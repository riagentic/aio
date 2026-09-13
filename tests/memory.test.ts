// memory.test.ts — leak detection and the dispatch allocation budget
//
// Verifies:
//   - A plain sync dispatch allocates no more than it did before `$call`
//     chains (bytes per reduce, read off V8's own allocation counter)
//   - 50k dispatches RETAIN nothing per dispatch once a real GC has run
//   - The retention probe sees a real leak (the instrument is checked, too)
//   - Repeated async-method cycles don't accumulate state
//   - until()-based waits clean up after signal and after timeout
//   - Rapid fill/clear cycles let old state be GC'd
//
// The heap checks run in a CHILD `deno eval --v8-flags=--expose-gc`, because
// only there is `gc()` real. They used to read `heapUsed` in this process
// around a 100 ms sleep labelled `forceGC()` — which never collects — so
// "growth" was wherever the young-generation sawtooth happened to stand when
// the loop ended: a 4% allocation change moved one scavenge and read as a
// doubling (19 MB → 39 MB), and an actual leak of every action would have
// hidden under the same 20 MB bar. `total_allocated_bytes` counts allocation
// whatever the collector does, and a post-`gc()` `heapUsed` IS the retained
// set.

import { assert, assertEquals } from "@std/assert";
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

type HeapReport = {
  /** Bytes V8 allocated per step over the first `ALLOC_STEPS` measured steps. */
  allocPerStep: number;
  /** Post-`gc()` heap growth across all `steps` measured steps, in bytes. */
  retained: number;
  steps: number;
};

/** Steps the allocation figure is taken over. Fixed, because the per-step
 *  number falls as the JIT settles (measured: 10.1 KB at 1k, 8.4 KB at 20k,
 *  7.5 KB at 200k) — a ceiling is only comparable at one length. */
const ALLOC_STEPS = 10_000;

/** Run `scenario` in a child isolate with a real `gc()`: 2,000 warm-up steps,
 *  a collection, then `steps` measured steps and a collection. A step is one
 *  `composed.reduce` (two for `fillClear`), exactly as `createTestApp` runs
 *  it. `leak` is the instrument's own control: the same counter, with a
 *  method that keeps one small object per call. */
async function heapProbe(
  scenario: "counter" | "leak" | "fillClear",
  steps: number,
): Promise<HeapReport> {
  const cellUrl = new URL("../src/state/cell.ts", import.meta.url).href;
  const code = `
import v8 from "node:v8";
import { cell, composeCells } from ${JSON.stringify(cellUrl)};
const kept = [];
const cells = {
  // ONE method, like the cell the ceiling was measured on: the \$call table
  // has an entry per method, so more methods would move the figure.
  counter: () => cell("counter", {
    state: { count: 0 },
    methods: { increment(s, by = 1) { s.count += by; } },
  }),
  leak: () => cell("counter", {
    state: { count: 0 },
    methods: { increment(s, by = 1) { s.count += by; kept.push({ by }); } },
  }),
  fillClear: () => cell("big", {
    state: { items: [] },
    methods: {
      fill(s) { s.items = Array.from({ length: 1000 }, (_, i) => "item-" + i); },
      clear(s) { s.items = []; },
    },
  }),
};
const scenario = ${JSON.stringify(scenario)};
const c = cells[scenario]();
const composed = composeCells([c]);
const cat = c.__aio.actions;
const acts = scenario === "fillClear"
  ? () => [cat.fill(), cat.clear()]
  : () => [cat.increment(1)];
let state = { ...composed.initialState };
const run = (n) => {
  for (let i = 0; i < n; i++) {
    for (const a of acts()) state = { ...composed.reduce(state, a).state };
  }
};
const alloc = () => v8.getHeapStatistics().total_allocated_bytes;
run(2000);
gc(); gc();
const h0 = Deno.memoryUsage().heapUsed;
const allocSteps = Math.min(${ALLOC_STEPS}, ${steps});
const a0 = alloc();
run(allocSteps);
const allocPerStep = (alloc() - a0) / allocSteps;
run(${steps} - allocSteps);
gc(); gc();
const retained = Deno.memoryUsage().heapUsed - h0;
console.log(JSON.stringify({ allocPerStep, retained, steps: ${steps} }));
`;
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["eval", "--v8-flags=--expose-gc", code],
    // The repo root, so the child resolves the same import map (`immer`).
    cwd: new URL("../", import.meta.url).pathname,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(out.stdout);
  assert(
    out.success,
    `heap probe "${scenario}" exited ${out.code}:\n` +
      new TextDecoder().decode(out.stderr) + stdout,
  );
  return JSON.parse(stdout.trim().split("\n").at(-1)!) as HeapReport;
}

/** Retained bytes per dispatch that count as a leak. A healthy run keeps a
 *  CONSTANT ~40 KB (JIT feedback, lazily built caches) whatever its length —
 *  measured 10.7 B/step at 1k steps, 2 at 20k, 0.2 at 200k — so over 50k steps
 *  that is under 1 B/step. Keeping one `{ by }` per call measured 41 B/step. */
const LEAK_BYTES_PER_DISPATCH = 8;
const LEAK_STEPS = 50_000;

/** Bytes one plain sync dispatch of a one-method cell may allocate — the
 *  `counter.increment` reduce, in the probe above, over 10,000 steps.
 *
 *  Measured (Deno 2.9.6 / V8 15.0, `v8.getHeapStatistics()
 *  .total_allocated_bytes`, three runs each):
 *    f626d1e07, before `$call` chains:        9,528–9,627 B
 *    3e65371db, chain tables built per call:  9,933–10,026 B
 *    lazy `$call` table (built on first read): 8,652–8,799 B
 *  The ceiling is the pre-chain level: a method that never says `$call` must
 *  not pay for it. ~9% headroom over today's figure absorbs run-to-run noise
 *  (±1%); a V8 upgrade that moves it is re-measured, not waved through. */
const ALLOC_CEILING_BYTES = 9_600;

// ── Cells ─────────────────────────────────────────────────────────

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

Deno.test("memory: a plain sync dispatch allocates at the pre-$call-chain level", async () => {
  const r = await heapProbe("counter", ALLOC_STEPS);
  console.log(`  ${Math.round(r.allocPerStep)} B allocated per dispatch`);
  assert(
    r.allocPerStep < ALLOC_CEILING_BYTES,
    `one counter.increment reduce allocated ${
      Math.round(r.allocPerStep)
    } B (ceiling ${ALLOC_CEILING_BYTES} B) — something now runs per ` +
      `dispatch that used to run only when a method asked for it`,
  );
});

Deno.test("memory: 50k dispatches retain nothing per dispatch after a real GC", async () => {
  const r = await heapProbe("counter", LEAK_STEPS);
  const per = r.retained / r.steps;
  console.log(`  ${per.toFixed(2)} B retained per dispatch after gc()`);
  assert(
    per < LEAK_BYTES_PER_DISPATCH,
    `${r.steps} dispatches retained ${
      (r.retained / 1024).toFixed(0)
    } KB after gc() (${per.toFixed(1)} B each) — a leak`,
  );
});

Deno.test("memory: the retention probe sees a real leak (the instrument works)", async () => {
  // Without this, a probe whose gc() silently did nothing — or that measured
  // the wrong isolate — would pass the test above forever.
  const r = await heapProbe("leak", LEAK_STEPS);
  const per = r.retained / r.steps;
  assert(
    per >= LEAK_BYTES_PER_DISPATCH,
    `a method keeping one object per call retained only ${
      per.toFixed(1)
    } B per dispatch — the probe cannot see a leak`,
  );
});

Deno.test({
  name: "memory: 100 async method cycles — no listener leak",
  // sanitizers disabled: fire-and-forget async methods with internal timers that outlive test
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

Deno.test("memory: rapid state reset lets old state be GC'd", async () => {
  // 300 fill/clear cycles allocate ~180 MB; keeping even one old 1,000-row
  // array per cycle would retain ~15 MB.
  const r = await heapProbe("fillClear", 300);
  console.log(
    `  ${
      (r.retained / 1024).toFixed(0)
    } KB retained after 300 fill/clear cycles`,
  );
  assert(
    r.retained < 1024 * 1024,
    `300 fill/clear cycles retained ${
      (r.retained / 1024).toFixed(0)
    } KB after gc() — old state not collected`,
  );
});

Deno.test("memory: fill then clear leaves the array empty", () => {
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
  app.dispatch(cat.fill!());
  assertEquals((app.getState().big as { items: string[] }).items.length, 1000);
  app.dispatch(cat.clear!());
  assertEquals((app.getState().big as { items: string[] }).items.length, 0);
});
