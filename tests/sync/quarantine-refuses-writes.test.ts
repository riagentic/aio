// tests/sync/quarantine-refuses-writes.test.ts — H2 regression.
//
// Boot QUARANTINES a sync cell whose op-log could not be folded into the
// current shape: the cell runs at its last snapshot, its snapshot is not
// rewritten and its log is not compacted, so nothing on disk is lost. That
// promise held for exactly one path — `tryCompact` asked `isQuarantined`;
// `handleOp` and `handleSync` never did.
//
// So a quarantined cell still accepted, persisted, dispatched, ACKED and
// broadcast client ops: the client is told its write is durable while the boot
// log says the opposite, and the next restart replays a log that still cannot
// be folded — the write is gone. Worse, compaction stays off forever, so
// `sync_ops` grows without bound and every boot re-loads the whole log,
// re-quarantines, and keeps compaction off: no escape without DB surgery.
import { assert, assertEquals } from "@std/assert";
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import { _resetServerTsForTest } from "../../src/sync/server-store.ts";
import type { HLC } from "../../src/sync/types.ts";
import { createTestDb, recordingSocket, until } from "./_test-db.ts";

const CELL = "notes";
const silent = { debug: () => {}, warn: () => {}, error: () => {} };

function makeHandler(db: ReturnType<typeof createTestDb>["db"], opts: {
  quarantined?: boolean;
  onDispatch?: () => void;
  onBroadcast?: () => void;
} = {}) {
  return createServerSyncHandler({
    dispatch: () => {
      opts.onDispatch?.();
    },
    db,
    syncCellIds: [CELL],
    getCellState: () => ({ items: [] }),
    getClientCellState: () => ({ items: [] }),
    isQuarantined: () => opts.quarantined === true,
    broadcastRaw: { fn: () => opts.onBroadcast?.() },
    log: silent,
  });
}

const op = (id: string) => ({
  id,
  // Stamped NOW — an unknown op stamped older than the tombstone window is
  // refused by name (`STALE_OP_REASON`), and this fixture is not about age.
  hlc: [Date.now(), 0, "c1"] as HLC,
  cell: CELL,
  action: "add",
  payload: { text: "hi" },
});

Deno.test("H2: a quarantined cell refuses ops — no persist, no dispatch, no ack, no broadcast", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    let dispatched = 0;
    let broadcast = 0;
    const handler = makeHandler(db, {
      quarantined: true,
      onDispatch: () => dispatched++,
      onBroadcast: () => broadcast++,
    });
    const { socket, frames } = recordingSocket();

    await handler.handleOp(op("o1"), { id: "s1" }, socket);

    assertEquals(dispatched, 0, "a quarantined cell must not dispatch");
    assertEquals(broadcast, 0, "a quarantined cell must not broadcast");
    assert(
      !frames.some((f) => f.t === "sync-ack"),
      "a quarantined cell must never ack — the ack is a durability promise it cannot keep",
    );
    const rejected = frames.find((f) => f.t === "op-rejected");
    assert(
      rejected,
      `expected an op-rejected frame, got ${
        JSON.stringify(frames.map((f) => f.t))
      }`,
    );
    assertEquals(rejected.d.opId, "o1");
    assertEquals(rejected.d.cell, CELL);
    const reason = String(rejected.d.reason);
    assert(
      reason.includes("quarantine"),
      `the reason must name the quarantine — got "${reason}"`,
    );
    assert(
      /restart|version|onMigrate/.test(reason),
      `the reason must say how to clear it — got "${reason}"`,
    );

    const { rows } = await db.query("SELECT id FROM sync_ops");
    assertEquals(rows.length, 0, "a refused op must not reach the op-log");
  } finally {
    close();
  }
});

Deno.test("H2: a quarantined cell refuses reconnect-flushed pending ops too", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    let dispatched = 0;
    const handler = makeHandler(db, {
      quarantined: true,
      onDispatch: () => dispatched++,
    });
    const { socket, frames } = recordingSocket();

    handler.handleSync(
      {
        clientId: "c1",
        cells: { [CELL]: { lastHlc: null } },
        pendingOps: [{ ...op("p1"), confirmed: false }],
      },
      { id: "s1" },
      socket,
    );
    await until(
      () => frames.some((f) => f.t === "sync-res"),
      "sync response",
    );

    assertEquals(dispatched, 0, "a quarantined cell must not dispatch");
    assert(
      !frames.some((f) => f.t === "sync-ack"),
      "a quarantined cell must never ack a pending op",
    );
    assert(
      frames.some((f) => f.t === "op-rejected" && f.d.opId === "p1"),
      "the client must be TOLD, or it re-sends this op forever",
    );
    const { rows } = await db.query("SELECT id FROM sync_ops");
    assertEquals(rows.length, 0, "a refused pending op must not reach the log");
  } finally {
    close();
  }
});

Deno.test("H2: a quarantined cell is not served state, and its cursor is not echoed", async () => {
  // Serving the quarantined cell's LIVE state would overwrite the client's
  // confirmed state with the pre-quarantine snapshot, and echoing a cursor
  // would seal the ops the server could not fold above it — the client would
  // never ask for them again.
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    const handler = makeHandler(db, { quarantined: true });
    const { socket, frames } = recordingSocket();
    handler.handleSync(
      { clientId: "c1", cells: { [CELL]: { lastHlc: null } }, pendingOps: [] },
      { id: "s1" },
      socket,
    );
    await until(() => frames.some((f) => f.t === "sync-res"), "sync response");
    const res = frames.find((f) => f.t === "sync-res")!.d as {
      mode: string;
      snapshot?: Record<string, unknown>;
      lastServerTs?: Record<string, number>;
    };
    assertEquals(
      res.snapshot?.[CELL],
      undefined,
      "no snapshot for a quarantined cell",
    );
    assertEquals(
      res.lastServerTs?.[CELL],
      undefined,
      "no cursor echo for a quarantined cell",
    );
  } finally {
    close();
  }
});

Deno.test("H2: a healthy cell is unaffected — ops persist, dispatch, ack and broadcast", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    let dispatched = 0;
    let broadcast = 0;
    const handler = makeHandler(db, {
      quarantined: false,
      onDispatch: () => dispatched++,
      onBroadcast: () => broadcast++,
    });
    const { socket, frames } = recordingSocket();
    await handler.handleOp(op("ok1"), { id: "s1" }, socket);
    assertEquals(dispatched, 1);
    assertEquals(broadcast, 1);
    assert(frames.some((f) => f.t === "sync-ack" && f.d.opId === "ok1"));
    const { rows } = await db.query("SELECT id FROM sync_ops");
    assertEquals(rows.length, 1);
  } finally {
    close();
  }
});
