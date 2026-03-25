import { assertEquals, assertExists } from "@std/assert";
import { createVitalsSystem } from "../../src/vitals/mod.ts";
import type { VitalAlert } from "../../src/vitals/types.ts";

Deno.test("vitals-mod: create with defaults", () => {
  const sys = createVitalsSystem({});
  assertExists(sys);
  assertExists(sys.loopProbe);
  assertExists(sys.serverTransport);
  assertEquals(typeof sys.destroy, "function");
  sys.destroy();
});

Deno.test("vitals-mod: onVitalAlert callback fires", () => {
  const alerts: VitalAlert[] = [];
  const sys = createVitalsSystem({
    onVitalAlert: (a) => alerts.push(a),
  });
  sys.loopProbe.updateQueueDepth(1500); // > frozen threshold (1000)
  sys.checkAndAlert();
  assertEquals(alerts.length >= 1, true);
  assertEquals(alerts[0]!.layer, "loop");
  sys.destroy();
});

Deno.test("vitals-mod: getEndpointData returns server + clients shape", () => {
  const sys = createVitalsSystem({});
  const data = sys.getEndpointData();
  assertExists(data.server);
  assertExists(data.server.loop);
  assertExists(data.clients);
  assertEquals(Array.isArray(data.clients), true);
  sys.destroy();
});

Deno.test("vitals-mod: custom thresholds merge with defaults", () => {
  const sys = createVitalsSystem({
    thresholds: { transport: { degraded: 30, warning: 100, frozen: 500 } },
  });
  assertExists(sys);
  sys.destroy();
});

Deno.test("vitals-mod: formatTimelineSummary produces one-liner", () => {
  const sys = createVitalsSystem({});
  sys.loopProbe.updateQueueDepth(1500);
  sys.loopProbe.onPerf({
    actionType: "orders/RECALC",
    reduce: 3100,
    effects: 0,
    budget: { reduce: 100, effect: 5 },
  });
  const summary = sys.formatTimelineSummary();
  assertEquals(typeof summary, "string");
  assertEquals(summary.includes("vitals") || summary.includes("loop"), true);
  sys.destroy();
});
