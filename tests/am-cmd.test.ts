// am command coverage — cmdStatus / ensureSingleton / killProcess (process
// lifecycle against real spawned children + real lock files) and the inspect
// commands (against a fake control-port HTTP server). These are the CLI's
// user-facing behaviors; the HTTP seam (trojanGet/Post, httpGet) is exercised
// for real — only the aio server behind it is canned.
import { assert, assertEquals } from "@std/assert";
import {
  cmdInstances,
  cmdStatus,
  cmdStop,
  ensureSingleton,
  killProcess,
} from "../src/am/am-cmd-process.ts";
import {
  cmdClick,
  cmdClient,
  cmdClients,
  cmdConfig,
  cmdDom,
  cmdErrors,
  cmdHealth,
  cmdInteract,
  cmdLog,
  cmdMetrics,
  cmdProfile,
  cmdSchedules,
  cmdSql,
  cmdSurface,
  cmdTables,
  cmdTrigger,
} from "../src/am/am-cmd-inspect.ts";
import { readPid, removePid, writePid } from "../src/am/am-utils.ts";
import { isProcessAlive } from "../src/server/single-instance-lock.ts";
import type { LockData } from "../src/server/single-instance-lock.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";

// ── Harness ──────────────────────────────────────────────────

/** Deno.exit stub — commands exit on error paths; convert to a throw. */
class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}
async function withExitStub(fn: () => Promise<void>): Promise<number | null> {
  const real = Deno.exit;
  let code: number | null = null;
  // deno-lint-ignore no-explicit-any
  (Deno as any).exit = (c?: number) => {
    throw new ExitSignal(c ?? 0);
  };
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
    code = e.code;
  } finally {
    Deno.exit = real;
  }
  return code;
}

/** Capture console.log/error lines emitted by a command. */
async function capture(
  fn: () => Promise<void>,
): Promise<{ logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const l = console.log, e = console.error;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  console.error = (...a: unknown[]) => errors.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.log = l;
    console.error = e;
  }
  return { logs, errors };
}

/** Fake aio control server — answers the trojan/error/health endpoints. */
function fakeControlServer(state: { errorsBody: string }) {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      const url = new URL(req.url);
      const p = url.pathname;
      const json = (d: unknown) =>
        new Response(JSON.stringify(d), {
          headers: { "content-type": "application/json" },
        });
      if (p === "/") return new Response("ok");
      if (p === "/__aio/error") return new Response(state.errorsBody);
      if (p === "/__aio/trojan/clients") {
        return json([{ index: 0, type: "browser" }]);
      }
      if (p === "/__aio/trojan/client/0") return json({ state: { n: 1 } });
      if (p === "/__aio/trojan/metrics") {
        return json({ uptime: 65, connections: 2, schedules: 1 });
      }
      if (p === "/__aio/trojan/schedules") return json([{ id: "tick" }]);
      if (p === "/__aio/trojan/config") return json({ appId: "fake" });
      if (p === "/__aio/trojan/dom/0") return json({ tag: "div" });
      if (p.startsWith("/__aio/trojan/click/0/")) return json({ ok: true });
      if (p === "/__aio/trojan/surface/0") {
        return json([{
          component: "App",
          path: "App",
          elements: [{
            name: "AddButton",
            tag: "button",
            events: ["click"],
            text: "Add",
          }],
          children: [],
        }]);
      }
      if (p === "/__aio/trojan/sql" && req.method === "POST") {
        const body = await req.json() as { query: string };
        if (body.query.includes("sqlite_master")) {
          return json([{ name: "aio_state" }, { name: "sync_ops" }]);
        }
        return json([{ n: 1 }]);
      }
      if (p === "/__aio/trojan/interact/0" && req.method === "POST") {
        return json({ ok: true });
      }
      if (p === "/__aio/trojan/trigger/0" && req.method === "POST") {
        return json({ ok: true, action: "click" });
      }
      return new Response("not found", { status: 404 });
    },
  );
  return server;
}

const flagsFor = (port: number, app: string): GlobalFlags =>
  ({ json: true, port, app }) as GlobalFlags;

function makePf(
  appId: string,
  overrides: Partial<LockData> & { pid: number; port: number },
): LockData {
  return {
    appId,
    startedAt: Date.now(),
    status: "started",
    cwd: Deno.cwd(),
    ...overrides,
  };
}

/** Spawn a child deno process that lives until killed (or for `ms`). */
function spawnChild(ms?: number): Deno.ChildProcess {
  const code = ms
    ? `await new Promise((r) => setTimeout(r, ${ms}))`
    : `await new Promise(() => {})`;
  return new Deno.Command(Deno.execPath(), {
    args: ["eval", code],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
}

// ── killProcess ──────────────────────────────────────────────

Deno.test("am: killProcess terminates a live child (SIGTERM path)", async () => {
  const child = spawnChild();
  assert(isProcessAlive(child.pid));
  await killProcess(child.pid);
  assertEquals(isProcessAlive(child.pid), false);
  await child.status;
});

Deno.test("am: killProcess is a no-op on a dead pid", async () => {
  const child = spawnChild(1);
  await child.status; // already exited
  const t = Date.now();
  await killProcess(child.pid);
  assert(Date.now() - t < 500, "returns immediately for dead pid");
});

// ── ensureSingleton ──────────────────────────────────────────

Deno.test("am: ensureSingleton — no lock file is a no-op", async () => {
  const app = `am-cmd-none-${Deno.pid}`;
  await ensureSingleton(app, "quiet");
  assertEquals(readPid(app), null);
});

Deno.test("am: ensureSingleton — stale lock (dead pid) is reclaimed", async () => {
  const app = `am-cmd-stale-${Deno.pid}`;
  const child = spawnChild(1);
  await child.status;
  writePid(makePf(app, { pid: child.pid, port: 59999 }));
  await ensureSingleton(app, "quiet");
  assertEquals(readPid(app), null, "stale lock removed");
});

Deno.test("am: ensureSingleton — waits out a stopping instance", async () => {
  const app = `am-cmd-stopping-${Deno.pid}`;
  const child = spawnChild(600); // exits on its own while we wait
  writePid(makePf(app, { pid: child.pid, port: 59999, status: "stopping" }));
  try {
    const { logs } = await capture(() => ensureSingleton(app, "json"));
    assertEquals(readPid(app), null, "lock removed after instance stopped");
    assert(
      logs.some((l) => l.includes("stopping")),
      "reports the wait",
    );
  } finally {
    removePid(app);
    await child.status;
  }
});

Deno.test("am: ensureSingleton — responding instance refuses with exit 1", async () => {
  const app = `am-cmd-live-${Deno.pid}`;
  const state = { errorsBody: "null" };
  const server = fakeControlServer(state);
  writePid(makePf(app, { pid: Deno.pid, port: server.addr.port }));
  try {
    const { errors } = await capture(async () => {
      const code = await withExitStub(() => ensureSingleton(app, "json"));
      assertEquals(code, 1);
    });
    assert(errors.some((l) => l.includes("already running")));
  } finally {
    removePid(app);
    await server.shutdown();
  }
});

Deno.test("am: ensureSingleton — unresponsive 'started' zombie is killed", async () => {
  const app = `am-cmd-zombie-${Deno.pid}`;
  const child = spawnChild();
  // Port nothing listens on — health probe fails fast (connection refused).
  writePid(makePf(app, { pid: child.pid, port: 1 }));
  try {
    const { logs } = await capture(() => ensureSingleton(app, "json"));
    assertEquals(isProcessAlive(child.pid), false, "zombie killed");
    assertEquals(readPid(app), null, "lock removed");
    assert(logs.some((l) => l.includes("unresponsive")));
  } finally {
    removePid(app);
    await child.status;
  }
});

// ── cmdStatus ────────────────────────────────────────────────

Deno.test("am: cmdStatus — no lock → stopped, exit 1", async () => {
  const app = `am-cmd-status-none-${Deno.pid}`;
  const { logs } = await capture(async () => {
    const code = await withExitStub(() => cmdStatus([], flagsFor(1, app)));
    assertEquals(code, 1);
  });
  assertEquals(JSON.parse(logs[0]!).status, "stopped");
});

Deno.test("am: cmdStatus — stale lock cleaned, reports stopped", async () => {
  const app = `am-cmd-status-stale-${Deno.pid}`;
  const child = spawnChild(1);
  await child.status;
  writePid(makePf(app, { pid: child.pid, port: 59999 }));
  const { logs } = await capture(async () => {
    const code = await withExitStub(() => cmdStatus([], flagsFor(1, app)));
    assertEquals(code, 1);
  });
  assertEquals(JSON.parse(logs[0]!).status, "stopped");
  assertEquals(readPid(app), null);
});

Deno.test("am: cmdStatus — stopping instance reports exit 2", async () => {
  const app = `am-cmd-status-stopping-${Deno.pid}`;
  writePid(makePf(app, { pid: Deno.pid, port: 59999, status: "stopping" }));
  try {
    const { logs } = await capture(async () => {
      const code = await withExitStub(() => cmdStatus([], flagsFor(1, app)));
      assertEquals(code, 2);
    });
    assertEquals(JSON.parse(logs[0]!).status, "stopping");
  } finally {
    removePid(app);
  }
});

Deno.test("am: cmdStatus — responding instance reports started + metrics", async () => {
  const app = `am-cmd-status-up-${Deno.pid}`;
  const server = fakeControlServer({ errorsBody: "null" });
  writePid(makePf(app, { pid: Deno.pid, port: server.addr.port }));
  try {
    const { logs } = await capture(() =>
      cmdStatus([], flagsFor(server.addr.port, app))
    );
    const st = JSON.parse(logs[0]!);
    assertEquals(st.status, "started");
    assertEquals(st.uptime, 65);
    assertEquals(st.connections, 2);
    assertEquals(st.transport, "ws");
  } finally {
    removePid(app);
    await server.shutdown();
  }
});

Deno.test("am: cmdStatus — auto-heals a stuck 'starting' lock to started", async () => {
  const app = `am-cmd-status-heal-${Deno.pid}`;
  const server = fakeControlServer({ errorsBody: "null" });
  writePid(
    makePf(app, { pid: Deno.pid, port: server.addr.port, status: "starting" }),
  );
  try {
    await capture(() => cmdStatus([], flagsFor(server.addr.port, app)));
    assertEquals(readPid(app)?.status, "started", "lock status auto-fixed");
  } finally {
    removePid(app);
    await server.shutdown();
  }
});

Deno.test("am: cmdStatus — alive but not responding reports starting, exit 2", async () => {
  const app = `am-cmd-status-starting-${Deno.pid}`;
  writePid(makePf(app, { pid: Deno.pid, port: 1, status: "started" }));
  try {
    const { logs } = await capture(async () => {
      const code = await withExitStub(() => cmdStatus([], flagsFor(1, app)));
      assertEquals(code, 2);
    });
    assertEquals(JSON.parse(logs[0]!).status, "starting");
  } finally {
    removePid(app);
  }
});

Deno.test("am: cmdInstances — lists the written lock in json mode", async () => {
  const app = `am-cmd-instances-${Deno.pid}`;
  writePid(makePf(app, { pid: Deno.pid, port: 59999 }));
  try {
    const { logs } = await capture(() =>
      Promise.resolve(cmdInstances([], { json: true } as GlobalFlags))
    );
    const all = JSON.parse(logs[0]!) as { appId: string }[];
    assert(Array.isArray(all));
    assert(all.some((i) => i.appId === app), "written instance listed");
  } finally {
    removePid(app);
  }
});

// ── Inspect commands (fake control server) ───────────────────

Deno.test("am: inspect commands answer over the control port", async () => {
  const app = `am-cmd-inspect-${Deno.pid}`;
  const state = { errorsBody: JSON.stringify({ errors: ["boom"] }) };
  const server = fakeControlServer(state);
  const flags = flagsFor(server.addr.port, app);
  try {
    let r = await capture(() => cmdClients([], flags));
    assertEquals(JSON.parse(r.logs[0]!)[0].type, "browser");

    r = await capture(() => cmdClient(["0"], flags));
    assertEquals(JSON.parse(r.logs[0]!).state.n, 1);

    r = await capture(() => cmdMetrics([], flags));
    assertEquals(JSON.parse(r.logs[0]!).uptime, 65);

    r = await capture(() => cmdSchedules([], flags));
    assertEquals(JSON.parse(r.logs[0]!)[0].id, "tick");

    r = await capture(() => cmdConfig([], flags));
    assertEquals(JSON.parse(r.logs[0]!).appId, "fake");

    r = await capture(() => cmdSql(["SELECT 1"], flags));
    assertEquals(JSON.parse(r.logs[0]!)[0].n, 1);

    r = await capture(() => cmdTables([], flags));
    assertEquals(JSON.parse(r.logs[0]!), ["aio_state", "sync_ops"]);

    r = await capture(() => cmdDom(["0"], flags));
    assertEquals(JSON.parse(r.logs[0]!).tag, "div");

    r = await capture(() => cmdClick(["0", "AddButton"], flags));
    assertEquals(JSON.parse(r.logs[0]!).ok, true);

    r = await capture(() => cmdInteract(["click", "button"], flags));
    assertEquals(JSON.parse(r.logs[0]!).ok, true);

    r = await capture(() => cmdSurface(["0"], flags));
    assertEquals(JSON.parse(r.logs[0]!)[0].component, "App");

    r = await capture(() => cmdTrigger(["0", "App:AddButton", "click"], flags));
    assertEquals(JSON.parse(r.logs[0]!).ok, true);

    r = await capture(() => cmdHealth([], flags));
    assertEquals(JSON.parse(r.logs[0]!).healthy, true);

    r = await capture(() => cmdErrors([], flags));
    assertEquals(JSON.parse(r.logs[0]!).errors, ["boom"]);

    state.errorsBody = "null"; // no errors case
    r = await capture(() => cmdErrors([], flags));
    assertEquals(JSON.parse(r.logs[0]!).errors, []);
  } finally {
    await server.shutdown();
  }
});

Deno.test("am: inspect usage errors exit 1 without touching the server", async () => {
  const app = `am-cmd-usage-${Deno.pid}`;
  const flags = flagsFor(1, app); // nothing listens on port 1
  const cases: [string, () => Promise<void>][] = [
    ["client", () => cmdClient([], flags)],
    ["click", () => cmdClick([], flags)],
    ["interact-no-args", () => cmdInteract([], flags)],
    ["interact-bad-action", () => cmdInteract(["explode", "sel"], flags)],
    ["sql-empty", () => cmdSql([], flags)],
    ["dom-bad-idx", () => cmdDom(["-1"], flags)],
    ["trigger-bad", () => cmdTrigger(["x", "", "click"], flags)],
  ];
  for (const [name, fn] of cases) {
    const { errors } = await capture(async () => {
      const code = await withExitStub(fn);
      assertEquals(code, 1, `${name} exits 1`);
    });
    assert(errors.length > 0, `${name} prints usage`);
  }
});

Deno.test("am: unreachable server → clean error + exit 1", async () => {
  const app = `am-cmd-unreach-${Deno.pid}`;
  const flags = flagsFor(1, app);
  const { errors } = await capture(async () => {
    const code = await withExitStub(() => cmdClients([], flags));
    assertEquals(code, 1);
  });
  assert(errors.length > 0, "reports the connection failure");
});

Deno.test("am: cmdHealth — unreachable reports unhealthy, exit 1", async () => {
  const app = `am-cmd-health-down-${Deno.pid}`;
  const { logs } = await capture(async () => {
    const code = await withExitStub(() => cmdHealth([], flagsFor(1, app)));
    assertEquals(code, 1);
  });
  assertEquals(JSON.parse(logs[0]!).healthy, false);
});

Deno.test("am: cmdProfile — no running app → error + exit 1", async () => {
  const app = `am-cmd-profile-none-${Deno.pid}`;
  const { errors } = await capture(async () => {
    const code = await withExitStub(() =>
      cmdProfile([], { json: true, app } as GlobalFlags)
    );
    assertEquals(code, 1);
  });
  assert(errors.some((l) => l.includes("no running app")));
});

// ── cmdLog ───────────────────────────────────────────────────

Deno.test("am: cmdLog — tails and filters .aio.log (json mode)", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "am-cmd-log-" });
  const cwd = Deno.cwd();
  try {
    Deno.chdir(tmp);
    await Deno.writeTextFile(
      ".aio.log",
      "INFO boot\nERROR boom\nINFO tick\nERROR crash\n",
    );
    const { logs } = await capture(() =>
      cmdLog(["error"], { json: true } as GlobalFlags)
    );
    const parsed = JSON.parse(logs[0]!) as { shown: number; lines: string[] };
    assertEquals(parsed.lines.filter((l) => l.includes("ERROR")).length, 2);
  } finally {
    Deno.chdir(cwd);
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("am: cmdLog — missing log file reports cleanly", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "am-cmd-nolog-" });
  const cwd = Deno.cwd();
  try {
    Deno.chdir(tmp);
    const { errors } = await capture(() =>
      cmdLog([], { json: true } as GlobalFlags)
    );
    assert(errors.some((l) => l.includes("no log file")));
  } finally {
    Deno.chdir(cwd);
    await Deno.remove(tmp, { recursive: true });
  }
});

// ── cmdStop ──────────────────────────────────────────────────

Deno.test("am: cmdStop — no lock and no --port refuses with exit 1", async () => {
  const app = `am-cmd-stop-none-${Deno.pid}`;
  const { errors } = await capture(async () => {
    const code = await withExitStub(() =>
      cmdStop([], { json: true, app } as GlobalFlags)
    );
    assertEquals(code, 1);
  });
  assert(errors.some((l) => l.includes("not running")));
});

Deno.test("am: cmdStop — SIGTERM fallback stops an unresponsive child", async () => {
  const app = `am-cmd-stop-kill-${Deno.pid}`;
  const child = spawnChild();
  // Port nothing listens on → graceful trojan shutdown fails → SIGTERM path.
  writePid(makePf(app, { pid: child.pid, port: 1 }));
  try {
    const { logs } = await capture(() =>
      cmdStop([], { json: true, app, wait: 3 } as GlobalFlags)
    );
    assertEquals(isProcessAlive(child.pid), false, "child stopped");
    assertEquals(readPid(app), null, "lock removed");
    assertEquals(JSON.parse(logs.at(-1)!).status, "stopped");
  } finally {
    removePid(app);
    await child.status;
  }
});

Deno.test("am: cmdStop — without --wait returns immediately as stopping", async () => {
  const app = `am-cmd-stop-async-${Deno.pid}`;
  const child = spawnChild();
  writePid(makePf(app, { pid: child.pid, port: 1 }));
  try {
    const { logs } = await capture(() =>
      cmdStop([], { json: true, app } as GlobalFlags)
    );
    assertEquals(JSON.parse(logs[0]!).status, "stopping");
    assertEquals(readPid(app)?.status, "stopping", "lock marked stopping");
  } finally {
    await killProcess(child.pid, 0);
    removePid(app);
    await child.status;
  }
});
