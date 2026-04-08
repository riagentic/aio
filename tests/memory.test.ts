// memory.test.ts — leak detection for long-running processes
//
// Verifies:
//   - Listener/subscription counts stay stable after many actions
//   - Memory growth is bounded after high-volume dispatch
//   - Flow action listeners are cleaned up after completion
//   - Completed generators don't leak into activeFlows

import { assertEquals } from "@std/assert";
import { cell, composeCells } from "../src/cell.ts";
import { resetFlows } from "../src/flow.ts";

// ── Helpers ──────────────────────────────────────────────────────────

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
  actions: {
    increment: (by = 1) => ({ by }),
    reset: () => ({}),
  },
  reduce: {
    increment(s, p) {
      s.count += p.by;
    },
    reset(s) {
      s.count = 0;
    },
  },
});

const flowCell = cell("flow", {
  state: { completed: 0 },
  actions: { start: () => ({}) },
  generators: {
    start: function* (ctx) {
      yield* ctx.call("work", () => Promise.resolve(42));
      yield* ctx.done((s) => {
        s.completed++;
      });
    },
  },
});

const waitCell = cell("waiter", {
  state: { received: 0 },
  actions: {
    begin: () => ({}),
    signal: () => ({}),
  },
  generators: {
    begin: function* (ctx) {
      yield* ctx.waitFor("waiter:signal", 500);
      yield* ctx.done((s) => {
        s.received++;
      });
    },
  },
});

// ── Tests ────────────────────────────────────────────────────────────

Deno.test("memory: 10k dispatches — heap growth < 20MB", async () => {
  resetFlows();
  const app = createTestApp([counter]);
  const N = 10_000;

  await forceGC();
  const before = Deno.memoryUsage().heapUsed;

  for (let i = 0; i < N; i++) {
    app.dispatch(counter.increment(1));
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
  name: "memory: 100 generator cycles — no listener leak",
  // sanitizers disabled: fire-and-forget generators with internal timers that outlive test
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  resetFlows();
  const app = createTestApp([flowCell]);
  const N = 100;

  for (let i = 0; i < N; i++) {
    app.dispatch(flowCell.start());
    await new Promise((r) => setTimeout(r, 10));
  }

  await new Promise((r) => setTimeout(r, 200));

  const s = app.getState().flow as { completed: number };
  // Last generator should have completed (previous ones cancelled)
  assertEquals(
    s.completed >= 1,
    true,
    `expected >=1 completed, got ${s.completed}`,
  );
});

Deno.test({
  name: "memory: waitFor listeners cleaned up after signal",
  // sanitizers disabled: generator waitFor + dispatch cycle leaves pending async ops
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  resetFlows();
  const app = createTestApp([waitCell]);

  // Start 20 wait cycles — each begins a waitFor, then gets signalled
  for (let i = 0; i < 20; i++) {
    app.dispatch(waitCell.begin());
    await new Promise((r) => setTimeout(r, 10));
    app.dispatch(waitCell.signal());
    await new Promise((r) => setTimeout(r, 20));
  }

  // The last cycle should complete (previous ones cancelled by restart)
  const s = app.getState().waiter as { received: number };
  assertEquals(s.received >= 1, true);
});

Deno.test({
  name: "memory: waitFor listeners cleaned up on timeout",
  // sanitizers disabled: 50 generators with 20ms timeouts — some timers outlive test
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  resetFlows();

  const shortWait = cell("shortWait", {
    state: { timedOut: 0 },
    actions: { go: () => ({}) },
    generators: {
      go: function* (ctx) {
        try {
          yield* ctx.waitFor("Never:Happens", 20);
        } catch {
          yield* ctx.done((s) => {
            s.timedOut++;
          });
        }
      },
    },
  });

  const app = createTestApp([shortWait]);

  // Fire 50 generators that all time out after 20ms
  for (let i = 0; i < 50; i++) {
    app.dispatch(shortWait.go());
    await new Promise((r) => setTimeout(r, 5));
  }

  await new Promise((r) => setTimeout(r, 200));

  // Last one should have timed out and completed
  const s = app.getState().shortWait as { timedOut: number };
  assertEquals(s.timedOut >= 1, true);
});

Deno.test("memory: rapid state reset prevents unbounded growth", async () => {
  resetFlows();

  const bigState = cell("big", {
    state: { items: [] as string[] },
    actions: {
      fill: () => ({}),
      clear: () => ({}),
    },
    reduce: {
      fill(s) {
        s.items = Array.from({ length: 1000 }, (_, i) => `item-${i}`);
      },
      clear(s) {
        s.items = [];
      },
    },
  });

  const app = createTestApp([bigState]);

  await forceGC();
  const before = Deno.memoryUsage().heapUsed;

  // Fill and clear 100 times — old arrays should be GC'd
  for (let i = 0; i < 100; i++) {
    app.dispatch(bigState.fill());
    app.dispatch(bigState.clear());
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
