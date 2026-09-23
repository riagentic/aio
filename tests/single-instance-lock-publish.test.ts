// Each of the lock's exclusivity fixes, pinned ALONE and deterministically.
//
// `single-instance-lock-exclusive.test.ts` races real processes, and its
// defences overlap: reverting ONE of them usually leaves the others catching
// the race, so it stays green. These two cases each isolate one fix:
//
//  1. PUBLISH, not create-then-write. The lock file must never exist without
//     its whole record — a racer that reads it empty takes it for an
//     unreadable (dead) lock. Observed from inside: after every file call the
//     acquire makes, the lock at the path is either absent or complete.
//  2. The 1 s AGE FLOOR on reclaiming an unreadable lock. On a filesystem
//     without hard links publication IS create-then-write, so an empty lock
//     can be a live racer's, mid-write. Planted empty and filled 300 ms later
//     by a "racer": acquire must still find the racer's lock, not its own.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { tempDir } from "../src/testing/temp-dir.ts";
import {
  AppLock,
  type LockData,
  lockDir,
  lockKey,
  lockPath,
  readLock,
} from "../src/server/single-instance-lock.ts";

async function withAppsDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await tempDir("lock-pub-");
  const was = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", join(dir, "apps"));
  try {
    return await fn(dir);
  } finally {
    if (was === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", was);
  }
}

Deno.test("lock publish: the lock file never exists without its whole record", async () => {
  await withAppsDir(async (dir) => {
    const home = join(dir, "home");
    const path = lockPath(lockKey("pub", home));
    const seen: string[] = [];
    // deno-lint-ignore no-explicit-any
    const D = Deno as any;
    const names = [
      "openSync",
      "linkSync",
      "renameSync",
      "writeTextFileSync",
      "writeFileSync",
    ] as const;
    const orig = Object.fromEntries(names.map((n) => [n, D[n]]));
    const check = () => {
      let text: string;
      try {
        text = Deno.readTextFileSync(path);
      } catch {
        return; // absent is fine
      }
      let whole = false;
      try {
        whole = typeof JSON.parse(text)?.pid === "number";
      } catch { /* aio-ok: unparseable IS the finding */ }
      if (!whole) seen.push(JSON.stringify(text));
    };
    for (const n of names) {
      D[n] = (...a: unknown[]) => {
        const r = orig[n].apply(Deno, a);
        check();
        return r;
      };
    }
    const lock = new AppLock("pub", home);
    try {
      const r = await lock.acquire(0);
      assert(r.ok, JSON.stringify(r));
    } finally {
      for (const n of names) D[n] = orig[n];
      lock.release();
    }
    assertEquals(seen, [], "the lock was visible half-written");
  });
});

Deno.test("lock publish: an EMPTY lock younger than 1 s is a racer mid-write, never reclaimed", async () => {
  await withAppsDir(async (dir) => {
    const home = join(dir, "home");
    const key = lockKey("floor", home);
    Deno.mkdirSync(lockDir(), { recursive: true });
    const racer = new Deno.Command("sleep", { args: ["30"] }).spawn();
    try {
      // The racer's create-then-write: the file first, its record 300 ms on.
      Deno.writeTextFileSync(lockPath(key), "");
      const rec: LockData = {
        appId: "floor",
        pid: racer.pid,
        port: 0,
        startedAt: Date.now(),
        status: "started",
        cwd: dir,
        home,
      };
      const fill = setTimeout(
        () => Deno.writeTextFileSync(lockPath(key), JSON.stringify(rec)),
        300,
      );
      const lock = new AppLock("floor", home);
      let r;
      try {
        r = await lock.acquire(0);
      } finally {
        clearTimeout(fill);
      }
      if (r.ok) lock.release();
      assert(!r.ok, "reclaimed a live racer's lock while it was being written");
      assertEquals(r.existing.pid, racer.pid);
      assertEquals(readLock(key)?.pid, racer.pid);
    } finally {
      racer.kill("SIGKILL");
      await racer.status;
    }
  });
});
