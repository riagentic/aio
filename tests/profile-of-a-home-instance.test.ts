// `am profile --home=X` / `--profile=dev` exported the DEFAULT instance's
// profile: `buildLocalProfile` read only the default lock, so a running
// profile instance was "no running app — start it". It takes the lock `am`
// already resolved, and reads that instance's key from that instance's home.
import { assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import { buildLocalProfile } from "../src/server/profile.ts";
import { appDirs } from "../src/server/app-dirs.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import type { LockData } from "../src/server/single-instance-lock.ts";

Deno.test("buildLocalProfile: the instance am found — its port, its home's key", async () => {
  const home = await tempDir("aio-profile-home-");
  try {
    const appId = `profhome-${Deno.pid}`;
    const keyPath = appDirs(appId, home).appKey;
    await Deno.mkdir(dirname(keyPath), { recursive: true });
    await Deno.writeTextFile(keyPath, "the-instance-key\n");
    const lock = {
      appId,
      pid: Deno.pid,
      port: 43210,
      startedAt: Date.now(),
      status: "started",
      cwd: home,
      home,
    } as LockData;
    const p = buildLocalProfile(appId, join(home, "nowhere"), lock);
    assertEquals(p?.port, 43210);
    assertEquals(p?.key, "the-instance-key");
  } finally {
    await dropTempDir(home);
  }
});
