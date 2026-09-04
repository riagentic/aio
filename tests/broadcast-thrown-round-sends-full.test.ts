// The twin of `broadcast-skipped-round-sends-full.test.ts`, for the OTHER way
// a round is lost.
//
// The coalescer empties its buffer BEFORE calling the flush, so a round that
// throws — anywhere: patch compaction, subscription filtering, serialization,
// cost metering — takes its patches with it. They exist nowhere else. The skip
// paths knew that and marked the client `needsFull`; the catch did not, so
// every client kept applying LATER patches on top of state missing the lost
// round's writes.
//
// Nothing downstream caught it either: Immer's out-of-range array `add`
// SPLICES instead of throwing, so the client's resync safety net never fired
// and the list was merely wrong, permanently, with health green. (Measured
// end to end: `s.items.push(v); s.big = 1n;` — the BigInt takes
// `JSON.stringify` down — left two clients on ["one","three"] against a
// server on ["one","two","three"].)
//
// Both halves are pinned here: the server marks the debt, and the client
// REFUSES an impossible op rather than inventing a plausible list from it.
import { assertEquals, assertThrows } from "@std/assert";
import { enablePatches } from "immer";
import { createBroadcaster } from "../src/server/server-broadcast.ts";
import { applyWirePatches } from "../src/protocol/patch-ops.ts";
import type { PatchEntry } from "../src/protocol/broadcast-utils.ts";
import type { ClientMeta } from "../src/server/server-ws.ts";

enablePatches();

function fakeClient(id: string) {
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    send(msg: string) {
      sent.push(msg);
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
  return { ws, meta, sent };
}
const kind = (frame: string) => JSON.parse(frame).t as string;
const settle = () => new Promise((r) => setTimeout(r, 60));

Deno.test("broadcast: a round lost to a THROW makes the next one a full state, for every client", async () => {
  // A value the wire cannot carry — the round's `JSON.stringify` throws on it.
  const state: Record<string, unknown> = {
    c: { pad: "p".repeat(400), items: [0] },
  };
  const a = fakeClient("a");
  const b = fakeClient("b");
  const connections = new Map<WebSocket, ClientMeta>([
    [a.ws, a.meta],
    [b.ws, b.meta],
  ]);
  const broadcaster = createBroadcaster({
    connections,
    payloadStats: new Map(),
    getUIState: () => state,
    debug: () => {},
    syncIntervalMs: 10,
  });
  try {
    for (const c of [a, b]) {
      c.meta.lastFullJson = JSON.stringify(state);
      c.meta.lastFullJsonStale = false;
    }
    // Round 1: the patch itself carries a BigInt — serializing the round
    // throws and nothing goes out.
    (state.c as { items: unknown[] }).items = [0, 1];
    broadcaster.broadcast(
      [{
        cell: "c",
        ops: [{ op: "add", path: ["items", 1], value: 1n }],
      }] as unknown as PatchEntry[],
    );
    await settle();
    assertEquals(a.sent.length, 0, "the thrown round delivered nothing");
    assertEquals(b.sent.length, 0, "the thrown round delivered nothing");
    assertEquals(a.meta.needsFull, true, "client a is owed a full state");
    assertEquals(b.meta.needsFull, true, "client b is owed a full state");

    // Round 2: serializable again. A patch here would assume round 1 landed.
    (state.c as { items: unknown[] }).items = [0, 1, 2];
    broadcaster.broadcast(
      [{
        cell: "c",
        ops: [{ op: "add", path: ["items", 2], value: 2 }],
      }] as PatchEntry[],
    );
    await settle();
    for (const c of [a, b]) {
      assertEquals(c.sent.length, 1, "the next round was delivered");
      assertEquals(kind(c.sent[0]!), "state", "…as FULL state, not a patch");
      assertEquals(JSON.parse(c.sent[0]!).d.c.items, [0, 1, 2]);
      assertEquals(c.meta.needsFull, false, "the debt is cleared");
    }
  } finally {
    broadcaster.shutdown();
  }
});

Deno.test("applyWirePatches: an op the state cannot describe throws, so the caller resyncs", () => {
  // Exactly the shape a lost round produces: the client never got `items[1]`,
  // so the next round's op addresses a row that is not there. Immer would
  // splice it at the end and hand back ["one","three"] — plausible, wrong,
  // silent. Every caller treats a throw as "request full state".
  assertThrows(
    () =>
      applyWirePatches({ items: ["one"] }, [
        { op: "add", path: ["items", 2], value: "three" },
      ]),
    Error,
    "a delta was lost",
  );
  assertThrows(
    () =>
      applyWirePatches({ items: ["one"] }, [
        { op: "replace", path: ["items", 4], value: "x" },
      ]),
    Error,
    "a delta was lost",
  );
  assertThrows(
    () =>
      applyWirePatches({ items: ["one"] }, [
        { op: "remove", path: ["items", 1] },
      ]),
    Error,
    "a delta was lost",
  );
});

Deno.test("applyWirePatches: every honest op still applies", () => {
  // Append at the end, the extend-by-one `replace` the compactor emits, ops
  // that SHIFT indices, and a whole-container write that makes a later index
  // legal. A guard that trips on any of these would be a resync loop.
  assertEquals(
    applyWirePatches({ items: ["a"] }, [
      { op: "add", path: ["items", 1], value: "b" },
      { op: "add", path: ["items", 2], value: "c" },
      { op: "remove", path: ["items", 0] },
      { op: "replace", path: ["items", 1], value: "C" },
    ]),
    { items: ["b", "C"] },
  );
  assertEquals(
    applyWirePatches({ items: ["a"] }, [
      { op: "replace", path: ["items", 1], value: "b" },
      { op: "replace", path: ["items", 2], value: "c" },
    ]),
    { items: ["a", "b", "c"] },
  );
  assertEquals(
    applyWirePatches({ o: { rows: [["a"]] } }, [
      { op: "replace", path: ["o"], value: { rows: [["a"], ["b"], ["c"]] } },
      { op: "add", path: ["o", "rows", 3], value: ["d"] },
      { op: "add", path: ["o", "rows", 0, 1], value: "a2" },
    ]),
    { o: { rows: [["a", "a2"], ["b"], ["c"], ["d"]] } },
  );
  // A path into something that is not an array is not this guard's business.
  assertEquals(
    applyWirePatches({ map: { "3": "x" } as Record<string, string> }, [
      { op: "replace", path: ["map", "9"], value: "y" },
    ]),
    { map: { "3": "x", "9": "y" } },
  );
});
