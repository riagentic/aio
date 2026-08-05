import { assertEquals } from "@std/assert";
import {
  createTransportProbeClient,
  createTransportProbeServer,
} from "../../src/vitals/transport-probe.ts";
import { DEFAULT_THRESHOLDS } from "../../src/vitals/types.ts";

// ─── Client-side ─────────────────────────────────────────────────────────────

Deno.test("client: initial status is healthy", () => {
  const probe = createTransportProbeClient({
    thresholds: DEFAULT_THRESHOLDS,
    interval: 1000,
  });
  assertEquals(probe.getStatus(), "healthy");
  assertEquals(probe.getRTT(), 0);
  assertEquals(probe.getFirstDegradedAt(), null);
  probe.destroy();
});

Deno.test("client: createPing returns message with t1", () => {
  const probe = createTransportProbeClient({
    thresholds: DEFAULT_THRESHOLDS,
    interval: 1000,
  });
  const before = Date.now();
  const ping = probe.createPing();
  const after = Date.now();
  assertEquals(ping.t1 >= before && ping.t1 <= after, true);
  probe.destroy();
});

Deno.test("client: processPong computes RTT", () => {
  const probe = createTransportProbeClient({
    thresholds: DEFAULT_THRESHOLDS,
    interval: 1000,
  });
  const t1 = Date.now() - 50; // simulate 50ms ago
  const t2 = t1 + 25; // server received 25ms later
  probe.processPong({ t1, t2, loop: null });
  const rtt = probe.getRTT();
  // RTT = now - t1, should be ~50ms (>= 50, with some margin)
  assertEquals(rtt >= 45, true, `RTT should be ~50ms, got ${rtt}`);
  assertEquals(probe.getStatus(), "healthy"); // 50ms < degraded threshold 100ms
  probe.destroy();
});

Deno.test("client: status degrades with high RTT (600ms > warning 500ms)", () => {
  let lastStatus: string | null = null;
  const probe = createTransportProbeClient({
    thresholds: DEFAULT_THRESHOLDS,
    interval: 1000,
    onStatusChange: (s) => {
      lastStatus = s;
    },
  });
  const t1 = Date.now() - 600; // 600ms ago
  probe.processPong({ t1, t2: t1 + 10, loop: null });
  assertEquals(probe.getStatus(), "warning");
  assertEquals(lastStatus, "warning");
  assertEquals(probe.getFirstDegradedAt() !== null, true);
  probe.destroy();
});

Deno.test("client: frozen when no pong received (3000ms > frozen 2000ms)", () => {
  let lastStatus: string | null = null;
  const probe = createTransportProbeClient({
    thresholds: DEFAULT_THRESHOLDS,
    interval: 1000,
    onStatusChange: (s) => {
      lastStatus = s;
    },
  });
  // Create a ping 3000ms ago, never got pong
  const ping = probe.createPing();
  // Manually set last ping time to 3000ms ago for testing
  probe.processPong({
    t1: Date.now() - 3100,
    t2: 0,
    loop: null,
  });
  // Now check liveness — the RTT is 3100ms which is > frozen 2000ms
  assertEquals(probe.getStatus(), "frozen");
  assertEquals(lastStatus, "frozen");
  probe.destroy();
});

Deno.test("client: getLastLoop returns loop from pong", () => {
  const probe = createTransportProbeClient({
    thresholds: DEFAULT_THRESHOLDS,
    interval: 1000,
  });
  assertEquals(probe.getLastLoop(), null);
  const loopData = {
    queueDepth: 5,
    drainRate: 100,
    lastReduceTime: 10,
    lastReduceAction: "test/ACT",
    lastReduceCell: "test",
    p95ReduceTime: 15,
    effectBacklog: 0,
    circuitBreakers: [],
  };
  probe.processPong({
    t1: Date.now() - 10,
    t2: Date.now() - 5,
    loop: loopData,
  });
  assertEquals(probe.getLastLoop(), loopData);
  probe.destroy();
});

// ─── Server-side ─────────────────────────────────────────────────────────────

Deno.test("server: track client liveness", () => {
  const probe = createTransportProbeServer({ thresholds: DEFAULT_THRESHOLDS });
  probe.onClientPing("c1");
  const liveness = probe.getClientLiveness("c1");
  assertEquals(liveness !== undefined, true);
  assertEquals(liveness!.clientId, "c1");
  assertEquals(liveness!.status, "healthy");
  probe.destroy();
});

Deno.test("server: detect frozen client (no ping for 3000ms)", () => {
  let frozenId: string | null = null;
  // Liveness is stamped by the probe's OWN clock (the one-clock invariant), so
  // "an old ping" is expressed by advancing that clock, never by handing the
  // probe a timestamp from somewhere else.
  let clock = 1_000_000;
  const probe = createTransportProbeServer({
    thresholds: DEFAULT_THRESHOLDS,
    now: () => clock,
    onClientFrozen: (id) => {
      frozenId = id;
    },
  });
  probe.onClientPing("c1");
  clock += 3000;
  probe.checkAllClients();
  assertEquals(probe.isFrozen("c1"), true);
  assertEquals(frozenId, "c1");
  probe.destroy();
});

Deno.test("server: client recovery fires callback", () => {
  let recoveredId: string | null = null;
  let clock = 1_000_000;
  const probe = createTransportProbeServer({
    thresholds: DEFAULT_THRESHOLDS,
    now: () => clock,
    onClientFrozen: () => {},
    onClientRecovered: (id) => {
      recoveredId = id;
    },
  });
  // Client goes silent past the freeze threshold
  probe.onClientPing("c1");
  clock += 3000;
  probe.checkAllClients();
  assertEquals(probe.isFrozen("c1"), true);
  // Client comes back
  probe.onClientPing("c1");
  probe.checkAllClients();
  assertEquals(probe.isFrozen("c1"), false);
  assertEquals(recoveredId, "c1");
  probe.destroy();
});

Deno.test("server: remove client on disconnect", () => {
  const probe = createTransportProbeServer({ thresholds: DEFAULT_THRESHOLDS });
  probe.onClientPing("c1");
  assertEquals(probe.getClientLiveness("c1") !== undefined, true);
  probe.removeClient("c1");
  assertEquals(probe.getClientLiveness("c1"), undefined);
  probe.destroy();
});

Deno.test("server: getAllClients returns all liveness records", () => {
  const probe = createTransportProbeServer({ thresholds: DEFAULT_THRESHOLDS });
  probe.onClientPing("c1");
  probe.onClientPing("c2");
  probe.onClientPing("c3");
  const all = probe.getAllClients();
  assertEquals(all.length, 3);
  const ids = all.map((c) => c.clientId).sort();
  assertEquals(ids, ["c1", "c2", "c3"]);
  probe.destroy();
});

Deno.test("server: isFrozen check", () => {
  const probe = createTransportProbeServer({ thresholds: DEFAULT_THRESHOLDS });
  probe.onClientPing("c1");
  assertEquals(probe.isFrozen("c1"), false);
  // Unknown client
  assertEquals(probe.isFrozen("unknown"), false);
  probe.destroy();
});

Deno.test("server: onClientStateSent updates lastSent", () => {
  let clock = 1_000_000;
  const probe = createTransportProbeServer({
    thresholds: DEFAULT_THRESHOLDS,
    now: () => clock,
  });
  probe.onClientPing("c1");
  const before = probe.getClientLiveness("c1")!.lastSent;
  clock += 100;
  probe.onClientStateSent("c1");
  const after = probe.getClientLiveness("c1")!.lastSent;
  assertEquals(after > before, true);
  probe.destroy();
});
