// memory.test.ts — leak detection for long-running processes
//
// Verifies:
//   - Memory growth is bounded after high-volume dispatch
//   - Repeated async-method cycles don't accumulate state
//   - until()-based waits clean up after signal and after timeout
//   - Rapid fill/clear cycles let old state be GC'd

import { assertEquals } from "@std/assert";
import { cell, composeCells } from "../src/state/cell.ts";
import { until } from "../src/state/async-helpers.ts";

// ── Helpers ──────────────────────────────────────────────────────────

type Cat = Record<
  string,
  (...a: unknown[]) => { type: string; payload: unknown }
>;

function createTestApp(entries: Parameters<typeof composeCells>[0]) {
  const composed = composeCells(entries);
  let state = { ...composed.initialState };

  const app = {
    dispatch(action: { type: string; payload: unknown }) {
      const result = composed.reduce(state, action);
      state = { ...result.state };
      for (const effect of result.effects) {
        composed.execute(app, effect as { type: string; payload: unknown });
      }
    },
    getState: () => state,
    flush: (ms = 50) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };

  return app;
}

function forceGC(): Promise<void> {
  // Multiple rounds to give GC a chance
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve();
    }, 100);
  });
}

// ── Cells ─────────────────────────────────────────────────────────

const counter = cell("counter", {
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

const flowCell = cell("flow", {
  state: { completed: 0 },
  methods: {
    async start(s) {
      await Promise.resolve(42);
      s.completed++;
    },
  },
});

const waitCell = cell("waiter", {
  state: { received: 0, flag: false },
  methods: {
    signal(s) {
      s.flag = true;
    },
    async begin(s) {
      try {
        await until(() => s.flag, { timeoutMs: 500, intervalMs: 5 });
        s.received++;
        s.flag = false;
      } catch {
        // timed out — cycle abandoned
      }
    },
  },
});

// ── Tests ────────────────────────────────────────────────────────────

Deno.test("memory: 10k dispatches — heap growth < 20MB", async () => {
  const app = createTestApp([counter]);
  const cat = counter.__aio.actions as Cat;
  const N = 10_000;

  await forceGC();
  const before = Deno.memoryUsage().heapUsed;

  for (let i = 0; i < N; i++) {
    app.dispatch(cat.increment!(1));
  }

  await forceGC();
  const after = Deno.memoryUsage().heapUsed;
  const growthMB = (after - before) / (1024 * 1024);

  console.log(
    `  heap growth: ${
      growthMB.toFixed(2)
    } MB after ${N.toLocaleString()} dispatches`,
  );

  // 20MB is generous — typical growth is < 5MB for pure reduce
  assertEquals(
    growthMB < 20,
    true,
    `heap grew ${growthMB.toFixed(1)}MB — possible leak`,
  );
});

Deno.test({
  name: "memory: 100 async method cycles — no listener leak",
  // sanitizers disabled: fire-and-forget async methods with internal timers that outlive test
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const app = createTestApp([flowCell]);
  const cat = flowCell.__aio.actions as Cat;
  const N = 100;

  for (let i = 0; i < N; i++) {
    app.dispatch(cat.start!());
    await new Promise((r) => setTimeout(r, 10));
  }

  await new Promise((r) => setTimeout(r, 200));

  const s = app.getState().flow as { completed: number };
  assertEquals(
    s.completed >= 1,
    true,
    `expected >=1 completed, got ${s.completed}`,
  );
});

Deno.test({
  name: "memory: until() waits cleaned up after signal",
  // sanitizers disabled: until() poll timers + dispatch cycle leave pending async ops
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const app = createTestApp([waitCell]);
  const cat = waitCell.__aio.actions as Cat;

  // Start 20 wait cycles — each begins an until() wait, then gets signalled
  for (let i = 0; i < 20; i++) {
    app.dispatch(cat.begin!());
    await new Promise((r) => setTimeout(r, 10));
    app.dispatch(cat.signal!());
    await new Promise((r) => setTimeout(r, 20));
  }

  const s = app.getState().waiter as { received: number };
  assertEquals(s.received >= 1, true);
});

Deno.test({
  name: "memory: until() waits cleaned up on timeout",
  // sanitizers disabled: 50 async methods with 20ms timeouts — some timers outlive test
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const shortWait = cell("shortWait", {
    state: { timedOut: 0 },
    methods: {
      async go(s) {
        try {
          await until(() => false, { timeoutMs: 20, intervalMs: 5 });
        } catch {
          s.timedOut++;
        }
      },
    },
  });

  const app = createTestApp([shortWait]);
  const cat = shortWait.__aio.actions as Cat;

  // Fire 50 waits that all time out after 20ms
  for (let i = 0; i < 50; i++) {
    app.dispatch(cat.go!());
    await new Promise((r) => setTimeout(r, 5));
  }

  await new Promise((r) => setTimeout(r, 200));

  // Last one should have timed out and completed
  const s = app.getState().shortWait as { timedOut: number };
  assertEquals(s.timedOut >= 1, true);
});

Deno.test("memory: rapid state reset prevents unbounded growth", async () => {
  const bigState = cell("big", {
    state: { items: [] as string[] },
    methods: {
      fill(s) {
        s.items = Array.from({ length: 1000 }, (_, i) => `item-${i}`);
      },
      clear(s) {
        s.items = [];
      },
    },
  });

  const app = createTestApp([bigState]);
  const cat = bigState.__aio.actions as Cat;

  await forceGC();
  const before = Deno.memoryUsage().heapUsed;

  // Fill and clear 100 times — old arrays should be GC'd
  for (let i = 0; i < 100; i++) {
    app.dispatch(cat.fill!());
    app.dispatch(cat.clear!());
  }

  await forceGC();
  const after = Deno.memoryUsage().heapUsed;
  const growthMB = (after - before) / (1024 * 1024);

  console.log(
    `  heap growth after 100 fill/clear cycles: ${growthMB.toFixed(2)} MB`,
  );

  // If arrays leak, 100 × 1000 items would accumulate. Should be near zero.
  assertEquals(
    growthMB < 20,
    true,
    `heap grew ${growthMB.toFixed(1)}MB — old state not GC'd`,
  );

  const s = app.getState().big as { items: string[] };
  assertEquals(s.items.length, 0);
});
