// tests/sync/tombstone-sweep-longest-retention.test.ts — a compaction of ONE
// cell must not sweep the tombstones ANOTHER cell's retention still needs.
//
// `sync_compacted_ids` has no cell column, so the sweep in `compactSyncOps`
// deletes every cell's tombstones older than the window it is handed. The
// handler handed it the COMPACTING cell's retention: a default-retention cell
// (24h window) compacting swept the tombstones of a `retention: "7d"` cell.
// That cell's lost-ack resend two days later is younger than its own window —
// so it is not refused as stale — and unknown to the store — so it was
// inserted, dispatched and applied a SECOND time.
import { assert, assertEquals } from "@std/assert";
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import { _resetServerTsForTest } from "../../src/sync/server-store.ts";
import type { HLC } from "../../src/sync/types.ts";
import { createTestDb, recordingSocket } from "./_test-db.ts";

const HOUR = 3600_000;
const silent = { debug: () => {}, warn: () => {}, error: () => {} };

Deno.test("tombstone sweep: a default-retention cell's compaction keeps a 7d cell's tombstones, so its 2-day-late resend is re-acked, not re-applied", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  const orig = Date.now;
  const at = { t: orig() };
  Date.now = () => at.t;
  try {
    const applied: string[] = [];
    const handler = createServerSyncHandler({
      dispatch: (a) => {
        applied.push(a.type);
      },
      db,
      syncCellIds: ["notes", "chat"],
      getCellState: () => ({}),
      getClientCellState: () => ({}),
      // `notes` keeps offline changes a week; `chat` takes the default.
      opRetentionMs: (c) => c === "notes" ? 7 * 24 * HOUR : undefined,
      broadcastRaw: { fn: () => {} },
      log: silent,
    });
    const { socket, frames } = recordingSocket();
    const X = {
      id: "phone-s1-1",
      hlc: [at.t, 0, "phone"] as HLC,
      cell: "notes",
      action: "add",
      payload: { t: "milk" },
    };

    // The phone's change lands; its ack is lost. A server write folds
    // `notes`: X's row becomes a tombstone.
    await handler.handleOp(X, { id: "phone" }, socket);
    assertEquals(applied, ["notes:add"]);
    handler.noteServerWrite("notes");
    assertEquals(await handler.flushServerWrites(), undefined);

    // Two days on, the OTHER cell compacts.
    at.t += 48 * HOUR;
    handler.noteServerWrite("chat");
    assertEquals(await handler.flushServerWrites(), undefined);
    assertEquals(
      (await db.query("SELECT id FROM sync_compacted_ids WHERE id = ?", [X.id]))
        .rows.length,
      1,
      "X's tombstone was swept by another cell's compaction, inside the 7d " +
        "retention `notes` declared",
    );

    // The phone comes back and re-sends X.
    frames.length = 0;
    await handler.handleOp(X, { id: "phone" }, socket);
    assertEquals(applied, ["notes:add"], "X was applied a SECOND time");
    assert(
      frames.some((f) => f.t === "sync-ack" && f.d.opId === X.id),
      "the resend must be re-acked",
    );
  } finally {
    Date.now = orig;
    close();
  }
});
