// Sync status "blocked" reports the pending cap AS IT IS, not as it was.
//
// `handleLocalAction` sets "blocked" when the op buffer refuses an op (pending
// cap reached). The only writers that moved a cell off it were `requestSync`
// and going offline, so on a connected tab whose acks drained the queue the
// status kept answering "blocked" ("cannot queue more") while new ops were
// accepted again. And `foldCell` RETURNED before `onSync` whenever the cell
// was blocked, so "blocked" — a documented `onSync` status — was never
// delivered, and a catch-up landing while the queue was full was not reported.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import { normalizeSyncConfig, type SyncStats } from "../../src/sync/types.ts";
import { createOpBuffer } from "../../src/sync/op-buffer.ts";
import { createMemoryStorage } from "./_memory-storage.ts";

Deno.test("sync status: 'blocked' clears once the queue drains on a live connection", async () => {
  const sent: { t: string; d: Record<string, unknown> }[] = [];
  const engine = createSyncEngine({
    clientId: "c1",
    cells: { todos: normalizeSyncConfig(true) },
    buffer: createOpBuffer(createMemoryStorage(), { pendingCap: 2 }),
    send: (m: string) => sent.push(JSON.parse(m)),
    reducer: (s: Record<string, unknown>) => s,
    getConfirmedState: () => ({ todos: {} }),
    setConfirmedState: () => {},
    onStateUpdate: () => {},
  });
  try {
    // Online, server slow to ack: two ops in flight fill the (small) cap.
    await engine.handleLocalAction("todos", "add", { text: "1" });
    await engine.handleLocalAction("todos", "add", { text: "2" });
    await assertRejects(
      () => engine.handleLocalAction("todos", "add", { text: "3" }),
      Error,
      "DROPPED",
    );
    assertEquals(engine.getStatus("todos").status, "blocked", "precondition");

    // The server now acks both in-flight ops.
    await new Promise((r) => setTimeout(r, 50)); // op pacing
    const ops = sent.filter((f) => f.t === "op");
    assertEquals(ops.length, 2, `precondition: both ops went out`);
    let ts = 1;
    for (const f of ops) {
      await engine.handleAck(
        "todos",
        f.d.id as string,
        [Date.now(), 0, "server"],
        ts++,
      );
    }
    const st = engine.getStatus("todos");
    assertEquals(st.pending, 0, "precondition: the queue drained");
    // …and a new op is accepted again — the cap no longer applies.
    await engine.handleLocalAction("todos", "add", { text: "4" });
    assert(engine.getStatus("todos").pending >= 1, "precondition: op queued");

    assertEquals(
      engine.getStatus("todos").status,
      "online",
      "status still reports 'blocked' (cap reached, cannot queue) after the " +
        "queue drained and a new op was accepted",
    );
  } finally {
    engine.dispose();
  }
});

Deno.test("sync onSync: a catch-up that lands while the cell is blocked is still reported", async () => {
  const seen: { status?: string; pending?: number }[] = [];
  let confirmed: Record<string, unknown> = { items: [] };
  const engine = createSyncEngine({
    clientId: "c1",
    cells: {
      todos: {
        ...normalizeSyncConfig(true),
        onSync: (st: SyncStats) =>
          seen.push({ status: st.status, pending: st.pending }),
      },
    },
    buffer: createOpBuffer(createMemoryStorage(), { pendingCap: 1 }),
    send: () => {},
    reducer: (s: Record<string, unknown>) => s,
    getConfirmedState: () => ({ todos: confirmed }),
    setConfirmedState: (_c, st) => {
      confirmed = st;
    },
    onStateUpdate: () => {},
    log: { warn: () => {}, debug: () => {} },
  });
  try {
    await engine.requestSync(); // reqId 1 outstanding
    await engine.handleLocalAction("todos", "add", { text: "1" });
    await assertRejects(
      () => engine.handleLocalAction("todos", "add", { text: "2" }),
      Error,
      "DROPPED",
    );
    assertEquals(engine.getStatus("todos").status, "blocked", "precondition");
    await engine.handleSyncResponse({
      mode: "snapshot",
      snapshot: { todos: { items: ["from-server"] } },
      ops: [],
      lowWater: {},
      lastServerTs: { todos: 1 },
      reqId: 1,
    });
    assertEquals(
      confirmed,
      { items: ["from-server"] },
      "precondition: the catch-up snapshot was applied",
    );
    assertEquals(
      seen.length,
      1,
      "the catch-up landed (snapshot applied) but onSync never fired because " +
        "the cell was 'blocked'",
    );
    // …and it says so: the queue is still full, so the status is "blocked".
    assertEquals(seen[0], { status: "blocked", pending: 1 });
    assertEquals(engine.getStatus("todos").status, "blocked");
  } finally {
    engine.dispose();
  }
});
