import { assertEquals } from "@std/assert";
import { formatDiagEvent } from "../../src/vitals/diag-formatter.ts";
import type { DiagEvent } from "../../src/vitals/types.ts";

function makeEvent(overrides: Partial<DiagEvent> = {}): DiagEvent {
  return {
    kind: "slow",
    severity: "likely",
    summary: "SLOW DISPATCH — orders.execute took 340ms",
    detail: {},
    timestamp: Date.now(),
    ...overrides,
  };
}

Deno.test("formatter: structured block for likely severity with 2+ data points", () => {
  const event = makeEvent({
    kind: "slow",
    severity: "likely",
    summary: "SLOW DISPATCH — orders.execute took 340ms (budget: 50ms)",
    detail: {
      trigger: "orders.execute",
      reduceMs: 340,
      p95Ms: 28,
      queueDepth: 8,
      drainRate: 1.4,
      hint: "single slow reducer — profile orders.execute",
    },
  });
  const lines = formatDiagEvent(event);
  assertEquals(lines.length > 1, true, "should produce structured block");
  assertEquals(lines[0]!.includes("[aio:vitals]"), true);
  assertEquals(lines[0]!.includes("SLOW DISPATCH"), true);
  assertEquals(lines.some((l) => l.includes("trigger")), true);
  assertEquals(lines.some((l) => l.includes("hint")), true);
});

Deno.test("formatter: one-liner for speculative severity", () => {
  const event = makeEvent({
    kind: "recovered",
    severity: "speculative",
    summary: "transport recovered (was degraded for 1.2s, RTT back to 28ms)",
    detail: { rtt: 28 },
  });
  const lines = formatDiagEvent(event);
  assertEquals(lines.length, 1, "should produce one-liner");
  assertEquals(lines[0]!.includes("[aio:vitals]"), true);
  assertEquals(lines[0]!.includes("recovered"), true);
});

Deno.test("formatter: freeze event includes all correlated data", () => {
  const event = makeEvent({
    kind: "freeze",
    severity: "likely",
    summary: "RENDER FROZEN — no update for 3.2s",
    detail: {
      trigger: "portfolio.refresh",
      reduceMs: 1847,
      p95Ms: 45,
      queueDepth: 12,
      drainRate: 2.1,
      rtt: 23,
      frozenFor: 3200,
      hint: "slow reducer blocking main thread — consider async",
    },
  });
  const lines = formatDiagEvent(event);
  assertEquals(lines.length > 1, true);
  assertEquals(lines.some((l) => l.includes("trigger")), true);
  assertEquals(lines.some((l) => l.includes("queue")), true);
  assertEquals(lines.some((l) => l.includes("transport")), true);
  assertEquals(lines.some((l) => l.includes("hint")), true);
});

Deno.test("formatter: stale event shows transport + delta info", () => {
  const event = makeEvent({
    kind: "stale",
    severity: "possible",
    summary: "STALE STATE — 4 broadcasts skipped, client degraded",
    detail: {
      rtt: 890,
      skipCount: 4,
      p95Ms: 12,
      hint: "network latency spike — check connection",
    },
  });
  const lines = formatDiagEvent(event);
  assertEquals(lines.length > 1, true);
  assertEquals(lines.some((l) => l.includes("transport")), true);
});

Deno.test("formatter: one-liner when likely but only 1 data point", () => {
  const event = makeEvent({
    kind: "disconnect",
    severity: "likely",
    summary: "transport lost — client unreachable",
    detail: { frozenFor: 5000 },
  });
  const lines = formatDiagEvent(event);
  assertEquals(lines.length, 1, "only 1 data point = one-liner");
});
