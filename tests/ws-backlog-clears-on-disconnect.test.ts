// The "a WebSocket peer is not draining" alarm must go out with the peer.
//
// `ws:write-backlog` is raised per broadcast ROUND (server-broadcast.ts) and
// lowered the same way — by a round in which no connected peer is over the
// high-water mark. Nothing lowered it when the stalled peer simply LEFT: after
// the one wedged tab closed, `/__aio/health` kept reporting a client that was
// not draining for as long as the app stayed idle, and forever if that tab
// had been the only client (a round with zero connections never says `ok()`).
// The UDS transport clears its half at the moment the queue drains or the
// connection dies; the WS half did not, and a false alarm that outlives its
// cause is how a real one stops being believed.
import { assert, assertEquals } from "@std/assert";
import { _resetDegraded, degradedReport } from "../src/diagnostics/degraded.ts";
import { createWsManager } from "../src/server/server-ws.ts";
import { createBroadcaster } from "../src/server/server-broadcast.ts";
import type { PatchEntry } from "../src/protocol/broadcast-utils.ts";
import { freePort } from "../src/testing/server-test.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BIG = "p".repeat(1_000_000); // one full-state frame ≈ 1 MB

/** A peer that completes the upgrade and then never reads another byte. */
async function stalledPeer(port: number): Promise<Deno.Conn> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  const w = conn.writable.getWriter();
  await w.write(
    new TextEncoder().encode(
      `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`,
    ),
  );
  w.releaseLock();
  // Read the 101, then stop reading for good.
  const r = conn.readable.getReader();
  let head = "";
  while (!head.includes("\r\n\r\n")) {
    const { value, done } = await r.read();
    if (done) break;
    head += new TextDecoder().decode(value);
  }
  r.releaseLock();
  assert(head.startsWith("HTTP/1.1 101"), head.slice(0, 80));
  return conn;
}

Deno.test("ws backlog: the alarm clears when the stalled peer disconnects", async () => {
  _resetDegraded();
  const state = { c: { n: 0, pad: BIG } };
  const mgr = createWsManager({
    dispatch: () => {},
    getUIState: () => state,
    debug: () => {},
    prod: false,
    clientCounter: { value: 0 },
    bootId: "b",
  });
  const broadcaster = createBroadcaster({
    connections: mgr.connections,
    payloadStats: mgr.payloadStats,
    getUIState: () => state,
    debug: () => {},
    syncIntervalMs: 1,
  });
  const port = freePort();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    (req) => mgr.handleWs(req),
  );
  const peer = await stalledPeer(port);
  try {
    for (let i = 0; i < 100 && mgr.connections.size === 0; i++) await wait(10);
    assertEquals(mgr.connections.size, 1, "the peer upgraded");

    // Feed it until the high-water mark is crossed and the tracker escalates.
    let raised = false;
    for (let i = 1; i <= 60 && !raised; i++) {
      state.c.n = i;
      state.c.pad = `${i}${BIG}`;
      broadcaster.broadcast(
        [{
          cell: "c",
          ops: [{ op: "replace", path: ["pad"], value: state.c.pad }],
        }] as PatchEntry[],
      );
      await wait(15);
      raised = degradedReport().some((d) => d.name === "ws:write-backlog");
    }
    const [ws] = [...mgr.connections.keys()];
    assert(
      raised,
      `precondition: the alarm never rose (bufferedAmount=${ws?.bufferedAmount})`,
    );

    // The wedged peer goes away. Nothing else happens — no dispatch, no round.
    peer.close();
    for (let i = 0; i < 200 && mgr.connections.size > 0; i++) await wait(10);
    assertEquals(mgr.connections.size, 0, "the socket was reaped");
    await wait(20);
    assertEquals(
      degradedReport().filter((d) => d.name === "ws:write-backlog"),
      [],
      "no connected peer is backlogged, so /__aio/health must not say one is",
    );
  } finally {
    try {
      peer.close();
    } catch { /* already closed */ }
    broadcaster.shutdown();
    mgr.shutdown();
    await server.shutdown();
    _resetDegraded();
  }
});
