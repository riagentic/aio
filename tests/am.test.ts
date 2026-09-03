import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  _resetTargetGuess,
  parseGlobalFlags,
  parsePayload,
  readPid,
  removePid,
  resolvePath,
  resolvePort,
  writePid,
} from "../src/am/am-utils.ts";
import { formatUptime } from "../src/am/am-output.ts";
import { resolveControlPort } from "../src/am/am-http.ts";
import {
  instances,
  isProcessAlive,
  lockPath,
} from "../src/server/single-instance-lock.ts";
import type { LockData as PidFile } from "../src/server/single-instance-lock.ts";
import { createServer } from "../src/server/server.ts";
import { join } from "@std/path";
import { VERSION } from "../src/server/aio.ts";
import { freePort } from "../src/testing/server-test.ts";

// Test app ID — unique per test run
const TEST_APP = "am-test-" + Deno.pid;
/** Helper to create a valid PidFile (LockData) with required fields */
function makePf(
  overrides: Partial<PidFile> & { pid: number; port: number },
): PidFile {
  return {
    appId: TEST_APP,
    startedAt: Date.now(),
    status: "started",
    cwd: Deno.cwd(),
    ...overrides,
  };
}

// ── Unit: formatUptime ───────────────────────────────────────

Deno.test("am: formatUptime — seconds", () => {
  assertEquals(formatUptime(0), "0s");
  assertEquals(formatUptime(45), "45s");
  assertEquals(formatUptime(59), "59s");
});

Deno.test("am: formatUptime — minutes", () => {
  // Zero-padded: uptimes are read as a COLUMN in `am instances`, and
  // "2m 05s" under "59m 59s" lines up where "2m 5s" does not. Same spelling
  // as every other duration aio prints (fmt.dur).
  assertEquals(formatUptime(60), "1m 00s");
  assertEquals(formatUptime(125), "2m 05s");
  assertEquals(formatUptime(3599), "59m 59s");
});

Deno.test("am: formatUptime — hours, then days", () => {
  assertEquals(formatUptime(3600), "1h 00m");
  assertEquals(formatUptime(7265), "2h 01m");
  // Past two days, hours stop being a unit anyone reads: 76h 17m is "3 days".
  assertEquals(formatUptime(274_620), "3d 4h");
});

// ── Unit: parsePayload ───────────────────────────────────────

Deno.test("am: parsePayload — key=value pairs", () => {
  assertEquals(parsePayload(["by=5", "name=alice"]), { by: 5, name: "alice" });
});

Deno.test("am: parsePayload — boolean/null auto-parse", () => {
  assertEquals(parsePayload(["active=true", "deleted=false", "data=null"]), {
    active: true,
    deleted: false,
    data: null,
  });
});

Deno.test("am: parsePayload — bare key becomes true", () => {
  assertEquals(parsePayload(["force"]), { force: true });
});

Deno.test("am: parsePayload — string values", () => {
  assertEquals(parsePayload(["msg=hello world"]), { msg: "hello world" });
});

Deno.test("am: parsePayload — array/object values", () => {
  assertEquals(parsePayload(["tags=[1,2,3]"]), { tags: [1, 2, 3] });
});

// ── Unit: resolvePath ────────────────────────────────────────

Deno.test("am: resolvePath — simple key", () => {
  const r = resolvePath({ count: 42 }, "count");
  assertEquals(r, { found: true, value: 42 });
});

Deno.test("am: resolvePath — nested dot-path", () => {
  const state = { fleet: [{ name: "a", stats: { pnl: 100 } }] };
  assertEquals(resolvePath(state, "fleet[0].stats.pnl"), {
    found: true,
    value: 100,
  });
  assertEquals(resolvePath(state, "fleet[0].name"), {
    found: true,
    value: "a",
  });
});

Deno.test("am: resolvePath — dot-number still works", () => {
  const state = { fleet: [{ name: "a" }] };
  assertEquals(resolvePath(state, "fleet.0.name"), { found: true, value: "a" });
});

Deno.test("am: resolvePath — missing path", () => {
  assertEquals(resolvePath({ a: 1 }, "b"), { found: false });
  assertEquals(resolvePath({ a: { b: 1 } }, "a.c"), { found: false });
});

Deno.test("am: resolvePath — bracket array index", () => {
  assertEquals(resolvePath({ items: ["x", "y", "z"] }, "items[1]"), {
    found: true,
    value: "y",
  });
});

Deno.test("am: resolvePath — chained brackets", () => {
  const state = { matrix: [[1, 2], [3, 4]] };
  assertEquals(resolvePath(state, "matrix[1][0]"), { found: true, value: 3 });
});

Deno.test("am: resolvePath — brace-pick from root", () => {
  const state = { counter: 5, page: "home", items: [1, 2] };
  assertEquals(resolvePath(state, "{counter,page}"), {
    found: true,
    value: { counter: 5, page: "home" },
  });
});

Deno.test("am: resolvePath — brace-pick from nested path", () => {
  const state = { fleet: [{ name: "a", stats: { pnl: 100 }, active: true }] };
  assertEquals(resolvePath(state, "fleet[0].{name,active}"), {
    found: true,
    value: { name: "a", active: true },
  });
});

Deno.test("am: resolvePath — brace-pick skips missing keys", () => {
  const state = { user: { id: 1, name: "bob" } };
  assertEquals(resolvePath(state, "user.{id,role}"), {
    found: true,
    value: { id: 1 },
  });
});

Deno.test("am: resolvePath — brace-pick with nested traverse", () => {
  const state = { owner: { id: 1, name: "alice", stats: { pnl: 50 } } };
  assertEquals(resolvePath(state, "owner.{id,stats.pnl}"), {
    found: true,
    value: { id: 1, "stats.pnl": 50 },
  });
});

Deno.test("am: resolvePath — brace-pick on missing prefix", () => {
  assertEquals(resolvePath({ a: 1 }, "nope.{x,y}"), { found: false });
});

// ── Unit: resolvePath — wildcard [*] ────────────────────────

Deno.test("am: resolvePath — wildcard plucks field from array", () => {
  const state = {
    fleet: [{ pair: "BTC", status: "on" }, { pair: "ETH", status: "off" }],
  };
  assertEquals(resolvePath(state, "fleet[*].pair"), {
    found: true,
    value: ["BTC", "ETH"],
  });
});

Deno.test("am: resolvePath — wildcard with brace-pick", () => {
  const state = {
    fleet: [{ pair: "BTC", status: "on", pnl: 5 }, {
      pair: "ETH",
      status: "off",
      pnl: -2,
    }],
  };
  const r = resolvePath(state, "fleet[*].{pair,status}");
  assertEquals(r, {
    found: true,
    value: [{ pair: "BTC", status: "on" }, { pair: "ETH", status: "off" }],
  });
});

Deno.test("am: resolvePath — wildcard nested path", () => {
  const state = { fleet: [{ stats: { pnl: 10 } }, { stats: { pnl: 20 } }] };
  assertEquals(resolvePath(state, "fleet[*].stats.pnl"), {
    found: true,
    value: [10, 20],
  });
});

Deno.test("am: resolvePath — wildcard on non-array returns not found", () => {
  assertEquals(resolvePath({ fleet: "nope" }, "fleet[*].pair"), {
    found: false,
  });
});

Deno.test("am: resolvePath — wildcard bare returns full array", () => {
  const state = { items: [1, 2, 3] };
  assertEquals(resolvePath(state, "items[*]"), {
    found: true,
    value: [1, 2, 3],
  });
});

Deno.test("am: resolvePath — wildcard no matches returns not found", () => {
  const state = { fleet: [{ a: 1 }, { a: 2 }] };
  assertEquals(resolvePath(state, "fleet[*].missing"), { found: false });
});

// ── Unit: parseGlobalFlags ───────────────────────────────────

Deno.test("am: parseGlobalFlags — basic", () => {
  const r = parseGlobalFlags(["status"]);
  assertEquals(r.command, "status");
  assertEquals(r.args, []);
  assertEquals(r.flags, {});
});

Deno.test("am: parseGlobalFlags — with flags", () => {
  const r = parseGlobalFlags(["--json", "--port=9000", "state", "todos"]);
  assertEquals(r.command, "state");
  assertEquals(r.args, ["todos"]);
  assertEquals(r.flags.json, true);
  assertEquals(r.flags.port, 9000);
});

Deno.test("am: parseGlobalFlags — --body flag", () => {
  const r = parseGlobalFlags(["dispatch", '--body={"type":"Inc"}']);
  assertEquals(r.command, "dispatch");
  assertEquals(r.flags.jsonBody, '{"type":"Inc"}');
});

Deno.test("am: parseGlobalFlags — no args defaults to help", () => {
  const r = parseGlobalFlags([]);
  assertEquals(r.command, "help");
});

// ── Unit: PID file I/O ──────────────────────────────────────

Deno.test("am: PID file round-trip", () => {
  const pf = makePf({ pid: 12345, port: 8000 });
  try {
    writePid(pf);
    const read = readPid(TEST_APP);
    assertEquals(read, pf);
  } finally {
    removePid(TEST_APP);
    assertEquals(readPid(TEST_APP), null);
  }
});

Deno.test("am: readPid returns null when no file", () => {
  removePid(TEST_APP); // ensure clean
  assertEquals(readPid(TEST_APP), null);
});

// ── Unit: resolvePort ────────────────────────────────────────

Deno.test("am: resolvePort — flag wins", () => {
  assertEquals(resolvePort(9999), 9999);
});

Deno.test("am: resolvePort — falls back to lock file", () => {
  writePid(makePf({ pid: 1, port: 3000, startedAt: 0 }));
  try {
    assertEquals(resolvePort(undefined, TEST_APP), 3000);
  } finally {
    removePid(TEST_APP);
  }
});

// 8000 is not a port aio binds — the runtime picks a FREE one when nothing is
// declared — so a tool that answers 8000 is answering with a number it made up.
// The contract is a refusal that names the failed question.
Deno.test("am: resolvePort — refuses rather than inventing 8000", () => {
  removePid(TEST_APP);
  // The "one running instance" rung is a legitimate answer and owns this case
  // when the machine has exactly one app up; only the invented rung is on trial.
  if (instances().length > 0) return;
  assertThrows(
    () => resolvePort(undefined, TEST_APP),
    Error,
    "does not know which app to target",
  );
});

// `--app=X` is a statement, not a guess. When X is not running, falling back
// to "the one that is" would aim `am dispatch --app=X` at Y — after a note.
//
// So is the id of the project the cwd sits in: its deno.json named it. The
// fallback rung serves exactly ONE case — a cwd with no project in it, where
// the id came from a directory name — and this test drives both sides of that
// line, because a refusal that fires everywhere is as wrong as one that never
// fires. (This file runs from the aio repo, which IS a project, so the
// guessed-form half has to stand somewhere else to be about the rung at all.)
Deno.test("am: resolvePort — an explicit --app never falls back to another app", async () => {
  const other = TEST_APP + "-other";
  const bare = await Deno.makeTempDir({ prefix: "aio-am-noproject-" });
  const cwd = Deno.cwd();
  writePid(makePf({ appId: other, pid: Deno.pid, port: 3456, startedAt: 0 }));
  try {
    assertThrows(
      () => resolvePort(undefined, TEST_APP, { explicit: true }),
      Error,
      "does not know which app to target",
      "--app=X is a statement: X is not running is the answer",
    );
    // Standing in a project — this repo — is a statement too.
    assertThrows(
      () => resolvePort(undefined, TEST_APP),
      Error,
      "does not know which app to target",
      "the cwd's own project id is not a guess either",
    );
    // The guessed form still finds the sole instance — that rung is for it.
    Deno.chdir(bare);
    if (instances().length === 1) {
      assertEquals(resolvePort(undefined, TEST_APP), 3456);
    }
  } finally {
    Deno.chdir(cwd);
    _resetTargetGuess();
    removePid(other);
    await Deno.remove(bare, { recursive: true }).catch(() => {});
  }
});

// ── Unit: isProcessAlive ─────────────────────────────────────

Deno.test("am: isProcessAlive — current process is alive", () => {
  assertEquals(isProcessAlive(Deno.pid), true);
});

Deno.test("am: isProcessAlive — bogus PID is dead", () => {
  assertEquals(isProcessAlive(999999), false);
});

// ── Unit: PidFile status field ────────────────────────────────

Deno.test("am: PidFile with status field round-trip", () => {
  const pf = makePf({
    pid: 42,
    port: 9000,
    startedAt: 1000,
    status: "starting",
  });
  try {
    writePid(pf);
    assertEquals(readPid(TEST_APP), pf);
  } finally {
    removePid(TEST_APP);
  }
});

Deno.test("am: readPid backward compat — lock without status treated as started", () => {
  try {
    // Write old-style lock (no status field) — actually all locks have status now,
    // but readPid still patches missing status for safety
    const raw = JSON.stringify({
      appId: TEST_APP,
      pid: 99,
      port: 8000,
      startedAt: 500,
      cwd: "/tmp",
    });
    Deno.writeTextFileSync(lockPath(TEST_APP), raw);
    const pf = readPid(TEST_APP)!;
    assertEquals(pf.status, "started");
    assertEquals(pf.pid, 99);
    assertEquals(pf.port, 8000);
  } finally {
    removePid(TEST_APP);
  }
});

Deno.test("am: PidFile status transitions", () => {
  try {
    writePid(makePf({ pid: 10, port: 8000, startedAt: 0, status: "starting" }));
    assertEquals(readPid(TEST_APP)!.status, "starting");
    writePid(makePf({ pid: 10, port: 8000, startedAt: 0, status: "started" }));
    assertEquals(readPid(TEST_APP)!.status, "started");
    writePid(makePf({ pid: 10, port: 8000, startedAt: 0, status: "stopping" }));
    assertEquals(readPid(TEST_APP)!.status, "stopping");
  } finally {
    removePid(TEST_APP);
  }
});

Deno.test("am: PidFile with trojanPort round-trip", () => {
  const pf = makePf({ pid: 1234, port: 8000, trojanPort: 9001 });
  try {
    writePid(pf);
    const loaded = readPid(TEST_APP)!;
    assertEquals(loaded.trojanPort, 9001);
    assertEquals(loaded.port, 8000);
  } finally {
    removePid(TEST_APP);
  }
});

Deno.test("am: resolveControlPort returns trojanPort when TLS active", () => {
  try {
    writePid(makePf({ pid: 1234, port: 8000, trojanPort: 9001 }));
    assertEquals(resolveControlPort(8000, TEST_APP), 9001);
    assertEquals(resolveControlPort(9999, TEST_APP), 9999); // different main port — no match
  } finally {
    removePid(TEST_APP);
  }
});

Deno.test("am: resolveControlPort falls back to main port without trojanPort", () => {
  try {
    writePid(makePf({ pid: 1234, port: 8000 }));
    assertEquals(resolveControlPort(8000, TEST_APP), 8000);
  } finally {
    removePid(TEST_APP);
  }
});

Deno.test("am: resolveControlPort falls back when no PID file", () => {
  removePid();
  assertEquals(resolveControlPort(8000), 8000);
});

// ── Unit: --wait flag parsing ──────────────────────────────────

Deno.test("am: parseGlobalFlags — --wait=N parsed", () => {
  const r = parseGlobalFlags(["start", "--wait=30", "--port=9000"]);
  assertEquals(r.command, "start");
  assertEquals(r.args, []);
  assertEquals(r.flags.wait, 30);
  assertEquals(r.flags.port, 9000);
});

Deno.test("am: parseGlobalFlags — bare --wait defaults to 0", () => {
  const r = parseGlobalFlags(["stop", "--wait"]);
  assertEquals(r.command, "stop");
  assertEquals(r.flags.wait, 0);
});

Deno.test("am: parseGlobalFlags — no --wait leaves undefined", () => {
  const r = parseGlobalFlags(["start", "--port=9000"]);
  assertEquals(r.command, "start");
  assertEquals(r.flags.wait, undefined);
  assertEquals(r.flags.port, 9000);
});

// ── Unit: --wait for state (watch mode) ───────────────────────

Deno.test("am: parseGlobalFlags — state --wait=5 parsed", () => {
  const r = parseGlobalFlags(["state", "fleet[0].stats", "--wait=5"]);
  assertEquals(r.command, "state");
  assertEquals(r.args, ["fleet[0].stats"]);
  assertEquals(r.flags.wait, 5);
});

// ── Integration: trojan endpoints via live server ────────────

const AM_TEST_PORT = freePort();

/** What the server's `loadSnapshot` was handed, or null when it was not called
 *  — so `am snapshot load` can be proved to have DELIVERED the file, not just
 *  to have printed "loaded". */
let lastLoaded: string | null = null;

async function withTrojanServer(
  fn: (url: string) => Promise<void>,
): Promise<void> {
  lastLoaded = null;
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(join(dir, "App.tsx"), "export default () => null");
  const appState = { count: 10, items: ["a", "b"] };
  const server = createServer({
    port: AM_TEST_PORT,
    title: "AmTest",
    getUIState: () => ({ count: appState.count }),
    dispatch: () => {},
    getSnapshot: () => JSON.stringify(appState),
    loadSnapshot: (json: string) => {
      lastLoaded = json;
    },
    baseDir: dir,
    debug: () => {},
    prod: false,
    trojan: {
      getState: () => appState,
      getSchedules: () => ["tick"],
      startedAt: Date.now() - 10_000,
    },
  });
  await new Promise((r) => setTimeout(r, 50));
  try {
    await fn(`http://127.0.0.1:${AM_TEST_PORT}`);
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("am-integration: trojanGet state", async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__aio/trojan/state`);
    assertEquals(resp.status, 200);
    const data = await resp.json();
    assertEquals(data.count, 10);
    assertEquals(data.items, ["a", "b"]);
  });
});

Deno.test("am-integration: trojanGet config", async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__aio/trojan/config`);
    assertEquals(resp.status, 200);
    const data = await resp.json();
    assertEquals(data.port, AM_TEST_PORT);
    assertEquals(data.title, "AmTest");
    assertEquals(data.expose, false);
    assertEquals(data.authMode, "public");
    assertEquals(data.prod, false);
  });
});

Deno.test("am-integration: trojanGet metrics", async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__aio/trojan/metrics`);
    assertEquals(resp.status, 200);
    const data = await resp.json();
    assertEquals(typeof data.uptime, "number");
    assertEquals(data.uptime >= 9, true);
    assertEquals(data.connections, 0);
    assertEquals(data.schedules, 1);
  });
});

Deno.test("am-integration: trojanPost dispatch", async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__aio/trojan/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AIO": "1" },
      body: JSON.stringify({ type: "Increment", payload: { by: 1 } }),
    });
    assertEquals(resp.status, 200);
    const data = await resp.json();
    assertEquals(data.ok, true);
  });
});

Deno.test("am-integration: trojanGet schedules", async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__aio/trojan/schedules`);
    assertEquals(resp.status, 200);
    const data = await resp.json();
    assertEquals(data, ["tick"]);
  });
});

Deno.test("am-integration: health check via root", async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(url);
    assertEquals(resp.status, 200);
    const body = await resp.text();
    assertEquals(body.includes("<!DOCTYPE html>"), true);
  });
});

// ── Subprocess am tests ──────────────────────────────────────────

const amScript = join(import.meta.dirname ?? ".", "..", "src", "am.ts");

/** Run am.ts as subprocess with --json, return parsed JSON output */
async function runAm(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string; json?: unknown }> {
  const result = await new Deno.Command("deno", {
    args: [
      "run",
      "-A",
      "--unstable-kv",
      amScript,
      "--json",
      `--port=${AM_TEST_PORT}`,
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  const stdout = dec.decode(result.stdout).trim();
  const stderr = dec.decode(result.stderr).trim();
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch { /* not JSON */ }
  return { code: result.code, stdout, stderr, json };
}

Deno.test("am-cli: state — full state via subprocess", async () => {
  await withTrojanServer(async () => {
    const r = await runAm(["state"]);
    assertEquals(r.code, 0);
    const data = r.json as { count: number; items: string[] };
    assertEquals(data.count, 10);
    assertEquals(data.items, ["a", "b"]);
  });
});

Deno.test("am-cli: state — dot-path resolution", async () => {
  await withTrojanServer(async () => {
    const r = await runAm(["state", "count"]);
    assertEquals(r.code, 0);
    assertEquals(r.json, 10);
  });
});

Deno.test("am-cli: state — missing path error", async () => {
  await withTrojanServer(async () => {
    const r = await runAm(["state", "nonexistent"]);
    assertEquals(r.code, 1);
    // json-mode errors land on STDOUT (the stream a script parses) + exit 1.
    assertEquals((r.stdout + r.stderr).includes("not found"), true);
  });
});

Deno.test("am-cli: dispatch — send action", async () => {
  await withTrojanServer(async () => {
    const r = await runAm(["dispatch", "Increment", "by=1"]);
    assertEquals(r.code, 0);
    const data = r.json as { ok: boolean };
    assertEquals(data.ok, true);
  });
});

Deno.test("am-cli: dispatch — --body JSON", async () => {
  await withTrojanServer(async () => {
    const r = await runAm(["dispatch", '--body={"type":"Reset"}']);
    assertEquals(r.code, 0);
    const data = r.json as { ok: boolean };
    assertEquals(data.ok, true);
  });
});

Deno.test("am-cli: clients — list (empty)", async () => {
  await withTrojanServer(async () => {
    const r = await runAm(["clients"]);
    assertEquals(r.code, 0);
    assertEquals(Array.isArray(r.json), true);
    assertEquals((r.json as unknown[]).length, 0);
  });
});

Deno.test("am-cli: schedules — list active", async () => {
  await withTrojanServer(async () => {
    const r = await runAm(["schedules"]);
    assertEquals(r.code, 0);
    assertEquals(r.json, ["tick"]);
  });
});

Deno.test("am-cli: config — returns port + title", async () => {
  await withTrojanServer(async () => {
    const r = await runAm(["config"]);
    assertEquals(r.code, 0);
    const data = r.json as { port: number; title: string };
    assertEquals(data.port, AM_TEST_PORT);
    assertEquals(data.title, "AmTest");
  });
});

Deno.test("am-cli: metrics — returns uptime + connections", async () => {
  await withTrojanServer(async () => {
    const r = await runAm(["metrics"]);
    assertEquals(r.code, 0);
    const data = r.json as { uptime: number; connections: number };
    assertEquals(typeof data.uptime, "number");
    assertEquals(data.connections, 0);
  });
});

Deno.test("am-cli: health — running server ok", async () => {
  await withTrojanServer(async () => {
    const r = await runAm(["health"]);
    assertEquals(r.code, 0);
    const data = r.json as { healthy: boolean };
    assertEquals(data.healthy, true);
  });
});

Deno.test("am-cli: health — dead port fails", async () => {
  // No server running on this port
  const result = await new Deno.Command("deno", {
    args: [
      "run",
      "-A",
      "--unstable-kv",
      amScript,
      "--json",
      "--port=19899",
      "health",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(result.code, 1);
});

Deno.test("am-cli: version — outputs semver", async () => {
  const r = await runAm(["version"]);
  assertEquals(r.code, 0);
  const data = r.json as { version: string };
  assertEquals(data.version, VERSION);
});

Deno.test("am-cli: help — lists commands", async () => {
  const r = await runAm(["help"]);
  assertEquals(r.code, 0);
  const data = r.json as { commands: string[] };
  assertEquals(Array.isArray(data.commands), true);
  assertEquals(data.commands.includes("start"), true);
  assertEquals(data.commands.includes("state"), true);
  assertEquals(data.commands.includes("dispatch"), true);
});

Deno.test("am-cli: logs — reads .aio.log", async () => {
  // In a cwd of ITS OWN. `.aio.log` is a legacy candidate resolved relative to
  // the process cwd, so writing one into the repo root put a file every other
  // test file could see — `am-log-finds-the-app-log` asserts what
  // `logPathFor` returns when neither current file exists, and intermittently
  // got this one instead. A test must not leave shared state where another
  // test's answer changes because of it.
  const cwd = await Deno.makeTempDir({ prefix: "aio-amlog-cwd-" });
  const logContent = "line1 hello\nline2 world\nline3 error found\n";
  await Deno.writeTextFile(join(cwd, ".aio.log"), logContent);
  try {
    const result = await new Deno.Command("deno", {
      args: ["run", "-A", "--unstable-kv", amScript, "--json", "logs"],
      cwd,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const dec = new TextDecoder();
    const stdout = dec.decode(result.stdout).trim();
    const data = JSON.parse(stdout);
    assertEquals(data.total, 4); // 3 lines + trailing empty
    assertEquals(data.lines.length > 0, true);
  } finally {
    await Deno.remove(cwd, { recursive: true }).catch(() => {});
  }
});

Deno.test("am-cli: logs — filter works", async () => {
  const cwd = await Deno.makeTempDir({ prefix: "aio-amlog-cwd2-" });
  await Deno.writeTextFile(
    join(cwd, ".aio.log"),
    "info: ok\nerror: bad\ninfo: fine\n",
  );
  try {
    const result = await new Deno.Command("deno", {
      args: ["run", "-A", "--unstable-kv", amScript, "--json", "logs", "error"],
      cwd,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const dec = new TextDecoder();
    const stdout = dec.decode(result.stdout).trim();
    const data = JSON.parse(stdout);
    assertEquals(data.filter, "error");
    assertEquals(data.lines.every((l: string) => l.includes("error")), true);
  } finally {
    await Deno.remove(cwd, { recursive: true }).catch(() => {});
  }
});

// ── am status — no server running ────────────────────────────

Deno.test("am-cli: status — exit code 1 when no server", async () => {
  removePid();
  const result = await new Deno.Command("deno", {
    args: [
      "run",
      "-A",
      "--unstable-kv",
      amScript,
      "--json",
      "--port=19899",
      "status",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  // Exit 1 = stopped
  assertEquals(result.code, 1);
  const stdout = new TextDecoder().decode(result.stdout).trim();
  const data = JSON.parse(stdout);
  assertEquals(data.status, "stopped");
});

// ── am state --ui — filtered UI-state projection (was `am ui`) ───────────────

Deno.test("am-cli: state --ui — returns filtered UI state", async () => {
  await withTrojanServer(async () => {
    // Pass a user arg to hit the server-state /ui route (no arg → DOM snapshot)
    const r = await runAm(["state", "--ui", "testuser"]);
    assertEquals(r.code, 0);
    // getUIState in withTrojanServer returns { count: appState.count }
    const data = r.json as { count: number };
    assertEquals(data.count, 10);
    // items not exposed via getUIState
    assertEquals((data as Record<string, unknown>).items, undefined);
  });
});

// ── am actions — history ─────────────────────────────────────

Deno.test("am-cli: actions — returns TT history", async () => {
  await withTrojanServer(async () => {
    const r = await runAm(["actions"]);
    assertEquals(r.code, 0);
    // history endpoint returns { entries, index, paused }
    const data = r.json as { entries: unknown[] };
    assertEquals(typeof data, "object");
  });
});

// ── am errors — no errors ─────────────────────────────────────

Deno.test("am-cli: errors — empty when no transpile errors", async () => {
  await withTrojanServer(async () => {
    const r = await runAm(["errors"]);
    assertEquals(r.code, 0);
    const data = r.json as { errors: unknown[] };
    assertEquals(Array.isArray(data.errors), true);
    assertEquals(data.errors.length, 0);
  });
});

// ── am sql / tables — no SQLite ──────────────────────────────

Deno.test("am-cli: sql — error when no sqlQuery configured", async () => {
  // withTrojanServer does not configure sqlQuery → trojan returns 404
  await withTrojanServer(async () => {
    const r = await runAm(["sql", "SELECT 1"]);
    assertEquals(r.code, 1);
  });
});

Deno.test("am-cli: tables — error when no sqlQuery configured", async () => {
  await withTrojanServer(async () => {
    const r = await runAm(["tables"]);
    assertEquals(r.code, 1);
  });
});

// ── am snapshot ───────────────────────────────────────────────

Deno.test("am-cli: snapshot — dumps state as JSON", async () => {
  await withTrojanServer(async () => {
    const r = await runAm(["snapshot"]);
    assertEquals(r.code, 0);
    // Snapshot dumps raw JSON to stdout (not wrapped in json mode)
    const text = r.stdout;
    const parsed = JSON.parse(text);
    assertEquals(parsed.count, 10);
  });
});

Deno.test("am-cli: snapshot save — writes file", async () => {
  // A path that does NOT exist yet — what a person types. `makeTempFile`
  // CREATES the file, and `snapshot save` now refuses to write over one (the
  // same rule `am backup` has always had); using it here tested the refusal
  // by accident and called it a failure.
  const dir = await Deno.makeTempDir();
  const tmp = `${dir}/snap.json`;
  try {
    await withTrojanServer(async () => {
      const r = await runAm(["snapshot", "save", tmp]);
      assertEquals(r.code, 0);
      const saved = JSON.parse(await Deno.readTextFile(tmp));
      assertEquals(saved.count, 10);

      // …and the second save refuses, rather than replacing it silently.
      const again = await runAm(["snapshot", "save", tmp]);
      assertEquals(again.code, 1, "an existing file is never clobbered");
      // --force is the way past, said on purpose.
      const forced = await runAm(["snapshot", "save", tmp, "--force"]);
      assertEquals(forced.code, 0);
    });
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// A snapshot is `{ cellName: cellState }` — what `app.snapshot()` writes, and
// the only shape every snapshot door now accepts (`snapshotShapeError`). This
// fixture used to be `{ count: 99, items: [] }`, which is a CELL's state with
// no cell around it: it could never have come out of `app.snapshot()`, and a
// server that took it would have set the cell "count" to the number 99 and
// thrown on the next dispatch. The test passed because nothing checked, and
// "loaded" was the only thing asserted.
Deno.test("am-cli: snapshot load — restores state from file", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".json" });
  const snap = JSON.stringify({ counter: { count: 99, items: [] } });
  try {
    await Deno.writeTextFile(tmp, snap);
    await withTrojanServer(async () => {
      const r = await runAm(["snapshot", "load", tmp]);
      assertEquals(r.code, 0, `am snapshot load failed: ${r.stdout}`);
      const data = r.json as { file: string; status: string };
      assertEquals(data.status, "loaded");
      // "loaded" is a word; this is the delivery.
      assertEquals(JSON.parse(lastLoaded ?? "null"), JSON.parse(snap));
    });
  } finally {
    await Deno.remove(tmp).catch(() => {});
  }
});

// The other half: a file that is NOT a snapshot is refused at the door and
// never reaches the app. A cell's state is always an object, so a scalar under
// a cell name loads today and breaks the next dispatch, far from the POST that
// caused it — `am snapshot load` must not be the way that gets in.
Deno.test("am-cli: snapshot load — a file that is not a snapshot is refused", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(tmp, JSON.stringify({ counter: 99 }));
    await withTrojanServer(async () => {
      const r = await runAm(["snapshot", "load", tmp]);
      assertEquals(r.code, 1, "an ill-shaped snapshot is not loaded");
      assertStringIncludes(r.stdout, "counter", "the refusal names the cell");
      assertStringIncludes(r.stdout, "must be an object");
      assertEquals(lastLoaded, null, "and it never reached the app");
    });
  } finally {
    await Deno.remove(tmp).catch(() => {});
  }
});

Deno.test("am-cli: snapshot load — error on missing file", async () => {
  await withTrojanServer(async () => {
    const r = await runAm([
      "snapshot",
      "load",
      "/tmp/nonexistent_aio_test_file.json",
    ]);
    assertEquals(r.code, 1);
  });
});

// ── am tt — time-travel commands ─────────────────────────────

const AM_TT_PORT = freePort();

async function withTTServer(fn: (url: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(join(dir, "App.tsx"), "export default () => null");
  const ttCmds: { cmd: string; arg?: number }[] = [];
  const server = createServer({
    port: AM_TT_PORT,
    title: "TTServer",
    getUIState: () => ({}),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: false,
    onTTCommand: (cmd, arg) => {
      ttCmds.push({ cmd, arg });
    },
    trojan: {
      getState: () => ({ step: 0 }),
      getSchedules: () => [],
      startedAt: Date.now(),
    },
  });
  await new Promise((r) => setTimeout(r, 50));
  try {
    await fn(`http://127.0.0.1:${AM_TT_PORT}`);
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
}

function runAmOnPort(port: number, args: string[]) {
  return new Deno.Command("deno", {
    args: [
      "run",
      "-A",
      "--unstable-kv",
      amScript,
      "--json",
      `--port=${port}`,
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output().then((r) => {
    const dec = new TextDecoder();
    const stdout = dec.decode(r.stdout).trim();
    let json: unknown;
    try {
      json = JSON.parse(stdout);
    } catch { /* not JSON */ }
    return { code: r.code, stdout, stderr: dec.decode(r.stderr).trim(), json };
  });
}

Deno.test("am-cli: timetravel undo — sends command to server", async () => {
  await withTTServer(async () => {
    const r = await runAmOnPort(AM_TT_PORT, ["timetravel", "undo"]);
    assertEquals(r.code, 0);
  });
});

Deno.test("am-cli: timetravel goto N — sends goto with index", async () => {
  await withTTServer(async () => {
    const r = await runAmOnPort(AM_TT_PORT, ["timetravel", "goto", "2"]);
    assertEquals(r.code, 0);
  });
});

Deno.test("am-cli: timetravel pause/resume — sends toggle", async () => {
  await withTTServer(async () => {
    const r1 = await runAmOnPort(AM_TT_PORT, ["timetravel", "pause"]);
    assertEquals(r1.code, 0);
    const r2 = await runAmOnPort(AM_TT_PORT, ["timetravel", "resume"]);
    assertEquals(r2.code, 0);
  });
});

Deno.test("am-cli: timetravel — no subcommand exits with error", async () => {
  await withTTServer(async () => {
    const r = await runAmOnPort(AM_TT_PORT, ["timetravel"]);
    assertEquals(r.code, 1);
  });
});

Deno.test("am-cli: timetravel goto — missing N exits with error", async () => {
  await withTTServer(async () => {
    const r = await runAmOnPort(AM_TT_PORT, ["timetravel", "goto"]);
    assertEquals(r.code, 1);
  });
});

// ── am dispatch — input validation ───────────────────────────

Deno.test("am-cli: dispatch — no args exits with error", async () => {
  await withTrojanServer(async () => {
    const r = await runAm(["dispatch"]);
    assertEquals(r.code, 1);
  });
});
