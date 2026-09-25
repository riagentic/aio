// Two instances running from ONE directory — two profiles, two components,
// two binaries in one `dist/` — are two apps. amui keyed its list, selection,
// and Stop by the directory, so the second instance overwrote the first in the
// list (one vanished) and Stop went to whichever entry happened to win.
// Sandboxed: AIO_APPS_DIR scopes the lock registry and HOME / AMUI_ROOTS the
// disk scan to a temp dir, so no real running app is ever seen or touched.
// The "instances" are `sleep` processes holding hand-written locks.
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { testCell } from "../src/testing/cell-test.ts";
import { manager } from "../amui/src/manager.ts";
import type { DiscoveredProject } from "../amui/src/manager.ts";
import {
  isProcessAlive,
  removeLock,
  writeLock,
} from "../src/server/single-instance-lock.ts";
import { _resetInstanceVerify } from "../src/am/am-http.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const APP = "amui-fixture-multi";

async function withTwoInstances(
  fn: (dir: string, pids: { dflt: number; dev: number }) => Promise<void>,
): Promise<void> {
  const sandbox = await tempDir("amui-multi-");
  const dir = `${sandbox}/proj`;
  await Deno.mkdir(dir);
  await Deno.writeTextFile(
    `${dir}/deno.json`,
    JSON.stringify({
      name: "multi",
      entry: "app.ts",
      imports: { aio: "../mod.ts" },
    }),
  );
  // The "app" a restart boots: records how it was launched, then exits.
  await Deno.writeTextFile(
    `${dir}/app.ts`,
    `await Deno.writeTextFile(new URL("./args.json", import.meta.url), JSON.stringify(Deno.args));\n`,
  );
  const keys = ["AIO_APPS_DIR", "AMUI_ROOTS", "HOME"] as const;
  const prev = keys.map((k) => Deno.env.get(k));
  Deno.env.set("AIO_APPS_DIR", `${sandbox}/apps`);
  Deno.env.set("AMUI_ROOTS", dir);
  Deno.env.set("HOME", sandbox);
  const spawn = () =>
    new Deno.Command("sleep", {
      args: ["120"],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
  const a = spawn();
  const b = spawn();
  const devHome = `${sandbox}/apps/.${APP}-dev`;
  writeLock({
    appId: APP,
    pid: a.pid,
    port: 0,
    startedAt: Date.now(),
    status: "started",
    cwd: dir,
  });
  writeLock({
    appId: APP,
    pid: b.pid,
    port: 0,
    startedAt: Date.now(),
    status: "started",
    cwd: dir,
    home: devHome,
    profile: "dev",
  });
  _resetInstanceVerify();
  try {
    await fn(dir, { dflt: a.pid, dev: b.pid });
  } finally {
    removeLock(APP);
    removeLock(`${APP}@dev`);
    for (const c of [a, b]) {
      try {
        c.kill("SIGKILL");
      } catch { /* gone */ }
      await c.status;
    }
    keys.forEach((k, i) => {
      const v = prev[i];
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    });
    _resetInstanceVerify();
    await dropTempDir(sandbox);
  }
}

testCell(
  manager,
  "amui lists two instances from one directory apart and stops the one selected",
  async (t) => {
    await withTwoInstances(async (dir, pids) => {
      await t.send.discover();
      const here = t.getState().projects.filter((p) => p.path === dir);
      assertEquals(here.length, 2, "one instance vanished from the list");
      assertNotEquals(here[0]!.id, here[1]!.id);
      assertNotEquals(here[0]!.name, here[1]!.name, "two identical rows");
      const dev = here.find((p) => p.running?.pid === pids.dev)!;
      assertEquals(dev.running?.profile, "dev");

      await t.send.select(dev.id);
      assertEquals(
        t.getState().detail?.pid,
        pids.dev,
        "selected the wrong one",
      );
      assertEquals(t.getState().selectedPath, dir, "files still read the dir");

      await t.send.stop(dev.id);
      assert(!isProcessAlive(pids.dev), "the selected instance kept running");
      assert(isProcessAlive(pids.dflt), "Stop hit the sibling instance");
      assertEquals(
        t.getState().actionMsg,
        "stopped multi (dev)",
        "a sibling still up read as a failed stop",
      );
      const left = t.getState().projects.filter((p) => p.path === dir);
      assertEquals(left.map((p) => p.running?.pid), [pids.dflt]);
    });
  },
);

testCell(
  manager,
  "amui: a directory two instances share is not a Stop target by itself",
  async (t) => {
    await withTwoInstances(async (dir, pids) => {
      await t.send.discover();
      await t.send.stop(dir);
      assert(isProcessAlive(pids.dev) && isProcessAlive(pids.dflt));
      assert((t.getState().actionMsg ?? "").includes("several instances"));
    });
  },
);

testCell(
  manager,
  "amui restart of a profile instance boots that profile and waits for IT",
  async (t) => {
    await withTwoInstances(async (dir, pids) => {
      await t.send.discover();
      const dev = t.getState().projects.find((p) =>
        p.running?.pid === pids.dev
      )!;
      await t.send.restart(dev.id);
      assert(isProcessAlive(pids.dflt), "restart hit the sibling instance");
      const args = JSON.parse(await Deno.readTextFile(`${dir}/args.json`));
      assert(
        args.includes("--profile=dev"),
        `restarted without its profile: ${args}`,
      );
      // The relaunched "app" exits without registering; the sibling that was
      // up all along must not read as this restart succeeding.
      assert(
        (t.getState().actionMsg ?? "").includes("failed to restart"),
        t.getState().actionMsg ?? "",
      );
    });
  },
);

// Selecting app B after app A's state was refused as too large painted A's
// "state is too large" banner (and A's control-plane error) on B until B's
// own state arrived — select() reset the state payload but not its flags.
testCell(
  manager,
  "amui select clears the previous app's too-large banner and errors",
  async (t) => {
    const dirB = await tempDir("amui-sel-b-");
    try {
      const meta = {
        name: "",
        version: null,
        target: null,
        tasks: {},
        isAio: true,
        entry: null,
      };
      const b: DiscoveredProject = {
        id: dirB,
        path: dirB,
        name: "b",
        meta,
        running: null,
        git: false,
      };
      t.init({
        projects: [b],
        selectedId: "/a",
        selectedPath: "/a",
        detailStatePath: "/a",
        detailStateTruncated: true,
        detailStateSize: 3_000_000,
        controlError: "app A refused",
        logTruncated: true,
      });
      await t.send.select(dirB);
      const s = t.getState();
      assertEquals(s.selectedId, dirB);
      assertEquals(s.detailStateTruncated, false, "A's too-large banner on B");
      assertEquals(s.detailStateSize, 0);
      assertEquals(s.controlError, null, "A's control error on B");
      assertEquals(s.logTruncated, false);
    } finally {
      await dropTempDir(dirB);
    }
  },
);

// The Logs tab of a PROFILE instance tailed `appDirs(appId).logs` — the
// DEFAULT home's logs (`~/.<appId>/logs`), i.e. the sibling instance's — while
// the selected instance wrote its own under its profile home. The lock's
// `home` is the instance's; the log dir is under it.
testCell(
  manager,
  "amui Logs tab of a profile instance tails that instance's own log dir",
  async (t) => {
    await withTwoInstances(async (_dir, pids) => {
      const sandbox = Deno.env.get("HOME")!;
      const devLogs = `${sandbox}/apps/.${APP}-dev/logs`;
      const dfltLogs = `${sandbox}/apps/${APP}/logs`;
      await Deno.mkdir(devLogs, { recursive: true });
      await Deno.mkdir(dfltLogs, { recursive: true });
      await Deno.writeTextFile(`${devLogs}/app.log`, "DEV-INSTANCE-LINE\n");
      await Deno.writeTextFile(
        `${dfltLogs}/app.log`,
        "DEFAULT-INSTANCE-LINE\n",
      );
      await t.send.discover();
      const byPid = (pid: number) =>
        t.getState().projects.find((p) => p.running?.pid === pid)!;
      for (
        const [pid, want, logs] of [
          [pids.dev, "DEV-INSTANCE-LINE", devLogs],
          [pids.dflt, "DEFAULT-INSTANCE-LINE", dfltLogs],
        ] as const
      ) {
        const e = byPid(pid);
        await t.send.select(e.id);
        await t.send.loadLogs(e.id, "app");
        const s = t.getState();
        assertEquals(
          s.logPath,
          `${logs}/app.log`,
          "tailed another instance's log",
        );
        assertEquals((s.logs ?? []).map((l) => l.raw), [want]);
      }
    });
  },
);
