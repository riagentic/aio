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

/** Run `fn` on a clock of the test's own (`_lockDeps.now`/`pause`): a pause
 *  is the only thing that moves it, and nothing sleeps — so what a wait
 *  "took" is exact on any machine. Returns every pause made, in order. */
function onTestClock(fn: () => void): { pauses: number[]; took: number } {
  const real = { ..._lockDeps };
  const start = 50_000;
  let clock = start;
  const pauses: number[] = [];
  _lockDeps.now = () => clock;
  _lockDeps.pause = (ms) => {
    pauses.push(ms);
    clock += ms;
  };
  try {
    fn();
  } finally {
    Object.assign(_lockDeps, real);
  }
  return { pauses, took: clock - start };
}

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
  let e: TypeError | undefined;
  const { pauses, took } = onTestClock(() => {
    e = assertThrows(
      () =>
        withCreatesRefused(
          { darwin: true, suffix: ".mx", times: Infinity },
          () => withLockMutexAt(lock, () => "inside", true),
        ),
      TypeError,
      "os error 22",
    );
  });
  assert(e!.message.includes(`${lock}.mx`), e!.message);
  // Each refusal is followed by a pause of 1–3 ms, until 2 000 ms of them:
  // the last one ends at the bound or at most 2 ms past it.
  assert(pauses.every((ms) => ms >= 1 && ms <= 3), "a pause of 1–3 ms");
  assert(took >= 2_000 && took <= 2_002, `gave up after ${took} ms`);
  assert(took - pauses.at(-1)! < 2_000, "one pause past the bound");
});

Deno.test("lock mutex: EINVAL anywhere but macOS is thrown at once", () => {
  const lock = lockPath(id("mx-linux"));
  const { pauses } = onTestClock(() => {
    assertThrows(
      () =>
        withCreatesRefused(
          { darwin: false, suffix: ".mx", times: Infinity },
          () => withLockMutexAt(lock, () => "inside", true),
        ),
      TypeError,
      "os error 22",
    );
  });
  assertEquals(pauses, [], "it waited for nothing");
});

// It was ONE more try: two prunes in a row threw the raw EINVAL (ENOENT on
// the others) out of `acquire`. Now for as long as every other create waits.
Deno.test("lock record: macOS's EINVAL on its temp is the pruned dir — made again, until the bound", () => {
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
      { darwin: true, suffix: ".tmp", times: 5 },
      () => writeLock(data(once)),
    );
    assertEquals(tries, 6, "refused five times in a row, then written");
    assertEquals(readLock(once)?.pid, Deno.pid);
  } finally {
    removeLock(once);
  }
  const stays = id("rec-stays");
  try {
    const { pauses } = onTestClock(() => {
      assertThrows(
        () =>
          withCreatesRefused(
            { darwin: true, suffix: ".tmp", times: Infinity },
            () => writeLock(data(stays)),
          ),
        TypeError,
        `${stays}.lock`,
      );
    });
    // Asked again after each 1 ms pause, through the 2 000th millisecond.
    assertEquals(pauses, Array(2_001).fill(1));
    assertEquals(readLock(stays), null, "nothing was published");
  } finally {
    removeLock(stays);
  }
});

// ── every other create in the lock dir ───────────────────────────────────────
//
// A socket's bind and the watcher's sentinel made the dir and then created in
// it, with no second try: a prune between the two failed the start (ENOENT;
// on macOS EINVAL as well — measured for bind(2) too). They go through one
// helper now. The prune is REAL here: the directory is removed between the
// "make sure it is there" and the create, as a sibling's exit does it.

/** A lock dir in a temp root, so a test may remove it: one aio CHOSE
 *  (`_lockDeps.chosen` — what `_chooseLockDir` adds its answer to). Its name
 *  says nothing: any directory called `aio` or `aio-u<digits>` used to get
 *  the lock dir's rules (lock-dir-is-a-chosen-path.test.ts). */
async function ownLockDir(): Promise<{ root: string; dir: string }> {
  const root = await tempDir("aio-dir-gone-");
  const dir = join(root, "locks");
  _lockDeps.chosen.add(dir);
  return { root, dir };
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
    let e: Error | undefined;
    const { pauses } = onTestClock(() => {
      e = assertThrows(
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
    });
    // By time, as the mutex's open is: a count of three was lost by six
    // processes making and pruning one dir (1.3 % of 18 000 creates). A try
    // after each 1 ms pause, through the 2 000th millisecond.
    assertEquals(pauses, Array(2_001).fill(1));
    assertEquals(tries, 2_002);
    assert(e!.message.includes(path), e!.message);
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
    // A directory that is not a lock dir is made when it is MISSING (as
    // 1.0.19 made `…/aio/`) — and that is all: nobody prunes it, so one that
    // goes under the create is no pruned dir. No retry, the plain error.
    const theirs = join(root, "theirs", "a.sock");
    tries = 0;
    assertThrows(
      () =>
        createInLockDir(theirs, () => {
          tries++;
          Deno.removeSync(dirname(theirs));
          return Deno.openSync(theirs, { createNew: true, write: true });
        }),
      Deno.errors.NotFound,
    );
    assertEquals(tries, 1);
    assert(!exists(dirname(theirs)), "and it was not made again");
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
    ignore: Deno.build.os === "windows", // a unix socket FILE in a directory: Windows binds a pipe name instead
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
  // Windows has neither, so there the dir is made and used (a prune after
  // that is `createInLockDir`'s).
  ignore: Deno.build.os === "windows", // the look is at the dir's POSIX mode and owner
  async fn() {
    const { root, dir } = await ownLockDir();
    try {
      let looks = 0;
      const why = _prepareLockDir(dir, {
        lstat: (p) => {
          if (++looks <= 2) Deno.removeSync(dir); // the sibling's prune
          return Deno.lstatSync(p);
        },
      });
      assertEquals(why, null);
      assertEquals(looks, 3, "looked again after each prune");
      assert(Deno.statSync(dir).isDirectory);
      // Under a FILE nothing can be made: no waiting for a prune to end.
      const file = join(root, "file");
      await Deno.writeTextFile(file, "");
      let refused: string | null = null;
      const { pauses } = onTestClock(() => {
        refused = _prepareLockDir(join(file, "aio-u1"));
      });
      assert(
        String(refused).includes("cannot be created or read"),
        String(refused),
      );
      assertEquals(pauses, [], "it waited for nothing");
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
      const { why, modeAtLook, chmods } = await permissiveUmask(() => {
        let modeAtLook: number | null = null;
        let chmods = 0;
        const why = _prepareLockDir(dir, {
          lstat: (p) => {
            const at = Deno.lstatSync(p);
            modeAtLook ??= at.mode! & 0o777;
            return at;
          },
          chmod: () => void chmods++,
        });
        return { why, modeAtLook, chmods };
      });
      assertEquals(why, null);
      assertEquals(modeAtLook, 0o700, "as it was made, at the first look");
      assertEquals(chmods, 0, "nothing to narrow, so nothing is chmodded");
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
