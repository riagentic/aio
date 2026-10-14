// "Is the file I locked the one at the path?" — the mutex's one question,
// asked of a filesystem whose answers a test hands in.
//
// The holder unlinks the mutex file on its way out, so a waiter can lock a
// file that is no longer at the path; it must see that and start over.
// - Windows: a file id is 64 bits and arrives as a JS number — two files in
//   neighbouring records read as ONE. The waiter then took the NEW file at
//   the path for the unlinked one it had locked: two processes inside
//   (measured: a clash in 8 of 39 runs of 3 × 6 processes). What is exact is
//   the HANDLE's link count: 0 for a file with no name left. Only a Windows
//   load run held that; here the colliding numbers are handed in.
// - A filesystem that counts no links (some FUSE mounts) says 0 for a live
//   file too: every mutex read as unlinked, forever, in a hot loop.
// - One on which a file never is "the one at its path" ends in an error that
//   names the path, not in that loop.
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  _lockDeps,
  lockPath,
  withLockMutexAt,
} from "../src/server/single-instance-lock.ts";

const id = (name: string) =>
  `mx-same-${name}-${crypto.randomUUID().slice(0, 8)}`;

Deno.test("lock mutex: a locked file with no name left is not the mutex, whatever its number says", () => {
  const lock = lockPath(id("collide"));
  const mx = `${lock}.mx`;
  const real = { ..._lockDeps };
  let creates = 0;
  let holder: Deno.FsFile | null = null; // the NEW file's holder, still inside
  let stale: Deno.FsFile | null = null;
  try {
    _lockDeps.create = (path, how) => {
      if (path !== mx) return real.create(path, how);
      if (++creates === 1) {
        // The waiter opens the mutex file; its holder unlinks it and leaves,
        // and the next holder makes a new file at the path and locks it.
        stale = real.create(path, how);
        Deno.removeSync(mx);
        holder = real.create(mx, { read: true, write: true, createNew: true });
        assert(holder.tryLockSync(true));
        return stale;
      }
      // Asked again: by now the holder is done.
      holder!.close();
      holder = null;
      return real.create(path, how);
    };
    // The collision: the unlinked file reads as the number of the new one.
    _lockDeps.fstat = (f) =>
      f === stale
        ? { ...real.fstat(f), ino: Deno.statSync(mx).ino }
        : real.fstat(f);
    const inside = withLockMutexAt(lock, () => holder === null, true);
    assertEquals(creates, 2, "the unlinked file was taken for the mutex");
    assertEquals(inside, true, "two were inside the mutex at once");
  } finally {
    Object.assign(_lockDeps, real);
    (holder as Deno.FsFile | null)?.close();
    try {
      Deno.removeSync(mx);
    } catch { /* removed by the mutex's own exit */ }
  }
});

Deno.test("lock mutex: on a filesystem that counts no links a live mutex file is still the mutex", () => {
  const lock = lockPath(id("nolinks"));
  const real = { ..._lockDeps };
  let rounds = 0;
  try {
    _lockDeps.fstat = (f) => ({ ...real.fstat(f), nlink: 0 });
    _lockDeps.stat = (p) => ({ ...real.stat(p), nlink: 0 });
    _lockDeps.create = (path, how) => {
      // It looped for good: ended here, so the test fails instead of hanging.
      if (path.endsWith(".mx") && ++rounds > 50) throw new Error("looping");
      return real.create(path, how);
    };
    assertEquals(withLockMutexAt(lock, () => "inside", true), "inside");
    assertEquals(rounds, 1);
  } finally {
    Object.assign(_lockDeps, real);
  }
});

Deno.test("lock mutex: a file that is never the one at its path ends in an error naming the path", () => {
  const lock = lockPath(id("unstable"));
  const real = { ..._lockDeps };
  let rounds = 0;
  try {
    // An identity that changes between two looks. (Not `ino + 1`: a Windows
    // file id is past 2^53, where that is the same number.)
    _lockDeps.fstat = (f) => {
      const at = real.fstat(f);
      return { ...at, ino: at.ino === 1 ? 2 : 1 };
    };
    _lockDeps.create = (path, how) => {
      if (path.endsWith(".mx") && ++rounds > 5_000) throw new Error("looping");
      return real.create(path, how);
    };
    const e = assertThrows(
      () => withLockMutexAt(lock, () => "inside", true),
      Error,
      "stable identity",
    );
    assert(e.message.includes(`${lock}.mx`), e.message);
    assertEquals(rounds, 1_000);
  } finally {
    Object.assign(_lockDeps, real);
    try {
      Deno.removeSync(`${lock}.mx`);
    } catch { /* none left */ }
  }
});

// Windows refuses to open a NAME whose file is being deleted (the last
// holder's unlink, while another waiter still has it open) until that handle
// closes — a holder leaving, not a failure. Six processes taking the mutex
// 3 000 times each died on it every run before it was waited out.
Deno.test("lock mutex: Windows's ACCESS_DENIED on a file being deleted is waited out — to the bound, and only there", () => {
  const real = { ..._lockDeps };
  const refuse = (times: number, tries: { n: number }) => {
    _lockDeps.create = (path, how) => {
      if (!path.endsWith(".mx") || ++tries.n > times) {
        return real.create(path, how);
      }
      throw new Deno.errors.PermissionDenied(
        `Access is denied. (os error 5): open '${path}'`,
      );
    };
  };
  try {
    _lockDeps.windows = () => true;
    const waited = { n: 0 };
    refuse(3, waited);
    assertEquals(
      withLockMutexAt(lockPath(id("win")), () => "inside", true),
      "inside",
    );
    assertEquals(waited.n, 4, "three refusals, then the open that worked");
    // One that stays is a real refusal: thrown at the bound, path and all.
    const lock = lockPath(id("win-stays"));
    refuse(Infinity, { n: 0 });
    const t0 = performance.now();
    const e = assertThrows(
      () => withLockMutexAt(lock, () => "inside", true),
      Deno.errors.PermissionDenied,
    );
    const took = performance.now() - t0;
    assert(e.message.includes(`${lock}.mx`), e.message);
    assert(took >= 1_900 && took < 10_000, `gave up after ${took} ms`);
    // Anywhere else a refused open is one: at once.
    _lockDeps.windows = () => false;
    const other = { n: 0 };
    refuse(Infinity, other);
    assertThrows(
      () => withLockMutexAt(lockPath(id("posix")), () => "inside", true),
      Deno.errors.PermissionDenied,
    );
    assertEquals(other.n, 1);
  } finally {
    Object.assign(_lockDeps, real);
  }
});
