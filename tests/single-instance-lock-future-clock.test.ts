// A lock stamped in the FUTURE is old, not young.
//
// The wall clock jumps back — an NTP step, a restored VM snapshot — and a
// lock written before the jump carries a time "after now". Every age check in
// the lock read that as "just written": a truncated lock (a crash mid-write)
// was never reclaimed, and the app refused to start, "already running
// (pid 0)", forever; a zombie still "starting" kept its startup grace forever.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { tempDir } from "../src/testing/temp-dir.ts";
import {
  AppLock,
  lockKey,
  lockPath,
  writeLock,
} from "../src/server/single-instance-lock.ts";

const HOUR = 3_600_000;

async function inApps<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await tempDir("lock-future-");
  const was = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", join(dir, "apps"));
  try {
    return await fn(dir);
  } finally {
    if (was === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", was);
  }
}

Deno.test("lock: a truncated lock with a FUTURE mtime is still reclaimed", async () => {
  await inApps(async (dir) => {
    const home = join(dir, "home");
    const path = lockPath(lockKey("futapp", home));
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, '{"appId":"futa'); // crashed mid-write
    const future = new Date(Date.now() + HOUR);
    await Deno.utime(path, future, future);
    const lock = new AppLock("futapp", home);
    const r = await lock.acquire(0);
    try {
      assert(
        r.ok,
        `refused over a truncated lock stamped an hour ahead: ` +
          JSON.stringify(r),
      );
    } finally {
      lock.release();
    }
  });
});

Deno.test("lock: a 'starting' zombie with a FUTURE startedAt loses its grace", async () => {
  await inApps(async (dir) => {
    const home = join(dir, "home");
    // A LIVE process that is not us, owning a lock whose port answers nothing.
    const owner = new Deno.Command("sleep", { args: ["30"] }).spawn();
    try {
      const l = Deno.listen({ port: 0, hostname: "127.0.0.1" });
      const deadPort = (l.addr as Deno.NetAddr).port;
      l.close();
      writeLock({
        appId: "futzombie",
        pid: owner.pid,
        port: deadPort,
        startedAt: Date.now() + HOUR,
        status: "starting",
        cwd: "/",
        home,
      });
      const lock = new AppLock("futzombie", home);
      const r = await lock.acquire(0);
      try {
        assertEquals(
          r.ok,
          true,
          `a zombie stamped an hour ahead kept its startup grace: ` +
            JSON.stringify(r),
        );
      } finally {
        lock.release();
      }
    } finally {
      owner.kill("SIGKILL");
      await owner.status;
    }
  });
});
