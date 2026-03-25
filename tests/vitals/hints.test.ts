import { assertEquals, assertExists } from "@std/assert";
import {
  classifySeverity,
  detectCascadeOrigin,
  evaluateHints,
} from "../../src/vitals/hints.ts";
import type { VitalHint, VitalsSnapshot } from "../../src/vitals/types.ts";
import { DEFAULT_THRESHOLDS } from "../../src/vitals/types.ts";

function makeSnapshot(overrides: Partial<{
  render: Partial<VitalsSnapshot["render"]>;
  transport: Partial<VitalsSnapshot["transport"]>;
  loop: Partial<VitalsSnapshot["loop"]>;
}> = {}): VitalsSnapshot {
  return {
    render: {
      status: "healthy",
      measured: 16,
      lastActionBefore: null,
      firstDegradedAt: null,
      visible: true,
      previousFreezeCount: 0,
      ...overrides.render,
    },
    transport: {
      status: "healthy",
      measured: 10,
      firstDegradedAt: null,
      ...overrides.transport,
    },
    loop: {
      status: "healthy",
      firstDegradedAt: null,
      queueDepth: 0,
      drainRate: 50,
      lastReduceTime: 5,
      lastReduceAction: "",
      lastReduceFeature: "",
      p95ReduceTime: 8,
      effectBacklog: 0,
      circuitBreakers: [],
      ...overrides.loop,
    },
  };
}

// Rule 1: Slow Reduce Freeze
Deno.test("hints: rule 1 — slow reduce causes render freeze", () => {
  const snap = makeSnapshot({
    render: {
      status: "frozen",
      measured: 3200,
      lastActionBefore: "orders/RECALC",
      firstDegradedAt: 100,
    },
    loop: {
      status: "warning",
      lastReduceTime: 3100,
      lastReduceAction: "orders/RECALC",
      lastReduceFeature: "orders",
      firstDegradedAt: 50,
    },
  });
  const hints = evaluateHints(snap, DEFAULT_THRESHOLDS);
  assertExists(hints);
  assertEquals(hints!.severity, "likely");
  assertEquals(hints!.cause.includes("orders/RECALC"), true);
});

// Rule 2: Queue Saturation
Deno.test("hints: rule 2 — queue saturation", () => {
  const snap = makeSnapshot({
    loop: {
      status: "frozen",
      queueDepth: 1500,
      drainRate: 3,
      firstDegradedAt: 50,
      lastReduceAction: "market/TICK",
      lastReduceFeature: "market",
    },
    transport: { status: "degraded", firstDegradedAt: 200 },
  });
  const hints = evaluateHints(snap, DEFAULT_THRESHOLDS);
  assertExists(hints);
  assertEquals(hints!.cause.includes("queue"), true);
});

// Rule 3: Transport Stall
Deno.test("hints: rule 3 — transport stall, both sides healthy", () => {
  const snap = makeSnapshot({
    transport: { status: "frozen", measured: 5000, firstDegradedAt: 100 },
    render: { status: "healthy" },
    loop: { status: "healthy" },
  });
  const hints = evaluateHints(snap, DEFAULT_THRESHOLDS);
  assertExists(hints);
  assertEquals(
    hints!.cause.includes("connection") || hints!.cause.includes("Network"),
    true,
  );
});

// Rule 4: Client-Only Freeze
Deno.test("hints: rule 4 — client-only freeze, no recent action", () => {
  const snap = makeSnapshot({
    render: {
      status: "frozen",
      measured: 3000,
      lastActionBefore: null,
      firstDegradedAt: 100,
    },
    transport: { status: "healthy" },
    loop: { status: "healthy" },
  });
  const hints = evaluateHints(snap, DEFAULT_THRESHOLDS);
  assertExists(hints);
  assertEquals(hints!.severity, "possible");
  assertEquals(hints!.cause.includes("non-AIO"), true);
});

// Rule 5: Recovery Death Spiral
Deno.test("hints: rule 5 — recovery death spiral", () => {
  const snap = makeSnapshot({
    render: {
      status: "recovered",
      measured: 0,
      previousFreezeCount: 3,
      firstDegradedAt: null,
    },
  });
  const hints = evaluateHints(snap, DEFAULT_THRESHOLDS);
  assertExists(hints);
  assertEquals(
    hints!.cause.includes("freeze-recover cycle") ||
      hints!.cause.includes("Repeated"),
    true,
  );
});

// Rule 6: Visibility Filter
Deno.test("hints: rule 6 — hidden window returns null (discard)", () => {
  const snap = makeSnapshot({
    render: {
      status: "frozen",
      measured: 5000,
      visible: false,
      firstDegradedAt: 100,
    },
  });
  const hints = evaluateHints(snap, DEFAULT_THRESHOLDS);
  assertEquals(hints, null);
});

// Healthy: no hint
Deno.test("hints: all healthy returns null", () => {
  const snap = makeSnapshot();
  const hints = evaluateHints(snap, DEFAULT_THRESHOLDS);
  assertEquals(hints, null);
});

// Cascade Detection
Deno.test("hints: cascade origin is earliest degraded probe", () => {
  const timelines = [
    {
      probe: "render" as const,
      firstDegradedAt: 300,
      firstWarningAt: null,
      firstFrozenAt: null,
      recoveredAt: null,
    },
    {
      probe: "transport" as const,
      firstDegradedAt: 200,
      firstWarningAt: null,
      firstFrozenAt: null,
      recoveredAt: null,
    },
    {
      probe: "loop" as const,
      firstDegradedAt: 100,
      firstWarningAt: null,
      firstFrozenAt: null,
      recoveredAt: null,
    },
  ];
  assertEquals(detectCascadeOrigin(timelines), "loop");
});

// Severity Classification
Deno.test("hints: severity — 2 probes with measurement + correlation = likely", () => {
  assertEquals(classifySeverity(2, true, true), "likely");
});

Deno.test("hints: severity — 1 probe with measurement = possible", () => {
  assertEquals(classifySeverity(1, true, false), "possible");
});

Deno.test("hints: severity — inference only = speculative", () => {
  assertEquals(classifySeverity(0, false, false), "speculative");
});
