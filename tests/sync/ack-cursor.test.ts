// tests/sync/ack-cursor.test.ts — an ack must always state WHERE the op sits
// in the log, including when the op is a duplicate.
//
// "Don't re-apply this op" and "where does this op sit" are two different
// facts. `persistOp` answers the first with `null` for a duplicate, and the
// ack used to answer the second with silence because of it. That is precisely
// the ack most likely to arrive after a snapshot — a duplicate means the FIRST
// ack was lost — and without the position the client cannot tell an op its
// snapshot already contains from one it doesn't, so it applies it again.
import { assert, assertEquals } from "@std/assert";
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import { _resetServerTsForTest } from "../../src/sync/server-store.ts";
import { compactSyncOps } from "../../src/sync/compact.ts";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import { createOpBuffer } from "../../src/sync/op-buffer.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";
import type { HLC } from "../../src/sync/types.ts";
import { createMemoryStorage } from "./_memory-storage.ts";
import { createTestDb, recordingSocket, until } from "./_test-db.ts";

const CELL = "notes";
const silentLog = { debug: () => {}, warn: () => {}, error: () => {} };

const OP = {
  id: "op-1",
  // Stamped NOW — an unknown op stamped older than the tombstone window is
  // refused by name (`STALE_OP_REASON`); this fixture is not about age.
  hlc: [Date.now(), 0, "c1"] as HLC,
  cell: CELL,
  action: "add",
  payload: "hello",
};

function server(db: ReturnType<typeof createTestDb>["db"]) {
  let state: Record<string, unknown> = { items: [] };
  const handler = createServerSyncHandler({
    dispatch: (a) => {
      state = {
        items: [
          ...(state.items as string[]),
          (a as { payload: string }).payload,
        ],
      };
    },
    db,
    syncCellIds: [CELL],
    getCellState: () => state,
    getClientCellState: () => state,
    broadcastRaw: { fn: () => {} },
    log: silentLog,
  });
  return { handler, state: () => state };
}

const acksIn = (frames: { t: string; d: Record<string, unknown> }[]) =>
  frames.filter((f) => f.t === "sync-ack");

Deno.test("a duplicate re-ack still states the op's server_ts", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    const { handler } = server(db);
    const { socket, frames } = recordingSocket();

    await handler.handleOp(OP, { id: "c" }, socket);
    await until(() => acksIn(frames).length >= 1, "first ack");
    const first = acksIn(frames)[0]!.d.serverTs;
    assert(typeof first === "number", "a fresh insert acks with its position");

    // The client never saw that ack and re-sends the op.
    await handler.handleOp(OP, { id: "c" }, socket);
    await until(() => acksIn(frames).length >= 2, "re-ack");
    assertEquals(
      acksIn(frames)[1]!.d.serverTs,
      first,
      "the re-ack must repeat the op's position, not omit it",
    );
  } finally {
    close();
  }
});

Deno.test("a re-ack after compaction reads the position off the tombstone", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    const { handler, state } = server(db);
    const { socket, frames } = recordingSocket();

    await handler.handleOp(OP, { id: "c" }, socket);
    await until(() => acksIn(frames).length >= 1, "first ack");
    const first = acksIn(frames)[0]!.d.serverTs as number;

    // Compaction folds the op into the snapshot and DELETES its row — the
    // tombstone is now the only record that the op ever existed.
    await compactSyncOps({
      db,
      cell: CELL,
      getState: state,
      serverHlc: [9999, 0, "server"],
      compactOps: 1,
      log: silentLog,
    });
    assertEquals(
      (await db.query("SELECT id FROM sync_ops WHERE id = ?", [OP.id])).rows
        .length,
      0,
      "row compacted away",
    );

    await handler.handleOp(OP, { id: "c" }, socket);
    await until(() => acksIn(frames).length >= 2, "re-ack");
    assertEquals(
      acksIn(frames)[1]!.d.serverTs,
      first,
      "a compacted op's position must survive in the tombstone — the client " +
        "needs it to know its snapshot already contains this op",
    );
    assertEquals(
      (state().items as string[]).length,
      1,
      "and the duplicate is still never re-applied",
    );
  } finally {
    close();
  }
});

Deno.test("a snapshot + a duplicate re-ack applies the op exactly once", async () => {
  // End to end, on the real handler: the ack is lost, a snapshot lands (it
  // contains the op — snapshots are the server's live state), and only THEN
  // does a resend produce a re-ack. Without the position on that re-ack the
  // client applies its own op a second time and stays diverged forever.
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    const { handler } = server(db);
    const { socket, frames } = recordingSocket();

    let confirmed: Record<string, unknown> = { items: [] };
    const sent: string[] = [];
    const engine = createSyncEngine({
      clientId: "c1",
      cells: { [CELL]: normalizeSyncConfig(true) },
      buffer: createOpBuffer(createMemoryStorage()),
      send: (m) => sent.push(m),
      reducer: (s, action, payload) =>
        action === "add"
          ? { items: [...(s.items as string[] ?? []), payload as string] }
          : s,
      getConfirmedState: () => ({ [CELL]: confirmed }),
      setConfirmedState: (_c, s) => {
        confirmed = s;
      },
      onStateUpdate: () => {},
    });

    // 1. Local op reaches the server, which applies it — but the ack is lost.
    await engine.handleLocalAction(CELL, "add", "hello");
    const opFrame = JSON.parse(sent[0]!).d;
    await handler.handleOp(opFrame, { id: "c" }, socket);
    await until(() => acksIn(frames).length >= 1, "first ack");
    frames.length = 0; // the ack never arrives

    // 2. Compaction rolls the log over, so the client's catch-up is a
    //    SNAPSHOT — which already contains the op it is still waiting on.
    handler.noteServerWrite(CELL);
    await handler.flushServerWrites();
    await engine.requestSync();
    handler.handleSync(JSON.parse(sent[1]!).d, { id: "c" }, socket);
    await until(() => frames.some((f) => f.t === "sync-res"), "sync-res");
    for (const f of frames) {
      if (f.t === "sync-res") {
        // deno-lint-ignore no-explicit-any
        await engine.handleSyncResponse(f.d as any);
      }
    }
    assertEquals(confirmed.items, ["hello"], "the snapshot brought it in once");

    // 3. A delayed duplicate of the original op frame reaches the server; its
    //    re-ack is the first ack this client actually receives.
    frames.length = 0;
    await handler.handleOp(opFrame, { id: "c" }, socket);
    await until(() => acksIn(frames).length >= 1, "re-ack");
    const ack = acksIn(frames)[0]!.d;
    await engine.handleAck(
      ack.cell as string,
      ack.opId as string,
      ack.serverHlc as HLC,
      ack.serverTs as number | undefined,
    );

    assertEquals(
      confirmed.items,
      ["hello"],
      "the op is already in the snapshot — the re-ack must not apply it again",
    );
  } finally {
    close();
  }
});

Deno.test("a tombstone written before the server_ts column degrades, never lies", async () => {
  // An existing app's database carries tombstones from an older aio: the
  // column is 0 there (`SYNC_MIGRATIONS` default). 0 is not a position, so the
  // ack omits the field and the client keeps its pre-alpha43 behaviour —
  // guessing a position would be worse than saying nothing.
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    const { handler } = server(db);
    const { socket, frames } = recordingSocket();
    await db.execute(
      "INSERT INTO sync_compacted_ids (id, compacted_at, server_ts) VALUES (?, ?, 0)",
      ["legacy-op", Date.now()],
    );
    await handler.handleOp(
      { ...OP, id: "legacy-op" },
      { id: "c" },
      socket,
    );
    await until(() => acksIn(frames).length >= 1, "ack");
    assertEquals(
      acksIn(frames)[0]!.d.serverTs,
      undefined,
      "an unknown position is reported as absent, not as 0",
    );
  } finally {
    close();
  }
});
