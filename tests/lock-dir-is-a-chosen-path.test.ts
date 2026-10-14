// A directory gets the lock dir's rules because aio CHOSE it, never because
// of what it is called.
//
// "Is this path in a lock dir" was answered by the directory's NAME: anything
// called `aio` or `aio-u<digits>`. `createUDSListener` is public, so a
// caller's own socket at `/run/aio/app.sock`, `/srv/x/aio/app.sock`, or in a
// project folder named `aio`, had its directory made — and chmodded 0700
// (measured: 0755 → 0700), which silently cut off the reverse proxy that
// reached the socket through the group. Now: `lockDir()` and the dirs
// `_chooseLockDir` answered with (the long-path socket fallback), and nothing
// else.
//
// What the name rule ALSO did, and an app relied on: a socket at
// `/run/aio/app.sock` whose directory was not there yet had it made (0700),
// and bound. Measured on 1.0.19: `<tmp>/aio/x` missing → made 0700 and
// created; without the rule, ENOENT. So a MISSING directory is made — made
// here, so ours — whatever it is called; one that is there is the caller's.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { selfUid } from "../src/server/dir-permissions.ts";
import {
  _chooseLockDir,
  _lockDeps,
  createInLockDir,
  listenInLockDir,
} from "../src/server/single-instance-lock.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { permissiveUmask } from "./permissive-umask.ts";

const POSIX = Deno.build.os !== "windows";
const NotFound = Deno.errors.NotFound;

for (const name of ["aio", `aio-u${selfUid() ?? 1000}`]) {
  Deno.test(`a caller's directory named ${name}: made 0700 when it is missing, never chmodded when it is there`, () =>
    permissiveUmask(async () => {
      const root = await tempDir("aio-chosen-path-");
      try {
        Deno.mkdirSync(join(root, "srv"));
        if (POSIX) Deno.chmodSync(join(root, "srv"), 0o755);
        const dir = join(root, "srv", name);
        const path = join(dir, "app.sock");
        // Not there: made, owner-only (under a umask that would give 0755).
        let tries = 0;
        createInLockDir(path, () => {
          tries++;
          return Deno.openSync(path, { createNew: true, write: true });
        }).close();
        assertEquals(tries, 1);
        if (POSIX) assertEquals(Deno.statSync(dir).mode! & 0o777, 0o700);
        // …and `srv` above it, which was there, is as it was.
        Deno.removeSync(path);
        // There, and shared with a group: left exactly so.
        if (POSIX) Deno.chmodSync(dir, 0o750);
        createInLockDir(
          path,
          () => Deno.openSync(path, { createNew: true, write: true }),
        ).close();
        if (POSIX) {
          assertEquals(
            Deno.statSync(dir).mode! & 0o777,
            0o750,
            "a caller's directory was narrowed",
          );
          assertEquals(Deno.statSync(join(root, "srv")).mode! & 0o777, 0o755);
        }
      } finally {
        await dropTempDir(root);
      }
    }));
}

Deno.test({
  name:
    "the directory _chooseLockDir answered with IS a lock dir: made again when it is pruned",
  async fn() {
    const root = await tempDir("aio-chosen-path-fallback-");
    try {
      const dir = _chooseLockDir(root, "");
      assertEquals(dir, join(root, "aio"));
      const path = join(dir, "app.sock");
      Deno.removeSync(dir); // a sibling's prune
      createInLockDir(
        path,
        () => Deno.openSync(path, { createNew: true, write: true }),
      ).close();
      assert(Deno.statSync(path).isFile);
    } finally {
      _lockDeps.chosen.delete(join(root, "aio"));
      await dropTempDir(root);
    }
  },
});

// The peer listener binds LATER — after an import, seconds into a cold start
// on a slow machine. Its wait for a pruned dir was counted from the call, so
// a first failure past 2 s was never asked again: the bind failed for a
// prune every other create waits out.
Deno.test("socket in the lock dir: a bind that first fails late is still asked again", async () => {
  const root = await tempDir("aio-chosen-path-rebind-");
  const dir = join(root, "locks");
  const path = join(dir, "a.sock");
  _lockDeps.chosen.add(dir);
  const real = { ..._lockDeps };
  try {
    let rebind: ((e: unknown, tries: number) => boolean) | undefined;
    _lockDeps.listen = (p, o) => {
      rebind = o?.rebind;
      return { path: p, close() {}, async *[Symbol.asyncIterator]() {} };
    };
    // Time is the subject, so the clock is the test's: nothing here waits.
    let clock = 1_000;
    _lockDeps.now = () => clock;
    _lockDeps.pause = (ms) => void (clock += ms);
    listenInLockDir(path, true).close();
    clock += 2_100; // the late bind
    Deno.removeSync(dir); // …and the prune it runs into
    const gone = new NotFound("No such file or directory (os error 2)");
    assertEquals(rebind!(gone, 1), true, "refused: counted from the call");
    assert(Deno.statSync(dir).isDirectory, "the dir was made again");
    // The bound still holds, from that first failure.
    clock += 1_900;
    assertEquals(rebind!(gone, 2), true);
    clock += 200;
    assertEquals(rebind!(gone, 3), false, "a bind that keeps failing ends");
  } finally {
    Object.assign(_lockDeps, real);
    _lockDeps.chosen.delete(dir);
    await dropTempDir(root);
  }
});
