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
import { dirname, isAbsolute, join, resolve } from "@std/path";
import { pruneVersions, reconcileInstalledVersion } from "./install-record.ts";
import { isProcessAlive } from "./single-instance-lock.ts";
import type { UpdateTarget } from "../build/ship.ts";
import { log } from "../diagnostics/logger-api.ts";

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
    : (Deno.env.get("APPIMAGE") ?? null);
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
export function classifyTarget(f: ProcessFacts): UpdateTarget {
  // Running from source: the executable is the `deno` binary itself, and there
  // is no artifact to swap. Detect works; apply refuses.
  if (/(^|[\\/])deno(\.exe)?$/i.test(f.execPath)) return "source";
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

export function detectTarget(): UpdateTarget {
  const execPath = Deno.execPath();
  const appImage = Deno.env.get("APPIMAGE") ?? null;
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
export function installableTargets(
  t: UpdateTarget = detectTarget(),
): UpdateTarget[] {
  // Running from source, DETECTION is universal — the update UI has to be
  // developable against a real source, and dev must not take a different code
  // path from prod. `apply` is where a source tree refuses, loudly, because
  // that is the only step it genuinely cannot perform.
  if (t === "source") {
    return ["binary", "appimage", "electron-appimage", "electron-zip"];
  }
  // An AppImage and a plain binary are both "one executable file", so the
  // rename strategy covers both and either manifest is installable here.
  if (t === "appimage" || t === "electron-appimage") {
    return ["appimage", "electron-appimage"];
  }
  if (t === "electron-zip") return ["electron-zip"];
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
  /** Backup taken because the update migrates data — restored on rollback,
   *  since putting the old binary back cannot un-migrate a store. */
  backup?: string;
  attempts: number;
  startedAt: string;
};

const PENDING = "update-pending.json";

export function pendingPath(dataDir: string): string {
  return join(dataDir, PENDING);
}

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
  const path = pendingPath(dataDir);
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
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(path, {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error:
        `the downloaded artifact cannot be executed (${msg}) — it is the ` +
        `wrong architecture, or ${dirname(path)} is mounted noexec. The ` +
        `update was NOT installed; the running version is untouched.`,
    };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch { /* already gone */ }
  }, timeoutMs);
  let out: Deno.CommandOutput;
  try {
    out = await child.output();
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) {
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
    const stderr = new TextDecoder().decode(out.stderr).trim().split("\n")
      .slice(-2).join(" ");
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

/** What to record before a swap so the new build can undo it. Passing this is
 *  what makes the update recoverable — see `writePending`. */
export type PendingMark = {
  dataDir: string;
  from: string;
  to: string;
  backup?: string;
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
  await reconcileInstalledVersion(dirname(opts.current), {
    version: opts.toVersion,
    artifact: opts.current.slice(dirname(opts.current).length + 1),
  });
  return { previous };
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
 *  Throws with the paths named when it cannot finish. The caller must NOT
 *  swallow that: a rollback that failed and said nothing is the worst of the
 *  three possible outcomes. */
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
    await Deno.remove(tmpLink).catch(() => {});
    await Deno.symlink(previous, tmpLink);
    await Deno.rename(tmpLink, current);
    return;
  }
  // Move whatever is at the stable path aside FIRST. A directory cannot be
  // renamed onto, and a file that is still open on Windows cannot be replaced —
  // both are fixed by vacating the name before filling it.
  let aside: string | null = null;
  if (await lexists(current)) {
    aside = `${current}.failed-${Date.now()}`;
    await Deno.rename(current, aside);
  }
  try {
    await Deno.rename(previous, current);
  } catch (e) {
    if (aside) await Deno.rename(aside, current).catch(() => {});
    throw e;
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

/** The flag a relaunching process carries so it knows to wait for its
 *  predecessor. Internal, and named to say so. */
export const RELAUNCH_FLAG = "--__aio-relaunch-after";

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
  const args = opts.args.filter((a) => !a.startsWith(RELAUNCH_FLAG));
  const cmd = new Deno.Command(opts.artifact, {
    args: [...args, `${RELAUNCH_FLAG}=${Deno.pid}`],
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  });
  // Detached: the successor must outlive this process, which is about to exit.
  cmd.spawn().unref();
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
    `[aio] update: previous instance (pid ${pid}) has not exited after ` +
      `${timeout / 1000}s — starting anyway`,
  );
}

// ── directory targets (electron-zip) ────────────────────────────────────────

/** Unpack a release archive into `dest`.
 *
 *  Deno has no zip reader, so this shells out to the tool each platform
 *  actually ships: PowerShell's `Expand-Archive` on Windows, `unzip` elsewhere.
 *  A missing tool is named explicitly — "unpack failed" with no cause is the
 *  kind of error that ends an update attempt and teaches nobody anything. */
export async function unpackArchive(
  archive: string,
  dest: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await Deno.mkdir(dest, { recursive: true });
  const cmd = Deno.build.os === "windows"
    ? new Deno.Command("powershell", {
      args: [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dest}' -Force`,
      ],
      stderr: "piped",
    })
    : new Deno.Command("unzip", {
      args: ["-q", "-o", archive, "-d", dest],
      stderr: "piped",
    });
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
  /** Write the rollback marker before the shell is handed the move. */
  pending?: PendingMark;
  /** Injected in tests; defaults to spawning the real shell. */
  spawn?: (cmd: string, args: string[]) => void;
}): { previous: string } {
  const previous = `${opts.current}.old-${opts.fromVersion}`;
  if (opts.pending) {
    writePending(opts.pending.dataDir, {
      from: opts.pending.from,
      to: opts.pending.to,
      artifact: opts.current,
      previous,
      backup: opts.pending.backup,
      attempts: 0,
      startedAt: new Date().toISOString(),
    });
  }
  const pid = Deno.pid;
  const launcher = zipLauncher(opts.current);
  const extra = opts.args ?? [];

  const spawn = opts.spawn ?? ((cmd: string, args: string[]) => {
    new Deno.Command(cmd, {
      args,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn().unref();
  });

  // NOTHING is interpolated into the script. Every path, the version and the
  // replayed argv arrive as POSITIONAL ARGUMENTS, because the script text used
  // to be built by string concatenation: an install directory containing a
  // space broke it outright, and one containing `"; rm -rf ~; #` made it a
  // self-injection sink reachable from a manifest field. The script itself is
  // a constant, and it lives in the system temp directory — the one place that
  // is inside neither install.
  const script = Deno.build.os === "windows" ? WIN_SWAP_BAT : UNIX_SWAP_SH;
  const path = Deno.makeTempFileSync({
    prefix: "aio-swap-",
    suffix: Deno.build.os === "windows" ? ".bat" : ".sh",
  });
  Deno.writeTextFileSync(path, script);
  if (Deno.build.os !== "windows") Deno.chmodSync(path, 0o700);
  const argv = [
    String(pid),
    opts.current,
    previous,
    opts.staged,
    launcher,
    ...extra,
  ];
  if (Deno.build.os === "windows") spawn("cmd.exe", ["/c", path, ...argv]);
  else spawn("/bin/sh", [path, ...argv]);
  return { previous };
}

/** Waits for the predecessor, swaps the two directories, starts the new
 *  launcher. On failure it puts the old directory back, so the worst case is
 *  the version you already had. */
const UNIX_SWAP_SH = `#!/bin/sh
# aio update helper — written by swapDirectoryDetached. Every value is a
# positional argument; this file never contains one.
pid="$1"; cur="$2"; prev="$3"; new="$4"; launch="$5"
shift 5
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
rm -rf "$prev"
mv "$cur" "$prev" || exit 1
mv "$new" "$cur" || { mv "$prev" "$cur"; exit 1; }
exec "$launch" "$@"
`;

const WIN_SWAP_BAT = `@echo off
setlocal EnableDelayedExpansion
rem aio update helper — written by swapDirectoryDetached. Every value is a
rem positional argument; this file never contains one.
set "PID=%~1"
set "CUR=%~2"
set "PREV=%~3"
set "NEW=%~4"
set "LAUNCH=%~5"
shift & shift & shift & shift & shift
set "ARGS="
:collect
if "%~1"=="" goto ready
set "ARGS=!ARGS! "%~1""
shift
goto collect
:ready
rem \`ping\` as a sleep is the portable idiom here: \`timeout\` fails without a
rem console, which a detached updater does not have.
:wait
tasklist /FI "PID eq %PID%" | find "%PID%" >nul && (ping -n 2 127.0.0.1 >nul & goto wait)
if exist "%PREV%" rmdir /S /Q "%PREV%"
move /Y "%CUR%" "%PREV%" >nul || exit /b 1
move /Y "%NEW%" "%CUR%" >nul || (move /Y "%PREV%" "%CUR%" >nul & exit /b 1)
start "" "%LAUNCH%" !ARGS!
`;
