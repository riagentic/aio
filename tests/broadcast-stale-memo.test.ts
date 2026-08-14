// The per-client "you already have this state" memo is only proof while it is
// FRESH.
//
// `meta.lastFullJson` is refreshed exactly when a full state is serialized for
// that client. Every patch round moves the client on WITHOUT touching it, so
// after any patch the memo describes an older state than the client actually
// holds. The dedup then read it as proof anyway: a state that serializes back
// to that older text — a value returning to what it was, mid-patch-stream —
// was treated as "already delivered" and the whole round was dropped. The
// client sat on the intermediate value forever: server idle, health green,
// nothing logged, a spinner that never resolves.
import { assert, assertEquals } from "@std/assert";
import { createBroadcaster } from "../src/server/server-broadcast.ts";
import type { PatchEntry } from "../src/protocol/broadcast-utils.ts";
import type { ClientMeta } from "../src/server/server-ws.ts";

/** A socket that records what it was handed. */
function fakeClient() {
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    send(msg: string) {
      sent.push(msg);
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
    subscriptions: null,
    disconnected: false,
    consecutiveDrops: 0,
  } as unknown as ClientMeta;
  return { ws, meta, sent };
}

const PAD = "p".repeat(400); // makes "a small patch" and "a big patch" distinct
const kind = (frame: string) => JSON.parse(frame).t as string;

const settle = () => new Promise((r) => setTimeout(r, 60));

Deno.test("broadcast: a state EQUAL to the last full send is still sent after a patch round", async () => {
  const state = { c: { pad: PAD, v: 1 } };
  const { ws, meta, sent } = fakeClient();
  const connections = new Map<WebSocket, ClientMeta>([[ws, meta]]);
  const broadcaster = createBroadcaster({
    connections,
    payloadStats: new Map(),
    getUIState: () => state,
    debug: () => {},
    syncIntervalMs: 10,
  });
  try {
    // The connect frame: the ws manager sends the full state and stamps the
    // memo. This is the state the client holds right now.
    meta.lastFullJson = JSON.stringify(state);
    meta.lastFullJsonStale = false;

    // Round 1 — a small patch. The client moves to v:2; the memo is NOT
    // re-serialized, so from here on it describes an older state.
    state.c.v = 2;
    const small: PatchEntry[] = [
      { cell: "c", ops: [{ op: "replace", path: ["v"], value: 2 }] },
      // deno-lint-ignore no-explicit-any
    ] as any;
    broadcaster.broadcast(small);
    await settle();
    assertEquals(sent.length, 1, "the patch round was delivered");
    assertEquals(kind(sent[0]!), "patches", "…as a patch");

    // Round 2 — the value returns to 1, and the ops are big enough that the
    // encoder chooses a full state (patch > 50% of full). The serialized
    // state now equals `lastFullJson`, which the client has NOT held since
    // round 1.
    state.c.v = 1;
    const big: PatchEntry[] = [
      {
        cell: "c",
        ops: [
          { op: "replace", path: ["v"], value: 1 },
          { op: "replace", path: ["pad"], value: PAD },
        ],
      },
      // deno-lint-ignore no-explicit-any
    ] as any;
    broadcaster.broadcast(big);
    await settle();

    assertEquals(
      sent.length,
      2,
      "the client is one state behind — dropping this round strands it there",
    );
    const frame = sent[1]!;
    assertEquals(kind(frame), "state", "the big-patch path sends full state");
    assert(
      frame.includes(`"v":1`),
      `the delivered state must be the current one:\n${frame.slice(0, 200)}`,
    );
  } finally {
    broadcaster.shutdown();
  }
});

Deno.test("broadcast: a genuinely unchanged state is still NOT re-sent", async () => {
  // The dedup itself is worth keeping — it is what stops a no-op dispatch from
  // costing every client a full-state frame. The fix narrows it to the case
  // where the memo is exact, it does not remove it.
  const state = { c: { pad: PAD, v: 1 } };
  const { ws, meta, sent } = fakeClient();
  const connections = new Map<WebSocket, ClientMeta>([[ws, meta]]);
  const broadcaster = createBroadcaster({
    connections,
    payloadStats: new Map(),
    getUIState: () => state,
    debug: () => {},
    syncIntervalMs: 10,
  });
  try {
    meta.lastFullJson = JSON.stringify(state);
    meta.lastFullJsonStale = false;
    // A round whose ops are large (→ full-state path) over an UNCHANGED state.
    const big: PatchEntry[] = [
      {
        cell: "c",
        ops: [{ op: "replace", path: ["pad"], value: PAD }],
      },
      // deno-lint-ignore no-explicit-any
    ] as any;
    broadcaster.broadcast(big);
    await settle();
    assertEquals(sent.length, 0, "nothing new to say, nothing sent");
  } finally {
    broadcaster.shutdown();
  }
});
