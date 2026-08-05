// amui tests — manager cell logic (testCell, hermetic), the UI shell (SSR), and
// the server helpers (project-meta parsing + path-traversal guard).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { testCell } from "../../src/testing/cell-test.ts";
import { renderToString } from "../../src/air/vdom-ssr.ts";
import { h } from "../../src/air/vdom.ts";
import { manager, reconcileDetail, refusalOf } from "./manager.ts";
import type { DiscoveredProject, ProjectDetail } from "./manager.ts";
import App from "./App.tsx";
import { readProjectMeta } from "./server/scan.ts";
import { psStats, readFile } from "./server/proc.ts";

// ── manager cell (hermetic) ──────────────────────────────────────────────────
testCell(manager, "initial state is empty and idle", (t) => {
  t.expect.state((s) =>
    s.projects.length === 0 &&
    s.selectedPath === null &&
    s.detail === null &&
    s.scanning === false &&
    s.taskRunning === null &&
    s.cpuHistory.length === 0 &&
    s.createMsg === null
  );
});

testCell(manager, "create rejects a blank name without spawning", async (t) => {
  await t.send.create("   ");
  t.expect.state((s) =>
    s.createMsg === "enter a name" && s.createBusy === false
  );
});

testCell(
  manager,
  "create rejects a dash-only name (no leading-dash flag)",
  async (t) => {
    await t.send.create("@@@");
    t.expect.state((s) =>
      s.createMsg === "enter a name" && s.createBusy === false
    );
  },
);

testCell(
  manager,
  "select/dispatch on an unknown project are safe no-ops",
  async (t) => {
    await t.send.select("/nope");
    await t.send.dispatch("/nope", "x:y", "");
    t.expect.state((s) => s.detail === null && s.dispatchMsg === null);
  },
);

testCell(
  manager,
  "loadState on an unknown/stopped project reports it, never hangs",
  async (t) => {
    await t.send.loadState("/nope");
    t.expect.state((s) =>
      s.detailState === null &&
      s.detailStateLoading === false &&
      s.detailStateError === "app not running"
    );
  },
);

// Integration: the real discovery path (instance registry + filesystem scan)
// executes end-to-end without throwing and yields a well-formed project list.
testCell(manager, "discover runs the real scan cleanly", async (t) => {
  await t.send.discover();
  t.expect.state((s) =>
    Array.isArray(s.projects) &&
    s.scanning === false &&
    s.lastScan !== null &&
    // roots are always surfaced (so an empty result is diagnosable)
    s.scanRoots.length > 0 &&
    // the walk-up from the test's cwd (examples/amui) finds sibling aio apps
    s.projects.length > 0 &&
    // every project has the required shape
    s.projects.every((p) =>
      typeof p.path === "string" && typeof p.name === "string" &&
      typeof p.meta === "object"
    )
  );
});

// REGRESSION (the "click does nothing" bug): select composes `detail` from a
// project read out of live cell state (an Immer proxy). Embedding that proxy
// back into state throws deep in the async batcher ('preventExtensions on
// proxy') and the whole action is rejected — so detail never populates. This
// dispatches select through the REAL reduce/execute path against REAL proxy
// state (amui's own dir is always discovered, stopped) and asserts it lands.
testCell(
  manager,
  "select a discovered project populates detail (no proxy/reduce error)",
  async (t) => {
    await t.send.discover();
    // Select a real discovered project out of live (proxy) state — the exact
    // path that triggered the 'preventExtensions on proxy' rejection.
    const path = t.getState().projects[0]?.path;
    assert(path, "discovery found at least one project to select");
    await t.send.select(path);
    t.expect.state((s) =>
      s.selectedPath === path &&
      s.detail !== null &&
      s.detail.name.length > 0 &&
      s.detail.meta.isAio === true &&
      s.detailLoading === false &&
      // fileTree loaded for a stopped app (no trojan needed)
      Array.isArray(s.fileTree)
    );
  },
);

// amui is an aio app too, so it monitors ITSELF: it appears in its own list
// (marked `self`) and every diagnostic surface works on it. Only lifecycle is
// off-limits — starting would spawn a second manager, stopping would kill the
// one you are looking at.
testCell(
  manager,
  "amui lists itself as a monitorable `self` project",
  async (t) => {
    const { selfDir } = await import("./server/scan.ts");
    await t.send.discover();
    t.expect.state((s) => {
      const me = s.projects.find((p) => p.path === selfDir());
      return !!me && me.self === true && me.meta.isAio === true &&
        // …and it is the ONLY self entry (no other app may claim it).
        s.projects.filter((p) => p.self).length === 1;
    });
  },
);

testCell(
  manager,
  "select on the self entry populates detail with self: true",
  async (t) => {
    const { selfDir } = await import("./server/scan.ts");
    await t.send.discover();
    await t.send.select(selfDir());
    t.expect.state((s) =>
      s.detail?.self === true && s.detail?.path === selfDir()
    );
  },
);

for (const action of ["start", "stop", "restart"] as const) {
  testCell(
    manager,
    `${action} refuses to act on amui itself`,
    async (t) => {
      const { selfDir } = await import("./server/scan.ts");
      await t.send.discover();
      const before = t.getState().projects.length;
      await t.send[action](selfDir());
      t.expect.state((s) =>
        // The refusal is reported, and nothing was spawned or killed.
        (s.actionMsg ?? "").includes("amui itself") &&
        s.projects.length === before
      );
    },
  );
}

// The scan roots must include ~/aio-apps and the launch-dir walk-up, and the
// framework repo itself must never appear as a managed project.
Deno.test("discoverProjects: roots cover ~/aio-apps + cwd; excludes the framework", async () => {
  const { discoverProjects } = await import("./server/scan.ts");
  const { projects, roots } = await discoverProjects();
  assert(roots.some((r) => r.endsWith("/aio-apps")), "includes ~/aio-apps");
  assert(
    roots.some((r) => Deno.cwd().startsWith(r)),
    "includes a cwd ancestor",
  );
  assert(
    !projects.some((p) => p.name.includes("riagentic")),
    "framework repo is excluded",
  );
});

// ── reconcileDetail (pure) — the external start/stop reconciliation ──────────
const baseDetail = (over: Partial<ProjectDetail> = {}): ProjectDetail => ({
  path: "/p",
  name: "p",
  running: true,
  self: false,
  appId: "p",
  pid: 42,
  port: 8000,
  status: "started",
  build: "dev",
  meta: { name: "p", version: null, target: null, tasks: {}, isAio: true },
  git: false,
  config: null,
  cells: null,
  cpuPct: 12,
  memMb: 128,
  uptimeSec: 99,
  connections: 1,
  errors: null,
  schedules: null,
  at: "t",
  ...over,
});
const proj = (running: DiscoveredProject["running"]): DiscoveredProject => ({
  path: "/p",
  name: "p",
  meta: { name: "p", version: null, target: null, tasks: {}, isAio: true },
  running,
  git: false,
});

Deno.test("reconcileDetail: running→stopped flips flags and clears metrics", () => {
  // Seed the whole live snapshot so we can prove it's dropped on the way down.
  const next = reconcileDetail(
    baseDetail({
      config: { title: "T" },
      cells: { c: ["m"] },
      errors: [{}],
      schedules: ["s"],
    }),
    proj(null),
  );
  assertEquals(next.running, false);
  assertEquals(next.pid, null);
  assertEquals(next.port, null);
  assertEquals(next.cpuPct, null);
  assertEquals(next.memMb, null);
  assertEquals(next.uptimeSec, null);
  // The live trojan snapshot came from a now-dead process — Overview must not
  // keep showing a stopped app's config/cells/build/errors/schedules.
  assertEquals(next.config, null);
  assertEquals(next.cells, null);
  assertEquals(next.build, null);
  assertEquals(next.errors, null);
  assertEquals(next.schedules, null);
});

Deno.test("reconcileDetail: stopped→running restores identity fields", () => {
  const stopped = baseDetail({ running: false, pid: null, port: null });
  const next = reconcileDetail(
    stopped,
    proj({ appId: "p", pid: 7, port: 9000, status: "started" }),
  );
  assertEquals(next.running, true);
  assertEquals(next.pid, 7);
  assertEquals(next.port, 9000);
});

Deno.test("reconcileDetail: in-place restart (new pid/port) is folded + metrics reset", () => {
  const running = baseDetail(); // pid 42, port 8000
  const next = reconcileDetail(
    running,
    proj({ appId: "p", pid: 999, port: 8001, status: "started" }),
  );
  assert(next !== running, "a new process must produce a new detail");
  assertEquals(next.running, true);
  assertEquals(next.pid, 999);
  assertEquals(next.port, 8001);
  // Fresh process → stale CPU/mem/uptime cleared (tick refills them).
  assertEquals(next.cpuPct, null);
  assertEquals(next.uptimeSec, null);
});

Deno.test("reconcileDetail: no state change returns the SAME reference", () => {
  const d = baseDetail();
  assert(
    reconcileDetail(
      d,
      proj({
        appId: "p",
        pid: 42,
        port: 8000,
        status: "started",
      }),
    ) === d,
  );
});

// ── psStats NaN guard — a bogus/dead pid must never yield NaN samples ────────
Deno.test("control plane: a refusal reaches the UI instead of an empty panel", () => {
  // amui reads a running app through /__aio/trojan/*, and every panel degrades
  // to null on failure — so an auth refusal used to render as blank boxes with
  // no cause anywhere. The refusal (which carries its own diagnosis) is kept.
  assertEquals(refusalOf([{ ok: true }]), null);
  assertEquals(
    refusalOf([{ ok: false, error: "app not running on port 8000" }]),
    null,
    "a dead app is visible elsewhere — not an error banner",
  );
  assertEquals(
    refusalOf([
      { ok: true },
      { ok: false, error: "Unauthorized — /__aio/trojan/* is the raw-state…" },
      { ok: false, error: "Forbidden" },
    ]),
    "Unauthorized — /__aio/trojan/* is the raw-state…",
    "the FIRST credential refusal, verbatim",
  );
  assertStringIncludes(
    refusalOf([{ ok: false, error: 'requires role "admin"' }]) ?? "",
    "admin",
  );
});

Deno.test("psStats: a dead pid yields null (never a NaN sample)", async () => {
  // pid 2^31-1 is effectively never live; ps returns nothing → null (not NaN).
  const r = await psStats(2147483646);
  assert(r === null || (Number.isFinite(r.cpuPct) && Number.isFinite(r.memMb)));
});

// ── UI shell (SSR) ───────────────────────────────────────────────────────────
Deno.test("amui shell renders the sidebar + empty state (SSR)", () => {
  const html = renderToString(h(App, {}));
  assertStringIncludes(html, "amui");
  assertStringIncludes(html, "Aio Manager UI");
  assertStringIncludes(html, "search projects");
  assertStringIncludes(html, "Rescan");
  assertStringIncludes(html, "select a project");
});

Deno.test("StateOverview renders merged cells + persist/UI badges (SSR)", async () => {
  const { StateOverview } = await import("./ui/state-view.tsx");
  const state = { counter: { count: 3 }, cfg: { name: "x" } };
  const fields = {
    counter: { count: { persisted: true, ui: true } },
    cfg: { name: { persisted: true, ui: false } },
  };
  const html = renderToString(h(StateOverview, { state, fields }));
  assertStringIncludes(html, "counter");
  assertStringIncludes(html, "cfg");
  assertStringIncludes(html, "disk"); // persist badge
  assertStringIncludes(html, "legend");
});

Deno.test("AreaChart renders an SVG trend with peak/avg (SSR)", async () => {
  const { AreaChart } = await import("./ui/charts.tsx");
  const html = renderToString(
    h(AreaChart, {
      title: "CPU",
      values: [1, 5, 3, 8],
      unit: "%",
      color: "#3fb950",
    }),
  );
  assertStringIncludes(html, "CPU");
  assertStringIncludes(html, "peak");
});

Deno.test("parsePromMem: extracts rss/heap from Prometheus text", async () => {
  const { parsePromMem } = await import("./manager.ts");
  const text = [
    "# HELP aio_uptime_seconds uptime",
    "aio_uptime_seconds 372",
    "aio_memory_rss_bytes 1.2288e+08",
    "aio_memory_heap_total_bytes 67108864",
    "aio_memory_heap_used_bytes 41943040",
  ].join("\n");
  const m = parsePromMem(text);
  assert(m !== null);
  assertEquals(m!.rss, 122880000);
  assertEquals(m!.heapUsed, 41943040);
  assertEquals(m!.heapTotal, 67108864);
  // No memory lines → null (not a zeroed object).
  assertEquals(parsePromMem("aio_uptime_seconds 1"), null);
});

Deno.test("parseLogLine: framework, client, and raw lines", async () => {
  const { parseLogLine } = await import("./manager.ts");
  const fw = parseLogLine(
    "2026-07-23 13:16:16.018  INFO   cell:manager  ready  (aio.ts:42)",
  );
  assertEquals(fw.level, "info");
  assertEquals(fw.scope, "cell:manager");
  assertStringIncludes(fw.msg, "ready");
  assertEquals(fw.ts, "2026-07-23 13:16:16.018");

  const cl = parseLogLine(
    "[2026-07-23T13:16:16Z] [WARN ] [client:2] slow paint",
  );
  assertEquals(cl.level, "warn");
  assertEquals(cl.scope, "client:2");
  assertStringIncludes(cl.msg, "slow paint");

  const raw = parseLogLine("    at foo (bar.ts:9)"); // stack-trace line
  assertEquals(raw.ts, null);
  assertEquals(raw.level, "");
  assertStringIncludes(raw.raw, "at foo");
});

Deno.test("readLogs: prefers the app's own log dir, falls back to the old one", async () => {
  const { readLogs } = await import("./server/proc.ts");
  const dir = await Deno.makeTempDir();
  try {
    // No log yet → missing.
    const none = await readLogs(dir, "app");
    assertEquals(none.missing, true);
    assertEquals(none.lines.length, 0);

    await Deno.mkdir(`${dir}/.aio/log`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/.aio/log/app.log`,
      "2026-07-23 13:00:00.000  INFO   aio  \x1b[32mstarted\x1b[0m\nplain line\n",
    );
    const r = await readLogs(dir, "app", 500);
    assertEquals(r.missing, false);
    assert(r.path!.endsWith("app.log"));
    assertEquals(r.lines.length, 2);
    assert(!r.lines[0]!.includes("\x1b"), "ANSI stripped");
    assertStringIncludes(r.lines[0]!, "started");

    // With an appId, the app's OWN log dir (`~/.<appId>/logs`, alpha38) wins —
    // amui must not show a stale project-relative log for a running app.
    const { appDirs } = await import("aio/server");
    const prevHome = Deno.env.get("AIO_DATA_HOME");
    Deno.env.set("AIO_DATA_HOME", dir);
    try {
      const own = appDirs("logapp");
      await Deno.mkdir(own.logs, { recursive: true });
      await Deno.writeTextFile(`${own.logs}/app.log`, "from the app dir\n");
      const r2 = await readLogs(dir, "app", 500, "logapp");
      assertEquals(r2.path, `${own.logs}/app.log`);
      assertStringIncludes(r2.lines[0]!, "from the app dir");
    } finally {
      if (prevHome === undefined) Deno.env.delete("AIO_DATA_HOME");
      else Deno.env.set("AIO_DATA_HOME", prevHome);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("MetricsPanel renders loop + clients + cell sizes (SSR)", async () => {
  const { MetricsPanel } = await import("./ui/metrics.tsx");
  const vitals = {
    loop: {
      queueDepth: 0,
      drainRate: 12,
      lastReduceTime: 0.4,
      lastReduceAction: "counter:inc",
      lastReduceCell: "counter",
      p95ReduceTime: 1.2,
      effectBacklog: 0,
      circuitBreakers: [],
    },
    clients: [{ id: "c_a1", status: "healthy" }],
    payloadStats: {
      c_a1: {
        lastPayloadBytes: 128,
        totalBytes: 4096,
        count: 32,
        bytesPerSec: 40,
      },
    },
    cellSizes: { counter: 14, todos: 210 },
    gauges: {
      "server.queueDepth": {
        name: "server.queueDepth",
        current: 0,
        capacity: 1000,
        percent: 0,
      },
    },
    clientBackpressure: { c_a1: 1 },
  };
  const html = renderToString(
    h(MetricsPanel, {
      vitals,
      mem: { rss: 122880000, heapUsed: 41943040, heapTotal: 67108864 },
      clients: [{
        index: 0,
        id: "c_a1",
        type: "browser",
        transport: "ws",
        readyState: 1,
      }],
      history: [{ id: 1, type: "counter:inc", ts: 1, perf: { reduce: 0.4 } }],
      cpu: [1, 2],
      memMb: [100, 110],
      heap: [40, 41],
      reduce: [1, 1.2],
      queue: [0, 0],
      connections: 1,
    }),
  );
  assertStringIncludes(html, "dispatch loop");
  assertStringIncludes(html, "counter:inc"); // last action + history
  assertStringIncludes(html, "todos"); // cell size row
  assertStringIncludes(html, "healthy"); // client health column
});

Deno.test("LogView renders filtered lines (SSR)", async () => {
  const { LogView } = await import("./ui/logs.tsx");
  const html = renderToString(
    h(LogView, {
      logs: [
        {
          ts: "2026-07-23 13:00:00.000",
          level: "info",
          scope: "aio",
          msg: "up",
          raw: "up",
        },
        { ts: null, level: "", scope: "", msg: "raw trace", raw: "raw trace" },
      ],
      loading: false,
      error: null,
      source: "combined",
      path: "/x/.aio.log",
      truncated: false,
      follow: false,
      onReload: () => {},
      onSource: () => {},
      onToggleFollow: () => {},
    }),
  );
  assertStringIncludes(html, "Combined");
  assertStringIncludes(html, "follow");
  assertStringIncludes(html, "up");
  assertStringIncludes(html, "raw trace");
});

Deno.test("highlight: colors TS/JSON, leaves unknown + huge files plain", async () => {
  const { highlight } = await import("./ui/highlight.tsx");
  const ts = renderToString(
    h("pre", {}, ...highlight('const x = "hi"; // c', "a.ts")),
  );
  assertStringIncludes(ts, "color"); // keyword/string/comment colored
  const json = renderToString(
    h("pre", {}, ...highlight('{"k": true, "n": 3}', "x.json")),
  );
  assertStringIncludes(json, "color");
  // unknown extension → plain (one text node, no spans)
  const plain = renderToString(
    h("pre", {}, ...highlight("hello", "notes.xyz")),
  );
  assert(!plain.includes("<span"), "unknown ext stays plain");
});

Deno.test("runtimeInfo: dev deno process → runtime root is the project dir", async () => {
  const { runtimeInfo } = await import("./server/proc.ts");
  // Our own process is `deno` running from this repo — kind dev, exe = deno.
  const ri = await runtimeInfo(Deno.pid, "/tmp/proj");
  // On Linux /proc resolves; elsewhere it falls back to the project dir.
  assert(["dev", "unknown"].includes(ri.kind), `kind=${ri.kind}`);
  assert(typeof ri.root === "string" && ri.root.length > 0);
});

// ── server helpers ───────────────────────────────────────────────────────────
Deno.test("readProjectMeta: parses an aio deno.json (name, target, tasks, isAio)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({
        title: "demo",
        version: "1.2.3",
        target: "electron",
        imports: { aio: "../../mod.ts" },
        tasks: { dev: "deno run app.ts", compile: "deno run build.ts" },
      }),
    );
    const m = await readProjectMeta(dir);
    assertEquals(m.name, "demo");
    assertEquals(m.version, "1.2.3");
    assertEquals(m.target, "electron");
    assert(m.isAio, "detected as aio");
    assertEquals(Object.keys(m.tasks).sort(), ["compile", "dev"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readProjectMeta: parses jsonc with trailing + block comments", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${dir}/deno.jsonc`,
      `{
        // leading comment
        "name": "jc", // trailing comment must not break the parse
        "target": "browser",
        /* block */ "version": "9.9"
      }`,
    );
    const m = await readProjectMeta(dir);
    assertEquals(m.name, "jc");
    assertEquals(m.version, "9.9");
    assert(m.isAio);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readProjectMeta: a non-aio deno.json is not flagged aio", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({ name: "plain" }),
    );
    const m = await readProjectMeta(dir);
    assert(!m.isAio);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runTask: cancel via signal terminates promptly (never hangs)", async () => {
  const { runTask } = await import("./server/proc.ts");
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({
        tasks: {
          sleep: "deno eval 'await new Promise(r=>setTimeout(r,60000))'",
        },
      }),
    );
    const ctrl = new AbortController();
    const t0 = performance.now();
    const timer = setTimeout(() => ctrl.abort(), 400);
    const r = await runTask(dir, "sleep", ctrl.signal, 60_000);
    clearTimeout(timer);
    const dt = performance.now() - t0;
    assertEquals(r.ended, "cancelled");
    assert(dt < 15_000, `returned promptly, took ${Math.round(dt)}ms`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("listFiles: walks the tree, ignores deps/junk, reports truncation", async () => {
  const { listFiles } = await import("./server/proc.ts");
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/src`);
    await Deno.mkdir(`${dir}/dep`); // must be ignored (framework mirror)
    await Deno.mkdir(`${dir}/node_modules`); // must be ignored
    await Deno.writeTextFile(`${dir}/deno.json`, "{}");
    await Deno.writeTextFile(`${dir}/src/app.ts`, "//");
    await Deno.writeTextFile(`${dir}/dep/huge.ts`, "//");
    await Deno.writeTextFile(`${dir}/data.db`, "x"); // junk file, ignored
    const { nodes, truncated } = await listFiles(dir);
    const paths = nodes.map((n) => n.path);
    assert(paths.includes("src"), "shows src dir");
    assert(paths.includes("src/app.ts"), "recurses into src");
    assert(!paths.some((p) => p.startsWith("dep")), "dep/ ignored");
    assert(
      !paths.some((p) => p.includes("node_modules")),
      "node_modules ignored",
    );
    assert(!paths.includes("data.db"), "junk file ignored");
    assertEquals(truncated, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readFile: reads within the project, blocks path traversal", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/hello.txt`, "hi there");
    const ok = await readFile(dir, "hello.txt");
    assert(ok.ok && ok.content === "hi there");
    // Traversal outside the project is refused.
    const bad = await readFile(dir, "../../../../etc/passwd");
    assert(!bad.ok, "traversal must be refused");
    assertStringIncludes(bad.error ?? "", "outside");
    // A symlink INSIDE the project pointing outside is refused too.
    try {
      await Deno.symlink("/etc/hostname", `${dir}/escape`);
      const link = await readFile(dir, "escape");
      assert(!link.ok, "symlink escape must be refused");
      assertStringIncludes(link.error ?? "", "outside");
    } catch (e) {
      // symlink creation may be unsupported in the sandbox — skip, don't fail.
      if (!(e instanceof Deno.errors.PermissionDenied)) throw e;
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("findCellSource: locates the cell definition, not references", async () => {
  const { findCellSource } = await import("./server/proc.ts");
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/src`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/src/counter.ts`,
      'import { cell } from "aio";\nexport const counter = cell("counter", {\n  state: { n: 0 },\n});\n',
    );
    // A file that only REFERENCES the cell (import) must not match.
    await Deno.writeTextFile(
      `${dir}/src/app.tsx`,
      'import { counter } from "./counter.ts";\nconsole.log(counter.n);\n',
    );
    const hit = await findCellSource(dir, "counter");
    assert(hit !== null, "found the cell");
    assertEquals(hit!.rel, "src/counter.ts");
    assertEquals(hit!.line, 2); // the `cell("counter"` line
    // A cell that isn't defined anywhere → null.
    assertEquals(await findCellSource(dir, "ghost"), null);
    // Name with regex-special chars is escaped (no throw, no false match).
    assertEquals(await findCellSource(dir, "a.b*c"), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// The scan has to find a project wherever the developer actually keeps it, while
// never walking pseudo-filesystems or network mounts — cheap reach, no nonsense.
// (`AMUI_ROOTS` was `AUI_ROOTS` until the aui→amui rename caught up with it.)
Deno.test("scan: explicit AMUI_ROOTS is honoured verbatim", async () => {
  const { _internals } = await import("./server/scan.ts");
  const prev = Deno.env.get("AMUI_ROOTS");
  Deno.env.set("AMUI_ROOTS", "/work/apps:/mnt/projects");
  try {
    const roots = _internals.defaultRoots([]);
    assert(roots.includes("/work/apps"), roots.join(","));
    // A network mount is not walked into by accident, but IS honoured when the
    // user names it — configuration beats the traversal filter.
    assert(roots.includes("/mnt/projects"), roots.join(","));
    // $HOME is always a root, so an unconfigured install still finds projects.
    assert(roots.includes(Deno.env.get("HOME")!), roots.join(","));
  } finally {
    if (prev === undefined) Deno.env.delete("AMUI_ROOTS");
    else Deno.env.set("AMUI_ROOTS", prev);
  }
});

Deno.test("scan: never walks pseudo-filesystems or machine state", async () => {
  const { _internals } = await import("./server/scan.ts");
  for (const p of ["/proc", "/sys", "/dev", "/var", "/etc", "/mnt", "/media"]) {
    assert(
      _internals.NEVER_WALK.has(p),
      `${p} must never be traversed — it cannot hold a project and readDir on a
       network mount blocks for seconds`,
    );
  }
});
