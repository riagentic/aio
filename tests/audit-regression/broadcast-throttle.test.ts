// Regression: broadcast() must not drop patches that arrive between the
// microtask schedule point and the microtask execution — audit F-6.
//
// Original bug (hand-rolled throttle): the dirty flag was reset INSIDE the
// microtask, after new patches had already been accumulated, so the follow-up
// throttle callback saw dirty=false and never flushed the backlog.
//
// Now WS + UDS share createCoalescer, which drains its buffer AT flush time
// (never snapshots at schedule time), so a re-entrant broadcast() in that gap
// is either coalesced into the leading flush or carried by the throttle tail —
// never dropped. This test pins the INVARIANT (both patches delivered), not the
// exact send count, which legitimately differs between the two implementations.

import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import { createBroadcaster } from "../../src/server/server-broadcast.ts";
import type { PatchEntry } from "../../src/protocol/broadcast-utils.ts";
import type { ClientMeta } from "../../src/server/server-ws.ts";

function makeFakeClient(): {
  ws: WebSocket;
  meta: ClientMeta;
  sent: string[];
} {
  const sent: string[] = [];
  const ws = {
    readyState: 1, // WebSocket.OPEN
    send(msg: string) {
      sent.push(msg);
    },
  } as unknown as WebSocket;
  const meta: ClientMeta = {
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
  };
  return { ws, meta, sent };
}

Deno.test("F-6: patches added between schedule and microtask flush on next throttle tick", async () => {
  const { ws, meta, sent } = makeFakeClient();
  const connections = new Map<WebSocket, ClientMeta>();
  connections.set(ws, meta);

  // seq increments on every getUIState() call. Fresh seq value in a later send
  // proves the throttle re-fired broadcast (not just resending cached payload).
  let seq = 0;
  const broadcaster = createBroadcaster({
    connections,
    payloadStats: new Map(),
    // Large full-state so patch payloads stay under the full-state threshold and
    // are sent AS patches (we assert on the patch content).
    getUIState: () => ({ seq: ++seq, pad: "z".repeat(500) }),
    debug: () => {},
    syncIntervalMs: 20,
  });

  const p1: PatchEntry = {
    cell: "a",
    ops: [{ op: "add", path: ["x"], value: 1 }],
  };
  const p2: PatchEntry = {
    cell: "a",
    ops: [{ op: "add", path: ["y"], value: 2 }],
  };

  // First call — schedules the leading flush.
  broadcaster.broadcast([p1]);
  // Before the microtask runs (still sync), add p2. The invariant: p2 must NOT
  // be dropped — it must reach the client, whether coalesced into the leading
  // flush (the shared coalescer drains at run time) or via the throttle tail.
  broadcaster.broadcast([p2]);

  // Let the leading flush AND any throttle tail settle.
  await new Promise((r) => setTimeout(r, 60));

  const all = sent.join("|");
  assert(all.includes('"x"'), `p1 (x) must be delivered: ${all}`);
  assert(
    all.includes('"y"'),
    `p2 (added in the schedule→flush gap) must be delivered — never dropped: ${all}`,
  );

  broadcaster.shutdown();
});

Deno.test("F-6: idle broadcaster — no throttle re-fire when nothing buffered", async () => {
  const { ws, meta, sent } = makeFakeClient();
  const connections = new Map<WebSocket, ClientMeta>();
  connections.set(ws, meta);

  let seq = 0;
  const broadcaster = createBroadcaster({
    connections,
    payloadStats: new Map(),
    getUIState: () => ({ seq: ++seq }),
    debug: () => {},
    syncIntervalMs: 20,
  });

  broadcaster.broadcast();
  await Promise.resolve();
  assertEquals(sent.length, 1);
  // Nothing else queued — throttle should expire silently
  await new Promise((r) => setTimeout(r, 60));
  assertEquals(
    sent.length,
    1,
    `expected idle broadcaster to stay quiet, got extra sends: ${
      JSON.stringify(sent.slice(1))
    }`,
  );
  broadcaster.shutdown();
});
