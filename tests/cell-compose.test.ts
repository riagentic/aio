import { assertEquals, assertExists } from "@std/assert";
import { cell } from "../src/cell-create.ts";
import { composeCells } from "../src/cell-compose.ts";
import type { Msg } from "../src/cell-types.ts";
import type { CellStatus } from "../src/cell-compose.ts";

// ── Helper cells ─────────────────────────────────────────────────

const counter = cell("counter", {
  state: { count: 0 },
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
  },
});

const flags = cell("flags", {
  state: { active: false, label: "" },
  methods: {
    activate(s) {
      s.active = true;
    },
    deactivate(s) {
      s.active = false;
    },
    setLabel(s, label: string) {
      s.label = label;
    },
  },
});

// ── 1. composeCells basic — single cell ──────────────────────

Deno.test("compose basic: initialState has cell key", () => {
  const composed = composeCells([counter]);
  assertExists(composed.initialState.counter);
  assertEquals((composed.initialState.counter as { count: number }).count, 0);
});

Deno.test("compose basic: reduce works and returns updated state", () => {
  const composed = composeCells([counter]);
  const action: Msg = { type: "counter:increment", payload: { args: [5] } };
  const result = composed.reduce(composed.initialState, action);
  assertEquals((result.state.counter as { count: number }).count, 5);
});

Deno.test("compose basic: reduce returns effects array", () => {
  // Cell with an effect returned from reduce
  const fx = cell("fx", {
    state: { x: 0 },
    actions: {
      go: () => ({}),
    },
    effects: {
      sideEffect: () => ({}),
    },
    machine: false,
    reduce: {
      go(state) {
        state.x = 1;
        // __aio.effects access intentional — standard pattern for action-style cells
        return [fx.__aio.effects.sideEffect()];
      },
    },
  });
  const composed = composeCells([fx]);
  const result = composed.reduce(composed.initialState, fx.__aio.actions.go());
  assertEquals(result.effects.length, 1);
  assertEquals(result.effects[0]!.type, "fx:sideEffect");
});

Deno.test("compose basic: cellNames populated", () => {
  const composed = composeCells([counter]);
  assertEquals(composed.cellNames, ["counter"]);
});

// ── 2. Multi-cell composition ───────────────────────────────────

Deno.test("multi-cell: each gets own state slice", () => {
  const composed = composeCells([counter, flags]);
  assertExists(composed.initialState.counter);
  assertExists(composed.initialState.flags);
  assertEquals((composed.initialState.counter as { count: number }).count, 0);
  assertEquals(
    (composed.initialState.flags as { active: boolean }).active,
    false,
  );
});

Deno.test("multi-cell: cellNames lists all cells", () => {
  const composed = composeCells([counter, flags]);
  assertEquals(composed.cellNames.includes("counter"), true);
  assertEquals(composed.cellNames.includes("flags"), true);
  assertEquals(composed.cellNames.length, 2);
});

Deno.test("multi-cell: actions are isolated to own slice", () => {
  const composed = composeCells([counter, flags]);
  const r1 = composed.reduce(composed.initialState, {
    type: "counter:increment",
    payload: { args: [10] },
  });
  assertEquals((r1.state.counter as { count: number }).count, 10);
  assertEquals((r1.state.flags as { active: boolean }).active, false); // unchanged

  const r2 = composed.reduce(r1.state, {
    type: "flags:activate",
    payload: { args: [] },
  });
  assertEquals((r2.state.counter as { count: number }).count, 10); // still 10
  assertEquals((r2.state.flags as { active: boolean }).active, true);
});

Deno.test("multi-cell: sequential actions accumulate", () => {
  const composed = composeCells([counter, flags]);
  let state = composed.initialState;
  state = composed.reduce(state, {
    type: "counter:increment",
    payload: { args: [3] },
  }).state;
  state = composed.reduce(state, {
    type: "counter:increment",
    payload: { args: [7] },
  }).state;
  state = composed.reduce(state, {
    type: "flags:setLabel",
    payload: { args: ["hello"] },
  }).state;
  assertEquals((state.counter as { count: number }).count, 10);
  assertEquals((state.flags as { label: string }).label, "hello");
});

// ── 3. Machine guards ──────────────────────────────────────────────

Deno.test("machine guard: blocks action not allowed in current state", () => {
  const door = cell("door", {
    state: { opened: false },
    actions: {
      open: () => ({}),
      close: () => ({}),
      lock: () => ({}),
    },
    machine: {
      initial: "closed",
      states: {
        closed: { open: "open", lock: "locked" },
        open: { close: "closed" },
        locked: { open: "closed" }, // unlock by opening → closed
      },
    },
    reduce: {
      open(state) {
        state.opened = true;
      },
      close(state) {
        state.opened = false;
      },
      lock() {},
    },
  });

  const composed = composeCells([door]);
  // closed state — 'close' is not allowed
  const r1 = composed.reduce(composed.initialState, door.__aio.actions.close());
  assertEquals(r1.effects.length, 0);
  assertEquals((r1.state.door as { opened: boolean }).opened, false); // unchanged

  // closed → open works
  const r2 = composed.reduce(composed.initialState, door.__aio.actions.open());
  assertEquals((r2.state.door as { opened: boolean }).opened, true);
  assertEquals(
    (r2.state.door as { __aio_status: string }).__aio_status,
    "open",
  );

  // open state — 'lock' is not allowed
  const r3 = composed.reduce(r2.state, door.__aio.actions.lock());
  assertEquals(r3.effects.length, 0);
  assertEquals(
    (r3.state.door as { __aio_status: string }).__aio_status,
    "open",
  ); // unchanged
});

Deno.test("machine guard: returns unchanged state reference", () => {
  const m = cell("m", {
    state: { v: 0 },
    actions: { go: () => ({}), blocked: () => ({}) },
    machine: {
      initial: "a",
      states: {
        a: { go: "b" },
        b: { blocked: "a", go: "a" },
      },
    },
    reduce: {
      go(state) {
        state.v = 1;
      },
      blocked() {},
    },
  });
  const composed = composeCells([m]);
  // 'blocked' not valid from state 'a' (only valid in 'b')
  const result = composed.reduce(composed.initialState, m.__aio.actions.blocked());
  assertEquals(result.state, composed.initialState);
});

// ── 4. State validation ────────────────────────────────────────────

Deno.test("validate: valid state passes through", () => {
  const validated = cell("validated", {
    state: { score: 0 },
    methods: {
      setScore(s, n: number) {
        s.score = n;
      },
    },
    validate: (s) => s.score >= 0 ? true : "score must be non-negative",
  });

  const composed = composeCells([validated]);
  const result = composed.reduce(composed.initialState, {
    type: "validated:setScore",
    payload: { args: [10] },
  });
  assertEquals((result.state.validated as { score: number }).score, 10);
});

const validated2 = cell("validated2", {
  state: { score: 0 },
  methods: {
    setScore(s, n: number) {
      s.score = n;
    },
  },
  validate: (s) => s.score >= 0 ? true : "score must be non-negative",
});

Deno.test("validate: invalid state rejects — returns old state", () => {
  const errors: unknown[] = [];
  const composed = composeCells([validated2], {
    onCellError: (err) => errors.push(err),
  });
  const result = composed.reduce(composed.initialState, {
    type: "validated2:setScore",
    payload: { args: [-5] },
  });
  assertEquals((result.state.validated2 as { score: number }).score, 0);
  assertEquals(result.effects.length, 0);
  assertEquals(errors.length, 1);
});

Deno.test("validate: with machine — invalid state rejects", () => {
  const guarded = cell("guarded", {
    state: { val: 10 },
    actions: { set: (v: number) => ({ v }) },
    machine: {
      initial: "ready",
      states: { ready: { set: "ready" } },
    },
    reduce: {
      set(state, payload) {
        state.val = payload.v;
      },
    },
    validate: (s) => s.val <= 100 ? true : "val must be <= 100",
  });

  const errors: unknown[] = [];
  const composed = composeCells([guarded], {
    onCellError: (err) => errors.push(err),
  });
  // Valid
  const r1 = composed.reduce(composed.initialState, guarded.__aio.actions.set(50));
  assertEquals((r1.state.guarded as { val: number }).val, 50);

  // Invalid — exceeds 100
  const r2 = composed.reduce(r1.state, guarded.__aio.actions.set(200));
  assertEquals((r2.state.guarded as { val: number }).val, 50); // unchanged
  assertEquals(errors.length, 1);
});

// ── 5. Circuit breaker ─────────────────────────────────────────────

Deno.test("circuit breaker: auto-disables cell after error threshold", () => {
  const tripped: string[] = [];

  const buggy = cell("buggy", {
    state: { x: 0 },
    actions: { go: () => ({}) },
    effects: { crash: () => ({}) },
    machine: false,
    reduce: {
      // __aio.effects access intentional — standard pattern for action-style cells
      go() {
        return [buggy.__aio.effects.crash()];
      },
    },
    execute: {
      crash() {
        throw new Error("boom");
      },
    },
  });

  const errors: unknown[] = [];
  const composed = composeCells([buggy], {
    onCellError: (err) => errors.push(err),
    circuitBreaker: {
      maxErrors: 3,
      onTrip: (name, count) => tripped.push(`${name}:${count}`),
    },
  });

  const dispatched: Msg[] = [];
  const app = {
    dispatch: (a: Msg) => dispatched.push(a),
    getState: () => composed.initialState,
  };

  // Wire circuit breaker dispatch via initAll
  composed.initAll(app);

  // Trigger 3 errors
  composed.execute(app, { type: "buggy:crash", payload: {} });
  composed.execute(app, { type: "buggy:crash", payload: {} });
  composed.execute(app, { type: "buggy:crash", payload: {} });

  assertEquals(tripped.length, 1);
  assertEquals(tripped[0], "buggy:3");
  assertEquals(composed.registry.isEnabled("buggy"), false);
});

Deno.test("circuit breaker: below threshold keeps cell enabled", () => {
  const buggy2 = cell("buggy2", {
    state: {},
    actions: { go: () => ({}) },
    effects: { crash: () => ({}) },
    machine: false,
    reduce: {
      // __aio.effects access intentional — standard pattern for action-style cells
      go() {
        return [buggy2.__aio.effects.crash()];
      },
    },
    execute: {
      crash() {
        throw new Error("boom");
      },
    },
  });

  const composed = composeCells([buggy2], {
    onCellError: () => {},
    circuitBreaker: { maxErrors: 5 },
  });

  const app = {
    dispatch: (_a: Msg) => {},
    getState: () => composed.initialState,
  };
  composed.initAll(app);

  // Only 2 errors — below threshold of 5
  composed.execute(app, { type: "buggy2:crash", payload: {} });
  composed.execute(app, { type: "buggy2:crash", payload: {} });

  assertEquals(composed.registry.isEnabled("buggy2"), true);
});

// ── 6. Registry ────────────────────────────────────────────────────

Deno.test("registry: isEnabled returns true by default", () => {
  const composed = composeCells([counter]);
  assertEquals(composed.registry.isEnabled("counter"), true);
});

Deno.test("registry: disable/enable toggle", () => {
  const composed = composeCells([counter]);
  const app = {
    dispatch: (_a: Msg) => {},
    getState: () => composed.initialState,
  };

  composed.registry.disable("counter", app);
  assertEquals(composed.registry.isEnabled("counter"), false);

  composed.registry.enable("counter", app);
  assertEquals(composed.registry.isEnabled("counter"), true);
});

Deno.test("registry: disabled cell actions are dropped", () => {
  const composed = composeCells([counter]);
  const app = {
    dispatch: (_a: Msg) => {},
    getState: () => composed.initialState,
  };

  composed.registry.disable("counter", app);

  // Action to disabled cell should be dropped (state unchanged)
  const result = composed.reduce(composed.initialState, {
    type: "counter:increment",
    payload: { args: [99] },
  });
  assertEquals((result.state.counter as { count: number }).count, 0); // unchanged
});

Deno.test("registry: status returns _status from machine", () => {
  const stateful = cell("stateful", {
    state: { v: 0 },
    actions: { go: () => ({}) },
    machine: {
      initial: "idle",
      states: { idle: { go: "active" }, active: { go: "idle" } },
    },
    reduce: { go() {} },
  });
  const composed = composeCells([stateful]);
  assertEquals(
    composed.registry.status("stateful", composed.initialState),
    "idle",
  );

  const r = composed.reduce(composed.initialState, stateful.__aio.actions.go());
  assertEquals(composed.registry.status("stateful", r.state), "active");
});

Deno.test("registry: health returns all cells info", () => {
  const composed = composeCells([counter, flags]);
  const health = composed.registry.health(composed.initialState);
  assertEquals(health.length, 2);

  const counterHealth = health.find((h: CellStatus) => h.name === "counter")!;
  assertEquals(counterHealth.enabled, true);
  assertEquals(counterHealth.errors, 0);

  const flagsHealth = health.find((h: CellStatus) => h.name === "flags")!;
  assertEquals(flagsHealth.enabled, true);
  assertEquals(flagsHealth.errors, 0);
});

Deno.test("registry: list cells via cellNames", () => {
  const composed = composeCells([counter, flags]);
  assertEquals(composed.cellNames.length, 2);
  assertEquals(composed.cellNames.includes("counter"), true);
  assertEquals(composed.cellNames.includes("flags"), true);
});

// ── 7. Cell error counting ──────────────────────────────────────

Deno.test("errors: increment on executor throw, visible in health()", () => {
  const errFeat = cell("errFeat", {
    state: {},
    actions: { go: () => ({}) },
    effects: { fail: () => ({}) },
    machine: false,
    reduce: {
      // __aio.effects access intentional — standard pattern for action-style cells
      go() {
        return [errFeat.__aio.effects.fail()];
      },
    },
    execute: {
      fail() {
        throw new Error("test error");
      },
    },
  });

  const composed = composeCells([errFeat], {
    onCellError: () => {},
  });
  const app = {
    dispatch: (_a: Msg) => {},
    getState: () => composed.initialState,
  };

  // Trigger errors
  composed.execute(app, { type: "errFeat:fail", payload: {} });
  composed.execute(app, { type: "errFeat:fail", payload: {} });

  const health = composed.registry.health(composed.initialState);
  const h = health.find((h: CellStatus) => h.name === "errFeat")!;
  assertEquals(h.errors, 2);
  assertEquals(h.enabled, true);
});

Deno.test("errors: re-enable resets error counter", () => {
  const errFeat2 = cell("errFeat2", {
    state: {},
    actions: { go: () => ({}) },
    effects: { fail: () => ({}) },
    machine: false,
    reduce: {
      // __aio.effects access intentional — standard pattern for action-style cells
      go() {
        return [errFeat2.__aio.effects.fail()];
      },
    },
    execute: {
      fail() {
        throw new Error("err");
      },
    },
  });

  const composed = composeCells([errFeat2], {
    onCellError: () => {},
  });
  const app = {
    dispatch: (_a: Msg) => {},
    getState: () => composed.initialState,
  };

  composed.execute(app, { type: "errFeat2:fail", payload: {} });
  assertEquals(
    composed.registry.health(composed.initialState).find((h: CellStatus) =>
      h.name === "errFeat2"
    )!.errors,
    1,
  );

  // Disable then re-enable resets errors
  composed.registry.disable("errFeat2", app);
  composed.registry.enable("errFeat2", app);
  assertEquals(
    composed.registry.health(composed.initialState).find((h: CellStatus) =>
      h.name === "errFeat2"
    )!.errors,
    0,
  );
});

// ── AIO-71 #7: Cell method error context ─────────────────────────

Deno.test("reduce error includes cell name and method name in message", () => {
  const buggy = cell("wallet", {
    state: { balance: 0 },
    methods: {
      withdraw(s, amount: number) {
        if (amount > s.balance) {
          throw new Error("insufficient funds");
        }
        s.balance -= amount;
      },
    },
  });

  const composed = composeCells([buggy]);
  const action: Msg = {
    type: "wallet:withdraw",
    payload: { args: [100] },
  };

  let caught: Error | undefined;
  try {
    composed.reduce(composed.initialState, action);
  } catch (e) {
    caught = e as Error;
  }

  assertExists(caught, "should have thrown");
  // Error message must include cell name and method name for DX
  const msg = caught!.message;
  assertEquals(
    msg.includes("wallet") && msg.includes("withdraw"),
    true,
    `error message should include cell name 'wallet' and method name 'withdraw', got: "${msg}"`,
  );
  // Original error message must be preserved
  assertEquals(
    msg.includes("insufficient funds"),
    true,
    `original error message should be preserved, got: "${msg}"`,
  );
});

Deno.test("reduce error includes context for machine-guarded cells", () => {
  const stateful = cell("door", {
    state: { locked: false },
    machine: {
      initial: "closed",
      states: {
        closed: { open: "open", lock: "closed" },
        open: { close: "closed" },
      },
    },
    methods: {
      open(s) {
        if (s.locked) throw new Error("door is locked");
      },
      close(_s) {},
      lock(s) {
        s.locked = true;
      },
    },
  });

  const composed = composeCells([stateful]);
  // Lock the door first
  let state = composed.reduce(composed.initialState, {
    type: "door:lock",
    payload: {},
  }).state;
  // Set locked=true on the state manually since lock method runs through Immer
  // Actually lock method already sets s.locked = true, let's use the returned state
  // Now open — the method will throw because locked=true
  let caught: Error | undefined;
  try {
    composed.reduce(state, { type: "door:open", payload: {} });
  } catch (e) {
    caught = e as Error;
  }

  assertExists(caught, "should have thrown");
  const msg = caught!.message;
  assertEquals(
    msg.includes("door") && msg.includes("open"),
    true,
    `error message should include cell 'door' and method 'open', got: "${msg}"`,
  );
  assertEquals(
    msg.includes("door is locked"),
    true,
    `original error preserved, got: "${msg}"`,
  );
});
