// An op THIS tab's buffer evicted is not a twin tab's doing — and must not be
// reported, or re-synced, as one.
//
// Each engine remembers the ops it issued (`_ownInFlight`) so it can notice one
// that left the shared offline queue without this engine folding it: a twin tab
// flushed it and marked it confirmed, and the server will never send it back
// (a catch-up leaves out the requester's own session's ops). That is a real
// fact this tab cannot place in its confirmed state, so it asks for the cell.
//
// The buffer's own backpressure eviction leaves the queue the same way: at the
// pending cap, `add` discards unconfirmed ops past their retention to make
// room, and those ids vanish with nobody folding them. The next `requestSync`
// then read that absence as a twin tab's work, logged "an op of this tab was
// confirmed by another tab sharing its queue" — for a change the app had just
// been told was DROPPED — and spent a snapshot re-sync on it. A diagnostic
// that names a cause that did not happen is worse than none; the re-sync is
// just the bill.
import { assert, assertEquals } from "@std/assert";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";
import {
  createMemoryStorage,
  createOpBuffer,
} from "../../src/sync/op-buffer.ts";

Deno.test("sync eviction: an op the buffer evicted does not cost a re-sync", async () => {
  const sent: string[] = [];
  const debug: string[] = [];
  const drops: string[] = [];
  const storage = createMemoryStorage();
  const buffer = createOpBuffer(storage, {
    pendingCap: 2,
    staleAfter: 0, // every queued op is instantly past its retention
    onDrop: (op, reason) => drops.push(`${op.id}:${reason}`),
  });
  const engine = createSyncEngine({
    clientId: "c1",
    cells: { todos: normalizeSyncConfig(true) },
    buffer,
    send: (m) => void sent.push(m),
    reducer: (s: Record<string, unknown>) => s,
    getConfirmedState: () => ({ todos: {} }),
    setConfirmedState: () => {},
    onStateUpdate: () => {},
    log: { warn: () => {}, debug: (m) => void debug.push(m) },
  });
  try {
    for (let i = 1; i <= 3; i++) {
      await engine.handleLocalAction("todos", "add", { n: i });
    }
    // The third op made room by evicting the first two.
    assertEquals(drops.length, 2, drops.join(", "));
    assert(
      drops.every((d) => d.endsWith(":stale-evicted")),
      drops.join(", "),
    );

    sent.length = 0;
    await engine.requestSync();
    const req = sent.map((m) => JSON.parse(m)).find((f) => f.t === "sync-req");
    assert(req, "a sync request went out");
    assertEquals(
      req.d.resync,
      undefined,
      "an op this tab's own buffer evicted is not a reason to re-sync the cell",
    );
    assert(
      !debug.some((m) => m.includes("confirmed by another tab")),
      `…and nothing blames a twin tab for it: ${debug.join(" | ")}`,
    );
  } finally {
    engine.dispose();
  }
});

Deno.test("sync eviction: an op a TWIN TAB confirmed still costs a re-sync", async () => {
  // The other direction — a prune that forgets too much would pass the test
  // above and bring back the bug `twin-tab-own-op.test.ts` pins.
  const sent: string[] = [];
  const storage = createMemoryStorage();
  const buffer = createOpBuffer(storage, { pendingCap: 50 });
  const engine = createSyncEngine({
    clientId: "c1",
    cells: { todos: normalizeSyncConfig(true) },
    buffer,
    send: (m) => void sent.push(m),
    reducer: (s: Record<string, unknown>) => s,
    getConfirmedState: () => ({ todos: {} }),
    setConfirmedState: () => {},
    onStateUpdate: () => {},
  });
  try {
    await engine.handleLocalAction("todos", "add", { n: 1 });
    // The twin tab flushed it, got the ack, and confirmed it in the shared
    // document — straight through the storage this engine shares with it.
    const [op] = await storage.loadOps("todos");
    await storage.confirmOp("todos", op!.id);
    await storage.pruneConfirmed("todos");

    sent.length = 0;
    await engine.requestSync();
    const req = sent.map((m) => JSON.parse(m)).find((f) => f.t === "sync-req");
    assert(req, "a sync request went out");
    assertEquals(req.d.resync, ["todos"], "the cell is re-synced to hold it");
  } finally {
    engine.dispose();
  }
});
