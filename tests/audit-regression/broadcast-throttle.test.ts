// Regression: broadcast() must not drop patches that arrive between the
// microtask schedule point and the microtask execution — audit F-6.
//
// Old behavior: dirty flag was reset INSIDE the microtask, after new patches
// had already been accumulated (and their dirty=true signal already squashed).
// The follow-up throttle callback then saw dirty=false and never flushed.
//
// Correct behavior: dirty is reset BEFORE the microtask is scheduled, so any
// re-entrant broadcast() between schedule and the throttle callback re-arms
// dirty and the throttle flushes the backlog.

import { assertEquals } from "jsr:@std/assert@1.0.19";
import { createBroadcaster } from "../../src/server-broadcast.ts";
import type { PatchEntry } from "../../src/broadcast-utils.ts";
import type { ClientMeta } from "../../src/server-ws.ts";

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
    getUIState: () => ({ seq: ++seq }),
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

  // First call — snapshots [p1], schedules microtask
  broadcaster.broadcast([p1]);
  // Before the microtask runs (still sync), add p2. Old bug: this dirty=true
  // was overwritten to false inside the microtask, so throttle skipped the flush.
  broadcaster.broadcast([p2]);

  // Microtask runs → first send goes out.
  await Promise.resolve();
  assertEquals(
    sent.length,
    1,
    `expected 1 send after microtask, got ${sent.length}: ${JSON.stringify(sent)}`,
  );

  // Wait long enough for throttle to expire AND its re-broadcast microtask to run.
  await new Promise((r) => setTimeout(r, 60));

  // p2 must have triggered a second send via the throttle. With the bug,
  // dirty was reset before the throttle saw it, so the second send never
  // happened and clients sat on stale state.
  assertEquals(
    sent.length,
    2,
    `expected 2 sends (initial + throttle flush of p2), got ${sent.length}: ${
      JSON.stringify(sent)
    }`,
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
