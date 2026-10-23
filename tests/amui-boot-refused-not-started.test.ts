// amui said "started <app>" over an app that had refused to boot.
//
// An aio app takes its lock at status "starting" BEFORE its config is
// checked; a refused boot (no App.tsx, a bad option) then exits. awaitBoot
// polled for ANY live lock from the directory, so the "starting" lock of a
// boot about to be refused read as up and Start reported success. Only a lock
// that reached "started" is an app that came up.
import { SLEEP_ARGS } from "./proc-helper.ts";
import { assertEquals } from "@std/assert";
import { awaitBoot } from "../amui/src/server/proc.server.ts";
import {
  lockKey,
  removeLock,
  writeLock,
} from "../src/server/single-instance-lock.ts";
import { _resetInstanceVerify } from "../src/am/am-http.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const APP = "amui-r3-starting-fixture";

Deno.test("amui awaitBoot: a lock still at `starting` is not a started app", async () => {
  const sandbox = await tempDir("amui-r3-starting-");
  const dir = `${sandbox}/proj`;
  await Deno.mkdir(dir);
  const prev = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", `${sandbox}/apps`);
  _resetInstanceVerify();
  const child = new Deno.Command(Deno.execPath(), {
    args: SLEEP_ARGS,
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  try {
    writeLock({
      appId: APP,
      pid: child.pid,
      port: 0,
      startedAt: Date.now(),
      status: "starting",
      cwd: dir,
    });
    const r = await awaitBoot(dir, child.pid, 600, [], 600);
    assertEquals(r.up, false, "a `starting` lock read as a started app");
  } finally {
    removeLock(lockKey(APP));
    try {
      child.kill("SIGKILL");
    } catch { /* gone */ }
    await child.status;
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    _resetInstanceVerify();
    await dropTempDir(sandbox);
  }
});
