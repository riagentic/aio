// Reading and writing the lock record (its shape, LockData, stays in
// single-instance-lock.ts beside readLock, the public reader): torn-read
// retries, the seal, exclusive atomic publish, the lock mutex,
// compare-and-swap removal, and printing a record safely. Split out of
// single-instance-lock.ts, which re-exports every name here, so no importer
// changes.

import { basename, dirname, join } from "@std/path";
import { listenLocal } from "./local-listen.ts";
import { log } from "../diagnostics/logger-api.ts";
import {
  _renameDeps,
  isHeldOpenError,
  removeOverSync,
  RENAME_BACKOFF_MS,
} from "../diagnostics/rename-over.ts";
import type { LockData } from "./single-instance-lock.ts";
import {
  hash8,
  holdLockDir,
  lockDir,
  lockDirRemade,
  lockKey,
  lockPath,
  remakeLockDir,
  removeIfNotDir,
  taggedOwnerGone,
} from "./lock-dir.ts";
import { ownPidTag, PID_TAG } from "./process-liveness.ts";

/** The lock file at `path`: its exact bytes and the record they hold — for a
 *  reader that does NOT hold the lock's mutex.
 *
 *  An owner rewrites its record IN PLACE (see {@linkcode rewriteLock}), so
 *  such a reader can catch the file mid-write. A record written that way
 *  carries a check ({@linkcode sealLock}); bytes that do not pass it, or do
 *  not parse, are read again — the write is one small call, done long before
 *  the last look. Still unreadable after that: `data` null, as for a file a
 *  crash left empty. */
export function readLockAt(
  path: string,
): { raw: string | null; data: LockData | null } {
  for (let look = 0;; look++) {
    let raw: string | null = null;
    try {
      raw = Deno.readTextFileSync(path);
    } catch { /* aio-ok: no lock file — null is the answer */ }
    const data = parseLock(raw, path);
    if (raw === null || data !== null || look === TORN_REREADS) {
      return { raw, data };
    }
    pauseSync(1 << look); // 1, 2, 4, 8 ms
  }
}
/** How many times bytes that do not read as a record are read again. */
const TORN_REREADS = 4;

/** The lock file's exact bytes (as text), or null when there is no file.
 *  Every removal compares against THIS — see {@linkcode removeLockIf}. */
export function readLockRaw(key: string): string | null {
  try {
    return Deno.readTextFileSync(lockPath(key));
  } catch {
    return null;
  }
}

/** `path`: where `raw` was read — a `hold` name resolves beside it. */
export function parseLock(raw: string | null, path?: string): LockData | null {
  if (raw === null) return null;
  try {
    // A sealed record whose check does not match is a write caught half-way.
    const seal = SEAL.exec(raw);
    if (seal && sealOf(raw.slice(0, seal.index)) !== seal[1]) return null;
    const data = JSON.parse(raw) as LockData;
    // Validate the SHAPE of each field, never its truthiness.
    //
    // This used to be `if (!data.appId || !data.pid || !data.port)`, and
    // `port: 0` is falsy — while being the documented "pick a free port"
    // setting, written into the lock verbatim. A port-0 app's lock therefore
    // read back as INVALID, and every consequence compounded in the same
    // direction: `release()` guards on this returning our record, so a
    // GRACEFUL shutdown removed nothing; staleness is decided from this data,
    // so the leftover could never be recognised as stale either; and the next
    // launch refused to start, permanently, with "Already running". An app
    // bricked by its own clean exit, recoverable only by finding a file in a
    // runtime directory nobody has reason to know about.
    //
    // pid is checked as POSITIVE (no process is pid 0, and the not-ok branch
    // below synthesises `pid: 0` for "someone holds it and we can't say who" —
    // that placeholder must never validate as a real record), while port is
    // checked only for being a number, because 0 is a real port value here.
    if (typeof data.appId !== "string" || data.appId === "") return null;
    if (typeof data.pid !== "number" || !(data.pid > 0)) return null;
    if (typeof data.port !== "number" || data.port < 0) return null;
    // Only a file beside the lock, whatever path the writer saw it at (a
    // container may mount this dir elsewhere).
    if (typeof data.hold === "string") {
      data.hold = path ? join(dirname(path), basename(data.hold)) : undefined;
    }
    return data;
  } catch {
    return null;
  }
}

// ── Exclusive, atomic lock-file primitives ───────────────────
//
// The lock was NOT exclusive, and two instances opened one `state.db`
// (measured: 6 processes on a barrier, >1 holder in 11 of 15 rounds, once 3).
// Three holes, each closed here:
//
//  1. CREATE-THEN-WRITE. The file was created empty (`createNew`) and filled a
//     moment later, so a racer read an EMPTY lock, judged it "unreadable —
//     names no owner", deleted it and took the name. Now the full record is
//     written to a private tmp file and PUBLISHED with `link()`, which fails
//     with EEXIST when the name is taken: the lock file never exists without
//     its whole content. (`writeLock`'s in-place overwrite had the same hole
//     for every update; see the seal below for how an update is written.)
//  2. DELETE-BY-PATH. A reclaim judged the record at the path dead, then
//     removed WHATEVER was at the path — by then possibly a fresh lock a live
//     racer had just taken. Every removal is now compare-and-delete: under a
//     per-lock mutex, the bytes are re-read and removed only if they are
//     exactly the record that was judged.
//  3. The owner's own `update`/`release` read-then-wrote the same way; they
//     run under the same mutex.
//
// Creation needs no mutex (`link` is the exclusive step); only the steps that
// CHANGE or REMOVE an existing file take it, and they hold it for a few
// synchronous file operations. The mutex is an OS lock (`flock`/`LockFileEx`
// via `FsFile.tryLockSync`) on `<lock>.mx`, so a holder that dies releases it
// with its process — there is nothing to BREAK. It used to be a file whose
// presence was the hold, and breaking a dead holder's file (rename aside,
// compare, link back) had a window no ordering closes: while a live holder's
// file sat moved aside, the name was free, a third process published, and
// the link-back failed — two holders. See `withLockMutex` for the protocol.

export const _nonce = (): string => crypto.randomUUID().slice(0, 8);

// ── The seal: a record that is rewritten in place says when it is whole ──
//
// A lock's owner changes its record (`starting` → `started`, its socket, its
// port) by writing the new bytes OVER the old ones through a handle it keeps
// open, never by writing a new file and renaming it. The lock is published
// through a hard link (`publishExclusive`), and on Windows a rename over a
// file published that way is refused with "access denied" — measured, 2 000
// tries a cell: 1.4–4.1 % of them, clearing after 0.5–1.3 s on a quiet
// machine and not within 10 s right after an install or an update, which is
// where a desktop app's boot was refused with an 11-try, 1.3 s wait already
// in place. A rename over a file written any other way was refused 0 times
// in 20 000, and a write through an open handle 0 times in 8 000.
//
// The price is that a reader without the mutex can see the write half done.
// So such a record ends in a SEAL: 32 spaces and tabs — the 32 bits of a hash
// of the JSON before them — on a line of their own. To `JSON.parse` (and to
// every older aio that reads a lock) that is trailing whitespace. To this
// reader it is the proof the bytes are one whole record: a mix of two writes
// does not pass, and is read again ({@linkcode readLockAt}).
//
// A placeholder filed by `am` or a dev session, and anything an older aio
// wrote, carries no seal: plain `JSON.stringify` text, which its writer
// compares byte for byte. Such a record is changed in place too, the file
// emptied first ({@linkcode rewriteLock}).

/** The seal at the end of a record: its 32 marks. */
const SEAL = /\n([ \t]{32})\n$/;

/** The 32 marks for `json`: the bits of its FNV-1a hash, space = 0, tab = 1. */
function sealOf(json: string): string {
  return parseInt(hash8(json), 16).toString(2).padStart(32, "0")
    .replaceAll("0", " ").replaceAll("1", "\t");
}

/** `data` as the text an owner's own record is stored as. */
export function sealLock(data: LockData): string {
  const json = JSON.stringify(data);
  return `${json}\n${sealOf(json)}\n`;
}

/** The seal's two halves, for their test. @internal */
// aio-ok: a test seam — the product reaches both through the lock's own reads and writes
export const _seal = {
  text: sealLock,
  parse: (raw: string): LockData | null => parseLock(raw),
};

/** The file steps a test replaces (a write that fails, a platform).
 *  @internal */
export const _lockDeps = {
  /** The whole record over the old one: one write from offset 0, then the
   *  length. */
  write(f: Deno.FsFile, bytes: Uint8Array): void {
    f.seekSync(0, Deno.SeekMode.Start);
    for (let at = 0; at < bytes.length;) at += f.writeSync(bytes.subarray(at));
    f.truncateSync(bytes.length);
  },
  open: (path: string): Deno.FsFile =>
    Deno.openSync(path, { read: true, write: true }),
  windows: (): boolean => Deno.build.os === "windows",
  /** The clock and the pause of every wait in the lock dir — for a pruned
   *  dir (`_prepareLockDir`, `lockDirRemade`), for the mutex — MONOTONIC. A test hands in its
   *  own, and asserts on what was done instead of on how long it took. */
  now: (): number => performance.now(),
  pause: (ms: number): void => pauseSync(ms),
  /** {@linkcode saySlowLockDir} has said its line in this process. */
  saidSlow: false,
  /** Create a file in the lock dir (0600) — the mutex, a record's temp. */
  create: (path: string, how: Deno.OpenOptions): Deno.FsFile =>
    Deno.openSync(path, { ...how, mode: 0o600 }),
  darwin: (): boolean => Deno.build.os === "darwin",
  /** Bind a socket in the lock dir. */
  listen: listenLocal,
  /** The look at a lock dir's own entry (`_prepareLockDir`). */
  lstat: (path: string): Deno.FileInfo => Deno.lstatSync(path),
  /** What a held mutex file is, by its handle and by its path
   *  (`sameFile`) — a filesystem's answers, which a test hands in. */
  fstat: (f: Deno.FsFile): Deno.FileInfo => f.statSync(),
  stat: (path: string): Deno.FileInfo => Deno.statSync(path),
  /** The lock dirs aio itself chose (`_chooseLockDir`), beside `lockDir()`:
   *  what {@linkcode ensureLockDirOf} may make and narrow. A test adds its
   *  own temp dir. */
  chosen: new Set<string>(),
};

/** Is `e` macOS's OTHER answer to creating a file in a directory that was
 *  removed under it — a sibling's exit prune of the (momentarily empty)
 *  scoped lock dir? Every OS answers ENOENT when the directory is gone before
 *  the lookup; macOS answers EINVAL when it goes between the lookup and the
 *  create (measured, APFS on macOS 26.5: 6 processes, 5 000 rounds each of
 *  create + unlink + rmdir — 26 020 EINVAL beside 63 704 ENOENT; none
 *  without the rmdir, and ENOENT only on Linux). The directory IS gone by
 *  then, so the next try gets the plain answer. */
export function removedUnderCreate(e: unknown): boolean {
  return _lockDeps.darwin() && e instanceof Error &&
    (/\(os error 22\)/.test(e.message) ||
      (e as { code?: unknown }).code === "EINVAL"); // `node:net`'s spelling
}

/** Open the lock file at `path` to rewrite it. On Windows a process that has
 *  it open without write sharing refuses this for as long as it looks — the
 *  same bounded wait as a rename gets. (An owner does not come here: it
 *  writes through the handle it has had open since it made the file.) */
function openToRewrite(path: string): Deno.FsFile {
  for (let tries = 1;; tries++) {
    try {
      return _lockDeps.open(path);
    } catch (e) {
      const wait = _lockDeps.windows() && isHeldOpenError(e)
        ? RENAME_BACKOFF_MS[tries - 1]
        : undefined;
      if (wait === undefined) throw e;
      pauseSync(wait);
    }
  }
}

/** Change the record at `path` to `data` — the caller holds the mutex and
 *  has read `was`, the bytes there now. Returns the handle an OWNER keeps
 *  (`owner`: the caller is the lock's holder, `held` its handle so far).
 *
 *  ALWAYS in place, never a replace by rename: the file was published
 *  through a hard link ({@linkcode publishExclusive}), and on Windows a
 *  rename over such a file is refused (ACCESS_DENIED) in 1.4–4.1 % of the
 *  tries for a second or longer — measured; a write through an open handle
 *  was refused in none of 8 000. It goes through `held` when that is still
 *  the file at the path, else through a handle opened for this write (which
 *  an owner then keeps instead).
 *
 *  Sealed over a sealed record of the same process: written over it, and a
 *  reader that catches the two mixed fails the check and reads again.
 *  Anything else — a record with no seal, a dead owner's record, a writer
 *  that stores the plain bytes it compares later — has no check both sides
 *  share, so the file is EMPTIED first: a reader then sees the old record,
 *  nothing, a cut-off start of the new one (none of which parses, bar the
 *  whole new record short of its seal), or the new one — never a splice of
 *  two records that reads as a third. An owner always writes sealed. */
export function rewriteLock(
  path: string,
  was: string,
  data: LockData,
  held: Deno.FsFile | null,
  owner: boolean,
): Deno.FsFile | null {
  const over = SEAL.test(was) && parseLock(was)?.pid === data.pid;
  const text = owner || over ? sealLock(data) : JSON.stringify(data);
  const mine = held !== null && sameFile(held, path);
  const f = mine ? held : openToRewrite(path);
  try {
    if (!over) f.truncateSync(0);
    _lockDeps.write(f, new TextEncoder().encode(text));
  } catch (e) {
    if (!mine) f.close(); // the owner's own handle stays the owner's
    throw e;
  }
  if (mine) return held;
  if (!owner) {
    f.close();
    return null;
  }
  held?.close(); // open on a file that is no longer the lock
  return f;
}

/** Publish `text` at `path` only if nothing is there — never a half-written
 *  file. True on success, false if the name is taken. */
export function publishExclusive(
  path: string,
  text: string,
  /** Handed the handle the record was written through, still open — the
   *  owner keeps it for the lock's life ({@linkcode rewriteLock}). Without
   *  it the handle is closed here. */
  keep?: (f: Deno.FsFile) => void,
): boolean {
  const tmp = `${path}.${ownPidTag()}.${_nonce()}.tmp`;
  const bytes = new TextEncoder().encode(text);
  const fill = (at: string): Deno.FsFile => {
    const f = _lockDeps.create(at, {
      read: true,
      write: true,
      createNew: true,
    });
    try {
      for (let n = 0; n < bytes.length;) n += f.writeSync(bytes.subarray(n));
    } catch (e) {
      // Created here and cut short: not left behind — a temp nobody would
      // remove (and the try after a remade dir found it "already there"),
      // or half a record at the lock's own name.
      f.close();
      try {
        Deno.removeSync(at);
      } catch { /* aio-ok: gone with its directory */ }
      throw e;
    }
    return f;
  };
  /** Published: the handle goes to the owner, or is closed. */
  const done = (f: Deno.FsFile): true => {
    if (keep) keep(f);
    else f.close();
    return true;
  };
  let f: Deno.FsFile;
  let moved = false; // the lock dir was replaced under the publish: refused
  // The directory can vanish between `lockDir()` and this write: a sibling
  // app's shutdown pruned its (momentarily empty) scoped dir. Made again and
  // tried again — an ENOENT here is never "someone holds the lock" (nor is
  // macOS's EINVAL for the same thing). For as long as every other create
  // waits (`lockDirRemade`): it was ONE more try, and two prunes in a row
  // threw the raw error out of `acquire`.
  for (const since = _lockDeps.now();;) {
    try {
      const made = fill(tmp);
      // macOS: the temp can be made in a dir pruned under it — in no dir,
      // so the link below found nothing and the fallback no directory. The
      // look every other create gets (`createInLockDir`), and the same wait.
      holdLockDir(tmp, () => {
        made.close();
        removeIfNotDir(tmp);
      });
      f = made;
      break;
    } catch (e) {
      if (!lockDirRemade(tmp, e, since)) throw e;
    }
  }
  try {
    // The handle opened on the temp name IS the published file (a hard link
    // is a second name for the same file). The owner keeps one opened by the
    // lock's OWN name instead, taken while this one is still open: nobody
    // can have the file open in a way that refuses it, since their open had
    // to allow this handle's writing. Not opened: this one is kept.
    Deno.linkSync(tmp, path);
    // The record is at its name: is the dir it is in still ours?
    holdLockDir(path, () => {
      moved = true;
      removeIfNotDir(path);
    });
    if (!keep) return done(f);
    let named: Deno.FsFile;
    try {
      named = _lockDeps.open(path);
    } catch {
      return done(f); // aio-ok: the first handle is the same file — kept
    }
    f.close();
    return done(named);
  } catch (e) {
    f.close();
    if (e instanceof Deno.errors.AlreadyExists) return false;
    if (moved) throw e;
    // A filesystem without hard links: fall back to an exclusive create. The
    // content goes in with ONE write call; readers treat a short/empty file
    // as "being written" for a grace period (see `acquire`), never as dead.
    // `mode` as the tmp above has it: the record names the owner's pid,
    // cwd and home, and this branch used to create it at the umask default
    // (0644 — every local user reads it) while the link path gave 0600.
    return done(fill(path));
  } finally {
    try {
      Deno.removeSync(tmp);
    } catch { /* aio-ok: already gone */ }
  }
}

const _sleepCell = new Int32Array(new SharedArrayBuffer(4));
/** A short SYNCHRONOUS pause — the mutex holders are synchronous, so the
 *  waiters are too. */
export function pauseSync(ms: number): void {
  Atomics.wait(_sleepCell, 0, 0, ms);
}

/** How long a waiter polls for the per-lock mutex before it BLOCKS on it.
 *  Holders keep it for a few synchronous file operations, and a dead holder
 *  has already released it (the OS does), so the blocking wait only ever
 *  waits for a live holder to finish. */
export const MUTEX_WAIT_MS = 2_000;

/** Run `fn` holding the per-lock mutex: an exclusive OS lock on `<lock>.mx`.
 *
 *  The file is removed by its holder on the way out (a scoped lock dir must
 *  be able to empty), so a waiter can end up locking an inode that is no
 *  longer at the path — a file the holder unlinked after the waiter opened
 *  it. Holding THAT proves nothing; the waiter re-checks that the inode it
 *  locked is the one at the path, and starts over if not. Invariant: the
 *  only way the path's inode changes is an unlink by the current holder, so
 *  exactly one process holds the lock on the inode at the path.
 *  @internal exported for its race test only. */
export function withLockMutex<T>(key: string, fn: () => T): T {
  return withLockMutexAt(lockPath(key), fn, true)!;
}

/** {@linkcode withLockMutex} for the lock FILE at `lockFile`, in any lock dir.
 *  `recreate` false: a lock dir that is gone is NOT made again — the result
 *  is `undefined` (nothing there to judge) — for cleanups of a dir that may
 *  be being pruned. Also the build lock's mutex (build-compile.ts). */
export function withLockMutexAt<T>(
  lockFile: string,
  fn: () => T,
  recreate: boolean,
): T | undefined {
  const mx = `${lockFile}.mx`;
  // MONOTONIC: a wall-clock jump must neither stretch nor skip this wait.
  const deadline = _lockDeps.now() + MUTEX_WAIT_MS;
  let f: Deno.FsFile;
  let deniedUntil = 0; // the end of the current streak of refused opens
  for (let lost = 0;;) {
    try {
      f = _lockDeps.create(mx, { read: true, write: true, create: true });
    } catch (e) {
      // Windows: the name of a file that is being deleted — the last holder's
      // unlink, while another waiter still has it open — refuses a new open
      // (ACCESS_DENIED) until that handle closes, milliseconds later. That is
      // a holder leaving, not a failure (measured: 6 processes taking the
      // mutex 3 000 times each died on it every run). A refusal that outlasts
      // the wait is a real one, and is thrown.
      //
      // macOS: the lock dir was pruned while this create was inside it
      // (`removedUnderCreate` — 2 of 30 runs of those 6 processes died on
      // it). Asked again, the open says so plainly (NotFound, below) or
      // works; the same bound, so an EINVAL that stays is thrown, path and
      // all.
      if (
        (_lockDeps.windows() ? isHeldOpenError(e) : removedUnderCreate(e)) &&
        _lockDeps.now() < (deniedUntil ||= _lockDeps.now() + MUTEX_WAIT_MS)
      ) {
        _lockDeps.pause(1 + Math.floor(Math.random() * 3));
        continue;
      }
      // A sibling's shutdown pruned the (momentarily empty) scoped lock dir.
      if (!(e instanceof Deno.errors.NotFound)) throw e;
      if (!recreate) return undefined;
      remakeLockDir(dirname(mx));
      continue;
    }
    deniedUntil = 0;
    let locked = false;
    while (!(locked = f.tryLockSync(true)) && _lockDeps.now() < deadline) {
      _lockDeps.pause(1 + Math.floor(Math.random() * 3));
    }
    if (!locked) f.lockSync(true); // a LIVE holder: wait for it, never break
    if (sameFile(f, mx)) break;
    f.close(); // locked a file its holder already unlinked — start over
    // Each such round is another holder having come and gone, so a waiter
    // loses a handful of them. Thousands in a row is a filesystem on which
    // a file is never "the one at its path" (identities that change between
    // two looks — some FUSE and network mounts): it looped for good, hot.
    if (++lost >= MUTEX_LOST_ROUNDS) {
      throw new Error(
        `aio: cannot take the lock mutex ${mx}: after ${lost} tries the ` +
          `file locked was never the one at that path — this filesystem ` +
          `does not give a file a stable identity`,
      );
    }
  }
  try {
    return fn();
  } finally {
    // Unlink BEFORE unlocking: a waiter that locks this inode afterwards
    // sees it is no longer at the path and retries (see above).
    unlinkHeldMutex(f, mx);
    f.close();
  }
}

/** How many times in a row a waiter may lock a file that is not (any longer)
 *  the mutex before it gives up — see `withLockMutexAt`. */
const MUTEX_LOST_ROUNDS = 1_000;

/** Is the file open as `f` the one at `path` right now? */
export function sameFile(f: Deno.FsFile, path: string): boolean {
  let at: Deno.FileInfo;
  try {
    at = _lockDeps.stat(path);
  } catch {
    return false; // aio-ok: unlinked since we opened it — not the mutex
  }
  const mine = _lockDeps.fstat(f);
  // A file with no name left is at no path — asked of the HANDLE, which is
  // exact. The numbers below are not, on Windows: a file id is 64 bits (16
  // of sequence over 48 of record) and arrives as a JS number, 53 — two
  // files in neighbouring records read as one. A waiter that locked the
  // mutex file its holder had just unlinked then took the NEW file at the
  // path for its own, and two processes were inside (measured, Windows 11,
  // 3 × 6 processes × 3 000 rounds: a clash in 8 of 39 runs; every OS says
  // 0 links for an unlinked file that is still open).
  //
  // Unless the file AT the path has no links either: it has a name, so a
  // count of 0 there is a filesystem that does not count links at all (some
  // FUSE mounts — a project dir, for `pid-lock.ts`), and 0 on the handle is
  // then no evidence. Every live mutex read as unlinked there, forever.
  if (mine.nlink === 0 && at.nlink !== 0) return false;
  // No file identity on this filesystem: the mutex file is then never
  // unlinked (`unlinkHeldMutex`), so the path cannot have moved under us.
  if (mine.ino === null || at.ino === null) return true;
  return mine.ino === at.ino && mine.dev === at.dev;
}

/** May a HELD mutex file be unlinked? Only where files have an identity the
 *  waiters' `sameFile` check can compare — every platform aio runs on
 *  (Windows included: measured on Deno 2.9.6, `ino` is set and an open,
 *  locked file unlinks with POSIX semantics). Without one the file stays:
 *  correctness over a tidy directory. Pure. */
export function mayUnlinkMutex(info: { ino: number | null }): boolean {
  return info.ino !== null;
}

/** Unlink the mutex file `f` (locked by us, verified at `path`). */
function unlinkHeldMutex(f: Deno.FsFile, path: string): void {
  if (!mayUnlinkMutex(f.statSync())) return;
  try {
    Deno.removeSync(path);
  } catch { /* aio-ok: already gone — the lock releases when f closes */ }
}

/** Remove a mutex file nobody holds — the one a process SIGKILLed inside the
 *  mutex leaves behind (no pid in its name, so the temp sweep cannot judge
 *  it, and it keeps a scoped lock dir from ever being pruned). Taken through
 *  the SAME protocol as a holder's exit: lock it without waiting, confirm it
 *  is the file at the path, unlink, unlock. Held by anyone → left alone. */
export function dropIdleMutex(path: string): void {
  let f: Deno.FsFile;
  try {
    f = Deno.openSync(path, { read: true, write: true });
  } catch {
    return; // aio-ok: no mutex file — nothing to drop
  }
  try {
    if (f.tryLockSync(true) && sameFile(f, path)) unlinkHeldMutex(f, path);
  } finally {
    f.close();
  }
}

/** The private files the steps above leave for a moment — `<lock>.<pid>.
 *  <nonce>.tmp` (publish/replace) and the `<lock>.mx` mutex file — outlive a
 *  process killed mid-step. Nothing else ever removes them, they pile up,
 *  and they keep the scoped lock dir from being pruned. Swept at acquire: a
 *  temp ONLY when the pid in its name is gone (a live process's file is part
 *  of an operation it is still running), the mutex only when nobody holds
 *  it (`dropIdleMutex`). */
const ORPHAN_TEMP = new RegExp(`^\\.${PID_TAG}\\.[0-9a-f]{8}\\.tmp$`);
export function sweepOrphanLockTemps(key: string): void {
  const base = `${key}.lock`;
  let names: string[];
  try {
    names = [...Deno.readDirSync(lockDir())]
      .filter((e) => e.isFile && e.name.startsWith(base))
      .map((e) => e.name);
  } catch {
    return; // aio-ok: no lock dir yet — nothing to sweep
  }
  for (const name of names) {
    const rest = name.slice(base.length);
    if (rest === ".mx" || rest.endsWith(".hold")) {
      // An unheld hold file is a dead owner's: same protocol as the mutex.
      dropIdleMutex(join(lockDir(), name));
      continue;
    }
    const m = ORPHAN_TEMP.exec(rest);
    if (!m) continue;
    const pid = Number(m[1]);
    if (
      pid === Deno.pid || !taggedOwnerGone(join(lockDir(), name), pid, m[2])
    ) {
      continue;
    }
    try {
      Deno.removeSync(join(lockDir(), name));
    } catch { /* aio-ok: a sibling swept it first */ }
  }
}

/** Remove the lock at `key` only if its bytes are still exactly `judged` —
 *  the record the caller decided was dead/stale/ours. True when removed. */
export function removeLockIf(key: string, judged: string): boolean {
  return removeLockFileIf(lockPath(key), judged, true);
}

/** {@linkcode removeLockIf} for the lock FILE at `path`, in any lock dir.
 *  @internal */
export function removeLockFileIf(
  path: string,
  judged: string,
  recreate = false,
  /** Wait out a Windows process that has the file open (`removeOverSync`),
   *  and THROW when it is still there at the bound — the owner's own release
   *  asks for this. A reclaim does not: its caller's loop is the retry. */
  wait = false,
): boolean {
  return withLockMutexAt(path, () => {
    let now: string | null = null;
    try {
      now = Deno.readTextFileSync(path);
    } catch { /* aio-ok: gone — nothing to remove */ }
    if (now !== judged) return false;
    if (wait) return removeOverSync(path);
    try {
      _renameDeps.remove(path); // the OS step `removeOverSync` takes too
      return true;
    } catch {
      return false; // aio-ok: removed meanwhile, or held — the caller's loop looks again
    }
  }, recreate) ?? false;
}

/** Beside the lock: "the instance this lock names quit CLEANLY and could not
 *  remove it". A lock whose owner is gone otherwise means a crash, and the
 *  next start says so — which would be false here. Holds the lock's bytes. */
export function quitMarkPath(key: string): string {
  return join(lockDir(), `${key}.quit`);
}

/** Is the dead owner's lock `raw` one its owner tried to remove on a clean
 *  quit? The mark is consumed either way. */
export function takeQuitMark(key: string, raw: string): boolean {
  const path = quitMarkPath(key);
  let mark: string | null = null;
  try {
    mark = Deno.readTextFileSync(path);
    Deno.removeSync(path);
  } catch { /* aio-ok: no mark — the owner did not quit cleanly */ }
  return mark === raw;
}

/** Remove the lock at `key` only if it still names the owner that was judged
 *  dead — the same pid, and the same start token when both carry one. A
 *  caller that holds only the PARSED record (`am`'s `pf`) uses this: deleting
 *  "whatever is at the path" removed a re-booted instance's LIVE lock, and a
 *  second instance then opened the same state.db. */
export function removeLockIfOwner(
  key: string,
  owner: Pick<LockData, "pid" | "startToken" | "startEpoch">,
): boolean {
  return withLockMutex(key, () => {
    const now = parseLock(readLockRaw(key));
    if (!now || now.pid !== owner.pid) return false;
    if (
      owner.startToken && now.startToken && owner.startToken !== now.startToken
    ) {
      return false;
    }
    if (
      owner.startEpoch !== undefined && now.startEpoch !== undefined &&
      owner.startEpoch !== now.startEpoch
    ) return false;
    try {
      removeOverSync(lockPath(key));
      return true; // removed, or removed meanwhile — the goal holds
    } catch (e) {
      log.warn(
        "lock",
        `${printable(lockPath(key))} could not be removed (${
          e instanceof Error ? e.message : String(e)
        }) — the next start reclaims it`,
      );
      return false;
    }
  });
}

/** Write lock file — created whole if none is there, else written over in
 *  place ({@linkcode rewriteLock}: a reader never takes a half-written file
 *  for a record), under the lock's mutex.
 *  @decider */
export function writeLock(data: LockData): void {
  const key = lockKey(data.appId, data.home, data.profile);
  withLockMutex(key, () => {
    const path = lockPath(key);
    const was = readLockRaw(key);
    if (was === null && publishExclusive(path, JSON.stringify(data))) return;
    // There, or filed in the instant since the read: written over.
    rewriteLock(path, was ?? readLockRaw(key) ?? "", data, null, false);
  });
}

/** Compare-and-swap for `am`'s own lock writes (the placeholder, the
 *  "stopping" mark and its undo, a status self-repair). They held only the
 *  PARSED record they read, and wrote over whatever sat at the path by then —
 *  a re-booted instance's live lock became a stale-looking copy of the old
 *  one, the next reader reclaimed it, and a second instance opened the same
 *  state.db.
 *
 *  `expected === null`: write only while NO lock is there (create-new).
 *  Otherwise the current record must still name the owner read — same pid,
 *  and the same start identity when both carry one ({@linkcode sameRecord})
 *  — and `next` is applied to the CURRENT record, so what the owner wrote
 *  since (its status, its bound port, its socket) is kept. Under the key's mutex. True when
 *  written; false = the lock changed, nothing written — the caller says so.
 *  @decider */
export function replaceLockIf(
  expected: LockData | null,
  next: LockData | ((now: LockData) => LockData),
): boolean {
  const ref = expected ?? (typeof next === "function" ? null : next);
  if (!ref) return false;
  const key = lockKey(ref.appId, ref.home, ref.profile);
  return withLockMutex(key, () => {
    const path = lockPath(key);
    if (expected === null) {
      // Create-new IS the compare: the link fails while any lock is there.
      if (typeof next === "function") return false;
      return publishExclusive(path, JSON.stringify(next));
    }
    const was = readLockRaw(key);
    const now = parseLock(was);
    if (!now || !sameRecord(expected, now)) return false;
    const data = typeof next === "function" ? next(now) : next;
    rewriteLock(path, was!, data, null, false);
    return true;
  }) ?? false;
}

/** Is `now` still written by the OWNER `was` names — same pid, and the same
 *  start identity when both carry one? Pure.
 *
 *  Identity only, never `status`/`startedAt`: a booting app rewrites its own
 *  lock (`starting` → `started`, its own `startedAt` over `am start`'s
 *  placeholder), and comparing those made `am stop` on an app that finished
 *  booting mid-command answer "lock changed — nothing was stopped" about the
 *  very process it meant, `am stop --all` skip it, and `am restart` exit 1.
 *  A changed record of the SAME owner is not a race to refuse: `next` is
 *  applied to that current record. */
function sameRecord(was: LockData, now: LockData): boolean {
  if (now.pid !== was.pid) return false;
  // Pid 7 in two containers sharing the lock dir is two owners.
  if (was.ns !== undefined && now.ns !== undefined && was.ns !== now.ns) {
    return false;
  }
  if (was.startToken && now.startToken && was.startToken !== now.startToken) {
    return false;
  }
  return !(typeof was.startEpoch === "number" &&
    typeof now.startEpoch === "number" && was.startEpoch !== now.startEpoch);
}

/** Atomic create-new lock file — returns false if file already exists (race-safe) */
export function tryCreateLock(
  data: LockData,
  /** The owner's: it gets the open handle, and the record is sealed. */
  keep: (f: Deno.FsFile) => void,
): boolean {
  const path = lockPath(lockKey(data.appId, data.home, data.profile));
  try {
    return publishExclusive(path, sealLock(data), keep);
  } catch (e) {
    // `false` means ONE thing: the file is already there, so another process
    // won the race. It used to mean "anything went wrong", and the caller
    // renders that as `[AIO] Already running` + exit 1 — which for a lock dir
    // that cannot be written is a lie about a machine problem, after a 3-second
    // retry loop looking for an owner that does not exist (measured: 3041 ms,
    // then "Already running: probe-app", pid 0).
    //
    // The triggers are ordinary: a read-only or full /tmp, `/tmp/aio` owned by
    // another uid when XDG_RUNTIME_DIR is unset (Docker, ssh without logind,
    // cron), SELinux. In every one of them the app cannot boot and the message
    // sends the operator to look for a process.
    if (e instanceof Deno.errors.AlreadyExists) return false;
    throw new Error(
      `cannot write the single-instance lock ${path}: ${
        e instanceof Error ? e.message : String(e)
      }\n` +
        `  This is not "already running" — the lock DIRECTORY is unusable ` +
        `(read-only or full filesystem, owned by another user, or blocked by ` +
        `SELinux/AppArmor).\n` +
        `  fix: make ${dirname(path)} writable by this user, or point the ` +
        `lock dir somewhere writable with XDG_RUNTIME_DIR=… (or AIO_APPS_DIR=… ` +
        `to scope the whole instance).`,
      { cause: e },
    );
  }
}

/** Milliseconds since a wall-clock stamp — and a stamp from the FUTURE is
 *  OLD, not young. The wall clock jumps back (NTP step, a restored VM
 *  snapshot, a hand-set clock), and a file written before the jump then
 *  carries a time "after now": read as young, an unreadable lock was never
 *  reclaimed and the app refused to start, "already running (pid 0)",
 *  forever. A second of slack covers coarse filesystem timestamps. */
export function ageSince(t: number): number {
  const age = Date.now() - t;
  return age < -1_000 ? Infinity : age;
}

/** Milliseconds since the lock file was last modified — Infinity when the
 *  platform reports no mtime (then nothing but the content can judge it), 0
 *  when the file is gone. */
export function lockAgeMs(key: string): number {
  try {
    const m = Deno.statSync(lockPath(key)).mtime;
    return m ? ageSince(m.getTime()) : Infinity;
  } catch {
    return 0;
  }
}

/** Remove a lock file by its key (the plain appId for a default-home app).
 *  Unconditional, so no product path calls it — test fixtures only. Every
 *  removal aio makes compares first ({@linkcode removeLockIf},
 *  {@linkcode removeLockIfOwner}): by the time a lock is judged dead, a new
 *  instance may hold the same name. */
// aio-ok: test fixtures' cleanup — no product path may delete unconditionally
export function removeLock(key: string): void {
  withLockMutex(key, () => {
    try {
      Deno.removeSync(lockPath(key));
    } catch { /* aio-ok: already gone — the removal's goal holds */ }
  });
}

/** Is this lock a MAINTENANCE hold (`am backup` / `am restore`), not an app?
 *  THE one predicate — acquire, the signal handler, every `am` verb and the
 *  dead-owner warning ask it, so they cannot disagree. ANY present value
 *  counts: a malformed one (`"yes"`, a hand edit, a future shape) is a hold
 *  of an unknown op, never an app to probe or kill. Pure. */
export function isHold(
  lock: { maintenance?: unknown } | null | undefined,
): boolean {
  const m = lock?.maintenance;
  return m !== undefined && m !== null && m !== false;
}

/** The invisible-or-reordering characters beyond C0/DEL/C1, as escapes in a
 *  STRING: `deno fmt` rewrites unicode escapes in a regex literal into the
 *  invisible characters themselves. */
const UNSEEN = "\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff";
const CTRL_FIELD = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${UNSEEN}]`, "g");
const CTRL_TEXT = new RegExp(
  `\\x1b\\[[0-9;]*m|[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f${UNSEEN}]`,
  "g",
);
/** The SGR codes `diagnostics/fmt.ts` emits, one parameter each. */
// deno-lint-ignore no-control-regex
const SGR_OK = new RegExp("^\\x1b\\[(?:0|1|2|4|22|24|39|3[0-7]|9[0-7])?m$");

/** USER DATA as it may reach a TERMINAL (an app's state, its logs, an eval
 *  result, surface text) — the opposite trade to {@linkcode printable}:
 *  everything that DISPLAYS stays byte-exact — ZWJ emoji, ZWNJ, LRM/RLM,
 *  a BOM, `\r`, every SGR colour (256 and truecolor included) — and only
 *  what a terminal would EXECUTE goes: OSC (titles, hyperlinks, clipboard),
 *  every non-SGR CSI (cursor moves, erase), other ESC sequences, C1 controls
 *  and the C0 controls a display has no use for (BEL, BS, …). Removed, not
 *  replaced: a log's `\x1b[K` is noise, not a warning sign. Never applied
 *  when the output is not a terminal — piped data is passed through as is.
 *  Pure. */
const EXEC_SEQ = new RegExp(
  "\\x1b\\[[0-?]*[ -/]*[@-~]|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)?|" +
    "\\x1b[PX^_][^\\x1b]*(?:\\x1b\\\\)?|\\x1b[ -~]?|" +
    "[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1a\\x1c-\\x1f\\x7f-\\x9f]",
  "g",
);
// deno-lint-ignore no-control-regex
const SGR_ANY = new RegExp("^\\x1b\\[[0-9;:]*m$");
export function terminalSafe(s: string): string {
  return s.replace(EXEC_SEQ, (m) => SGR_ANY.test(m) ? m : "");
}

/** Text as it may be PRINTED to a terminal — THE one helper. Lock files (and
 *  anything else read from disk) are writable by anything running as the
 *  user, and what is planted in one must not reach the operator's terminal
 *  from `am status`, a refusal, a warning:
 *  - control characters (C0, DEL, C1): an escape (`\x1b[2J`, an OSC title or
 *    hyperlink), a CSI via C1 `\x9b`, a `\r` that overwrites the line;
 *  - bidi controls (U+202A–202E, U+2066–2069): text that DISPLAYS in another
 *    order than it reads (a path that shows as a different path);
 *  - zero-width characters (U+200B–200F, U+FEFF): two names that look alike.
 *  Each becomes `?`.
 *
 *  Applied at PRINT, never at parse: a lock's `home`/`cwd`/`socketPath` are
 *  IDENTITY — the lock key is derived from `home` — and "cleaning" them on
 *  read filed a self-repair under a second key (two lock files, one app
 *  "running from 2 data homes").
 *
 *  `text: false` (a single field): all of the above.
 *  `text: true` (a whole message): `\n` and `\t` are kept, and so are the
 *  SGR codes aio's own styling emits — exactly those ({@linkcode SGR_OK}:
 *  reset, bold, dim, underline and their resets, the 8+8 foreground colours).
 *  Any other escape (conceal (SGR 8), a cursor move) is replaced. Pure. */
export function printable(s: string, text = false): string {
  return text
    ? s.replace(CTRL_TEXT, (m) => m.length > 1 && SGR_OK.test(m) ? m : "?")
    : s.replace(CTRL_FIELD, "?");
}

/** Before a DEAD maintenance holder's lock is removed — by any cleanup:
 *  a boot, `am start`, `am status`, `am instances` — say which op was killed
 *  and what it left. Cleaning the lock up silently was how a restore killed
 *  mid-swap ended in an app booting on an empty data/ with no word of why.
 *  An app's dead lock stays as it was (the boot alone warns about that). */
export function noteDeadHolder(lock: LockData): void {
  if (isHold(lock)) log.warn("lock", deadOwnerWarning(lock.appId, lock));
}

/** What a boot says when it reclaims the lock of a DEAD owner. Pure.
 *
 *  An app that died may have lost its last debounced writes — that is the
 *  warning. A dead MAINTENANCE holder (`am backup` / `am restore` killed
 *  mid-run) was never the app: it held no app state, and blaming "the
 *  previous run" of the app for lost writes sent the reader after a data
 *  loss that did not happen. It says what the op leaves instead.
 *  @internal exported for its test only. */
export function deadOwnerWarning(
  appId: string,
  existing: Pick<LockData, "pid" | "maintenance">,
): string {
  const m = existing.maintenance as unknown;
  appId = printable(appId); // may come from a lock file — printed below
  if (isHold(existing)) {
    const rec = typeof m === "object" ? m as Record<string, unknown> : {};
    const op = typeof rec.op === "string" && rec.op ? printable(rec.op) : "am";
    const left = typeof rec.partial === "string" && rec.partial
      ? ` It left ${printable(rec.partial)} — possibly incomplete, never the ` +
        `live data; delete it when you no longer need it.`
      : "";
    return `${op} (pid ${existing.pid}) was killed before it finished — it ` +
      `was not "${appId}" running, so no app state was lost. ` +
      (/restore/.test(op)
        ? `data/ holds the old data or the restored copy — unless it died ` +
          `between the swap's two renames, when data/ is missing and the ` +
          `previous data is in data.replaced-*.`
        : `data/ was only being read.`) +
      left;
  }
  return `the previous run of "${appId}" (pid ${existing.pid}) did not ` +
    `shut down cleanly — a graceful stop removes its lock, so that ` +
    `process was killed, crashed, or lost power. Persistence is ` +
    `debounced: state committed inside the last window is replayed on ` +
    `boot only with \`journal: true\`, and is otherwise gone. ` +
    `See docs/persistence/auto-persist.md`;
}
