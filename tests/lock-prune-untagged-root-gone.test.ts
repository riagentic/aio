// An older build (or one without `/proc` access) names its watch sentinel
// `watch-<pid>.tmp` with no pid-namespace tag, so a live lock dir keeps it
// 10 minutes — pid alone could be another namespace's. A test's temp apps
// root is gone by the time its lock dirs are pruned, though: nothing can
// live under it, and the untagged file kept the dir (six per suite run,
// from the v1.0.9 upgrade sweeps). With the root gone, a dead pid is enough.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  pruneDeadLockDirAt,
  pruneDeadLockDirsTagged,
} from "../src/server/single-instance-lock.ts";

async function deadPid(): Promise<number> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["eval", ""],
    stdout: "null",
    stderr: "null",
  }).spawn();
  await child.status;
  return child.pid;
}

const exists = (p: string) => {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
};

Deno.test("lock prune: an untagged watch file of a dead pid keeps a live root's dir, and goes once the root is gone", async () => {
  const dir = await tempDir("aio-lock-untagged-");
  try {
    const lockDir = join(dir, "aio-x");
    await Deno.mkdir(lockDir);
    await Deno.writeTextFile(join(lockDir, `watch-${await deadPid()}.tmp`), "");
    assertEquals(pruneDeadLockDirAt(lockDir), false, "fresh: kept 10 minutes");
    assertEquals(pruneDeadLockDirAt(lockDir, true), true);
    assertEquals(exists(lockDir), false);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("lock prune: a live pid's untagged watch file is kept even with the root gone", async () => {
  const dir = await tempDir("aio-lock-untagged-live-");
  try {
    const lockDir = join(dir, "aio-x");
    await Deno.mkdir(lockDir);
    await Deno.writeTextFile(join(lockDir, `watch-${Deno.pid}.tmp`), "");
    assertEquals(pruneDeadLockDirAt(lockDir, true), false);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("lock prune: dropping a temp dir removes its tagged lock dir holding an untagged dead watch file", async () => {
  const runtime = await tempDir("aio-lock-untagged-runtime-");
  const was = Deno.env.get("XDG_RUNTIME_DIR");
  Deno.env.set("XDG_RUNTIME_DIR", runtime);
  try {
    const tag = "0123456789abcdef";
    const lockDir = join(runtime, `aio-e-tmp-aio-sweep-${tag}`);
    await Deno.mkdir(lockDir);
    await Deno.writeTextFile(join(lockDir, `watch-${await deadPid()}.tmp`), "");
    assertEquals(pruneDeadLockDirsTagged(tag), 1);
    assertEquals(exists(lockDir), false);
  } finally {
    if (was === undefined) Deno.env.delete("XDG_RUNTIME_DIR");
    else Deno.env.set("XDG_RUNTIME_DIR", was);
    await dropTempDir(runtime);
  }
});
