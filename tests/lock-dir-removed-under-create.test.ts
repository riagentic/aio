// A lock dir pruned UNDER a create is the pruned-dir case on macOS too.
//
// A scoped lock dir is removed by whoever leaves it empty, so a file created
// in it can find it gone. Every OS answers that with ENOENT, and the lock
// code makes the dir again. macOS has a second answer: EINVAL, when the dir
// goes between the path lookup and the create (measured, APFS: 6 processes,
// 5 000 rounds each of create + unlink + rmdir — 26 020 EINVAL beside 63 704
// ENOENT; Linux, ENOENT only). It was not caught: `lock mutex: 6 processes`
// (single-instance-lock-mutex.test.ts) died on it in 2 of 30 runs on a Mac,
// and in an app the same throw is a start that fails because a sibling quit.
//
// That race is the real proof and only a Mac runs it; here the answer is
// handed in, so every OS holds the rule — and its bound: an EINVAL that
// stays is thrown, naming the path.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { dirname, join } from "@std/path";
import { connectLocal } from "../src/server/local-listen.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { permissiveUmask } from "./permissive-umask.ts";
import {
  _lockDeps,
  _prepareLockDir,
  createInLockDir,
  listenInLockDir,
  type LockData,
  lockPath,
  readLock,
  removeLock,
  withLockMutexAt,
  writeLock,
} from "../src/server/single-instance-lock.ts";

const id = (name: string) =>
  `dir-gone-${name}-${crypto.randomUUID().slice(0, 8)}`;

/** Run `fn` on an OS that is (or is not) macOS, where creating a file whose
 *  name ends in `suffix` is answered EINVAL the first `times` times. Returns
 *  how many creates of such a file were tried. */
function withCreatesRefused<T>(
  o: { darwin: boolean; suffix: string; times: number },
  fn: () => T,
): { out: T; tries: number } {
  const real = { ..._lockDeps };
  let tries = 0;
  _lockDeps.darwin = () => o.darwin;
  _lockDeps.windows = () => false;
  _lockDeps.create = (path, how) => {
    if (!path.endsWith(o.suffix) || ++tries > o.times) {
      return real.create(path, how);
    }
    throw new TypeError(`Invalid argument (os error 22): open '${path}'`);
  };
  try {
    return { out: fn(), tries };
  } finally {
    Object.assign(_lockDeps, real);
  }
}

Deno.test("lock mutex: macOS's EINVAL for a dir pruned under the create is asked again", () => {
  const lock = lockPath(id("mx"));
  const { out, tries } = withCreatesRefused(
    { darwin: true, suffix: ".mx", times: 3 },
    () => withLockMutexAt(lock, () => "inside", true),
  );
  assertEquals(out, "inside");
  assertEquals(tries, 4, "three refusals, then the create that worked");
});

Deno.test("lock mutex: an EINVAL that stays is thrown at the bound, naming the path", () => {
  const lock = lockPath(id("mx-stays"));
  const t0 = performance.now();
  const e = assertThrows(
    () =>
      withCreatesRefused(
        { darwin: true, suffix: ".mx", times: Infinity },
        () => withLockMutexAt(lock, () => "inside", true),
      ),
    TypeError,
    "os error 22",
  );
  const took = performance.now() - t0;
  assert(e.message.includes(`${lock}.mx`), e.message);
  assert(took >= 1_900 && took < 10_000, `gave up after ${took} ms`);
});

Deno.test("lock mutex: EINVAL anywhere but macOS is thrown at once", () => {
  const lock = lockPath(id("mx-linux"));
  const t0 = performance.now();
  assertThrows(
    () =>
      withCreatesRefused(
        { darwin: false, suffix: ".mx", times: Infinity },
        () => withLockMutexAt(lock, () => "inside", true),
      ),
    TypeError,
    "os error 22",
  );
  assert(performance.now() - t0 < 1_000, "it waited for nothing");
});

Deno.test("lock record: macOS's EINVAL on its temp is the pruned dir — made again, once", () => {
  const data = (appId: string): LockData => ({
    appId,
    pid: Deno.pid,
    port: 0,
    startedAt: Date.now(),
    status: "started",
    cwd: Deno.cwd(),
  });
  const once = id("rec");
  try {
    const { tries } = withCreatesRefused(
      { darwin: true, suffix: ".tmp", times: 1 },
      () => writeLock(data(once)),
    );
    assertEquals(tries, 2, "refused once, then written");
    assertEquals(readLock(once)?.pid, Deno.pid);
  } finally {
    removeLock(once);
  }
  const twice = id("rec-stays");
  try {
    assertThrows(
      () =>
        withCreatesRefused(
          { darwin: true, suffix: ".tmp", times: 2 },
          () => writeLock(data(twice)),
        ),
      TypeError,
      `${twice}.lock`,
    );
    assertEquals(readLock(twice), null, "nothing was published");
  } finally {
    removeLock(twice);
  }
});

// ── every other create in the lock dir ───────────────────────────────────────
//
// A socket's bind and the watcher's sentinel made the dir and then created in
// it, with no second try: a prune between the two failed the start (ENOENT;
// on macOS EINVAL as well — measured for bind(2) too). They go through one
// helper now. The prune is REAL here: the directory is removed between the
// "make sure it is there" and the create, as a sibling's exit does it.

/** A lock dir by its NAME (`aio-u<uid>`, the `/tmp` fallback's) in a temp
 *  root, so a test may remove it. */
async function ownLockDir(): Promise<{ root: string; dir: string }> {
  const root = await tempDir("aio-dir-gone-");
  return { root, dir: join(root, "aio-u1") };
}

Deno.test("create in the lock dir: a dir pruned between the ensure and the create is made again", async () => {
  const { root, dir } = await ownLockDir();
  try {
    const path = join(dir, "watch-1.tmp");
    let tries = 0;
    createInLockDir(path, () => {
      if (++tries === 1) Deno.removeSync(dir); // the sibling's prune
      return Deno.openSync(path, { createNew: true, write: true });
    }).close();
    assertEquals(tries, 2, "refused once (ENOENT), then created");
    assert(Deno.statSync(path).isFile);
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("create in the lock dir: macOS's EINVAL is the pruned dir too — and only there", async () => {
  const { root, dir } = await ownLockDir();
  const real = { ..._lockDeps };
  try {
    const path = join(dir, "a.sock");
    const refuse = (tries: { n: number }) => () => {
      if (++tries.n === 1) {
        Deno.removeSync(dir);
        throw new TypeError("Invalid argument (os error 22)");
      }
      return "made";
    };
    _lockDeps.darwin = () => true;
    const mac = { n: 0 };
    assertEquals(createInLockDir(path, refuse(mac)), "made");
    assertEquals(mac.n, 2);
    assert(Deno.statSync(dir).isDirectory, "the dir was made again");
    _lockDeps.darwin = () => false;
    const other = { n: 0 };
    assertThrows(
      () => createInLockDir(path, refuse(other)),
      TypeError,
      "os error 22",
    );
    assertEquals(other.n, 1, "not a pruned dir anywhere else: thrown at once");
  } finally {
    Object.assign(_lockDeps, real);
    await dropTempDir(root);
  }
});

Deno.test("create in the lock dir: a dir that keeps going is thrown at the bound, naming the path", async () => {
  const { root, dir } = await ownLockDir();
  try {
    const path = join(dir, "a.sock");
    let tries = 0;
    const t0 = performance.now();
    const e = assertThrows(
      () =>
        createInLockDir(path, () => {
          tries++;
          Deno.removeSync(dir);
          throw new Deno.errors.NotFound(
            "No such file or directory (os error 2)",
          );
        }),
      Deno.errors.NotFound,
    );
    const took = performance.now() - t0;
    // By time, as the mutex's open is: a count of three was lost by six
    // processes making and pruning one dir (1.3 % of 18 000 creates).
    assert(tries > 3 && took >= 1_900 && took < 10_000, `${tries} in ${took}`);
    assert(e.message.includes(path), e.message);
    // Another error is nobody's pruned dir: once, and as it came.
    tries = 0;
    assertThrows(
      () =>
        createInLockDir(path, () => {
          tries++;
          throw new Deno.errors.AddrInUse("Address already in use");
        }),
      Deno.errors.AddrInUse,
    );
    assertEquals(tries, 1);
    // A directory that is not a lock dir is its caller's to make: no retry.
    const theirs = join(root, "theirs", "a.sock");
    tries = 0;
    assertThrows(
      () =>
        createInLockDir(theirs, () => {
          tries++;
          return Deno.openSync(theirs, { createNew: true, write: true });
        }),
      Deno.errors.NotFound,
    );
    assertEquals(tries, 1);
    assert(!exists(dirname(theirs)), "and it was not made here");
  } finally {
    await dropTempDir(root);
  }
});

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

for (const peer of [false, true]) {
  Deno.test({
    name: `socket in the lock dir: a dir pruned under the bind is made again ${
      peer ? "(the peer listener, which binds later)" : "(the plain listener)"
    }`,
    // A unix socket FILE in a directory: Windows binds a pipe name instead.
    ignore: Deno.build.os === "windows",
    // `node:net` (the peer listener) keeps its own handles.
    sanitizeOps: !peer,
    sanitizeResources: !peer,
    async fn() {
      const { root, dir } = await ownLockDir();
      const real = { ..._lockDeps };
      let binds = 0;
      try {
        const path = join(dir, "a.sock");
        _lockDeps.listen = (p, o) => {
          if (++binds === 1) Deno.removeSync(dir); // the sibling's prune
          return real.listen(p, o);
        };
        const l = listenInLockDir(path, peer);
        try {
          const accepted = (async () => {
            for await (const c of l) return c;
          })();
          // The peer listener's bind lands later: connect when it is there.
          for (const end = Date.now() + 10_000; !exists(path);) {
            if (Date.now() > end) throw new Error("no socket within 10 s");
            await new Promise((r) => setTimeout(r, 5));
          }
          const client = await connectLocal(path);
          const server = await accepted;
          assert(server, "the listener accepted on the remade dir");
          server.close();
          client.close();
        } finally {
          l.close();
        }
        // Plain: the sync bind failed and was called again. Peer: one call,
        // whose later bind was asked again through `rebind`.
        assertEquals(binds, peer ? 1 : 2);
      } finally {
        Object.assign(_lockDeps, real);
        await new Promise((r) => setTimeout(r, 20)); // the server's close
        await dropTempDir(root);
      }
    },
  });
}

// The same prune, one step earlier: between MAKING the lock dir and the look
// at what was made. It was refused ("cannot be created or read") and the
// next candidate taken — an app then kept its lock in a dir `am` does not
// read. Measured, six processes making and pruning one scoped dir: 1 150 of
// 18 000 looks at HEAD, 0 of 108 000 now.
Deno.test({
  name:
    "lock dir: pruned between its mkdir and the look at it is made again; one that cannot be made is refused at once",
  // The look is at the dir's POSIX mode and owner: Windows has neither, so
  // there the dir is made and used (a prune after that is `createInLockDir`'s).
  ignore: Deno.build.os === "windows",
  async fn() {
    const { root, dir } = await ownLockDir();
    try {
      let looks = 0;
      const why = _prepareLockDir(dir, {
        stat: (p) => {
          if (++looks <= 2) Deno.removeSync(dir); // the sibling's prune
          return Deno.statSync(p);
        },
      });
      assertEquals(why, null);
      assertEquals(looks, 3, "looked again after each prune");
      assert(Deno.statSync(dir).isDirectory);
      // Under a FILE nothing can be made: no waiting for a prune to end.
      const file = join(root, "file");
      await Deno.writeTextFile(file, "");
      const t0 = performance.now();
      const refused = _prepareLockDir(join(file, "aio-u1"));
      assert(refused?.includes("cannot be created or read"), String(refused));
      assert(performance.now() - t0 < 1_000, "it waited for nothing");
    } finally {
      await dropTempDir(root);
    }
  },
});

// Made owner-only in ONE step. Made at the umask's 0755 and narrowed after, a
// sibling that looked between the two refused the dir as "not owner-only"
// (macOS, 3 processes making and pruning one dir: 39 of 9 000 looks).
Deno.test({
  name: "lock dir: it is never there wider than 0700, even before the chmod",
  ignore: Deno.build.os === "windows", // no POSIX mode to read
  async fn() {
    const { root, dir } = await ownLockDir();
    try {
      // Under 022: at 077 a dir made with no mode is 0700 by itself.
      const { why, modeAtChmod } = await permissiveUmask(() => {
        let modeAtChmod: number | null = null;
        const why = _prepareLockDir(dir, {
          chmod: (p) => {
            modeAtChmod = Deno.statSync(p).mode! & 0o777;
          },
        });
        return { why, modeAtChmod };
      });
      assertEquals(why, null);
      assertEquals(modeAtChmod, 0o700, "as it was made, before any chmod");
    } finally {
      await dropTempDir(root);
    }
  },
});

// Windows refuses a create in a directory that is BEING removed
// (ACCESS_DENIED) until the removal is done: the same prune, a moment earlier.
Deno.test("create in the lock dir: Windows's ACCESS_DENIED under a dir being removed is waited out — and only there", async () => {
  const { root, dir } = await ownLockDir();
  const real = { ..._lockDeps };
  try {
    const path = join(dir, "watch-1.tmp");
    const refuse = (tries: { n: number }) => () => {
      if (++tries.n <= 2) {
        throw new Deno.errors.PermissionDenied(
          "Access is denied. (os error 5)",
        );
      }
      return "made";
    };
    _lockDeps.windows = () => true;
    const win = { n: 0 };
    assertEquals(createInLockDir(path, refuse(win)), "made");
    assertEquals(win.n, 3);
    _lockDeps.windows = () => false;
    const other = { n: 0 };
    assertThrows(
      () => createInLockDir(path, refuse(other)),
      Deno.errors.PermissionDenied,
    );
    assertEquals(other.n, 1, "a refusal anywhere else is one: thrown at once");
  } finally {
    Object.assign(_lockDeps, real);
    await dropTempDir(root);
  }
});
