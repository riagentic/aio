import { assertEquals } from "@std/assert";
import { bindCell, cell, composeCells } from "../src/state/cell.ts";
import { schedule } from "../src/state/schedule.ts";
import { testCell } from "../src/testing/cell-test.ts";

// AIO-427: a sync method may RETURN a value that `await cell.method()` resolves
// with — the same ergonomics as an async method, without forcing `async` +
// `// deno-lint-ignore require-await`. Effects (schedule/own) are still routed,
// never mistaken for a value; a bare value is never mistaken for effects.

/** Minimal app harness: dispatch reduces synchronously and surfaces the
 *  transported return value (`result.ret`), like the real dispatch queue. */
function createApp(composed: ReturnType<typeof composeCells>) {
  let state = composed.initialState;
  return {
    get state() {
      return state;
    },
    dispatch(action: { type: string; payload: unknown }): Promise<unknown> {
      const result = composed.reduce(state, action) as {
        state: Record<string, unknown>;
        effects: unknown[];
        ret?: unknown;
      };
      state = result.state;
      for (const eff of result.effects) {
        composed.execute(
          { dispatch: () => Promise.resolve(), getState: () => state },
          eff as never,
        );
      }
      return Promise.resolve(result.ret);
    },
  };
}

// deno-lint-ignore no-explicit-any
function boot(f: any) {
  const composed = composeCells([f]);
  const app = createApp(composed);
  bindCell(
    f,
    (a) => app.dispatch(a as never),
    () => app.state as Record<string, unknown>,
  );
  return app;
}

Deno.test("427: sync method returning a primitive resolves with it", async () => {
  const ids = cell("ids", {
    state: { next: 1 },
    methods: {
      mint(s): number {
        const id = s.next;
        s.next += 1;
        return id;
      },
    },
  });
  boot(ids);
  const v = await (ids as unknown as { mint: () => Promise<number> }).mint();
  assertEquals(v, 1);
  const v2 = await (ids as unknown as { mint: () => Promise<number> }).mint();
  assertEquals(v2, 2, "state advanced between calls");
});

Deno.test("427: sync method returning a plain object resolves with it", async () => {
  const c = cell("obj", {
    state: { n: 0 },
    methods: {
      bump(s) {
        s.n += 1;
        return { ok: true, n: s.n };
      },
    },
  });
  boot(c);
  const v = await (c as unknown as { bump: () => Promise<unknown> }).bump();
  assertEquals(v, { ok: true, n: 1 });
});

Deno.test("427: returning a DATA array resolves with the array (not eaten as effects)", async () => {
  const c = cell("list", {
    state: { items: [] as number[] },
    methods: {
      seed(s) {
        s.items = [1, 2, 3];
        return s.items;
      },
    },
  });
  boot(c);
  const v = await (c as unknown as { seed: () => Promise<number[]> }).seed();
  assertEquals(v, [1, 2, 3]);
});

Deno.test("427: returning an EMPTY array is a value, not 'no effects'", async () => {
  const c = cell("empty", {
    state: { n: 0 },
    methods: {
      none(s) {
        s.n += 1;
        return [] as string[];
      },
    },
  });
  boot(c);
  const v = await (c as unknown as { none: () => Promise<string[]> }).none();
  assertEquals(v, []);
});

Deno.test("427: returning a slice of DRAFT state survives (no revoked proxy)", async () => {
  const c = cell("store", {
    state: { items: [] as { id: number; label: string }[] },
    methods: {
      add(s, label: string) {
        const item = { id: s.items.length + 1, label };
        s.items.push(item);
        // Returning the freshly-pushed DRAFT object — must be snapshotted so
        // reading it after the reducer's Immer recipe closes does not throw.
        return s.items[s.items.length - 1];
      },
    },
  });
  boot(c);
  const item = await (c as unknown as {
    add: (l: string) => Promise<{ id: number; label: string }>;
  }).add("hello");
  assertEquals(
    item,
    { id: 1, label: "hello" },
    "draft slice snapshotted intact",
  );
});

Deno.test("427: returning a ScheduleEffect still schedules — value is undefined", async () => {
  const c = cell("sched", {
    state: { n: 0 },
    methods: {
      tick(s) {
        s.n += 1;
        return schedule.after("tick", 50, { type: "sched:tick", payload: {} });
      },
    },
  });
  boot(c);
  const v = await (c as unknown as { tick: () => Promise<unknown> }).tick();
  assertEquals(v, undefined, "an effect return is not a transported value");
});

Deno.test("427: a void sync method resolves undefined", async () => {
  const c = cell("v", {
    state: { n: 0 },
    methods: {
      inc(s) {
        s.n += 1;
      },
    },
  });
  boot(c);
  const v = await (c as unknown as { inc: () => Promise<unknown> }).inc();
  assertEquals(v, undefined);
});

// ── testCell harness surfaces the same value (inews Bad #5) ────────────────

testCell(
  cell("cart", {
    state: { items: [] as string[] },
    methods: {
      addItem(s, name: string): number {
        s.items.push(name);
        return s.items.length;
      },
    },
  }),
  "427: testCell send resolves with a sync method's return value",
  async (t) => {
    const count = await t.send.addItem("apple");
    assertEquals(count, 1);
    const count2 = await t.send.addItem("pear");
    assertEquals(count2, 2);
    t.expect.state((s) => s.items.length === 2);
  },
);

// ── Compile-time: DirectCalling infers the resolved value type ─────────────
// A returned value flows to `await cell.method()`; a void/effect method → void.

Deno.test("427: inferred return types (compile-time)", () => {
  const c = cell("typed", {
    state: { n: 0, items: [] as string[] },
    methods: {
      mint(s): number {
        return ++s.n;
      },
      justMutate(s) {
        s.n += 1;
      },
      list(s): string[] {
        return s.items;
      },
    },
  });
  // Bind so calling doesn't hit the unbound guard.
  boot(c);
  const _num: Promise<number> = c.mint();
  const _void: Promise<void> = c.justMutate();
  const _arr: Promise<string[]> = c.list();
  void _num, _void, _arr;
});

testCell(
  cell("calc", {
    state: { last: 0 },
    methods: {
      // deno-lint-ignore require-await
      async triple(s, n: number) {
        s.last = n * 3;
        return s.last;
      },
    },
  }),
  "427: testCell send resolves with an async method's return value",
  async (t) => {
    const v = await t.send.triple(7);
    assertEquals(v, 21);
  },
);
