// cell.test.ts — methods-style cell() + composeCells() + testCell() coverage.
// perfect-aio D1: ported from the redux-era Style-B config (actions/reduce/
// execute/machine) to methods-style. Machine guards became status-field guards
// inside methods; effect creators became schedule-effect returns.
import { assertEquals, assertThrows } from "@std/assert";
import { cell, composeCells } from "../src/state/cell.ts";
import { testCell } from "../src/cell-test.ts";
import type { CellEntry } from "../src/state/cell-types.ts";
import { schedule } from "../src/state/schedule.ts";

// ── cell() — methods-style catalog ──────────────────────────────

const counter = cell("counter", {
  state: { count: 0, error: null as string | null, status: "idle" },
  methods: {
    increment(s, by = 1) {
      s.count += by;
    },
    decrement(s, by = 1) {
      s.count -= by;
    },
    reset(s) {
      s.count = 0;
    },
    // Save lifecycle — guard at method top replaces the old machine table:
    // an action fired in the wrong state is IGNORED (state untouched).
    save(s) {
      if (s.status !== "idle") return;
      s.status = "saving";
    },
    saved(s) {
      if (s.status !== "saving") return;
      s.status = "idle";
    },
    saveFailed(s, error: string) {
      if (s.status !== "saving") return;
      s.status = "error";
      s.error = error;
    },
    retry(s) {
      if (s.status !== "error") return;
      s.error = null;
      s.status = "saving";
    },
    dismiss(s) {
      if (s.status !== "error") return;
      s.error = null;
      s.status = "idle";
    },
  },
  selectors: {
    getCount: (s) => s.count,
    isIdle: (s) => s.status === "idle",
  },
});

// ── Catalog ──

Deno.test("cell: method labels are cellName:methodKey format", () => {
  assertEquals(counter.increment.type, "counter:increment");
  assertEquals(counter.decrement.type, "counter:decrement");
  assertEquals(counter.reset.type, "counter:reset");
  assertEquals(counter.save.type, "counter:save");
  assertEquals(counter.saved.type, "counter:saved");
  assertEquals(counter.saveFailed.type, "counter:saveFailed");
});

Deno.test("cell: method default params preserved", () => {
  const composed = composeCells([counter]);
  // No args → `by` defaults to 1 inside the method.
  const r = composed.reduce(composed.initialState, {
    type: "counter:increment",
    payload: { args: [] },
  });
  assertEquals((r.state.counter as { count: number }).count, 1);
});

Deno.test("cell: selectors via compose", () => {
  // Test selectors through compose — the public consumption path
  const composed = composeCells([counter]);
  const state = composed.reduce(composed.initialState, {
    type: "counter:increment",
    payload: { args: [42] },
  }).state;
  // Actually invoke the cell's selectors against the composed slice
  const slice = state.counter as Record<string, unknown>;
  assertEquals(
    (counter.__aio.selectors.getCount as (s: unknown) => unknown)(slice),
    42,
  );
  assertEquals(
    (counter.__aio.selectors.isIdle as (s: unknown) => unknown)(slice),
    true,
  );
});

// ── composeCells() ──

Deno.test("compose: reduce routes action to correct cell", () => {
  const composed = composeCells([counter]);
  const result = composed.reduce(composed.initialState, {
    type: "counter:increment",
    payload: { args: [5] },
  });
  const s = result.state.counter as Record<string, unknown>;
  assertEquals(s.count, 5);
  assertEquals(s.status, "idle");
});

Deno.test("compose: guard ignores action in wrong state", () => {
  const composed = composeCells([counter]);
  // Can't 'saved' from idle — the guard only accepts it in 'saving'
  const result = composed.reduce(composed.initialState, {
    type: "counter:saved",
    payload: { args: [] },
  });
  assertEquals(result.effects.length, 0);
  const s = result.state.counter as Record<string, unknown>;
  assertEquals(s.count, 0); // unchanged
  assertEquals(s.status, "idle"); // unchanged
});

Deno.test("compose: status lifecycle transitions correctly", () => {
  const composed = composeCells([counter]);
  const dispatch = (
    state: Record<string, unknown>,
    type: string,
    args: unknown[] = [],
  ) => composed.reduce(state, { type, payload: { args } });

  // idle → save → saving
  const r1 = dispatch(composed.initialState, "counter:save");
  assertEquals((r1.state.counter as { status: string }).status, "saving");

  // saving → saved → idle
  const r2 = dispatch(r1.state, "counter:saved");
  assertEquals((r2.state.counter as { status: string }).status, "idle");

  // saving → saveFailed → error
  const r3 = dispatch(r1.state, "counter:saveFailed", ["disk full"]);
  assertEquals((r3.state.counter as { status: string }).status, "error");
  assertEquals((r3.state.counter as { error: string }).error, "disk full");

  // error → retry → saving
  const r4 = dispatch(r3.state, "counter:retry");
  assertEquals((r4.state.counter as { status: string }).status, "saving");
  assertEquals((r4.state.counter as { error: null }).error, null); // cleared

  // error → dismiss → idle
  const r5 = dispatch(r3.state, "counter:dismiss");
  assertEquals((r5.state.counter as { status: string }).status, "idle");
});

Deno.test("compose: multiple cells isolated", () => {
  const a = cell("alpha", {
    state: { x: 0 },
    methods: {
      inc(s) {
        s.x += 1;
      },
    },
  });
  const b = cell("beta", {
    state: { y: 0 },
    methods: {
      inc(s) {
        s.y += 1;
      },
    },
  });

  const composed = composeCells([a, b]);
  const r = composed.reduce(composed.initialState, {
    type: "alpha:inc",
    payload: { args: [] },
  });
  assertEquals((r.state.alpha as Record<string, number>).x, 1);
  assertEquals((r.state.beta as Record<string, number>).y, 0);
});

// ── Dependency resolution ──

Deno.test("compose: dependency order respected", () => {
  const a = cell("a", {
    state: { v: "a" },
    methods: {
      ping(s) {
        s.v = "a-done";
      },
    },
  });
  const b = cell("b", {
    state: { v: "b" },
    methods: {
      ping(s) {
        s.v = "b-done";
      },
    },
  });

  // b depends on a — a should be before b in cells list
  const composed = composeCells([
    { cell: b, dependsOn: ["a"] },
    a,
  ]);
  assertEquals(composed.cellNames, ["a", "b"]);
});

Deno.test("compose: cycle detection", () => {
  const a = cell("a", {
    state: {},
    methods: { x(_s) {} },
  });
  const b = cell("b", {
    state: {},
    methods: { x(_s) {} },
  });

  assertThrows(
    () =>
      composeCells([
        { cell: a, dependsOn: ["b"] },
        { cell: b, dependsOn: ["a"] },
      ]),
    Error,
    "cycle",
  );
});

Deno.test("compose: unknown dependency", () => {
  const a = cell("a", {
    state: {},
    methods: { x(_s) {} },
  });

  assertThrows(
    () => composeCells([{ cell: a, dependsOn: ["nonexistent"] }]),
    Error,
    "unknown cell",
  );
});

Deno.test("compose: duplicate cell name", () => {
  const a1 = cell("dup", {
    state: {},
    methods: { x(_s) {} },
  });
  const a2 = cell("dup", {
    state: {},
    methods: { y(_s) {} },
  });

  assertThrows(
    () => composeCells([a1, a2]),
    Error,
    "duplicate",
  );
});

// ── testCell() harness ──

testCell(counter, "increment from idle", (t) => {
  t.init();
  t.send.increment(5);
  t.expect.state((s) => s.count === 5);
  t.expect.state((s) => s.status === "idle");
});

testCell(counter, "guard blocks save while already saving", (t) => {
  t.init();
  // Can't save twice — first save goes to 'saving', second is ignored
  t.send.save();
  t.expect.state((s) => s.status === "saving");
  t.send.save(); // ignored by the guard
  t.expect.state((s) => s.status === "saving"); // still saving, no corruption
});

testCell(counter, "count is always a number (property-based)", (t) => {
  t.init();
  t.randomActions(200);
  t.expect.invariant((s) => typeof s.count === "number");
  t.expect.invariant((s) => !isNaN(s.count as number));
});

testCell(counter, "full lifecycle", (t) => {
  t.init();
  t.send.increment(10);
  t.expect.state((s) => s.count === 10);
  t.expect.state((s) => s.status === "idle");

  t.destroy();
  t.expect.state((s) => s.count === 0);

  t.init();
  t.expect.state((s) => s.count === 0);
  t.expect.state((s) => s.status === "idle");
});

// ── Fix A: a ScheduleEffect $do'd from a sync method ──

Deno.test("methods: a sync method's $do'd ScheduleEffect surfaces it", () => {
  const f = cell("sched", {
    state: { count: 0 },
    methods: {
      tick(s) {
        s.count += 1;
        s.$do(schedule.after("sched:retry", 1000, {
          type: "sched:tick",
          payload: { args: [] },
        }));
      },
    },
  });
  const composed = composeCells([f]);
  const result = composed.reduce(composed.initialState, {
    type: "sched:tick",
    payload: { args: [] },
  });
  assertEquals(result.effects.length, 1);
  assertEquals(result.effects[0]!.type, "__schedule");
  assertEquals((result.state.sched as { count: number }).count, 1);
});

// ── ScopedApp.getFullState ──────────────────────────────────────────

Deno.test("onInit: getFullState returns full app state", () => {
  let fullStateInInit: unknown = null;

  const a = cell("alpha", {
    state: { x: 1 },
    methods: { noop(_s) {} },
    onInit(app) {
      fullStateInInit = app.getFullState?.() ?? null;
    },
  });

  const b = cell("beta", {
    state: { y: 2 },
    methods: { noop(_s) {} },
  });

  const composed = composeCells([a, b]);

  // Simulate initAll
  const state = composed.initialState;
  composed.initAll({ dispatch: () => {}, getState: () => state });

  assertEquals(fullStateInInit !== null, true);
  assertEquals(
    typeof (fullStateInInit as Record<string, unknown>).alpha,
    "object",
  );
  assertEquals(
    typeof (fullStateInInit as Record<string, unknown>).beta,
    "object",
  );
  assertEquals(
    ((fullStateInInit as Record<string, unknown>).alpha as Record<
      string,
      unknown
    >).x,
    1,
  );
  assertEquals(
    ((fullStateInInit as Record<string, unknown>).beta as Record<
      string,
      unknown
    >).y,
    2,
  );
});

Deno.test("onInit: getState still returns own slice only", () => {
  let ownState: unknown = null;

  const f = cell("myf", {
    state: { val: 42 },
    methods: { noop(_s) {} },
    onInit(app) {
      ownState = app.getState();
    },
  });

  const composed = composeCells([f]);
  composed.initAll({
    dispatch: () => {},
    getState: () => composed.initialState,
  });

  assertEquals((ownState as Record<string, unknown>).val, 42);
  // own slice is { val: 42 }, not { myf: { val: 42 } }
  assertEquals((ownState as Record<string, unknown>).myf, undefined);
});

// ── cell persist + ui config ──────────────────────────────────
// framework internals tests — __aio access intentional
// persist/ui config has no public getter; consumed by server internals at runtime

Deno.test("cell persist: 'all' sets persist on internals", () => {
  const f = cell("rich", {
    state: { name: "", htmlCache: "" },
    methods: {
      setName(s, n: string) {
        s.name = n;
      },
    },
    persist: "all",
  });
  assertEquals(f.__aio.persist, "all");
});

Deno.test("cell persist: { exclude } sets persist on internals", () => {
  const f = cell("doc", {
    state: { title: "", body: "", rendered: "", thumbnail: "" },
    methods: {
      setTitle(s, t: string) {
        s.title = t;
      },
    },
    persist: { exclude: ["rendered", "thumbnail"] },
  });
  assertEquals(f.__aio.persist, { exclude: ["rendered", "thumbnail"] });
});

Deno.test("cell persist: { include } sets persist on internals", () => {
  const f = cell("small", {
    state: { count: 0, cache: "" },
    methods: {
      inc(s) {
        s.count++;
      },
    },
    persist: { include: ["count"] },
  });
  assertEquals(f.__aio.persist, { include: ["count"] });
});

Deno.test("cell persist: absent defaults to undefined (none)", () => {
  const f = cell("plain", {
    state: { x: 0 },
    methods: {
      inc(s) {
        s.x++;
      },
    },
  });
  assertEquals(f.__aio.persist, undefined);
});

Deno.test("cell ui: 'all' sets ui on internals", () => {
  const f = cell("visible", {
    state: { count: 0 },
    methods: {
      inc(s) {
        s.count++;
      },
    },
    visible: "all",
  });
  assertEquals(f.__aio.ui, "all");
});

Deno.test("cell ui: { include } sets ui on internals", () => {
  const f = cell("partial", {
    state: { count: 0, secret: "" },
    methods: {
      inc(s) {
        s.count++;
      },
    },
    visible: { include: ["count"] },
  });
  assertEquals(f.__aio.ui, { include: ["count"] });
});

Deno.test("cell ui: { exclude } sets ui on internals", () => {
  const f = cell("filtered", {
    state: { count: 0, cache: "" },
    methods: {
      inc(s) {
        s.count++;
      },
    },
    visible: { exclude: ["cache"] },
  });
  assertEquals(f.__aio.ui, { exclude: ["cache"] });
});

Deno.test("cell ui: forUser is extracted", () => {
  const fn = (exposed: Record<string, unknown>) => exposed;
  const f = cell("admin", {
    state: { users: [] as string[] },
    methods: {
      add(s, u: string) {
        s.users.push(u);
      },
    },
    visible: { include: ["users"], forUser: fn },
  });
  assertEquals(f.__aio.ui, { include: ["users"] });
  assertEquals(f.__aio.uiForUser, fn);
});

Deno.test("cell ui: absent defaults to undefined (none)", () => {
  const f = cell("hidden", {
    state: { x: 0 },
    methods: {
      inc(s) {
        s.x++;
      },
    },
  });
  assertEquals(f.__aio.ui, undefined);
  assertEquals(f.__aio.uiForUser, undefined);
});

// ── Persist filter in composition ──────────────────────────────
// framework internals test — __aio access intentional (verifies compose preserves cell config)

Deno.test("compose: persist 'all' cell included, no-persist cell excluded", () => {
  const a = cell("kept", {
    state: { val: 1 },
    methods: {
      set(s, v: number) {
        s.val = v;
      },
    },
    persist: "all",
  });
  const b = cell("dropped", {
    state: { tmp: 0 },
    methods: {
      set(s, v: number) {
        s.tmp = v;
      },
    },
  });

  const composed = composeCells([a, b] as unknown as CellEntry[]);

  assertEquals(composed.cells[0]!.__aio.persist, "all");
  assertEquals(composed.cells[1]!.__aio.persist, undefined);
});

Deno.test("compose: persist { include } filters fields", () => {
  const f = cell("data", {
    state: { count: 0, cache: "", name: "x" },
    methods: {
      inc(s) {
        s.count++;
      },
    },
    persist: { include: ["count", "name"] },
  });

  assertEquals(f.__aio.persist, { include: ["count", "name"] });
});

// ── UI filter in composition ──────────────────────────────
// framework internals test — __aio access intentional (verifies compose preserves cell config)

Deno.test("compose: ui 'all' cell visible, ui absent cell hidden", () => {
  const visible = cell("vis", {
    state: { count: 0 },
    methods: {
      inc(s) {
        s.count++;
      },
    },
    visible: "all",
  });
  const hidden = cell("bg", {
    state: { queue: [] as string[] },
    methods: {
      push(s, v: string) {
        s.queue.push(v);
      },
    },
  });

  const composed = composeCells([visible, hidden] as unknown as CellEntry[]);

  assertEquals(composed.cells[0]!.__aio.ui, "all");
  assertEquals(composed.cells[1]!.__aio.ui, undefined);
});

// ── cellDefaults behavior ──────────────────────────────

Deno.test("cell without persist/ui has undefined filters (cellDefaults applied at app level)", () => {
  const f = cell("bare", {
    state: { x: 0 },
    methods: {
      inc(s) {
        s.x++;
      },
    },
  });

  assertEquals(f.__aio.persist, undefined);
  assertEquals(f.__aio.ui, undefined);
  assertEquals(f.__aio.uiForUser, undefined);
});

Deno.test("cell with explicit config is not overridden by cellDefaults", () => {
  const f = cell("explicit", {
    state: { count: 0, secret: "" },
    methods: {
      inc(s) {
        s.count++;
      },
    },
    persist: { include: ["count"] },
    visible: { exclude: ["secret"] },
  });

  assertEquals(f.__aio.persist, { include: ["count"] });
  assertEquals(f.__aio.ui, { exclude: ["secret"] });
});

Deno.test("cell with empty methods map is a valid state-only cell (thin-client stub)", () => {
  // `aio create` remote-electron/android scaffolds: cell('app', { state: {}, methods: {} })
  const stub = cell("stub-empty", { state: {}, methods: {} });
  assertEquals(stub.__aio.id, "stub-empty");

  // Omitting methods entirely is tolerated at runtime (state-only cell)
  // deno-lint-ignore no-explicit-any
  const stateOnly = (cell as any)("stub-state-only", { state: { label: "x" } });
  assertEquals(stateOnly.__aio.id, "stub-state-only");
  assertEquals(stateOnly.label, "x");
});

Deno.test("validateConfig: every typed UiConfig key is accepted (ui.entry regression)", async () => {
  const { validateConfig, VALID_UI_KEYS, NUMERIC_VALUES } = await import(
    "../src/server/config.ts"
  );
  // Every key the UiConfig type documents must validate — a typed option that
  // exits the process at boot is the worst kind of bug.
  //
  // The sample VALUE has to suit the key: `width` and `height` are numbers and
  // are range-checked (`NUMERIC_VALUES`), so handing them a string would test
  // the opposite of this test's claim — it would assert that a nonsense value
  // is ACCEPTED. The one table that knows which keys are numeric decides here
  // too, so a key that becomes numeric later cannot quietly re-lenient this.
  const typedUiKeys = ["title", "width", "height", "showStatus", "entry"];
  const sample = (k: string): unknown =>
    k in NUMERIC_VALUES ? (NUMERIC_VALUES[k]?.min ?? 0) + 1 : "x";
  for (const k of typedUiKeys) {
    let exited = false;
    validateConfig(
      { [k]: sample(k) },
      VALID_UI_KEYS,
      "ui",
      ((_c: number) => {
        exited = true;
        throw new Error("exit");
        // deno-lint-ignore no-explicit-any
      }) as any,
    );
    assertEquals(exited, false, `typed ui key "${k}" was rejected`);
  }
});
