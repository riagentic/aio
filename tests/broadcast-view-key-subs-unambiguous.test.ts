// The broadcaster shares ONE full-state serialization per VIEW, keyed by
// `${userMemoKey(user)}|<subscriptions>` (server-broadcast.ts
// `_viewSnapshotter`). A subscription path is any client-supplied string
// (parseSubs caps length/count, nothing else), so when the subscription set was
// encoded as `[...subs].sort().join(",")`, the set {"a,b"} and the set
// {"a","b"} built the SAME key — and the second client in the round was handed
// the first client's view. Anonymous clients all share the "no-user" bucket,
// so one peer subscribing to ["a,b"] blanked every other anonymous client
// subscribed to ["a","b"] whenever a round sent them a whole state. The set is
// now encoded as a JSON array, which no path string can forge.
import { assertEquals } from "@std/assert";
import { createBroadcaster } from "../src/server/server-broadcast.ts";
import type { PatchEntry } from "../src/protocol/broadcast-utils.ts";
import type { ClientMeta } from "../src/server/server-ws.ts";

const settle = () => new Promise((r) => setTimeout(r, 50));

function client(id: string, subs: string[]) {
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    send(m: string) {
      sent.push(m);
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
    subscriptions: new Set(subs),
    disconnected: false,
    consecutiveDrops: 0,
    // Owed a whole state (a skipped round) — the round sends full.
    needsFull: true,
  } as unknown as ClientMeta;
  return { ws, meta, sent };
}

Deno.test("broadcast: subs {'a,b'} and {'a','b'} are different views", async () => {
  const state = { a: { v: 1 }, b: { v: 1 } };
  const odd = client("odd", ["a,b"]);
  const victim = client("victim", ["a", "b"]);
  const broadcaster = createBroadcaster({
    connections: new Map([[odd.ws, odd.meta], [victim.ws, victim.meta]]),
    payloadStats: new Map(),
    getUIState: () => state,
    debug: () => {},
    syncIntervalMs: 10,
  });
  try {
    state.a.v = 2;
    broadcaster.broadcast([
      { cell: "a", ops: [{ op: "replace", path: ["v"], value: 2 }] },
    ] as PatchEntry[]);
    await settle();
    const last = JSON.parse(victim.sent.at(-1)!);
    assertEquals(last.t, "state");
    assertEquals(
      last.d,
      { a: { v: 2 }, b: { v: 1 } },
      "the victim is sent ITS view, not the other client's",
    );
  } finally {
    broadcaster.shutdown();
  }
});
