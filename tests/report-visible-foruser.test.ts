// A bug report must not carry what a PER-USER `visible.forUser` view hides.
//
// `visible: { forUser }` is the spelling an app uses when one cell holds every
// user's rows and each client may see only its own — the broadcast runs the
// callback per client (`decideForUser`, aio-composition.ts) and `am surface`
// runs it too. The report builder screened through the cell's STRUCTURAL
// filter only, and a `forUser`-only cell has none: every user's rows — the
// one thing the declaration exists to prevent — were written to disk and
// POSTed the day the app sets `feedback:`.
//
// A report is built with no client attached, so there is no user whose view
// it could reproduce. The only answer that is never MORE than a client's is
// to withhold the cell whole and say so.
import { assert, assertEquals } from "@std/assert";
import { buildReport } from "../src/server/report.ts";
import type { TimelineEntry } from "../src/server/timeline.ts";
import { buildLegacyConfig } from "../src/server/aio-cells-bridge.ts";
import { composeCellsWiring } from "../src/server/aio-composition.ts";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const MINE = "row-of-alice";
const THEIRS = "SECRET-row-of-bob";

/** Compose one cell exactly as `aio.run` does and hand back both answers: the
 *  state a client receives, and the internal config the report is built from.
 *  No hand-written copy of either side — the wire's own getter and the app's
 *  own bridge. */
// deno-lint-ignore no-explicit-any
function wireAndConfig(
  def: any,
  state: Record<string, unknown>,
  user?: unknown,
) {
  _resetAioRuntime();
  const w = composeCellsWiring(
    // deno-lint-ignore no-explicit-any
    { fc: { appId: "probe" } as any, cellEntries: [def] } as any,
  );
  const cfg = buildLegacyConfig(
    {
      // deno-lint-ignore no-explicit-any
      fc: { appId: "probe" } as any,
      composed: w.composed,
      beforeReduce: undefined,
      onRestore: undefined,
      autoGetUIState: w.autoGetUIState,
      autoGetDBState: w.autoGetDBState,
      cellPatchStrategies: w.cellPatchStrategies,
      cellFilterFieldsMap: w.cellFilterFields,
      cellReportOpts: {},
      logger: null,
      appRef: { current: null },
      // deno-lint-ignore no-explicit-any
    } as any,
  ) as unknown as Record<string, unknown>;
  return { ui: w.autoGetUIState?.(state, user), cfg };
}

function sources(
  cfg: Record<string, unknown>,
  over: Record<string, unknown>,
): Parameters<typeof buildReport>[1] {
  return {
    appId: "probe",
    appVersion: "1",
    aioVersion: "1",
    dataDir: "/nonexistent",
    logsDir: "/nonexistent",
    exposed: false,
    persist: false,
    cells: ["acct"],
    // deno-lint-ignore no-explicit-any
    visibleFilters: cfg._cellVisible as any,
    // deno-lint-ignore no-explicit-any
    visible: cfg._cellFields as any,
    ...over,
    // deno-lint-ignore no-explicit-any
  } as any;
}

const perUserCell = () =>
  cell("acct", {
    state: {
      rows: [
        { owner: "alice", note: MINE },
        { owner: "bob", note: THEIRS },
      ],
      open: true,
    },
    visible: {
      forUser: (
        s: { rows: { owner: string }[] },
        u: { id?: string } | undefined,
      ) => ({ rows: s.rows.filter((r) => r.owner === (u?.id ?? "")) }),
    },
    methods: {},
    // deno-lint-ignore no-explicit-any
  } as any);

Deno.test("report state: a visible.forUser cell is withheld, not carried whole", async () => {
  const def = perUserCell();
  const state = {
    acct: (def as unknown as { __aio: { state: unknown } }).__aio.state,
  } as Record<string, unknown>;
  const { ui, cfg } = wireAndConfig(def, state, { id: "alice" });
  // The wire's own answer for alice: her row only.
  const wire = JSON.stringify(ui);
  assert(wire.includes(MINE), wire);
  assert(!wire.includes(THEIRS), `the wire already hides it: ${wire}`);

  const r = await buildReport(
    { kind: "user", title: "t" },
    sources(cfg, { getState: () => state }),
  );
  const text = JSON.stringify(r.state);
  assert(
    !text.includes(THEIRS),
    `a per-user view's OTHER users' rows must not reach a report: ${text}`,
  );
  assertEquals(r.state?.acct, undefined, "the cell is withheld whole");
  assert(
    (r.truncated ?? []).some((t) => t.includes("acct")),
    `…and its absence is named: ${JSON.stringify(r.truncated)}`,
  );
});

Deno.test("report state: a forUser view beside a structural filter still withholds", async () => {
  // `visible: { exclude: [...], forUser }` — the structural filter is the
  // FIRST of two screens the wire applies. Screening with it alone shows every
  // field the callback would have dropped.
  const def = cell("acct", {
    state: { pub: 1, priv: THEIRS, tok: "SECRET-excluded" },
    visible: {
      exclude: ["tok"],
      forUser: (s: Record<string, unknown>) => ({ pub: s.pub }),
    },
    methods: {},
    // deno-lint-ignore no-explicit-any
  } as any);
  const state = {
    acct: (def as unknown as { __aio: { state: unknown } }).__aio.state,
  } as Record<string, unknown>;
  const { ui, cfg } = wireAndConfig(def, state, { id: "x" });
  assertEquals(ui, { acct: { pub: 1 } }, "what a client actually receives");

  const r = await buildReport(
    { kind: "user", title: "t" },
    sources(cfg, { getState: () => state }),
  );
  const text = JSON.stringify(r.state);
  assert(!text.includes(THEIRS), text);
  assert(!text.includes("SECRET-excluded"), text);
});

Deno.test("report timeline: a forUser cell's diff leaves lose their values", async () => {
  // The timeline is state too. A diff leaf under a per-user cell carries the
  // row the action wrote — whoever it belonged to.
  const def = perUserCell();
  const state = {
    acct: (def as unknown as { __aio: { state: unknown } }).__aio.state,
  } as Record<string, unknown>;
  const { cfg } = wireAndConfig(def, state);
  const entries: TimelineEntry[] = [{
    seq: 1,
    ts: 1,
    type: "acct:addRow",
    payload: { args: [THEIRS] },
    diff: [{
      path: "acct.rows.1",
      before: undefined,
      after: { owner: "bob", note: THEIRS },
    }],
  }];
  const r = await buildReport(
    { kind: "user", title: "t" },
    sources(cfg, { getTimeline: () => entries }),
  );
  const text = JSON.stringify(r.timeline);
  assert(!text.includes(THEIRS), text);
  assertEquals(
    r.timeline?.[0]?.diff[0]?.path,
    "acct.rows.1",
    "the path stays — that the action happened is diagnostic",
  );
});

// ── The same thing end to end: a real app, a real feedback capture ─────────
const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

const CHILD = `
import { aio, cell } from "${MOD}";
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const acct = cell("acct", {
  state: { rows: [] },
  // One cell, every user's rows, one view per client.
  visible: {
    forUser: (s, u) => ({ rows: s.rows.filter((r) => r.owner === u?.id) }),
  },
  methods: {
    add(s, owner, note) { s.rows.push({ owner, note }); },
  },
});
await aio.run({
  cells: [acct],
  appId: "report-foruser-probe",
  client: "server-only",
  feedback: true,
  persist: false,
  port: PORT,
  appDir: DIR,
});
await acct.add("alice", "${MINE}");
await acct.add("bob", "${THEIRS}");
const res = await fetch("http://127.0.0.1:" + PORT + "/__aio/trojan/dispatch", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-AIO": "1" },
  body: JSON.stringify({ type: "feedback:report", payload: { args: ["title", "body"] } }),
});
await res.text();
const dir = DIR + "/data/reports";
for (let i = 0; i < 200; i++) {
  try {
    if ([...Deno.readDirSync(dir)].some((e) => e.name.endsWith(".json"))) break;
  } catch { /* not yet */ }
  await new Promise((r) => setTimeout(r, 25));
}
Deno.exit(0);
`;

Deno.test("feedback capture: a per-user cell's other rows never reach the file", async () => {
  const dir = await tempDir("aio-report-foruser-");
  await Deno.writeTextFile(`${dir}/app.ts`, CHILD);
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, `${dir}/app.ts`],
    env: { DIR: dir, PORT: String(freePort()), AIO_APPS_DIR: dir },
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(out.success, new TextDecoder().decode(out.stderr));
  const files = [...Deno.readDirSync(`${dir}/data/reports`)]
    .filter((e) => e.name.endsWith(".json"));
  assertEquals(files.length, 1, "one user report");
  const text = await Deno.readTextFile(`${dir}/data/reports/${files[0]!.name}`);
  assert(!text.includes(THEIRS), text.slice(0, 1200));
  assert(!text.includes(MINE), "no user's rows — the report has no user");
});
