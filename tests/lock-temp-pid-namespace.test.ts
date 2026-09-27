// A lock dir's temp files and watch sentinels are named by the pid that wrote
// them — and a pid means something only in its own pid namespace. A container
// sharing the lock dir writes as pid 7 (under tini), which is dead HERE: its
// in-flight temp (and its live sentinel) was deleted under it. The name now
// records the namespace; another's, or none where one exists (an older aio's
// name), goes only once untouched for 10 min.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const LINUX = Deno.build.os === "linux";

async function names() {
  const gone = new Deno.Command("true").spawn();
  await gone.status;
  const { ownPidNs, ownPidTag } = await import(
    "../src/server/single-instance-lock.ts"
  );
  const ns = ownPidNs()!;
  const here = ownPidTag().slice(String(Deno.pid).length);
  const other = `d${(ns + 1).toString(16).padStart(8, "0")}`;
  return { dead: gone.pid, here, other };
}

const exists = (p: string) => {
  try {
    Deno.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
const old = new Date(Date.now() - 11 * 60_000);

Deno.test({
  name:
    "lock dir prune: another pid namespace's temp and sentinel are kept until untouched for 10 min",
  ignore: !LINUX,
  async fn() {
    const dir = await tempDir("lock-ns-prune-");
    try {
      const { pruneDeadLockDirAt } = await import(
        "../src/server/single-instance-lock.ts"
      );
      const { dead, here, other } = await names();
      const foreign = [
        `watch-${dead}${other}.tmp`,
        `a.lock.${dead}${other}.0badf00d.tmp`,
        `watch-${dead}.tmp`, // an older aio's name: no namespace recorded
        `b.lock.${dead}.0badf00d.tmp`,
      ];
      const ours = [
        `watch-${dead}${here}.tmp`,
        `c.lock.${dead}${here}.0badf00d.tmp`,
      ];
      for (const n of [...foreign, ...ours]) {
        Deno.writeTextFileSync(join(dir, n), "");
      }
      assertEquals(pruneDeadLockDirAt(dir), false);
      assertEquals(
        [...Deno.readDirSync(dir)].map((e) => e.name).sort(),
        [...foreign].sort(),
        "our namespace's dead pid goes at once; another's is kept",
      );
      for (const n of foreign) Deno.utimeSync(join(dir, n), old, old);
      assertEquals(pruneDeadLockDirAt(dir), true, "untouched 10 min: debris");
    } finally {
      if (exists(dir)) await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "lock acquire sweep: another pid namespace's in-flight temp is kept until untouched for 10 min",
  ignore: !LINUX,
  async fn() {
    const dir = await tempDir("lock-ns-sweep-");
    const was = Deno.env.get("AIO_APPS_DIR");
    Deno.env.set("AIO_APPS_DIR", join(dir, "apps"));
    const m = await import("../src/server/single-instance-lock.ts");
    try {
      const { dead, here, other } = await names();
      const key = m.lockKey("t", join(dir, "t"));
      const lock = m.lockPath(key);
      Deno.mkdirSync(join(lock, ".."), { recursive: true });
      const theirs = `${lock}.${dead}${other}.0badf00d.tmp`;
      const untagged = `${lock}.${dead}.0badf00d.tmp`;
      const mine = `${lock}.${dead}${here}.cafe0123.tmp`;
      for (const p of [theirs, untagged, mine]) Deno.writeTextFileSync(p, "");
      m.sweepOrphanLockTemps(key);
      assertEquals(exists(mine), false, "our namespace's dead pid: swept");
      assertEquals(exists(theirs), true, "a container's live write lost");
      assertEquals(exists(untagged), true);
      for (const p of [theirs, untagged]) Deno.utimeSync(p, old, old);
      m.sweepOrphanLockTemps(key);
      assertEquals(exists(theirs), false);
      assertEquals(exists(untagged), false);
    } finally {
      if (was === undefined) Deno.env.delete("AIO_APPS_DIR");
      else Deno.env.set("AIO_APPS_DIR", was);
      m.pruneLockDir();
      await dropTempDir(dir);
    }
  },
});
