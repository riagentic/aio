// `am stop --profile=nope` (a profile that is not running) answered
//
//     app not running: no lock file for "ex-counter"
//       running right now: ex-counter, ex-counter — target one with --app=<id>
//
// The app IS running — twice, from two data homes — and the advice was to
// pass the `--app=` that had already resolved: the one thing that tells the
// two apart (the profile / home) was never named. A miss on an id that has
// live instances now names each instance's home, the way to target it.
import { assert, assertStringIncludes } from "@std/assert";
import { noLockMessage } from "../src/am/am-cmd-process.ts";
import {
  lockKey,
  removeLock,
  writeLock,
} from "../src/server/single-instance-lock.ts";
import { appHome, profileHome } from "../src/server/app-dirs.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("am: a lock miss on a running id names the homes it runs from", async () => {
  const root = await tempDir("aio-am-nolock-homes-");
  const prev = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", root);
  const appId = "twin-app";
  const dflt = appHome(appId);
  const dev = profileHome(appId, "dev");
  const base = {
    appId,
    pid: Deno.pid,
    port: 0,
    startedAt: Date.now(),
    status: "started" as const,
    cwd: root,
  };
  try {
    writeLock({ ...base, home: dflt });
    writeLock({ ...base, home: dev, profile: "dev" });
    const msg = noLockMessage(appId);
    assertStringIncludes(msg, `"${appId}" IS running`);
    assertStringIncludes(msg, "--profile=dev");
    assertStringIncludes(msg, "no --profile");
    // Not the useless "ex-counter, ex-counter — target one with --app=<id>".
    assert(!msg.includes(`${appId}, ${appId}`), msg);
  } finally {
    removeLock(lockKey(appId, dflt));
    removeLock(lockKey(appId, dev, "dev"));
    removeLock(lockKey(appId, dev));
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    await dropTempDir(root);
  }
});
