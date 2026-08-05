// tests/vitals/integration.test.ts
import { assertEquals, assertExists } from "@std/assert";
import { createVitalsSystem } from "../../src/vitals/mod.ts";
import {
  createTransportProbeClient,
  createTransportProbeServer,
} from "../../src/vitals/transport-probe.ts";
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
  // `ping.t1` is the CLIENT's clock and is echoed back in the pong for the
  // client to compute its own RTT. The server's liveness record never touches
  // it — see the one-clock invariant in transport-probe.ts.
  sys.serverTransport.onClientPing("test_client");

  const pong = {
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

Deno.test("integration: endpoint data with frozen client", () => {
  // Ageing a client means advancing the SERVER's clock — the probe stamps
  // liveness itself and takes no timestamp from a caller (the one-clock
  // invariant in transport-probe.ts). `createVitalsSystem` deliberately does
  // not expose that clock: it is a test seam, not public surface, so the
  // freeze path is driven through the probe it wires.
  let clock = 1_000_000;
  const probe = createTransportProbeServer({
    thresholds: DEFAULT_THRESHOLDS,
    now: () => clock,
  });
  // c1 pings and then goes silent for 5s; c2 pings just before the check.
  probe.onClientPing("c1");
  clock += 5000;
  probe.onClientPing("c2");
  probe.checkAllClients();

  const all = probe.getAllClients();
  assertEquals(all.length, 2);
  const frozen = all.find((c) => c.status === "frozen");
  assertExists(frozen);
  assertEquals(frozen!.clientId, "c1");
  assertEquals(all.find((c) => c.clientId === "c2")!.status, "healthy");
  probe.destroy();
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
