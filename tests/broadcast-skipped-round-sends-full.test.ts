// A client under backpressure pacing SKIPS rounds. The patches in a skipped
// round are not queued anywhere — they are gone for that client — and the next
// round it was eligible for sent only the NEWER patch. A throttled client
// applied `replace items[1]` on a list that never received `add items[1]`,
// diverged from the server, and health stayed green. Now a skipped round marks
// the client as owed a FULL state, and the next eligible round sends one.
import { assertEquals } from "@std/assert";
import { createBroadcaster } from "../src/server/server-broadcast.ts";
import type { PatchEntry } from "../src/protocol/broadcast-utils.ts";
import type { ClientMeta } from "../src/server/server-ws.ts";

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
const kind = (frame: string) => JSON.parse(frame).t as string;
const settle = () => new Promise((r) => setTimeout(r, 60));

Deno.test("broadcast: a round skipped under backpressure makes the next one a full state", async () => {
  const state = { c: { pad: "p".repeat(400), items: [0] } };
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
    // Round 1: the client is current.
    meta.lastFullJson = JSON.stringify(state);
    meta.lastFullJsonStale = false;
    // Round 2: throttled — this round is skipped for the client.
    meta.bpMultiplier = 4;
    meta.bpLastSentAt = Date.now();
    state.c.items = [0, 1];
    broadcaster.broadcast(
      [{
        cell: "c",
        ops: [{ op: "add", path: ["items", 1], value: 1 }],
      }] as PatchEntry[],
    );
    await settle();
    assertEquals(sent.length, 0, "the throttled round was skipped");
    // Round 3: eligible again. The patch alone would leave items[1] missing.
    meta.bpMultiplier = 1;
    state.c.items = [0, 2];
    broadcaster.broadcast(
      [{
        cell: "c",
        ops: [{ op: "replace", path: ["items", 1], value: 2 }],
      }] as PatchEntry[],
    );
    await settle();
    assertEquals(sent.length, 1, "the eligible round was delivered");
    assertEquals(
      kind(sent[0]!),
      "state",
      "…as FULL state, not a patch on a lost patch",
    );
    assertEquals(JSON.parse(sent[0]!).d.c.items, [0, 2]);
    assertEquals(meta.needsFull, false, "the debt is cleared by the full send");
  } finally {
    broadcaster.shutdown();
  }
});
