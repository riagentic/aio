// A client subscribed to ONE cell must not be sent anything when a round
// changes only cells outside its subscriptions.
//
// The flush loop fell through to its full-state fallback whenever no patch in
// the round matched the client's subscriptions, and the dedup memo only stops
// that while it is fresh — after any patch round it is stale by design
// (tests/broadcast-stale-memo.test.ts). So every change to an unrelated cell,
// following a change to the subscribed one, re-sent the client its whole view:
// a 5 KB full state per round in place of nothing.
import { assert, assertEquals } from "@std/assert";
import { createBroadcaster } from "../src/server/server-broadcast.ts";
import type { PatchEntry } from "../src/protocol/broadcast-utils.ts";
import type { ClientMeta } from "../src/server/server-ws.ts";

const settle = () => new Promise((r) => setTimeout(r, 50));
const kind = (frame: string) => JSON.parse(frame).t as string;

Deno.test("broadcast: a round with no patch in a client's subscriptions sends it nothing", async () => {
  const state = { a: { pad: "p".repeat(5000), v: 1 }, b: { v: 1 } };
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    send(m: string) {
      sent.push(m);
    },
  } as unknown as WebSocket;
  const meta = {
    id: "c1",
    index: 0,
    clientType: "browser",
    isElectron: false,
    msgCount: 0,
    bytesThisSec: 0,
    bpMultiplier: 1,
    bpConsecutiveLow: 0,
    bpLastSentAt: 0,
    subscriptions: new Set(["a"]),
    disconnected: false,
    consecutiveDrops: 0,
  } as unknown as ClientMeta;
  const broadcaster = createBroadcaster({
    connections: new Map([[ws, meta]]),
    payloadStats: new Map(),
    getUIState: () => state,
    debug: () => {},
    syncIntervalMs: 10,
  });
  try {
    // The connect frame: the client holds its view of `a`.
    meta.lastFullJson = JSON.stringify({ a: state.a });
    meta.lastFullJsonStale = false;
    for (let i = 0; i < 5; i++) {
      state.a.v++;
      broadcaster.broadcast([
        { cell: "a", ops: [{ op: "replace", path: ["v"], value: state.a.v }] },
      ] as PatchEntry[]);
      await settle();
      state.b.v++;
      broadcaster.broadcast([
        { cell: "b", ops: [{ op: "replace", path: ["v"], value: state.b.v }] },
      ] as PatchEntry[]);
      await settle();
    }
    assertEquals(
      sent.map(kind),
      ["patches", "patches", "patches", "patches", "patches"],
      "one patch per change to `a`, nothing for the rounds that changed only `b`",
    );
    assert(
      sent.every((f) => !f.includes('"b"')),
      "no frame carries the unsubscribed cell",
    );
  } finally {
    broadcaster.shutdown();
  }
});
