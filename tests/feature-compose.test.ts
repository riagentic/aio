import { assertEquals, assertExists } from "@std/assert";
import { feature } from "../src/feature-create.ts";
import { composeFeatures } from "../src/feature-compose.ts";
import type { Msg } from "../src/feature-types.ts";
import type { FeatureStatus } from "../src/feature-compose.ts";

// ── Helper features ─────────────────────────────────────────────────

const counter = feature("counter", {
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

const flags = feature("flags", {
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

// ── 1. composeFeatures basic — single feature ──────────────────────

Deno.test("compose basic: initialState has feature key", () => {
  const composed = composeFeatures([counter]);
  assertExists(composed.initialState.counter);
  assertEquals((composed.initialState.counter as { count: number }).count, 0);
});

Deno.test("compose basic: reduce works and returns updated state", () => {
  const composed = composeFeatures([counter]);
  const action: Msg = { type: "counter:increment", payload: { args: [5] } };
  const result = composed.reduce(composed.initialState, action);
  assertEquals((result.state.counter as { count: number }).count, 5);
});

Deno.test("compose basic: reduce returns effects array", () => {
  // Feature with an effect returned from reduce
  const fx = feature("fx", {
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
        return [fx.__aio.effects.sideEffect()];
      },
    },
  });
  const composed = composeFeatures([fx]);
  const result = composed.reduce(composed.initialState, fx.go());
  assertEquals(result.effects.length, 1);
  assertEquals(result.effects[0]!.type, "fx:sideEffect");
});

Deno.test("compose basic: featureNames populated", () => {
  const composed = composeFeatures([counter]);
  assertEquals(composed.featureNames, ["counter"]);
});

// ── 2. Multi-feature composition ───────────────────────────────────

Deno.test("multi-feature: each gets own state slice", () => {
  const composed = composeFeatures([counter, flags]);
  assertExists(composed.initialState.counter);
  assertExists(composed.initialState.flags);
  assertEquals((composed.initialState.counter as { count: number }).count, 0);
  assertEquals(
    (composed.initialState.flags as { active: boolean }).active,
    false,
  );
});

Deno.test("multi-feature: featureNames lists all features", () => {
  const composed = composeFeatures([counter, flags]);
  assertEquals(composed.featureNames.includes("counter"), true);
  assertEquals(composed.featureNames.includes("flags"), true);
  assertEquals(composed.featureNames.length, 2);
});

Deno.test("multi-feature: actions are isolated to own slice", () => {
  const composed = composeFeatures([counter, flags]);
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

Deno.test("multi-feature: sequential actions accumulate", () => {
  const composed = composeFeatures([counter, flags]);
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
  const door = feature("door", {
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

  const composed = composeFeatures([door]);
  // closed state — 'close' is not allowed
  const r1 = composed.reduce(composed.initialState, door.close());
  assertEquals(r1.effects.length, 0);
  assertEquals((r1.state.door as { opened: boolean }).opened, false); // unchanged

  // closed → open works
  const r2 = composed.reduce(composed.initialState, door.open());
  assertEquals((r2.state.door as { opened: boolean }).opened, true);
  assertEquals((r2.state.door as { _status: string })._status, "open");

  // open state — 'lock' is not allowed
  const r3 = composed.reduce(r2.state, door.lock());
  assertEquals(r3.effects.length, 0);
  assertEquals((r3.state.door as { _status: string })._status, "open"); // unchanged
});

Deno.test("machine guard: returns unchanged state reference", () => {
  const m = feature("m", {
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
  const composed = composeFeatures([m]);
  // 'blocked' not valid from state 'a' (only valid in 'b')
  const result = composed.reduce(composed.initialState, m.blocked());
  assertEquals(result.state, composed.initialState);
});

// ── 4. State validation ────────────────────────────────────────────

Deno.test("validate: valid state passes through", () => {
  const validated = feature("validated", {
    state: { score: 0 },
    methods: {
      setScore(s, n: number) {
        s.score = n;
      },
    },
    validate: (s) => s.score >= 0 ? true : "score must be non-negative",
  });

  const composed = composeFeatures([validated]);
  const result = composed.reduce(composed.initialState, {
    type: "validated:setScore",
    payload: { args: [10] },
  });
  assertEquals((result.state.validated as { score: number }).score, 10);
});

const validated2 = feature("validated2", {
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
  const composed = composeFeatures([validated2], {
    onFeatureError: (err) => errors.push(err),
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
  const guarded = feature("guarded", {
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
  const composed = composeFeatures([guarded], {
    onFeatureError: (err) => errors.push(err),
  });
  // Valid
  const r1 = composed.reduce(composed.initialState, guarded.set(50));
  assertEquals((r1.state.guarded as { val: number }).val, 50);

  // Invalid — exceeds 100
  const r2 = composed.reduce(r1.state, guarded.set(200));
  assertEquals((r2.state.guarded as { val: number }).val, 50); // unchanged
  assertEquals(errors.length, 1);
});

// ── 5. Circuit breaker ─────────────────────────────────────────────

Deno.test("circuit breaker: auto-disables feature after error threshold", () => {
  const tripped: string[] = [];

  const buggy = feature("buggy", {
    state: { x: 0 },
    actions: { go: () => ({}) },
    effects: { crash: () => ({}) },
    machine: false,
    reduce: {
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
  const composed = composeFeatures([buggy], {
    onFeatureError: (err) => errors.push(err),
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

Deno.test("circuit breaker: below threshold keeps feature enabled", () => {
  const buggy2 = feature("buggy2", {
    state: {},
    actions: { go: () => ({}) },
    effects: { crash: () => ({}) },
    machine: false,
    reduce: {
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

  const composed = composeFeatures([buggy2], {
    onFeatureError: () => {},
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
  const composed = composeFeatures([counter]);
  assertEquals(composed.registry.isEnabled("counter"), true);
});

Deno.test("registry: disable/enable toggle", () => {
  const composed = composeFeatures([counter]);
  const app = {
    dispatch: (_a: Msg) => {},
    getState: () => composed.initialState,
  };

  composed.registry.disable("counter", app);
  assertEquals(composed.registry.isEnabled("counter"), false);

  composed.registry.enable("counter", app);
  assertEquals(composed.registry.isEnabled("counter"), true);
});

Deno.test("registry: disabled feature actions are dropped", () => {
  const composed = composeFeatures([counter]);
  const app = {
    dispatch: (_a: Msg) => {},
    getState: () => composed.initialState,
  };

  composed.registry.disable("counter", app);

  // Action to disabled feature should be dropped (state unchanged)
  const result = composed.reduce(composed.initialState, {
    type: "counter:increment",
    payload: { args: [99] },
  });
  assertEquals((result.state.counter as { count: number }).count, 0); // unchanged
});

Deno.test("registry: status returns _status from machine", () => {
  const stateful = feature("stateful", {
    state: { v: 0 },
    actions: { go: () => ({}) },
    machine: {
      initial: "idle",
      states: { idle: { go: "active" }, active: { go: "idle" } },
    },
    reduce: { go() {} },
  });
  const composed = composeFeatures([stateful]);
  assertEquals(
    composed.registry.status("stateful", composed.initialState),
    "idle",
  );

  const r = composed.reduce(composed.initialState, stateful.go());
  assertEquals(composed.registry.status("stateful", r.state), "active");
});

Deno.test("registry: health returns all features info", () => {
  const composed = composeFeatures([counter, flags]);
  const health = composed.registry.health(composed.initialState);
  assertEquals(health.length, 2);

  const counterHealth = health.find((h: FeatureStatus) =>
    h.name === "counter"
  )!;
  assertEquals(counterHealth.enabled, true);
  assertEquals(counterHealth.errors, 0);

  const flagsHealth = health.find((h: FeatureStatus) => h.name === "flags")!;
  assertEquals(flagsHealth.enabled, true);
  assertEquals(flagsHealth.errors, 0);
});

Deno.test("registry: list features via featureNames", () => {
  const composed = composeFeatures([counter, flags]);
  assertEquals(composed.featureNames.length, 2);
  assertEquals(composed.featureNames.includes("counter"), true);
  assertEquals(composed.featureNames.includes("flags"), true);
});

// ── 7. Feature error counting ──────────────────────────────────────

Deno.test("errors: increment on executor throw, visible in health()", () => {
  const errFeat = feature("errFeat", {
    state: {},
    actions: { go: () => ({}) },
    effects: { fail: () => ({}) },
    machine: false,
    reduce: {
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

  const composed = composeFeatures([errFeat], {
    onFeatureError: () => {},
  });
  const app = {
    dispatch: (_a: Msg) => {},
    getState: () => composed.initialState,
  };

  // Trigger errors
  composed.execute(app, { type: "errFeat:fail", payload: {} });
  composed.execute(app, { type: "errFeat:fail", payload: {} });

  const health = composed.registry.health(composed.initialState);
  const h = health.find((h: FeatureStatus) => h.name === "errFeat")!;
  assertEquals(h.errors, 2);
  assertEquals(h.enabled, true);
});

Deno.test("errors: re-enable resets error counter", () => {
  const errFeat2 = feature("errFeat2", {
    state: {},
    actions: { go: () => ({}) },
    effects: { fail: () => ({}) },
    machine: false,
    reduce: {
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

  const composed = composeFeatures([errFeat2], {
    onFeatureError: () => {},
  });
  const app = {
    dispatch: (_a: Msg) => {},
    getState: () => composed.initialState,
  };

  composed.execute(app, { type: "errFeat2:fail", payload: {} });
  assertEquals(
    composed.registry.health(composed.initialState).find((h: FeatureStatus) =>
      h.name === "errFeat2"
    )!.errors,
    1,
  );

  // Disable then re-enable resets errors
  composed.registry.disable("errFeat2", app);
  composed.registry.enable("errFeat2", app);
  assertEquals(
    composed.registry.health(composed.initialState).find((h: FeatureStatus) =>
      h.name === "errFeat2"
    )!.errors,
    0,
  );
});

// ── AIO-71 #7: Feature method error context ─────────────────────────

Deno.test("reduce error includes feature name and method name in message", () => {
  const buggy = feature("wallet", {
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

  const composed = composeFeatures([buggy]);
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
  // Error message must include feature name and method name for DX
  const msg = caught!.message;
  assertEquals(
    msg.includes("wallet") && msg.includes("withdraw"),
    true,
    `error message should include feature name 'wallet' and method name 'withdraw', got: "${msg}"`,
  );
  // Original error message must be preserved
  assertEquals(
    msg.includes("insufficient funds"),
    true,
    `original error message should be preserved, got: "${msg}"`,
  );
});

Deno.test("reduce error includes context for machine-guarded features", () => {
  const stateful = feature("door", {
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

  const composed = composeFeatures([stateful]);
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
    `error message should include feature 'door' and method 'open', got: "${msg}"`,
  );
  assertEquals(
    msg.includes("door is locked"),
    true,
    `original error preserved, got: "${msg}"`,
  );
});
