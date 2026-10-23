// amui launched every app as `--client=browser`.
//
// Restart forced `browser` on the instance it relaunched, whatever it ran: a
// `--client=server-only` service (no App.tsx) came back REFUSED — "App.tsx
// not found" — so Restart killed a healthy app for good, and an electron app
// came back as a browser tab. Start did the same to a project whose deno.json
// declares `"client": "server-only"`. The relaunch must carry the instance's
// recorded client (restart) or the project's declared headless one (start).
//
// Sandboxed like tests/amui-restart-keeps-home.test.ts: the "instance" is a
// sleeper holding a hand-written lock; the relaunched "app" records its argv.
import { SLEEP_ARGS } from "./proc-helper.ts";
import { assert, assertEquals } from "@std/assert";
import { testCell } from "../src/testing/cell-test.ts";
import { manager } from "../amui/src/manager.ts";
import { launchClient } from "../amui/src/server/proc.server.ts";
import {
  lockKey,
  removeLock,
  writeLock,
} from "../src/server/single-instance-lock.ts";
import { _resetInstanceVerify } from "../src/am/am-http.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const APP = "amui-r3-client-fixture";

Deno.test("amui launchClient: recorded wins, then a declared headless client, else browser", () => {
  assertEquals(launchClient("server-only", null), "server-only");
  assertEquals(launchClient("electron", "server-only"), "electron");
  assertEquals(launchClient(undefined, "server-only"), "server-only");
  // What `am create --target=server` writes — the runtime reads it as no UI.
  assertEquals(launchClient(undefined, "server"), "server-only");
  assertEquals(launchClient(undefined, "cli"), "cli");
  assertEquals(launchClient(undefined, "electron"), "browser");
  assertEquals(launchClient(undefined, null), "browser");
  assertEquals(launchClient("bogus", null), "browser");
});

async function fixture(sandbox: string, declared?: string) {
  const dir = `${sandbox}/proj`;
  await Deno.mkdir(dir);
  await Deno.writeTextFile(
    `${dir}/deno.json`,
    JSON.stringify({
      name: "svc",
      entry: "app.ts",
      ...(declared ? { client: declared } : {}),
      imports: { aio: "../mod.ts" },
    }),
  );
  await Deno.writeTextFile(
    `${dir}/app.ts`,
    `await Deno.writeTextFile(new URL("./args.json", import.meta.url), JSON.stringify(Deno.args));\n`,
  );
  return dir;
}

async function withEnv(sandbox: string, dir: string, fn: () => Promise<void>) {
  const keys = ["AIO_APPS_DIR", "AMUI_ROOTS", "HOME", "AIO_NO_OPEN"] as const;
  const prev = keys.map((k) => Deno.env.get(k));
  Deno.env.set("AIO_APPS_DIR", `${sandbox}/apps`);
  Deno.env.set("AMUI_ROOTS", dir);
  Deno.env.set("HOME", sandbox);
  Deno.env.set("AIO_NO_OPEN", "1");
  _resetInstanceVerify();
  try {
    await fn();
  } finally {
    keys.forEach((k, i) => {
      const v = prev[i];
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    });
    _resetInstanceVerify();
  }
}

const argsOf = async (dir: string): Promise<string[]> =>
  JSON.parse(await Deno.readTextFile(`${dir}/args.json`));

testCell(
  manager,
  "amui restart relaunches a server-only instance as server-only",
  async (t) => {
    const sandbox = await tempDir("amui-r3-client-");
    const dir = await fixture(sandbox);
    const child = new Deno.Command(Deno.execPath(), {
      args: SLEEP_ARGS,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      await withEnv(sandbox, dir, async () => {
        writeLock({
          appId: APP,
          pid: child.pid,
          port: 0,
          startedAt: Date.now(),
          status: "started",
          cwd: dir,
          client: "server-only",
        });
        await t.send.discover();
        const row = t.getState().projects.find((p) =>
          p.running?.pid === child.pid
        );
        assert(row, "fixture instance not discovered");
        await t.send.restart(row.id);
        const args = await argsOf(dir);
        assert(
          args.includes("--client=server-only"),
          `restarted under another client: ${JSON.stringify(args)}`,
        );
      });
    } finally {
      removeLock(lockKey(APP));
      try {
        child.kill("SIGKILL");
      } catch { /* gone */ }
      await child.status;
      await dropTempDir(sandbox);
    }
  },
);

testCell(
  manager,
  'amui start honours a project\'s declared no-UI client (`client: "server"`, as am create writes it)',
  async (t) => {
    const sandbox = await tempDir("amui-r3-client-start-");
    const dir = await fixture(sandbox, "server");
    try {
      await withEnv(sandbox, dir, async () => {
        await t.send.discover();
        const row = t.getState().projects.find((p) => p.path === dir);
        assert(row && !row.running, "idle fixture project not discovered");
        await t.send.start(row.id);
        const args = await argsOf(dir);
        assert(
          args.includes("--client=server-only"),
          `started under another client: ${JSON.stringify(args)}`,
        );
      });
    } finally {
      await dropTempDir(sandbox);
    }
  },
);
