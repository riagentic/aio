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
import { join } from "@std/path";
import {
  pruneDeadLockDirAt,
  removeLockFileIf,
  rootRegistryEntry,
  sweepRootRegistry,
} from "../src/server/single-instance-lock.ts";

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
    return "?";
  }
}

function lockRoots(): string[] {
  // A test's seam: its own fake runtime base ONLY, so the gate's test never
  // scans — let alone prunes — the machine's real `/tmp`.
  const only = Deno.env.get("AIO_ORPHANS_LOCK_ROOTS");
  if (only) return only.split(":").filter(Boolean);
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
    if (p) out.push(p.replace(/\/+$/, ""));
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
    if (TEMP_ROOTS.some((r) => p === r || p.startsWith(`${r}/`))) return true;
  }
  return false;
}

type Orphan = { pid: number; appId: string; port: number; dir: string };
const orphans: Orphan[] = [];
const staleDirs: string[] = [];

/** Everything a lock dir ever holds: `<key>.lock`, the app's `.sock` /
 *  `.http.sock`, am's `<appId>.launch.json`, and the dev watcher's
 *  `watch-<pid>.tmp` sentinel (see `lockDir()` and its callers). Files only —
 *  a lock dir has no subdirectories.
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
  return /\.(?:lock|sock|launch\.json)$/.test(e.name) ||
    /^watch-\d+\.tmp$/.test(e.name);
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
        let lock:
          | {
            pid?: number;
            appId?: string;
            port?: number;
            cwd?: string;
            home?: string;
            startedAt?: number;
          }
          | null = null;
        let raw: string | null = null;
        try {
          raw = Deno.readTextFileSync(path);
          lock = JSON.parse(raw);
        } catch { /* corrupt — stale */ }
        const pid = lock?.pid ?? 0;
        if (pid > 0 && alive(pid)) {
          live++;
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
          const parent = Number(envOf(pid)?.AIO_PARENT_PID ?? "");
          if (parent > 0 && alive(parent) && fresh) continue;
          // A lock whose "owner" is a test RUNNER (or this very process) is a
          // fixture a test wrote with its own pid, not an app — the am
          // stop-all tests do exactly that, and a suite running right now
          // must not read as seven orphans.
          if (pid === Deno.pid || /\bdeno(\S*)? test\b/.test(cmdlineOf(pid))) {
            continue;
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
        // name carries the PID of the process that wrote it.
        const pid = Number(f.name.slice(6, -4));
        if (pid > 0 && alive(pid)) live++;
        else if (clean && !foreign) Deno.removeSync(path);
      }
    }
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
const liveRefs: string[] = [];
try {
  for (const p of Deno.readDirSync("/proc")) {
    const pid = Number(p.name);
    if (!(pid > 0)) continue;
    try {
      liveRefs.push(Deno.readLinkSync(`/proc/${pid}/cwd`));
    } catch { /* not ours */ }
    try {
      liveRefs.push(dec.decode(Deno.readFileSync(`/proc/${pid}/environ`)));
      liveRefs.push(dec.decode(Deno.readFileSync(`/proc/${pid}/cmdline`)));
    } catch { /* not ours */ }
  }
} catch { /* no /proc */ }
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
 *  `aio-` prefix is only required in the shared `/tmp`. */
function scratchRoots(): { dir: string; requirePrefix: boolean }[] {
  const out = [{ dir: "/tmp", requirePrefix: true }];
  const override = Deno.env.get("AIO_TEST_ROOT")?.trim();
  const home = (Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "")
    .replace(/[/\\]+$/, "");
  const root = override || (home ? join(home, "tmp", "aio") : "");
  if (root && root !== "/tmp") out.push({ dir: root, requirePrefix: false });
  return out;
}

const tmpDirs: string[] = [];
for (const { dir: root, requirePrefix } of scratchRoots()) {
  try {
    for (const e of Deno.readDirSync(root)) {
      if (!e.isDirectory) continue;
      if (requirePrefix && !e.name.startsWith("aio-")) continue;
      const dir = join(root, e.name);
      if (liveRefs.some((r) => r.includes(dir))) continue;
      let mtime = 0;
      try {
        mtime = Deno.statSync(dir).mtime?.getTime() ?? 0;
      } catch {
        continue;
      }
      if (Date.now() - mtime < RECENT_MS) continue;
      tmpDirs.push(dir);
    }
  } catch { /* no such root */ }
}

for (const o of orphans) {
  console.error(
    `ORPHAN  pid ${o.pid}  ${o.appId}${o.port ? ` :${o.port}` : ""}\n` +
      `        ${cmdlineOf(o.pid)}\n        lock: ${o.dir}`,
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
        const pid = JSON.parse(Deno.readTextFileSync(join(dir, f.name))).pid;
        if (typeof pid === "number" && alive(pid)) return false;
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
      `dir(s) and ${homes} ownerless /tmp/aio-* dir(s) removed`,
  );
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
    const fresh = scopedLockDirs().filter((d) => {
      if (had.has(d) || !leftoverLockDir(d)) return false;
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
          return false;
        }
      }
      return true;
    });
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
          `(single-instance-lock.ts pruneAtExit). \`deno task clean:tmp\` ` +
          `removes them.`,
      );
      Deno.exit(1);
    }
  }
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
    `${tmpDirs.length} ownerless /tmp/aio-* dir(s) — deno task clean:tmp removes them)`,
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
const LEFTOVER_CEILING = 200;
const leftovers = staleDirs.length + tmpDirs.length;
if (leftovers > LEFTOVER_CEILING) {
  console.error(
    `\ncheck:orphans FAIL — ${leftovers} abandoned director(ies) ` +
      `(${staleDirs.length} stale lock, ${tmpDirs.length} ownerless ` +
      `/tmp/aio-*), ceiling ${LEFTOVER_CEILING}.\n` +
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
      `  ${tmpDirs.length} ownerless /tmp/aio-*: a test made a temp dir and ` +
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
