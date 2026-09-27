// A late ack for an op the buffer EVICTED under backpressure re-syncs the cell.
//
// `stale-evicted` drops an unconfirmed op that may already have been sent; its
// ack can just be slow. That ack is proof the server applied the change — and
// nothing else will bring it to this client (a catch-up leaves out the
// requester's own session's ops). It used to be ignored: no fold (the op is
// gone from the queue), no re-sync (eviction had forgotten the id), so the
// server and every peer held the change and this client never would.
// dropReport("stale-evicted") tells the user to read the cell's state to see
// whether the change is there — the state has to be able to show it.
import { assert, assertEquals } from "@std/assert";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";
import {
  createMemoryStorage,
  createOpBuffer,
} from "../../src/sync/op-buffer.ts";

type Frame = { t: string; d: Record<string, unknown> };

function setup() {
  const sent: Frame[] = [];
  const drops: string[] = [];
  const engine = createSyncEngine({
    clientId: "c1",
    cells: { todos: normalizeSyncConfig(true) },
    buffer: createOpBuffer(createMemoryStorage(), {
      pendingCap: 1,
      staleAfter: 1, // 1 ms retention — the first op is stale at once
      onDrop: (op, reason) => drops.push(`${op.id}:${reason}`),
    }),
    send: (m) => sent.push(JSON.parse(m)),
    reducer: (s: Record<string, unknown>, action, payload) =>
      action === "add"
        ? { ...s, items: [...(s.items as unknown[]), payload] }
        : null,
    getConfirmedState: () => ({ todos: { items: [] } }),
    setConfirmedState: () => {},
    onStateUpdate: () => {},
  });
  const resyncAsked = () =>
    sent.some((f) =>
      f.t === "sync-req" && Array.isArray(f.d.resync) &&
      (f.d.resync as string[]).includes("todos")
    );
  return { engine, sent, drops, resyncAsked };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

Deno.test("sync eviction: a late ack for an evicted op re-syncs the cell", async () => {
  const { engine, sent, drops, resyncAsked } = setup();
  try {
    // op1 goes out on the wire; the server applies it, the ack is slow.
    await engine.handleLocalAction("todos", "add", "one");
    const op1 = sent.find((f) => f.t === "op")!.d;
    await tick();
    // Queue at its cap, op1 past retention: evicted to make room.
    await engine.handleLocalAction("todos", "add", "two");
    assertEquals(drops, [`${op1.id}:stale-evicted`], "precondition: evicted");
    assert(!resyncAsked(), "precondition: eviction alone does not re-sync");

    // The late ack lands: the server DID apply op1.
    await engine.handleAck("todos", op1.id as string, [Date.now(), 0, "s"], 7);
    await tick(); // the coalesced re-sync runs on a 0 ms timer

    assert(
      resyncAsked(),
      "the server acked an evicted op, yet the client never asked for the " +
        "cell — its confirmed state can never hold the change",
    );
  } finally {
    engine.dispose();
  }
});

Deno.test("sync eviction: an ack for an evicted op an installed snapshot already covers costs nothing", async () => {
  const { engine, sent, drops, resyncAsked } = setup();
  try {
    await engine.handleLocalAction("todos", "add", "one");
    const op1 = sent.find((f) => f.t === "op")!.d;
    await tick();
    await engine.handleLocalAction("todos", "add", "two");
    assertEquals(drops.length, 1, "precondition: evicted");
    // A catch-up snapshot at position 10 — it holds everything at or below.
    await engine.handleSyncResponse({
      mode: "snapshot",
      ops: [],
      snapshot: { todos: { items: ["one"] } },
      lowWater: { todos: [1000, 0, "s"] },
      lastServerTs: { todos: 10 },
    });
    await tick();
    sent.length = 0;
    await engine.handleAck("todos", op1.id as string, [Date.now(), 0, "s"], 7);
    await tick();
    assert(!resyncAsked(), "the snapshot already holds the evicted op");
  } finally {
    engine.dispose();
  }
});
