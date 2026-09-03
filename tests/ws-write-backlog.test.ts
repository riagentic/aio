// A WebSocket peer that never reads cost the SERVER unbounded memory.
//
// The broadcaster fed every OPEN socket every round. The only thing that ever
// stopped it was `serverTransport.isFrozen(meta.id)` — a LIVENESS answer, "how
// long since this client last spoke" — and the transport probe only learned a
// client existed on its first `vitals-ping`. So a peer that upgrades and then
// simply never reads (a stalled tab, a wedged proxy, a script that opens a
// socket and walks away) was never registered, never evaluated, never frozen,
// and was written to forever. Every frame stayed alive in the runtime's
// outgoing buffer, on the server's heap: +23 MB per 1000 × 30 KB commits,
// linear, with `/__aio/health` green throughout (audit a2/W2).
//
// The UDS transport grew this guard in alpha74 under a comment that said the
// WS transport "throttles and freezes a slow client". This file is that
// sentence made true, in both halves:
//
//   1. `bufferedAmount` — the runtime's own answer to "is this peer draining"
//      — gates every broadcast round, one policy shared with UDS
//      (server/write-backlog.ts).
//   2. a peer that never says anything is stopped by that backlog check, NOT
//      by the freeze watchdog — which only judges clients that send
//      heartbeats, because the age of a heartbeat is meaningless for a client
//      that does not send them.
import { assert, assertEquals } from "@std/assert";
import { createBroadcaster } from "../src/server/server-broadcast.ts";
import { WS_BUFFER_HIGH_WATER } from "../src/server/write-backlog.ts";
import { createTransportProbeServer } from "../src/vitals/transport-probe.ts";
import { DEFAULT_THRESHOLDS } from "../src/vitals/types.ts";
import type { PatchEntry } from "../src/protocol/broadcast-utils.ts";
import type { ClientMeta } from "../src/server/server-ws.ts";

/** A socket whose peer is not draining: `bufferedAmount` only ever grows. */
function fakeClient(id: string) {
  const sent: string[] = [];
  let buffered = 0;
  const ws = {
    readyState: 1,
    get bufferedAmount() {
      return buffered;
    },
    send(msg: string) {
      sent.push(msg);
      buffered += msg.length;
    },
  } as unknown as WebSocket;
  const meta = {
    id,
    index: 0,
    clientType: "browser",
    isElectron: false,
    msgCount: 0,
    bytesThisSec: 0,
    bpMultiplier: 1,
    bpConsecutiveLow: 0,
    bpLastSentAt: 0,
    subscriptions: null,
    disconnected: false,
    consecutiveDrops: 0,
  } as unknown as ClientMeta;
  return { ws, meta, sent, drain: () => (buffered = 0) };
}

const settle = () => new Promise((r) => setTimeout(r, 40));
/** A round that really costs 200 KB on the wire — the frame is the point. */
const BIG = "p".repeat(200_000);
const patch = (v: number) =>
  [{
    cell: "c",
    ops: [{ op: "replace", path: ["pad"], value: `${v}${BIG}` }],
  }] as PatchEntry[];

Deno.test("ws backlog: a peer that stops draining stops being fed", async () => {
  // One frame is ~200 KB, so the high-water mark is crossed in a handful of
  // rounds — and after it, nothing more may be written to this socket.
  const state = { c: { n: 0, pad: BIG } };
  const dead = fakeClient("dead");
  const live = fakeClient("live");
  const connections = new Map<WebSocket, ClientMeta>([
    [dead.ws, dead.meta],
    [live.ws, live.meta],
  ]);
  const broadcaster = createBroadcaster({
    connections,
    payloadStats: new Map(),
    getUIState: () => state,
    debug: () => {},
    syncIntervalMs: 1,
  });
  try {
    for (let i = 1; i <= 60; i++) {
      state.c.n = i;
      state.c.pad = `${i}${BIG}`;
      // A full-state round each time (force), so every round is a big frame.
      broadcaster.broadcast(patch(i));
      await settle();
      live.drain(); // the healthy peer reads what it is given
    }
    assert(
      dead.sent.length < 60,
      `the server must stop writing to a peer that is not draining — it ` +
        `wrote ${dead.sent.length} of 60 rounds`,
    );
    assert(
      (dead.ws as WebSocket).bufferedAmount <
        WS_BUFFER_HIGH_WATER + 2 * 200_000,
      `held bytes must stay bounded by the high-water mark, got ${
        (dead.ws as WebSocket).bufferedAmount
      }`,
    );
    // …and the healthy peer is untouched by its neighbour's problem.
    assertEquals(
      live.sent.length,
      60,
      `a draining peer must still get every round, got ${live.sent.length}`,
    );
    // A skipped round is a LOST round: the client is owed whole state, never a
    // patch that assumes the skipped ones landed.
    assertEquals(dead.meta.needsFull, true);
  } finally {
    broadcaster.shutdown();
  }
});

Deno.test("ws backlog: a peer that resumes reading is fed again", async () => {
  const state = { c: { n: 0, pad: BIG } };
  const c = fakeClient("c1");
  const connections = new Map<WebSocket, ClientMeta>([[c.ws, c.meta]]);
  const broadcaster = createBroadcaster({
    connections,
    payloadStats: new Map(),
    getUIState: () => state,
    debug: () => {},
    syncIntervalMs: 1,
  });
  try {
    for (let i = 1; i <= 40; i++) {
      state.c.n = i;
      state.c.pad = `${i}${BIG}`;
      broadcaster.broadcast(patch(i));
      await settle();
    }
    const stalled = c.sent.length;
    assert(stalled < 40, "it must have been cut off");
    c.drain();
    state.c.n = 99;
    state.c.pad = `99${BIG}`;
    broadcaster.broadcast(patch(99));
    await settle();
    assertEquals(
      c.sent.length,
      stalled + 1,
      "…and fed again the moment it drains",
    );
    assertEquals(
      JSON.parse(c.sent[c.sent.length - 1]!).t,
      "state",
      "the first frame after a cut-off is FULL state, not a patch on a gap",
    );
  } finally {
    broadcaster.shutdown();
  }
});

Deno.test("ws backlog: a silent peer is stopped by BACKLOG, not by the watchdog", () => {
  // The freeze watchdog's clock used to start at CONNECT, so a peer that had
  // said nothing since it connected was frozen like any other — and
  // `server-broadcast.ts` skips exactly the frozen. That closed the heap-growth
  // hole above, but it also froze every client that simply does not speak the
  // heartbeat protocol: `connectCli`, the dev reload socket, any third-party
  // client written against the documented wire. Each went dark two seconds
  // after connecting and stayed dark, because the gap only grows.
  //
  // The two questions are different. "Is this peer draining?" is what protects
  // the server's heap, and `bufferedAmount` answers it directly — proved by the
  // two tests above, which pass on their own. "How long since its last
  // heartbeat?" is only answerable for a client that sends heartbeats, so that
  // is the only client the watchdog now grades.
  let t = 1000;
  const probe = createTransportProbeServer({
    thresholds: DEFAULT_THRESHOLDS,
    now: () => t,
  });
  probe.onClientConnected("silent");
  t += DEFAULT_THRESHOLDS.transport.frozen * 10;
  probe.checkAllClients();
  assertEquals(
    probe.isFrozen("silent"),
    false,
    "a peer that never beats is not judged by the age of a beat",
  );

  // Once it DOES beat, it has opted into being judged — and stopping freezes it.
  probe.onClientPing("silent");
  probe.checkAllClients();
  assertEquals(probe.isFrozen("silent"), false);
  t += DEFAULT_THRESHOLDS.transport.frozen + 1;
  probe.checkAllClients();
  assertEquals(probe.isFrozen("silent"), true, "a stopped heartbeat freezes");
  probe.destroy();
});
