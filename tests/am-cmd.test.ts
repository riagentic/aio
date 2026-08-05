// am command coverage — cmdStatus / ensureSingleton / killProcess (process
// lifecycle against real spawned children + real lock files) and the inspect
// commands (against a fake control-port HTTP server). These are the CLI's
// user-facing behaviors; the HTTP seam (trojanGet/Post, httpGet) is exercised
// for real — only the aio server behind it is canned.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  cmdInstances,
  cmdStatus,
  cmdStop,
  ensureSingleton,
  killProcess,
} from "../src/am/am-cmd-process.ts";
import {
  cmdClient,
  cmdClients,
  cmdConfig,
  cmdErrors,
  cmdHealth,
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
    ["sql-empty", () => cmdSql([], flags)],
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

Deno.test("am: cmdLog — missing log file reports cleanly (and exits 1)", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "am-cmd-nolog-" });
  const cwd = Deno.cwd();
  try {
    Deno.chdir(tmp);
    // Nothing to tail is a FAILURE, not a quiet note: `am log | grep …` in a
    // script must not see a success. The message names the path it searched.
    const { errors } = await capture(async () => {
      const code = await withExitStub(() =>
        cmdLog([], { json: true } as GlobalFlags)
      );
      assertEquals(code, 1);
    });
    assert(errors.some((l) => l.includes("no log file at")));
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

// ── cmdLink (am link / am fix) — make a cloned dep/aio app buildable ─────────
import { cmdLink } from "../src/am/am-cmd-link.ts";
import { join as joinPath } from "@std/path";

Deno.test("cmdLink: links a fresh dep/aio clone, idempotent, skips JSR apps", async () => {
  const orig = Deno.cwd();
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  const dir = await Deno.makeTempDir();
  const jsrDir = await Deno.makeTempDir();
  try {
    // A cloned dep/aio app with NO dep/ (the broken state).
    await Deno.writeTextFile(
      joinPath(dir, "deno.json"),
      JSON.stringify({ imports: { aio: "./dep/aio/mod.ts" } }),
    );
    Deno.chdir(dir);

    // Fresh link → creates the symlink.
    logs.length = 0;
    await cmdLink([], { json: true } as never);
    const r1 = JSON.parse(logs[0]!);
    assertEquals(r1.linked, true);
    assertEquals(r1.changed, true);
    const target = await Deno.readLink(joinPath(dir, "dep", "aio"));
    assert(target.length > 0, "dep/aio symlink created");

    // Idempotent — second run detects it's already linked.
    logs.length = 0;
    await cmdLink([], { json: true } as never);
    assertEquals(JSON.parse(logs[0]!).changed, false);

    // A JSR-pinned app has no dep/aio to link.
    await Deno.writeTextFile(
      joinPath(jsrDir, "deno.json"),
      JSON.stringify({ imports: { aio: "jsr:@riagentic/aio" } }),
    );
    Deno.chdir(jsrDir);
    logs.length = 0;
    await cmdLink([], { json: true } as never);
    assertEquals(JSON.parse(logs[0]!).linked, false);
  } finally {
    console.log = realLog;
    Deno.chdir(orig);
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(jsrDir, { recursive: true });
  }
});

// ── cmdFix (am fix) — repair a cloned app: symlink, .env, chmod, config ──────
import { cmdFix } from "../src/am/am-cmd-fix.ts";

Deno.test("cmdFix: fixes dep/aio link, .env, and non-exec scripts", async () => {
  const orig = Deno.cwd();
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      joinPath(dir, "deno.json"),
      JSON.stringify({
        imports: { aio: "./dep/aio/mod.ts" },
        tasks: { seed: "bash scripts/seed.sh" },
        unstable: ["kv"],
      }),
    );
    await Deno.mkdir(joinPath(dir, "scripts"));
    await Deno.writeTextFile(
      joinPath(dir, "scripts", "seed.sh"),
      "#!/bin/bash",
    );
    await Deno.chmod(joinPath(dir, "scripts", "seed.sh"), 0o644); // not exec
    await Deno.writeTextFile(joinPath(dir, ".env.example"), "K=v"); // .env missing
    Deno.chdir(dir);

    // dry-run: reports fixable, changes nothing
    logs.length = 0;
    await cmdFix(["--dry-run"], { json: true } as never);
    const dr = JSON.parse(logs[0]!);
    assert(dr.wouldFix >= 3, `dry-run finds fixable issues (${dr.wouldFix})`);
    assert(
      !(await Deno.stat(joinPath(dir, ".env")).catch(() => null)),
      "dry-run made no .env",
    );

    // apply
    logs.length = 0;
    await cmdFix([], { json: true } as never);
    const r = JSON.parse(logs[0]!);
    assert(r.fixed >= 3, `applied fixes (${r.fixed})`);
    assert(
      (await Deno.readLink(joinPath(dir, "dep", "aio"))).length > 0,
      "dep/aio linked",
    );
    assert(
      await Deno.stat(joinPath(dir, ".env")).then(() => true),
      ".env created",
    );
    const mode = (await Deno.stat(joinPath(dir, "scripts", "seed.sh"))).mode ??
      0;
    assert((mode & 0o111) !== 0, "script made executable");
  } finally {
    console.log = realLog;
    Deno.chdir(orig);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cmdFix: never destroys a vendored dep/aio; skips JSR apps", async () => {
  const orig = Deno.cwd();
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  const vend = await Deno.makeTempDir();
  const jsr = await Deno.makeTempDir();
  try {
    // A committed vendored copy — a real dep/aio DIRECTORY with mod.ts.
    await Deno.mkdir(joinPath(vend, "dep", "aio"), { recursive: true });
    await Deno.writeTextFile(
      joinPath(vend, "dep", "aio", "mod.ts"),
      "export const x=1;",
    );
    await Deno.writeTextFile(
      joinPath(vend, "deno.json"),
      JSON.stringify({ imports: { aio: "./dep/aio/mod.ts" } }),
    );
    Deno.chdir(vend);
    logs.length = 0;
    await cmdFix([], { json: true } as never);
    const r = JSON.parse(logs[0]!);
    const link = r.results.find((x: { name: string }) =>
      x.name === "dep/aio framework link"
    );
    assertEquals(link.outcome, "ok"); // vendored → untouched, not "fixed"
    const st = await Deno.lstat(joinPath(vend, "dep", "aio"));
    assert(
      st.isDirectory && !st.isSymlink,
      "vendored dir preserved (not replaced by a symlink)",
    );
    assert(
      await Deno.stat(joinPath(vend, "dep", "aio", "mod.ts")).then(() => true),
      "vendored mod.ts intact",
    );

    // A JSR-pinned app → no dep/aio link action at all.
    await Deno.writeTextFile(
      joinPath(jsr, "deno.json"),
      JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@^1.0.0-alpha" } }),
    );
    Deno.chdir(jsr);
    logs.length = 0;
    await cmdFix([], { json: true } as never);
    const r2 = JSON.parse(logs[0]!);
    assert(
      !r2.results.some((x: { name: string }) =>
        x.name === "dep/aio framework link"
      ),
      "JSR app: no link action",
    );
    assert(
      r2.results.some((x: { name: string; note: string }) =>
        x.name === "aio consumption mode" && x.note.includes("registry")
      ),
      "recognizes registry mode",
    );
  } finally {
    console.log = realLog;
    Deno.chdir(orig);
    await Deno.remove(vend, { recursive: true });
    await Deno.remove(jsr, { recursive: true });
  }
});

Deno.test("cmdFix: sibling vendoring is 'custom', not a dep/aio symlink", async () => {
  // Regression: a substring test read "../vendor-dep/aio-core/mod.ts" as the
  // dep/aio layout and littered a stray, unused dep/aio symlink. The mode probe
  // is now anchored to a real path segment.
  const orig = Deno.cwd();
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  const app = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      joinPath(app, "deno.json"),
      JSON.stringify({ imports: { aio: "../vendor-dep/aio-core/mod.ts" } }),
    );
    Deno.chdir(app);
    await cmdFix([], { json: true } as never);
    const r = JSON.parse(logs[0]!);
    assert(
      r.results.some((x: { name: string; note: string }) =>
        x.name === "aio consumption mode" && x.note.includes("custom")
      ),
      "sibling vendoring recognized as custom",
    );
    assert(
      !r.results.some((x: { name: string }) =>
        x.name === "dep/aio framework link"
      ),
      "no dep/aio link action for a custom path",
    );
    assertEquals(
      await Deno.lstat(joinPath(app, "dep")).then(() => true).catch(() =>
        false
      ),
      false,
      "no stray dep/ dir created",
    );
  } finally {
    console.log = realLog;
    Deno.chdir(orig);
    await Deno.remove(app, { recursive: true });
  }
});

Deno.test("cmdFix: adds missing standard tasks, never overwrites existing ones", async () => {
  // Hand-rolled apps (or ones predating the scaffold) miss the task set the
  // docs assume (`deno task compile:electron`, the dev:*/compile:* matrix).
  // am fix appends the missing ones from the SAME producer am create uses —
  // and an existing task is user customization: it must survive untouched.
  const orig = Deno.cwd();
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      joinPath(dir, "deno.json"),
      JSON.stringify({
        imports: { aio: "jsr:@riagentic/aio@1.0.0" },
        target: "electron",
        build: { targets: ["electron", "browser"] },
        tasks: { dev: "deno run -A my-custom-entry.ts", seed: "echo seed" },
        unstable: ["kv"],
      }),
    );
    Deno.chdir(dir);
    await cmdFix([], {});
    const cfg = JSON.parse(
      await Deno.readTextFile(joinPath(dir, "deno.json")),
    ) as { tasks: Record<string, string> };
    // Missing standard tasks were added — for the targets this app declares…
    assert(cfg.tasks["compile:electron"], "compile:electron added");
    assert(cfg.tasks["compile"], "default compile added");
    assert(cfg.tasks["dev:browser"], "dev matrix added for browser");
    // …existing ones were NOT touched.
    assertEquals(cfg.tasks.dev, "deno run -A my-custom-entry.ts");
    assertEquals(cfg.tasks.seed, "echo seed");
  } finally {
    console.log = realLog;
    Deno.chdir(orig);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ── am fix adds the tasks the app's TARGETS need, not all 21 ────────────────
// A field report: `am fix` wrote `dev:android`, `dev:cli`, `dev:service` into an
// app that ships none of them — "noise the maintainer has to remove after every
// repair". A repair tool that leaves a mess behind stops being run.
import { declaredTargets, tasksForTargets } from "../src/am/am-cmd-fix.ts";
import { standardTasks } from "../src/am/am-cmd-create.ts";

Deno.test("cmdFix: a browser-only app gets no android/cli/service tasks", async () => {
  const orig = Deno.cwd();
  const realLog = console.log;
  console.log = () => {};
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      joinPath(dir, "deno.json"),
      JSON.stringify({
        imports: { aio: "jsr:@riagentic/aio@1.0.0" },
        target: "browser",
        build: { targets: ["browser"], platforms: ["host"], out: "dist" },
        // A CURATED list: two of the app's own tasks, and one standard task the
        // author rewrote. None of it may be touched.
        tasks: {
          dev: "deno run -A src/app.ts --port=9000",
          seed: "deno run -A scripts/seed.ts",
          "sync:shared": "deno run -A scripts/sync-shared.ts",
        },
      }),
    );
    Deno.chdir(dir);
    await cmdFix([], {});
    const cfg = JSON.parse(
      await Deno.readTextFile(joinPath(dir, "deno.json")),
    ) as { tasks: Record<string, string> };

    for (
      const t of [
        "dev:android",
        "dev:cli",
        "dev:service",
        "compile:android",
        "compile:cli",
        "compile:service",
        "dev:electron",
        "compile:electron",
        "install:electron",
        "dev:client",
      ]
    ) {
      assertEquals(
        cfg.tasks[t],
        undefined,
        `${t} is for a target this app does not ship`,
      );
    }
    // What it DOES ship, plus the universally useful ones, is still repaired.
    assert(cfg.tasks["dev:browser"], "the browser target's tasks are added");
    assert(cfg.tasks["compile:browser"], "compile:browser added");
    assert(cfg.tasks["compile"], "compile is universal");
    assert(cfg.tasks["build"], "build is universal");
    assert(cfg.tasks["test"] && cfg.tasks["am"] && cfg.tasks["lint"]);
    // Nothing curated was removed or rewritten.
    assertEquals(cfg.tasks.dev, "deno run -A src/app.ts --port=9000");
    assertEquals(cfg.tasks.seed, "deno run -A scripts/seed.ts");
    assertEquals(
      cfg.tasks["sync:shared"],
      "deno run -A scripts/sync-shared.ts",
    );

    // Idempotent: a second repair changes nothing at all.
    const before = await Deno.readTextFile(joinPath(dir, "deno.json"));
    await cmdFix([], {});
    assertEquals(await Deno.readTextFile(joinPath(dir, "deno.json")), before);
  } finally {
    console.log = realLog;
    Deno.chdir(orig);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("cmdFix: build.targets in OBJECT form declares the same fleet as the array", async () => {
  const orig = Deno.cwd();
  const realLog = console.log;
  console.log = () => {};
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      joinPath(dir, "deno.json"),
      JSON.stringify({
        imports: { aio: "jsr:@riagentic/aio@1.0.0" },
        // The per-target-override spelling — one repo, two apps.
        build: {
          targets: {
            server: { entry: "src/relay/app.ts", name: "relay" },
            cli: { entry: "src/app.ts" },
          },
        },
        tasks: {},
      }),
    );
    Deno.chdir(dir);
    await cmdFix([], {});
    const cfg = JSON.parse(
      await Deno.readTextFile(joinPath(dir, "deno.json")),
    ) as { tasks: Record<string, string> };
    assert(cfg.tasks["dev:service"], "the object form is read, not ignored");
    assert(cfg.tasks["compile:service"]);
    assert(cfg.tasks["dev:cli"]);
    assertEquals(cfg.tasks["dev:android"], undefined);
    assertEquals(cfg.tasks["dev:browser"], undefined);
  } finally {
    console.log = realLog;
    Deno.chdir(orig);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("declaredTargets reads both spellings, and neither invents targets", () => {
  assertEquals(declaredTargets({ target: "electron" }), ["electron"]);
  assertEquals(
    declaredTargets({ target: "browser", build: { targets: ["browser"] } }),
    ["browser"],
    "the default target and the fleet overlap without duplicating",
  );
  assertEquals(
    declaredTargets({ build: { targets: { server: {}, "cli-client": {} } } }),
    ["server", "cli-client"],
  );
  assertEquals(declaredTargets({}), []);
  assertEquals(declaredTargets(null), []);
  assertEquals(declaredTargets({ build: { targets: [1, "", "  browser "] } }), [
    "browser",
  ]);
});

Deno.test("tasksForTargets: every standard task stays reachable from some target", () => {
  // The gate that keeps this from silently orphaning a task as the set grows:
  // a key no target (and no universal entry) can produce could never be added
  // by `am fix` again, and nobody would notice until an app was missing it.
  const all = standardTasks(true, "browser");
  const everyTarget = [
    "browser",
    "electron",
    "android",
    "cli",
    "server",
    "electron-client",
    "android-client",
    "cli-client",
  ];
  const { tasks, unknown, assumed } = tasksForTargets(all, everyTarget);
  assertEquals(unknown, []);
  assertEquals(assumed, false);
  assertEquals(
    Object.keys(tasks).sort(),
    Object.keys(all).sort(),
    "a full fleet still gets the WHOLE standard set — no task is unreachable",
  );
});

Deno.test("tasksForTargets: an unknown target is reported, an empty fleet is assumed", () => {
  const all = standardTasks(true, "browser");
  const bad = tasksForTargets(all, ["browser", "webassembly"]);
  assertEquals(bad.unknown, ["webassembly"], "named, never silently dropped");
  assert(bad.tasks["dev:browser"], "the known target is still repaired");

  const none = tasksForTargets(all, []);
  assertEquals(none.assumed, true);
  assert(none.tasks["dev:browser"], "falls back to the framework default");
  assertEquals(none.tasks["dev:android"], undefined);
  assertEquals(none.tasks["dev"], all["dev"], "universal tasks always apply");
});

Deno.test("cmdFix: --dry-run reports missing tasks without writing", async () => {
  const orig = Deno.cwd();
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  const dir = await Deno.makeTempDir();
  const original = JSON.stringify({
    imports: { aio: "jsr:@riagentic/aio@1.0.0" },
    tasks: {},
    unstable: ["kv"],
  });
  try {
    await Deno.writeTextFile(joinPath(dir, "deno.json"), original);
    Deno.chdir(dir);
    await cmdFix(["--dry-run"], {});
    assertEquals(
      await Deno.readTextFile(joinPath(dir, "deno.json")),
      original,
      "dry run writes nothing",
    );
    assert(
      logs.some((l) => l.includes("standard deno tasks")),
      logs.join("\n"),
    );
  } finally {
    console.log = realLog;
    Deno.chdir(orig);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ── am pin <path> — LOCAL-DEV pin (follow a framework checkout) ──────────────
import { cmdPin } from "../src/am/am-cmd-pin.ts";

Deno.test("cmdPin: a path arg records a local-dev pin and links to it", async () => {
  const orig = Deno.cwd();
  const logs: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  const fw = await Deno.makeTempDir(); // a stand-in aio checkout
  const app = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(joinPath(fw, "mod.ts"), "export const aio = 1;");
    await Deno.writeTextFile(
      joinPath(fw, "deno.json"),
      JSON.stringify({ imports: {} }),
    );
    await Deno.writeTextFile(
      joinPath(app, "deno.json"),
      JSON.stringify({
        imports: { aio: "./dep/aio/mod.ts" },
        tasks: {},
        unstable: ["kv"],
      }),
    );
    Deno.chdir(app);
    await cmdPin([fw], {});
    // The pin is recorded as machine-local, explicitly.
    const cfg = JSON.parse(
      await Deno.readTextFile(joinPath(app, "deno.json")),
    ) as { aioVersion?: string };
    assertEquals(cfg.aioVersion, `path:${fw}`);
    // dep/aio links to the checkout itself, not a worktree.
    assert(
      (await Deno.realPath(joinPath(app, "dep", "aio"))) ===
        (await Deno.realPath(fw)),
      "dep/aio resolves to the local checkout",
    );
    // The warning names the trade-off.
    assert(
      logs.some((l) => l.includes("machine-specific")),
      logs.join("\n"),
    );
  } finally {
    console.log = realLog;
    console.error = realErr;
    Deno.chdir(orig);
    await Deno.remove(fw, { recursive: true }).catch(() => {});
    await Deno.remove(app, { recursive: true }).catch(() => {});
  }
});

Deno.test("cmdFix: honors a recorded path pin after the symlink is lost", async () => {
  const orig = Deno.cwd();
  const realLog = console.log;
  console.log = () => {};
  const fw = await Deno.makeTempDir();
  const app = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(joinPath(fw, "mod.ts"), "export const aio = 1;");
    await Deno.writeTextFile(
      joinPath(app, "deno.json"),
      JSON.stringify({
        imports: { aio: "./dep/aio/mod.ts" },
        aioVersion: `path:${fw}`,
        tasks: {},
        unstable: ["kv"],
      }),
    );
    Deno.chdir(app); // fresh clone shape: no dep/aio at all
    await cmdFix([], {});
    assertEquals(
      await Deno.realPath(joinPath(app, "dep", "aio")),
      await Deno.realPath(fw),
      "am fix relinked dep/aio to the path pin",
    );
  } finally {
    console.log = realLog;
    Deno.chdir(orig);
    await Deno.remove(fw, { recursive: true }).catch(() => {});
    await Deno.remove(app, { recursive: true }).catch(() => {});
  }
});

Deno.test("cmdPin: a path pin whose checkout is gone fails loud with the fix", async () => {
  const orig = Deno.cwd();
  const errs: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a: unknown[]) => errs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
  const app = await Deno.makeTempDir();
  const exitCalls: (number | undefined)[] = [];
  const realExit = Deno.exit;
  // deno-lint-ignore no-explicit-any
  (Deno as any).exit = (c?: number) => {
    exitCalls.push(c);
    throw new Error("exit-intercepted");
  };
  try {
    await Deno.writeTextFile(
      joinPath(app, "deno.json"),
      JSON.stringify({
        imports: { aio: "./dep/aio/mod.ts" },
        tasks: {},
        unstable: ["kv"],
      }),
    );
    Deno.chdir(app);
    try {
      await cmdPin(["/nonexistent/aio-checkout"], {});
    } catch (e) {
      assert(String(e).includes("exit-intercepted"), String(e));
    }
    assertEquals(exitCalls, [1]);
    assert(
      errs.some((l) => l.includes("no aio checkout")),
      errs.join("\n"),
    );
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).exit = realExit;
    console.log = realLog;
    console.error = realErr;
    Deno.chdir(orig);
    await Deno.remove(app, { recursive: true }).catch(() => {});
  }
});

Deno.test("am delegates to a path-pinned checkout's am (toolchain coherence)", async () => {
  // The chicken-and-egg a local-dev pin must solve: an app pinned to a WIP
  // framework needs that framework's am (unpushed commands included), not the
  // installed one. The installed am detects the path pin and re-execs.
  const fw = await Deno.makeTempDir(); // fake checkout with a marker am
  const app = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(joinPath(fw, "mod.ts"), "export const aio = 1;");
    await Deno.writeTextFile(
      joinPath(fw, "deno.json"),
      JSON.stringify({ imports: {} }),
    );
    await Deno.mkdir(joinPath(fw, "src"));
    await Deno.writeTextFile(
      joinPath(fw, "src", "am.ts"),
      `console.log("PINNED-AM " + Deno.args.join(" "));`,
    );
    await Deno.writeTextFile(
      joinPath(app, "deno.json"),
      JSON.stringify({
        imports: { aio: "./dep/aio/mod.ts" },
        aioVersion: `path:${fw}`,
        unstable: ["kv"],
      }),
    );
    const REPO = new URL("..", import.meta.url).pathname;
    const run = (env: Record<string, string> = {}) =>
      new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--config",
          joinPath(REPO, "deno.json"),
          joinPath(REPO, "src", "am.ts"),
          "version",
        ],
        cwd: app,
        env: { ...Deno.env.toObject(), ...env },
        stdout: "piped",
        stderr: "piped",
      }).output();

    const p = await run();
    const outText = new TextDecoder().decode(p.stdout);
    const errText = new TextDecoder().decode(p.stderr);
    assert(outText.includes("PINNED-AM version"), `out: ${outText}`);
    assert(errText.includes("path pin"), `stderr announces: ${errText}`);

    // Opt-out: the installed am handles the command itself.
    const p2 = await run({ AIO_AM_NO_DELEGATE: "1" });
    const out2 = new TextDecoder().decode(p2.stdout);
    assert(!out2.includes("PINNED-AM"), `no delegation: ${out2}`);
    assert(out2.includes("1.0.0"), `real am version: ${out2}`);
  } finally {
    await Deno.remove(fw, { recursive: true }).catch(() => {});
    await Deno.remove(app, { recursive: true }).catch(() => {});
  }
});

// ── am update <path> — switch the global am to a dev checkout ────────────────
import { cmdUpdate, installFromArgv } from "../src/am/am-cmd-meta.ts";

Deno.test("am update <path>: installs the checkout's am globally (sandboxed)", async () => {
  const fw = await Deno.makeTempDir();
  const sandbox = await Deno.makeTempDir();
  const logs: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  const prevRoot = Deno.env.get("DENO_INSTALL_ROOT");
  try {
    await Deno.writeTextFile(joinPath(fw, "mod.ts"), "export const aio = 1;");
    await Deno.writeTextFile(
      joinPath(fw, "deno.json"),
      JSON.stringify({ imports: {} }),
    );
    await Deno.mkdir(joinPath(fw, "src"));
    await Deno.writeTextFile(
      joinPath(fw, "src", "am.ts"),
      `console.log("DEV-AM " + Deno.args.join(" "));`,
    );
    Deno.env.set("DENO_INSTALL_ROOT", sandbox); // never touch the real am
    await cmdUpdate([fw], {});
    // The installed shim exists and runs the DEV am.
    const bin = joinPath(
      sandbox,
      "bin",
      Deno.build.os === "windows" ? "am.cmd" : "am",
    );
    const p = await new Deno.Command(bin, {
      args: ["whoami"],
      stdout: "piped",
      stderr: "null",
    }).output();
    assert(
      new TextDecoder().decode(p.stdout).includes("DEV-AM whoami"),
      new TextDecoder().decode(p.stdout),
    );
    // The switch is loud, with the way back.
    assert(logs.some((l) => l.includes("DEV am")), logs.join("\n"));
    assert(
      logs.some((l) => l.includes('"am update" returns')),
      logs.join("\n"),
    );
  } finally {
    if (prevRoot === undefined) Deno.env.delete("DENO_INSTALL_ROOT");
    else Deno.env.set("DENO_INSTALL_ROOT", prevRoot);
    console.log = realLog;
    console.error = realErr;
    await Deno.remove(fw, { recursive: true }).catch(() => {});
    await Deno.remove(sandbox, { recursive: true }).catch(() => {});
  }
});

Deno.test("am update <path>: refuses a non-checkout path, loudly", async () => {
  const notFw = await Deno.makeTempDir();
  const logs: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  const realExit = Deno.exit;
  const exits: (number | undefined)[] = [];
  // deno-lint-ignore no-explicit-any
  (Deno as any).exit = (c?: number) => {
    exits.push(c);
    throw new Error("exit-intercepted");
  };
  try {
    try {
      await cmdUpdate([notFw], {});
    } catch (e) {
      assert(String(e).includes("exit-intercepted"));
    }
    assertEquals(exits, [1]);
    assert(
      logs.some((l) => l.includes("not an aio checkout")),
      logs.join("\n"),
    );
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).exit = realExit;
    console.log = realLog;
    console.error = realErr;
    await Deno.remove(notFw, { recursive: true }).catch(() => {});
  }
});

Deno.test("installFromArgv: the one dev-install recipe", () => {
  assertEquals(installFromArgv("/x/aio"), [
    "install",
    "-gAf",
    "--config",
    "/x/aio/deno.json",
    "-n",
    "am",
    "/x/aio/src/am.ts",
  ]);
});

// `am new <kind> <name>` took the name straight from argv into BOTH a
// file path and generated source. `am new cell "../etc/x"` escaped src/, and a
// name containing `}` closed the generated `cell(` literal so everything after
// it became executable code in the developer's own project.
Deno.test("am new: a name that is not an identifier is refused", async () => {
  const { cmdNew } = await import("../src/am/am-cmd-meta.ts");
  const dir = await Deno.makeTempDir({ prefix: "am-new-" });
  const cwd = Deno.cwd();
  const errors: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));
  try {
    Deno.chdir(dir);
    for (
      const bad of [
        "../etc/x", // path traversal
        "x}; console.log('pwned'); const y = {", // code injection
        "a/b", // nested path
        "2fast", // not an identifier start
      ]
    ) {
      errors.length = 0;
      // A refusal is also a non-zero exit — `am new cell x && git add …`
      // must not run the second half.
      const code = await withExitStub(() =>
        cmdNew(["cell", bad], { json: false } as never)
      );
      assertEquals(code, 1, `"${bad}" must exit 1`);
      assert(
        errors.some((e) => e.includes("invalid name")),
        `"${bad}" must be refused, got: ${errors.join(" | ")}`,
      );
    }
    // Nothing was written anywhere.
    let wrote = false;
    try {
      await Deno.stat(`${dir}/src`);
      wrote = true;
    } catch { /* expected */ }
    assertEquals(wrote, false, "a refused name creates no files");

    // A good name still works, and '-' becomes a valid identifier.
    await cmdNew(["cell", "my-widget"], { json: false } as never);
    const src = await Deno.readTextFile(`${dir}/src/cells/my-widget/index.ts`);
    assertStringIncludes(src, "export const myWidget = cell('my-widget'");
  } finally {
    console.error = origErr;
    Deno.chdir(cwd);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
