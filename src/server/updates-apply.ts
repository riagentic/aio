// updates-apply.ts — installing a verified release, per target.
//
// One spine, five endings. Everything up to the swap is identical (download →
// verify → stage); only how the artifact is put in place and how the process
// comes back differ. The rules that make this boring:
//
//   • Nothing is swapped that has not been verified against a trusted key AND
//     shown to actually RUN on this machine (smokeTestArtifact).
//   • The rollback marker is written BEFORE the first rename, atomically, and
//     records the STABLE path it replaced — never a path derived later.
//   • Nothing is deleted before the replacement is in place and healthy.
//   • The process never rewrites its own running binary — it renames a file
//     and hands over to a fresh process. (On Windows it renames ITSELF aside
//     first: that OS permits renaming a running image, never replacing one.)
//   • A failed boot after an update rolls itself back, because the case that
//     most needs a rollback (an unattended service) has nobody to run one — and
//     a rollback that FAILS keeps its marker and says so on every boot.
import { dirname, isAbsolute, join, resolve, SEPARATOR } from "@std/path";
import { dirname as posixDirname } from "@std/path/posix";
import { dirname as winDirname } from "@std/path/windows";
import { pruneVersions, reconcileInstalledVersion } from "./install-record.ts";
import { isProcessAlive } from "./single-instance-lock.ts";
import { appImageOwner, isCompiled } from "./paths.ts";
import { locateDenoJsonAbove } from "./deno-json.ts";
import { readBuildStamp } from "./app-version.ts";
import type { ReleaseTarget, UpdateTarget } from "../build/ship.ts";
import { type Log, log } from "../diagnostics/logger-api.ts";
import {
  outlivingParent,
  spawnInheritingOrNull,
  startWindowless,
  windowsCommandLine,
} from "./no-console.ts";

/** The path this process was LAUNCHED through, which is the one an update has
 *  to replace — not the file it resolves to.
 *
 *  `Deno.execPath()` is `/proc/self/exe`, already resolved: launched through
 *  `~/app/notes/notes` → `~/app/notes/versions/1.0.0/notes`, it answers with
 *  the versioned file. An update that believes that answer writes 2.0.0 INTO
 *  the directory named 1.0.0, leaves the stable symlink pointing at a lie, and
 *  never prunes anything — which is exactly what every one-liner install did.
 *  `$APPIMAGE` is resolved the same way, which is why AppImage's own AppRun
 *  exports `$ARGV0`.
 *
 *  So: ask the invocation, not the kernel. Every candidate must resolve to the
 *  SAME file the process is actually running, or it is discarded — an `argv[0]`
 *  of `notes` found on `$PATH`, or inherited from an exec that renamed us, must
 *  never aim an update at an unrelated file. */
/** `$APPIMAGE` when THIS process runs from that AppImage — its executable
 *  lies under the mount the AppImage runtime exported as `$APPDIR` — else
 *  null. Both variables are inherited by every child: a plain binary started
 *  from a terminal that is itself an AppImage sees its host's `$APPIMAGE`,
 *  which is not the file it runs. Args are test seams. */
export function ownAppImage(
  execPath: string = Deno.execPath(),
  appImage: string | undefined = Deno.env.get("APPIMAGE"),
  appDir: string | undefined = Deno.env.get("APPDIR"),
): string | null {
  return appImageOwner(execPath, appImage, appDir) === "own" ? appImage! : null;
}

export function launchArtifactPath(opts: {
  /** Injected in tests; defaults to the real process. */
  execPath?: string;
  appImage?: string | null;
  argv0?: string | null;
  procArgv0?: string | null;
  cwd?: string;
} = {}): string {
  const execPath = opts.execPath ?? Deno.execPath();
  const appImage = opts.appImage !== undefined
    ? opts.appImage
    : ownAppImage(execPath);
  // Inside an AppImage, `Deno.execPath()` points into the read-only squashfs
  // mount, which vanishes with the process — the file the user launched, and
  // the one an update must replace, is `$APPIMAGE`.
  const running = appImage || execPath;
  const argv0 = opts.argv0 !== undefined
    ? opts.argv0
    : (Deno.env.get("ARGV0") ?? null);
  const procArgv0 = opts.procArgv0 !== undefined
    ? opts.procArgv0
    : readProcArgv0();
  const cwd = opts.cwd ?? safeCwd();
  let runningReal: string;
  try {
    runningReal = Deno.realPathSync(running);
  } catch {
    return running;
  }
  for (const candidate of [argv0, procArgv0]) {
    if (!candidate) continue;
    // A bare name came off `$PATH`; resolving it against cwd would invent a
    // path that does not exist, and the realpath check below would reject it
    // anyway — skip it explicitly so the intent is readable.
    if (!candidate.includes("/") && !candidate.includes("\\")) continue;
    const abs = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
    try {
      if (Deno.realPathSync(abs) === runningReal) return abs;
    } catch { /* gone or unreadable — not a path an update may aim at */ }
  }
  return running;
}

/** `argv[0]` as the kernel recorded it. Linux only; every other platform
 *  returns null and falls back to `$ARGV0` / the resolved path. */
function readProcArgv0(): string | null {
  if (Deno.build.os !== "linux") return null;
  try {
    const raw = Deno.readFileSync("/proc/self/cmdline");
    const end = raw.indexOf(0);
    return new TextDecoder().decode(end === -1 ? raw : raw.subarray(0, end)) ||
      null;
  } catch {
    return null;
  }
}

function safeCwd(): string {
  try {
    return Deno.cwd();
  } catch {
    return "/";
  }
}

/** Where the artifact that is actually running lives on disk. */
export function artifactPath(): string {
  return launchArtifactPath();
}

/** Everything about the PROCESS that decides what kind of install this is.
 *  Split out so the decision is a pure function with real tests: a rule that
 *  can only be exercised by being an AppImage is a rule nothing checks. */
export type ProcessFacts = {
  /** `Deno.execPath()`. */
  execPath: string;
  /** `$APPIMAGE`, when running from one. */
  appImage?: string | null;
  /** `$ELECTRON_PATH`, exported by the AppRun an Electron AppImage ships. */
  electronPath?: string | null;
  /** The root of an unpacked Electron release, if this process is inside one. */
  installDir?: string | null;
};

/** What kind of install this process is, decided from the process itself
 *  rather than from configuration — configuration can be copied between
 *  machines, the runtime facts cannot. */
/** What a RUNNING install is — every shape a release can be published as
 *  (`UpdateTarget`), plus the one that can only be installed BY HAND.
 *
 *  Two vocabularies, deliberately: `UpdateTarget` is what a signed manifest
 *  declares, and a manifest can never say `"macos-app"` because no strategy
 *  installs one. Folding them would either widen the frozen shipping union
 *  for a value nothing ships, or leave a `.app` classified as `"binary"` —
 *  which is the bug this exists to close. */
export type InstalledTarget = UpdateTarget | "macos-app";

export function classifyTarget(f: ProcessFacts): InstalledTarget {
  // Running from source: the executable is the `deno` binary itself, and there
  // is no artifact to swap. Detect works; apply refuses.
  if (/(^|[\\/])deno(\.exe)?$/i.test(f.execPath)) return "source";
  // A macOS `.app`, BEFORE anything else can claim it.
  //
  // Measured on this exact code before the branch existed:
  // `classifyTarget({execPath: "/Applications/Counter.app/Contents/MacOS/
  // Counter"})` answered `"binary"`, and `installableTargets` answered
  // `["binary"]`. So a macOS bundle would accept a plain-binary release and
  // run the `binary` strategy, which renames the new executable over
  // `Contents/MacOS/<exe>` — a file INSIDE a signed bundle. Every byte of a
  // bundle is covered by its seal, so the result is an app macOS refuses to
  // launch at all, produced by the update mechanism itself, on the user's
  // machine, with no way back but a fresh download. A silent, remote,
  // unrecoverable break: the worst shape this repo has a name for.
  //
  // There IS no in-place strategy for a bundle yet (see `installableTargets`
  // and the note in todo.md), so the honest answer is a target of its own
  // that installs nothing and says what to do instead. Matched on the path
  // rather than on `Deno.build.os`, so the rule is a pure test on any host.
  if (isMacAppBundle(f.execPath)) return "macos-app";
  if (f.appImage) {
    // `ELECTRON_PATH`, not `AIO_ELECTRON`: the AppRun an Electron AppImage
    // ships exports the former, and nothing in this repo has ever set the
    // latter — so this branch was unreachable and every Electron AppImage
    // reported itself as a plain `appimage`.
    return f.electronPath ? "electron-appimage" : "appimage";
  }
  // An unpacked Electron release: a launcher and a bundled `electron/` sitting
  // above us. That directory — not the executable — is what an update replaces.
  if (f.installDir) return "electron-zip";
  return "binary";
}

/** `execPath` is a test seam. */
export function detectTarget(
  execPath: string = Deno.execPath(),
): InstalledTarget {
  const appImage = ownAppImage(execPath);
  return classifyTarget({
    execPath,
    appImage,
    electronPath: Deno.env.get("ELECTRON_PATH") ?? null,
    // Only asked when it can matter — it walks the filesystem.
    installDir: appImage ? null : installDir(execPath),
  });
}

/** The root of an unpacked Electron release, if this process is inside one.
 *
 *  Walks up from the executable looking for the pair the build always writes
 *  together: the launcher and the bundled `electron/`. Bounded, and requiring
 *  BOTH, so a stray `run.sh` in somebody's home directory can never be mistaken
 *  for an install root — the cost of getting this wrong is replacing the wrong
 *  directory. */
export function installDir(from: string = Deno.execPath()): string | null {
  // A macOS bundle IS the unit an update replaces: `…/X.app/Contents/MacOS/
  // <bin>` → `…/X.app`. Pure over the path, like `isMacAppBundle`.
  const app = macAppDir(from);
  if (app) return app;
  const launcher = Deno.build.os === "windows" ? "run.bat" : "run.sh";
  let dir = dirname(from);
  for (let i = 0; i < 5; i++) {
    const hasLauncher = existsSync(join(dir, launcher));
    const hasElectron = existsSync(join(dir, "electron"));
    if (hasLauncher && hasElectron) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function existsSync(p: string): boolean {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** The targets this process can actually install. Everything else is reported
 *  to the user with the reason, never silently ignored. */
/** Is `execPath` the executable of a macOS `.app` bundle
 *  (`…/Foo.app/Contents/MacOS/<exe>`)? Pure — the shape of the path IS the
 *  fact, and a pure rule is one that a Linux CI can hold. */
export function isMacAppBundle(execPath: string): boolean {
  return macAppDir(execPath) !== null;
}

/** The `.app` directory enclosing a bundle executable, or null. Pure. */
export function macAppDir(execPath: string): string | null {
  return /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)?.[1] ?? null;
}

/** Why this `.app` cannot replace itself where it runs, or null when it can.
 *
 *  App Translocation: a quarantined app opened from a mounted `.dmg` or
 *  straight from Downloads runs from a random READ-ONLY copy under
 *  `…/AppTranslocation/…`, so a swap there would land nowhere the user will
 *  ever launch again. The same answer for any bundle whose folder this user
 *  cannot write (a mounted image, a locked-down /Applications). Asked BEFORE
 *  the download, so the refusal costs nothing. `canWrite` is the seam. */
export function macAppUpdateBlocker(
  app: string,
  canWrite: (dir: string) => boolean = dirWritable,
): string | null {
  const name = app.slice(app.lastIndexOf("/") + 1);
  const where = app.includes("/AppTranslocation/")
    ? `macOS is running it from a temporary read-only copy (App ` +
      `Translocation — it was opened from the disk image or from Downloads)`
    : canWrite(dirname(app))
    ? null
    : `its folder (${dirname(app)}) is not writable by this user`;
  if (where === null) return null;
  // Already in /Applications: moving it there is no advice. The folder
  // belongs to an administrator.
  return dirname(app) === "/Applications"
    ? `${name} cannot update itself: ${where}. Update it from an ` +
      `administrator account, or install it in ~/Applications instead.`
    : `${name} cannot update itself: ${where}. ` +
      `Move ${name} to /Applications (drag it there from the disk image or ` +
      `Finder), open it from /Applications, then update.`;
}

function dirWritable(dir: string): boolean {
  try {
    Deno.removeSync(Deno.makeTempFileSync({ dir, prefix: ".aio-w-" }));
    return true;
  } catch {
    return false;
  }
}

/** `Contents/MacOS/<CFBundleExecutable>` of a bundle, read from its
 *  Info.plist (the XML one `assembleMacApp` writes). Null when unreadable. */
export function macBundleExecutable(app: string): string | null {
  let plist: string;
  try {
    plist = Deno.readTextFileSync(join(app, "Contents", "Info.plist"));
  } catch {
    return null;
  }
  const exe = /<key>CFBundleExecutable<\/key>\s*<string>([^<\/]+)<\/string>/
    .exec(
      plist,
    )?.[1];
  return exe ? join(app, "Contents", "MacOS", exe) : null;
}

/** `codesign --verify --deep --strict` on a staged bundle — the seal every
 *  file in it is covered by. A failure refuses the update; the running app is
 *  untouched. */
export async function verifyMacBundle(
  app: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const out = await new Deno.Command("codesign", {
      args: ["--verify", "--deep", "--strict", app],
      stdin: "null",
      stdout: "null",
      stderr: "piped",
    }).output();
    if (out.success) return { ok: true };
    return {
      ok: false,
      error: `the downloaded app's code signature does not verify ` +
        `(codesign: ${
          new TextDecoder().decode(out.stderr).trim().split("\n").slice(-2)
            .join(" ") || `exit ${out.code}`
        }). The update was NOT installed; the running version is untouched.`,
    };
  } catch (e) {
    return {
      ok: false,
      error:
        `\`codesign\` could not run (${
          e instanceof Error ? e.message : e
        }) — the downloaded app cannot be verified, so the update was NOT ` +
        `installed; the running version is untouched.`,
    };
  }
}

export function installableTargets(
  t: InstalledTarget = detectTarget(),
): ReleaseTarget[] {
  // Running from source, DETECTION is universal — the update UI has to be
  // developable against a real source, and dev must not take a different code
  // path from prod. `apply` is where a source tree refuses, loudly, because
  // that is the only step it genuinely cannot perform.
  if (t === "source") {
    return [
      "binary",
      "appimage",
      "electron-appimage",
      "electron-zip",
      "electron-app",
    ];
  }
  // An AppImage and a plain binary are both "one executable file", so the
  // rename strategy covers both and either manifest is installable here.
  if (t === "appimage" || t === "electron-appimage") {
    return ["appimage", "electron-appimage"];
  }
  if (t === "electron-zip") return ["electron-zip"];
  // A `.app` installs a whole signed bundle (`electron-app`), swapped from
  // OUTSIDE it — never a file inside its own seal, so a `binary` or zip
  // release is refused (`decide` names the download instead).
  if (t === "macos-app") return ["electron-app"];
  return ["binary"];
}

/** Records an update that has been swapped in but not yet proven to work.
 *
 *  This exists for the unattended case. When a service updates itself at 3am
 *  there is no operator watching a health check, and a supervisor that restarts
 *  a broken binary will restart it forever. The marker lets the NEW build
 *  perform its own rollback: it counts its own failed boots and, having spent
 *  them, puts the old artifact back and exits so the supervisor brings up a
 *  version that is known to work. */
export type PendingUpdate = {
  from: string;
  to: string;
  /** The artifact that was replaced, kept until the new one proves itself. */
  previous: string;
  /** The STABLE path the swap replaced — the symlink, file or directory the
   *  user launches. Recorded at swap time and never re-derived: deriving it by
   *  stripping `.old-<version>` off `previous` is right for exactly one of the
   *  three layouts, and on the versioned (`run.sh`) layout it produced
   *  `current === previous`, so the rollback renamed a file onto itself, logged
   *  "rolled back", and left the stable name pointing at the broken version.
   *
   *  Optional only because a marker written before this field existed may still
   *  be on disk; `judgePendingUpdate` says so out loud when it has to guess. */
  artifact?: string;
  /** Set when a rollback was attempted and FAILED. The marker is then kept, not
   *  cleared: an unrecoverable install that silently forgets it tried is how an
   *  app crash-loops with no explanation. */
  rollbackFailed?: string;
  /** Set by the swap helper when the directory swap itself could not be made
   *  (a move failed after its retries): the old version was started again. */
  swapFailed?: string;
  /** Backup taken because the update migrates data — restored on rollback,
   *  since putting the old binary back cannot un-migrate a store. */
  backup?: string;
  /** `exeIdentity` of the OLD build's executable, taken by the process that
   *  staged the update. A boot whose own executable is still that file is the
   *  old version: the swap never happened. The version string cannot say
   *  that — a repository rebuild, a pinned `version` or a re-stamped publish
   *  reports one version for two builds. Absent in a marker written before
   *  this field existed, and then nothing is judged "old". */
  fromExe?: string;
  /** On the FAILED record of a rollback handed to the Windows swap helper:
   *  `exeIdentity` of the build being put back. A boot still running that
   *  file learns the helper did not put the old version back. */
  failedExe?: string;
  /** Set when the new build ended CLEANLY (exit code 0) before its own
   *  confirm ran — a quit while its `onStart` was still going. The next boot
   *  confirms it first thing: at exit, the confirm's prune of the kept-aside
   *  copy (async) and its log line (the logger had flushed) never happened. */
  confirmedAt?: string;
  attempts: number;
  startedAt: string;
};

/** The identity of an executable FILE — device, inode, size and mtime — or
 *  undefined when it cannot be read. Two builds never share one: a new build
 *  is a new file (a download, an unpack, a copy), while the old one keeps its
 *  identity through every rename a swap makes. Defaults to the artifact this
 *  process runs (`$APPIMAGE` inside an AppImage, whose `execPath` is a fresh
 *  mount on every launch). */
export function exeIdentity(
  path: string = ownAppImage() ?? Deno.execPath(),
): string | undefined {
  try {
    const s = Deno.statSync(path);
    return `${s.dev}:${s.ino}:${s.size}:${s.mtime?.getTime()}`;
  } catch {
    return undefined; // aio-ok: unknown ⇒ never judged the old build
  }
}

/** `exeIdentity()` of the running executable when `artifact` — the file or
 *  install directory a swap replaces — is it or holds it; else undefined. An
 *  executable the swap does not replace (a `deno run`, an injected target)
 *  stays the same file across the update, so it can tell nothing. */
export function replacedExeIdentity(
  artifact: string,
  running: string = ownAppImage() ?? Deno.execPath(),
): string | undefined {
  try {
    const exe = Deno.realPathSync(running);
    const dir = Deno.realPathSync(artifact);
    const inside = exe === dir || exe.startsWith(dir + SEPARATOR);
    return inside ? exeIdentity(running) : undefined;
  } catch {
    return undefined; // aio-ok: unknown ⇒ never judged the old build
  }
}

const PENDING = "update-pending.json";

export function pendingPath(dataDir: string): string {
  return join(dataDir, PENDING);
}

/** Where an update that was put back is recorded: the pending marker, moved
 *  here by whoever rolled it back (the in-app judge, or the swap helper when
 *  the new version never started). The next boot names it and does not
 *  auto-install that version again. */
export function failedUpdatePath(dataDir: string): string {
  return join(dataDir, "update-failed.json");
}

/** The first-boot token of a directory swap: a copy of the pending record
 *  that exactly ONE side takes. The new version's first boot deletes it (it
 *  won: it runs); the swap helper, when the wait runs out, renames it to
 *  `update-failed.json` (it won: the old version comes back). Both are single
 *  atomic syscalls on the same name, so the loser's call fails — there is no
 *  instant at which both think they won. */
export function firstBootPath(dataDir: string): string {
  return join(dataDir, "update-first-boot.json");
}

/** Take the first-boot token for the booting new version. "won": it was
 *  there and is ours; "lost": the swap helper took it first — this build was
 *  rolled back and must exit without touching anything; "none": no helper is
 *  watching (a single-file swap, or a later boot). */
export function claimFirstBoot(
  dataDir: string,
  pending: PendingUpdate,
  logger: Log = log,
): "won" | "lost" | "none" {
  try {
    Deno.removeSync(firstBootPath(dataDir));
    return "won";
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  const path = failedUpdatePath(dataDir);
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return "none";
    throw e; // held by a scanner: the caller retries
  }
  const f = parseUpdateRecord(text);
  if (typeof f === "string") {
    // Not the helper's claim — that is one rename of a whole record — so
    // there is nothing here to lose to. Moved aside, so it is said once.
    setAsideRecord(path, f, logger);
    return "none";
  }
  return f.startedAt === pending.startedAt && f.to === pending.to
    ? "lost"
    : "none";
}

/** An update record parsed, or why the text is not one. */
export function parseUpdateRecord(text: string): PendingUpdate | string {
  try {
    const p = JSON.parse(text) as PendingUpdate | null;
    return typeof p?.from === "string" && typeof p.to === "string"
      ? p
      : "is not an update record";
  } catch (e) {
    return `is unreadable (${e})`;
  }
}

/** Move a record that cannot be used aside, saying so ONCE — not on every
 *  boot forever. */
export function setAsideRecord(
  path: string,
  why: string,
  logger: Log = log,
): void {
  const aside = `${path}.bad-${Date.now()}`;
  try {
    Deno.renameSync(path, aside);
    logger.error("updates", `${path} ${why} — ignored, kept as ${aside}`);
  } catch (e) {
    logger.error(
      "updates",
      `${path} ${why} — ignored; moving it aside failed: ${e}`,
    );
  }
}

/** How long the directory-swap helper waits for the new version's FIRST boot
 *  to take the first-boot token before it puts the old version back. That boot
 *  measured ~1 s after the swap (macOS 14 VM); this is slack for a slow disk,
 *  not a guess at normal. */
export const FIRST_BOOT_WAIT_S = 120;

export function readPending(dataDir: string): PendingUpdate | null {
  const path = pendingPath(dataDir);
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch {
    return null; // absent — no update in flight, which is the normal case
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Never silent. A marker we cannot read is an update whose rollback we have
    // just lost, and pretending there is none is how a broken build becomes
    // permanent.
    log.error(
      `[aio] update: ${path} is not readable JSON (${text.length} bytes) — ` +
        `the rollback for an in-flight update is lost. Delete it once the app ` +
        `is running the version you want.`,
    );
    return null;
  }
  const p = parsed as PendingUpdate | null;
  if (
    !p || typeof p !== "object" || typeof p.from !== "string" ||
    typeof p.to !== "string" || typeof p.previous !== "string" ||
    typeof p.attempts !== "number"
  ) {
    log.error(
      `[aio] update: ${path} is missing required fields (from/to/previous/` +
        `attempts) — the rollback for an in-flight update is lost. Delete it ` +
        `once the app is running the version you want.`,
    );
    return null;
  }
  return p;
}

/** Write the marker ATOMICALLY: temp file, fsync, rename.
 *
 *  A plain write leaves a window in which the file exists and is empty, and an
 *  empty marker parses as "no update in flight" — so a power cut one second
 *  after a swap used to remove the only record that a rollback was possible. */
export function writePending(dataDir: string, p: PendingUpdate): void {
  writeRecordAtomic(pendingPath(dataDir), p);
}

/** Write an update record ATOMICALLY (see `writePending`). */
export function writeRecordAtomic(path: string, p: PendingUpdate): void {
  const tmp = `${path}.tmp-${Deno.pid}`;
  const bytes = new TextEncoder().encode(JSON.stringify(p, null, 2) + "\n");
  const f = Deno.openSync(tmp, { write: true, create: true, truncate: true });
  try {
    let off = 0;
    while (off < bytes.length) off += f.writeSync(bytes.subarray(off));
    f.syncSync();
  } finally {
    f.close();
  }
  Deno.renameSync(tmp, path);
}

export function clearPending(dataDir: string): void {
  try {
    Deno.removeSync(pendingPath(dataDir));
  } catch { /* already gone — the update is confirmed either way */ }
}

/** How many boots a new build gets to come up healthy before it is rolled
 *  back. Two, not one: a single failure can be an unlucky port collision or a
 *  machine still coming up, and rolling back on that would be its own outage. */
export const MAX_BOOT_ATTEMPTS = 2;

/** What the boot sequence should do about a pending update. Pure, so the
 *  policy is testable without staging a real update. */
export type PendingVerdict =
  | { action: "none" }
  | { action: "confirm"; from: string; to: string }
  | { action: "retry"; attempt: number; of: number }
  | {
    action: "rollback";
    to: string;
    /** The stable path to put `previous` back at, recorded at swap time.
     *  Undefined only for a marker written before that field existed. */
    artifact?: string;
    previous: string;
    backup?: string;
  };

/** Decide, at boot, what a pending marker means.
 *
 *  Called twice per boot: once BEFORE serving (`healthy: false`) to count the
 *  attempt or give up, and once after the app reports healthy (`healthy: true`)
 *  to confirm and clear it. */
export function judgePending(
  p: PendingUpdate | null,
  healthy: boolean,
): PendingVerdict {
  if (!p) return { action: "none" };
  if (healthy) return { action: "confirm", from: p.from, to: p.to };
  if (p.attempts < MAX_BOOT_ATTEMPTS) {
    return { action: "retry", attempt: p.attempts + 1, of: MAX_BOOT_ATTEMPTS };
  }
  return {
    action: "rollback",
    to: p.from,
    artifact: p.artifact,
    previous: p.previous,
    backup: p.backup,
  };
}

/** Is `path` the STABLE NAME of an installed app — a symlink pointing at a
 *  versioned artifact beside it?
 *
 *  `run.sh` installs an app as:
 *
 *      ~/app/<name>/<name>-<version>.AppImage   the artifact
 *      ~/app/<name>/<name>.AppImage → that      the stable name
 *
 *  and the stable name is what the menu entry, the shell alias and the user's
 *  muscle memory point at. A plain `rename(staged, current)` over that symlink
 *  REPLACES IT WITH A FILE: after the first update the versioning is gone, the
 *  old version is unrecoverable, and every launcher now points at a regular
 *  file that the next update overwrites in place. Detecting the layout is what
 *  lets an update add a version instead of flattening the scheme. */
export async function versionedInstall(
  path: string,
): Promise<
  | { dir: string; link: string; target: string; base: string; ext: string }
  | null
> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch {
    return null;
  }
  if (!info.isSymlink) return null;
  let target: string;
  try {
    target = await Deno.realPath(path);
  } catch {
    return null; // dangling — not a layout we can reason about
  }
  const dir = dirname(path);
  // `~/app/<name>/<name>.ext -> ~/app/<name>/versions/<version>/<name>.ext`.
  // The VERSION is the directory, and the file keeps the app's name — a
  // deno-compiled binary derives its identity (and therefore its data
  // directory) from its own file name, so versioning the file would rename the
  // app on every update.
  const versions = join(dir, "versions");
  if (!target.startsWith(versions + "/")) return null;
  const linkName = path.slice(dir.length + 1);
  const dot = linkName.indexOf(".");
  const base = dot === -1 ? linkName : linkName.slice(0, dot);
  const ext = dot === -1 ? "" : linkName.slice(dot);
  if (target.slice(target.lastIndexOf("/") + 1) !== linkName) return null;
  return { dir, link: path, target, base, ext };
}

/** How the replacement gets into place.
 *
 *  `rename-over` — Unix. The kernel refuses a WRITE to a busy executable
 *  (ETXTBSY) but a rename only moves a directory entry, so the running process
 *  keeps its inode (and, for an AppImage, its mount) while the path resolves to
 *  the new version. The current artifact is COPIED aside first, so the path is
 *  never missing.
 *
 *  `rename-self-aside` — Windows. Replacing a running image is
 *  ERROR_ACCESS_DENIED, full stop; there is no share mode that permits it. What
 *  Windows DOES permit is renaming a running image, so the order inverts: move
 *  the running exe out of the way, then move the new one into the name it
 *  vacated. The old file cannot be deleted until the process exits, which is
 *  exactly what `pruneOld` is for. */
export type SwapStrategy = "rename-over" | "rename-self-aside";

/** One decider, so the Windows path is testable from any host. */
export function swapStrategy(os: string = Deno.build.os): SwapStrategy {
  return os === "windows" ? "rename-self-aside" : "rename-over";
}

/** Does the staged artifact RUN on this machine?
 *
 *  Wrong architecture, a `noexec` mount, a missing interpreter, a truncated
 *  download that still hashed (it cannot, but a swap from a git rebuild has no
 *  hash at all): every one of these installs cleanly and then never comes up.
 *  Nothing counted those boots — the process died before it could write a boot
 *  attempt — so the app crash-looped forever with the rollback marker untouched.
 *
 *  The PREDECESSOR asks the question, while it is still the thing that works:
 *  run the staged artifact with a flag that prints and exits, bounded. A
 *  non-zero exit refuses the update by name. */
export async function smokeTestArtifact(
  path: string,
  opts: { timeoutMs?: number; args?: string[] } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const args = opts.args ?? ["--version"];
  const timeoutMs = opts.timeoutMs ?? 30_000;
  if (Deno.build.os !== "windows") {
    // Staged files arrive 0600 from the download; without this the smoke test
    // measures our own permissions rather than the artifact.
    await Deno.chmod(path, 0o755).catch(() => {});
  }
  let out: ProbeResult;
  try {
    out = await probeOffThread(path, args, timeoutMs);
  } catch (e) {
    return {
      ok: false,
      error: `the downloaded artifact could not be run: ${
        e instanceof Error ? e.message : e
      }. The update was NOT installed; the running version is untouched.`,
    };
  }
  if ("spawnError" in out) {
    return {
      ok: false,
      error:
        `the downloaded artifact cannot be executed (${out.spawnError}) — it ` +
        `is the wrong architecture, or ${dirname(path)} is mounted noexec. ` +
        `The update was NOT installed; the running version is untouched.`,
    };
  }
  if (out.timedOut) {
    return {
      ok: false,
      error:
        `the downloaded artifact did not answer \`${args.join(" ")}\` within ${
          timeoutMs / 1000
        }s and was killed — it cannot be verified ` +
        `on this machine, so the update was NOT installed; the running ` +
        `version is untouched.`,
    };
  }
  if (!out.success) {
    const stderr = out.stderr.trim().split("\n").slice(-2).join(" ");
    return {
      ok: false,
      error:
        `the downloaded artifact exited ${out.code} on \`${args.join(" ")}\`${
          stderr ? ` — ${stderr}` : ""
        }. It cannot run on this machine, so ` +
        `the update was NOT installed; the running version is untouched.`,
    };
  }
  return { ok: true };
}

type ProbeResult =
  | { spawnError: string }
  | { timedOut: true }
  | { timedOut: false; success: boolean; code: number; stderr: string };

/** The probe's worker, as plain JS (a Blob module: nothing for `deno compile`
 *  to miss). It posts `{ pid }` once the child exists, then the result. */
const PROBE_WORKER = `
self.onmessage = async ({ data: a }) => {
  let child;
  try {
    child = new Deno.Command(a.path, {
      args: a.args, stdin: "null", stdout: "null", stderr: "piped",
    }).spawn();
  } catch (e) {
    self.postMessage({ spawnError: e instanceof Error ? e.message : String(e) });
    return;
  }
  self.postMessage({ pid: child.pid });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }, a.timeoutMs);
  try {
    const out = await child.output();
    self.postMessage(timedOut ? { timedOut: true } : {
      timedOut: false, success: out.success, code: out.code,
      stderr: new TextDecoder().decode(out.stderr),
    });
  } catch (e) {
    self.postMessage({ spawnError: e instanceof Error ? e.message : String(e) });
  } finally {
    clearTimeout(timer);
  }
};`;

/** Run `path args` to completion in a WORKER, never on this thread.
 *
 *  `Deno.Command#spawn` is synchronous, and on Windows CreateProcess waits for
 *  the antivirus to scan a new unsigned exe — measured on Windows 11: 16–20 s
 *  for a 265 MB Electron build, during which the app answered nothing (no
 *  render, no dispatch, a loop-stall warning). In a worker only the worker's
 *  thread waits. The worker's own kill timer cannot fire while CreateProcess
 *  holds that thread, so this side keeps one too (plus a grace for the scan). */
async function probeOffThread(
  path: string,
  args: string[],
  timeoutMs: number,
): Promise<ProbeResult> {
  const url = URL.createObjectURL(
    new Blob([PROBE_WORKER], { type: "application/javascript" }),
  );
  const w = new Worker(url, { type: "module", name: "aio-update-probe" });
  let pid: number | undefined;
  try {
    return await new Promise<ProbeResult>((resolve, reject) => {
      const guard = setTimeout(() => {
        if (pid !== undefined) {
          try {
            Deno.kill(pid, "SIGKILL");
          } catch { /* already gone */ }
        }
        resolve({ timedOut: true });
      }, timeoutMs + 30_000);
      w.onmessage = (e: MessageEvent) => {
        if (typeof e.data?.pid === "number") {
          pid = e.data.pid;
          return;
        }
        clearTimeout(guard);
        resolve(e.data as ProbeResult);
      };
      w.onerror = (e: ErrorEvent) => {
        e.preventDefault();
        clearTimeout(guard);
        reject(new Error(e.message));
      };
      w.postMessage({ path, args, timeoutMs });
    });
  } finally {
    w.terminate();
    URL.revokeObjectURL(url);
  }
}

/** What to record before a swap so the new build can undo it. Passing this is
 *  what makes the update recoverable — see `writePending`. */
export type PendingMark = {
  dataDir: string;
  from: string;
  to: string;
  backup?: string;
  /** `exeIdentity()` of the running (old) build — `PendingUpdate.fromExe`. */
  exe?: string;
};

export async function swapArtifact(opts: {
  /** The artifact currently running — the file to replace. */
  current: string;
  /** The verified replacement, already downloaded. Must be on the same
   *  filesystem as `current`, or the rename is not atomic. */
  staged: string;
  /** Version being replaced, for the kept-aside copy's name. */
  fromVersion: string;
  /** How many versioned artifacts to keep in an installed layout (default 3,
   *  never fewer than 2 — the new one and the one it replaced). */
  keepVersions?: number;
  /** Version being installed. Only used for the versioned-install layout,
   *  where it NAMES the new file; without it that layout cannot be preserved,
   *  so the old flat behaviour is used and said so at the call site. */
  toVersion?: string;
  /** Write the rollback marker BEFORE touching anything, carrying the STABLE
   *  path this swap replaces. Omitted only by a caller that is exercising the
   *  rename mechanics on stand-in files. */
  pending?: PendingMark;
  /** Refuse an artifact that cannot exec (default on). `false` only for a
   *  caller whose `staged` is a stand-in rather than a real program. */
  smoke?: boolean;
  /** Overridable so the Windows ordering is exercised from any host. */
  strategy?: SwapStrategy;
}): Promise<{ previous: string }> {
  if (opts.smoke !== false) {
    const smoked = await smokeTestArtifact(opts.staged);
    if (!smoked.ok) {
      await Deno.remove(opts.staged).catch(() => {});
      throw new Error(smoked.error);
    }
  }
  const layout = await versionedInstall(opts.current);
  /** The marker goes down BEFORE the first rename, always. A crash between the
   *  swap and the marker used to leave a new binary with no attempt counter and
   *  no way back — permanently. */
  const mark = (previous: string) => {
    if (!opts.pending) return;
    writePending(opts.pending.dataDir, {
      from: opts.pending.from,
      to: opts.pending.to,
      artifact: opts.current,
      previous,
      backup: opts.pending.backup,
      fromExe: opts.pending.exe,
      attempts: 0,
      startedAt: new Date().toISOString(),
    });
  };
  if (layout && opts.toVersion) {
    // Add a version, then re-point the stable name at it. The old artifact is
    // left exactly where it was — it IS the rollback copy, no duplicate
    // needed — and the symlink swap is atomic (rename over a temporary link),
    // so a crash mid-update leaves the app pointing at a real binary either
    // way.
    const nextDir = `${layout.dir}/versions/${opts.toVersion}`;
    await Deno.mkdir(nextDir, { recursive: true });
    const next = `${nextDir}/${layout.base}${layout.ext}`;
    // A SAME-VERSION REBUILD lands in the directory the old artifact already
    // occupies — `decide()` offers one on purpose ("same version, new build")
    // — so `rename(staged, next)` wrote the new bytes straight over the very
    // file the marker had just recorded as the rollback. `restoreArtifact`
    // then "succeeded", logged `rolled back the artifact → <version>`, and
    // pointed the app at the build that had just failed: a crash loop with a
    // log claiming a good rollback, and the last known-good copy gone. This is
    // the layout the one-liner installer produces.
    //
    // So vacate the name first, and let the marker name where the old copy
    // WILL be. Marker still goes down before any rename that could lose it: a
    // crash before the aside leaves the target untouched (rollback fails
    // loudly, app intact); a crash after it leaves `previous` real and the
    // marker pointing at it.
    const sameSlot = next === layout.target;
    const previousPath = sameSlot
      ? `${nextDir}/${layout.base}.previous${layout.ext}`
      : layout.target;
    mark(previousPath);
    if (sameSlot) {
      await Deno.remove(previousPath).catch(() => {
        // aio-ok: clearing a leftover from an earlier interrupted swap. If it
        // is not there, there is nothing to clear; if it cannot be removed,
        // the rename below fails loudly with the real reason.
      });
      await Deno.rename(layout.target, previousPath);
    }
    if (Deno.build.os !== "windows") await Deno.chmod(opts.staged, 0o755);
    await Deno.rename(opts.staged, next);
    const tmpLink = `${layout.link}.new-${opts.toVersion}`;
    await Deno.remove(tmpLink).catch(() => {});
    await Deno.symlink(next, tmpLink);
    await Deno.rename(tmpLink, layout.link);
    // `am installed` and `am upgrade` read installed.json, and nothing but
    // `run.sh` ever wrote it — so an app that updated itself five times still
    // reported the version it was first installed at, and `am upgrade`'s prune
    // could delete the very version this marker names as `previous`.
    await reconcileInstalledVersion(layout.dir, {
      version: opts.toVersion,
      artifact: `${layout.base}${layout.ext}`,
    });
    // Old versions ARE the rollback, but only the last few. Without this each
    // update leaves another artifact — ~156MB for an AppImage — in the install
    // directory forever: nothing fails, the disk just fills, and the person
    // who finds out is the one who runs out of space doing something else.
    // The two just written (new + previous) are always kept.
    await pruneVersions({
      dir: layout.dir,
      keep: Math.max(2, opts.keepVersions ?? 3),
      current: nextDir,
    }).catch(() => []);
    return { previous: previousPath };
  }
  const previous = `${opts.current}.old-${opts.fromVersion}`;
  mark(previous);
  try {
    await swapFlat(opts, previous);
  } catch (e) {
    // The swap never happened: the running artifact is still at its path (the
    // Windows branch undoes its own first step). A marker left behind claimed
    // an update that never landed — the next healthy boot "confirmed" it, and
    // two unhealthy ones "rolled back" by moving the partial kept-aside copy
    // over the good binary. Take the marker back, with the half-written copy
    // and the staged file, and let the failure speak.
    if (await Deno.lstat(opts.current).then(() => true, () => false)) {
      if (opts.pending) clearPending(opts.pending.dataDir);
      await Deno.remove(previous).catch(() => {
        // aio-ok: the partial copy may never have been created.
      });
      await Deno.remove(opts.staged).catch(() => {
        // aio-ok: the staged file may already be gone.
      });
    }
    throw e;
  }
  await reconcileInstalledVersion(dirname(opts.current), {
    version: opts.toVersion,
    artifact: opts.current.slice(dirname(opts.current).length + 1),
  });
  return { previous };
}

/** The flat-layout swap: keep the running artifact aside as `previous`, move
 *  the staged one into its name. */
async function swapFlat(
  opts: Parameters<typeof swapArtifact>[0],
  previous: string,
): Promise<void> {
  if (Deno.build.os !== "windows") await Deno.chmod(opts.staged, 0o755);
  if ((opts.strategy ?? swapStrategy()) === "rename-self-aside") {
    // Windows: the running image cannot be replaced, only renamed. Move it out
    // of the name first, then move the new one in. If the second step fails the
    // first is undone, so the app is never left with no artifact at its path.
    await Deno.remove(previous).catch(() => {});
    await Deno.rename(opts.current, previous);
    try {
      await Deno.rename(opts.staged, opts.current);
    } catch (e) {
      await Deno.rename(previous, opts.current).catch(() => {});
      throw e;
    }
  } else {
    await Deno.copyFile(opts.current, previous);
    await Deno.rename(opts.staged, opts.current);
  }
}

/** Undo a swap: put the kept-aside artifact back at the stable path.
 *
 *  Three layouts, and the naive `rename(previous, current)` is correct for
 *  exactly one of them:
 *
 *    • versioned (`run.sh`) — `current` is the stable SYMLINK and `previous` is
 *      a file under `versions/`. Renaming over the link would destroy the whole
 *      scheme; the rollback is re-pointing the link.
 *    • electron-zip — both are DIRECTORIES, and `rename` onto an existing
 *      directory is `AlreadyExists (os error 17)` on every platform. That is
 *      why this path failed on every single attempt.
 *    • flat binary — the plain case.
 *
 *  Throws with EVERY path named when it cannot finish — the stable one, the
 *  version that worked, and wherever the build that failed now sits — plus the
 *  one command that puts something back. The caller must NOT swallow that, and
 *  must not paraphrase it either: a rollback that failed and said nothing is
 *  the worst of the possible outcomes, and a rollback that failed and did not
 *  say WHERE the artifact went is the second worst. The flat layout has a
 *  moment with nothing at the stable path (the failed build moved aside, the
 *  good one not yet in); when the second rename fails, the put-back fails for
 *  the same reason more often than not — a mount gone read-only, an install
 *  dir locked down — and the user is left with neither. That error used to
 *  name only the second rename. */
export async function restoreArtifact(
  current: string,
  previous: string,
): Promise<void> {
  try {
    await Deno.lstat(previous);
  } catch (e) {
    throw new Error(
      `the artifact to roll back to is ${
        e instanceof Deno.errors.NotFound ? "gone" : `unreadable (${e})`
      } (${previous}) — nothing was ` +
        `changed. Re-install the version you want, or run \`am upgrade\`.`,
      { cause: e },
    );
  }
  const layout = await versionedInstall(current);
  if (layout) {
    const tmpLink = `${current}.rollback`;
    const untouched =
      `nothing was changed: ${current} still points at ${layout.target}, ` +
      `the build that failed, and ${previous} is untouched`;
    // A leftover from a rollback interrupted between its two steps is OUR
    // symlink and goes quietly. Anything else wearing that name — a directory,
    // a file we lack the permission for — is not removed recursively behind
    // the user's back; it is named, because it is exactly what would make the
    // symlink below fail with a bare `File exists`.
    try {
      await Deno.remove(tmpLink);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) {
        throw new Error(
          `${tmpLink} is in the way of the rollback and could not be ` +
            `removed (${e}) — ${untouched}. Clear it and retry:\n` +
            `  rm -rf ${tmpLink}`,
          { cause: e },
        );
      }
    }
    try {
      await Deno.symlink(previous, tmpLink);
    } catch (e) {
      throw new Error(
        `could not create the link ${tmpLink} → ${previous} (${e}) — ` +
          `${untouched}. Re-point the link by hand:\n` +
          `  ln -sfn ${previous} ${current}`,
        { cause: e },
      );
    }
    try {
      await Deno.rename(tmpLink, current);
    } catch (e) {
      // The link was made but never moved into place: `current` is unchanged
      // and `<current>.rollback` is left behind, pointing at `previous`.
      // `ln -sfn`, not `mv`: on the electron-zip layout the target is a
      // DIRECTORY, and `mv` of a link onto a link-to-a-directory moves it
      // INSIDE.
      throw new Error(
        `could not re-point ${current} at ${previous} (${e}) — it still ` +
          `points at ${layout.target}, the build that failed, and the link ` +
          `${tmpLink} → ${previous} was left behind. Finish the rollback ` +
          `by hand:\n  ln -sfn ${previous} ${current} && rm ${tmpLink}`,
        { cause: e },
      );
    }
    return;
  }
  // Move whatever is at the stable path aside FIRST. A directory cannot be
  // renamed onto, and a file that is still open on Windows cannot be replaced —
  // both are fixed by vacating the name before filling it.
  let aside: string | null = null;
  if (await lexists(current)) {
    aside = `${current}.failed-${Date.now()}`;
    try {
      await Deno.rename(current, aside);
    } catch (e) {
      throw new Error(
        `could not move the build that failed aside (${e}) — nothing was ` +
          `changed: ${current} still holds it, and ${previous} is untouched. ` +
          `Put the version that worked back by hand:\n` +
          `  mv ${previous} ${current}`,
        { cause: e },
      );
    }
  }
  try {
    await Deno.rename(previous, current);
  } catch (e) {
    if (!aside) {
      throw new Error(
        `could not move ${previous} to ${current} (${e}) — nothing was ` +
          `changed: there was no artifact at ${current}, and ${previous} is ` +
          `untouched. Put it back by hand:\n  mv ${previous} ${current}`,
        { cause: e },
      );
    }
    // The name is vacant and the version that worked did not go in. Put the
    // build that failed back so SOMETHING launches — and when that fails too
    // (the same read-only mount, the same permission), the artifact's
    // whereabouts ARE the message. Rethrowing the first error here used to
    // leave the user with an empty stable path, a `.failed-` copy nobody had
    // named, and an error about a rename of `previous`.
    try {
      await Deno.rename(aside, current);
    } catch (e2) {
      throw new Error(
        `could not move ${previous} to ${current} (${e}), and could not put ` +
          `the build that failed back either (${e2}). NOTHING is at ` +
          `${current} now: the build that failed is at ${aside}, and the ` +
          `version that worked is still at ${previous}. Put one of them ` +
          `back by hand:\n` +
          `  mv ${previous} ${current}   (the rollback)\n` +
          `  mv ${aside} ${current}   (the build that failed)`,
        { cause: e },
      );
    }
    throw new Error(
      `could not move ${previous} to ${current} (${e}) — the build that ` +
        `failed was put back, so ${current} still holds it and ${previous} ` +
        `is untouched. Put the version that worked back by hand:\n` +
        `  mv ${previous} ${current}`,
      { cause: e },
    );
  }
  if (aside) {
    await Deno.remove(aside, { recursive: true }).catch(() => {});
  }
}

async function lexists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** How many superseded artifacts to keep so a manual rollback is a rename. */
export const KEEP_OLD = 3;

/** Keep the N most recent kept-aside artifacts, delete older ones. A manual
 *  rollback is then a rename, not a re-download. */
export async function pruneOld(current: string, keep: number): Promise<void> {
  const dir = dirname(current);
  await pruneKeepingNewest(dir, `${current.slice(dir.length + 1)}.old-`, keep);
}

/** Names an update leaves behind at the stable path. `.old-` is retained (it is
 *  the rollback); the rest are debris from a swap that was interrupted, and
 *  nothing ever removed them — on the electron-zip target a whole unpacked
 *  install per attempt. */
const STALE_SUFFIXES = [
  ".new-",
  ".staged-",
  ".zip-",
  ".failed-",
  ".rollback",
];

/** Sweep interrupted-swap leftovers beside the stable path.
 *
 *  Bounded twice over: only names this module writes, and only entries older
 *  than `minAgeMs` — a swap that is happening RIGHT NOW must not have its
 *  staging directory deleted out from under it. Best-effort by design; a boot
 *  must not fail because a temp file could not be removed. Returns what it
 *  removed so the caller can say so. */
export async function sweepStaleSwaps(
  current: string,
  opts: { minAgeMs?: number; max?: number } = {},
): Promise<string[]> {
  const minAge = opts.minAgeMs ?? 60 * 60 * 1000; // an hour
  const max = opts.max ?? 64;
  const dir = dirname(current);
  const base = current.slice(dir.length + 1);
  const removed: string[] = [];
  const now = Date.now();
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch {
    return removed;
  }
  for (const e of entries) {
    if (removed.length >= max) break;
    if (!e.name.startsWith(base)) continue;
    const rest = e.name.slice(base.length);
    if (!STALE_SUFFIXES.some((sfx) => rest.startsWith(sfx))) continue;
    const full = join(dir, e.name);
    const st = await Deno.stat(full).catch(() => null);
    if (!st) continue;
    if (now - (st.mtime?.getTime() ?? 0) < minAge) continue;
    try {
      await Deno.remove(full, { recursive: true });
      removed.push(e.name);
    } catch { /* in use, or not ours to remove — never fatal at boot */ }
  }
  return removed;
}

/** Keep the `keep` newest files named `<prefix>*` in `dir`, delete the rest.
 *
 *  ONE answer to "how much history does an update leave behind", because there
 *  are two kinds and only one of them used to be answered. Superseded ARTIFACTS
 *  were pruned; the pre-migration STORE BACKUPS were not — every migrating
 *  update copied the whole database into `data/backups/` and nothing ever
 *  removed it. On an app with a multi-gigabyte store that is unbounded growth
 *  inside the backup unit itself, so each `am backup` then copied every
 *  historical snapshot too. Silent, and it compounds. */
export async function pruneKeepingNewest(
  dir: string,
  prefix: string,
  keep: number,
): Promise<void> {
  const found: { name: string; mtime: number }[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      // Directories count. The electron-zip target keeps its rollback as a
      // whole unpacked install, and skipping directories here meant that
      // target leaked one complete copy of the app per update, forever.
      if (e.isSymlink || !e.name.startsWith(prefix)) continue;
      const st = await Deno.stat(join(dir, e.name)).catch(() => null);
      found.push({ name: e.name, mtime: st?.mtime?.getTime() ?? 0 });
    }
  } catch {
    return; // no such directory — nothing was ever kept here
  }
  found.sort((a, b) => b.mtime - a.mtime);
  for (const f of found.slice(keep)) {
    await Deno.remove(join(dir, f.name), { recursive: true }).catch(() => {});
  }
}

/** Start the swap helper so it RUNS and outlives this process.
 *
 *  POSIX: a plain spawn outlives its parent. Windows (measured on Windows 11,
 *  2026-09-27): a plain Deno child is ended with its parent, and a
 *  `detached` PowerShell has no console and exits 0 without running a line
 *  — every directory update and in-app rollback did nothing. So the helper is
 *  started windowless through CreateProcessW ({@link startWindowless}), and
 *  where that is unavailable (no --allow-ffi) through a detached `cmd.exe`,
 *  which runs console-less and gives PowerShell a console of its own (a
 *  console window may show for a moment). */
export function spawnSwapHelper(
  cmd: string,
  args: string[],
  extra?: { env?: Record<string, string>; cwd?: string },
  deps: {
    os?: typeof Deno.build.os;
    windowless?: typeof startWindowless;
    spawn?: (cmd: string, o: Deno.CommandOptions) => void;
  } = {},
): void {
  const os = deps.os ?? Deno.build.os;
  const start = deps.spawn ??
    ((c: string, o: Deno.CommandOptions) =>
      void new Deno.Command(c, o).spawn().unref());
  if (os !== "windows") return start(cmd, swapHelperOptions(args, extra, os));
  const started = (deps.windowless ?? startWindowless)(
    windowsCommandLine([cmd, ...args]),
    { ...Deno.env.toObject(), ...extra?.env },
    extra?.cwd,
  );
  if (typeof started === "number") return;
  // cmd.exe refuses a command line over 8191 characters, and the helper's
  // encoded script is longer: it rides in the environment, and a short
  // bootstrap runs it (the script clears every AIO_SWAP_* variable first).
  const i = args.indexOf("-EncodedCommand");
  const via = i < 0 ? { args, env: extra?.env } : {
    args: [...args.slice(0, i), "-EncodedCommand", SWAP_BOOTSTRAP],
    env: { ...extra?.env, AIO_SWAP_SCRIPT: args[i + 1]! },
  };
  start(
    "cmd.exe",
    swapHelperOptions(["/d", "/c", cmd, ...via.args], {
      ...extra,
      env: via.env,
    }, os),
  );
}

/** Runs the helper script handed over in `AIO_SWAP_SCRIPT` (base64 of
 *  UTF-16LE, as `-EncodedCommand` takes it). */
const SWAP_BOOTSTRAP = encodePowerShell(
  "$s = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($env:AIO_SWAP_SCRIPT)); & ([scriptblock]::Create($s))",
);

/** The swap helper's spawn options, as a pure value. The helper's whole job
 *  happens AFTER this process exits (it waits for the pid, then moves the
 *  install), so it must outlive it — see {@link outlivingParent}. */
export function swapHelperOptions(
  args: string[],
  extra?: { env?: Record<string, string>; cwd?: string },
  os: typeof Deno.build.os = Deno.build.os,
): Deno.CommandOptions {
  return {
    args,
    ...(extra?.env ? { env: extra.env } : {}),
    ...(extra?.cwd ? { cwd: extra.cwd } : {}),
    stdin: "null",
    stdout: "null",
    stderr: "null",
    ...outlivingParent(os),
  };
}

/** The flag a relaunching process carries so it knows to wait for its
 *  predecessor. Internal, and named to say so. */
export const RELAUNCH_FLAG = "--__aio-relaunch-after";

/** The argv a successor is started with: this process's, without the
 *  relaunch flag and with only the LAST `--client=` (the one the parser
 *  obeys). A compiled binary gets its baked `--client=` in FRONT of its argv,
 *  and the successor bakes its own again — replayed whole, every update added
 *  one more. `baked`: `args[0]` is that bake, so it is dropped and the NEW
 *  build's own decides (a user's `--client=` after it still wins). Past a bare
 *  `--` the argv is the app's own and replayed as it is, less a relaunch flag
 *  an older aio appended there. Pure. */
export function replayArgs(
  args: readonly string[],
  baked = false,
): string[] {
  const end = args.indexOf("--");
  const head = end < 0 ? args : args.slice(0, end);
  const own = baked && head[0]?.startsWith("--client=") ? head.slice(1) : head;
  const lastClient = own.findLastIndex((a) => a.startsWith("--client="));
  return [
    ...own.filter((a, i) =>
      !a.startsWith(RELAUNCH_FLAG) &&
      (i === lastClient || !a.startsWith("--client="))
    ),
    // A flag an older aio appended past `--` is still aio's, never the app's.
    ...(end < 0
      ? []
      : args.slice(end).filter((a) => !a.startsWith(RELAUNCH_FLAG))),
  ];
}

/** {@link replayArgs} of THIS process. aio's build bakes a `--client=` into
 *  every binary it compiles except a `"client": "cli"` one (build-compile.ts
 *  `bakedClientArgs`), and always embeds its build stamp; a hand-run
 *  `deno compile` does neither. Only a stamped, non-cli binary's first
 *  `--client=` is the bake — anywhere else it is the user's. */
export function ownReplayArgs(): string[] {
  let found: ReturnType<typeof locateDenoJsonAbove>;
  if (isCompiled()) {
    try {
      found = locateDenoJsonAbove(new URL(Deno.mainModule));
    } catch {
      // aio-ok: no usable main module — nothing was baked into it.
    }
  }
  return replayArgs(Deno.args, bakedClient(isCompiled(), found));
}

/** Did aio's build bake a `--client=` in front of this argv? See
 *  {@link ownReplayArgs}. Pure, with the stamp read injected. */
export function bakedClient(
  compiled: boolean,
  found: { config: Record<string, unknown>; dir: URL } | undefined,
  stamped: (dir: URL) => boolean = (dir) => readBuildStamp(dir) !== null,
): boolean {
  if (!compiled || !found) return false;
  const declared = found.config.client ?? found.config.target;
  return declared !== "cli" && stamped(found.dir);
}

/** Hand over to the newly-installed artifact.
 *
 *  The subtlety this exists for: aio takes a single-instance lock per appId and
 *  REFUSES to start when one is held, so the obvious "spawn the new process,
 *  then exit" loses the race — the new process asks for the lock while this one
 *  still owns it, is refused, and the app is simply gone.
 *
 *  So the successor is started with the predecessor's pid and waits for it to
 *  disappear before booting. No helper binary is needed: the artifact at that
 *  path is already the new version, and it is the one doing the waiting. */
export function relaunch(opts: {
  artifact: string;
  /** The original argv to replay, minus any previous relaunch flag. */
  args: string[];
}): void {
  // Inherit stdio so a terminal-run app keeps its output — but a `--no-terminal`
  // GUI exe opened by double-click has no console, and `inherit` throws
  // `Invalid handle` there: the update or `aio.restart()` then exited the app
  // and never started the successor.
  const child = spawnInheritingOrNull((stdio) => {
    const [cmd, o] = relaunchCommand(
      opts.artifact,
      relaunchOptions(opts.args, stdio),
    );
    return new Deno.Command(cmd, o);
  });
  child.unref();
}

/** Closes every inherited descriptor above stderr, then execs the successor
 *  (same pid). `$0` is the artifact, `$@` its argv. Only 3–9: dash (Debian's
 *  `/bin/sh`) parses `exec 12>&-` as running a command named `12` and dies
 *  before the final exec. */
export const CLOSE_FDS_EXEC = "for f in /proc/self/fd/*; do n=${f##*/}; " +
  'case $n in [3-9]) eval "exec $n>&-";; esac; done; exec "$0" "$@"';

/** {@link CLOSE_FDS_EXEC} for a shell that closes a two-digit fd too (bash,
 *  busybox ash). */
export const CLOSE_FDS_EXEC_ALL = "for f in /proc/self/fd/*; do " +
  'n=${f##*/}; [ "$n" -gt 2 ] 2>/dev/null && eval "exec $n>&-"; done; ' +
  'exec "$0" "$@"';

/** {@link CLOSE_FDS_EXEC_ALL} for bash. Chosen by the shell `relaunchCommand`
 *  resolved — never by `$BASH_VERSION`, which an environment can export into
 *  a dash. `set +p` first: `-p` (see {@link relaunchCommand}) has done its job
 *  by then, and left on it rides an exported `SHELLOPTS` into every bash the
 *  app starts. */
export const CLOSE_FDS_EXEC_BASH = `set +p; ${CLOSE_FDS_EXEC_ALL}`;

/** Variables a shell sets or rewrites on its way to the exec (`IFS`, `PWD`,
 *  `SHLVL`; bash `-p` replaces `SHELLOPTS`/`BASHOPTS`). With every name that
 *  is not a shell identifier (dash and busybox drop `my-var`, `BASH_FUNC_f%%`),
 *  they are handed back through `env` exactly as the successor would have
 *  inherited them directly — set to the same value, or unset. */
const SHELL_OWNED = [
  "IFS",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "SHELLOPTS",
  "BASHOPTS",
  "_",
];

/** The `env` argv that restores {@link SHELL_OWNED} and the non-identifier
 *  names of `env` — the environment the successor would inherit directly.
 *  Their values sit in argv only until `env` execs (same pid). Pure. */
export function envRestoreArgs(env: Record<string, string>): string[] {
  const unset = SHELL_OWNED.filter((k) => !Object.hasOwn(env, k)).flatMap((
    k,
  ) => [
    "-u",
    k,
  ]);
  const set = Object.entries(env)
    .filter(([k]) =>
      SHELL_OWNED.includes(k) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)
    )
    .map(([k, v]) => `${k}=${v}`);
  return [...unset, ...set];
}

/** The environment a spawn with these options hands its child, or null when
 *  this process may not read its own (no `--allow-env`). */
function spawnEnv(o: Deno.CommandOptions): Record<string, string> | null {
  try {
    return o.clearEnv ? { ...o.env } : { ...Deno.env.toObject(), ...o.env };
  } catch {
    // aio-ok: no env permission — the hop cannot restore what it cannot read.
    return null;
  }
}

/** The first shell present, and what it is through its links (`/bin/sh` →
 *  dash, busybox, or bash on NixOS), or null. Started by its own path:
 *  busybox picks the applet by that name. */
type Shell = { path: string; name: string };

function findShell(): Shell | null {
  for (const sh of ["/bin/bash", "/bin/sh"]) {
    try {
      if (Deno.statSync(sh).isFile) {
        const real = Deno.realPathSync(sh);
        return { path: sh, name: real.slice(real.lastIndexOf("/") + 1) };
      }
    } catch {
      // aio-ok: not installed — the next shell, or the successor starts directly.
    }
  }
  return null;
}

/** How the successor is started. On Linux, through a shell closing every
 *  descriptor it would inherit: an AppImage's runtime keeps its mount alive
 *  for as long as anyone holds its keep-alive pipe, and a relaunched successor
 *  inherited it — the OLD version's runtime and mount of the replaced file
 *  lived as long as the new version did (measured on a real AppImage update).
 *  Deno's spawn has no close-fds switch. `/bin/bash` first; under a
 *  `/bin/sh` that is not bash or busybox only 3–9 are closed (see
 *  {@link CLOSE_FDS_EXEC}). bash runs `-p`: a non-interactive bash sources
 *  `$BASH_ENV` first, and a script there that exits would end the handover
 *  with nothing started. The shell's own changes to the environment are
 *  undone through `env` (see {@link envRestoreArgs}); without `env`, or an
 *  artifact path `env` would read as an assignment, the successor gets the
 *  shell's environment. Without a shell, started directly. Pure, with the OS,
 *  the shell lookup and the `env` hop injected. */
export function relaunchCommand(
  artifact: string,
  o: Deno.CommandOptions,
  os: typeof Deno.build.os = Deno.build.os,
  shell: () => Shell | null = findShell,
  hop: () => { bin: string; env: Record<string, string> } | null = () => {
    const env = spawnEnv(o);
    try {
      return env && Deno.statSync("/usr/bin/env").isFile
        ? { bin: "/usr/bin/env", env }
        : null;
    } catch {
      // aio-ok: no `env` — the successor gets the shell's environment.
      return null;
    }
  },
): [string, Deno.CommandOptions] {
  const sh = os === "linux" ? shell() : null;
  if (!sh) return [artifact, o];
  const bash = sh.name === "bash";
  const script = bash
    ? CLOSE_FDS_EXEC_BASH
    : sh.name === "busybox"
    ? CLOSE_FDS_EXEC_ALL
    : CLOSE_FDS_EXEC;
  const via = artifact.includes("=") ? null : hop();
  return [sh.path, {
    ...o,
    args: [
      ...(bash ? ["-p", "-c", script] : ["-c", script]),
      ...(via ? [via.bin, ...envRestoreArgs(via.env)] : []),
      artifact,
      ...(o.args ?? []),
    ],
  }];
}

/** The relaunch flag goes BEFORE a bare `--`: past it the argv is the app's. */
function withRelaunchFlag(args: string[], pid: number): string[] {
  const end = args.indexOf("--");
  const flag = `${RELAUNCH_FLAG}=${pid}`;
  return end < 0
    ? [...args, flag]
    : [...args.slice(0, end), flag, ...args.slice(end)];
}

/** The successor's spawn options, as a pure value (the OS and pid are
 *  injected, so the Windows shape is a unit test anywhere). It must outlive
 *  this process, which is about to exit — see {@link outlivingParent}. */
export function relaunchOptions(
  args: string[],
  stdio: "inherit" | "null",
  os: typeof Deno.build.os = Deno.build.os,
  pid: number = Deno.pid,
): Deno.CommandOptions {
  return {
    args: withRelaunchFlag(replayArgs(args), pid),
    stdin: "null",
    stdout: stdio,
    stderr: stdio,
    ...outlivingParent(os),
  };
}

/** Block until the predecessor named by `--__aio-relaunch-after=<pid>` is gone,
 *  so the single-instance lock is free. Returns immediately when the flag is
 *  absent, which is every normal launch.
 *
 *  Bounded: if the old process hangs on shutdown we proceed anyway and let the
 *  lock's own diagnostics explain the refusal, rather than hanging forever in a
 *  state with no UI and no logs. */
export async function awaitPredecessor(
  args: string[],
  opts: { timeoutMs?: number; isAlive?: (pid: number) => boolean } = {},
): Promise<void> {
  const flag = args.find((a) => a.startsWith(`${RELAUNCH_FLAG}=`));
  if (!flag) return;
  const pid = Number.parseInt(flag.split("=")[1] ?? "", 10);
  if (!Number.isFinite(pid) || pid <= 0) return;
  const timeout = opts.timeoutMs ?? 30_000;
  // Signal 0 is the probe. `SIGCONT` was used here as if it were one, and it is
  // not: it RESUMES a stopped process, so probing whether the predecessor had
  // exited could restart one an operator had deliberately suspended. The
  // singleton lock has always used the right one.
  const alive = opts.isAlive ?? isProcessAlive;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!alive(pid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  log.warn(
    `update: previous instance (pid ${pid}) has not exited after ` +
      `${timeout / 1000}s — starting anyway`,
  );
}

// ── directory targets (electron-zip) ────────────────────────────────────────

/** The command that unpacks a `.zip` release on `os`.
 *
 *  Windows uses .NET's `ZipFile.ExtractToDirectory`, NOT `Expand-Archive`:
 *  Expand-Archive refuses any file whose name does not END in `.zip`, and the
 *  updater downloads to `<install>.zip-<version>` — so every electron-zip update
 *  on Windows failed at unpack ("… is not a supported archive file format"),
 *  after downloading and verifying it. `dest` is always a fresh directory.
 *  Paths go into single-quoted PowerShell strings, where `'` is written `''`.
 *
 *  @internal exported for tests */
export function unpackCommand(
  os: string,
  archive: string,
  dest: string,
): { cmd: string; args: string[] } {
  if (os !== "windows") {
    return { cmd: "unzip", args: ["-q", "-o", archive, "-d", dest] };
  }
  const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
  return {
    cmd: "powershell",
    args: [
      "-NoProfile",
      "-Command",
      "Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
      `[System.IO.Compression.ZipFile]::ExtractToDirectory(${q(archive)}, ${
        q(dest)
      })`,
    ],
  };
}

/** Unpack a release archive into `dest`.
 *
 *  Deno has no zip reader, so this shells out to the tool each platform
 *  actually ships (`unpackCommand`): PowerShell/.NET on Windows, `unzip`
 *  elsewhere. A missing tool is named explicitly — "unpack failed" with no
 *  cause is the kind of error that ends an update attempt and teaches nobody
 *  anything. */
export async function unpackArchive(
  archive: string,
  dest: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await Deno.mkdir(dest, { recursive: true });
  const { cmd: bin, args } = unpackCommand(Deno.build.os, archive, dest);
  const cmd = new Deno.Command(bin, { args, stderr: "piped" });
  try {
    const out = await cmd.output();
    if (!out.success) {
      return {
        ok: false,
        error: `unpacking ${archive} failed: ${
          new TextDecoder().decode(out.stderr).trim() || `exit ${out.code}`
        }`,
      };
    }
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: /No such file|not found|os error 2/i.test(msg)
        ? Deno.build.os === "windows"
          ? "powershell is not available — needed to unpack a .zip release"
          : "`unzip` is not installed — needed to unpack a .zip release"
        : msg,
    };
  }
}

/** Unpack a `.app.tar.gz` so `dest` IS the bundle (its one top entry,
 *  `X.app/`, stripped), with the system `tar` (bsdtar on macOS): symlinks stay
 *  links and exec bits stay set, which a signed `.app` needs. The seal does not
 *  cover the bundle's own folder name, so `X.app.staged-2.0.0` verifies
 *  (measured, macOS 14). */
export async function unpackAppTarball(
  archive: string,
  dest: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await Deno.mkdir(dest, { recursive: true });
  try {
    const out = await new Deno.Command("tar", {
      args: ["-xzf", archive, "-C", dest, "--strip-components", "1"],
      stdin: "null",
      stdout: "null",
      stderr: "piped",
    }).output();
    return out.success ? { ok: true } : {
      ok: false,
      error: `unpacking ${archive} failed: ${
        new TextDecoder().decode(out.stderr).trim() || `exit ${out.code}`
      }`,
    };
  } catch (e) {
    return {
      ok: false,
      error: `\`tar\` could not run (${
        e instanceof Error ? e.message : e
      }) — needed to unpack a .app.tar.gz release`,
    };
  }
}

/** The launcher inside an unpacked Electron release, as the build writes it. */
export function zipLauncher(dir: string): string {
  return join(dir, Deno.build.os === "windows" ? "run.bat" : "run.sh");
}

/** Replace a whole install DIRECTORY, from outside it.
 *
 *  A single-file target can be renamed under the running process, because a
 *  rename only moves a directory entry and the process keeps its inode. A
 *  DIRECTORY cannot: on Windows the running executable inside it is locked, and
 *  on every platform the successor would have to move the directory it is
 *  itself running from. There is no ordering that avoids this from inside.
 *
 *  So the move is handed to a process that lives in neither directory — the
 *  system shell, which is always present and always outside the install. It
 *  waits for this process to exit, swaps the directories, and starts the new
 *  launcher. On failure it puts the old directory back, so the worst case is
 *  the version you already had.
 *
 *  The pending marker is written BEFORE this is called, so a new build that
 *  cannot come up still rolls itself back on the next boot. */
export function swapDirectoryDetached(opts: {
  /** The install directory being replaced. */
  current: string;
  /** The unpacked new version, a sibling of `current`. */
  staged: string;
  /** Version being replaced — names the kept-aside copy. */
  fromVersion: string;
  /** Extra args to pass to the new launcher. */
  args?: string[];
  /** What starts the new version (default: its `run.sh`/`run.bat`). A macOS
   *  `.app` passes `/usr/bin/open` with `["-n", <app>, "--args", …]`. */
  launcher?: string;
  /** Write the rollback marker before the shell is handed the move. */
  pending?: PendingMark;
  /** Injected in tests; defaults to spawning the real shell. `extra` carries
   *  the environment and working directory the helper must run with. */
  spawn?: (
    cmd: string,
    args: string[],
    extra?: { env?: Record<string, string>; cwd?: string },
  ) => void;
}): { previous: string } {
  const previous = `${opts.current}.old-${opts.fromVersion}`;
  if (opts.pending) {
    writePending(opts.pending.dataDir, {
      from: opts.pending.from,
      to: opts.pending.to,
      artifact: opts.current,
      previous,
      backup: opts.pending.backup,
      fromExe: opts.pending.exe,
      attempts: 0,
      startedAt: new Date().toISOString(),
    });
    const token = firstBootPath(opts.pending.dataDir);
    Deno.copyFileSync(pendingPath(opts.pending.dataDir), `${token}.tmp`);
    Deno.renameSync(`${token}.tmp`, token);
  }
  const spawn = opts.spawn ??
    ((cmd, args, extra) => spawnSwapHelper(cmd, args, extra));

  const values: SwapValues = {
    pid: Deno.pid,
    current: opts.current,
    previous,
    staged: opts.staged,
    launcher: opts.launcher ?? zipLauncher(opts.current),
    mark: opts.pending ? pendingPath(opts.pending.dataDir) : "",
    token: opts.pending ? firstBootPath(opts.pending.dataDir) : "",
    failed: opts.pending ? failedUpdatePath(opts.pending.dataDir) : "",
    waitS: FIRST_BOOT_WAIT_S,
    args: opts.args ?? [],
  };
  // The unix script lives in the system temp directory — the one place that
  // is inside neither install. Windows needs no file (see `_swapSpec`).
  let scriptPath = "";
  if (Deno.build.os !== "windows") {
    scriptPath = Deno.makeTempFileSync({ prefix: "aio-swap-", suffix: ".sh" });
    Deno.writeTextFileSync(scriptPath, UNIX_SWAP_SH);
    Deno.chmodSync(scriptPath, 0o700);
  }
  const spec = _swapSpec(Deno.build.os, values, scriptPath);
  spawn(spec.cmd, spec.args, { env: spec.env, cwd: spec.cwd });
  return { previous };
}

/** Everything the detached swap helper needs, as plain values. @internal */
export interface SwapValues {
  pid: number;
  current: string;
  previous: string;
  staged: string;
  launcher: string;
  /** The pending marker, the first-boot token both sides race for ("" = do
   *  not watch), where the token goes when the helper wins, and how long the
   *  helper waits before it claims. */
  mark: string;
  token: string;
  failed: string;
  waitS: number;
  args: string[];
}

/** The detached swap helper's command line, as a PURE spec (testable from any
 *  OS).
 *
 *  NOTHING is interpolated into script text. It used to be built by string
 *  concatenation: an install directory containing a space broke it outright,
 *  and one containing `"; rm -rf ~; #` made it a self-injection sink reachable
 *  from a manifest field.
 *
 *  - unix: a constant `/bin/sh` script FILE (`scriptPath`), every value a
 *    positional argument — sh never re-parses an argument.
 *  - windows: NOT `cmd.exe /c <bat> …argv`. cmd re-parses its whole command
 *    line and the batch expands `%1` before parsing, so an install path with
 *    `&` (no space, so no quotes) ran the rest as a COMMAND, `%VAR%` expanded,
 *    and `!` vanished under delayed expansion (the same class `openExternal`
 *    fixed). PowerShell gets a constant script as `-EncodedCommand` (base64,
 *    nothing to parse) and every value as an ENVIRONMENT VARIABLE, which
 *    nothing parses. Its cwd is the install's parent: a helper whose current
 *    directory is INSIDE the install holds a handle that makes Windows refuse
 *    to move it. @internal */
export function _swapSpec(
  os: typeof Deno.build.os,
  v: SwapValues,
  scriptPath: string,
): {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  cwd: string;
} {
  // By the TARGET os's rules, so the spec is the same from any host.
  const cwd = os === "windows"
    ? winDirname(v.current)
    : posixDirname(v.current);
  if (os !== "windows") {
    return {
      cmd: "/bin/sh",
      args: [
        scriptPath,
        String(v.pid),
        v.current,
        v.previous,
        v.staged,
        v.launcher,
        v.mark,
        v.token,
        v.failed,
        String(v.waitS),
        ...v.args,
      ],
      cwd,
    };
  }
  const env: Record<string, string> = {
    AIO_SWAP_PID: String(v.pid),
    AIO_SWAP_CUR: v.current,
    AIO_SWAP_PREV: v.previous,
    AIO_SWAP_NEW: v.staged,
    AIO_SWAP_LAUNCH: v.launcher,
    AIO_SWAP_MARK: v.mark,
    AIO_SWAP_TOKEN: v.token,
    AIO_SWAP_FAILED: v.failed,
    AIO_SWAP_WAIT: String(v.waitS),
    AIO_SWAP_ARGC: String(v.args.length),
  };
  v.args.forEach((a, i) => (env[`AIO_SWAP_ARG_${i}`] = a));
  return {
    cmd: "powershell",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-EncodedCommand",
      encodePowerShell(WIN_SWAP_PS1),
    ],
    env,
    cwd,
  };
}

/** `-EncodedCommand` wants base64 of UTF-16LE. */
function encodePowerShell(script: string): string {
  const bytes = new Uint8Array(script.length * 2);
  for (let i = 0; i < script.length; i++) {
    const c = script.charCodeAt(i);
    bytes[i * 2] = c & 0xff;
    bytes[i * 2 + 1] = c >> 8;
  }
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Waits for the predecessor, swaps the two directories, starts the new
 *  launcher. On failure it puts the old directory back, so the worst case is
 *  the version you already had.
 *
 *  Then it OWNS THE ROLLBACK until the new version has started. The two-boot
 *  rollback (`judgePendingUpdate`) runs inside the new build, so a build that
 *  never starts — macOS refused to open it, it died before booting — can
 *  never judge itself. Its first boot deletes the first-boot token
 *  (`claimFirstBoot`), which hands the rollback back to the app. Still there
 *  after `wait` seconds: the helper claims it by renaming it to `failed` — one
 *  rename(2), so exactly one side wins the same instant — then stops every
 *  process running from the new install and waits for them BEFORE it moves a
 *  directory, removes the marker, puts the old directory back and starts it.
 *  A new version that loses the claim exits without touching anything. */
const UNIX_SWAP_SH = `#!/bin/sh
# aio update helper — written by swapDirectoryDetached. Every value is a
# positional argument; this file never contains one.
pid="$1"; cur="$2"; prev="$3"; new="$4"; launch="$5"; mark="$6"; token="$7"
failed="$8"; wait="$9"
shift 9
rm -f "$0"
# A move is retried: a process that is closing (and a scanner) can hold the
# directory for a moment.
try_mv() {
  i=0
  until mv "$1" "$2" 2>/dev/null; do
    i=$((i + 1)); [ "$i" -lt 50 ] || return 1; sleep 0.2
  done
}
# The swap could not be made: the first-boot token becomes the failed record,
# with why, so the next boot says it and does not install it again in a loop.
note() {
  [ -n "$token" ] && [ -f "$token" ] || return 0
  { printf '{\\n  "swapFailed": "%s",' "$1"; tail -c +2 "$token"; } >"$failed.tmp" && mv -f "$failed.tmp" "$failed" && rm -f "$token" "$mark"
}
# Start the install in place — or, when no move could put one there, whichever
# copy is left, the old one first, with the launcher and every argument that
# names the install directory aimed at it. The helper never ends with no app
# while a copy exists.
start() {
  for d in "$cur" "$prev" "$new"; do
    [ -e "$d" ] || continue
    # LaunchServices opens a bundle only under a .app name (measured, macOS
    # 14): a set-aside macOS copy is started by its executable, with the
    # app's own arguments (those after --args).
    if [ "$d" != "$cur" ] && [ -f "$d/Contents/Info.plist" ]; then
      x=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$d/Contents/Info.plist")
      while [ $# -gt 0 ] && [ "$1" != "--args" ]; do shift; done
      [ $# -gt 0 ] && shift
      exec "$d/Contents/MacOS/$x" "$@"
    fi
    l="$launch"
    case "$l" in "$cur"/*) l="$d\${l#"$cur"}" ;; esac
    n=$#
    while [ "$n" -gt 0 ]; do
      a="$1"; shift; [ "$a" = "$cur" ] && a="$d"; set -- "$@" "$a"; n=$((n - 1))
    done
    exec "$l" "$@"
  done
  exit 1
}
# The rollback could not be made: the failed record says so FIRST, then an
# install is started.
unrolled() {
  why="$1"; shift
  { printf '{\\n  "rollbackFailed": "%s",' "$why"; tail -c +2 "$failed"; } >"$failed.tmp" && mv -f "$failed.tmp" "$failed"
  start "$@"
}
# The new version claimed the rollback the aio <= 1.0.12 way: that build never
# takes the token — its boot rewrites the marker, or removes it. Only a marker
# that is gone, or that reads differently from "$1", is that claim. A read
# error is not, and no cmp is needed (a box without diffutils has none).
claimed() {
  [ -e "$mark" ] || return 0
  a=$(cat "$mark") && b=$(cat "$1") || return 1
  [ "$a" != "$b" ]
}
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
rm -rf "$prev"
if [ -e "$prev" ] || ! try_mv "$cur" "$prev"; then
  note "the running version could not be moved aside"
  exec "$launch" "$@"
fi
if ! try_mv "$new" "$cur"; then
  if try_mv "$prev" "$cur"; then
    note "the new version could not be moved into place"
    rm -rf "$new"
    exec "$launch" "$@"
  fi
  note "the new version could not be moved into place, nor the old one back"
  start "$@"
fi
[ -n "$token" ] && [ -f "$token" ] || exec "$launch" "$@"
"$launch" "$@" </dev/null &
i=0
while [ "$i" -lt "$wait" ]; do
  [ -f "$token" ] || exit 0
  claimed "$token" && { rm -f "$token"; exit 0; }
  sleep 1; i=$((i + 1))
done
mv -f "$token" "$failed" 2>/dev/null || exit 0
# ...and such a boot at the very instant of the claim keeps the version too.
claimed "$failed" && { rm -f "$failed"; exit 0; }
real=$(cd "$cur" && pwd -P) && [ -n "$real" ] || real="$cur"
running() {
  ps -A -ww -o pid= -o args= | while read -r p a; do
    case "$a" in "$cur"/*|"$real"/*) echo "$p" ;; esac
  done
}
for sig in TERM KILL; do
  i=0
  while [ "$i" -lt 50 ]; do
    ps=$(running)
    [ -z "$ps" ] && break
    kill -s "$sig" $ps 2>/dev/null
    sleep 0.2; i=$((i + 1))
  done
done
rm -f "$mark"
try_mv "$cur" "$new" || unrolled "the new version could not be moved out of the way" "$@"
if ! try_mv "$prev" "$cur"; then
  try_mv "$new" "$cur" || unrolled "the old version could not be moved back into place, nor the new one" "$@"
  unrolled "the old version could not be moved back into place" "$@"
fi
rm -rf "$new"
exec "$launch" "$@"
`;

/** Constant: every value arrives in an `AIO_SWAP_*` environment variable.
 *  Paths go through .NET (`[IO.Directory]::Move`, `Process.Start`) and
 *  `-LiteralPath`, never a wildcard-expanding parameter: `Start-Process
 *  -WorkingDirectory` treated an install dir named `…[1]` as a pattern and
 *  refused it (measured, Windows 11). The launcher is a .bat, so cmd is
 *  unavoidable for IT — but it is started by bare NAME from its own directory,
 *  so the install path never appears on a command line cmd parses (a quoted
 *  `%VAR%` still expands there, and ShellExecute of a .bat whose path holds
 *  `&` never ran it — both measured). The replayed argv is quoted per the
 *  Windows argv convention. */
const WIN_SWAP_PS1 = `$ErrorActionPreference = 'Stop'
$p = [int]$env:AIO_SWAP_PID
$cur = $env:AIO_SWAP_CUR
$prev = $env:AIO_SWAP_PREV
$new = $env:AIO_SWAP_NEW
$launch = $env:AIO_SWAP_LAUNCH
$mark = $env:AIO_SWAP_MARK
$token = $env:AIO_SWAP_TOKEN
$failed = $env:AIO_SWAP_FAILED
$wait = [int]$env:AIO_SWAP_WAIT
$n = [int]$env:AIO_SWAP_ARGC
$argv = @(for ($i = 0; $i -lt $n; $i++) { [Environment]::GetEnvironmentVariable("AIO_SWAP_ARG_$i") })
Get-ChildItem Env: | Where-Object { $_.Name -like 'AIO_SWAP_*' } | ForEach-Object { Remove-Item -LiteralPath ("Env:" + $_.Name) }
function Start-App {
  $q = @($argv | ForEach-Object { '"' + (($_ -replace '(\\\\*)"', '$1$1\\"') -replace '(\\\\+)$', '$1$1') + '"' })
  $si = New-Object System.Diagnostics.ProcessStartInfo
  $si.FileName = 'cmd.exe'
  $si.Arguments = '/d /s /c "' + ((@('"' + [IO.Path]::GetFileName($launch) + '"') + $q) -join ' ') + '"'
  $si.WorkingDirectory = [IO.Path]::GetDirectoryName($launch)
  $si.UseShellExecute = $false
  $si.CreateNoWindow = $true
  [void][System.Diagnostics.Process]::Start($si)
}
# The install in place — or, when no move could put one there, whichever copy
# is left, the old one first. Never no app while a copy exists.
function Start-Any {
  foreach ($d in @($cur, $prev, $new)) {
    if (-not [IO.Directory]::Exists($d)) { continue }
    if ($launch.StartsWith($cur + '\\', [StringComparison]::OrdinalIgnoreCase)) { $script:launch = $d + $launch.Substring($cur.Length) }
    Start-App; return
  }
}
# Read without locking: a new build renames or deletes these files while the
# helper reads them, and a plain read (no FileShare.Delete) made that fail.
function Read-Shared($f) {
  $s = New-Object IO.FileStream($f, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  try { (New-Object IO.StreamReader($s)).ReadToEnd() } finally { $s.Dispose() }
}
function Get-Running {
  try { @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($cur + '\\', [StringComparison]::OrdinalIgnoreCase) }) } catch { @() }
}
function Remove-File($f) {
  for ($i = 0; $i -lt 50; $i++) {
    try { [IO.File]::Delete($f); return } catch { Start-Sleep -Milliseconds 200 }
  }
}
function Test-Claimed($t) {
  try { -not [IO.File]::Exists($mark) -or (Read-Shared $mark) -cne (Read-Shared $t) } catch { $false }
}
function Move-Dir($a, $b) {
  for ($i = 0; $i -lt 50; $i++) {
    try { [IO.Directory]::Move($a, $b); return $true } catch { Start-Sleep -Milliseconds 200 }
  }
  return $false
}
function Write-Failed($why) {
  if (-not $token -or -not [IO.File]::Exists($token)) { return }
  try {
    $j = Read-Shared $token
    [IO.File]::WriteAllText($failed + '.tmp', '{' + [char]10 + '  "swapFailed": "' + $why + '",' + $j.Substring(1))
    if ([IO.File]::Exists($failed)) { [IO.File]::Delete($failed) }
    [IO.File]::Move($failed + '.tmp', $failed)
    [IO.File]::Delete($token)
    [IO.File]::Delete($mark)
  } catch {}
}
function Set-Unrolled($why) {
  try {
    $j = Read-Shared $failed
    [IO.File]::WriteAllText($failed + '.tmp', '{' + [char]10 + '  "rollbackFailed": "' + $why + '",' + $j.Substring(1))
    Remove-File $failed
    [IO.File]::Move($failed + '.tmp', $failed)
  } catch {}
  Start-Any
}
function Remove-Dir($d) { try { Remove-Item -LiteralPath $d -Recurse -Force } catch {} }
while (Get-Process -Id $p -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 200 }
for ($i = 0; $i -lt 150 -and (Get-Running).Count -gt 0; $i++) { Start-Sleep -Milliseconds 200 }
if (Test-Path -LiteralPath $prev) { Remove-Dir $prev }
if ((Test-Path -LiteralPath $prev) -or -not (Move-Dir $cur $prev)) {
  Write-Failed 'the running version could not be moved aside'; Start-App; exit 1
}
if (-not (Move-Dir $new $cur)) {
  if (Move-Dir $prev $cur) {
    Write-Failed 'the new version could not be moved into place'; Remove-Dir $new; Start-App; exit 1
  }
  Write-Failed 'the new version could not be moved into place, nor the old one back'; Start-Any; exit 1
}
if (-not $token -or -not [IO.File]::Exists($token)) { Start-App; exit 0 }
Start-App
for ($i = 0; $i -lt $wait; $i++) {
  if (-not [IO.File]::Exists($token)) { exit 0 }
  if (Test-Claimed $token) { Remove-File $token; exit 0 }
  Start-Sleep -Seconds 1
}
Remove-File $failed
try { [IO.File]::Move($token, $failed) } catch { exit 0 }
if (Test-Claimed $failed) { Remove-File $failed; exit 0 }
for ($i = 0; $i -lt 50; $i++) {
  $ps = Get-Running
  if ($ps.Count -eq 0) { break }
  $ps | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 200
}
Remove-File $mark
if (-not (Move-Dir $cur $new)) { Set-Unrolled 'the new version could not be moved out of the way'; exit 1 }
if (-not (Move-Dir $prev $cur)) {
  if (Move-Dir $new $cur) { Set-Unrolled 'the old version could not be moved back into place' }
  else { Set-Unrolled 'the old version could not be moved back into place, nor the new one' }
  exit 1
}
Remove-Dir $new
Start-App
`;
