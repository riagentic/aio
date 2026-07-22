// aui tests — manager cell logic (testCell, hermetic), the UI shell (SSR), and
// the server helpers (project-meta parsing + path-traversal guard).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { testCell } from "../../../src/testing/cell-test.ts";
import { renderToString } from "../../../src/air/vdom-ssr.ts";
import { h } from "../../../src/air/vdom.ts";
import { manager, reconcileDetail } from "./manager.ts";
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
    // the walk-up from the test's cwd (examples/aui) finds sibling aio apps
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
// state (aui's own dir is always discovered, stopped) and asserts it lands.
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

testCell(
  manager,
  "aui excludes itself from the managed project list",
  async (t) => {
    await t.send.discover();
    t.expect.state((s) => !s.projects.some((p) => p.path === Deno.cwd()));
  },
);

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
  const next = reconcileDetail(baseDetail(), proj(null));
  assertEquals(next.running, false);
  assertEquals(next.pid, null);
  assertEquals(next.port, null);
  assertEquals(next.cpuPct, null);
  assertEquals(next.memMb, null);
  assertEquals(next.uptimeSec, null);
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
Deno.test("psStats: a dead pid yields null (never a NaN sample)", async () => {
  // pid 2^31-1 is effectively never live; ps returns nothing → null (not NaN).
  const r = await psStats(2147483646);
  assert(r === null || (Number.isFinite(r.cpuPct) && Number.isFinite(r.memMb)));
});

// ── UI shell (SSR) ───────────────────────────────────────────────────────────
Deno.test("aui shell renders the sidebar + empty state (SSR)", () => {
  const html = renderToString(h(App, {}));
  assertStringIncludes(html, "aui");
  assertStringIncludes(html, "aio app manager");
  assertStringIncludes(html, "search projects");
  assertStringIncludes(html, "Rescan");
  assertStringIncludes(html, "select a project");
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
