// Two instances of one app on zero-port Unix sockets — the default home and a
// `--profile=dev` one (the shape a packaged/UDS app runs in). Every amui
// control call is `(port, appId)`, and with port 0 both rows are the same
// question: `controlEndpoint` answered it with the DEFAULT instance's lock.
// So the dev row's State tab showed its sibling's state, its Dispatch wrote
// into the sibling, and its Stop shut the sibling down (and reported success).
// The row's pid now picks the instance.
//
// No real app: the "instances" are `sleep` processes holding hand-written
// locks whose sockets do not exist, so the socket each call TRIED is named in
// its error — which is exactly the fact under test.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { testCell } from "../src/testing/cell-test.ts";
import { manager } from "../amui/src/manager.ts";
import { controlEndpoint } from "../src/am/am-http.ts";
import { _resetInstanceVerify } from "../src/am/am-http.ts";
import {
  lockKey,
  removeLock,
  writeLock,
} from "../src/server/single-instance-lock.ts";
import { appHome, profileHome } from "../src/server/app-dirs.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const APP = "amui-fixture-uds";

async function withTwoUdsInstances(
  fn: (
    pids: { dflt: number; dev: number },
    sock: (n: string) => string,
  ) => Promise<void>,
): Promise<void> {
  const sandbox = await tempDir("amui-uds-");
  const dir = `${sandbox}/proj`;
  await Deno.mkdir(dir);
  await Deno.writeTextFile(
    `${dir}/deno.json`,
    JSON.stringify({ name: "udsapp", imports: { aio: "../mod.ts" } }),
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
  const sock = (n: string) => `${sandbox}/${n}.sock`;
  const dflt = appHome(APP);
  const dev = profileHome(APP, "dev");
  const base = {
    appId: APP,
    port: 0,
    startedAt: Date.now(),
    status: "started" as const,
    cwd: dir,
  };
  writeLock({ ...base, pid: a.pid, home: dflt, socketPath: sock("default") });
  writeLock({
    ...base,
    pid: b.pid,
    home: dev,
    profile: "dev",
    socketPath: sock("dev"),
  });
  _resetInstanceVerify();
  try {
    await fn({ dflt: a.pid, dev: b.pid }, sock);
  } finally {
    removeLock(lockKey(APP, dflt));
    removeLock(lockKey(APP, dev, "dev"));
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

Deno.test("controlEndpoint: a pid picks that instance's socket among zero-port siblings", async () => {
  await withTwoUdsInstances((pids, sock) => {
    const dev = controlEndpoint(APP, 0, pids.dev);
    assertEquals(dev.kind === "uds" && dev.socketPath, sock("dev"));
    const dflt = controlEndpoint(APP, 0, pids.dflt);
    assertEquals(dflt.kind === "uds" && dflt.socketPath, sock("default"));
    return Promise.resolve();
  });
});

testCell(
  manager,
  "amui talks to a zero-port profile instance on ITS socket, not the default's",
  async (t) => {
    await withTwoUdsInstances(async (pids, sock) => {
      await t.send.discover();
      const rows = t.getState().projects.filter((p) =>
        p.running?.appId === APP
      );
      assertEquals(rows.length, 2);
      const dev = rows.find((p) => p.running?.pid === pids.dev)!;
      assert(dev, "the dev instance is listed");
      await t.send.select(dev.id);
      await t.send.loadState(dev.id);
      const err = t.getState().detailStateError ?? "";
      assertStringIncludes(err, sock("dev"));
      assert(!err.includes(sock("default")), err);
      await t.send.dispatch(dev.id, "x:y", "");
      const msg = t.getState().dispatchMsg ?? "";
      assertStringIncludes(msg, sock("dev"));
    });
  },
);

// A row's pid that names NO live instance any more — the profile instance
// crashed or was stopped after amui listed it — fell through to "the"
// instance of the app: on zero-port sockets, the DEFAULT one. So a Stop
// clicked on a row that had just died shut its live sibling down (and said
// "stopped"), and a Dispatch wrote into it. A named instance that is gone is
// gone; it is never replaced by another one.
Deno.test("controlEndpoint: a pid that names no live instance never falls back to a sibling's socket", async () => {
  await withTwoUdsInstances((_pids, sock) => {
    // A pid no lock holds (the sleeps' pids are the only ones that do).
    const deadPid = 2 ** 22 + 12345;
    const ep = controlEndpoint(APP, 0, deadPid);
    assert(
      ep.kind !== "uds" || ep.socketPath !== sock("default"),
      `a dead instance's call reached the live default one: ${
        JSON.stringify(ep)
      }`,
    );
    assertEquals(ep.kind, "tcp");
    return Promise.resolve();
  });
});

// …and its Stop then fell back to SIGTERM on the row's bare pid. With the
// instance gone, that pid is anybody's: the kernel reuses it, and amui's Stop
// killed whatever process holds it now. A signal goes only to a pid a live
// lock of THIS app still names (the lock records the owner's start identity).
Deno.test("amui stop never signals a pid no live instance of the app holds", async () => {
  await withTwoUdsInstances(async () => {
    const { stopApp } = await import("../amui/src/server/proc.server.ts");
    const stranger = new Deno.Command("sleep", {
      args: ["60"],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      const r = await stopApp(0, APP, stranger.pid);
      assertEquals(r.ok, false, "a stop of a gone instance is not a success");
      const settled = await Promise.race([
        stranger.status.then(() => "killed"),
        new Promise((res) => setTimeout(() => res("alive"), 300)),
      ]);
      assertEquals(
        settled,
        "alive",
        "the stranger holding the pid was signalled",
      );
    } finally {
      try {
        stranger.kill("SIGKILL");
      } catch { /* gone */ }
      await stranger.status;
    }
  });
});
