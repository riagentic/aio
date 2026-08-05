// tests/sync/reload-cursor.test.ts — the catch-up cursor may be exactly as
// durable as the state it describes, and no more.
//
// The client's CONFIRMED state lives in memory (the engine is handed a plain
// object, re-seeded from the cell's initialState on every boot — see
// browser-sync's `initBrowserSync`). The cursor, however, was persisted in
// localStorage. So a reload produced a client that had thrown its state away
// while still telling the server "I'm caught up to T": the catch-up delivered
// nothing, and the first op or ack after that rebased the UI onto an
// initialState base — the user's data disappearing in front of them.
//
// One durable half, one volatile half, deciding one fact between them. The
// cursor now dies with the state it describes: a reload re-syncs from scratch
// (a snapshot, or the whole log), while the PENDING op queue — the thing the
// storage exists for — still survives.
import { assertEquals } from "@std/assert";
import { createLocalStorageOpStorage } from "../../src/sync/browser-storage.ts";
import { createOpBuffer } from "../../src/sync/op-buffer.ts";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import { _resetServerTsForTest } from "../../src/sync/server-store.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";
import type { HLC, SyncOp } from "../../src/sync/types.ts";
import { createTestDb, recordingSocket, until } from "./_test-db.ts";

const CELL = "notes";
const silentLog = { debug: () => {}, warn: () => {}, error: () => {} };

function shimLocalStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

const add = (
  s: Record<string, unknown>,
  payload: unknown,
): Record<string, unknown> => ({
  items: [...(s.items as string[] ?? []), payload as string],
});

/** A boot of the client: fresh engine + fresh storage handle over the same
 *  localStorage, and confirmed state re-seeded from the cell's initialState —
 *  exactly what `initBrowserSync` does on every page load. */
function boot() {
  let confirmed: Record<string, unknown> = { items: [] };
  const sent: string[] = [];
  const engine = createSyncEngine({
    clientId: "me",
    cells: { [CELL]: normalizeSyncConfig(true) },
    buffer: createOpBuffer(createLocalStorageOpStorage()),
    send: (m) => sent.push(m),
    reducer: (s, action, payload) => action === "add" ? add(s, payload) : s,
    getConfirmedState: () => ({ [CELL]: confirmed }),
    setConfirmedState: (_c, s) => {
      confirmed = s;
    },
    onStateUpdate: () => {},
  });
  return { engine, sent, confirmed: () => confirmed };
}

Deno.test("a reloaded client rebuilds its confirmed state instead of trusting a stale cursor", async () => {
  shimLocalStorage();
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    let live: Record<string, unknown> = { items: [] };
    const handler = createServerSyncHandler({
      dispatch: (a) => {
        live = add(live, (a as { payload: unknown }).payload);
      },
      db,
      syncCellIds: [CELL],
      getCellState: () => live,
      getClientCellState: () => live,
      broadcastRaw: { fn: () => {} },
      log: silentLog,
    });
    const { socket, frames } = recordingSocket();

    const peerOp = async (i: number): Promise<SyncOp> => {
      const op = {
        id: `p${i}`,
        hlc: [Date.now() + i, 0, "peer"] as HLC,
        cell: CELL,
        action: "add",
        payload: `p${i}`,
      };
      await handler.handleOp(op, { id: "peer" }, {
        send: () => {},
      } as unknown as WebSocket);
      return { ...op, confirmed: true } as SyncOp;
    };

    await peerOp(1);
    await peerOp(2);

    // ── session 1: catch up normally ────────────────────────────────────
    const s1 = boot();
    await s1.engine.requestSync();
    handler.handleSync(JSON.parse(s1.sent[0]!).d, { id: "c" }, socket);
    await until(() => frames.some((f) => f.t === "sync-res"), "sync-res");
    // deno-lint-ignore no-explicit-any
    await s1.engine.handleSyncResponse(
      frames.find((f) => f.t === "sync-res")!.d as any,
    );
    assertEquals(s1.confirmed().items, ["p1", "p2"], "session 1 caught up");

    // ── session 2: page reload ──────────────────────────────────────────
    frames.length = 0;
    const s2 = boot();
    assertEquals(s2.confirmed().items, [], "a reload starts from initialState");
    await s2.engine.requestSync();
    handler.handleSync(JSON.parse(s2.sent[0]!).d, { id: "c" }, socket);
    await until(() => frames.some((f) => f.t === "sync-res"), "sync-res");
    // deno-lint-ignore no-explicit-any
    await s2.engine.handleSyncResponse(
      frames.find((f) => f.t === "sync-res")!.d as any,
    );
    assertEquals(
      s2.confirmed().items,
      ["p1", "p2"],
      "the catch-up must rebuild what the reload threw away",
    );

    // …and the next peer op does not reveal a hollow base.
    const p3 = await peerOp(3);
    await s2.engine.handleRemoteOp(p3);
    assertEquals(
      s2.confirmed().items,
      ["p1", "p2", "p3"],
      "one op after a reload must not collapse the cell to initialState",
    );
  } finally {
    close();
  }
});

Deno.test("a reload keeps the pending op queue but not the cursor", async () => {
  shimLocalStorage();
  const first = createLocalStorageOpStorage();
  await first.saveOp({
    id: "queued",
    cell: CELL,
    action: "add",
    payload: "offline-edit",
    hlc: [1, 0, "me"],
    confirmed: false,
    _clientTs: 1,
  });
  await first.saveMeta(CELL, { lastHlc: [5, 0, "peer"], lastServerTs: 99 });

  const reloaded = createLocalStorageOpStorage();
  assertEquals(
    (await reloaded.loadOps(CELL)).map((o) => o.id),
    ["queued"],
    "the offline queue is the whole point of persisting — it must survive",
  );
  assertEquals(
    await reloaded.loadMeta(CELL),
    undefined,
    "the cursor describes confirmed state, which did NOT survive — keeping " +
      "it makes the server answer 'nothing new' to a client that has nothing",
  );

  // Within the SAME session the cursor is still a real cursor.
  await reloaded.saveMeta(CELL, { lastHlc: [7, 0, "peer"], lastServerTs: 120 });
  assertEquals((await reloaded.loadMeta(CELL))?.lastServerTs, 120);
});
