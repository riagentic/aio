import { assertEquals } from "@std/assert";
import type {
  ClientLiveness,
  Gauge,
  LoopVitals,
  RenderBudget,
  RenderFreezeReport,
  VitalAlert,
  VitalHint,
  VitalsConfig,
  VitalStatus,
  VitalThresholds,
} from "../../src/vitals/types.ts";
import {
  DEFAULT_HEARTBEAT_INTERVAL,
  DEFAULT_THRESHOLDS,
} from "../../src/vitals/types.ts";

Deno.test("types: DEFAULT_THRESHOLDS has all layers", () => {
  assertEquals(typeof DEFAULT_THRESHOLDS.render.frozen, "number");
  assertEquals(typeof DEFAULT_THRESHOLDS.transport.frozen, "number");
  assertEquals(typeof DEFAULT_THRESHOLDS.loop.frozen, "number");
  assertEquals(typeof DEFAULT_THRESHOLDS.queue.frozen, "number");
});

Deno.test("types: DEFAULT_HEARTBEAT_INTERVAL is 1000ms", () => {
  assertEquals(DEFAULT_HEARTBEAT_INTERVAL, 1000);
});

Deno.test("types: default thresholds have degraded < warning < frozen", () => {
  for (const layer of ["render", "transport", "loop", "queue"] as const) {
    const t = DEFAULT_THRESHOLDS[layer];
    assertEquals(t.degraded < t.warning, true, `${layer}: degraded < warning`);
    assertEquals(t.warning < t.frozen, true, `${layer}: warning < frozen`);
  }
});

// Type-level checks — these just need to compile, not run assertions
Deno.test("types: VitalAlert shape compiles", () => {
  const _alert: VitalAlert = {
    id: "test",
    layer: "render",
    status: "frozen",
    duration: 3000,
    measured: 3000,
    threshold: 2000,
    hint: null,
    ts: Date.now(),
  };
  assertEquals(_alert.layer, "render");
});

Deno.test("types: VitalHint shape compiles", () => {
  const _hint: VitalHint = {
    cause: "test",
    evidence: ["a"],
    suggestion: "do x",
    severity: "likely",
  };
  assertEquals(_hint.severity, "likely");
});

Deno.test("types: VitalsConfig accepts partial thresholds", () => {
  const _cfg: VitalsConfig = {
    heartbeatInterval: 500,
    thresholds: { render: { degraded: 10, warning: 50, frozen: 500 } },
    hints: true,
  };
  assertEquals(_cfg.heartbeatInterval, 500);
});

Deno.test("types: LoopVitals shape compiles", () => {
  const _lv: LoopVitals = {
    queueDepth: 0,
    drainRate: 100,
    lastReduceTime: 2,
    lastReduceAction: "inc",
    lastReduceFeature: "counter",
    p95ReduceTime: 5,
    effectBacklog: 0,
    circuitBreakers: [],
  };
  assertEquals(_lv.queueDepth, 0);
});

Deno.test("types: ClientLiveness shape compiles", () => {
  const _cl: ClientLiveness = {
    clientId: "c1",
    lastPing: Date.now(),
    lastSent: Date.now(),
    status: "healthy",
  };
  assertEquals(_cl.status, "healthy");
});

Deno.test("types: RenderFreezeReport shape compiles", () => {
  const _rfr: RenderFreezeReport = {
    frozenFor: 3000,
    lastActionBefore: "click",
    lastFeature: "ui",
    unprocessedDeltas: 5,
  };
  assertEquals(_rfr.frozenFor, 3000);
});

Deno.test("types: VitalStatus union covers all values", () => {
  const statuses: VitalStatus[] = [
    "healthy",
    "degraded",
    "warning",
    "frozen",
    "recovered",
  ];
  assertEquals(statuses.length, 5);
});

Deno.test("types: Gauge shape compiles and percent is clamped", () => {
  const g: Gauge = {
    name: "render.staleness",
    current: 600,
    capacity: 300,
    percent: Math.min(100, (600 / 300) * 100),
  };
  assertEquals(g.percent, 100);
  assertEquals(g.name, "render.staleness");
});

Deno.test("types: Gauge percent is proportional within range", () => {
  const g: Gauge = {
    name: "render.frameTime",
    current: 8,
    capacity: 16,
    percent: Math.min(100, (8 / 16) * 100),
  };
  assertEquals(g.percent, 50);
});

Deno.test("types: RenderBudget is fully optional", () => {
  const empty: RenderBudget = {};
  assertEquals(empty.staleness, undefined);
  assertEquals(empty.pendingPatches, undefined);
});

Deno.test("types: RenderBudget accepts explicit values", () => {
  const budget: RenderBudget = { staleness: 500, pendingPatches: 20 };
  assertEquals(budget.staleness, 500);
  assertEquals(budget.pendingPatches, 20);
});
