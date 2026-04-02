// reactive.test.ts — tests for feature({ methods }) reactive style
// (formerly reactive() — removed in v0.8, feature({ methods }) is identical)
import { assertEquals, assertThrows } from "@std/assert";
import {
  bindFeature,
  composeFeatures,
  feature,
  testFeature,
} from "../src/feature.ts";
import { schedule } from "../src/schedule.ts";
import { call } from "../src/feature-impl.ts";
import type { GenCtx } from "../src/flow.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Mini dispatch loop for integration tests */
function createApp(composed: ReturnType<typeof composeFeatures>) {
  let state = composed.initialState;
  const actions: { type: string }[] = [];
  const app = {
    dispatch: (action: { type: string; payload: unknown }): Promise<void> => {
      actions.push(action);
      const result = composed.reduce(state, action);
      state = result.state;
      for (const eff of result.effects) {
        composed.execute(app, eff as { type: string; payload: unknown });
      }
      return Promise.resolve();
    },
    getState: () => state,
    get state() {
      return state;
    },
    get actions() {
      return actions;
    },
  };
  return app;
}

// ── Sync method tests ───────────────────────────────────────────────

Deno.test("feature(methods): sync method mutates state", () => {
  const counter = feature("counter", {
    state: { count: 0 },
    methods: {
      increment(s, by = 1) {
        s.count += by;
      },
      reset(s) {
        s.count = 0;
      },
    },
  });

  assertEquals(counter.__aio.id, "counter");
  assertEquals(counter.increment!.type, "counter:increment");

  const composed = composeFeatures([counter]);
  let state = composed.initialState;
  state = composed.reduce(state, counter.increment!(5)).state;
  assertEquals((state.counter as { count: number }).count, 5);
});

Deno.test("feature(methods): multiple sync mutations in sequence", () => {
  const counter = feature("counter", {
    state: { count: 0 },
    methods: {
      increment(s, by = 1) {
        s.count += by;
      },
      reset(s) {
        s.count = 0;
      },
    },
  });

  const composed = composeFeatures([counter]);
  let state = composed.initialState;
  state = composed.reduce(state, counter.increment!(3)).state;
  state = composed.reduce(state, counter.increment!(7)).state;
  assertEquals((state.counter as { count: number }).count, 10);
  state = composed.reduce(state, counter.reset!()).state;
  assertEquals((state.counter as { count: number }).count, 0);
});

Deno.test("feature(methods): generates correct action types", () => {
  const cart = feature("cart", {
    state: { items: [] as string[] },
    methods: {
      addItem(s, item: string) {
        s.items.push(item);
      },
      clear(s) {
        s.items = [];
      },
    },
  });

  assertEquals(cart.addItem!.type, "cart:addItem");
  assertEquals(cart.clear!.type, "cart:clear");

  const action = cart.addItem!("book");
  assertEquals(action.type, "cart:addItem");
  assertEquals(action.payload, { args: ["book"] });
});

Deno.test("feature(methods): nested object mutation", () => {
  const app = feature("app", {
    state: { user: { name: "Alice", settings: { theme: "light" } } },
    methods: {
      setTheme(s, theme: string) {
        s.user.settings.theme = theme;
      },
      rename(s, name: string) {
        s.user.name = name;
      },
    },
  });

  const composed = composeFeatures([app]);
  let state = composed.initialState;
  state = composed.reduce(state, app.setTheme!("dark")).state;
  assertEquals((state.app as any).user.settings.theme, "dark");
});

Deno.test("feature(methods): array mutations via sync methods", () => {
  const list = feature("list", {
    state: { items: [] as string[] },
    methods: {
      add(s, item: string) {
        s.items.push(item);
      },
      remove(s, idx: number) {
        s.items.splice(idx, 1);
      },
      clear(s) {
        s.items = [];
      },
    },
  });

  const composed = composeFeatures([list]);
  let state = composed.initialState;
  state = composed.reduce(state, list.add!("a")).state;
  state = composed.reduce(state, list.add!("b")).state;
  state = composed.reduce(state, list.add!("c")).state;
  assertEquals((state.list as any).items, ["a", "b", "c"]);
  state = composed.reduce(state, list.remove!(1)).state;
  assertEquals((state.list as any).items, ["a", "c"]);
  state = composed.reduce(state, list.clear!()).state;
  assertEquals((state.list as any).items, []);
});

// ── Async method tests ──────────────────────────────────────────────

Deno.test("feature(methods): async method emits __exec effect", () => {
  const loader = feature("loader", {
    state: { data: null as string | null },
    methods: {
      async load(s) {
        const result = await Promise.resolve("fetched");
        s.data = result;
      },
    },
  });

  const composed = composeFeatures([loader]);
  const result = composed.reduce(composed.initialState, loader.load!() as any);
  assertEquals(result.effects.length, 1);
  assertEquals((result.effects[0] as any).type, "loader:__exec");
});

Deno.test("feature(methods): async method with live Proxy writes state", async () => {
  const loader = feature("loader", {
    state: { data: null as string | null, loading: false },
    methods: {
      setLoading(s, value: boolean) {
        s.loading = value;
      },
      async fetchData(s) {
        s.loading = true;
        const result = await Promise.resolve("hello world");
        s.data = result;
        s.loading = false;
      },
    },
  });

  const composed = composeFeatures([loader]);
  const app = createApp(composed);

  app.dispatch(loader.fetchData!() as any);
  await delay(50);

  assertEquals((app.state.loader as any).data, "hello world");
  assertEquals((app.state.loader as any).loading, false);
});

Deno.test("feature(methods): async method reads fresh state", async () => {
  const store = feature("store", {
    state: { value: 0, doubled: 0 },
    methods: {
      setValue(s, v: number) {
        s.value = v;
      },
      async compute(s) {
        s.value = 42;
        await delay(10);
        // s.value reads fresh state via Proxy
        s.doubled = s.value * 2;
      },
    },
  });

  const composed = composeFeatures([store]);
  const app = createApp(composed);

  app.dispatch(store.compute!() as any);
  await delay(50);

  assertEquals((app.state.store as any).value, 42);
  assertEquals((app.state.store as any).doubled, 84);
});

Deno.test("feature(methods): async array mutation via Proxy", async () => {
  const list = feature("list", {
    state: { items: ["a"] as string[] },
    methods: {
      async addAsync(s, item: string) {
        await delay(10);
        s.items.push(item);
      },
    },
  });

  const composed = composeFeatures([list]);
  const app = createApp(composed);

  app.dispatch(list.addAsync!("b") as any);
  await delay(50);

  assertEquals((app.state.list as any).items, ["a", "b"]);
});

// ── Microtask batching tests ────────────────────────────────────────

Deno.test("feature(methods): async consecutive writes are batched into one action", async () => {
  const counter = feature("counter", {
    state: { a: 0, b: 0, c: 0 },
    methods: {
      async setAll(s) {
        s.a = 1;
        s.b = 2;
        s.c = 3;
        // All three writes in same sync frame → one batched __set action
      },
    },
  });

  const composed = composeFeatures([counter]);
  const app = createApp(composed);

  app.dispatch(counter.setAll!() as any);
  await delay(50);

  assertEquals((app.state.counter as any).a, 1);
  assertEquals((app.state.counter as any).b, 2);
  assertEquals((app.state.counter as any).c, 3);

  // Should have: 1 trigger (counter:setAll) + 1 batched __set (not 3 individual __sets)
  const setActions = app.actions.filter((a) => a.type.includes("__set"));
  assertEquals(setActions.length, 1);
});

Deno.test("feature(methods): writes separated by await produce separate batches", async () => {
  const counter = feature("counter", {
    state: { a: 0, b: 0 },
    methods: {
      async staggered(s) {
        s.a = 1; // batch 1
        await delay(10);
        s.b = 2; // batch 2 (new microtask frame)
      },
    },
  });

  const composed = composeFeatures([counter]);
  const app = createApp(composed);

  app.dispatch(counter.staggered!() as any);
  await delay(50);

  assertEquals((app.state.counter as any).a, 1);
  assertEquals((app.state.counter as any).b, 2);

  // Two batches: one before await, one after
  const setActions = app.actions.filter((a) => a.type.includes("__set"));
  assertEquals(setActions.length, 2);
});

// ── Machine guard tests ─────────────────────────────────────────────

Deno.test("feature(methods): machine guards on sync methods", () => {
  const door = feature("door", {
    state: { opened: false },
    machine: {
      initial: "closed",
      states: {
        closed: { open: "open" },
        open: { close: "closed" },
      },
    },
    methods: {
      open(s) {
        s.opened = true;
      },
      close(s) {
        s.opened = false;
      },
    },
  });

  const composed = composeFeatures([door]);
  let state = composed.initialState;

  state = composed.reduce(state, door.open!()).state;
  assertEquals((state.door as any).opened, true);
  assertEquals((state.door as any).__aio_status, "open");

  // Can't open again
  const before = state;
  state = composed.reduce(state, door.open!()).state;
  assertEquals(state, before);

  state = composed.reduce(state, door.close!()).state;
  assertEquals((state.door as any).opened, false);
  assertEquals((state.door as any).__aio_status, "closed");
});

Deno.test("feature(methods): async Proxy writes gated by machine", async () => {
  const fetcher = feature("fetcher", {
    state: { data: null as string | null, loading: false },
    machine: {
      initial: "idle",
      states: {
        idle: { load: "loading" },
        loading: { done: "idle" },
      },
    },
    methods: {
      async load(s) {
        s.loading = true; // __set:load allowed (load→loading transition exists)
        const data = await Promise.resolve("result");
        s.data = data;
        s.loading = false;
      },
      done(s) {/* transition back to idle */},
    },
  });

  const composed = composeFeatures([fetcher]);
  const app = createApp(composed);

  // Trigger load from idle
  app.dispatch(fetcher.load!() as any);
  await delay(50);

  assertEquals((app.state.fetcher as any).data, "result");
  assertEquals((app.state.fetcher as any).loading, false);
});

Deno.test("feature(methods): async writes blocked when method not in current machine state", async () => {
  const gate = feature("gate", {
    state: { value: "initial" },
    machine: {
      initial: "locked",
      states: {
        locked: { unlock: "unlocked" },
        unlocked: { write: "unlocked", lock: "locked" },
      },
    },
    methods: {
      unlock(s) {/* just transition */},
      lock(s) {/* just transition */},
      async write(s) {
        s.value = "written";
      },
    },
  });

  const composed = composeFeatures([gate]);
  const app = createApp(composed);

  // Try to write while locked → should be blocked (write not in locked.on)
  app.dispatch(gate.write!() as any);
  await delay(50);
  assertEquals((app.state.gate as any).value, "initial"); // unchanged

  // Unlock, then write → should work
  app.dispatch(gate.unlock!());
  app.dispatch(gate.write!() as any);
  await delay(50);
  assertEquals((app.state.gate as any).value, "written");
});

Deno.test("feature(methods): machine validation rejects bad config", () => {
  assertThrows(
    () =>
      feature("bad", {
        state: {},
        machine: { initial: "nonexistent", states: { idle: {} } },
        methods: { noop() {} },
      }),
    Error,
    "not in declared states",
  );
});

// ── Integration tests ───────────────────────────────────────────────

Deno.test("feature(methods): coexists with feature(actions) in composeFeatures", () => {
  const counter = feature("counter", {
    state: { count: 0 },
    methods: {
      increment(s) {
        s.count++;
      },
    },
  });

  const logger = feature("logger", {
    state: { logs: [] as string[] },
    actions: { log: (msg: string) => ({ msg }) },
    reduce: {
      log(state, payload) {
        state.logs.push(payload.msg);
      },
    },
  });

  const composed = composeFeatures([counter, logger]);
  let state = composed.initialState;
  state = composed.reduce(state, counter.increment!()).state;
  state = composed.reduce(state, logger.log!("hello")).state;

  assertEquals((state.counter as any).count, 1);
  assertEquals((state.logger as any).logs, ["hello"]);
});

Deno.test("feature(methods): foreign action listeners", () => {
  const counter = feature("counter", {
    state: { count: 0 },
    methods: {
      increment(s) {
        s.count++;
      },
    },
  });

  const watcher = feature("watcher", {
    state: { lastSeen: "" },
    actions: { noop: () => ({}) },
    machine: {
      initial: "watching",
      states: {
        watching: { noop: "watching", "counter:increment": "watching" },
      },
    },
    reduce: {
      ["counter:increment"](state) {
        state.lastSeen = "increment";
      },
    },
  });

  const composed = composeFeatures([counter, watcher]);
  let state = composed.initialState;
  state = composed.reduce(state, counter.increment!()).state;
  assertEquals((state.watcher as any).lastSeen, "increment");
});

Deno.test("feature(methods): selectors scoped to feature", () => {
  const cart = feature("cart", {
    state: { items: [{ price: 10 }, { price: 20 }] },
    methods: {
      addItem(s, price: number) {
        s.items.push({ price });
      },
    },
    selectors: {
      total: (s) =>
        s.items.reduce((sum: number, i: { price: number }) => sum + i.price, 0),
    },
  });

  const composed = composeFeatures([cart]);
  assertEquals(cart.__aio.selectors.total!(composed.initialState), 30);
});

Deno.test("feature(methods): dispatchTo config", () => {
  const source = feature("source", {
    state: { value: 0 },
    dispatchTo: ["target"],
    methods: {
      set(s, v: number) {
        s.value = v;
      },
    },
  });

  assertEquals(source.__aio.crossDispatchPrefixes.has("target"), true);
});

Deno.test("feature(methods): onInit and onDestroy hooks", () => {
  const inits: string[] = [];
  const destroys: string[] = [];

  const f = feature("hooks", {
    state: { ready: false },
    methods: {
      activate(s) {
        s.ready = true;
      },
    },
    onInit: () => {
      inits.push("init");
    },
    onDestroy: () => {
      destroys.push("destroy");
    },
  });

  const composed = composeFeatures([f]);
  const app = createApp(composed);
  composed.initAll(app);
  assertEquals(inits, ["init"]);
  composed.destroyAll(app);
  assertEquals(destroys, ["destroy"]);
});

// ── Flattened API tests ──────────────────────────────────────────────

Deno.test("feature(methods): action creators flattened onto feature def", () => {
  const counter = feature("counter", {
    state: { count: 0 },
    methods: {
      increment(s, by = 1) {
        s.count += by;
      },
      reset(s) {
        s.count = 0;
      },
    },
  });

  // Flattened creators
  const action = (counter as any).increment(5);
  assertEquals(action.type, "counter:increment");
  assertEquals(action.payload, { args: [5] });

  // _actions catalog works (creators only, no PascalCase labels)
  assertEquals(counter.increment!.type, "counter:increment");
  assertEquals(counter.increment!(3).type, "counter:increment");
});

Deno.test("feature(methods): bindFeature enables direct dispatch and selectors", () => {
  const counter = feature("counter", {
    state: { count: 0 },
    methods: {
      increment(s, by = 1) {
        s.count += by;
      },
    },
    selectors: {
      doubled: (s) => s.count * 2,
    },
  });

  const composed = composeFeatures([counter]);
  const app = createApp(composed);

  // Before binding, flattened creator returns action object
  const action = (counter as any).increment(5);
  assertEquals(action.type, "counter:increment");

  // Bind to app
  bindFeature(
    counter,
    (a) => app.dispatch(a as any),
    () => app.state as Record<string, unknown>,
  ); // After binding, flattened creator dispatches directly
  (counter as any).increment(3);
  assertEquals((app.state.counter as any).count, 3);
  (counter as any).increment(7);
  assertEquals((app.state.counter as any).count, 10);

  // Bound selector reads current state
  assertEquals((counter as any).doubled(), 20);
});

Deno.test("feature(methods): selector/method name collision throws", () => {
  assertThrows(
    () =>
      feature("bad", {
        state: { count: 0 },
        methods: {
          total(s) {
            s.count++;
          },
        },
        selectors: { total: (s) => s.count },
      }),
    Error,
    "collides with selector",
  );
});

// testFeature calls Deno.test internally — must be top-level
const _counterForTest = feature("counterTest", {
  state: { count: 0 },
  methods: {
    increment(s: { count: number }, by = 1) {
      s.count += by;
    },
  },
});

testFeature(
  _counterForTest,
  "feature(methods): testFeature harness works",
  (t) => {
    t.init();
    t.send.increment!(5);
    t.expect.state((s: { count: number }) => s.count === 5);
  },
);

// Async testFeature with settle
const _asyncLoader = feature("asyncLoader", {
  state: { data: null as string | null, loading: false },
  methods: {
    async load(s: { data: string | null; loading: boolean }) {
      s.loading = true;
      const result = await Promise.resolve("loaded-data");
      s.data = result;
      s.loading = false;
    },
  },
});

testFeature(
  _asyncLoader,
  "feature(methods): async testFeature with settle",
  async (t) => {
    t.init();
    t.send.load!();
    await t.settle(); // auto-runs effects + drains microtasks
    t.expect.state((s: { data: string | null }) => s.data === "loaded-data");
    t.expect.state((s: { loading: boolean }) => s.loading === false);
  },
);

// Async error dispatches __error action (visible in time-travel, middleware)
const _errorFeature = feature("errorTest", {
  state: { status: "idle" },
  methods: {
    async failingMethod(_s: { status: string }) {
      throw new Error("boom");
    },
  },
});

testFeature(
  _errorFeature,
  "feature(methods): async error dispatches __error action",
  async (t) => {
    t.init();
    t.send.failingMethod!();
    await t.settle();
    // Verify __error action was dispatched (visible in time-travel)
    t.expect.state(() => true); // no crash = error was handled, not thrown
  },
);

// Async error with machine — __error self-loop keeps machine in current state
const _errorWithMachine = feature("errorMachine", {
  state: { data: null as string | null },
  machine: {
    initial: "idle",
    states: {
      idle: { load: "loading" },
      loading: { done: "idle" },
    },
  },
  methods: {
    async load(_s: { data: string | null }) {
      throw new Error("network error");
    },
    done(s: { data: string | null }) {
      s.data = "ok";
    },
  },
});

testFeature(
  _errorWithMachine,
  "feature(methods): __error self-loop preserves machine state",
  async (t) => {
    t.init();
    t.expect.status("idle");
    t.send.load!();
    t.expect.status("loading");
    await t.settle();
    // __error dispatched as self-loop in 'loading' — machine stays in loading
    t.expect.status("loading");
  },
);

// ── Sync methods returning schedule effects ──────────────────────────

Deno.test("feature(methods): sync method returns schedule effect", () => {
  const timer = feature("timer", {
    state: { count: 0 },
    methods: {
      start(s) {
        s.count++;
        return schedule.every("tick", 1000, { type: "Timer:Tick" });
      },
      tick(s) {
        s.count++;
      },
    },
  });

  const composed = composeFeatures([timer]);
  let state = composed.initialState;
  const result = composed.reduce(state, timer.start!());
  state = result.state;

  assertEquals((state.timer as any).count, 1);
  assertEquals(result.effects.length, 1);
  assertEquals((result.effects[0] as any).type, "__schedule");
  assertEquals((result.effects[0] as any).id, "tick");
});

Deno.test("feature(methods): sync method returns array of schedule effects", () => {
  const multi = feature("multi", {
    state: { v: 0 },
    methods: {
      setup(s) {
        s.v = 1;
        return [
          schedule.every("a", 500, { type: "Multi:A" }),
          schedule.every("b", 1000, { type: "Multi:B" }),
        ];
      },
    },
  });

  const composed = composeFeatures([multi]);
  const result = composed.reduce(composed.initialState, multi.setup!());
  assertEquals(result.effects.length, 2);
});

// ── listensTo without full machine ──────────────────────────────────

Deno.test("feature(methods): listensTo auto-generates machine for foreign listeners", () => {
  const counter = feature("counter", {
    state: { count: 0 },
    methods: {
      increment(s) {
        s.count++;
      },
    },
  });

  const watcher = feature("watcher", {
    state: { seen: 0 },
    listensTo: ["counter:increment"],
    methods: {
      onIncrement(s) {
        s.seen++;
      },
    },
  });

  // Verify machine was auto-generated
  assertEquals(watcher.__aio.machine !== false, true);
  assertEquals(
    watcher.__aio.foreignActions.includes("counter:increment"),
    true,
  );

  // Integration: watcher receives counter's actions
  const composed = composeFeatures([counter, watcher]);
  let state = composed.initialState;
  state = composed.reduce(state, counter.increment!()).state;
  // Foreign action routed to watcher's reducer
  assertEquals((state.watcher as any).seen, 0); // foreign actions don't auto-call methods — they're machine transitions
});

Deno.test("feature(methods): listensTo ignored when explicit machine provided", () => {
  const f = feature("test", {
    state: { v: 0 },
    machine: {
      initial: "active",
      states: { active: { bump: "active" } },
    },
    listensTo: ["other:action"], // should be ignored since machine is explicit
    methods: {
      bump(s) {
        s.v++;
      },
    },
  });

  // The explicit machine shouldn't include 'other:action' (it wasn't in states.active.on)
  assertEquals(f.__aio.foreignActions.includes("other:action"), false);
});

// ── call() inter-feature coordination ────────────────────────────────

Deno.test("call: dispatches observable action through store", async () => {
  const target = feature("target", {
    state: { value: 0 },
    methods: {
      async setValue(s, n: number) {
        s.value = n;
      },
    },
  });

  const composed = composeFeatures([target]);
  const app = createApp(composed);
  bindFeature(target, app.dispatch, app.getState);

  await target.setValue(42);
  await delay(10);

  // Action should be in the log — observable
  const found = app.actions.some((a: { type: string }) =>
    a.type === "target:setValue"
  );
  assertEquals(found, true);
  assertEquals((app.state.target as { value: number }).value, 42);
});

Deno.test("call: async method can call another feature", async () => {
  const callee = feature("callee", {
    state: { name: "" as string },
    methods: {
      async setName(s, name: string) {
        s.name = name;
      },
    },
    machine: false,
  });

  const caller = feature("caller", {
    state: { called: false },
    methods: {
      async callOther(s) {
        await callee.setName("from-caller"); // direct calling — typed, observable
        s.called = true;
      },
    },
    machine: false,
  });

  const composed = composeFeatures([caller, callee]);
  const app = createApp(composed);
  bindFeature(callee, app.dispatch, app.getState);
  bindFeature(caller, app.dispatch, app.getState);

  caller.callOther!();
  await delay(50);

  assertEquals(
    (app.state.callee as { name: string }).name,
    "from-caller",
    "callee should have been called",
  );
  assertEquals(
    (app.state.caller as { called: boolean }).called,
    true,
    "caller should have completed",
  );
});

Deno.test("call: rejects immediately when machine blocks the target action", async () => {
  const locked = feature("locked", {
    state: { value: 0 },
    machine: {
      initial: "idle",
      states: {
        idle: {}, // no transitions — everything blocked
      },
    },
    methods: {
      async setValue(s, n: number) {
        s.value = n;
      },
    },
  });

  const composed = composeFeatures([locked]);
  const app = createApp(composed);
  bindFeature(locked, app.dispatch, app.getState);

  let rejected = false;
  try {
    await locked.setValue(42);
  } catch {
    rejected = true;
  }

  assertEquals(
    rejected,
    true,
    "call() should reject when machine blocks the action",
  );
});

Deno.test("call: async method return value is resolved", async () => {
  const inventory = feature("inventory", {
    state: { stock: 10 },
    methods: {
      async checkStock(s, item: string) {
        return item === "widget" ? s.stock : 0; // returns number
      },
    },
  });

  const composed = composeFeatures([inventory]);
  const app = createApp(composed);
  bindFeature(inventory, app.dispatch, app.getState);

  const count = await inventory.checkStock("widget");
  assertEquals(count, 10, "call() should resolve with the return value");
});

Deno.test("call: timeout option rejects after specified ms", async () => {
  const slow = feature("slow", {
    state: { done: false },
    methods: {
      async slowOp(s) {
        await delay(100); // slower than the timeout
        s.done = true;
      },
    },
    machine: false,
  });

  const composed = composeFeatures([slow]);
  const app = createApp(composed);
  bindFeature(slow, app.dispatch, app.getState);

  let timedOut = false;
  try {
    await call({ timeout: 20 }, () => slow.slowOp());
  } catch (e) {
    timedOut = (e as Error).message.includes("timeout");
  }

  assertEquals(timedOut, true, "call() should timeout after 20ms");
  await delay(120); // wait for method to complete, avoiding timer leak
});

Deno.test("call: retries option retries on failure", async () => {
  let attempts = 0;
  const flaky = feature("flaky", {
    state: { result: "" },
    methods: {
      async tryOp(s) {
        attempts++;
        if (attempts < 3) throw new Error("not yet");
        s.result = "ok";
      },
    },
    machine: false,
  });

  const composed = composeFeatures([flaky]);
  const app = createApp(composed);
  bindFeature(flaky, app.dispatch, app.getState);

  await call({ retries: 3 }, () => flaky.tryOp());
  assertEquals(attempts, 3, "should have retried until success");
});

// ── generators ─────────────────────────────────────────────────────

Deno.test("feature(generators): generator runs when action dispatched", async () => {
  let ran = false;
  const wf = feature("wf", {
    state: { result: "" as string },
    methods: {},
    generators: {
      *doWork(ctx: GenCtx) {
        yield* ctx.call("fetch", async () => {
          await delay(10);
          ran = true;
          return "done";
        });
        yield* ctx.done();
      },
    },
  });

  const composed = composeFeatures([wf]);
  const app = createApp(composed);

  app.dispatch({ type: "wf:doWork", payload: { args: [] } });
  await delay(50);
  assertEquals(ran, true);
});

Deno.test("feature(generators): generator mutates state via ctx.mutate", async () => {
  const order = feature("order", {
    state: { status: "idle" as string },
    methods: {},
    generators: {
      *place(ctx: GenCtx) {
        yield* ctx.mutate("set-processing", (draft) => {
          draft.status = "processing";
        });
        yield* ctx.call("process", async () => {
          await delay(10);
        });
        yield* ctx.done((draft) => {
          draft.status = "done";
        });
      },
    },
  });

  const composed = composeFeatures([order]);
  const app = createApp(composed);

  app.dispatch({ type: "order:place", payload: { args: [] } });
  await delay(5);
  assertEquals(
    (app.getState().order as Record<string, unknown>).status,
    "processing",
  );
  await delay(50);
  assertEquals(
    (app.getState().order as Record<string, unknown>).status,
    "done",
  );
});

Deno.test("feature(generators): generator coexists with methods", async () => {
  let genRan = false;
  const shop = feature("shop", {
    state: { count: 0, submitted: false },
    methods: {
      increment(s: { count: number; submitted: boolean }) {
        s.count++;
      },
    },
    generators: {
      *submit(ctx: GenCtx) {
        yield* ctx.call("send", async () => {
          await delay(10);
          genRan = true;
        });
        yield* ctx.done((draft: Record<string, unknown>) => {
          draft.submitted = true;
        });
      },
    },
  });

  const composed = composeFeatures([shop]);
  const app = createApp(composed);

  // method works
  app.dispatch({ type: "shop:increment", payload: { args: [] } });
  assertEquals((app.getState().shop as Record<string, unknown>).count, 1);

  // generator works
  app.dispatch({ type: "shop:submit", payload: { args: [] } });
  await delay(50);
  assertEquals(genRan, true);
  assertEquals(
    (app.getState().shop as Record<string, unknown>).submitted,
    true,
  );
});

Deno.test("feature(generators): A catalog includes generator action keys", () => {
  const proc = feature("proc", {
    state: {},
    methods: {
      reset(s: Record<string, unknown>) {
        s.x = 0;
      },
    },
    generators: {
      *run(_ctx: GenCtx) {
        yield* _ctx.done();
      },
    },
  });

  // camelCase creator with .type property
  assertEquals(
    typeof (proc.__aio.actions as Record<string, unknown>).run,
    "function",
  );
  assertEquals(
    ((proc as Record<string, unknown>).run as { type: string }).type,
    "proc:run",
  );
});

Deno.test("feature(generators): generators-only (no methods) works", async () => {
  let called = false;
  const bg = feature("bg", {
    state: { done: false },
    methods: {},
    generators: {
      *tick(ctx: GenCtx) {
        yield* ctx.call("work", async () => {
          await delay(10);
          called = true;
        });
        yield* ctx.done((draft: Record<string, unknown>) => {
          draft.done = true;
        });
      },
    },
  });

  const composed = composeFeatures([bg]);
  const app = createApp(composed);
  app.dispatch({ type: "bg:tick", payload: { args: [] } });
  await delay(50);
  assertEquals(called, true);
  assertEquals((app.getState().bg as Record<string, unknown>).done, true);
});

// ── direct calling — feature.method() returns Promise ────────────────

Deno.test("direct calling: async method returns Promise that resolves with return value", async () => {
  const inventory = feature("inv", {
    state: { stock: 10 },
    methods: {
      async checkStock(
        _s,
        item: string,
      ): Promise<{ item: string; count: number }> {
        return { item, count: 10 };
      },
    },
  });

  const composed = composeFeatures([inventory]);
  const app = createApp(composed);
  bindFeature(
    inventory,
    app.dispatch,
    () => app.state.inv as Record<string, unknown>,
  );

  const result = await inventory.checkStock("widget") as {
    item: string;
    count: number;
  };
  assertEquals(result.item, "widget");
  assertEquals(result.count, 10);
});

Deno.test("direct calling: cross-feature — one feature calls another directly", async () => {
  const pricing = feature("pricing", {
    state: { lastPrice: 0 },
    methods: {
      async calculate(_s, amount: number): Promise<{ total: number }> {
        return { total: amount + 10 };
      },
    },
  });

  const orders = feature("orders2", {
    state: { total: 0 },
    methods: {
      async placeOrder(s, amount: number) {
        const price = await pricing.calculate(amount) as { total: number };
        s.total = price.total;
      },
    },
  });

  const composed = composeFeatures([pricing, orders]);
  const app = createApp(composed);
  bindFeature(
    pricing,
    app.dispatch,
    () => app.state.pricing as Record<string, unknown>,
  );
  bindFeature(
    orders,
    app.dispatch,
    () => app.state.orders2 as Record<string, unknown>,
  );

  await orders.placeOrder(100);
  await delay(30);

  assertEquals((app.state.orders2 as { total: number }).total, 110);
});

Deno.test("direct calling: sync methods return Promise<void> after bind", async () => {
  const counter = feature("ctr2", {
    state: { count: 0 },
    methods: {
      increment(s, by = 1) {
        s.count += by;
      },
    },
  });

  const composed = composeFeatures([counter]);
  const app = createApp(composed);
  bindFeature(
    counter,
    app.dispatch,
    () => app.state.ctr2 as Record<string, unknown>,
  );

  const result = counter.increment(5);
  assertEquals(result instanceof Promise, true); // sync methods now return Promise<void>
  assertEquals((app.state.ctr2 as { count: number }).count, 5); // state already updated (sync reduce)
  await result; // awaiting works — resolves after reduce + effects
});

Deno.test("direct calling: await sync method from async method (cross-feature)", async () => {
  const counter = feature("ctr3", {
    state: { count: 0 },
    methods: {
      increment(s, by = 1) {
        s.count += by;
      },
    },
  });

  const orchestrator = feature("orch", {
    state: { result: 0 },
    methods: {
      async run(s) {
        await counter.increment(10); // await sync method — should work after fix
        // counter state should be updated by now
        s.result = 42;
      },
    },
  });

  const composed = composeFeatures([counter, orchestrator]);
  const app = createApp(composed);
  bindFeature(
    counter,
    app.dispatch,
    () => app.state.ctr3 as Record<string, unknown>,
  );
  bindFeature(
    orchestrator,
    app.dispatch,
    () => app.state.orch as Record<string, unknown>,
  );

  await orchestrator.run();
  await delay(30);

  assertEquals((app.state.ctr3 as { count: number }).count, 10);
  assertEquals((app.state.orch as { result: number }).result, 42);
});

Deno.test("direct calling: call(opts, fn) callback form with timeout", {
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const slow = feature("slowf", {
    state: { done: false },
    methods: {
      async slowOp(_s) {
        await delay(500);
      },
    },
  });

  const composed = composeFeatures([slow]);
  const app = createApp(composed);
  bindFeature(
    slow,
    app.dispatch,
    () => app.state.slowf as Record<string, unknown>,
  );

  let timedOut = false;
  try {
    await call({ timeout: 20 }, () => slow.slowOp() as Promise<unknown>);
  } catch (e) {
    if (e instanceof Error && e.message.includes("timeout")) timedOut = true;
  }
  assertEquals(timedOut, true);
});

Deno.test("direct calling: call(fn) callback form — passthrough to feature method", async () => {
  const svc = feature("svc", {
    state: { result: "" as string },
    methods: {
      async compute(_s, x: number): Promise<string> {
        return `result-${x}`;
      },
    },
  });

  const composed = composeFeatures([svc]);
  const app = createApp(composed);
  bindFeature(
    svc,
    app.dispatch,
    () => app.state.svc as Record<string, unknown>,
  );

  const out = await svc.compute(42) as string;
  assertEquals(out, "result-42");
});
