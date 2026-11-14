// amui's Restart relaunched an app with ONLY `--client=` (+ profile/home): the
// flags it was started with — recorded by `am start` in ~/.<appId>/launch.json
// precisely so a restart can replay them (`--env-file`, `--port`, `--expose`,
// a custom entry) — were dropped. `am restart` replays them; amui's Restart of
// the same instance came back on another port, unexposed, without its env
// file. And a Start from amui left no record, so a later restart of it had
// nothing to replay.
//
// The "app" is a stand-in: logs its argv, registers its lock like an aio app,
// stays up.
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { testCell } from "../src/testing/cell-test.ts";
import { manager } from "../amui/src/manager.ts";
import {
  instances,
  lockKey,
  readLaunchInfo,
  removeLock,
  writeLaunchInfo,
  writeLock,
} from "../src/server/single-instance-lock.ts";
import { sleeper } from "./proc-helper.ts";
import { appDirs } from "../src/server/app-dirs.ts";
import { _resetInstanceVerify } from "../src/am/am-http.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { launchRecordFor } from "../amui/src/server/proc.server.ts";

const APP = "amui-rflags-fixture";
const REPO = fromFileUrl(new URL("../", import.meta.url));

async function repoImports(): Promise<Record<string, string>> {
  const repo = JSON.parse(await Deno.readTextFile(`${REPO}deno.json`));
  return Object.fromEntries(
    Object.entries(repo.imports as Record<string, string>).map(([k, v]) => [
      k,
      v.startsWith("./") ? `${REPO}${v.slice(2)}` : v,
    ]),
  );
}

async function denoDir(): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "null",
  }).output();
  return JSON.parse(new TextDecoder().decode(out.stdout)).denoDir;
}

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
};

testCell(
  manager,
  "amui restart replays the flags the instance was launched with, and its own start leaves a record",
  async (t) => {
    const sandbox = await tempDir("amui-rflags-");
    const proj = `${sandbox}/roots/proj`;
    await Deno.mkdir(`${proj}/src`, { recursive: true });
    await Deno.mkdir(`${sandbox}/home`);
    await Deno.writeTextFile(
      `${proj}/deno.json`,
      JSON.stringify({
        title: "rflags",
        lock: false,
        imports: await repoImports(),
      }),
    );
    const argvLog = `${sandbox}/argv.log`;
    await Deno.writeTextFile(
      `${proj}/src/app.ts`,
      `import { writeLock } from ${
        JSON.stringify(`${REPO}src/server/single-instance-lock.ts`)
      };
await Deno.writeTextFile(${
        JSON.stringify(argvLog)
      }, JSON.stringify(Deno.args) + "\\n", { append: true });
writeLock({ appId: "${APP}", pid: Deno.pid, port: 0, startedAt: Date.now(),
  status: "started", cwd: Deno.cwd() });
setInterval(() => {}, 1000);
`,
    );
    const keys = ["AIO_APPS_DIR", "AMUI_ROOTS", "HOME", "DENO_DIR"] as const;
    const prev = keys.map((k) => Deno.env.get(k));
    Deno.env.set("DENO_DIR", await denoDir());
    Deno.env.set("AIO_APPS_DIR", `${sandbox}/apps`);
    Deno.env.set("AMUI_ROOTS", `${sandbox}/roots`);
    Deno.env.set("HOME", `${sandbox}/home`);
    _resetInstanceVerify();
    const flags = ["--port=9123", "--expose"];
    const boots = async () =>
      (await Deno.readTextFile(argvLog)).trim().split("\n")
        .map((l) => JSON.parse(l) as string[]);
    const restartRow = async () => {
      await t.send.discover();
      const row = t.getState().projects.find((p) => p.running?.appId === APP);
      assert(row, "fixture instance not discovered");
      await t.send.restart(row.id);
      return t.getState().actionMsg;
    };
    try {
      // The first launch, as `am start --port=9123 --expose` makes it: the
      // process gets the flags, and the launch is recorded for a restart.
      new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "src/app.ts", ...flags, "--client=browser"],
        cwd: proj,
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn().unref();
      assert(
        writeLaunchInfo(APP, { flags, entry: "src/app.ts", cwd: proj }) ===
          null,
      );
      await until(() => instances(APP).some((x) => x.alive));
      let msg = await restartRow();
      let all = await boots();
      assertEquals(all.length, 2, `expected two boots; ${msg}`);
      assert(
        flags.every((f) => all[1]!.includes(f)),
        `restart dropped the recorded launch flags: ${
          JSON.stringify(all[1])
        } (${msg})`,
      );
      // amui's restart re-recorded the launch for the NEW process — so a
      // second restart (amui's or `am restart`) replays it again.
      const rec = readLaunchInfo(APP);
      const live = instances(APP).find((i) => i.alive)!;
      assertEquals(rec?.pid, live.pid, "the relaunch was not recorded");
      msg = await restartRow();
      all = await boots();
      assertEquals(all.length, 3, `expected three boots; ${msg}`);
      assert(
        flags.every((f) => all[2]!.includes(f)),
        `the second restart dropped the flags: ${JSON.stringify(all[2])}`,
      );
    } finally {
      for (const i of instances(APP)) {
        try {
          Deno.kill(i.pid, "SIGKILL");
        } catch { /* gone */ }
        removeLock(lockKey(APP, i.home, i.profile));
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

Deno.test("amui launchRecordFor: a record of another directory, or of a DIFFERENT process, is not this instance's", async () => {
  const sandbox = await tempDir("amui-rflags-match-");
  const prev = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", `${sandbox}/apps`);
  try {
    const dir = `${sandbox}/proj`;
    await Deno.mkdir(dir);
    const home = appDirs(APP).home;
    writeLaunchInfo(APP, { flags: ["--expose"], cwd: dir });
    const inst = { appId: APP, pid: Deno.pid, home };
    assert(launchRecordFor(dir, inst), "a pid-less record of this dir replays");
    assertEquals(launchRecordFor(`${sandbox}/other`, inst), null);
    assertEquals(
      launchRecordFor(dir, { ...inst, home: `${sandbox}/elsewhere` }),
      null,
      "a --home instance is not the default home's record",
    );
    // A record naming ANOTHER process (an old `am start`; the app since run
    // from a terminal) is not replayed onto this one.
    const child = sleeper({ stdin: "null", stdout: "null", stderr: "null" });
    try {
      writeLock({
        appId: APP,
        pid: child.pid,
        port: 0,
        startedAt: Date.now(),
        status: "started",
        cwd: dir,
      });
      const live = { appId: APP, pid: child.pid, home };
      writeLaunchInfo(APP, { flags: ["--expose"], cwd: dir, pid: Deno.pid });
      assertEquals(launchRecordFor(dir, live), null);
      writeLaunchInfo(APP, { flags: ["--expose"], cwd: dir, pid: child.pid });
      assert(launchRecordFor(dir, live), "the record of THIS process replays");
    } finally {
      removeLock(lockKey(APP, home));
      child.kill("SIGKILL");
      await child.status;
    }
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    await dropTempDir(sandbox);
  }
});
