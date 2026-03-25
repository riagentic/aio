import { assertEquals } from "@std/assert";
import { createLoopProbe } from "../../src/vitals/loop-probe.ts";
import { DEFAULT_THRESHOLDS } from "../../src/vitals/types.ts";
import type { VitalThresholds } from "../../src/vitals/types.ts";
import type { PerfTiming } from "../../src/dispatch.ts";

function makeTiming(actionType: string, reduce = 5): PerfTiming {
  return {
    actionType,
    reduce,
    effects: 0,
    budget: { reduce: 100, effect: 5 },
  };
}

/** Thresholds with lower queue values for easier testing */
const TEST_THRESHOLDS: VitalThresholds = {
  render: { degraded: 50, warning: 200, frozen: 2000 },
  transport: { degraded: 100, warning: 500, frozen: 2000 },
  loop: { degraded: 100, warning: 500, frozen: 2000 },
  queue: { degraded: 50, warning: 200, frozen: 1000 },
};

// ─── Initial state ──────────────────────────────────────────────────────────

Deno.test("loop-probe: initial state is healthy with zeroes", () => {
  const probe = createLoopProbe(DEFAULT_THRESHOLDS);
  const vitals = probe.getVitals();

  assertEquals(probe.getStatus(), "healthy");
  assertEquals(vitals.queueDepth, 0);
  assertEquals(vitals.lastReduceTime, 0);
  assertEquals(vitals.lastReduceAction, "");
  assertEquals(vitals.lastReduceFeature, "");
  assertEquals(vitals.p95ReduceTime, 0);
  assertEquals(vitals.effectBacklog, 0);
  assertEquals(vitals.circuitBreakers, []);
  assertEquals(probe.getFirstDegradedAt(), null);
});

// ─── onPerf updates ─────────────────────────────────────────────────────────

Deno.test("loop-probe: onPerf updates reduce metrics", () => {
  const probe = createLoopProbe(DEFAULT_THRESHOLDS);

  probe.onPerf(makeTiming("orders/PLACE_ORDER", 42));
  const vitals = probe.getVitals();

  assertEquals(vitals.lastReduceTime, 42);
  assertEquals(vitals.lastReduceAction, "orders/PLACE_ORDER");
  assertEquals(vitals.lastReduceFeature, "orders");
});

Deno.test("loop-probe: onPerf extracts feature from colon pattern", () => {
  const probe = createLoopProbe(DEFAULT_THRESHOLDS);

  probe.onPerf(makeTiming("portfolio:REBALANCE", 10));
  const vitals = probe.getVitals();

  assertEquals(vitals.lastReduceFeature, "portfolio");
  assertEquals(vitals.lastReduceAction, "portfolio:REBALANCE");
});

// ─── P95 computation ────────────────────────────────────────────────────────

Deno.test("loop-probe: p95 computed from last 100 actions", () => {
  const probe = createLoopProbe(DEFAULT_THRESHOLDS);

  // Feed 90 fast actions (1ms) and 10 slow actions (500ms)
  // Sorted: 90 x 1, 10 x 500. p95 index = ceil(100*0.95)-1 = 94 → value 500
  for (let i = 0; i < 90; i++) {
    probe.onPerf(makeTiming("fast/ACTION", 1));
  }
  for (let i = 0; i < 10; i++) {
    probe.onPerf(makeTiming("slow/ACTION", 500));
  }

  const vitals = probe.getVitals();
  assertEquals(vitals.p95ReduceTime, 500);
});

Deno.test("loop-probe: p95 window slides — old values drop off", () => {
  const probe = createLoopProbe(DEFAULT_THRESHOLDS);

  // Feed 100 slow actions
  for (let i = 0; i < 100; i++) {
    probe.onPerf(makeTiming("slow/ACTION", 200));
  }
  assertEquals(probe.getVitals().p95ReduceTime, 200);

  // Feed 100 fast actions — old slow ones should drop off
  for (let i = 0; i < 100; i++) {
    probe.onPerf(makeTiming("fast/ACTION", 2));
  }
  assertEquals(probe.getVitals().p95ReduceTime, 2);
});

// ─── Queue depth and effect backlog ─────────────────────────────────────────

Deno.test("loop-probe: queue depth and effect backlog update", () => {
  const probe = createLoopProbe(DEFAULT_THRESHOLDS);

  probe.updateQueueDepth(25);
  probe.updateEffectBacklog(3);

  const vitals = probe.getVitals();
  assertEquals(vitals.queueDepth, 25);
  assertEquals(vitals.effectBacklog, 3);
});

// ─── Status degradation by queue depth ──────────────────────────────────────

Deno.test("loop-probe: status degraded at queue threshold", () => {
  const probe = createLoopProbe(TEST_THRESHOLDS);

  probe.updateQueueDepth(60);
  assertEquals(probe.getStatus(), "degraded");
});

Deno.test("loop-probe: status warning at queue threshold", () => {
  const probe = createLoopProbe(TEST_THRESHOLDS);

  probe.updateQueueDepth(250);
  assertEquals(probe.getStatus(), "warning");
});

Deno.test("loop-probe: status frozen at queue threshold", () => {
  const probe = createLoopProbe(TEST_THRESHOLDS);

  probe.updateQueueDepth(1100);
  assertEquals(probe.getStatus(), "frozen");
});

Deno.test("loop-probe: status degrades with slow reduce time", () => {
  const probe = createLoopProbe(TEST_THRESHOLDS);

  probe.onPerf(makeTiming("slow/ACTION", 150));
  assertEquals(probe.getStatus(), "degraded");

  probe.onPerf(makeTiming("slower/ACTION", 600));
  assertEquals(probe.getStatus(), "warning");

  probe.onPerf(makeTiming("frozen/ACTION", 2500));
  assertEquals(probe.getStatus(), "frozen");
});

// ─── Circuit breakers ───────────────────────────────────────────────────────

Deno.test("loop-probe: circuit breakers update", () => {
  const probe = createLoopProbe(DEFAULT_THRESHOLDS);

  probe.updateCircuitBreakers(["ws-reconnect", "order-submit"]);
  const vitals = probe.getVitals();

  assertEquals(vitals.circuitBreakers, ["ws-reconnect", "order-submit"]);
});

Deno.test("loop-probe: circuit breakers are defensively copied", () => {
  const probe = createLoopProbe(DEFAULT_THRESHOLDS);
  const input = ["cb-1"];
  probe.updateCircuitBreakers(input);

  const vitals = probe.getVitals();
  input.push("cb-2"); // mutate original
  assertEquals(vitals.circuitBreakers, ["cb-1"]); // should not be affected
});

// ─── Drain rate ─────────────────────────────────────────────────────────────

Deno.test("loop-probe: drain rate tracks actions per second", () => {
  const probe = createLoopProbe(DEFAULT_THRESHOLDS);

  // Feed some actions
  for (let i = 0; i < 10; i++) {
    probe.onPerf(makeTiming("test/ACTION", 1));
  }

  const vitals = probe.getVitals();
  // All actions happened nearly simultaneously, drain rate should be > 0
  assertEquals(vitals.drainRate > 0, true);
});

// ─── First degraded tracking ────────────────────────────────────────────────

Deno.test("loop-probe: firstDegradedAt set on first degradation", () => {
  const probe = createLoopProbe(TEST_THRESHOLDS);

  assertEquals(probe.getFirstDegradedAt(), null);

  probe.updateQueueDepth(60);
  const ts = probe.getFirstDegradedAt();
  assertEquals(ts !== null, true);
  assertEquals(typeof ts, "number");
});

Deno.test("loop-probe: firstDegradedAt not overwritten on subsequent degradations", () => {
  const probe = createLoopProbe(TEST_THRESHOLDS);

  probe.updateQueueDepth(60);
  const first = probe.getFirstDegradedAt();

  probe.updateQueueDepth(300);
  assertEquals(probe.getFirstDegradedAt(), first);
});

// ─── Reset ──────────────────────────────────────────────────────────────────

Deno.test("loop-probe: reset clears all state", () => {
  const probe = createLoopProbe(DEFAULT_THRESHOLDS);

  probe.onPerf(makeTiming("test/ACTION", 50));
  probe.updateQueueDepth(100);
  probe.updateEffectBacklog(5);
  probe.updateCircuitBreakers(["cb-1"]);

  probe.reset();

  const vitals = probe.getVitals();
  assertEquals(probe.getStatus(), "healthy");
  assertEquals(vitals.queueDepth, 0);
  assertEquals(vitals.lastReduceTime, 0);
  assertEquals(vitals.lastReduceAction, "");
  assertEquals(vitals.p95ReduceTime, 0);
  assertEquals(vitals.effectBacklog, 0);
  assertEquals(vitals.circuitBreakers, []);
  assertEquals(probe.getFirstDegradedAt(), null);
});
