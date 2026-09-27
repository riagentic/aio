// amui Restart of a `--home=<dir>` instance comes back as the DEFAULT instance.
//
// restart() re-launches with `running.profile` only ("Boot the SAME instance
// again: a profile instance restarted without its profile comes back as the
// default one"). An instance started with `--home=<dir>` records `home` in its
// lock but no `profile`, so the relaunch carries neither flag and the app boots
// from its default data home — a different state.db, under the same row. `am`
// addresses such an instance by `--home=<dir>` (stopCommandFor).
//
// Sandboxed exactly like tests/amui-multi-instance.test.ts: the "instance" is
// a `sleep` holding a hand-written lock; the relaunched "app" records its argv.
import { assert } from "@std/assert";
import { testCell } from "../src/testing/cell-test.ts";
import { manager } from "../amui/src/manager.ts";
import {
  lockKey,
  removeLock,
  writeLock,
} from "../src/server/single-instance-lock.ts";
import { _resetInstanceVerify } from "../src/am/am-http.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const APP = "amui-r9-home-fixture";

testCell(
  manager,
  "amui restart of a --home instance boots that home again",
  async (t) => {
    const sandbox = await tempDir("amui-r9-home-");
    const dir = `${sandbox}/proj`;
    const customHome = `${sandbox}/elsewhere/data`;
    await Deno.mkdir(dir);
    await Deno.mkdir(customHome, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({
        name: "homeapp",
        entry: "app.ts",
        imports: { aio: "../mod.ts" },
      }),
    );
    await Deno.writeTextFile(
      `${dir}/app.ts`,
      `await Deno.writeTextFile(new URL("./args.json", import.meta.url), JSON.stringify(Deno.args));\n`,
    );
    const keys = ["AIO_APPS_DIR", "AMUI_ROOTS", "HOME"] as const;
    const prev = keys.map((k) => Deno.env.get(k));
    Deno.env.set("AIO_APPS_DIR", `${sandbox}/apps`);
    Deno.env.set("AMUI_ROOTS", dir);
    Deno.env.set("HOME", sandbox);
    const child = new Deno.Command("sleep", {
      args: ["120"],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    writeLock({
      appId: APP,
      pid: child.pid,
      port: 0,
      startedAt: Date.now(),
      status: "started",
      cwd: dir,
      home: customHome, // `--home=<dir>`: a home, no profile
    });
    _resetInstanceVerify();
    try {
      await t.send.discover();
      const row = t.getState().projects.find((p) =>
        p.running?.pid === child.pid
      );
      assert(row, "fixture instance not discovered");
      assert(row.running?.home === customHome, "lock home not surfaced");
      await t.send.restart(row.id);
      const args: string[] = JSON.parse(
        await Deno.readTextFile(`${dir}/args.json`),
      );
      assert(
        args.some((a) =>
          a === `--home=${customHome}` || a === `--profile=${customHome}`
        ),
        `restarted without its data home — it boots the DEFAULT instance: ${
          JSON.stringify(args)
        }`,
      );
    } finally {
      removeLock(lockKey(APP, customHome));
      try {
        child.kill("SIGKILL");
      } catch { /* gone */ }
      await child.status;
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
