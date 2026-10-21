// The lock directory — where every app's lock lives: choosing it (private,
// per-uid, scoped by AIO_APPS_DIR), creating it and the files in it, pruning
// dead ones, the key → path naming, and the launch-info sidecar. Split out of
// single-instance-lock.ts, which re-exports every name here, so no importer
// changes.

import { basename, dirname, join, resolve } from "@std/path";
import { privateDirRefusal, selfUid } from "./dir-permissions.ts";
import { isPipePath } from "./local-listen.ts";
import type { LocalListener } from "./local-listen.ts";
import {
  appDirs,
  appHome,
  appsDirEnv,
  profileNameError,
  profileOfHome,
} from "./app-dirs.ts";
import { log } from "../diagnostics/logger-api.ts";
import { isHeldOpenError } from "../diagnostics/rename-over.ts";
import {
  _lockDeps,
  ageSince,
  dropIdleMutex,
  MUTEX_WAIT_MS,
  parseLock,
  readLockAt,
  removedUnderCreate,
  removeLockFileIf,
} from "./lock-file.ts";
import { isLockOwnerAlive, isOwnLock } from "./lock-owner.ts";
import { AppLock } from "./single-instance-lock.ts";
import {
  isProcessAlive,
  ownPidNs,
  ownPidTag,
  PID_TAG,
} from "./process-liveness.ts";

// ── Lock File Paths ──────────────────────────────────────────

/** Directory for lock + socket files — /tmp/aio/ (or $XDG_RUNTIME_DIR/aio/ on Linux) */
let _lockDir: string | null = null;
let _lockDirKey: string | null = null;
export function lockDir(): string {
  // AIO_APPS_DIR relocates the apps' DATA root — the lock/socket dir scopes
  // with it, so ONE env var isolates an instance completely. A temp $HOME
  // alone used to isolate state but NOT the lock: a sandboxed e2e died on
  // "already running", and its `am` silently reached the production instance
  // (a field report). Must-not-survive-reboot still holds — the
  // base stays $XDG_RUNTIME_DIR//tmp either way.
  //
  // Normalized (`appsDirEnv`), because the dir is named after the STRING:
  // `AIO_APPS_DIR=demo/../apps` for the app and `AIO_APPS_DIR=apps` for `am`
  // are one data root, and were two lock dirs — `am` said "not running" about
  // an app whose data it could see.
  const appsRoot = appsDirEnv() ?? "";
  if (_lockDir && _lockDirKey === appsRoot) return _lockDir;
  const { base, scope } = _lockDirParts(appsRoot);
  _lockDirKey = appsRoot;
  // Which candidates were already there — the preferred path AND the private
  // `aio-u<uid>` fallback `_chooseLockDir` may pick instead: "did this
  // process create it" is asked of the dir actually chosen, not of a path
  // it may not use.
  const before = new Set(
    scope === "" ? [] : _lockDirCandidates(base, scope).filter(_exists),
  );
  // ONE wait for the whole step — both candidates and the registry.
  const until = _lockDeps.now() + MUTEX_WAIT_MS;
  _lockDir = _chooseLockDir(base, scope, until);
  if (scope !== "" && !before.has(_lockDir)) {
    pruneAtExit(_lockDir);
    // Which apps root this dir serves, so the suite's end gate
    // (`scripts/check-orphans.ts`) can tell debris — root deleted, nothing
    // live — from a dir some process is about to use. Only there, AFTER
    // every test has ended: at runtime a missing root is no proof (an
    // `AIO_APPS_DIR` is often created on first use, after its lock dir).
    registerRoot(_lockDir, appsRoot, until);
  }
  return _lockDir;
}

/** Both dirs `_chooseLockDir(base, scope)` may answer with. */
export function _lockDirCandidates(base: string, scope: string): string[] {
  const uid = selfUid();
  return [
    join(base, "aio" + scope),
    ...(uid === null ? [] : [join(base, `aio-u${uid}${scope}`)]),
  ];
}

export function _exists(path: string): boolean {
  try {
    Deno.lstatSync(path);
    return true;
  } catch {
    return false; // aio-ok: absent is the answer asked for
  }
}

/** The registry entry naming the apps root of scoped lock dir `dir`:
 *  `<base>/.aio-roots/<dir name>`. OUTSIDE the lock dir on purpose — a marker
 *  inside it (`.root`, never released) made the dir non-empty, and a
 *  v1.0.9 app's exit prune is non-recursive: it left every such dir behind.
 *  Only the gate reads it. @internal */
export function rootRegistryEntry(dir: string): string {
  return join(dirname(dir), ".aio-roots", basename(dir));
}

/** Record which apps root `dir` serves. Best effort: an unregistered dir is
 *  one the gate cannot judge, which it counts rather than removes. The
 *  registry is checked like a lock dir (ours, 0700, no link) — under a
 *  shared `/tmp` another account could pre-create it and have this write
 *  follow a link it planted. */
function registerRoot(dir: string, appsRoot: string, until?: number): void {
  const entry = rootRegistryEntry(dir);
  if (_prepareLockDir(dirname(entry), { until }) !== null) return;
  sweepRootRegistry(dirname(dir));
  try {
    Deno.writeTextFileSync(entry, appsRoot, { mode: 0o600 });
  } catch { /* aio-ok: unregistered dirs are only counted, never swept */ }
}

/** Drop the registry entries under `base` whose lock dir is gone — removed
 *  by something that never unregisters it (a test's recursive cleanup, a
 *  1.0.9 app's prune). Each is a few bytes, but nothing else would ever
 *  clear them. Best effort: a dir re-created in the gap loses its entry, and
 *  an unregistered dir is only ever COUNTED by the gate, never removed.
 *  @internal */
export function sweepRootRegistry(base: string): void {
  const reg = join(base, ".aio-roots");
  let names: string[];
  try {
    names = [...Deno.readDirSync(reg)].map((e) => e.name);
  } catch {
    return; // aio-ok: no registry yet
  }
  for (const n of names) {
    if (_exists(join(base, n))) continue;
    try {
      Deno.removeSync(join(reg, n));
    } catch { /* aio-ok: a sibling dropped it first */ }
  }
}

/** Drop `dir`'s registry entry — after `dir` itself is gone. */
function unregisterRoot(dir: string): void {
  try {
    Deno.removeSync(rootRegistryEntry(dir));
  } catch { /* aio-ok: never registered, or already dropped */ }
}

/** Where `lockDir()` puts the lock dir for an apps root ("" = the shared
 *  one): the base and the `-<scope>` suffix. Pure over the env.
 *
 *  The scope is the last 48 of the root's ASCII letters and digits, and it is
 *  a CONTRACT between builds: an app pinned to an older aio and an `am` on
 *  this one must name the same directory, or the lock no longer refuses a
 *  second start and `am` says "not running" about a live app. So two roots
 *  that differ only in what the scope drops (letters of another script, a
 *  prefix past 48 characters) are one lock dir, by design of that contract —
 *  the start that loses says so by name (`_alreadyRunningMessage`), and the
 *  data folder's own claim (`claimHome`) keeps the two apart. @internal */
// aio-ok: exported for its test (tests/lock-dir-scope-of-a-root.test.ts) — the product reaches it through `lockDir()`
export function _lockDirParts(
  appsRoot: string,
): { base: string; scope: string } {
  const base = Deno.build.os === "windows"
    ? (Deno.env.get("TEMP") ?? Deno.env.get("TMP") ?? "C:\\Temp")
    : (Deno.env.get("XDG_RUNTIME_DIR") ?? "/tmp");
  const scope = appsRoot
    ? "-" + appsRoot.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "")
      .slice(-48)
    : "";
  return { base, scope };
}

/** {@linkcode pruneDeadLockDirAt} for the scoped lock dir of `appsRoot` (an
 *  absolute `AIO_APPS_DIR`) — for a supervisor that owns that root and knows
 *  its processes are done (the test runner, after a shard). @internal */
// aio-ok: a seam for the test runner (scripts/test-shards.ts), not the product
export function pruneDeadLockDir(appsRoot: string): boolean {
  if (!appsRoot) return false;
  const { base, scope } = _lockDirParts(appsRoot);
  return pruneDeadLockDirAt(join(base, "aio" + scope));
}

/** {@linkcode pruneDeadLockDirAt} for every scoped lock dir whose name carries
 *  `tag` — the unique tail of a temp dir's name, which every apps root under
 *  it puts into its scope (whatever the subpath, so long as it keeps the
 *  48-char scope). Returns how many were removed. @internal */
export function pruneDeadLockDirsTagged(tag: string): number {
  if (tag.length < 8) return 0; // too short to be unique — never guess
  const { base } = _lockDirParts("x");
  let n = 0;
  let names: string[];
  try {
    names = [...Deno.readDirSync(base)]
      .filter((e) => e.isDirectory && e.name.startsWith("aio-"))
      .map((e) => e.name);
  } catch {
    return 0; // aio-ok: no runtime base — nothing was created in it
  }
  for (const name of names) {
    // The temp dir is gone before this runs: its root is gone.
    if (name.includes(tag) && pruneDeadLockDirAt(join(base, name), true)) n++;
  }
  return n;
}

/** Remove the scoped lock dir `dir` once nothing LIVE is in it — file by
 *  file, only the kinds this module knows how to judge dead, then the dir
 *  itself NEVER recursively:
 *  - a `.lock` whose owner is dead — compare-and-delete against the exact
 *    bytes judged, so a lock re-published meanwhile is never the one removed;
 *    an unparsable one only by {@linkcode unknownLockDead};
 *  - an idle `.lock.mx` mutex; a `watch-<pid>.tmp` / `<lock>.<pid>.<n>.tmp`
 *    whose pid is gone;
 *  - a `.sock` / `.http.sock` nobody is bound to (Linux: absent from
 *    `/proc/net/unix`; elsewhere unknown, so it stays) — a `singleton: false`
 *    app holds no lock, and its socket is the only sign it is alive;
 *  - a legacy `<appId>.launch.json`, or a second launch's `<key>.show`
 *    request, with no lock of that app beside it.
 *  Anything else keeps the dir. For a throwaway apps root whose processes are
 *  done — a test's temp dir, where a SIGKILLed child app leaves exactly these
 *  behind and no creator is alive to prune them — and the suite's end gate.
 *  The shared (unscoped) dir is never passed here. @internal */
export function pruneDeadLockDirAt(dir: string, rootGone = false): boolean {
  let names: string[];
  try {
    names = [...Deno.readDirSync(dir)].map((e) => e.name);
  } catch {
    return false; // aio-ok: never created, or already gone
  }
  let bound: Set<string> | null | undefined;
  for (const n of names) {
    const path = join(dir, n);
    if (n.endsWith(".lock")) {
      // Read through the path: `readLock` resolves under `lockDir()`, which
      // may be a different scope in this process.
      const { raw, data: own } = readLockAt(path);
      if (raw === null) continue; // gone, or not a file — rmdir decides
      if (!own) {
        if (unknownLockDead(path, raw, rootGone)) removeLockFileIf(path, raw);
        continue;
      }
      // Naming THIS process but held by no lock of it: a hand-written record
      // (a test fixture) — as dead as its writer is about to be.
      const planted = isOwnLock(own) &&
        !AppLock.live().some((l) => lockPath(l.key) === path);
      if (planted || !isLockOwnerAlive(own)) removeLockFileIf(path, raw);
    } else if (n.endsWith(".lock.mx") || n.endsWith(".hold")) {
      dropIdleMutex(path);
    } else if (/\.sock$/.test(n)) {
      if (bound === undefined) bound = boundUnixSockets();
      if (bound && !bound.has(path)) removeIfSocket(path);
    } else {
      const m = SENTINEL_NAME.exec(n) ??
        new RegExp(`\\.lock\\.${PID_TAG}\\.[0-9a-f]{8}\\.tmp$`).exec(n);
      // With the apps root gone, an untagged file (an older build, or no
      // `/proc` access) goes once its pid is dead — the 10-minute age wait
      // is for a root something may still live under.
      if (
        m && (taggedOwnerGone(path, Number(m[1]), m[2]) ||
          (rootGone && !isProcessAlive(Number(m[1]))))
      ) {
        try {
          Deno.removeSync(path);
        } catch { /* aio-ok: a sibling removed it first */ }
      }
    }
  }
  // A pre-alpha38 `<appId>.launch.json` (nothing writes one there now; it is
  // only read) goes once no lock of that app is left beside it.
  for (const n of names) {
    const m = /^(.+)\.(?:launch\.json|show|quit)$/.exec(n);
    if (m && !_exists(join(dir, `${m[1]}.lock`))) {
      try {
        Deno.removeSync(join(dir, n));
      } catch { /* aio-ok: already gone */ }
    }
  }
  try {
    Deno.removeSync(dir);
  } catch {
    return false; // aio-ok: something live (or unknown) is in it — kept
  }
  unregisterRoot(dir);
  if (_lockDir === dir) {
    _lockDir = null;
    _lockDirKey = null;
  }
  return true;
}

/** An unparsable lock is written by nothing live: a publish is atomic (the
 *  record exists whole or not at all), so it is a torn 1.0.9 write, a hand
 *  edit, or debris. It goes when it names no live pid AND either its apps
 *  root is gone (`rootGone`: the caller checked — the gate) or it has not
 *  been touched for {@linkcode TORN_LOCK_AGE_MS}. Kept forever, it made its
 *  dir un-prunable while the gate counted it as a leftover. */
const TORN_LOCK_AGE_MS = 10 * 60_000;
function unknownLockDead(
  path: string,
  raw: string,
  rootGone: boolean,
): boolean {
  let pid: unknown;
  try {
    pid = (JSON.parse(raw) as { pid?: unknown } | null)?.pid;
  } catch { /* aio-ok: not JSON — no owner named */ }
  if (typeof pid === "number" && pid > 0 && isProcessAlive(pid)) return false;
  if (rootGone) return true;
  try {
    const m = Deno.statSync(path).mtime;
    return m !== null && ageSince(m.getTime()) > TORN_LOCK_AGE_MS;
  } catch {
    return false; // aio-ok: gone meanwhile — nothing to judge
  }
}

/** Paths of the unix sockets some process is bound to, or null where that
 *  cannot be read — "unknown", never "none".
 *  - Linux: `/proc/net/unix` (the path is the 8th column on);
 *  - macOS: `netstat -f unix -n` (the path is the 9th column on — measured on
 *    the macOS 14 VM; it is the path as bound, `/tmp/…` not `/private/tmp`).
 *  Without it a SIGKILLed app's socket was "unknown" on macOS and kept its
 *  lock dir forever — a CI shard's runtime dir with it.
 *  `read`/`os` are seams (a table a test builds). @internal */
export function boundUnixSockets(
  read?: () => string,
  os: typeof Deno.build.os = Deno.build.os,
): Set<string> | null {
  const firstPathCol = os === "darwin" ? 8 : 7;
  let text: string;
  try {
    text = read
      ? read()
      : os === "linux"
      ? Deno.readTextFileSync("/proc/net/unix")
      : os === "darwin"
      ? netstatUnix()
      : (() => {
        throw new Error("no socket table on " + os);
      })();
  } catch {
    return null; // aio-ok: no table readable here — liveness unknown
  }
  // The path is the RAW remainder after the fixed columns — never split and
  // rejoined, which folded `a  b` and `a\tb` into `a b` and named a socket
  // that does not exist (its own dir then read as dead). A path always starts
  // with `/`, so the gap before it is unambiguous.
  const row = new RegExp(`^\\s*(?:\\S+\\s+){${firstPathCol}}(/.*?)\\r?$`);
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    const path = row.exec(line)?.[1];
    if (path === undefined) continue;
    out.add(path);
    try {
      out.add(Deno.realPathSync(path)); // a caller may name it either way
    } catch { /* aio-ok: gone meanwhile — the bound name is enough */ }
  }
  return out;
}

/** macOS's socket table, as text; throws when it cannot be read. */
function netstatUnix(): string {
  const r = new Deno.Command("netstat", {
    args: ["-f", "unix", "-n"],
    env: { LC_ALL: "C" },
    stdout: "piped",
    stderr: "null",
  }).outputSync();
  if (!r.success) throw new Error("netstat failed");
  return new TextDecoder().decode(r.stdout);
}

/** Remove what was just created at `path` — a file or a socket. */
export function removeIfNotDir(path: string): void {
  try {
    if (!Deno.lstatSync(path).isDirectory) Deno.removeSync(path);
  } catch { /* aio-ok: gone, or never made */ }
}

/** Remove `path` only if it is still a socket (never a file swapped in). */
function removeIfSocket(path: string): void {
  try {
    if (Deno.lstatSync(path).isSocket) Deno.removeSync(path);
  } catch { /* aio-ok: gone meanwhile */ }
}

/** Re-create a lock dir a sibling's prune removed between our `lockDir()`
 *  and our write. A scoped one is then OURS to prune at exit, like one
 *  `lockDir()` created — else it outlived every process, unmarked. */
export function remakeLockDir(dir: string, until?: number): void {
  const was = _exists(dir);
  // The same checks `lockDir()` made (ours, 0700, not a link) — EVERY time,
  // not only when it is missing: under a shared `/tmp` another account can
  // create the path in the gap a prune opened, and "it exists" is exactly
  // what that looks like.
  const why = _prepareLockDir(dir, { until });
  if (why !== null) throw new Error(`aio: ${why}`);
  const appsRoot = appsDirEnv() ?? "";
  if (was || appsRoot === "" || dir !== _lockDir) return;
  pruneAtExit(dir);
  registerRoot(dir, appsRoot, until);
}

/** Make sure the lock dir holding `path` exists before a file is created in
 *  it — a control socket, the watcher's sentinel. `lockDir()` is cached, and
 *  a sibling's exit prune removes the dir whenever it is empty: a
 *  `singleton: false` app (no lock to keep it) then bound its socket into a
 *  void, ENOENT. No-op for a pipe name or a dir that is there. */
export function ensureLockDirOf(path: string, until?: number): void {
  if (inLockDir(path)) return remakeLockDir(dirname(path), until);
  // A caller's own socket path (`createUDSListener` is public) whose
  // directory is MISSING: made, 0700 — made here, so ours, and nobody's
  // arrangement to respect. 1.0.19 made it (for `/run/aio/x.sock`: by the
  // name rule that is gone), and a start that worked there failed ENOENT. One
  // that EXISTS is theirs, and is never touched: no chmod, as `inLockDir`
  // says. A mkdir that fails is thrown, with its path.
  if (isPipePath(path) || _exists(dirname(path))) return;
  Deno.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
}

/** Is `path` a file in a LOCK dir — this one, or one `_chooseLockDir`
 *  answered with (the `/tmp` fallback `resolveSocketPath` picks)? Only a
 *  lock dir gets the lock dir's rules. A socket path a caller chose
 *  (`createUDSListener` is public) is left as it was: chmodding its directory
 *  0700 is not ours to do (one that is missing is made:
 *  {@linkcode ensureLockDirOf}).
 *
 *  By the exact PATH aio chose, never by the directory's name: any directory
 *  called `aio` or `aio-u<digits>` used to count — a caller's socket at
 *  `/run/aio/app.sock`, or in a project folder named `aio`, had its directory
 *  made 0700, which cut off the reverse proxy that reached it through the
 *  group. Never a Windows pipe name, which is no file. */
function inLockDir(path: string): boolean {
  if (isPipePath(path)) return false;
  const dir = dirname(path);
  return _lockDeps.chosen.has(dir) || dir === lockDir();
}

/** Is `e` a create's answer to "the directory is not there"? ENOENT on every
 *  OS, macOS's EINVAL too ({@linkcode removedUnderCreate}) — for a unix
 *  socket's bind as for a file (measured on macOS 26.5: 3 processes, 5 000
 *  rounds each of mkdir + bind + unlink + rmdir — 1 653 EINVAL beside 1 158
 *  ENOENT; Linux, ENOENT only). `node:net` says it as a `code`. */
function dirGone(e: unknown): boolean {
  return e instanceof Deno.errors.NotFound ||
    (e as { code?: unknown } | null)?.code === "ENOENT" ||
    removedUnderCreate(e) || e instanceof PrunedUnderCreate;
}

/** macOS's THIRD answer to a create in a directory that is removed under it:
 *  success. The create returns, and what it made is in no directory — the
 *  rmdir went through beside it (measured, APFS on macOS 26.5, 3 processes
 *  of mkdir + create + lstat + unlink + rmdir on one dir: after 24 of 60 000
 *  creates that succeeded the dir was gone, the file not at its path, its
 *  handle's link count 0; a socket's bind, 6 of 90 000; Linux, 0 of either).
 *  So there a dir that is gone right after a create WAS pruned: the refusal
 *  {@linkcode holdLockDir} throws is this one, which {@linkcode dirGone}
 *  reads as "made again, try again" for as long as any pruned dir is waited
 *  for — and which is thrown as the refusal it is once that is over. */
class PrunedUnderCreate extends Error {}

/** A create at `path`, first tried at `since` (`performance.now()`), failed
 *  with `e`: was its lock dir removed under it (a sibling's exit prune of the
 *  momentarily empty scoped dir), and is the dir made again — try once more?
 *  False for any other error, for a directory that is not a lock dir (never
 *  made here), and past the wait. THE answer for every create that has no
 *  file of its own in the dir yet to keep it ({@linkcode createInLockDir}; a
 *  bind that fails later, `listenLocal`'s `rebind`).
 *
 *  Bounded by TIME, as the mutex's open is, not by a count: six processes
 *  making and pruning one scoped dir in a loop lost a count of three in 1.3 %
 *  of 18 000 creates, and none of them under the wait. */
export function lockDirRemade(
  path: string,
  e: unknown,
  since: number,
): boolean {
  // Windows: a create in a directory that is BEING removed is refused
  // (ACCESS_DENIED) until the removal is done — the same prune, caught a
  // moment earlier (6 processes making and pruning one dir: 8 of 18 000
  // creates). Waited out as the mutex's open waits out a file being deleted.
  const gone = dirGone(e) || (_lockDeps.windows() && isHeldOpenError(e));
  if (
    !gone || !inLockDir(path) || _lockDeps.now() - since > MUTEX_WAIT_MS
  ) return false;
  _lockDeps.pause(1);
  saySlowLockDir(dirname(path), since);
  try {
    // Until the SAME bound: making the dir again used to bring a wait of its
    // own (`_prepareLockDir`), so one create could take twice the time.
    ensureLockDirOf(path, since + MUTEX_WAIT_MS);
  } catch (refusal) {
    // The dir cannot be made again: that is what is said, and the create's
    // own error — the reason anything was being made — stays with it.
    if (refusal instanceof Error && refusal.cause === undefined) {
      refusal.cause = e;
    }
    throw refusal;
  }
  return true;
}

/** One line, once a process (`_lockDeps.saidSlow`), when a step in the lock
 *  dir has been waiting for {@linkcode SLOW_NOTE_MS}: a start that takes
 *  seconds here took them without a word. */
function saySlowLockDir(dir: string, since: number): void {
  if (_lockDeps.saidSlow || _lockDeps.now() - since < SLOW_NOTE_MS) return;
  _lockDeps.saidSlow = true;
  log.warn(
    `waiting for the lock directory ${dir} — another aio process keeps ` +
      `removing it (for up to ${MUTEX_WAIT_MS / 1000} s)`,
  );
}
const SLOW_NOTE_MS = 500;

/** The lock dirs judged by {@linkcode _prepareLockDir}, each by the file
 *  identity of the entry that was judged. */
const _judged = new Map<string, { dev: number; ino: number | null }>();

/** Something was just created in the lock dir `dir`: is `dir` still the
 *  entry that was judged private — or, when a sibling pruned it and made it
 *  again meanwhile, one that passes the same judgement? Null when it is,
 *  else why not.
 *
 *  What this closes: the path is resolved once to judge the dir and again by
 *  the create, and Deno has no `openat` to tie the two. An entry that is ours
 *  cannot be replaced by another account under a sticky `/tmp`, but a scoped
 *  dir is REMOVED by whoever leaves it empty, and in that gap the name is
 *  free for anyone. What stays open: a create that went through such an entry
 *  has happened by the time this looks (it is undone by path, through the
 *  same entry), and an entry swapped and swapped back between the create and
 *  this look is not seen. Neither exists under `$XDG_RUNTIME_DIR`. */
function lockDirMoved(dir: string): string | null {
  const was = _judged.get(dir);
  if (was === undefined || _lockDeps.windows()) return null;
  let now: Deno.FileInfo;
  try {
    now = _lockDeps.lstat(dir);
  } catch (e) {
    // Gone — and what was just created is in it, so it was not pruned (a
    // prune removes an EMPTY dir): the name was taken away with our file
    // behind it. It read as "pruned, so empty" while the peer listener was
    // looked at before its bind; that look is now made after it (`bound`).
    // (macOS does prune it under a create: `PrunedUnderCreate`.)
    if (e instanceof Deno.errors.NotFound) return `${dir} is no longer there`;
    return `${dir} cannot be read (${e instanceof Error ? e.message : e})`;
  }
  if (now.dev === was.dev && now.ino === was.ino) return null;
  const why = judgeLockDir(dir, now);
  if (why === null) _judged.set(dir, { dev: now.dev, ino: now.ino });
  return why;
}

/** {@linkcode lockDirMoved} after a create at `path`: a dir that is no
 *  longer ours is REFUSED — `undo` what was made, and throw. */
export function holdLockDir(path: string, undo: () => void): void {
  if (!inLockDir(path)) return;
  const why = lockDirMoved(dirname(path));
  if (why === null) return;
  try {
    undo();
  } catch { /* aio-ok: the refusal below is what is said */ }
  const pruned = _lockDeps.darwin() &&
    why === `${dirname(path)} is no longer there`;
  throw new (pruned ? PrunedUnderCreate : Error)(
    `aio: ${why} — it was replaced while ${path} was being created in it; ` +
      `refusing to keep this app's lock or control socket there`,
  );
}

/** `create()` something at `path` in the lock dir — a socket, the watcher's
 *  sentinel — with the dir made first and made AGAIN when it is pruned
 *  between the two ({@linkcode lockDirRemade}). What still fails is thrown
 *  as it came; a "no such directory" that does not say where gets the path. */
export function createInLockDir<T>(
  path: string,
  create: () => T,
  /** Close what `create` returned — when the dir turns out to have been
   *  replaced under it ({@linkcode lockDirMoved}); the file at `path` is
   *  removed here. */
  undo?: (made: T) => void,
  /** `create` only STARTS what makes the file (the peer listener, bound
   *  after an import): nothing is at `path` to look for yet, and its maker
   *  holds the dir itself once it is. */
  later = false,
): T {
  const since = _lockDeps.now();
  ensureLockDirOf(path, since + MUTEX_WAIT_MS);
  for (;;) {
    try {
      const made = create();
      if (later) return made;
      holdLockDir(path, () => {
        undo?.(made);
        removeIfNotDir(path);
      });
      return made;
    } catch (e) {
      if (lockDirRemade(path, e, since)) continue;
      if (dirGone(e) && e instanceof Error && !e.message.includes(path)) {
        e.message += `: ${path}`;
      }
      throw e;
    }
  }
}

/** {@linkcode listenLocal} at a socket `path` in the lock dir, by
 *  {@linkcode createInLockDir}'s rule — also for the peer listener, whose
 *  bind fails after this returns. */
export function listenInLockDir(path: string, peer: boolean): LocalListener {
  // The peer listener binds LATER (after an import): its wait starts at its
  // own first failure. Counted from this call, a bind that first failed 2 s
  // in — a cold start on a slow machine — was never asked again.
  let since = 0;
  return createInLockDir(
    path,
    () =>
      _lockDeps.listen(path, {
        peer,
        rebind: (e, tries) =>
          lockDirRemade(
            path,
            e,
            tries === 1 ? (since = _lockDeps.now()) : since,
          ),
        // The look at the dir AFTER the socket is in it: for the peer
        // listener that is here, not when `listen` returned — the look came
        // before the bind, and a dir replaced in between was never seen.
        bound: () => holdLockDir(path, () => removeIfSocket(path)),
      }),
    (l) => l.close(),
    // A Windows pipe is no file in the dir: as ever (`holdLockDir` is a
    // no-op for it either way).
    peer && !isPipePath(path),
  );
}

/** Remove, from `dir`, the `watch-<pid>.tmp` sentinels of watchers whose
 *  process is gone ({@linkcode taggedOwnerGone}) — an app killed, or one
 *  that exited without stopping its server. Nothing else took them out of
 *  the shared dir (232 found in one after a week of test runs), and one
 *  keeps a scoped dir from pruning. Called by a watcher making its own. */
export function sweepDeadSentinels(dir: string): void {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch {
    return; // aio-ok: no dir — nothing to remove
  }
  // EACH one: a remove that fails (a sibling swept it first, a file somebody
  // holds on Windows) used to end the sweep for every sentinel after it.
  for (const e of entries) {
    const m = e.isFile ? SENTINEL_NAME.exec(e.name) : null;
    const path = join(dir, e.name);
    if (!m || !taggedOwnerGone(path, Number(m[1]), m[2])) continue;
    try {
      Deno.removeSync(path);
    } catch { /* aio-ok: a sibling swept it first — the next one is tried */ }
  }
}

/** Scoped lock dirs THIS process created, removed (when empty) at exit. */
const _madeScoped = new Set<string>();
let _pruneArmed = false;

/** A scoped (`AIO_APPS_DIR`) lock dir is created by whoever first asks for
 *  it — an app, but just as often `am backup`, `am status`, or a test calling
 *  `AppLock` in-process — and only an app's shutdown ever pruned it. Every
 *  other creator left it behind in `$XDG_RUNTIME_DIR`: measured, ~5,400 empty
 *  `aio-<scope>` dirs from one day of test runs. The creator now removes it
 *  at exit, by the same rule as {@linkcode pruneLockDir}: only when empty
 *  (idle mutexes dropped first), never recursively — a sibling's live lock
 *  or socket keeps it. Its own held locks are released first, since the
 *  `unload` that releases them may run after this one. */
function pruneAtExit(dir: string): void {
  _madeScoped.add(dir);
  if (_pruneArmed) return;
  _pruneArmed = true;
  try {
    addEventListener("unload", () => {
      for (const l of AppLock.live()) l.release();
      for (const d of _madeScoped) {
        dropOwnPlants(d);
        pruneScopedDir(d);
      }
      _madeScoped.clear();
    });
  } catch { /* aio-ok: no global event target — nothing to arm */ }
}

/** Remove, from `dir`, lock files that name THIS process but that no lock it
 *  holds wrote — records written by hand (`writeLock`, a test's fixture) that
 *  outlive the process they name, and this process's own `watch-<pid>.tmp`
 *  sentinel. Only this process's own: another's dead
 *  lock is left for the next acquire, which says what that death may have
 *  cost. Called at exit, after every held lock is released. */
function dropOwnPlants(dir: string): void {
  // This process's live-reload sentinel (`server-watcher.ts`): its watcher is
  // gone with the process, and left behind it keeps the dir from pruning.
  let files: string[];
  try {
    files = [...Deno.readDirSync(dir)].filter((e) => e.isFile)
      .map((e) => e.name);
  } catch {
    return; // aio-ok: gone — nothing planted in it
  }
  const own = `watch-${ownPidTag()}`;
  for (const n of files) {
    // One per watcher this process ran (`sentinelName`).
    if (
      !n.startsWith(own) || !SENTINEL_NAME.test(n) ||
      !/^[-.]/.test(n.slice(own.length))
    ) continue;
    try {
      Deno.removeSync(join(dir, n));
    } catch { /* aio-ok: its watcher removed it first */ }
  }
  for (const n of files.filter((f) => f.endsWith(".lock"))) {
    const path = join(dir, n);
    try {
      const raw = Deno.readTextFileSync(path);
      // Compare-and-delete: only the record read, never one written since.
      const l = parseLock(raw);
      if (l && isOwnLock(l)) removeLockFileIf(path, raw);
    } catch { /* aio-ok: unreadable or gone — not ours to judge */ }
  }
}

/** Remove `dir` if nothing but idle mutex files is in it. */
function pruneScopedDir(dir: string): boolean {
  try {
    for (const e of Deno.readDirSync(dir)) {
      if (e.isFile && e.name.endsWith(".lock.mx")) {
        dropIdleMutex(join(dir, e.name));
      }
    }
  } catch { /* aio-ok: the dir is already gone — nothing to prune */ }
  try {
    Deno.removeSync(dir);
  } catch {
    return false; // aio-ok: not empty (a sibling's lock/socket), or gone
  }
  unregisterRoot(dir);
  if (_lockDir === dir) {
    _lockDir = null;
    _lockDirKey = null;
  }
  return true;
}

/** Create `dir` 0700 and say why it still cannot hold a control socket.
 *
 *  The 0700 is NOT tidiness: the base is `$XDG_RUNTIME_DIR` (already 0700, so
 *  the chmod is a no-op) OR `/tmp` when that is unset — containers,
 *  no-systemd hosts, plain ssh. There the default 0755 left every app's
 *  control socket at a predictable path any local user could traverse to and
 *  connect to, i.e. dispatch methods into someone else's app.
 *
 *  It used to stop at the chmod and swallow the failure, which is the half
 *  that does not hold: chmod on a directory you do not own returns EPERM, so
 *  a `/tmp/aio` somebody else created — at 0777, or at 0700 as themselves —
 *  was then used exactly as if the chmod had worked. Create, narrow, and then
 *  LOOK. */
export function _prepareLockDir(
  dir: string,
  // A seam, because the case that matters cannot be built in a test: chmod
  // fails with EPERM only on a directory owned by ANOTHER account, and a test
  // has exactly one uid. Injecting the chmod reproduces it exactly — the same
  // branch, for the same reason — instead of leaving the wiring unproven and
  // the pure rule tested in isolation. @internal
  ops: {
    chmod?: (path: string, mode: number) => void;
    /** The look THROUGH a link of ours, at what it names. */
    stat?: (path: string) => Deno.FileInfo;
    /** The same seam, for the OTHER account's half of the symlink case: a
     *  link this process planted is its own, and a test has one uid.
     *  @internal */
    lstat?: (path: string) => Deno.FileInfo;
    /** Until when (`performance.now()`) a dir that keeps being pruned is
     *  made again — the caller's own bound, so one start step waits once.
     *  Default: {@linkcode MUTEX_WAIT_MS} from now. */
    until?: number;
  } = {},
): string | null {
  const lstat = ops.lstat ?? _lockDeps.lstat;
  const since = _lockDeps.now();
  const until = ops.until ?? since + MUTEX_WAIT_MS;
  /** Make it; false when it could not be made. */
  const make = (): boolean => {
    try {
      // Made 0700, not made and THEN narrowed: a sibling that looks between
      // the two saw a dir of ours at the umask's 0755 and refused it as
      // "not owner-only" (macOS, 3 processes making and pruning one dir: 39
      // of 9 000). The chmod (`judgeLockDir`) is for one that was already
      // there.
      Deno.mkdirSync(dir, { recursive: true, mode: 0o700 });
      return true;
    } catch (e) {
      // "Exists" or "not there" from a recursive mkdir: the dir was pruned
      // inside the call itself (it found the dir, then looked at it) — as
      // good as made and gone. (A FILE of that name is "exists" too, and so
      // is a link to nothing; the look below finds either.) Anything else
      // could not be made.
      return pruned(e) || e instanceof Deno.errors.AlreadyExists;
    }
  };
  // Windows answers ACCESS_DENIED for a directory that is BEING removed —
  // to the mkdir and to the look alike — until the removal is done.
  const pruned = (e: unknown): boolean =>
    e instanceof Deno.errors.NotFound ||
    (_lockDeps.windows() && isHeldOpenError(e));
  let made = make();
  // ONE look, at the entry itself, and that one result is judged. It was
  // three steps — chmod, `lstat` for "whose link", `stat` for the mode — each
  // resolving the path again, on a base (`/tmp`, no `$XDG_RUNTIME_DIR`) where
  // any local account can make the name first:
  // - the chmod FOLLOWED a link: `/tmp/aio` planted as a link to a directory
  //   of ours was narrowed to 0700 before the link was refused;
  // - a directory of theirs passed the `lstat` (not a link) and was swapped
  //   for a link to a 0700 directory of ours before the `stat`, which
  //   followed it and found nothing wrong.
  for (;;) {
    let entry: Deno.FileInfo;
    try {
      entry = lstat(dir);
    } catch (e) {
      // MADE a moment ago and not there: a sibling's exit pruned the (empty)
      // scoped dir between the two — made again, for as long as the mutex
      // waits. It was refused instead, and the next candidate taken: an app
      // then kept its lock where `am` does not look (six processes making
      // and pruning one dir: 1 150 of 18 000 looks). One that could not be
      // made is refused at once, as ever. With a pause: the loop ran hot.
      if (made && pruned(e) && _lockDeps.now() < until) {
        _lockDeps.pause(1);
        saySlowLockDir(dir, since);
        made = make();
        continue;
      }
      return `${dir} cannot be created or read (${
        e instanceof Error ? e.message : e
      })`;
    }
    if (_lockDeps.windows()) {
      // No POSIX mode or owner to read: the profile's ACLs are the boundary.
      // But it has to BE there — a dir that could not be made was answered
      // "fine" without a look, and the create after it failed unexplained.
      // (A junction or a link counts by what it names.)
      try {
        const at = entry.isSymlink ? (ops.stat ?? Deno.statSync)(dir) : entry;
        return at.isDirectory ? null : `${dir} exists and is not a directory`;
      } catch (e) {
        return `${dir} cannot be created or read (${
          e instanceof Error ? e.message : e
        })`;
      }
    }
    const why = judgeLockDir(dir, entry, ops);
    if (why === null) _judged.set(dir, { dev: entry.dev, ino: entry.ino });
    return why;
  }
}

/** Why the lock dir entry `entry` (an `lstat` of `dir`) cannot hold a
 *  control socket, or null. Narrows a directory of OURS that is wider than
 *  0700; touches nothing else.
 *
 *  A real directory is judged by that one result — owner and mode — and
 *  chmodded only when it is provably ours: an entry of ours cannot be swapped
 *  by another account under a sticky `/tmp`, so the chmod names what was
 *  judged. (Without `--allow-sys` there is no uid to prove it with: a wider
 *  directory that is no link is narrowed and looked at again — `blind`.)
 *
 *  A symbolic link is refused when it is somebody else's: whoever owns the
 *  link chooses where the lock and the socket go, and a link to a 0700
 *  directory of ours passes every check on its target. A link of OURS (or
 *  one whose owner cannot be read — "cannot tell" must not refuse) is the
 *  user's own arrangement: its target is looked at ONCE and judged, never
 *  waited for — one that names nothing is refused at once. A link in the
 *  path ABOVE the dir (macOS's `/tmp` → `/private/tmp`) is not this entry
 *  and is followed as any path is. */
function judgeLockDir(
  dir: string,
  entry: Deno.FileInfo,
  ops: {
    chmod?: (path: string, mode: number) => void;
    stat?: (path: string) => Deno.FileInfo;
    lstat?: (path: string) => Deno.FileInfo;
  } = {},
): string | null {
  const me = selfUid();
  const known = (uid: number | null | undefined): uid is number =>
    uid !== null && uid !== undefined;
  let at = entry;
  if (entry.isSymlink) {
    if (me !== null && known(entry.uid) && entry.uid !== me) {
      return `${dir} is a symbolic link owned by uid ${entry.uid}, not by ` +
        `you (uid ${me}) — whoever owns the link chooses where this app's ` +
        `lock and control socket actually go`;
    }
    try {
      at = (ops.stat ?? Deno.statSync)(dir);
    } catch (e) {
      return `${dir} is a symbolic link to nothing usable (${
        e instanceof Error ? e.message : e
      })`;
    }
  }
  if (!at.isDirectory) return `${dir} exists and is not a directory`;
  const wide = typeof at.mode === "number" && (at.mode & 0o077) !== 0;
  const ours = me !== null && at.uid === me &&
    (!entry.isSymlink || entry.uid === me);
  // No uid to prove it with (no `--allow-sys`): a real directory — never a
  // link, which a chmod follows — is narrowed all the same, as 1.0.19 did
  // (an app that started there on a 0755 `/tmp/aio` was refused, with no
  // fallback to take). Whose it is the chmod itself answers: it fails on
  // somebody else's, and the mode then refuses below. What it LEFT is looked
  // at again and must be the entry that was judged.
  const blind = me === null && !entry.isSymlink;
  if (wide && (ours || blind)) {
    try {
      (ops.chmod ?? Deno.chmodSync)(dir, 0o700);
      // Looked at again the same way: what the chmod LEFT is what is judged.
      const again = (ops.lstat ?? _lockDeps.lstat)(dir);
      if (
        again.isSymlink !== entry.isSymlink ||
        (blind && (again.dev !== entry.dev || again.ino !== entry.ino))
      ) {
        return `${dir} was replaced while it was being checked`;
      }
      at = again.isSymlink ? (ops.stat ?? Deno.statSync)(dir) : again;
    } catch { /* not ours to chmod after all — the mode below says so */ }
  }
  return privateDirRefusal(dir, at.mode, at.uid);
}

/** The lock/socket directory this process may actually use.
 *
 *  Shared `<base>/aio` first — one directory per machine keeps `am` able to
 *  see every app of THIS user. When that one belongs to somebody else, a
 *  uid-scoped sibling is used instead: it is the same isolation the shared
 *  directory was supposed to provide, and it also fixes the case that was
 *  merely broken rather than unsafe — a second user on a host with no
 *  `$XDG_RUNTIME_DIR` could not bind in the first user's 0700 directory and
 *  got an unexplained bind failure.
 *
 *  If the fallback is unusable too, that is not a configuration this can paper
 *  over, and a control socket is not something to place hopefully.
 *
 *  Exported because `resolveSocketPath`'s long-path fallback places a control
 *  socket in a shared `/tmp` too and must ask the SAME question — it used to
 *  mkdir + chmod and hope, which is the half that does not hold. @internal
 *  @decider */
export function _chooseLockDir(
  base: string,
  scope: string,
  /** The caller's bound for the whole choice; else one for both candidates. */
  until = _lockDeps.now() + MUTEX_WAIT_MS,
): string {
  const chosen = (dir: string): string => {
    _lockDeps.chosen.add(dir); // a lock dir by aio's own choice: `inLockDir`
    return dir;
  };
  const preferred = join(base, "aio" + scope);
  const first = _prepareLockDir(preferred, { until });
  if (first === null) return chosen(preferred);
  const uid = selfUid();
  if (uid === null) {
    throw new Error(
      `aio: ${first}, and this process cannot read its own uid to pick a ` +
        `private directory instead. Set XDG_RUNTIME_DIR to a directory you ` +
        `own, or grant --allow-sys.`,
    );
  }
  const scoped = join(base, `aio-u${uid}${scope}`);
  const second = _prepareLockDir(scoped, { until });
  if (second === null) {
    log.warn(
      `${first} — using ${scoped} for this app's lock and control socket ` +
        `instead. Other users' aio apps are not visible to \`am\` from here.`,
    );
    return chosen(scoped);
  }
  throw new Error(
    `aio: refusing to place a control socket where another local user can ` +
      `reach it. ${first}; the private fallback failed too: ${second}. ` +
      `A control socket lets whoever connects dispatch methods into this app. ` +
      `Fix: remove or chmod 700 the directory named above, or set ` +
      `XDG_RUNTIME_DIR to a directory you own.`,
  );
}

/** Remove the per-`AIO_APPS_DIR` lock dir when it is empty — called at the
 *  very end of an app's shutdown. The default dir (`…/aio`) is never removed;
 *  it is shared by every app on the machine and costs nothing. A scoped one
 *  belongs to a temp home that is about to be deleted, and used to outlive it
 *  forever. Non-recursive on purpose: another app's lock or a live watcher
 *  sentinel makes the rmdir fail, which is the right answer. */
export function pruneLockDir(): void {
  if (!_lockDir || !appsDirEnv()) return;
  // A crashed app's idle mutex file would keep the dir non-empty forever.
  // On success the cached answer is forgotten, so the next `lockDir()` call
  // re-creates it (a later app in this same process — every sequential test
  // — must not write into a void).
  pruneScopedDir(_lockDir);
}

/** 8 hex chars of FNV-1a over `s` — a filename-safe tag, not a secret. */
export function hash8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** THE key a lock (and its sockets) is filed under: `<appId>` when the app runs
 *  from its default home, `<appId>@<hash8(home)>` otherwise.
 *
 *  The lock used to be keyed by appId alone, so an app booted a second time
 *  ON PURPOSE from an isolated home (`--<app>-home=/tmp/x` for a smoke test or
 *  a screenshot harness) was refused as a duplicate — and the refusal named
 *  the USER's port and pid, which is how a harness came to `kill` the user's
 *  running wallet (a field report, §2.1). Identity is appId AND home: one
 *  data dir, one instance. The default home keeps the plain name, so nothing
 *  already running or already written needs migrating. */
export function lockKey(
  appId: string,
  home?: string,
  profile?: string,
): string {
  if (!home) return appId;
  const want = resolve(home);
  if (want === resolve(appHome(appId))) return appId;
  // A PROFILE's home is filed under its name — `myapp@dev` — never a hash: a
  // name cannot look like one (profileNameError refuses 8 hex digits). The
  // default base (`~/.myapp-dev`) is recognised from the home alone; an
  // `appDir` app's (`/opt/myapp-dev`) from the profile its lock RECORDS
  // (`LockData.profile`), which every reader passes back in.
  const named = profile !== undefined && want.endsWith(`-${profile}`) &&
      profileNameError(profile) === null
    ? profile
    : profileOfHome(appId, want);
  if (named) return `${appId}@${named}`;
  return `${appId}@${hash8(want)}`;
}

/** The two halves of a lock key / lock file name. */
export function parseLockKey(key: string): { appId: string; tag?: string } {
  const at = key.lastIndexOf("@");
  return at > 0
    ? { appId: key.slice(0, at), tag: key.slice(at + 1) }
    : { appId: key };
}

/** The key of the lock THIS process holds for `appId`, else the plain appId.
 *  The socket paths (`paths.ts`) are named by it, so an instance's control
 *  socket follows its lock: `am --home=<dir>` reads that lock and finds that
 *  socket, never the default instance's. */
export function heldLockKey(appId: string): string {
  for (const l of AppLock.live()) if (l.appId === appId) return l.key;
  return appId;
}

/** Full path to the lock file for a given lock key (see {@linkcode lockKey}) */
export function lockPath(key: string): string {
  return join(lockDir(), `${key}.lock`);
}

/** Where a second launch asks the running window of the instance under lock
 *  `key` to come to the front — beside the lock, in the 0700 lock dir. The
 *  window watches it (`AioMeta.showFile`); see `askRunningToShow` (aio-run-helpers.ts). */
export function showRequestPath(key: string): string {
  return join(lockDir(), `${key}.show`);
}

/** The show-request file of the lock this process holds for `appId`, or
 *  undefined when it holds none (`singleton: false`, `libraryMode`): with no
 *  lock there is no "second launch" to answer. */
export function heldShowRequestPath(appId: string): string | undefined {
  const l = AppLock.live().find((l) => l.appId === appId);
  return l ? showRequestPath(l.key) : undefined;
}

// ── Launch-info sidecar (am restart flag preservation) ───────
// The running app can't recover deno-runtime flags (e.g. --env-file) from its
// own Deno.args — only the launcher (am) knows them. am records them here at
// start so `am restart` can replay the exact launch; am-owned, the app's _run()
// never touches it. (a field report: restart dropped --env-file, so
// the vault silently stopped auto-unlocking.)
export type LaunchInfo = {
  flags: string[];
  entry?: string;
  cwd?: string;
  /** The pid am spawned, and its kernel start stamp — how `am instances`
   *  tells an instance am started from one a terminal or launcher started
   *  (`startedBy`). Absent on records before 1.0.23. */
  pid?: number;
  startToken?: string;
  startEpoch?: number;
  /** The start environment that decides where data lives (am-instance.ts
   *  `captureLaunchEnv`; paths only, never secrets): name → value, null =
   *  unset. `am restart` replays it. Absent on records before 1.0.23. */
  env?: Record<string, string | null>;
};

/** Path to am's launch-info sidecar: `~/.<appId>/launch.json`.
 *
 *  Two things this is NOT, both learned the hard way:
 *
 *  • not the runtime dir — a launch record has to outlive the machine (`am start`
 *    in the morning, reboot, `am restart` in the afternoon must still replay
 *    `--env-file`). `$XDG_RUNTIME_DIR` is cleared on logout BY DESIGN, which is
 *    exactly right for the lock and socket and exactly wrong for this.
 *  • not a shared toolchain directory — these are THIS app's flags, so keeping
 *    them with the app means "delete the app" is one `rm -rf` and there is no
 *    second root to relocate when sandboxing. */
export function launchInfoPath(appId: string): string {
  return appDirs(appId).launch;
}

/** Pre-alpha38: the record lived in the runtime dir, so it vanished on logout. */
function legacyLaunchPath(appId: string): string {
  return join(lockDir(), `${appId}.launch.json`);
}

/** Record the flags am launched an app with (best-effort). */
export function writeLaunchInfo(
  appId: string,
  info: LaunchInfo,
): string | null {
  // The app's HOME, not a lock dir: a plain mkdir, as ever. The lock dir's
  // rules (chmod 0700, refuse what is not ours) have no business here — a
  // home on exFAT/NTFS/CIFS or owned by another uid cannot be chmodded, and
  // applying them made launch.json silently vanish, so `am restart` came back
  // without the `--env-file` it was started with (a field bug, twice).
  const path = launchInfoPath(appId);
  try {
    Deno.mkdirSync(dirname(path), { recursive: true });
    Deno.writeTextFileSync(path, JSON.stringify(info));
    return null;
  } catch (e) {
    // Said, never swallowed: the caller prints it where the operator looks.
    return `could not record this launch in ${path} (${
      e instanceof Error ? e.message : String(e)
    }) — \`am restart\` will not replay its flags (--env-file, --port, …)`;
  }
}

/** Read the recorded launch info, or null if none/corrupt. */
export function readLaunchInfo(appId: string): LaunchInfo | null {
  // The pre-alpha38 runtime-dir location is still read, so an app already
  // running when aio was upgraded can still be restarted with its flags.
  for (const path of [launchInfoPath(appId), legacyLaunchPath(appId)]) {
    try {
      const info = JSON.parse(Deno.readTextFileSync(path)) as LaunchInfo;
      if (Array.isArray(info.flags)) return info;
    } catch { /* next */ }
  }
  return null;
}

/** Remove the launch sidecar (on a clean stop) — both locations. */
export function removeLaunchInfo(appId: string): void {
  for (const path of [launchInfoPath(appId), legacyLaunchPath(appId)]) {
    try {
      Deno.removeSync(path);
    } catch { /* already gone */ }
  }
}

/** A watcher's sentinel: `watch-<pid tag>.tmp`, and `watch-<pid tag>-<n>.tmp`
 *  for every further watcher of one process ({@linkcode sentinelName}). */
const SENTINEL_NAME = new RegExp(`^watch-${PID_TAG}(?:-\\d+)?\\.tmp$`);

/** The sentinel of this process's watcher number `n` (from 0). The first
 *  keeps the name every build has used; a second one used to share it — it
 *  replaced the first's file, and the first's shutdown removed the file the
 *  second still touched: "watcher unresponsive" a minute later. @internal */
export function sentinelName(n: number): string {
  return `watch-${ownPidTag()}${n === 0 ? "" : `-${n}`}.tmp`;
}

/** Is the process a file's name tags (`pid`, namespace hex `ns`) gone? A pid
 *  means something only in the namespace that wrote it: ours (or none on
 *  either side — macOS, Windows), its death decides. Another namespace (a
 *  container sharing this dir, where pid 7 is not ours), or no namespace
 *  recorded where one exists (an older aio's name): only once the file went
 *  untouched for {@linkcode TORN_LOCK_AGE_MS} — its owner finishes such a
 *  file in microseconds or refreshes it (the watch sentinel, every 30 s). A
 *  future mtime (a skewed clock) counts as fresh. @internal */
export function taggedOwnerGone(
  path: string,
  pid: number,
  ns: string | undefined,
): boolean {
  if ((ns === undefined ? undefined : parseInt(ns, 16)) === ownPidNs()) {
    return pid <= 0 || !isProcessAlive(pid);
  }
  try {
    const m = Deno.statSync(path).mtime;
    return m !== null && Date.now() - m.getTime() > TORN_LOCK_AGE_MS;
  } catch {
    return false; // aio-ok: gone meanwhile — nothing to judge
  }
}
