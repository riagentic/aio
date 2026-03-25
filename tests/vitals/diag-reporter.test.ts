import { assertEquals, assertExists } from "@std/assert";
import { createServerDiagReporter } from "../../src/vitals/diag-reporter.ts";
import type { DiagEvent } from "../../src/vitals/types.ts";
import type { VitalAlert } from "../../src/vitals/types.ts";

function makeAlert(overrides: Partial<VitalAlert> = {}): VitalAlert {
  return {
    id: "test-1",
    layer: "loop",
    status: "warning",
    duration: 500,
    measured: 340,
    threshold: 50,
    hint: null,
    ts: Date.now(),
    ...overrides,
  };
}

Deno.test("server-reporter: slow dispatch from loop alert", () => {
  const events: DiagEvent[] = [];
  const reporter = createServerDiagReporter({
    onDiagnostic: (e: DiagEvent) => events.push(e),
    getLoopSnapshot: () => ({
      status: "warning",
      queueDepth: 8,
      drainRate: 1.4,
      lastReduceTime: 340,
      lastReduceAction: "orders/execute",
      lastReduceFeature: "orders",
      p95ReduceTime: 28,
      effectBacklog: 3,
      circuitBreakers: [],
      firstDegradedAt: null,
    }),
    getTransportSnapshot: () => ({ clients: [] }),
  });
  reporter.onAlert(
    makeAlert({ layer: "loop", status: "warning", measured: 340 }),
  );
  assertEquals(events.length, 1);
  assertEquals(events[0]!.kind, "slow");
  assertExists(events[0]!.detail.reduceMs);
});

Deno.test("server-reporter: disconnect from transport frozen", () => {
  const events: DiagEvent[] = [];
  const reporter = createServerDiagReporter({
    onDiagnostic: (e: DiagEvent) => events.push(e),
    getLoopSnapshot: () => ({
      status: "healthy",
      queueDepth: 0,
      drainRate: 50,
      lastReduceTime: 5,
      lastReduceAction: "",
      lastReduceFeature: "",
      p95ReduceTime: 8,
      effectBacklog: 0,
      circuitBreakers: [],
      firstDegradedAt: null,
    }),
    getTransportSnapshot: () => ({
      clients: [{ id: "c1", status: "frozen" as const, frozenFor: 5000 }],
    }),
  });
  reporter.onAlert(
    makeAlert({ layer: "transport", status: "frozen", measured: 5000 }),
  );
  assertEquals(events.length, 1);
  assertEquals(events[0]!.kind, "disconnect");
});

Deno.test("server-reporter: recovery deduplication", () => {
  const events: DiagEvent[] = [];
  const reporter = createServerDiagReporter({
    onDiagnostic: (e: DiagEvent) => events.push(e),
    getLoopSnapshot: () => ({
      status: "healthy",
      queueDepth: 0,
      drainRate: 50,
      lastReduceTime: 5,
      lastReduceAction: "",
      lastReduceFeature: "",
      p95ReduceTime: 8,
      effectBacklog: 0,
      circuitBreakers: [],
      firstDegradedAt: null,
    }),
    getTransportSnapshot: () => ({ clients: [] }),
  });
  // First: trigger slow
  reporter.onAlert(
    makeAlert({ layer: "loop", status: "warning", measured: 340 }),
  );
  // Then: recover
  reporter.onAlert(
    makeAlert({ layer: "loop", status: "healthy", measured: 5 }),
  );
  const recoveries = events.filter((e) => e.kind === "recovered");
  assertEquals(recoveries.length, 1);
  // Recover again without degradation — no duplicate
  reporter.onAlert(
    makeAlert({ layer: "loop", status: "healthy", measured: 5 }),
  );
  assertEquals(events.filter((e) => e.kind === "recovered").length, 1);
});

Deno.test("server-reporter: console throttling suppresses rapid same-kind events", () => {
  let consoleCount = 0;
  const reporter = createServerDiagReporter({
    onConsole: () => {
      consoleCount++;
    },
    getLoopSnapshot: () => ({
      status: "warning",
      queueDepth: 8,
      drainRate: 1.4,
      lastReduceTime: 340,
      lastReduceAction: "orders/execute",
      lastReduceFeature: "orders",
      p95ReduceTime: 28,
      effectBacklog: 3,
      circuitBreakers: [],
      firstDegradedAt: null,
    }),
    getTransportSnapshot: () => ({ clients: [] }),
  });
  reporter.onAlert(
    makeAlert({ layer: "loop", status: "warning", measured: 340 }),
  );
  reporter.onAlert(
    makeAlert({ layer: "loop", status: "warning", measured: 340 }),
  );
  reporter.onAlert(
    makeAlert({ layer: "loop", status: "warning", measured: 340 }),
  );
  assertEquals(
    consoleCount,
    1,
    "should throttle repeated same-kind console output",
  );
});

Deno.test("server-reporter: stale from transport degraded", () => {
  const events: DiagEvent[] = [];
  const reporter = createServerDiagReporter({
    onDiagnostic: (e) => events.push(e),
    getLoopSnapshot: () => ({
      status: "healthy",
      queueDepth: 0,
      drainRate: 50,
      lastReduceTime: 5,
      lastReduceAction: "",
      lastReduceFeature: "",
      p95ReduceTime: 8,
      effectBacklog: 0,
      circuitBreakers: [],
      firstDegradedAt: null,
    }),
    getTransportSnapshot: () => ({
      clients: [{ id: "c1", status: "degraded" as const }],
    }),
  });
  reporter.onAlert(
    makeAlert({ layer: "transport", status: "degraded", measured: 500 }),
  );
  assertEquals(events.length, 1);
  assertEquals(events[0]!.kind, "stale");
});
