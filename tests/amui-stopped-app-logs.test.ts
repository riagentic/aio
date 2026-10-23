// amui lost a stopped app's logs — and a crashed scratch app altogether.
//
// The Logs tab found an app's `~/.<appId>/logs/` only through its LOCK
// (`running.appId`/`home`). Once the app stopped or crashed, the lock was
// gone and the tab read "no combined log found (app may not have written one
// yet)" over the very log that said why it died. And an app living outside
// the scan roots (a scratch app under /tmp) was listed only while its lock
// existed: a crash made the entry, the selection and its logs vanish.
import { SLEEP_ARGS } from "./proc-helper.ts";
import { assert, assertEquals } from "@std/assert";
import { testCell } from "../src/testing/cell-test.ts";
import { manager } from "../amui/src/manager.ts";
import {
  lockKey,
  removeLock,
  writeLock,
} from "../src/server/single-instance-lock.ts";
import { _resetInstanceVerify } from "../src/am/am-http.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const APP = "amui-r3-logs-fixture";

testCell(
  manager,
  "amui: a stopped app outside the scan roots stays listed and its logs still read",
  async (t) => {
    const sandbox = await tempDir("amui-r3-logs-");
    const dir = `${sandbox}/scratch/proj`; // outside HOME and AMUI_ROOTS
    const home = `${sandbox}/apps/${APP}`;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.mkdir(`${sandbox}/home`);
    await Deno.mkdir(`${sandbox}/roots`);
    await Deno.mkdir(`${home}/logs`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({ name: "scratch", imports: { aio: "../mod.ts" } }),
    );
    await Deno.writeTextFile(
      `${home}/logs/app.log`,
      "2026-10-21 10:00:00.000  ERROR  app         kaboom — the crash reason\n",
    );
    const keys = ["AIO_APPS_DIR", "AMUI_ROOTS", "HOME"] as const;
    const prev = keys.map((k) => Deno.env.get(k));
    Deno.env.set("AIO_APPS_DIR", `${sandbox}/apps`);
    Deno.env.set("AMUI_ROOTS", `${sandbox}/roots`);
    Deno.env.set("HOME", `${sandbox}/home`);
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
        status: "started",
        cwd: dir,
        home,
      });
      await t.send.discover();
      const row = t.getState().projects.find((p) =>
        p.running?.pid === child.pid
      );
      assert(row, "fixture instance not discovered");
      await t.send.select(row.id);
      // The app crashes: its process and its lock are gone.
      child.kill("SIGKILL");
      await child.status;
      removeLock(lockKey(APP, home));
      _resetInstanceVerify();
      await t.send.discover();
      const s = t.getState();
      const idle = s.projects.find((p) => p.path === dir);
      assert(idle, "the crashed app vanished from the list");
      assertEquals(s.selectedId, dir, "the selection was dropped");
      await t.send.loadLogs(dir);
      const after = t.getState();
      assertEquals(after.logError, null, "a stopped app's log was not found");
      assert(
        after.logs?.some((l) => l.raw.includes("kaboom")),
        `crash log not shown: ${JSON.stringify(after.logs)}`,
      );
    } finally {
      removeLock(lockKey(APP, home));
      try {
        child.kill("SIGKILL");
      } catch { /* gone */ }
      await child.status.catch(() => {});
      keys.forEach((k, i) => {
        const v = prev[i];
        if (v === undefined) Deno.env.delete(k);
        else Deno.env.set(k, v);
      });
      _resetInstanceVerify();
      await dropTempDir(sandbox);
    }
  },
);
