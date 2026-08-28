// Client vitals over a REAL socket: the AIR transport connects to a real aio
// server, sends its heartbeat, and `/__aio/vitals` reports the client.
//
// Until alpha70 this endpoint reported `clients: []` for every app that ever
// ran — `vitals-ping` had no sender. The fake-socket test (client-vitals-
// wired.test.ts) proves the frames leave; this one proves the server side
// hears them: the ping becomes a liveness row (`serverTransport.onClientPing`)
// and a pong comes back that the client's transport probe turns into an RTT.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";

Deno.test("client vitals: a connected AIR client shows up in /__aio/vitals with an RTT", async () => {
  const c = cell("vitals-probe", { state: { n: 0 }, methods: {} });
  await using srv = await testServer({ cells: [c] });

  // The transport derives its WS URL from `location` — point it at the server
  // BEFORE the module loads (it wires itself at import).
  const g = globalThis as Record<string, unknown>;
  const prevLoc = g.location;
  const u = new URL(srv.url);
  g.location = {
    protocol: u.protocol,
    host: u.host,
    search: "",
    origin: u.origin,
  };
  const { _setVitalsHeartbeatForTest } = await import(
    "../src/browser/browser-vitals.ts"
  );
  _setVitalsHeartbeatForTest(50);
  await import("../src/browser/browser-air-transport.ts");
  const { ensureConnected } = await import(
    "../src/browser/browser-protocol.ts"
  );
  const sub = await import("../src/browser/protocol-subscription.ts");
  try {
    ensureConnected();
    type Row = { id: string; status: string; rtt?: number };
    let clients: Row[] = [];
    for (let i = 0; i < 100 && clients.length === 0; i++) {
      const body = await (await srv.fetch("/__aio/vitals")).json() as {
        clients: Row[];
      };
      clients = body.clients ?? [];
      if (clients.length === 0) await new Promise((r) => setTimeout(r, 30));
    }
    assertEquals(
      clients.length,
      1,
      "the connected client is a row (this was `clients: []` for every app " +
        "from alpha48 to alpha69)",
    );
    assertEquals(clients[0]!.status, "healthy");
    // The pong reached the client's probe: an RTT exists (0 on loopback is a
    // legal measurement; `null`/`undefined` would mean no pong was processed).
    for (let i = 0; i < 50 && !sub._vitalsTransportProbe; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert(sub._vitalsTransportProbe, "transport probe exists");
    await new Promise((r) => setTimeout(r, 120));
    assertEquals(typeof sub._vitalsTransportProbe!.getRTT(), "number");
    assertEquals(sub._vitalsTransportProbe!.getStatus(), "healthy");
  } finally {
    // Teardown the way the runtime does: last listener gone → 300ms grace.
    sub._subscribe(() => {})();
    await new Promise((r) => setTimeout(r, 400));
    _setVitalsHeartbeatForTest(null);
    if (prevLoc === undefined) delete g.location;
    else g.location = prevLoc;
  }
});
