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

// A read-only subscriber is not a dead one.
//
// Liveness was graded from CONNECT time for every client, and `lastPing` was
// refreshed only by an inbound `vitals-ping`. `connectCli` never sent one, so
// every CLI client crossed the 2000 ms `frozen` threshold two seconds after
// connecting and stayed across it — the gap only grows — and
// `server-broadcast.ts` skips a frozen client. The result was that `watch()`
// and `cli.subscribe()`, the advertised feature of the CLI toolkit and of
// `examples/cli-tool`, silently stopped receiving state after two seconds,
// in dev AND in `--prod`, with the one console message that did appear
// ("Check network stability. Auto-reconnect will trigger.") being false on
// both halves. The dev live-reload socket had the same fate on every page
// load.
//
// The memory case that motivated grading-from-connect — a peer that upgrades
// and never drains its socket — is answered directly by the `bufferedAmount`
// high-water check that sits beside the frozen check in server-broadcast.ts.
Deno.test("vitals: a client that never pings is not graded as frozen", () => {
  let clock = 1_000_000;
  const probe = createTransportProbeServer({
    thresholds: DEFAULT_THRESHOLDS,
    now: () => clock,
  });
  probe.onClientConnected("watcher"); // speaks the wire, not the heartbeat
  clock += 60_000; // a minute of happily receiving state
  probe.checkAllClients();

  assertEquals(probe.isFrozen("watcher"), false);
  assertEquals(probe.getClientLiveness("watcher")?.status, "healthy");
  probe.destroy();
});

Deno.test("vitals: a client that DID ping and stopped is still frozen", () => {
  // The instrument check: the watchdog must not have been switched off.
  let clock = 1_000_000;
  const probe = createTransportProbeServer({
    thresholds: DEFAULT_THRESHOLDS,
    now: () => clock,
  });
  probe.onClientConnected("browser");
  probe.onClientPing("browser");
  clock += 60_000;
  probe.checkAllClients();

  assertEquals(probe.isFrozen("browser"), true);
  probe.destroy();
});

Deno.test("vitals: any frame keeps a heartbeat client alive", () => {
  // A client mid-conversation — dispatching actions, being acked — could be
  // graded frozen and have its state updates dropped, because only a
  // `vitals-ping` refreshed liveness. A client that speaks is alive.
  let clock = 1_000_000;
  const probe = createTransportProbeServer({
    thresholds: DEFAULT_THRESHOLDS,
    now: () => clock,
  });
  probe.onClientConnected("busy");
  probe.onClientPing("busy");
  for (let i = 0; i < 60; i++) {
    clock += 1000;
    probe.onClientActivity("busy"); // an action frame, not a heartbeat
    probe.checkAllClients();
    assertEquals(probe.isFrozen("busy"), false, `frozen at second ${i}`);
  }
  // …and it still freezes once it genuinely stops.
  clock += 60_000;
  probe.checkAllClients();
  assertEquals(probe.isFrozen("busy"), true);
  probe.destroy();
});

Deno.test("vitals: activity does not enrol a non-heartbeat client in grading", () => {
  // One frame at connect time says nothing about whether more will follow, so
  // speaking must not be what signs a client up to be judged by silence.
  let clock = 1_000_000;
  const probe = createTransportProbeServer({
    thresholds: DEFAULT_THRESHOLDS,
    now: () => clock,
  });
  probe.onClientConnected("cli");
  probe.onClientActivity("cli"); // its `proto` hello
  clock += 60_000;
  probe.checkAllClients();
  assertEquals(probe.isFrozen("cli"), false);
  probe.destroy();
});

Deno.test("vitals: removeClient forgets the heartbeat enrolment too", () => {
  // A reconnecting client reuses nothing, but a leaked enrolment would grade a
  // fresh id that never pinged.
  let clock = 1_000_000;
  const probe = createTransportProbeServer({
    thresholds: DEFAULT_THRESHOLDS,
    now: () => clock,
  });
  probe.onClientConnected("c");
  probe.onClientPing("c");
  probe.removeClient("c");
  probe.onClientConnected("c");
  clock += 60_000;
  probe.checkAllClients();
  assertEquals(probe.isFrozen("c"), false);
  probe.destroy();
});
