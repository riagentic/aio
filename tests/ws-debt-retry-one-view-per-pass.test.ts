// The idle debt retry (tests/ws-backlog-debt-paid-when-idle.test.ts) pays
// every owed client — and a thrown round owes EVERY client at once. The round
// loop serializes ONE full state per distinct view (user × subscriptions) and
// shares the string (server-broadcast.ts `fullFor`: 100 clients on 2.2 MB
// held 217 MB of private copies before that). The retry built one per CLIENT:
// N serializations in one timer tick, N retained copies in `lastFullJson`,
// and N `degraded` failures from one failed view — escalating a single blip
// straight to /__aio/health "degraded" with five tabs open, where a round
// counts it once.
import { assertEquals } from "@std/assert";
import { createBroadcaster } from "../src/server/server-broadcast.ts";
import type { PatchEntry } from "../src/protocol/broadcast-utils.ts";
import type { ClientMeta } from "../src/server/server-ws.ts";
import { _resetDegraded, degraded } from "../src/diagnostics/degraded.ts";

function fakeClient(id: string) {
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("ws debt retry: one full-state serialization per VIEW, not per client", async () => {
  const state: Record<string, unknown> = { c: { items: [0] } };
  let reads = 0;
  const clients = [fakeClient("a"), fakeClient("b"), fakeClient("c")];
  const connections = new Map<WebSocket, ClientMeta>(
    clients.map((c) => [c.ws, c.meta]),
  );
  const broadcaster = createBroadcaster({
    connections,
    payloadStats: new Map(),
    getUIState: () => {
      reads++;
      return state;
    },
    debug: () => {},
    syncIntervalMs: 1,
  });
  try {
    for (const c of clients) {
      c.meta.lastFullJson = JSON.stringify(state);
      c.meta.lastFullJsonStale = false;
    }
    // A round that throws (BigInt in the patch) — every client is owed.
    (state.c as { items: unknown[] }).items = [0, 1];
    broadcaster.broadcast(
      [{
        cell: "c",
        ops: [{ op: "add", path: ["items", 1], value: 1n }],
      }] as unknown as PatchEntry[],
    );
    await wait(0);
    for (const c of clients) assertEquals(c.meta.needsFull, true);
    reads = 0;
    // Idle from here: only the retry can pay.
    const t0 = Date.now();
    while (clients.some((c) => c.meta.needsFull) && Date.now() - t0 < 2000) {
      await wait(10);
    }
    for (const c of clients) {
      assertEquals(c.sent.length, 1, `client ${c.meta.id} was paid once`);
      assertEquals(JSON.parse(c.sent[0]!).d.c.items, [0, 1]);
    }
    assertEquals(
      reads,
      1,
      "three clients on one view cost ONE snapshot, as in a round",
    );
  } finally {
    broadcaster.shutdown();
  }
});

Deno.test("ws debt retry: a view that fails counts ONE failure per pass, not one per client", async () => {
  const state: Record<string, unknown> = { c: { items: [0] } };
  let broken = false;
  const clients = [
    fakeClient("d1"),
    fakeClient("d2"),
    fakeClient("d3"),
    fakeClient("d4"),
    fakeClient("d5"),
  ];
  const connections = new Map<WebSocket, ClientMeta>(
    clients.map((c) => [c.ws, c.meta]),
  );
  _resetDegraded();
  const tracker = degraded("broadcast:state");
  const broadcaster = createBroadcaster({
    connections,
    payloadStats: new Map(),
    getUIState: () => {
      if (broken) throw new Error("transient: view threw");
      return state;
    },
    debug: () => {},
    syncIntervalMs: 1,
  });
  try {
    for (const c of clients) {
      c.meta.lastFullJson = JSON.stringify(state);
      c.meta.lastFullJsonStale = false;
    }
    (state.c as { items: unknown[] }).items = [0, 1];
    broadcaster.broadcast(
      [{
        cell: "c",
        ops: [{ op: "add", path: ["items", 1], value: 1n }],
      }] as unknown as PatchEntry[],
    );
    await wait(0);
    broken = true;
    // The first retry pass (≥ 50 ms) fails the view for all five clients.
    await wait(80);
    assertEquals(
      tracker.failures,
      1,
      "one retry pass is one failure, however many clients it covered",
    );
  } finally {
    broken = false;
    broadcaster.shutdown();
    _resetDegraded();
  }
});
