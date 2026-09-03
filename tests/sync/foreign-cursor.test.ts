// A client whose catch-up cursor sits ABOVE the server's high-water mark was
// never issued that cursor by THIS op-log: `reserveServerTs` is the durable
// maximum, and every position a client can hold came from it. So the client
// synced with a different history — the server restarted on a restored
// backup, a wiped data dir, or another app now answers on the same address.
//
// Before: the server served the cursor "incrementally" (no op is above a
// position that does not exist → nothing sent), the client kept its cursor
// under the never-regress rule, and the two diverged permanently and silently
// — no line in any log, on either side (audit a5, 2026-09-02).
//
// Now: the server treats it like a cursor below compaction (snapshot), names
// the cell in `reset`, and warns once per client; the client adopts the
// snapshot and the server's cursor for a reset cell, bypassing never-regress,
// and keeps its unsent ops (they are re-sent as pendingOps and acked by the
// server it is actually talking to).
import { assert, assertEquals } from "@std/assert";
import { _resetServerTsForTest } from "../../src/sync/server-store.ts";
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import { createOpBuffer } from "../../src/sync/op-buffer.ts";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import type { SyncOp } from "../../src/sync/types.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";
import { createTestDb } from "./_test-db.ts";
import { createMemoryStorage } from "./_memory-storage.ts";

const CELL = "notes";
const reduce = (
  s: Record<string, unknown>,
  action: string,
  payload: unknown,
) => {
  if (action !== "add") return s;
  return {
    ...s,
    items: [...((s.items as string[]) ?? []), (payload as { id: string }).id],
  };
};
const macro = () => new Promise<void>((r) => setTimeout(r, 0));
const silent = { debug: () => {}, warn: () => {}, error: () => {} };

/** One client engine, one server handler whose db/state can be swapped
 *  under it (a "restart on another history"), and a pump that carries the
 *  frames both ways. */
function rig() {
  let serverState: Record<string, unknown> = { items: [] };
  let { db, close } = createTestDb();
  const closers = [close];
  const inbox: string[] = [];
  const outbox: string[] = [];
  const socket = { send: (m: string) => inbox.push(m) } as unknown as WebSocket;
  const serverWarns: string[] = [];
  const clientWarns: string[] = [];
  const makeHandler = () =>
    createServerSyncHandler({
      dispatch: (a) => {
        serverState = reduce(serverState, a.type.split(":")[1]!, a.payload);
      },
      db,
      syncCellIds: [CELL],
      getCellState: () => serverState,
      getClientCellState: () => serverState,
      broadcastRaw: { fn: () => {} },
      log: { ...silent, warn: (m) => serverWarns.push(m) },
    });
  let handler = makeHandler();

  let confirmed: Record<string, unknown> = { items: [] };
  const buffer = createOpBuffer(createMemoryStorage());
  const engine = createSyncEngine({
    clientId: "c1",
    cells: { [CELL]: normalizeSyncConfig(true) },
    buffer,
    send: (m) => outbox.push(m),
    reducer: (s, a, p) => reduce(s, a, p),
    getConfirmedState: () => ({ [CELL]: confirmed }),
    setConfirmedState: (_c, s) => {
      confirmed = s;
    },
    onStateUpdate: () => {},
    log: { warn: (m) => clientWarns.push(m) },
  });
  const pump = async () => {
    for (let i = 0; i < 20; i++) {
      await macro();
      while (outbox.length) {
        const m = JSON.parse(outbox.shift()!);
        if (m.t === "op") await handler.handleOp(m.d, { id: "s" }, socket);
        else if (m.t === "sync-req") {
          handler.handleSync(m.d, { id: "s" }, socket);
        }
      }
      await macro();
      while (inbox.length) {
        const m = JSON.parse(inbox.shift()!);
        if (m.t === "sync-ack") {
          await engine.handleAck(
            m.d.cell,
            m.d.opId,
            m.d.serverHlc,
            m.d.serverTs,
          );
        } else if (m.t === "op") {
          await engine.handleRemoteOp({ ...m.d, confirmed: true } as SyncOp);
        } else if (m.t === "sync-res") await engine.handleSyncResponse(m.d);
        else if (m.t === "op-rejected") {
          await engine.handleRejection(m.d.cell, m.d.opId, m.d.reason);
        }
      }
    }
  };
  /** The server comes back on a DIFFERENT, empty history. */
  const restartOnFreshHistory = () => {
    _resetServerTsForTest();
    const fresh = createTestDb();
    closers.push(fresh.close);
    db = fresh.db;
    serverState = { items: [] };
    handler = makeHandler();
  };
  const peerWrites = (id: string) =>
    handler.handleOp(
      {
        id,
        hlc: [Date.now(), 0, "peer"],
        cell: CELL,
        action: "add",
        payload: { id },
      },
      { id: "peer" },
      { send: () => {} } as unknown as WebSocket,
    );
  return {
    engine,
    buffer,
    pump,
    restartOnFreshHistory,
    peerWrites,
    confirmed: () => confirmed,
    serverState: () => serverState,
    serverWarns,
    clientWarns,
    close: () => closers.forEach((c) => c()),
  };
}

Deno.test("foreign cursor: a client above the server's high-water converges (restored backup)", async () => {
  _resetServerTsForTest();
  const r = rig();
  try {
    // Session on history A: 3 ops, one catch-up → the client holds A's cursor.
    await r.engine.requestSync();
    await r.pump();
    for (const id of ["a1", "a2", "a3"]) {
      await r.engine.handleLocalAction(CELL, "add", { id });
    }
    await r.pump();
    await r.engine.requestSync();
    await r.pump();
    const cursorA = (await r.buffer.getMeta(CELL))?.lastServerTs ?? 0;
    assert(cursorA > 0, "client holds a cursor from history A");
    assertEquals(r.confirmed().items, ["a1", "a2", "a3"]);

    // The server "restarts" on history B — a fresh log, a peer writes to it.
    r.restartOnFreshHistory();
    r.engine.setOnline(false);
    r.engine.setOnline(true); // reconnect → catch-up with A's cursor
    await r.pump();
    await r.peerWrites("b1");
    await r.engine.requestSync();
    await r.pump();

    assertEquals(
      r.confirmed().items,
      r.serverState().items,
      "client converges to the server it is connected to",
    );
    const cursorB = (await r.buffer.getMeta(CELL))?.lastServerTs ?? 0;
    assert(cursorB !== cursorA, "cursor was reset to B's");
    assertEquals(
      r.serverWarns.filter((m) => m.includes("above this log's high-water"))
        .length,
      1,
      "server warns exactly once per client, not once per round",
    );
    assert(
      r.clientWarns.some((m) =>
        m.includes("never issued this client's sync cursor")
      ),
      "client says why its state was replaced",
    );

    // And it keeps working from there: a further catch-up stays incremental.
    await r.peerWrites("b2");
    await r.engine.requestSync();
    await r.pump();
    assertEquals(r.confirmed().items, ["b1", "b2"]);
    assertEquals(
      r.serverWarns.filter((m) => m.includes("high-water")).length,
      1,
    );
  } finally {
    r.close();
  }
});

Deno.test("foreign cursor: the client's unsent ops survive the reset and land on the new history", async () => {
  _resetServerTsForTest();
  const r = rig();
  try {
    await r.engine.requestSync();
    await r.pump();
    await r.engine.handleLocalAction(CELL, "add", { id: "a1" });
    await r.pump();
    await r.engine.requestSync();
    await r.pump();
    assert(((await r.buffer.getMeta(CELL))?.lastServerTs ?? 0) > 0);

    // Offline: one unsent op. Then the server comes back on another history.
    r.engine.setOnline(false);
    await r.engine.handleLocalAction(CELL, "add", { id: "offline-1" });
    r.restartOnFreshHistory();
    r.engine.setOnline(true);
    await r.pump();
    await r.engine.requestSync();
    await r.pump();

    assertEquals(
      r.serverState().items,
      ["offline-1"],
      "the unsent op reached history B",
    );
    assertEquals(r.confirmed().items, r.serverState().items);
    assertEquals(
      (await r.buffer.getUnconfirmed(CELL)).length,
      0,
      "nothing left pending",
    );
  } finally {
    r.close();
  }
});

Deno.test("foreign cursor: a cursor the server DID issue is not reset (no false positive)", async () => {
  _resetServerTsForTest();
  const r = rig();
  try {
    await r.engine.requestSync();
    await r.pump();
    for (const id of ["a1", "a2"]) {
      await r.engine.handleLocalAction(CELL, "add", { id });
    }
    await r.pump();
    await r.engine.requestSync();
    await r.pump();
    await r.peerWrites("a3");
    await r.engine.requestSync();
    await r.pump();
    assertEquals(r.confirmed().items, ["a1", "a2", "a3"]);
    assertEquals(r.serverWarns.filter((m) => m.includes("high-water")), []);
    assertEquals(r.clientWarns.filter((m) => m.includes("never issued")), []);
  } finally {
    r.close();
  }
});
