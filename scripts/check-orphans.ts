// Nothing outlives the run.
//
// A test that hangs and is then killed by an outer `timeout` never reaches its
// `finally`, and the aio app it spawned is reparented to init — holding its
// port, its lock, and (exposed) a LAN-visible listener. One ran for 5 h on a
// developer machine, answering `am discover` as a ghost, invisible to
// `am instances` because its lock sat in a per-`AIO_APPS_DIR` lock dir.
//
// This is the gate: every `aio*` lock dir under $XDG_RUNTIME_DIR and /tmp is
// scanned, and a live lock in a SCOPED dir (anything but the shared `…/aio`)
// is an app a test started and did not stop — red, with pid and command line.
// A lock whose owner still has a living `AIO_PARENT_PID` is skipped: another
// suite on this machine is mid-run, and its apps are its business.
//
//   deno task check:orphans          report (exit 1 if any)
//   …--clean-stale                   sweep finished runs' lock dirs only —
//                                    no process signalled, no temp home
//                                    removed. `deno task test` runs this right
//                                    after the test-home reset, because
//                                    nothing else ever did: they accumulated
//                                    across every run (664 against a ceiling
//                                    of 400 when this landed) and turned this
//                                    gate red at no defect.
//   deno task clean:tmp              also SIGTERM them, remove ownerless
//                                    /tmp/aio-* dirs, stale lock dirs and
//                                    stale watcher sentinels
import { basename, DELIMITER, join, SEPARATOR } from "@std/path";
import {
  foreignOwnerRefusal,
  isLockOwnerAlive,
  type LockData,
  pruneDeadLockDirAt,
  removeLockFileIf,
  rootRegistryEntry,
  sweepRootRegistry,
  taggedOwnerGone,
} from "../src/server/single-instance-lock.ts";
import { LIVE_OWNER } from "../src/testing/temp-dir.ts";
import { pruneTestWorktrees } from "./test-shards.ts";

const clean = Deno.args.includes("--clean");
/** Sweep only the DEBRIS a finished run leaves: scoped lock dirs with no live
 *  lock in them. No process is signalled and no temp home is removed, so this
 *  is safe to run at the START of a suite — which is where it belongs.
 *
 *  Without it nothing ever cleared them. `deno task test` resets
 *  `.aio-test-home` so "no run inherits another's" holds for app DATA, and the
 *  per-run lock dirs beside it accumulated across every run ever made:
 *  measured at 664 on this machine, against a ceiling of 400. The gate then
 *  goes red at no defect, which is the one thing a gate must not do — a real
 *  orphan (the 5-hour ghost app this file exists for) would be reported among
 *  six hundred false ones and read as more of the same. */
const staleOnly = Deno.args.includes("--clean-stale");
const dec = new TextDecoder();

function alive(pid: number): boolean {
  try {
    Deno.kill(pid, 0);
    return true;
  } catch (e) {
    return e instanceof Deno.errors.PermissionDenied;
  }
}

/** Is the owner of `lock` (read from a file in `dir`) alive — judged as the
 *  lock module judges it, never by a bare pid: a lock written in another pid
 *  namespace (a container sharing the dir) names a pid that is a stranger
 *  here, and only its hold file says whether it lives. */
function ownerAlive(lock: Partial<LockData> | null, dir: string): boolean {
  if (typeof lock?.pid !== "number" || !(lock.pid > 0)) return false;
  const hold = typeof lock.hold === "string"
    ? join(dir, basename(lock.hold))
    : undefined;
  return isLockOwnerAlive({ ...lock, pid: lock.pid, hold });
}

/** /proc only — elsewhere the answer is "unknown", which counts as orphan. */
function envOf(pid: number): Record<string, string> | null {
  try {
    const raw = Deno.readFileSync(`/proc/${pid}/environ`);
    const out: Record<string, string> = {};
    for (const kv of dec.decode(raw).split("\0")) {
      const i = kv.indexOf("=");
      if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return out;
  } catch {
    return null;
  }
}
function cmdlineOf(pid: number): string {
  try {
    return dec.decode(Deno.readFileSync(`/proc/${pid}/cmdline`))
      .split("\0").filter(Boolean).join(" ");
  } catch {
    return listed.get(pid)?.text ?? "?";
  }
}
/** Where there is no /proc: pid → its OS parent and what the OS shows of it
 *  (`processRefs` fills it — macOS the command line with the environment,
 *  Windows the command line). It was nothing, so there every test RUNNER read
 *  as "?" — not a runner — and a fixture lock a live suite wrote with its own
 *  pid was an ORPHAN: `clean:tmp` on Windows ended the suite. */
const listed = new Map<number, { parent: number; text: string }>();
/** Whether `root` is a test process's `apps-<pid>` sandbox
 *  (src/testing/test-strict.ts) and that process is still a live deno. On
 *  Windows the process table of the last look says (`listed`); a recycled
 *  pid there is a deno only by chance. Elsewhere a signal 0 does. */
function sandboxOwnerLive(root: string): boolean {
  const pid = Number(/^apps-(\d+)$/.exec(basename(root))?.[1] ?? NaN);
  if (!(pid > 0)) return false;
  if (Deno.build.os !== "windows") return alive(pid);
  return /\bdeno(\.exe)?\b/i.test(listed.get(pid)?.text ?? "");
}
/** The process that started `pid` and that it dies with (`AIO_PARENT_PID`):
 *  read from its environment — and on Windows, which shows nobody that, its
 *  OS parent, the same process for an app a test spawned. 0 when unknown. */
function parentOf(pid: number): number {
  const said = envOf(pid)?.AIO_PARENT_PID ??
    /(?:^|\s)AIO_PARENT_PID=(\d+)/.exec(listed.get(pid)?.text ?? "")?.[1];
  if (said !== undefined) return Number(said);
  return Deno.build.os === "windows" ? listed.get(pid)?.parent ?? 0 : 0;
}

function lockRoots(): string[] {
  // A test's seam: its own fake runtime base ONLY, so the gate's test never
  // scans — let alone prunes — the machine's real `/tmp`.
  const only = Deno.env.get("AIO_ORPHANS_LOCK_ROOTS");
  if (only) return only.split(DELIMITER).filter(Boolean);
  const roots = new Set<string>();
  const xdg = Deno.env.get("XDG_RUNTIME_DIR");
  if (xdg) roots.add(xdg);
  roots.add(
    Deno.build.os === "windows" ? (Deno.env.get("TEMP") ?? "") : "/tmp",
  );
  return [...roots].filter(Boolean);
}

/** Temp roots a leftover app's cwd/home can sit under.
 *
 *  Includes the TEST root (`AIO_TEST_ROOT`, else `~/tmp/aio`). A harness pins
 *  every app directory into one, so a leftover lock under it is a test's
 *  leftover exactly as a `/tmp/aio-*` one is — and this list decided which
 *  stale locks were in scope, so locks in that tree were never reaped. */
function tempRoots(): string[] {
  const out = ["/tmp", "/var/tmp"];
  for (const v of ["TMPDIR", "TEMP", "TMP"]) {
    const p = Deno.env.get(v);
    // Strip EITHER separator: a Windows `%TEMP%` may end in `\`, and the
    // containment test below appends the platform separator.
    if (p) out.push(p.replace(/[/\\]+$/, ""));
  }
  const override = Deno.env.get("AIO_TEST_ROOT")?.trim();
  const home = (Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "")
    .replace(/[/\\]+$/, "");
  const testRoot = override || (home ? join(home, "tmp", "aio") : "");
  if (testRoot) out.push(testRoot);
  return out;
}
const TEMP_ROOTS = tempRoots();

/** How long "another suite is mid-run" stays a believable reason to skip an
 *  app. The longest gate in this repo (`test:onboard`) is minutes; four hours
 *  is generous by two orders of magnitude and still catches a ghost that has
 *  been holding a port since the day before yesterday. */
const PARENT_GRACE_MS = 4 * 60 * 60_000;

/** True when this lock's app was started from a temp directory — the shape of
 *  a test or a session leftover, never of an app someone installed. */
function tempRooted(lock: { cwd?: string; home?: string } | null): boolean {
  for (const p of [lock?.cwd, lock?.home]) {
    if (typeof p !== "string" || p === "") continue;
    // SEPARATOR, not "/": a Windows temp root is `C:\…\Temp`, so a hardcoded
    // `/` prefix never matched and shared-`%TEMP%` orphans were invisible to
    // the clean-up gate. Same rule as `paths.ts` / `app-dirs.ts`.
    if (
      TEMP_ROOTS.some((r) =>
        p === r || p.startsWith(r.endsWith(SEPARATOR) ? r : r + SEPARATOR)
      )
    ) {
      return true;
    }
  }
  return false;
}

type Orphan = { pid: number; appId: string; port: number; dir: string };
const orphans: Orphan[] = [];

/** What the live process a lock with NO start token names actually is.
 *
 *  A lock records its owner's start time so a reused pid is told from the
 *  owner (`isLockOwnerAlive`). One without it — written before 1.0.19, or by
 *  hand as a fixture — falls back to "the pid is alive", and a pid the system
 *  has since given to something else then read as a live aio app: reported
 *  as an ORPHAN, and SIGTERMed by `clean:tmp` (seen on Windows naming
 *  `dllhost.exe` and `msedge.exe`).
 *
 *  So it is judged by what the process IS, with the decider `am kill --stale`
 *  already uses for the same question (`stalePidRefusal`: the command line on
 *  Linux and macOS, the image name on Windows). Loaded only when such a lock
 *  is met — it is the app manager's module, and no run has one normally. */
async function tokenlessOwner(
  pid: number,
): Promise<{ is: "aio" | "stranger" | "unknown"; why: string }> {
  const { stalePidRefusal } = await import("../src/am/am-cmd-process.ts");
  const why = stalePidRefusal(pid, new Map());
  if (why === null) return { is: "aio", why: "" };
  // POSITIVELY not the app: another program has the pid, or nothing has it
  // any more (it ended since the scan read it alive). Everything else is a
  // live process this cannot name.
  const not = why.includes("is not an aio process") ||
    why.includes("is already gone");
  return { is: not ? "stranger" : "unknown", why };
}
/** Locks left out of the orphan list because their pid is positively another
 *  program's: said, never signalled, never a red gate. */
const unverified: string[] = [];
/** Locks whose LIVE pid could not be told from an aio app: never signalled
 *  (it may be anybody's), and RED — "cannot tell" was printed and passed, so
 *  an app left running under a pid this could not read passed the gate. */
const unidentified: string[] = [];
const staleDirs: string[] = [];

/** Everything a lock dir ever holds: `<key>.lock`, the app's `.sock` /
 *  `.http.sock`, its `.hold` file, am's `<appId>.launch.json`, and the dev
 *  watcher's `watch-<pid>.tmp` sentinel (see `lockDir()` and its callers).
 *  Files only — a lock dir has no subdirectories.
 *
 *  A lock dir is named `aio` / `aio-<scope>`, and so is every other aio temp
 *  directory in `/tmp` — a test's scratch, a build's staging dir. The sweep
 *  used to take the NAME as proof, so any `/tmp/aio*` dir with no live lock in
 *  it was "a finished run's lock dir" and was removed recursively at the start
 *  of every `deno task test`: a macOS `.dmg` build lost its `payload.tgz`
 *  between `tar` and `scp` that way while a suite started beside it (a field
 *  report, #7). A directory holding anything else is somebody else's.
 *
 *  `xephyr-<N>.auth` is deliberately NOT on this list although aio writes it
 *  (nested-display.ts keeps it in `<runtime>/aio` or `<runtime>/aio-u<uid>`,
 *  the very names this walks): a live nested display's cookie sits there with
 *  no lock beside it, and sweeping that directory takes the display's access
 *  file with it while the display is still up. Counting it as foreign leaves
 *  the directory alone, which is the only safe answer. */
function isLockDirEntry(e: Deno.DirEntry): boolean {
  if (e.isDirectory) return false;
  return /\.(?:lock|sock|hold|launch\.json)$/.test(e.name) ||
    /^watch-\d+(?:d[0-9a-f]{8})?(?:-\d+)?\.tmp$/.test(e.name);
}

/** A lock dir touched this recently belongs to a run that is making it right
 *  now (a lock is written after its directory is created) — never debris.
 *  The same window the ownerless-temp-home sweep below has always used.
 *
 *  Read BEFORE this pass touches the directory itself. `--clean` removes the
 *  dead locks inside it first, and removing a file bumps its parent's mtime to
 *  NOW — so asking afterwards answered "a run is making it right now" about a
 *  directory this very process had just emptied, and `clean:tmp` reported
 *  "0 stale lock dir(s) removed" having emptied every one of them. */
const LOCK_DIR_RECENT_MS = 10 * 60_000;
function dirMtime(dir: string): number | null {
  try {
    return Deno.statSync(dir).mtime?.getTime() ?? 0;
  } catch {
    return null; // cannot tell — leave it alone
  }
}
function touchedRecently(mtime: number | null): boolean {
  if (mtime === null) return true;
  return Date.now() - mtime < LOCK_DIR_RECENT_MS;
}

/** What every live process refers to: its command line, and where the OS
 *  shows them its cwd and its environment. null when that cannot be read —
 *  the caller then counts and removes NOTHING: with no live set every temp
 *  dir reads as ownerless, a live run's among them.
 *
 *  Linux reads /proc. macOS has none, so every dir here read as ownerless
 *  there and a live run's `/tmp/xdg-shard-*` was one `clean:tmp` from deleted
 *  once it was ten minutes old: `ps e` prints each command line WITH its
 *  environment (the cwd is not in it). Windows had neither and the same
 *  defect: it shows nobody another process's environment or cwd, so there it
 *  is the command lines alone (CIM) — and what a process WROTE about itself,
 *  which every OS reads below: a live lock's cwd and home, and the suite
 *  runner's owner file in each shard runtime dir (`runOwners`). */
function processRefs(): string[] | null {
  const run = (cmd: string, args: string[]): string[] | null => {
    try {
      const out = new Deno.Command(cmd, {
        args,
        stdin: "null",
        stdout: "piped",
        stderr: "null",
      }).outputSync();
      const text = dec.decode(out.stdout);
      if (!out.success || text.trim() === "") return null;
      listed.clear(); // this look replaces the last: a process gone is gone
      // `<pid> <parent pid> <the rest>` a line.
      for (const line of text.split(/\r?\n/)) {
        const m = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
        if (m) listed.set(Number(m[1]), { parent: Number(m[2]), text: m[3]! });
      }
      return [text];
    } catch {
      return null; // aio-ok: no such program — "cannot be read", said by the caller
    }
  };
  if (Deno.build.os === "windows") {
    return run("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      // A parent is named only if it was born first: Windows keeps the pid of
      // a parent that is gone, and hands that pid to somebody else.
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
      "$all = Get-CimInstance Win32_Process; $born = @{}; " +
      "foreach ($p in $all) { $born[[int]$p.ProcessId] = $p.CreationDate }; " +
      "foreach ($p in $all) { $pp = [int]$p.ParentProcessId; " +
      "if (-not $born.ContainsKey($pp) -or $born[$pp] -gt $p.CreationDate) " +
      "{ $pp = 0 }; " +
      "[string]$p.ProcessId + ' ' + $pp + ' ' + $p.CommandLine }",
    ]);
  }
  if (Deno.build.os === "darwin") {
    return run("ps", ["axeww", "-o", "pid=,ppid=,command="]);
  }
  // A test's seam: another directory can only make this answer "unreadable"
  // (it does not hold this very process), never "nothing is live".
  const proc = Deno.env.get("AIO_ORPHANS_PROC") ?? "/proc";
  const refs: string[] = [];
  let self = false;
  try {
    for (const p of Deno.readDirSync(proc)) {
      const pid = Number(p.name);
      if (!(pid > 0)) continue;
      self ||= pid === Deno.pid;
      try {
        refs.push(Deno.readLinkSync(`${proc}/${pid}/cwd`));
      } catch { /* not ours */ }
      try {
        refs.push(dec.decode(Deno.readFileSync(`${proc}/${pid}/environ`)));
        refs.push(dec.decode(Deno.readFileSync(`${proc}/${pid}/cmdline`)));
      } catch { /* not ours */ }
    }
  } catch { /* aio-ok: no /proc — `self` stays false, and that is said */ }
  return self ? refs : null;
}
// Read BEFORE anything is removed: a run that cannot tell removes nothing.
const liveRefs = processRefs() ?? (() => {
  console.error(
    "check-orphans: the live processes could not be read (/proc, `ps axeww`, " +
      "CIM on Windows) — cannot tell a live run's temp dir from a dead " +
      "one's; none is counted or removed",
  );
  Deno.exit(2);
})();
/** Dirs the lock rule owns: lock-shaped (pruned file by file, never
 *  recursively) or holding a LIVE lock. The temp sweep below goes by name and
 *  recursively, and on Windows both walk `%TEMP%` — a live app's `aio-<scope>`
 *  lock dir there is not an ownerless temp home. */
const lockRuled = new Set<string>();

for (const root of lockRoots()) {
  let entries: Deno.DirEntry[] = [];
  try {
    entries = [...Deno.readDirSync(root)];
  } catch {
    continue;
  }
  for (const e of entries) {
    if (!e.isDirectory || !e.name.startsWith("aio")) continue;
    const dir = join(root, e.name);
    const scoped = e.name !== "aio";
    let live = 0;
    let files: Deno.DirEntry[] = [];
    try {
      files = [...Deno.readDirSync(dir)];
    } catch {
      continue;
    }
    // Not a lock dir (see isLockDirEntry): its live locks are still READ — an
    // orphan is an orphan wherever its lock sits — but nothing in it is ever
    // removed, file or directory.
    const foreign = files.some((f) => !isLockDirEntry(f));
    // Before the loop below removes anything from it — see `dirMtime`.
    const mtime = dirMtime(dir);
    for (const f of files) {
      if (!f.isFile) continue;
      const path = join(dir, f.name);
      if (f.name.endsWith(".lock")) {
        let lock: Partial<LockData> | null = null;
        let raw: string | null = null;
        try {
          raw = Deno.readTextFileSync(path);
          lock = JSON.parse(raw);
        } catch { /* corrupt — stale */ }
        const pid = lock?.pid ?? 0;
        if (ownerAlive(lock, dir)) {
          live++;
          // What the app wrote about itself: where it runs is in use.
          for (const p of [lock?.cwd, lock?.home]) if (p) liveRefs.push(p);
          // Another pid namespace's app: its pid is a stranger here — never
          // an orphan to report, and never one to SIGTERM.
          if (foreignOwnerRefusal({ pid, ns: lock?.ns }) !== null) continue;
          // The SHARED dir holds the machine's real apps — reporting those
          // would be wrong, and skipping it wholesale was the hole.
          //
          // A test or a session that spawns an app WITHOUT `childEnv()` gets
          // the default app home, so its lock lands here beside them and the
          // gate could never see it. Measured on this machine: two apps from a
          // scratch session tree had been holding ports for two days and
          // eighteen hours while this said "no orphaned aio processes" — the
          // five-hour ghost in this file's own header, twice over and older.
          //
          // A real app does not live in a temp directory. That is the whole
          // rule: a shared-dir lock whose recorded cwd or home is under a temp
          // root is a leftover, everything else here is the user's.
          if (!scoped && !tempRooted(lock)) continue;
          // "Another suite is mid-run, and its apps are its business" — but
          // only while that is still plausibly TRUE. A suite runs for minutes;
          // this exemption had no clock, so a ghost whose PARENT was also a
          // ghost stayed invisible for as long as both survived. Measured
          // here: an app two days and eighteen hours old, exempt because its
          // equally abandoned parent was still running. Past the window, a
          // live app in a scoped or temp-rooted lock dir is a leftover no
          // matter who started it.
          const started = Number(lock?.startedAt ?? 0);
          const fresh = started > 0 && Date.now() - started < PARENT_GRACE_MS;
          const parent = parentOf(pid);
          if (parent > 0 && alive(parent) && fresh) continue;
          // A lock whose "owner" is a test RUNNER (or this very process) is a
          // fixture a test wrote with its own pid, not an app — the am
          // stop-all tests do exactly that, and a suite running right now
          // must not read as seven orphans.
          if (pid === Deno.pid || /\bdeno(\S*)? test\b/.test(cmdlineOf(pid))) {
            continue;
          }
          if (!lock?.startToken && typeof lock?.startEpoch !== "number") {
            const who = await tokenlessOwner(pid);
            if (who.is !== "aio") {
              (who.is === "stranger" ? unverified : unidentified).push(
                who.is === "stranger"
                  ? `stale lock (no start token; its pid was reused)  ` +
                    `${lock?.appId ?? f.name}\n        ${who.why}`
                  : `unverifiable (no start token)  pid ${pid}  ` +
                    `${lock?.appId ?? f.name}\n        ${who.why}`,
                `        lock: ${path}`,
              );
              continue;
            }
          }
          orphans.push({
            pid,
            appId: lock?.appId ?? f.name,
            port: lock?.port ?? 0,
            dir,
          });
        } else if (clean && !foreign && raw !== null) {
          // Compare-and-delete: only the record judged dead, never a lock an
          // app published at this path since it was read.
          removeLockFileIf(path, raw);
        }
      } else if (f.name.startsWith("watch-") && f.name.endsWith(".tmp")) {
        // A watcher sentinel whose process is gone is a hard-killed app. The
        // name carries the PID (and pid namespace) of the process that wrote
        // it — a pid from another namespace proves nothing here.
        const m = /^watch-(\d+)(?:d([0-9a-f]{8}))?(?:-\d+)?\.tmp$/.exec(f.name);
        if (!m || !taggedOwnerGone(path, Number(m[1]), m[2])) live++;
        else if (clean && !foreign) Deno.removeSync(path);
      }
    }
    if (!foreign || live > 0) lockRuled.add(dir);
    if (scoped && live === 0 && !foreign && !touchedRecently(mtime)) {
      staleDirs.push(dir);
    }
  }
}

// Ownerless temp homes: /tmp/aio-* that no live process refers to — by cwd,
// by an env var (AIO_APPS_DIR, DENO_COVERAGE_DIR), or on its command line —
// AND that nothing has touched for a while. A suite that is running right now
// owns its temp dirs through exactly those three, and a dir modified minutes
// ago is in use by something even if we cannot see by whom. Never delete what
// is not clearly abandoned: this script runs with write permission.
const RECENT_MS = 10 * 60_000;
/** Where a test's throwaway directories live.
 *
 *  BOTH roots. This swept `/tmp` only, and `src/testing/temp-dir.ts` used to
 *  put them there — but `src/testing/test-strict.ts` has always created its
 *  own under `~/tmp/aio/` (or `AIO_TEST_ROOT`), so that tree was ungated:
 *  measured at 151 directories, 122 of them over a day old, going back weeks.
 *  The gate built because of 5,612 leaked `/tmp/aio-*` dirs was blind to the
 *  tree that replaced them. `temp-dir.ts` now creates under the same root, and
 *  `/tmp` stays here so anything an older checkout left behind is still found.
 *
 *  Under the test root a directory is a leftover whatever it is called, so the
 *  `aio-` prefix is only required in the shared `/tmp`.
 *
 *  …and `xdg-shard-`: the suite runner gives each shard a runtime dir of its
 *  own (`/tmp/xdg-shard-XXXX`, scripts/test-shards.ts) and removes it when
 *  the shard ends — so one whose RUN was killed stays, lock dirs inside it,
 *  where the lock scan above never looks (it is not named `aio*`). Same rule
 *  as every other dir here: no live process names it, untouched for a while. */
const TMP_PREFIXES = ["aio-", "xdg-shard-"];
/** The shared temp dir's scratch, as a message names it on this OS — it said
 *  `/tmp/aio-*` on Windows, where the sweep reads `%TEMP%`. */
const TMP_GLOBS = TMP_PREFIXES.map((p) =>
  Deno.build.os === "windows" ? `%TEMP%\\${p}*` : `/tmp/${p}*`
).join(", ");
function scratchRoots(): { dir: string; requirePrefix: boolean }[] {
  // The test seam replaces the shared `/tmp` here too (see lockRoots): a
  // test of this sweep must never count, or remove, the machine's own.
  const only = Deno.env.get("AIO_ORPHANS_LOCK_ROOTS");
  // Where the runner and the tests put them: `/tmp`, on Windows `%TEMP%` —
  // the literal `/tmp` there named nothing, so nothing was counted or swept.
  const shared = Deno.build.os === "windows"
    ? [Deno.env.get("TEMP") ?? Deno.env.get("TMP") ?? ""].filter(Boolean)
    : ["/tmp"];
  const out = (only ? only.split(DELIMITER).filter(Boolean) : shared)
    .map((dir) => ({ dir, requirePrefix: true }));
  const override = Deno.env.get("AIO_TEST_ROOT")?.trim();
  const home = (Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "")
    .replace(/[/\\]+$/, "");
  const root = override || (home ? join(home, "tmp", "aio") : "");
  if (root && !out.some((o) => o.dir === root)) {
    out.push({ dir: root, requirePrefix: false });
  }
  return out;
}

/** The suite runs that are LIVE, by the owner file their runner wrote into
 *  each shard runtime dir (`markShardRuntime`, scripts/test-shards.ts): the
 *  dirs themselves, and when the earliest of those runs began. A scratch dir
 *  touched since then may be that run's — a test process's own temp dir is on
 *  nobody's command line or environment — and is left. */
function runOwners(): { dirs: Set<string>; since: number } {
  const dirs = new Set<string>();
  let since = Infinity;
  for (const { dir: root } of scratchRoots()) {
    try {
      for (const e of Deno.readDirSync(root)) {
        if (!e.isDirectory || !e.name.startsWith("xdg-shard-")) continue;
        try {
          const o = JSON.parse(
            Deno.readTextFileSync(join(root, e.name, ".run-owner")),
          );
          if (!ownerAlive(o, join(root, e.name))) continue;
          dirs.add(join(root, e.name));
          if (typeof o.startedAt === "number") {
            since = Math.min(since, o.startedAt);
          }
        } catch { /* aio-ok: no owner file (an older runner's), or torn */ }
      }
    } catch { /* aio-ok: no such root */ }
  }
  return { dirs, since };
}
const liveRuns = runOwners();

/** One spelling for a path and the text it is looked for in: Windows names
 *  a file in either case and with either separator (a command line carries
 *  `file:///C:/…` as readily as `C:\…`). */
const fold = (t: string) =>
  Deno.build.os === "windows" ? t.toLowerCase().replaceAll("/", "\\") : t;
const foldedRefs = liveRefs.map(fold);
/** Whether `ref` (a folded environment, command line or `ps` text) names the
 *  path `p` WHOLE — itself or a path inside it, never one it merely begins
 *  (`apps-12` is not named by `apps-123`). */
const namesPath = (ref: string, p: string) => {
  const f = fold(p);
  for (let i = ref.indexOf(f); i >= 0; i = ref.indexOf(f, i + 1)) {
    const next = ref[i + f.length];
    if (next === undefined || /[\0\s"'/\\:;,=]/.test(next)) return true;
  }
  return false;
};

/** The dirs a LIVE test process wrote down as its own (`LIVE_OWNER`,
 *  src/testing/temp-dir.ts): `<root>/.live-<pid>` — who it is, then a dir a
 *  line. The one sign of a bare `deno test`'s temp dirs that every OS can
 *  read: they are on no command line, and Windows shows nobody another
 *  process's environment or cwd. A record whose owner is gone (it was
 *  SIGKILLed) protects nothing, and `--clean` removes it. */
function liveOwnedDirs(): Set<string> {
  const out = new Set<string>();
  for (const { dir: root } of scratchRoots()) {
    let names: string[];
    try {
      names = [...Deno.readDirSync(root)]
        .filter((e) => e.isFile && e.name.startsWith(LIVE_OWNER))
        .map((e) => e.name);
    } catch {
      continue; // aio-ok: no such root
    }
    for (const name of names) {
      const path = join(root, name);
      try {
        const [who, ...dirs] = Deno.readTextFileSync(path).split("\n");
        if (!ownerAlive(JSON.parse(who!), root)) {
          if (clean) Deno.removeSync(path);
          continue;
        }
        for (const d of dirs.filter(Boolean)) {
          out.add(fold(d));
          // …and as this scan spells it: the same root under another name
          // (a symlinked /tmp, a short Windows path).
          out.add(fold(join(root, basename(d))));
        }
      } catch {
        /* aio-ok: torn mid-write, or removed by its owner's exit — the next look reads it */
      }
    }
  }
  return out;
}
const liveOwned = liveOwnedDirs();

const tmpDirs: string[] = [];
for (const { dir: root, requirePrefix } of scratchRoots()) {
  try {
    for (const e of Deno.readDirSync(root)) {
      if (!e.isDirectory) continue;
      if (requirePrefix && !TMP_PREFIXES.some((p) => e.name.startsWith(p))) {
        continue;
      }
      // An Electron window's preload dir, as builds before 1.0.17 made it
      // (the temp dir, no owner recorded): any aio app's, maybe a live one's.
      if (e.name.startsWith("aio-preload-")) continue;
      const dir = join(root, e.name);
      if (lockRuled.has(dir) || liveRuns.dirs.has(dir)) continue;
      if (foldedRefs.some((r) => namesPath(r, dir))) continue;
      if (liveOwned.has(fold(dir))) continue;
      let mtime = 0;
      try {
        mtime = Deno.statSync(dir).mtime?.getTime() ?? 0;
      } catch {
        continue;
      }
      if (Date.now() - mtime < RECENT_MS || mtime >= liveRuns.since) continue;
      tmpDirs.push(dir);
    }
  } catch { /* no such root */ }
}

// A process still running inside a DELETED test directory. Its test removed
// the temp root — lock file included — while the app lived on, so the lock
// scan above cannot see it: eight test apps ran for up to 14 h each, one per
// mutation run, while this gate reported only "ownerless dirs". A deleted cwd
// under a scratch root has no owner by definition; it is read twice, 2 s
// apart, so a test that drops its dir a moment before stopping its child is
// not a false alarm.
{
  const roots = scratchRoots();
  const underRoot = (cwd: string) =>
    roots.some(({ dir, requirePrefix }) =>
      cwd.startsWith(`${dir}/${requirePrefix ? "aio-" : ""}`)
    );
  const deletedCwds = () => {
    const out = new Map<number, string>();
    try {
      for (const p of Deno.readDirSync("/proc")) {
        const pid = Number(p.name);
        if (!(pid > 0) || pid === Deno.pid) continue;
        try {
          const cwd = Deno.readLinkSync(`/proc/${pid}/cwd`);
          if (cwd.endsWith(" (deleted)") && underRoot(cwd)) out.set(pid, cwd);
        } catch { /* aio-ok: not ours, or gone — only our own can be judged */ }
      }
    } catch { /* aio-ok: no /proc (macOS) — the lock scan is all there is */ }
    return out;
  };
  const first = deletedCwds();
  if (first.size) {
    await new Promise((r) => setTimeout(r, 2000));
    for (const [pid, cwd] of deletedCwds()) {
      if (!first.has(pid) || orphans.some((o) => o.pid === pid)) continue;
      // A test RUNNER that chdir'd into its own temp dir is not an app (the
      // lock scan above exempts runners alike).
      if (/\bdeno(\S*)? test\b/.test(cmdlineOf(pid))) continue;
      orphans.push({
        pid,
        appId: "(its test dir was deleted)",
        port: 0,
        dir: cwd,
      });
    }
  }
}

for (const line of unverified) console.log(line);
for (const line of unidentified) console.error(line);
for (const o of orphans) {
  console.error(
    `ORPHAN  pid ${o.pid}  ${o.appId}${o.port ? ` :${o.port}` : ""}\n` +
      `        ${cmdlineOf(o.pid)}\n        ${
        o.dir.endsWith(" (deleted)") ? "cwd" : "lock"
      }: ${o.dir}`,
  );
}
// ── New lock dirs: what THIS run left in the runtime dir ─────────────────
//
// The stale sweep above skips anything touched recently, so a run's own
// leftovers were never counted by the run that made them — measured, ~5,400
// empty `aio-<scope>` dirs in $XDG_RUNTIME_DIR after one day, every one
// "recent" to the gate that could have caught it. So the START of a suite
// (`--clean-stale`) records which scoped lock dirs exist, and the END (this
// report) fails on every scoped dir that appeared since and holds no live
// lock: a creator that did not prune what it made.
const BASELINE = ".aio/lock-dirs-baseline.json";
function scopedLockDirs(): string[] {
  const out: string[] = [];
  for (const root of lockRoots()) {
    try {
      for (const e of Deno.readDirSync(root)) {
        // `aio-preload-*` is an Electron window's private preload dir
        // (`electron-shared.ts`), swept by that window at exit — not a lock
        // dir. Any aio app on the machine makes one, so counting it blamed
        // this run for another app's live window.
        if (
          e.isDirectory && e.name.startsWith("aio-") &&
          !e.name.startsWith("aio-preload-")
        ) {
          out.push(join(root, e.name));
        }
      }
    } catch { /* aio-ok: no such root on this host */ }
  }
  return out;
}
/** A dir with no lock file whose owner is alive — nothing is using it. */
function leftoverLockDir(dir: string): boolean {
  try {
    for (const f of Deno.readDirSync(dir)) {
      if (!f.name.endsWith(".lock")) continue;
      try {
        const lock = JSON.parse(Deno.readTextFileSync(join(dir, f.name)));
        if (ownerAlive(lock, dir)) return false;
      } catch { /* aio-ok: unreadable — no live owner to protect */ }
    }
  } catch {
    return false; // aio-ok: gone meanwhile — not left over
  }
  return true;
}

if (staleOnly) {
  let swept = 0;
  // File by file, never recursively (`pruneDeadLockDirAt`): the scan above
  // saw no live LOCK, but a `singleton: false` app holds none — its socket is
  // the only sign of it — and an app may publish a lock after the scan.
  for (const d of staleDirs) if (pruneDeadLockDirAt(d)) swept++;
  console.log(
    `clean-stale: ${swept} of ${staleDirs.length} stale lock dir(s) removed` +
      (orphans.length
        ? ` (${orphans.length} live orphan(s) left alone — \`deno task check:orphans\` reports them)`
        : ""),
  );
  try {
    Deno.mkdirSync(".aio", { recursive: true });
    Deno.writeTextFileSync(BASELINE, JSON.stringify(scopedLockDirs()));
  } catch (e) {
    console.error(`clean-stale: could not record ${BASELINE}: ${e}`);
  }
  Deno.exit(0);
}
if (clean) {
  for (const o of orphans) {
    try {
      Deno.kill(o.pid, "SIGTERM");
      console.error(`        → SIGTERM sent`);
    } catch { /* gone */ }
  }
  let removed = 0;
  for (const d of staleDirs) if (pruneDeadLockDirAt(d)) removed++;
  let homes = 0;
  const kept: string[] = [];
  for (const d of tmpDirs) {
    try {
      Deno.removeSync(d, { recursive: true });
      homes++;
    } catch (e) {
      kept.push(`${d} (${String((e as Error).message).split("\n")[0]})`);
    }
  }
  console.log(
    `clean: ${orphans.length} orphan(s) signalled, ${removed} stale lock ` +
      `dir(s) and ${homes} ownerless temp dir(s) (${TMP_GLOBS}, every dir under the test root) removed`,
  );
  // A removed test store leaves its `git worktree` registration in THIS
  // checkout's `.git` — forgotten here as the suite runner forgets them.
  const forgotten = pruneTestWorktrees(Deno.cwd(), Deno.env.toObject());
  if (forgotten.length) {
    console.log(
      `clean: ${forgotten.length} worktree registration(s) of removed test ` +
        `stores forgotten`,
    );
  }
  // Never a silent "0 removed": say which ones resisted, and why.
  for (const k of kept) console.error(`  could not remove ${k}`);
  Deno.exit(0);
}
{
  let before: string[] | null = null;
  try {
    before = JSON.parse(Deno.readTextFileSync(BASELINE));
    Deno.removeSync(BASELINE); // one baseline per run
  } catch { /* aio-ok: no suite start recorded (a bare check:orphans) */ }
  if (before) {
    const had = new Set(before);
    // A dir whose apps root (its `<base>/.aio-roots/<name>` entry) is gone
    // and that holds nothing live is debris no process will ever use again —
    // a SIGKILLed child app's, whose test then deleted its temp root. Only
    // here, after every test has ended: at runtime a missing root is no
    // proof (an `AIO_APPS_DIR` is often created after its lock dir). What is
    // LEFT is what nothing would ever clear: an unregistered dir, or one
    // whose root still exists.
    let swept = 0;
    /** Each new dir that holds nothing live, with the apps root it serves. */
    const leftBehind = () =>
      scopedLockDirs().flatMap((d) => {
        if (had.has(d) || !leftoverLockDir(d)) return [];
        let root: string | null = null;
        try {
          root = Deno.readTextFileSync(rootRegistryEntry(d));
        } catch { /* aio-ok: unregistered — cannot be judged, so it counts */ }
        if (root !== null) {
          let rootGone = false;
          try {
            Deno.lstatSync(root);
          } catch {
            rootGone = true;
          }
          // Dead files one by one, then a non-recursive rmdir — anything
          // live or unknown keeps it, and it is counted below.
          if (rootGone && pruneDeadLockDirAt(d, true)) {
            swept++;
            return [];
          }
        }
        return [{ d, root }];
      });
    // A dir whose apps root a LIVE process still names (its AIO_APPS_DIR — a
    // test process's `apps-<pid>` sandbox) belongs to a creator that has not
    // exited, so its exit prune has not had its turn: a test process still in
    // its unload on a loaded box, or a run beside this one. Judged once those
    // processes are gone — up to 30 s — and not before. One still running
    // then is named, and not charged to this run.
    // Or names by its OWN pid: the sandbox is `apps-<pid>` of the test process
    // that made it, and Windows shows nobody that process's environment —
    // there the root was named by no one, and a test still in its unload was
    // charged with its lock dir (seen on every Windows suite).
    const named = (root: string | null, refs: string[]) =>
      root !== null &&
      (refs.some((r) => namesPath(r, root)) || sandboxOwnerLive(root));
    let refs = foldedRefs;
    let left = leftBehind();
    for (
      const t0 = Date.now();
      left.some((x) => named(x.root, refs)) && Date.now() - t0 < 30_000;
    ) {
      await new Promise((r) => setTimeout(r, 500));
      refs = (processRefs() ?? []).map(fold);
      left = leftBehind();
    }
    const inUse = left.filter((x) => named(x.root, refs));
    for (const { d, root } of inUse) {
      console.log(
        `lock dirs: ${d} is still in use by a live process (apps root ` +
          `${root}) after 30 s — not judged`,
      );
    }
    const fresh = left.filter((x) => !inUse.includes(x)).map((x) => x.d);
    if (swept) {
      console.log(
        `lock dirs: ${swept} orphaned (apps root deleted, nothing live) swept`,
      );
    }
    // …and the registry entries of dirs that are gone, however they went.
    for (const root of lockRoots()) sweepRootRegistry(root);
    if (fresh.length) {
      console.error(
        `\n${fresh.length} scoped lock dir(s) appeared in the runtime dir ` +
          `during this run and were left behind (no live lock in them):\n` +
          fresh.slice(0, 10).map((d) => `  ${d}`).join("\n") +
          (fresh.length > 10 ? `\n  … and ${fresh.length - 10} more` : "") +
          `\n  Whatever created them did not prune them at exit ` +
          `(lock-dir.ts pruneAtExit). \`deno task clean:tmp\` ` +
          `removes them.`,
      );
      Deno.exit(1);
    }
  }
}
if (unidentified.length) {
  console.error(
    `\n${unidentified.length / 2} lock(s) with no start token name a live ` +
      `process that could not be identified — it may be an aio app left ` +
      `running. Nothing was signalled. Look at each pid; remove the lock ` +
      `file if it is not one.`,
  );
  if (!orphans.length) Deno.exit(1);
}
if (orphans.length) {
  console.error(
    `\n${orphans.length} aio process(es) outlived their test run. ` +
      `\`deno task clean:tmp\` stops them; the test that started them needs a ` +
      `deadline (and its app childEnv() — see tests/e2e-app-harness.ts).`,
  );
  Deno.exit(1);
}
console.log(
  `no orphaned aio processes (${staleDirs.length} stale lock dir(s), ` +
    `${tmpDirs.length} ownerless temp dir(s): ${TMP_GLOBS} and every dir under the test root, apps-* included — deno task clean:tmp removes them)`,
);

// ── The leak nobody was failing on ──
//
// This script has always COUNTED abandoned directories and always exited 0
// about them. Measured on a developer machine after a few weeks of suite runs:
// 5,612 ownerless `/tmp/aio-*` directories holding 4.3 GB. Every one is a test
// that made a temp home and did not remove it, and the number only goes up.
//
// A process left running is red because it holds a port; a directory left
// behind is not red, because one directory is nothing. Ten thousand of them is
// not nothing, and there was no point at which anyone was told. So: a ceiling,
// which only ever goes DOWN — the same ratchet as `check:silent-catch` and
// friends. It is deliberately generous, because this counts what is on the
// WHOLE machine (a colleague's suite, a container's leftovers), not just what
// this run made; the job of the number is to catch a new leak class, not to
// police a tidy /tmp.
// 400 → 200 once `--clean-stale` ran at the start of every suite: a run leaves
// ~90 (measured, twice), and 400 was chosen when nothing swept them and the
// number climbed by a couple of hundred per run. A ceiling far above the real
// count is a ceiling that rots — the win has to be locked in or it is not one.
// 200 → 100 (1.0.20): a suite run measured 37, and this printed "lower it" at
// every one. 100 is that with room for a second checkout's run beside it; a
// machine over it has a leak or a round of killed runs, and `clean:tmp` is the
// answer to both.
const LEFTOVER_CEILING = 100;
const leftovers = staleDirs.length + tmpDirs.length;
if (leftovers > LEFTOVER_CEILING) {
  console.error(
    `\ncheck:orphans FAIL — ${leftovers} abandoned director(ies) ` +
      `(${staleDirs.length} stale lock, ${tmpDirs.length} ownerless ` +
      `${TMP_GLOBS}), ceiling ${LEFTOVER_CEILING}.\n` +
      `  They are invisible one at a time and 4 GB in aggregate.\n` +
      // The two halves have DIFFERENT causes and different fixes, and saying
      // "every one is a test that did not remove its temp home" of both sent
      // a reader hunting `makeTempDir` calls for the half where that is not
      // the cause at all — the stale locks are app homes under AIO_APPS_DIR,
      // left by the hundreds of apps a suite boots, and `deno task test`
      // already resets that home at the START of every run.
      `  ${staleDirs.length} stale lock: app homes under AIO_APPS_DIR whose ` +
      `owner is gone. A suite boots hundreds of apps, and \`deno task test\` ` +
      `resets that home each run — so roughly one run's worth is expected, ` +
      `and a number far above that is the signal.\n` +
      `  ${tmpDirs.length} ownerless temp dir(s) (${TMP_GLOBS}, the test root's apps-*/aio-*/…): a test made a temp dir and ` +
      `did not remove it. THIS is the one to fix at the source — find the ` +
      `test and give it an \`await using\` or a finally.\n` +
      `  \`deno task clean:tmp\` removes both.`,
  );
  Deno.exit(1);
}
if (leftovers > 0 && leftovers <= LEFTOVER_CEILING / 4) {
  console.log(
    `  (${leftovers} abandoned dir(s), ceiling ${LEFTOVER_CEILING} — ` +
      `lower it in scripts/check-orphans.ts to keep the win)`,
  );
}
