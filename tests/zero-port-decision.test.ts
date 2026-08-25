// The zero-TCP-port decision, as a TABLE. `resolveZeroPort` is the one pure
// decider behind `skipHttp` (no handler at all), `useHttpSocket` (the handler
// on a Unix socket) and the boot line's "no TCP port" claim — which must only
// be printed when literally true.
//
// The principle it encodes: a local desktop app that serves nothing to a
// browser or another service has no reason to open a port — a port is a cost
// (reachable by every process and tab on the machine), not a feature. So a
// local Electron app on a Unix socket binds NO TCP port by default, dev and
// prod alike; anything that needs a URL (browser client, --expose, Windows,
// prod without dist/) keeps one, and a NAMED port (`--port=N`, `AIO_PORT`,
// `aio.run({ port })`) is the explicit opt-out — a webhook receiver another
// process must reach over TCP names its port. Custom `routes` never veto
// zero: they move to the socket (`aio://app/<path>`).

import { assertEquals } from "@std/assert";
import { resolveZeroPort } from "../src/server/aio-server.ts";

type In = Parameters<typeof resolveZeroPort>[0];
type Out = ReturnType<typeof resolveZeroPort>;

const PORT: Out = { zeroPort: false, skipHttp: false, useHttpSocket: false };
const SOCKET: Out = { zeroPort: true, skipHttp: false, useHttpSocket: true };
const DISK: Out = { zeroPort: true, skipHttp: true, useHttpSocket: false };

const TABLE: [string, In, Out][] = [
  // prod
  ["prod, dist, no routes → page off disk, no handler", {
    prod: true,
    localElectronUds: true,
    canServeFromDisk: true,
    portRequested: false,
    routeCount: 0,
  }, DISK],
  ["prod, dist, routes → page off disk, routes on the socket, no TCP", {
    prod: true,
    localElectronUds: true,
    canServeFromDisk: true,
    portRequested: false,
    routeCount: 1,
  }, SOCKET],
  ["prod, dist, routes, --port=N → the named port (a webhook receiver)", {
    prod: true,
    localElectronUds: true,
    canServeFromDisk: true,
    portRequested: true,
    routeCount: 1,
  }, PORT],
  ["prod, no dist → port (the window must load over http)", {
    prod: true,
    localElectronUds: true,
    canServeFromDisk: false,
    portRequested: false,
    routeCount: 0,
  }, PORT],
  ["prod, not electron+uds (browser / --expose / ws / Windows) → port", {
    prod: true,
    localElectronUds: false,
    canServeFromDisk: true,
    portRequested: false,
    routeCount: 0,
  }, PORT],
  // dev — zero is the DEFAULT
  ["dev, default, no routes → handler on the socket, no TCP", {
    prod: false,
    localElectronUds: true,
    canServeFromDisk: false,
    portRequested: false,
    routeCount: 0,
  }, SOCKET],
  ["dev, default, routes → handler AND routes on the socket", {
    prod: false,
    localElectronUds: true,
    canServeFromDisk: false,
    portRequested: false,
    routeCount: 3,
  }, SOCKET],
  ["dev, --port=N → the named port (the opt-out)", {
    prod: false,
    localElectronUds: true,
    canServeFromDisk: false,
    portRequested: true,
    routeCount: 0,
  }, PORT],
  ["dev, not electron+uds (browser / --expose / ws / Windows) → port", {
    prod: false,
    localElectronUds: false,
    canServeFromDisk: false,
    portRequested: false,
    routeCount: 0,
  }, PORT],
  ["dev never skips the handler (modules are transpiled on demand)", {
    prod: false,
    localElectronUds: true,
    canServeFromDisk: true,
    portRequested: false,
    routeCount: 0,
  }, SOCKET],
];

Deno.test("zero-port decision table", () => {
  for (const [name, input, want] of TABLE) {
    assertEquals(resolveZeroPort(input), want, name);
  }
});

Deno.test("zero-port invariants over the whole input space", () => {
  const bools = [false, true];
  for (const prod of bools) {
    for (const localElectronUds of bools) {
      for (const canServeFromDisk of bools) {
        for (const portRequested of bools) {
          for (const routeCount of [0, 1, 7]) {
            const input = {
              prod,
              localElectronUds,
              canServeFromDisk,
              portRequested,
              routeCount,
            };
            const r = resolveZeroPort(input);
            const ctx = JSON.stringify(input);
            // exactly one of {port, socket, disk}
            assertEquals(
              r.skipHttp && r.useHttpSocket,
              false,
              `skipHttp XOR socket ${ctx}`,
            );
            assertEquals(
              r.zeroPort,
              r.skipHttp || r.useHttpSocket,
              `zeroPort ⇔ one of the two zero shapes ${ctx}`,
            );
            // no handler at all ⇒ nothing to serve routes: only when there are none, in prod, off disk
            if (r.skipHttp) {
              assertEquals([prod, canServeFromDisk, routeCount], [
                true,
                true,
                0,
              ], `skipHttp preconditions ${ctx}`);
            }
            // never zero without electron+uds
            if (!localElectronUds) {
              assertEquals(r.zeroPort, false, `no electron+uds ⇒ port ${ctx}`);
            }
            // a named port is always honoured — the opt-out never loses
            if (portRequested) {
              assertEquals(r.zeroPort, false, `named port ⇒ port ${ctx}`);
            }
            // dev on electron+uds without a named port is ALWAYS zero
            if (!prod && localElectronUds && !portRequested) {
              assertEquals(r.zeroPort, true, `dev default is zero ${ctx}`);
            }
            // routes never veto zero — they move to the socket
            if (r.zeroPort && routeCount > 0) {
              assertEquals(r.useHttpSocket, true, `routes ⇒ socket ${ctx}`);
            }
          }
        }
      }
    }
  }
});
