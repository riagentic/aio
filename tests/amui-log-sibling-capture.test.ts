// amui's Logs tab (combined) of one instance showed a SIBLING instance's
// stdout. amui's launcher capture was ONE file per directory
// (`<cwd>/.aio-amui-start.log`), and the combined source ranks captures by
// freshness only. Two instances of one app run from one directory (a default
// and a `--profile=dev`, listed as two rows): the dev one was restarted from
// amui and is chatty, the default one is idle — the DEFAULT row's Logs showed
// the dev instance's output, under the default instance's name.
//
// Now: a restart captures into the instance's own log dir, and a
// per-directory file is never attributed to an instance while another one
// runs from that directory.
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
import { sleeper } from "./proc-helper.ts";
import { instanceLogPath, readLogs } from "../amui/src/server/proc.server.ts";

const APP = "amui-logsib-fixture";

testCell(
  manager,
  "amui: the combined log of one instance never shows a sibling instance's capture",
  async (t) => {
    const sandbox = await tempDir("amui-logsib-");
    const dir = `${sandbox}/roots/proj`;
    const homeDefault = `${sandbox}/apps/${APP}`;
    const homeDev = `${sandbox}/apps/${APP}-dev`;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.mkdir(`${sandbox}/home`);
    await Deno.mkdir(`${homeDefault}/logs`, { recursive: true });
    await Deno.mkdir(`${homeDev}/logs`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({ title: "proj", imports: { aio: "../mod.ts" } }),
    );
    // The default instance's own framework log — a minute old (idle app).
    const fw = `${homeDefault}/logs/app.log`;
    await Deno.writeTextFile(
      fw,
      "2026-11-14 10:00:00.000  INFO   app         DEFAULT-INSTANCE-LINE\n",
    );
    const old = new Date(Date.now() - 60_000);
    await Deno.utime(fw, old, old);
    // The per-directory capture, fresh — written by the dev instance.
    await Deno.writeTextFile(
      `${dir}/.aio-amui-start.log`,
      "DEV-PROFILE-STDOUT dev output\n",
    );
    const keys = ["AIO_APPS_DIR", "AMUI_ROOTS", "HOME"] as const;
    const prev = keys.map((k) => Deno.env.get(k));
    Deno.env.set("AIO_APPS_DIR", `${sandbox}/apps`);
    Deno.env.set("AMUI_ROOTS", `${sandbox}/roots`);
    Deno.env.set("HOME", `${sandbox}/home`);
    _resetInstanceVerify();
    const quiet = { stdin: "null", stdout: "null", stderr: "null" } as const;
    const a = sleeper(quiet);
    const b = sleeper(quiet);
    try {
      writeLock({
        appId: APP,
        pid: a.pid,
        port: 0,
        startedAt: Date.now(),
        status: "started",
        cwd: dir,
        home: homeDefault,
      });
      writeLock({
        appId: APP,
        pid: b.pid,
        port: 0,
        startedAt: Date.now(),
        status: "started",
        cwd: dir,
        home: homeDev,
        profile: "dev",
      });
      await t.send.discover();
      const rows = t.getState().projects.filter((p) => p.path === dir);
      assertEquals(rows.length, 2, "two rows expected");
      const def = rows.find((p) => p.running?.pid === a.pid)!;
      await t.send.select(def.id);
      await t.send.loadLogs(def.id, "combined");
      const s = t.getState();
      const text = (s.logs ?? []).map((l) => l.raw).join("\n");
      assert(
        !text.includes("DEV-PROFILE-STDOUT"),
        `the DEFAULT instance's Logs tab shows a shared directory's capture ` +
          `(read ${s.logPath}): ${text}`,
      );
      assert(text.includes("DEFAULT-INSTANCE-LINE"), text);

      // A restart's capture is the instance's own, in its own home — read
      // for that instance, never for its sibling.
      const devCapture = instanceLogPath(APP, homeDev);
      assertEquals(devCapture, `${homeDev}/logs/amui-stdout.log`);
      await Deno.writeTextFile(devCapture!, "DEV-OWN-CAPTURE\n");
      const dev = await readLogs(dir, "combined", 500, APP, homeDev, true);
      assert(dev.lines.join("\n").includes("DEV-OWN-CAPTURE"), dev.path!);
      const mine = await readLogs(dir, "combined", 500, APP, homeDefault, true);
      assert(!mine.lines.join("\n").includes("DEV-OWN-CAPTURE"), mine.path!);
    } finally {
      removeLock(lockKey(APP, homeDefault));
      removeLock(lockKey(APP, homeDev, "dev"));
      for (const c of [a, b]) {
        try {
          c.kill("SIGKILL");
        } catch { /* gone */ }
        await c.status.catch(() => {});
      }
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
