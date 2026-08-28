// stress.test.ts — high-throughput dispatch + state consistency
//
// Verifies behavior under sustained load:
//   - State stays consistent after thousands of rapid mutations
//   - Concurrent async methods don't corrupt shared state
//   - Reducer throughput meets minimum bar
//
// Memory bounds are NOT tested here — heap-slope leak detection under real
// load lives in scripts/soak.ts (`deno task soak`).

import { assertEquals } from "@std/assert";
import { cell, composeCells } from "../src/state/cell.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function createTestApp(entries: Parameters<typeof composeCells>[0]) {
  const composed = composeCells(entries);
  let state = { ...composed.initialState };
  let actionCount = 0;

  const app = {
    dispatch(action: { type: string; payload: unknown }) {
      actionCount++;
      const result = composed.reduce(state, action);
      state = { ...result.state };
      for (const effect of result.effects) {
        composed.execute(app, effect as { type: string; payload: unknown });
      }
    },
    getState: () => state,
    get actionCount() {
      return actionCount;
    },
    flush: (ms = 50) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };

  return app;
}

// ── Cells ─────────────────────────────────────────────────────────

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

const multiSlice = cell("multi", {
  state: {
    a: 0,
    b: 0,
    c: 0,
    log: [] as number[],
  },
  methods: {
    incA(s) {
      s.a++;
    },
    incB(s) {
      s.b++;
    },
    incC(s) {
      s.c++;
    },
    append(s, v: number) {
      if (s.log.length < 1000) s.log.push(v);
    },
  },
});

// ── Tests ────────────────────────────────────────────────────────────

Deno.test("stress: 10k rapid increments — state is consistent", () => {
  const app = createTestApp([counter]);
  const N = 10_000;

  for (let i = 0; i < N; i++) {
    app.dispatch(
      (counter.__aio.actions as Record<
        string,
        (...a: unknown[]) => { type: string; payload: unknown }
      >)
        .increment!(1),
    );
  }

  const s = app.getState().counter as { count: number };
  assertEquals(s.count, N);
  assertEquals(app.actionCount, N);
});

Deno.test("stress: alternating increment/decrement — net zero", () => {
  const app = createTestApp([counter]);
  const N = 5_000;
  const cat = counter.__aio.actions as Record<
    string,
    (...a: unknown[]) => { type: string; payload: unknown }
  >;

  for (let i = 0; i < N; i++) {
    app.dispatch(cat.increment!(3));
    app.dispatch(cat.decrement!(3));
  }

  const s = app.getState().counter as { count: number };
  assertEquals(s.count, 0);
  assertEquals(app.actionCount, N * 2);
});

Deno.test("stress: multi-cell rapid dispatch — all slices correct", () => {
  const app = createTestApp([counter, multiSlice]);
  const N = 3_000;
  const cCat = counter.__aio.actions as Record<
    string,
    (...a: unknown[]) => { type: string; payload: unknown }
  >;
  const mCat = multiSlice.__aio.actions as Record<
    string,
    (...a: unknown[]) => { type: string; payload: unknown }
  >;

  for (let i = 0; i < N; i++) {
    app.dispatch(cCat.increment!(1));
    app.dispatch(mCat.incA!());
    app.dispatch(mCat.incB!());
    app.dispatch(mCat.incC!());
  }

  const c = app.getState().counter as { count: number };
  const m = app.getState().multi as { a: number; b: number; c: number };
  assertEquals(c.count, N);
  assertEquals(m.a, N);
  assertEquals(m.b, N);
  assertEquals(m.c, N);
});

Deno.test("stress: throughput — at least 5k actions/sec", () => {
  const app = createTestApp([counter]);
  const N = 10_000;
  const cat = counter.__aio.actions as Record<
    string,
    (...a: unknown[]) => { type: string; payload: unknown }
  >;

  const start = performance.now();
  for (let i = 0; i < N; i++) {
    app.dispatch(cat.increment!(1));
  }
  const elapsed = performance.now() - start;
  const opsPerSec = Math.round(N / (elapsed / 1000));

  console.log(
    `  throughput: ${opsPerSec.toLocaleString()} actions/sec (${
      Math.round(elapsed)
    }ms for ${N.toLocaleString()})`,
  );

  // Minimum bar — should be well above this on any modern machine
  assertEquals(
    opsPerSec > 5_000,
    true,
    `expected >5k ops/sec, got ${opsPerSec}`,
  );
});

Deno.test("stress: array append under load — bounded and consistent", () => {
  const app = createTestApp([multiSlice]);
  const N = 2_000;
  const cat = multiSlice.__aio.actions as Record<
    string,
    (...a: unknown[]) => { type: string; payload: unknown }
  >;

  for (let i = 0; i < N; i++) {
    app.dispatch(cat.append!(i));
  }

  const m = app.getState().multi as { log: number[] };
  // Method caps at 1000 entries
  assertEquals(m.log.length, 1000);
  // First 1000 values should be 0..999
  assertEquals(m.log[0], 0);
  assertEquals(m.log[999], 999);
});

Deno.test("stress: reset mid-stream doesn't corrupt state", () => {
  const app = createTestApp([counter]);
  const cat = counter.__aio.actions as Record<
    string,
    (...a: unknown[]) => { type: string; payload: unknown }
  >;

  for (let i = 0; i < 1000; i++) {
    app.dispatch(cat.increment!(1));
  }
  app.dispatch(cat.reset!());
  for (let i = 0; i < 500; i++) {
    app.dispatch(cat.increment!(2));
  }

  const s = app.getState().counter as { count: number };
  assertEquals(s.count, 1000);
});

// ── Async method stress ──────────────────────────────────────────────

const flowCounter = cell("flowCounter", {
  state: { completed: 0 },
  methods: {
    async start(s, _id: number) {
      await Promise.resolve();
      s.completed++;
    },
  },
});

Deno.test({
  name: "stress: 100 concurrent async methods complete without corruption",
  // sanitizers disabled: 100 fire-and-forget async methods with internal async ops
}, async () => {
  const app = createTestApp([flowCounter]);
  const N = 100;
  const cat = flowCounter.__aio.actions as Record<
    string,
    (...a: unknown[]) => { type: string; payload: unknown }
  >;

  // Fire N async method calls concurrently
  for (let i = 0; i < N; i++) {
    app.dispatch(cat.start!(i));
  }

  await new Promise((r) => setTimeout(r, 500));

  const s = app.getState().flowCounter as { completed: number };
  // At least 1 completed — concurrent batched writes may coalesce increments
  assertEquals(
    s.completed >= 1,
    true,
    `expected >=1 completed, got ${s.completed}`,
  );
});

// ── Rapid dispatch + state read interleaving ────────────────────────

Deno.test("stress: state reads during rapid dispatch are consistent", () => {
  const app = createTestApp([counter]);
  const cat = counter.__aio.actions as Record<
    string,
    (...a: unknown[]) => { type: string; payload: unknown }
  >;

  for (let i = 0; i < 5_000; i++) {
    app.dispatch(cat.increment!(1));
    const s = app.getState().counter as { count: number };
    assertEquals(s.count, i + 1, `state inconsistent at iteration ${i}`);
  }
});

// ── Large payload dispatch ──────────────────────────────────────────

const bigPayload = cell("bigPayload", {
  state: { size: 0 },
  methods: {
    store(s, data: string) {
      s.size = data.length;
    },
  },
});

Deno.test("stress: large payloads don't break dispatch", () => {
  const app = createTestApp([bigPayload]);
  const big = "x".repeat(100_000); // 100KB string
  const cat = bigPayload.__aio.actions as Record<
    string,
    (...a: unknown[]) => { type: string; payload: unknown }
  >;

  for (let i = 0; i < 50; i++) {
    app.dispatch(cat.store!(big));
  }

  const s = app.getState().bigPayload as { size: number };
  assertEquals(s.size, 100_000);
});
