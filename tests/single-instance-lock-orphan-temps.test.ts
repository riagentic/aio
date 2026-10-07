// The lock's private temp files do not pile up.
//
// Publishing (`<lock>.<pid>.<nonce>.tmp` → link) leaves a file for a moment;
// a process SIGKILLed in that moment leaves it for good (30 SIGKILLs → 13
// files), and they keep the scoped lock dir from being pruned. `acquire`
// sweeps them — but only a DEAD pid's: a live process's temp is an operation
// in flight. (The `<lock>.mx` mutex file: single-instance-lock-mutex.test.ts.)
import { sleeper } from "./proc-helper.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { tempDir } from "../src/testing/temp-dir.ts";
import {
  AppLock,
  lockDir,
  lockKey,
  lockPath,
  ownPidTag,
} from "../src/server/single-instance-lock.ts";

function deadPid(): number {
  for (let p = 3_999_989; p > 1_000_000; p -= 7919) {
    try {
      Deno.kill(p, 0);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return p;
    }
  }
  throw new Error("no free pid found");
}

Deno.test("lock: acquire sweeps a dead process's temp files, and only those", async () => {
  const dir = await tempDir("lock-orphans-");
  const was = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", join(dir, "apps"));
  const live = sleeper();
  let planted: string[] = [];
  try {
    const home = join(dir, "home");
    const key = lockKey("orphans", home);
    const base = lockPath(key);
    await Deno.mkdir(lockDir(), { recursive: true });
    const dead = deadPid();
    // Named in OUR pid namespace: only there does a dead pid prove anything.
    const ns = ownPidTag().slice(`${Deno.pid}`.length);
    const orphans = [`${base}.${dead}${ns}.0a1b2c3d.tmp`];
    const kept = [
      `${base}.${live.pid}.0a1b2c3d.tmp`, // a live process, mid-publish
      join(lockDir(), `other.lock.${dead}.0a1b2c3d.tmp`), // another app's
    ];
    planted = [...orphans, ...kept];
    for (const f of planted) await Deno.writeTextFile(f, "x");
    const lock = new AppLock("orphans", home);
    const r = await lock.acquire(0);
    try {
      assert(r.ok, JSON.stringify(r));
      const exists = (f: string) => {
        try {
          Deno.statSync(f);
          return true;
        } catch {
          return false;
        }
      };
      assertEquals(orphans.filter(exists), [], "a dead pid's temp survived");
      assertEquals(kept.filter(exists), kept, "swept a file it must not");
    } finally {
      lock.release();
    }
  } finally {
    live.kill("SIGKILL");
    await live.status;
    // The kept fixtures are the test's, not debris the lock may sweep: left
    // behind, they keep the scoped lock dir from its exit prune.
    for (const f of planted) await Deno.remove(f).catch(() => {});
    if (was === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", was);
  }
});
