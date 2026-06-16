// integration-reactive.test.ts — cell({ methods }) integration with compose pipeline
import { assertEquals } from "@std/assert";
import { cell, composeCells } from "../src/cell.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Full dispatch loop with init/destroy lifecycle */
function createApp(composed: ReturnType<typeof composeCells>) {
  let state = composed.initialState;
  const history: { type: string }[] = [];
  const app = {
    dispatch: (action: { type: string; payload: unknown }) => {
      history.push(action);
      const result = composed.reduce(state, action);
      state = result.state;
      for (const eff of result.effects) {
        composed.execute(app, eff as { type: string; payload: unknown });
      }
    },
    getState: () => state,
    get state() {
      return state;
    },
    get history() {
      return history;
    },
  };
  return app;
}

// ── Multi-cell reactive composition ──────────────────────────────

Deno.test("integration: two cell(methods) cells compose independently", () => {
  const counter = cell("counter", {
    state: { count: 0 },
    methods: {
      increment(s) {
        s.count++;
      },
      decrement(s) {
        s.count--;
      },
    },
  });

  const todo = cell("todo", {
    state: { items: [] as string[] },
    methods: {
      add(s, item: string) {
        s.items.push(item);
      },
    },
  });

  const composed = composeCells([counter, todo]);
  const app = createApp(composed);

  app.dispatch((counter.__aio.actions as unknown as Record<string, any>).increment());
  app.dispatch((counter.__aio.actions as unknown as Record<string, any>).increment());
  app.dispatch((todo.__aio.actions as unknown as Record<string, any>).add("buy milk"));
  app.dispatch((counter.__aio.actions as unknown as Record<string, any>).decrement());

  assertEquals((app.state.counter as any).count, 1);
  assertEquals((app.state.todo as any).items, ["buy milk"]);
});

// ── Reactive + event-driven cross-cell ───────────────────────────

Deno.test("integration: event-driven cell reacts to cell(methods) cell actions", () => {
  const cart = cell("cart", {
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

  const stats = cell("stats", {
    state: { addCount: 0, clearCount: 0 },
    actions: { noop: () => ({}) },
    machine: {
      initial: "active",
      states: {
        active: {
          noop: "active",
          "cart:addItem": "active",
          "cart:clear": "active",
        },
      },
    },
    reduce: {
      ["cart:addItem"](state) {
        state.addCount++;
      },
      ["cart:clear"](state) {
        state.clearCount++;
      },
    },
  });

  const composed = composeCells([cart, stats]);
  const app = createApp(composed);

  app.dispatch((cart.__aio.actions as unknown as Record<string, any>).addItem("a"));
  app.dispatch((cart.__aio.actions as unknown as Record<string, any>).addItem("b"));
  app.dispatch((cart.__aio.actions as unknown as Record<string, any>).clear());
  app.dispatch((cart.__aio.actions as unknown as Record<string, any>).addItem("c"));

  assertEquals((app.state.cart as any).items, ["c"]);
  assertEquals((app.state.stats as any).addCount, 3);
  assertEquals((app.state.stats as any).clearCount, 1);
});

// ── Async reactive + sync reactive interaction ──────────────────────

Deno.test("integration: async cell(methods) method with machine + sync methods", async () => {
  const workflow = cell("workflow", {
    state: { step: "none", data: null as string | null },
    machine: {
      initial: "idle",
      states: {
        idle: { start: "running" },
        running: { complete: "idle" },
      },
    },
    methods: {
      async start(s) {
        s.step = "fetching";
        const result = await Promise.resolve("fetched-data");
        s.data = result;
        s.step = "done";
      },
      complete(s) {
        s.step = "completed";
      },
    },
  });

  const composed = composeCells([workflow]);
  const app = createApp(composed);

  app.dispatch((workflow.__aio.actions as unknown as Record<string, any>).start() as any);
  await delay(50);

  assertEquals((app.state.workflow as any).data, "fetched-data");
  assertEquals((app.state.workflow as any).step, "done");
  assertEquals((app.state.workflow as any).__aio_status, "running");

  // Transition back to idle
  app.dispatch((workflow.__aio.actions as unknown as Record<string, any>).complete());
  assertEquals((app.state.workflow as any).__aio_status, "idle");
});

// ── Lifecycle hooks with multiple reactive cells ─────────────────

Deno.test("integration: init and destroy across multiple cell(methods) cells", () => {
  const log: string[] = [];

  const a = cell("alpha", {
    state: { ready: false },
    methods: {
      activate(s) {
        s.ready = true;
      },
    },
    onInit: () => {
      log.push("alpha:init");
    },
    onDestroy: () => {
      log.push("alpha:destroy");
    },
  });

  const b = cell("beta", {
    state: { ready: false },
    methods: {
      activate(s) {
        s.ready = true;
      },
    },
    onInit: () => {
      log.push("beta:init");
    },
    onDestroy: () => {
      log.push("beta:destroy");
    },
  });

  const composed = composeCells([a, b]);
  const app = createApp(composed);

  composed.initAll(app);
  assertEquals(log, ["alpha:init", "beta:init"]);

  composed.destroyAll(app);
  // Destroy runs in reverse order
  assertEquals(log, [
    "alpha:init",
    "beta:init",
    "beta:destroy",
    "alpha:destroy",
  ]);
});

// ── Selectors across composed cells ──────────────────────────────

Deno.test("integration: selectors work across composed cell(methods) cells", () => {
  const prices = cell("prices", {
    state: { items: [{ name: "A", price: 10 }, { name: "B", price: 20 }] },
    methods: {
      addItem(s, name: string, price: number) {
        s.items.push({ name, price });
      },
    },
    selectors: {
      total: (s) =>
        s.items.reduce((sum: number, i: { price: number }) => sum + i.price, 0),
      count: (s) => s.items.length,
    },
  });

  const composed = composeCells([prices]);
  let state = composed.initialState;

  // Verify selector behavior through state values
  type PriceState = { items: { name: string; price: number }[] };
  const sum = (s: Record<string, unknown>) =>
    (s.prices as PriceState).items.reduce((t, i) => t + i.price, 0);
  const cnt = (s: Record<string, unknown>) =>
    (s.prices as PriceState).items.length;

  assertEquals(sum(state), 30);
  assertEquals(cnt(state), 2);

  state = composed.reduce(state, (prices.__aio.actions as unknown as Record<string, any>).addItem("C", 15)).state;
  assertEquals(sum(state), 45);
  assertEquals(cnt(state), 3);
});

// ── Batching across await boundaries ────────────────────────────────

Deno.test("integration: batching produces correct action count across awaits", async () => {
  const store = cell("store", {
    state: { a: 0, b: 0, c: 0, d: 0 },
    methods: {
      async multiStep(s) {
        // Batch 1: two writes before await
        s.a = 1;
        s.b = 2;
        await delay(10);
        // Batch 2: two writes after await
        s.c = 3;
        s.d = 4;
      },
    },
  });

  const composed = composeCells([store]);
  const app = createApp(composed);

  app.dispatch((store.__aio.actions as unknown as Record<string, any>).multiStep() as any);
  await delay(50);

  assertEquals((app.state.store as any).a, 1);
  assertEquals((app.state.store as any).b, 2);
  assertEquals((app.state.store as any).c, 3);
  assertEquals((app.state.store as any).d, 4);

  // 1 trigger + 2 batched __set = 3 total actions
  const setActions = app.history.filter((a) => a.type.includes("__set"));
  assertEquals(setActions.length, 2);
});
