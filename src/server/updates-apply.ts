// updates-apply.ts — installing a verified release, per target.
//
// One spine, five endings. Everything up to the swap is identical (download →
// verify → stage); only how the artifact is put in place and how the process
// comes back differ. The rules that make this boring:
//
//   • Nothing is swapped that has not been verified against a trusted key.
//   • Nothing is deleted before the replacement is in place and healthy.
//   • The process never rewrites its own running binary — it renames a file
//     and hands over to a fresh process.
//   • A failed boot after an update rolls itself back, because the case that
//     most needs a rollback (an unattended service) has nobody to run one.
import { dirname, join } from "@std/path";
import type { UpdateTarget } from "../build/ship.ts";

/** Where the artifact that is actually running lives on disk.
 *
 *  Inside an AppImage, `Deno.execPath()` points into the read-only squashfs
 *  mount, which vanishes with the process — the file the user launched, and the
 *  one an update must replace, is `$APPIMAGE`. Getting this wrong writes the
 *  new version into a temporary mountpoint and silently loses it. */
export function artifactPath(): string {
  const appImage = Deno.env.get("APPIMAGE");
  if (appImage) return appImage;
  return Deno.execPath();
}

/** What kind of install this process is, decided from the process itself
 *  rather than from configuration — configuration can be copied between
 *  machines, the runtime facts cannot. */
export function detectTarget(): UpdateTarget {
  // Running from source: the executable is the `deno` binary itself, and there
  // is no artifact to swap. Detect works; apply refuses.
  const exec = Deno.execPath();
  const isDeno = /(^|[\\/])deno(\.exe)?$/i.test(exec);
  if (isDeno) return "source";
  if (Deno.env.get("APPIMAGE")) {
    return Deno.env.get("AIO_ELECTRON") ? "electron-appimage" : "appimage";
  }
  // An unpacked Electron release: a launcher and a bundled `electron/` sitting
  // above us. That directory — not the executable — is what an update replaces.
  if (installDir()) return "electron-zip";
  return "binary";
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
export function installableTargets(): UpdateTarget[] {
  const t = detectTarget();
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
  try {
    return JSON.parse(Deno.readTextFileSync(pendingPath(dataDir)));
  } catch {
    return null;
  }
}

export function writePending(dataDir: string, p: PendingUpdate): void {
  Deno.writeTextFileSync(pendingPath(dataDir), JSON.stringify(p, null, 2));
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
  | { action: "rollback"; to: string; previous: string; backup?: string };

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
    previous: p.previous,
    backup: p.backup,
  };
}

/** Put a downloaded, VERIFIED artifact in place.
 *
 *  The order is what makes it safe. The current artifact is copied aside
 *  first, then the replacement is renamed over it — `rename` is atomic within
 *  a filesystem, so the path is never missing, and a crash at any point leaves
 *  either the old version or the new one, never neither.
 *
 *  Renaming over a RUNNING executable is deliberate and correct on Unix: the
 *  kernel refuses a write to a busy binary (ETXTBSY) but a rename only moves a
 *  directory entry. The running process keeps its inode — and, for an AppImage,
 *  its mount — while the path now resolves to the new version, which is exactly
 *  what the next launch needs. */
export async function swapArtifact(opts: {
  /** The artifact currently running — the file to replace. */
  current: string;
  /** The verified replacement, already downloaded. Must be on the same
   *  filesystem as `current`, or the rename is not atomic. */
  staged: string;
  /** Version being replaced, for the kept-aside copy's name. */
  fromVersion: string;
}): Promise<{ previous: string }> {
  const previous = `${opts.current}.old-${opts.fromVersion}`;
  await Deno.copyFile(opts.current, previous);
  if (Deno.build.os !== "windows") await Deno.chmod(opts.staged, 0o755);
  await Deno.rename(opts.staged, opts.current);
  return { previous };
}

/** Undo a swap: put the kept-aside artifact back. */
export async function restoreArtifact(
  current: string,
  previous: string,
): Promise<void> {
  await Deno.rename(previous, current);
}

/** Keep the N most recent kept-aside artifacts, delete older ones. A manual
 *  rollback is then a rename, not a re-download. */
export async function pruneOld(current: string, keep: number): Promise<void> {
  const dir = dirname(current);
  await pruneKeepingNewest(dir, `${current.slice(dir.length + 1)}.old-`, keep);
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
      if (!e.isFile || !e.name.startsWith(prefix)) continue;
      const st = await Deno.stat(join(dir, e.name)).catch(() => null);
      found.push({ name: e.name, mtime: st?.mtime?.getTime() ?? 0 });
    }
  } catch {
    return; // no such directory — nothing was ever kept here
  }
  found.sort((a, b) => b.mtime - a.mtime);
  for (const f of found.slice(keep)) {
    await Deno.remove(join(dir, f.name)).catch(() => {});
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
  const alive = opts.isAlive ?? ((p: number) => {
    try {
      Deno.kill(p, "SIGCONT" as Deno.Signal); // signal 0 equivalent — probes only
      return true;
    } catch {
      return false;
    }
  });
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!alive(pid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  console.warn(
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
  /** Injected in tests; defaults to spawning the real shell. */
  spawn?: (cmd: string, args: string[]) => void;
}): { previous: string } {
  const previous = `${opts.current}.old-${opts.fromVersion}`;
  const pid = Deno.pid;
  const launcher = zipLauncher(opts.current);
  const extra = (opts.args ?? []).join(" ");

  const spawn = opts.spawn ?? ((cmd: string, args: string[]) => {
    new Deno.Command(cmd, {
      args,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn().unref();
  });

  if (Deno.build.os === "windows") {
    // `ping` as a sleep is the portable idiom here: `timeout` fails without a
    // console, which a detached updater does not have.
    const script = [
      `:wait`,
      `tasklist /FI "PID eq ${pid}" | find "${pid}" >nul && (ping -n 2 127.0.0.1 >nul & goto wait)`,
      `move /Y "${opts.current}" "${previous}" >nul || exit /b 1`,
      `move /Y "${opts.staged}" "${opts.current}" >nul || (move /Y "${previous}" "${opts.current}" >nul & exit /b 1)`,
      `start "" "${launcher}" ${extra}`,
    ].join(" & ");
    spawn("cmd.exe", ["/c", script]);
  } else {
    const script = `while kill -0 ${pid} 2>/dev/null; do sleep 0.2; done; ` +
      `mv "${opts.current}" "${previous}" || exit 1; ` +
      `mv "${opts.staged}" "${opts.current}" || { mv "${previous}" "${opts.current}"; exit 1; }; ` +
      `exec "${launcher}" ${extra}`;
    spawn("/bin/sh", ["-c", script]);
  }
  return { previous };
}
