// Two ways the sync catch-up quietly served a client LESS than the log holds.
//
// 1. `compacted_ts = 0` means three different things — no snapshot, a SEEDED
//    one (`seedSyncSnapshot` leaves sync_meta alone on purpose so no live
//    client is forced into a resync), and a row written before the column
//    existed (the migration adds it `DEFAULT 0`). The catch-up read all three
//    as "never compacted", so a client with NO cursor took the incremental
//    branch and rebuilt the cell from its own declared `initialState` plus the
//    ops. For a `localFirst` cell adopted with existing KV data, that data
//    then vanished from the client on its first local edit; after an upgrade
//    from a pre-`compacted_ts` aio, every reloaded client rebuilt from a base
//    whose ops the server had already deleted.
//
// 2. Compaction tombstones the ids of the ops it deletes so `INSERT OR IGNORE`
//    still dedups a resend. It swept them on a fixed 24h, justified by a
//    comment claiming client-side stale eviction made older resends
//    impossible. It does not — that eviction only runs at `pendingCap` — and
//    `offline.retention` is per-cell with `"7d"` as the docs' own example. A
//    resend past the sweep is a server-side DOUBLE APPLY.
import { assertEquals } from "@std/assert";
import { createTestDb, recordingSocket, until } from "./_test-db.ts";
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import {
  COMPACTED_ID_RETENTION_MS,
  compactSyncOps,
  tombstoneWindowMs,
} from "../../src/sync/compact.ts";
import {
  _resetServerTsForTest,
  persistOp,
  seedSyncSnapshot,
} from "../../src/sync/server-store.ts";
import { parseRetention } from "../../src/sync/op-buffer.ts";
import type { HLC, SyncStats } from "../../src/sync/types.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import {
  createMemoryStorage,
  createOpBuffer,
} from "../../src/sync/op-buffer.ts";

const noLog = { debug: () => {}, warn: () => {}, error: () => {} };

Deno.test("catch-up: a SEEDED snapshot reaches a client that has no cursor", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  const { socket, frames } = recordingSocket();
  try {
    // What `aio-boot` writes when `localFirst`/`sync: true` adopts a cell that
    // already has KV-persisted data: a base snapshot, and NO sync_meta row.
    const live = { items: ["from-kv-1", "from-kv-2"] };
    await seedSyncSnapshot(db, "todos", live);

    const h = createServerSyncHandler({
      dispatch: () => {},
      db,
      syncCellIds: ["todos"],
      getCellState: () => live,
      getClientCellState: () => live,
      broadcastRaw: { fn: () => {} },
      log: noLog,
    });
    h.handleSync(
      {
        clientId: "c",
        session: "s",
        reqId: 1,
        // A reloaded browser: the offline-queue cursor is session-scoped, so
        // both cursors are gone with it.
        cells: { todos: { lastHlc: null } },
        pendingOps: [],
      },
      { id: "c1" },
      socket,
    );
    await until(() => frames.some((f) => f.t === "sync-res"), "sync-res");
    const res = frames.find((f) => f.t === "sync-res")!.d as Record<
      string,
      unknown
    >;
    assertEquals(
      res.mode,
      "snapshot",
      "a cursorless client must be given the base it cannot rebuild",
    );
    assertEquals(
      (res.snapshot as Record<string, unknown>).todos,
      live,
    );
  } finally {
    close();
  }
});

Deno.test("catch-up: a client WITH a cursor is still served incrementally", async () => {
  // The scope that keeps the fix from costing a snapshot per round: a cursor
  // was issued by this log AFTER the snapshot was written, so the client's
  // state already contains it.
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  const { socket, frames } = recordingSocket();
  try {
    const live = { items: ["seeded"] };
    await seedSyncSnapshot(db, "todos", live);
    const ts = await persistOp(db, {
      id: "op1",
      hlc: [Date.now(), 0, "other"] as HLC,
      cell: "todos",
      action: "add",
      payload: { t: "x" },
    });
    const h = createServerSyncHandler({
      dispatch: () => {},
      db,
      syncCellIds: ["todos"],
      getCellState: () => live,
      getClientCellState: () => live,
      broadcastRaw: { fn: () => {} },
      log: noLog,
    });
    h.handleSync(
      {
        clientId: "c",
        session: "s",
        reqId: 1,
        cells: { todos: { lastHlc: null, lastServerTs: ts ?? 1 } },
        pendingOps: [],
      },
      { id: "c1" },
      socket,
    );
    await until(() => frames.some((f) => f.t === "sync-res"), "sync-res");
    const res = frames.find((f) => f.t === "sync-res")!.d as Record<
      string,
      unknown
    >;
    assertEquals(res.mode, "incremental");
  } finally {
    close();
  }
});

Deno.test("tombstoneWindowMs: never below the floor, never below the cell's retention", () => {
  assertEquals(tombstoneWindowMs(undefined), COMPACTED_ID_RETENTION_MS);
  assertEquals(tombstoneWindowMs(0), COMPACTED_ID_RETENTION_MS);
  assertEquals(tombstoneWindowMs(NaN), COMPACTED_ID_RETENTION_MS);
  assertEquals(
    tombstoneWindowMs(parseRetention("4h")),
    COMPACTED_ID_RETENTION_MS,
    "a retention below the floor does not lower it",
  );
  // A LITERAL, not `parseRetention("7d")` on both sides — comparing a
  // function against itself holds for any implementation, including a broken
  // one.
  assertEquals(
    tombstoneWindowMs(parseRetention("7d")),
    7 * 24 * 3600_000,
    "the docs' own example must not be swept early",
  );
});

Deno.test("compaction: a tombstone survives as long as the cell lets a client hold the op", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    const op = {
      id: "clientA-sess-1",
      hlc: [Date.now(), 0, "clientA"] as HLC,
      cell: "todos",
      action: "add",
      payload: { t: "milk" },
    };
    await persistOp(db, op);
    const compact = (state: string[], hlcCnt: number) =>
      compactSyncOps({
        db,
        cell: "todos",
        getState: () => ({ items: state }),
        serverHlc: [Date.now(), hlcCnt, "server"] as HLC,
        compactOps: 0,
        retentionMs: parseRetention("7d"),
        log: noLog,
      });
    await compact(["milk"], 1);
    assertEquals(await persistOp(db, op), null, "deduped while fresh");

    // Three days offline — inside `retention: "7d"`, well past the 24h floor.
    await db.execute("UPDATE sync_compacted_ids SET compacted_at = ?", [
      Date.now() - 3 * 24 * 3600_000,
    ]);
    await persistOp(db, {
      ...op,
      id: "other",
      hlc: [Date.now(), 0, "clientB"] as HLC,
    });
    await compact(["milk", "eggs"], 2);

    assertEquals(
      await persistOp(db, op),
      null,
      "the resend must still be a duplicate — otherwise handleOp dispatches " +
        "it a SECOND time onto state that already contains it",
    );
  } finally {
    close();
  }
});

// `sync.onSync` was declared in `SyncConfig`, normalized by
// `normalizeSyncConfig`, written into `docs/persistence/crdt.md`'s own code
// example — and called from nowhere. A documented callback that never fires is
// dead wiring that reads as a working feature, the same shape as a declared
// frame kind with no sender.
Deno.test("sync: the documented onSync callback fires when a catch-up lands", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  const { socket, frames } = recordingSocket();
  try {
    const live = { items: ["seeded"] };
    await seedSyncSnapshot(db, "todos", live);
    const h = createServerSyncHandler({
      dispatch: () => {},
      db,
      syncCellIds: ["todos"],
      getCellState: () => live,
      getClientCellState: () => live,
      broadcastRaw: { fn: () => {} },
      log: noLog,
    });
    h.handleSync(
      {
        clientId: "c",
        session: "s",
        reqId: 1,
        cells: { todos: { lastHlc: null } },
        pendingOps: [],
      },
      { id: "c1" },
      socket,
    );
    await until(() => frames.some((f) => f.t === "sync-res"), "sync-res");

    // …and the client half: an engine given an onSync must call it.
    const seen: SyncStats[] = [];
    const buffer = createOpBuffer(createMemoryStorage());
    let confirmed: Record<string, unknown> = { items: [] };
    const engine = createSyncEngine({
      clientId: "me",
      cells: {
        todos: {
          ...normalizeSyncConfig(true),
          onSync: (st: SyncStats) => seen.push(st),
        },
      },
      buffer,
      send: () => {},
      reducer: (st) => st,
      getConfirmedState: () => ({ todos: confirmed }),
      setConfirmedState: (_c, st) => {
        confirmed = st;
      },
      onStateUpdate: () => {},
      log: { warn: () => {}, debug: () => {} },
    });
    await engine.requestSync();
    await engine.handleSyncResponse({
      mode: "snapshot",
      snapshot: { todos: { items: ["from-server"] } },
      ops: [],
      lowWater: {},
      lastServerTs: { todos: 1 },
      reqId: 1,
    });
    assertEquals(seen.length, 1, "onSync never fired");
    assertEquals(seen[0]!.merged, 1);
    assertEquals(typeof seen[0]!.status, "string");
    assertEquals(typeof seen[0]!.pending, "number");
  } finally {
    close();
  }
});
