// The look at the lock dir AFTER a create comes after the file is there.
//
// Deno has no `openat`, so the dir is judged, and after something was created
// in it its entry is looked at again: still the one that was judged? Two ways
// that look said "fine" about a dir that was not:
//
// - the PEER listener (the production local-peer lockdown) binds later, after
//   an import — the look was made when `listenLocal` returned, before any
//   socket existed, and a dir replaced before the bind was never seen;
// - a dir that is GONE read as "pruned, so empty". Right before anything is in
//   it; after a successful create our file is in it, a prune (rmdir) cannot
//   have removed it, and the name was taken away with the file behind it.
//
// Except on macOS, where a prune CAN: a create (a bind) that races the rmdir
// of its dir succeeds, and what it made is in no directory (measured on APFS,
// macOS 26.5: 24 of 60 000 creates, 6 of 90 000 binds; Linux: 0). There the
// dir is made again and the create tried again, for as long as any pruned dir
// is waited for — a start failed because a sibling quit — and refused after.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { selfUid } from "../src/server/dir-permissions.ts";
import {
  _lockDeps,
  createInLockDir,
  listenInLockDir,
} from "../src/server/single-instance-lock.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

// The second look reads the entry's identity and owner: Windows has neither,
// and binds a pipe name, which is no file in the dir.
const UID = Deno.build.os !== "windows" && selfUid() !== null;
const NotFound = Deno.errors.NotFound;
const exists = (p: string): boolean => {
  try {
    Deno.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

Deno.test({
  name:
    "socket in the lock dir: the peer listener's dir is looked at once its socket IS bound — replaced before the bind, it is refused",
  ignore: !UID,
  sanitizeOps: false, // aio-ok: `node:net` (the peer listener) keeps its own handles
  sanitizeResources: false, // aio-ok: the same `node:net` handles
  async fn() {
    const root = await tempDir("aio-held-bind-");
    const dir = join(root, "locks");
    const path = join(dir, "a.sock");
    _lockDeps.chosen.add(dir);
    const real = { ..._lockDeps };
    try {
      // The control: nothing replaced, the listener binds and is kept.
      const kept = listenInLockDir(path, true);
      const it = kept[Symbol.asyncIterator]();
      const first = it.next();
      for (const end = Date.now() + 10_000; !exists(path);) {
        if (Date.now() > end) throw new Error("no socket within 10 s");
        await new Promise((r) => setTimeout(r, 5));
      }
      kept.close();
      await first;
      try {
        Deno.removeSync(path);
      } catch { /* aio-ok: the listener's close removed it */ }
      // Somebody else's dir at the name by the time the socket is in it —
      // which is AFTER `listenInLockDir` returned.
      let looksAtSocket = 0;
      _lockDeps.lstat = (p) => {
        const at = real.lstat(p);
        if (p !== dir || !exists(path)) return at;
        looksAtSocket++;
        return { ...at, ino: (at.ino ?? 0) + 1, uid: selfUid()! + 1 };
      };
      const l = listenInLockDir(path, true); // returns: nothing bound yet
      // Bounded: a listener that is KEPT never ends its first `next()`.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const e = await assertRejects(
        () =>
          Promise.race([
            l[Symbol.asyncIterator]().next(),
            new Promise((_, no) => {
              timer = setTimeout(() => {
                l.close();
                no(new Error("bound, kept, and accepting after 10 s"));
              }, 10_000);
            }),
          ]),
        Error,
        "was replaced while",
      ).finally(() => clearTimeout(timer));
      assertStringIncludes(e.message, `owned by uid ${selfUid()! + 1}`);
      assertEquals(looksAtSocket, 1, "one look, with the socket there");
      assert(!exists(path), "the socket bound in a dir not ours was left");
      l.close();
    } finally {
      Object.assign(_lockDeps, real);
      _lockDeps.chosen.delete(dir);
      await new Promise((r) => setTimeout(r, 20)); // the server's close
      await dropTempDir(root);
    }
  },
});

Deno.test({
  name:
    "create in the lock dir: a dir that is GONE right after a successful create was replaced, not pruned",
  ignore: !UID,
  async fn() {
    const root = await tempDir("aio-held-gone-");
    const dir = join(root, "locks");
    const path = join(dir, "watch-1.tmp");
    _lockDeps.chosen.add(dir);
    const real = { ..._lockDeps };
    try {
      let created = false;
      let undone = 0;
      // Every OS but macOS: no create succeeds in a dir that is removed.
      _lockDeps.darwin = () => false;
      _lockDeps.lstat = (p) => {
        if (p === dir && created) {
          throw new NotFound(`No such file or directory: ${p}`);
        }
        return real.lstat(p);
      };
      let tries = 0;
      const e = assertThrows(
        () =>
          createInLockDir(path, () => {
            tries++;
            const f = Deno.openSync(path, { createNew: true, write: true });
            created = true;
            return f;
          }, (f) => {
            undone++;
            f.close();
          }),
        Error,
        "is no longer there",
      );
      assertStringIncludes(e.message, "was replaced while");
      assertEquals([tries, undone], [1, 1], "refused: no retry, and undone");
      assert(!exists(path), "what was made is removed");
    } finally {
      Object.assign(_lockDeps, real);
      _lockDeps.chosen.delete(dir);
      await dropTempDir(root);
    }
  },
});

Deno.test({
  name:
    "create in the lock dir, macOS: a dir GONE right after a successful create was pruned under it — made and tried again; one that stays gone is refused",
  ignore: !UID,
  async fn() {
    const root = await tempDir("aio-held-pruned-");
    const dir = join(root, "locks");
    const path = join(dir, "watch-1.tmp");
    _lockDeps.chosen.add(dir);
    const real = { ..._lockDeps };
    try {
      _lockDeps.darwin = () => true;
      // The wait is counted in pauses, not in this machine's time.
      let clock = 0;
      _lockDeps.now = () => clock;
      _lockDeps.pause = (ms) => void (clock += ms);
      // What macOS does: the create returns, and its file is in no dir.
      let gone = 1;
      let looks = 0;
      _lockDeps.lstat = (p) => {
        if (p === dir && exists(path) && looks++ < gone) {
          Deno.removeSync(path);
          Deno.removeSync(dir);
        }
        return real.lstat(p);
      };
      let tries = 0;
      let undone = 0;
      const make = () =>
        createInLockDir(path, () => {
          tries++;
          return Deno.openSync(path, { createNew: true, write: true });
        }, (f) => {
          undone++;
          f.close();
        });
      make().close();
      assertEquals([tries, undone], [2, 1], "the first is closed, one more");
      assert(exists(path), "the file is in the dir that was made again");
      Deno.removeSync(path);

      // Gone after EVERY create: not a prune any more — refused, in the same
      // words, once the wait every pruned dir gets is over.
      [gone, looks, tries, undone, clock] = [Infinity, 0, 0, 0, 0];
      const e = assertThrows(make, Error, "is no longer there");
      assertStringIncludes(e.message, "was replaced while");
      assertStringIncludes(e.message, path);
      assert(tries > 2 && undone === tries, `${tries} tries, each undone`);
      assert(clock > 2_000 && clock < 2_100, `the mutex's wait: ${clock} ms`);
      assert(!exists(path), "nothing is left");
    } finally {
      Object.assign(_lockDeps, real);
      _lockDeps.chosen.delete(dir);
      await dropTempDir(root);
    }
  },
});

Deno.test({
  name:
    "socket in the lock dir, macOS: the peer listener's dir GONE right after its bind was pruned under it — bound again, and kept",
  ignore: !UID,
  sanitizeOps: false, // aio-ok: `node:net` (the peer listener) keeps its own handles
  sanitizeResources: false, // aio-ok: the same `node:net` handles
  async fn() {
    const root = await tempDir("aio-held-rebind-");
    const dir = join(root, "locks");
    const path = join(dir, "a.sock");
    _lockDeps.chosen.add(dir);
    const real = { ..._lockDeps };
    try {
      _lockDeps.darwin = () => true;
      let looks = 0;
      _lockDeps.lstat = (p) => {
        if (p === dir && exists(path) && looks++ === 0) {
          Deno.removeSync(path);
          Deno.removeSync(dir);
        }
        return real.lstat(p);
      };
      const l = listenInLockDir(path, true);
      // A listener that is kept never ends its first `next()`; one that is
      // refused ends it with the refusal.
      const first = l[Symbol.asyncIterator]().next();
      let refusal: unknown;
      first.catch((e) => refusal = e);
      for (const end = Date.now() + 10_000; looks < 2 || !exists(path);) {
        if (refusal) throw refusal;
        if (Date.now() > end) throw new Error("not bound again within 10 s");
        await new Promise((r) => setTimeout(r, 5));
      }
      assertEquals(looks, 2, "looked at after each bind");
      const c = await Deno.connect({ transport: "unix", path });
      c.close();
      assertEquals((await first).done, false, "and it accepts");
      l.close();
    } finally {
      Object.assign(_lockDeps, real);
      _lockDeps.chosen.delete(dir);
      await new Promise((r) => setTimeout(r, 20)); // the server's close
      await dropTempDir(root);
    }
  },
});
