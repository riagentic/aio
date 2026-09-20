// A round skipped for a client that could not keep up is OWED to it — and the
// debt has to be paid even when no later round ever comes.
//
// The broadcaster skips a peer whose socket is not draining
// (`bufferedAmount` over the high-water mark) and marks it `needsFull`, so
// the next round carries whole state instead of a patch on a gap. But only a
// later ROUND honoured the mark. An app that went idle after the skip never
// had one, so the peer drained its buffer and then sat on the state from
// before the skip — for as long as nothing changed. Measured with four real
// sockets on a 1.7 MB cell: the last push and the last append of a burst
// never reached any client, the server idle, no error anywhere, health green.
// (The freeze watchdog's recovery hook already paid ITS clients this way —
// tests/frozen-client-recovery-resync.test.ts; the backlog skip had nothing.)
import { assert, assertEquals } from "@std/assert";
import { createBroadcaster } from "../src/server/server-broadcast.ts";
import type { PatchEntry } from "../src/protocol/broadcast-utils.ts";
import type { ClientMeta } from "../src/server/server-ws.ts";

/** A socket whose peer reads nothing until `drain()`. */
function slowClient(id: string) {
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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BIG = "p".repeat(1_000_000);

Deno.test("ws backlog: a skipped client is paid its full state once it drains, with no later round", async () => {
  const state = { c: { n: 0, pad: BIG } };
  const c = slowClient("slow");
  const connections = new Map<WebSocket, ClientMeta>([[c.ws, c.meta]]);
  const broadcaster = createBroadcaster({
    connections,
    payloadStats: new Map(),
    getUIState: () => state,
    debug: () => {},
    syncIntervalMs: 1,
  });
  try {
    // A burst: ~1 MB frames until the peer is over the high-water mark and
    // rounds start being skipped for it.
    for (let i = 1; i <= 8; i++) {
      state.c = { n: i, pad: `${i}${BIG}` };
      broadcaster.broadcast([{
        cell: "c",
        ops: [
          { op: "replace", path: ["n"], value: i },
          { op: "replace", path: ["pad"], value: state.c.pad },
        ],
      }] as PatchEntry[]);
      await wait(20);
    }
    // Instrument check: the burst really crossed the mark, so the last rounds
    // were skipped and are owed.
    assert(c.sent.length < 8, `nothing was skipped (${c.sent.length}/8)`);
    assertEquals(c.meta.needsFull, true);

    // The peer catches up — and the app is idle from here on.
    c.drain();
    const t0 = Date.now();
    while (c.meta.needsFull && Date.now() - t0 < 3000) await wait(20);

    const last = JSON.parse(c.sent[c.sent.length - 1]!) as {
      t: string;
      d: { c: { n: number } };
    };
    assertEquals(
      last.t,
      "state",
      "the debt is paid with whole state, not a patch on a gap",
    );
    assertEquals(
      last.d.c.n,
      8,
      "the client must end up holding the server's state — it was left on " +
        `n=${last.d.c.n} with the server idle on n=8`,
    );
    assertEquals(c.meta.needsFull, false);
  } finally {
    broadcaster.shutdown();
  }
});

Deno.test("ws backlog: a peer that never drains is not written to by the retry", async () => {
  const state = { c: { n: 0, pad: BIG } };
  const c = slowClient("dead");
  const connections = new Map<WebSocket, ClientMeta>([[c.ws, c.meta]]);
  const broadcaster = createBroadcaster({
    connections,
    payloadStats: new Map(),
    getUIState: () => state,
    debug: () => {},
    syncIntervalMs: 1,
  });
  try {
    for (let i = 1; i <= 8; i++) {
      state.c = { n: i, pad: `${i}${BIG}` };
      broadcaster.broadcast([{
        cell: "c",
        ops: [
          { op: "replace", path: ["n"], value: i },
          { op: "replace", path: ["pad"], value: state.c.pad },
        ],
      }] as PatchEntry[]);
      await wait(20);
    }
    const cut = c.sent.length;
    await wait(400);
    assertEquals(
      c.sent.length,
      cut,
      "the retry must never pile a whole state onto a socket that is not draining",
    );
    assertEquals(c.meta.needsFull, true, "…and the debt is kept, not dropped");
  } finally {
    broadcaster.shutdown();
  }
});
