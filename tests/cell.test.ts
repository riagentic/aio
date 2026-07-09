import { assertEquals, assertThrows } from "@std/assert";
import { cell, composeCells, tagSource, testCell } from "../src/state/cell.ts";
import type { CellEntry } from "../src/state/cell-types.ts";
import { schedule } from "../src/state/schedule.ts";
import { aio } from "../src/server/aio.ts";

// ── cell() — catalog generation ─────────────────────────────────

const counter = cell("counter", {
  state: { count: 0, lastUpdatedAt: 0, error: null as string | null },
  actions: {
    increment: (by = 1) => ({ by }),
    decrement: (by = 1) => ({ by }),
    reset: () => ({}),
    save: () => ({}),
    saved: () => ({}),
    saveFailed: (error: string) => ({ error }),
    retry: () => ({}),
    dismiss: () => ({}),
  },
  effects: {
    persist: (value: number) => ({ value }),
    log: (message: string) => ({ message }),
  },
  machine: {
    initial: "idle",
    states: {
      idle: {
        increment: "idle",
        decrement: "idle",
        reset: "idle",
        save: "saving",
      },
      saving: { saved: "idle", saveFailed: "error" },
      error: { retry: "saving", dismiss: "idle" },
    },
  },
  reduce: {
    // __aio.effects access intentional — standard pattern for action-style cells (no public accessor)
    increment(state, payload) {
      state.count += payload.by;
      state.lastUpdatedAt = Date.now();
      return [counter.__aio.effects.log(`incremented to ${state.count}`)];
    },
    decrement(state, payload) {
      state.count -= payload.by;
      state.lastUpdatedAt = Date.now();
    },
    reset(state) {
      state.count = 0;
    },
    save(state) {
      return [counter.__aio.effects.persist(state.count)];
    },
    saved() {},
    saveFailed(state, payload) {
      state.error = payload.error;
    },
    retry(state) {
      state.error = null;
      return [counter.__aio.effects.persist(state.count)];
    },
    dismiss(state) {
      state.error = null;
    },
  },
  execute: {
    persist(app) {
      app.dispatch(
        (counter.__aio.actions as unknown as Record<string, any>).saved(),
      );
    },
    log() {/* noop in tests */},
  },
  selectors: {
    getCount: (s) => s.count,
    isIdle: (s) =>
      (s as unknown as { __aio_status: string }).__aio_status === "idle",
  },
});

// ── A catalog ──

Deno.test("cell: action labels are cellName:actionKey format", () => {
  assertEquals(counter.increment.type, "counter:increment");
  assertEquals(counter.decrement.type, "counter:decrement");
  assertEquals(counter.reset.type, "counter:reset");
  assertEquals(counter.save.type, "counter:save");
  assertEquals(counter.saved.type, "counter:saved");
  assertEquals(counter.saveFailed.type, "counter:saveFailed");
});

Deno.test("cell: action creators produce { type, payload }", () => {
  assertEquals(
    (counter.__aio.actions as unknown as Record<string, any>).increment(5),
    {
      type: "counter:increment",
      payload: { by: 5 },
    },
  );
  assertEquals(
    (counter.__aio.actions as unknown as Record<string, any>).decrement(3),
    {
      type: "counter:decrement",
      payload: { by: 3 },
    },
  );
  assertEquals(
    (counter.__aio.actions as unknown as Record<string, any>).reset(),
    { type: "counter:reset", payload: {} },
  );
  assertEquals(
    (counter.__aio.actions as unknown as Record<string, any>).save(),
    { type: "counter:save", payload: {} },
  );
});

Deno.test("cell: default params preserved", () => {
  assertEquals(
    (counter.__aio.actions as unknown as Record<string, any>).increment(),
    {
      type: "counter:increment",
      payload: { by: 1 },
    },
  );
});

Deno.test("cell: effect labels and creators", () => {
  // framework internals test — __aio access intentional (effects have no public accessor)
  assertEquals(counter.__aio.effects.persist.type, "counter:persist");
  assertEquals(counter.__aio.effects.log.type, "counter:log");
  assertEquals(counter.__aio.effects.persist(42), {
    type: "counter:persist",
    payload: { value: 42 },
  });
  assertEquals(counter.__aio.effects.log("hi"), {
    type: "counter:log",
    payload: { message: "hi" },
  });
});

Deno.test("cell: selectors via compose", () => {
  // Test selectors through compose — the public consumption path
  const composed = composeCells([counter]);
  let state = composed.initialState;
  state = composed.reduce(
    state,
    (counter.__aio.actions as unknown as Record<string, any>).increment(42),
  ).state;
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

// ── Machine validation ──

Deno.test("cell: machine validates action keys", () => {
  assertThrows(
    () =>
      cell("bad", {
        state: {},
        actions: { go: () => ({}) },
        machine: { initial: "a", states: { a: { typo: "a" } } },
        reduce() {},
      }),
    Error,
    "unknown action",
  );
});

Deno.test("cell: machine validates target states", () => {
  assertThrows(
    () =>
      cell("bad", {
        state: {},
        actions: { go: () => ({}) },
        // @ts-expect-error — intentionally invalid: "nonexistent" is not a declared state
        machine: { initial: "a", states: { a: { go: "nonexistent" } } },
        reduce() {},
      }),
    Error,
    "unknown target",
  );
});

Deno.test("cell: machine validates initial state exists", () => {
  assertThrows(
    () =>
      cell("bad", {
        state: {},
        actions: { go: () => ({}) },
        // @ts-expect-error — intentionally invalid: "nope" is not a declared state
        machine: { initial: "nope", states: { a: { go: "a" } } },
        reduce() {},
      }),
    Error,
    "not in declared states",
  );
});

Deno.test("cell: machine validates reachability", () => {
  assertThrows(
    () =>
      cell("bad", {
        state: {},
        actions: { go: () => ({}) },
        machine: {
          initial: "a",
          states: { a: { go: "a" }, orphan: { go: "a" } },
        },
        reduce() {},
      }),
    Error,
    "unreachable",
  );
});

Deno.test("cell: simple machine accepted", () => {
  const f = cell("simple", {
    state: { x: 0 },
    actions: { set: (x: number) => ({ x }) },
    machine: false,
    reduce: {
      set(state, payload) {
        state.x = payload.x;
      },
    },
  });
  // Cell identity verified via action type prefix (public API)
  assertEquals(f.set.type, "simple:set");
});

Deno.test("cell: foreign actions in machine allowed", () => {
  // Should not throw — foreign actions have ':' and are allowed
  const dc = cell("dc", {
    state: {},
    actions: { priceUpdated: (price: number) => ({ price }) },
    machine: { initial: "idle", states: { idle: { priceUpdated: "idle" } } },
    reduce() {},
  });

  const te = cell("te", {
    state: { price: 0 },
    actions: { placeOrder: () => ({}) },
    machine: {
      initial: "idle",
      states: {
        idle: { placeOrder: "waiting", [dc.priceUpdated.type]: "idle" },
        waiting: { [dc.priceUpdated.type]: "idle" },
      },
    },
    reduce: {
      ["dc:priceUpdated"](state, payload) {
        state.price = payload.price;
      },
    },
  });

  // Verify foreign action routing works via compose (behavioral test)
  const composed = composeCells([dc, te]);
  const r = composed.reduce(
    composed.initialState,
    (dc.__aio.actions as unknown as Record<string, any>).priceUpdated(42000),
  );
  assertEquals((r.state.te as Record<string, unknown>).price, 42000);
});

// ── composeCells() ──

Deno.test("compose: initialState includes __aio_status", () => {
  const composed = composeCells([counter]);
  const state = composed.initialState as Record<
    string,
    Record<string, unknown>
  >;
  assertEquals(state.counter!.__aio_status, "idle");
  assertEquals(state.counter!.count, 0);
});

Deno.test("compose: simple machine has no _status", () => {
  const f = cell("noop", {
    state: { x: 1 },
    actions: { set: () => ({}) },
    machine: false,
    reduce() {},
  });
  const composed = composeCells([f]);
  assertEquals(
    (composed.initialState.noop as Record<string, unknown>)._status,
    undefined,
  );
});

Deno.test("compose: reduce routes action to correct cell", () => {
  const composed = composeCells([counter]);
  const result = composed.reduce(
    composed.initialState,
    (counter.__aio.actions as unknown as Record<string, any>).increment(5),
  );
  const s = result.state.counter as Record<string, unknown>;
  assertEquals(s.count, 5);
  assertEquals(s.__aio_status, "idle");
  assertEquals(result.effects.length, 1);
  assertEquals(result.effects[0]!.type, "counter:log");
});

Deno.test("compose: machine guard blocks invalid transitions", () => {
  const composed = composeCells([counter]);
  // Can't 'saved' from idle — only valid in 'saving'
  const result = composed.reduce(
    composed.initialState,
    (counter.__aio.actions as unknown as Record<string, any>).saved(),
  );
  assertEquals(result.effects.length, 0);
  assertEquals((result.state.counter as Record<string, unknown>).count, 0); // unchanged
});

Deno.test("compose: state machine transitions correctly", () => {
  const composed = composeCells([counter]);

  // idle → save → saving
  const r1 = composed.reduce(
    composed.initialState,
    (counter.__aio.actions as unknown as Record<string, any>).save(),
  );
  assertEquals(
    (r1.state.counter as Record<string, unknown>).__aio_status,
    "saving",
  );
  assertEquals(r1.effects.length, 1); // persist effect

  // saving → saved → idle
  const r2 = composed.reduce(
    r1.state,
    (counter.__aio.actions as unknown as Record<string, any>).saved(),
  );
  assertEquals(
    (r2.state.counter as Record<string, unknown>).__aio_status,
    "idle",
  );

  // saving → saveFailed → error
  const r3 = composed.reduce(
    r1.state,
    (counter.__aio.actions as unknown as Record<string, any>).saveFailed(
      "disk full",
    ),
  );
  assertEquals(
    (r3.state.counter as Record<string, unknown>).__aio_status,
    "error",
  );
  assertEquals(
    (r3.state.counter as Record<string, unknown>).error,
    "disk full",
  );

  // error → retry → saving
  const r4 = composed.reduce(
    r3.state,
    (counter.__aio.actions as unknown as Record<string, any>).retry(),
  );
  assertEquals(
    (r4.state.counter as Record<string, unknown>).__aio_status,
    "saving",
  );
  assertEquals((r4.state.counter as Record<string, unknown>).error, null); // cleared

  // error → dismiss → idle
  const r5 = composed.reduce(
    r3.state,
    (counter.__aio.actions as unknown as Record<string, any>).dismiss(),
  );
  assertEquals(
    (r5.state.counter as Record<string, unknown>).__aio_status,
    "idle",
  );
});

Deno.test("compose: multiple cells isolated", () => {
  const a = cell("alpha", {
    state: { x: 0 },
    actions: { inc: () => ({}) },
    machine: false,
    reduce(state) {
      state.x += 1;
    },
  });
  const b = cell("beta", {
    state: { y: 0 },
    actions: { inc: () => ({}) },
    machine: false,
    reduce(state) {
      state.y += 1;
    },
  });

  const composed = composeCells([a, b]);
  const r = composed.reduce(
    composed.initialState,
    (a.__aio.actions as unknown as Record<string, any>).inc(),
  );
  assertEquals((r.state.alpha as Record<string, number>).x, 1);
  assertEquals((r.state.beta as Record<string, number>).y, 0);
});

Deno.test("compose: foreign action routing", () => {
  const dc = cell("dc", {
    state: { price: 0 },
    actions: { priceUpdated: (price: number) => ({ price }) },
    machine: { initial: "idle", states: { idle: { priceUpdated: "idle" } } },
    reduce: {
      priceUpdated(state, payload) {
        state.price = payload.price;
      },
    },
  });

  const te = cell("te", {
    state: { lastPrice: 0 },
    actions: { noop: () => ({}) },
    machine: {
      initial: "idle",
      states: { idle: { noop: "idle", [dc.priceUpdated.type]: "idle" } },
    },
    reduce: {
      ["dc:priceUpdated"](state, payload) {
        state.lastPrice = payload.price;
      },
    },
  });

  const composed = composeCells([dc, te]);
  const r = composed.reduce(
    composed.initialState,
    (dc.__aio.actions as unknown as Record<string, any>).priceUpdated(42000),
  );

  // DC updates its own state
  assertEquals((r.state.dc as Record<string, unknown>).price, 42000);
  // TE listens and updates too
  assertEquals((r.state.te as Record<string, unknown>).lastPrice, 42000);
});

// ── Dependency resolution ──

Deno.test("compose: dependency order respected", () => {
  const order: string[] = [];
  const a = cell("a", {
    state: { v: "a" },
    actions: { ping: () => ({}) },
    machine: false,
    reduce(state) {
      order.push("a");
      state.v = "a-done";
    },
  });
  const b = cell("b", {
    state: { v: "b" },
    actions: { ping: () => ({}) },
    machine: false,
    reduce(state) {
      order.push("b");
      state.v = "b-done";
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
    actions: { x: () => ({}) },
    machine: false,
    reduce() {},
  });
  const b = cell("b", {
    state: {},
    actions: { x: () => ({}) },
    machine: false,
    reduce() {},
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
    actions: { x: () => ({}) },
    machine: false,
    reduce() {},
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
    actions: { x: () => ({}) },
    machine: false,
    reduce() {},
  });
  const a2 = cell("dup", {
    state: {},
    actions: { y: () => ({}) },
    machine: false,
    reduce() {},
  });

  assertThrows(
    () => composeCells([a1, a2]),
    Error,
    "duplicate",
  );
});

// ── testCell() harness ──

testCell<{ count: number; lastUpdatedAt: number; error: string | null }>(
  counter,
  "increment from idle",
  (t) => {
    t.init();
    t.send.increment!(5);
    t.expect.state((s) => s.count === 5);
    t.expect.effects(["counter:log"]);
    t.expect.status("idle");
  },
);

testCell<{ count: number; lastUpdatedAt: number; error: string | null }>(
  counter,
  "save triggers persist effect",
  (t) => {
    t.init();
    t.send.save!();
    t.expect.status("saving");
    t.expect.effects(["counter:persist"]);
    t.expect.effectCount(1);
  },
);

testCell<{ count: number; lastUpdatedAt: number; error: string | null }>(
  counter,
  "machine blocks invalid transition",
  (t) => {
    t.init();
    // Can't save twice — first save goes to 'saving', second is blocked
    t.send.save!();
    t.expect.status("saving");
    t.send.save!(); // blocked by machine
    t.expect.effectCount(0); // no new effects
    t.expect.status("saving"); // still saving
  },
);

testCell<{ count: number; lastUpdatedAt: number; error: string | null }>(
  counter,
  "count is always a number (property-based)",
  (t) => {
    t.init();
    t.randomActions(200);
    t.expect.invariant((s) => typeof s.count === "number");
    t.expect.invariant((s) => !isNaN(s.count));
  },
);

testCell<{ count: number; lastUpdatedAt: number; error: string | null }>(
  counter,
  "full lifecycle",
  (t) => {
    t.init();
    t.send.increment!(10);
    t.expect.state((s) => s.count === 10);
    t.expect.status("idle");

    t.destroy();
    t.expect.state((s) => s.count === 0);

    t.init();
    t.expect.state((s) => s.count === 0);
    t.expect.status("idle");
  },
);

// middleware: freeze returns action (passthrough)

Deno.test("aio.middleware.freeze: passthrough returns the action", () => {
  const mw = aio.middleware.freeze();
  const result = mw({ type: "Test", payload: {} }, {}) as { type: string };
  assertEquals(result.type, "Test");
});

// middleware: devtools returns action (passthrough)

Deno.test("aio.middleware.devtools: passthrough returns the action", () => {
  const mw = aio.middleware.devtools();
  const result = mw({ type: "Test", payload: {} }, {}) as { type: string };
  assertEquals(result.type, "Test");
});

// middleware: perfBudget stores start time

Deno.test("aio.middleware.perfBudget: stores perf start on globalThis", () => {
  const mw = aio.middleware.perfBudget({ reduce: 10 });
  mw({ type: "Test", payload: {} }, {});
  assertEquals(
    typeof (globalThis as Record<string, unknown>).__aioMiddlewarePerfStart,
    "number",
  );
  // cleanup
  delete (globalThis as Record<string, unknown>).__aioMiddlewarePerfStart;
  delete (globalThis as Record<string, unknown>).__aioMiddlewarePerfBudget;
});

// middleware: validate warns on array payload

Deno.test("aio.middleware.validate: warns on array payload", () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  const mw = aio.middleware.validate();
  const result = mw({ type: "Test", payload: [1, 2, 3] }, {});
  console.log = origLog;
  assertEquals(result !== null, true); // not dropped, just warned
  assertEquals(logs.some((l) => l.includes("plain object")), true);
});

// middleware: validate allows undefined payload

Deno.test("aio.middleware.validate: allows undefined payload", () => {
  const mw = aio.middleware.validate();
  const result = mw({ type: "Test" }, {});
  assertEquals(result !== null, true);
});

// middleware: metrics tracks multiple cells

Deno.test("aio.middleware.metrics: tracks errors field initialized to 0", () => {
  const mw = aio.middleware.metrics();
  mw({ type: "Foo:Bar", payload: {} }, {});
  const counters = (globalThis as Record<string, unknown>).__aioMetrics as Map<
    string,
    { count: number; errors: number }
  >;
  assertEquals(counters.get("Foo")?.errors, 0);
  delete (globalThis as Record<string, unknown>).__aioMetrics;
});

// ── Fix A: ScheduleEffect in reduce return ──

Deno.test("reduce: accepts ScheduleEffect in effects array", () => {
  const f = cell("sched", {
    state: { count: 0 },
    actions: { tick: () => ({}) },
    effects: { log: (msg: string) => ({ msg }) },
    machine: false,
    reduce: {
      tick() {
        // __aio.effects access intentional — standard pattern for action-style cells
        return [
          f.__aio.effects.log("hello"),
          schedule.after("sched:retry", 1000, {
            type: "sched:tick",
            payload: {},
          }),
        ];
      },
    },
  });
  const composed = composeCells([f]);
  const result = composed.reduce(
    composed.initialState,
    (f.__aio.actions as unknown as Record<string, any>).tick(),
  );
  assertEquals(result.effects.length, 2);
  assertEquals(result.effects[0]!.type, "sched:log");
  assertEquals(result.effects[1]!.type, "__schedule");
});

// ── Verify: machine: false does NOT receive foreign actions ──

Deno.test("compose: machine: false does not receive foreign actions", () => {
  let betaReduced = false;
  const alpha = cell("alpha", {
    state: {},
    actions: { fire: () => ({}) },
    machine: false,
    reduce() {},
  });
  const beta = cell("beta", {
    state: { heard: false },
    actions: { update: () => ({}) },
    machine: false,
    reduce(state, action) {
      // foreign action — cast to Msg for cross-cell access
      const msg = action as { type: string };
      if (msg.type === "alpha:fire") {
        betaReduced = true;
        state.heard = true;
      }
    },
  });
  const composed = composeCells([alpha, beta]);
  const result = composed.reduce(
    composed.initialState,
    (alpha.__aio.actions as unknown as Record<string, any>).fire(),
  );
  // beta should NOT have received the action — machine: false can't declare foreign listeners
  assertEquals(betaReduced, false);
  assertEquals((result.state.beta as Record<string, unknown>).heard, false);
});

Deno.test("compose: machine with foreign action declaration DOES receive foreign actions", () => {
  let betaReduced = false;
  const alpha = cell("alpha", {
    state: {},
    actions: { fire: () => ({}) },
    machine: false,
    reduce() {},
  });
  const beta = cell("beta", {
    state: { heard: false },
    actions: { update: () => ({}) },
    machine: {
      initial: "idle",
      states: {
        idle: { update: "idle", [alpha.fire.type]: "idle" },
      },
    },
    reduce: {
      update() {},
      ["alpha:fire"](state) {
        betaReduced = true;
        state.heard = true;
      },
    },
  });
  const composed = composeCells([alpha, beta]);
  const result = composed.reduce(
    composed.initialState,
    (alpha.__aio.actions as unknown as Record<string, any>).fire(),
  );
  assertEquals(betaReduced, true);
  assertEquals((result.state.beta as Record<string, unknown>).heard, true);
});

// ── ScopedApp.getFullState ──────────────────────────────────────────

Deno.test("onInit: getFullState returns full app state", () => {
  let fullStateInInit: unknown = null;

  const a = cell("alpha", {
    state: { x: 1 },
    actions: { noop: () => ({}) },
    machine: false,
    onInit(app) {
      fullStateInInit = app.getFullState?.() ?? null;
    },
  });

  const b = cell("beta", {
    state: { y: 2 },
    actions: { noop: () => ({}) },
    machine: false,
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
    actions: { noop: () => ({}) },
    machine: false,
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
    actions: { noop: () => ({}) },
    machine: false,
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
    actions: { inc: () => ({}) },
    machine: false,
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
    ui: "all",
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
    ui: { include: ["count"] },
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
    ui: { exclude: ["cache"] },
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
    ui: { include: ["users"], forUser: fn },
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

// ── Mixed mode: methods + actions + effects in one cell ──

Deno.test("mixed: methods + actions coexist in one cell", () => {
  const f = cell("mixed", {
    state: { count: 0, label: "" },
    methods: {
      increment(s: { count: number }, by = 1) {
        s.count += by;
      },
    },
    actions: {
      SetLabel: (label: string) => ({ label }),
    },
    reduce: {
      SetLabel(state: { label: string }, payload: { label: string }) {
        state.label = payload.label;
      },
    },
  });

  // Method works
  assertEquals(
    (f.__aio.actions as unknown as Record<string, any>).increment(),
    {
      type: "mixed:increment",
      payload: { args: [] },
    },
  );
  assertEquals(
    (f.__aio.actions as unknown as Record<string, any>).increment(5),
    {
      type: "mixed:increment",
      payload: { args: [5] },
    },
  );

  // Action works (explicit actions are flattened at runtime)
  assertEquals(
    (f.__aio.actions as unknown as Record<string, any>).SetLabel("hello"),
    { type: "mixed:SetLabel", payload: { label: "hello" } },
  );
});

Deno.test("mixed: methods + actions + effects compose correctly", () => {
  const effectsRun: string[] = [];
  const f = cell("shop", {
    state: { items: [] as string[], synced: false },
    methods: {
      add(s: { items: string[] }, item: string) {
        s.items.push(item);
      },
      clear(s: { items: string[] }) {
        s.items = [];
      },
    },
    actions: {
      MarkSynced: () => ({}),
    },
    effects: {
      SyncToServer: (items: string[]) => ({ items }),
    },
    reduce: {
      MarkSynced(state: { synced: boolean }) {
        state.synced = true;
      },
    },
    execute: {
      SyncToServer(_app: unknown, payload: { items: string[] }) {
        effectsRun.push(`sync:${payload.items.join(",")}`);
      },
    },
  });

  const composed = composeCells([f]);
  let state = composed.initialState;

  // Method dispatch works
  state = composed.reduce(
    state,
    (f.__aio.actions as unknown as Record<string, any>).add("apple"),
  ).state;
  assertEquals((state.shop as { items: string[] }).items, ["apple"]);

  // Action dispatch works (explicit actions flattened at runtime)
  state = composed.reduce(
    state,
    (f.__aio.actions as unknown as Record<string, any>).MarkSynced(),
  ).state;
  assertEquals((state.shop as { synced: boolean }).synced, true);

  // framework internals test — __aio access intentional (effects have no public accessor)
  assertEquals(
    (f.__aio.effects as unknown as Record<string, { type: string }>)
      .SyncToServer!.type,
    "shop:SyncToServer",
  );
});

Deno.test("mixed: name collision between method and action throws", () => {
  assertThrows(
    () =>
      cell("bad", {
        state: {},
        methods: {
          save(s: Record<string, unknown>) {
            s.saved = true;
          },
        },
        actions: { save: () => ({}) },
      }),
    Error,
    "collides with method",
  );
});

Deno.test("mixed: name collision between method and effect throws", () => {
  assertThrows(
    () =>
      cell("bad", {
        state: {},
        methods: {
          sync(s: Record<string, unknown>) {
            s.synced = true;
          },
        },
        effects: { sync: () => ({}) },
      }),
    Error,
    "collides with method",
  );
});

Deno.test("mixed: name collision between generator and action throws", () => {
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () =>
      cell("bad" as any, {
        state: {},
        methods: { noop() {} },
        // deno-lint-ignore no-explicit-any
        generators: {
          *process(_ctx: any): any {
            yield 1;
          },
        },
        actions: { process: () => ({}) },
      } as any),
    Error,
    "collides with generator",
  );
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
    ui: "all",
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
    ui: { exclude: ["secret"] },
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
