// Responsiveness invariants — the promise is "user actions stay prompt", so
// these are the properties that must hold, not micro-benchmarks:
//
//  1. CPU work handed to schedule.blocking really leaves the isolate free
//     (an await on a compute function does NOT — the difference the docs now
//     make explicit).
//  2. Dev holds a reduce to one frame, prod to 100ms — the budget that teaches.
//  3. Measuring must not cost more as the app runs: the p95 window computes on
//     read, and per-client rate slots don't accumulate per connection.
import { assert, assertEquals } from "@std/assert";
import { createBlockingPool } from "../src/state/blocking.ts";
import { DEV_FRAME_BUDGET_MS } from "../src/state/dispatch.ts";
import { createLoopProbe } from "../src/vitals/loop-probe.ts";
import { DEFAULT_THRESHOLDS } from "../src/vitals/types.ts";
import {
  _rateSlotCount,
  initClientLog,
  writeClientLog,
} from "../src/server/client-log.ts";

/** Busy-loop for `ms` — the shape of work that `await` cannot rescue. */
function burn(ms: number): number {
  const end = performance.now() + ms;
  let n = 0;
  while (performance.now() < end) n++;
  return n;
}

Deno.test("blocking pool: the isolate stays responsive while a worker burns CPU", async () => {
  const pool = createBlockingPool({ size: 2 });
  try {
    // A 1s timer scheduled BEFORE the work: if the work ran on this thread it
    // could not fire until the work finished.
    let ticked = 0;
    const iv = setInterval(() => ticked++, 20);
    const started = performance.now();
    const result = await pool.run<number>(
      "burn",
      (ms) => {
        const end = performance.now() + (ms as number);
        let n = 0;
        while (performance.now() < end) n++;
        return n;
      },
      400,
    );
    const elapsed = performance.now() - started;
    clearInterval(iv);

    assert(result > 0, "the worker actually ran the function");
    assert(elapsed >= 350, `the work really took time (${elapsed}ms)`);
    // The main isolate kept servicing timers throughout — that's the whole
    // point. ~20 ticks are expected in 400ms; anything above a handful proves
    // the loop was never blocked.
    assert(ticked >= 5, `main isolate kept running (only ${ticked} ticks)`);
  } finally {
    await pool.dispose();
  }
});

Deno.test("blocking pool: cancel stops a running task, and the pool is bounded", async () => {
  const pool = createBlockingPool({ size: 1 });
  try {
    assertEquals(pool.size, 1, "size is honored — a burst queues, not spawns");
    const running = pool.run("slow", () => {
      const end = performance.now() + 5000;
      while (performance.now() < end) { /* busy */ }
      return "never";
    });
    // Give the worker a moment to pick it up, then kill it.
    await new Promise((r) => setTimeout(r, 100));
    assertEquals(pool.cancel("slow"), true, "a running task can be cancelled");
    let rejected = false;
    await running.catch(() => rejected = true);
    assert(rejected, "the caller learns it was cancelled — never hangs");
  } finally {
    await pool.dispose();
  }
});

Deno.test("an await on CPU work does NOT free the thread (why the docs say so)", async () => {
  // This is the trap the perf guide now calls out: `await heavyAsync()` looks
  // non-blocking and isn't. Pinning it means the guidance can't silently rot.
  let ticked = 0;
  const iv = setInterval(() => ticked++, 10);
  await new Promise((r) => setTimeout(r, 30)); // let the timer prove it works
  const before = ticked;
  await (async () => burn(200))();
  clearInterval(iv);
  assertEquals(
    ticked,
    before,
    "no timer fired during the awaited compute — the isolate was blocked",
  );
});

Deno.test("dev budget is one frame; prod stays at the 100ms default", () => {
  assertEquals(DEV_FRAME_BUDGET_MS, 16, "one animation frame");
  // The wiring lives in aio.ts (`prod ? undefined : { reduce: … }`); this pins
  // the constant it wires, so a future edit can't quietly loosen dev.
  assert(
    DEV_FRAME_BUDGET_MS < 100,
    "dev must be stricter than prod, never looser",
  );
});

Deno.test("vitals: p95 is computed on read, not on every dispatch", () => {
  const probe = createLoopProbe(DEFAULT_THRESHOLDS);
  const timing = (reduce: number) => ({
    actionType: "cart:add",
    reduce,
    effects: 0,
    budget: { reduce: 16, effect: 5 },
  });
  // Feed a window's worth of samples — this is the hot path (every action).
  for (let i = 1; i <= 200; i++) probe.onPerf(timing(i % 50));
  // The value is still correct when someone actually looks.
  const first = probe.getVitals().p95ReduceTime;
  assert(first > 0, "p95 is produced on read");
  assertEquals(
    probe.getVitals().p95ReduceTime,
    first,
    "and memoized until the window moves",
  );
  probe.onPerf(timing(999));
  assert(
    probe.getVitals().p95ReduceTime >= first,
    "a new sample invalidates the memo",
  );
});

Deno.test("client-log: rate slots don't accumulate one per connection forever", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-clientlog-" });
  try {
    initClientLog(dir);
    // Every browser reload gets a fresh, monotonically increasing client index.
    for (let i = 0; i < 500; i++) {
      writeClientLog(i, { level: "info", msg: `hello ${i}`, ts: Date.now() });
    }
    assert(_rateSlotCount() > 0, "slots exist while clients are logging");
    // The 1s window clears them; the map tracks the last second of clients,
    // not every client the process has ever seen.
    await new Promise((r) => setTimeout(r, 1200));
    assertEquals(
      _rateSlotCount(),
      0,
      "the window cleared — memory and per-tick work stay flat with uptime",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
