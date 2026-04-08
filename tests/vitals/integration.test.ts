// tests/vitals/integration.test.ts
import { assertEquals, assertExists } from "@std/assert";
import { createVitalsSystem } from "../../src/vitals/mod.ts";
import { createTransportProbeClient } from "../../src/vitals/transport-probe.ts";
import { createRenderProbe } from "../../src/vitals/render-probe.ts";
import { DEFAULT_THRESHOLDS } from "../../src/vitals/types.ts";
import type { DiagEvent, VitalAlert } from "../../src/vitals/types.ts";

Deno.test("integration: full freeze detection — loop overload triggers alert with hint", () => {
  const alerts: VitalAlert[] = [];
  const sys = createVitalsSystem({
    onVitalAlert: (a) => alerts.push(a),
    hints: true,
  });

  sys.loopProbe.updateQueueDepth(1500);
  sys.loopProbe.onPerf({
    actionType: "orders/RECALC_ALL",
    reduce: 3100,
    effects: 0,
    budget: { reduce: 100, effect: 5 },
  });
  sys.checkAndAlert();

  assertEquals(alerts.length >= 1, true, "should fire at least one alert");
  const first = alerts[0]!;
  assertEquals(first.layer, "loop");
  assertExists(first.hint);
  sys.destroy();
});

Deno.test("integration: transport probe client <-> server ping/pong flow", () => {
  const sys = createVitalsSystem({});
  const client = createTransportProbeClient({
    thresholds: DEFAULT_THRESHOLDS,
    interval: 1000,
  });

  const ping = client.createPing();
  sys.serverTransport.onClientPing("test_client", ping.t1);

  const pong = {
    type: "__vitals:pong" as const,
    t1: ping.t1,
    t2: Date.now(),
    loop: sys.getLoopVitalsForPong() as ReturnType<
      typeof sys.loopProbe.getVitals
    >,
  };

  client.processPong(pong);
  assertEquals(client.getStatus(), "healthy");
  assertEquals(client.getRTT() >= 0, true);
  assertExists(client.getLastLoop());

  sys.destroy();
  client.destroy();
});

Deno.test("integration: render probe detects freeze and provides report", () => {
  const probe = createRenderProbe({
    thresholds: DEFAULT_THRESHOLDS,
    interval: 100,
    manualTick: true,
  });

  probe.recordAction("orders/RECALC", "orders");
  probe.recordDelta();
  probe.recordDelta();

  const report = probe.tick(3000);
  assertExists(report);
  assertEquals(report!.frozenFor >= 2000, true);
  assertEquals(report!.lastActionBefore, "orders/RECALC");
  assertEquals(report!.lastCell, "orders");
  assertEquals(report!.unprocessedDeltas, 2);

  probe.tick(10);
  assertEquals(probe.getStatus(), "recovered");
  assertEquals(probe.getPreviousFreezeCount(), 1);
  probe.destroy();
});

Deno.test("integration: endpoint data with frozen client", () => {
  const sys = createVitalsSystem({});
  sys.serverTransport.onClientPing("c1", Date.now());
  sys.serverTransport.onClientPing("c2", Date.now() - 5000);
  sys.serverTransport.checkAllClients();

  const data = sys.getEndpointData();
  assertEquals(data.clients.length, 2);
  const frozen = data.clients.find((c) => c.status === "frozen");
  assertExists(frozen);
  sys.destroy();
});

Deno.test("integration: VitalsSystem fires onDiagnostic on loop degradation", () => {
  const events: DiagEvent[] = [];
  const sys = createVitalsSystem({
    onDiagnostic: (e) => events.push(e),
  });
  // Trigger slow dispatch
  sys.loopProbe.updateQueueDepth(1500); // above frozen threshold (1000)
  sys.checkAndAlert();
  assertEquals(events.length >= 1, true, "should fire at least one DiagEvent");
  assertEquals(events[0]!.kind, "slow");
  sys.destroy();
});
