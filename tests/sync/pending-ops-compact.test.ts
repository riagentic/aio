// tests/sync/pending-ops-compact.test.ts — ops that arrive through a
// reconnect's offline queue (`sync-req.pendingOps`) must reach compaction like
// ops sent live.
//
// `handleOp` runs `tryCompact` after every applied op; the pendingOps path —
// the same persist → dispatch → ack → broadcast sequence — never did. A client
// that writes mostly offline (a phone that syncs when it gets signal) put
// every op in through that door, so its cell's op-log was never folded past
// `compactOps`: the log, the boot replay and every catch-up grew for the life
// of the app, until some live op or server write happened to compact it.
import { assert, assertEquals } from "@std/assert";
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import {
  _resetServerTsForTest,
  loadSnapshot,
} from "../../src/sync/server-store.ts";
import { SYNC_DEFAULTS } from "../../src/sync/types.ts";
import { createTestDb, recordingSocket, until } from "./_test-db.ts";

const CELL = "notes";
const silentLog = { debug: () => {}, warn: () => {}, error: () => {} };

Deno.test("ops flushed through sync-req pendingOps are compacted past compactOps", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    let serverState: Record<string, unknown> = { items: [] };
    const handler = createServerSyncHandler({
      dispatch: (a) => {
        const payload = (a as { payload?: unknown }).payload;
        serverState = {
          items: [...(serverState.items as string[]), payload as string],
        };
      },
      db,
      syncCellIds: [CELL],
      getCellState: () => serverState,
      getClientCellState: () => serverState,
      broadcastRaw: { fn: () => {} },
      log: silentLog,
    });
    const n = SYNC_DEFAULTS.compactOps + 5;
    const now = Date.now();
    const pendingOps = Array.from({ length: n }, (_, i) => ({
      id: `phone-s-${i}`,
      hlc: [now, i, "phone"],
      cell: CELL,
      action: "add",
      payload: `p${i}`,
    }));
    assertEquals(pendingOps.length, n);
    const { socket, frames } = recordingSocket();
    handler.handleSync(
      { clientId: "phone", session: "s", cells: {}, pendingOps },
      { id: "phone" },
      socket,
    );
    await until(() => frames.some((f) => f.t === "sync-res"), "sync response");
    assertEquals(frames.filter((f) => f.t === "sync-ack").length, n);
    assertEquals((serverState.items as string[]).length, n);

    const { rows } = await db.query<{ count: number }>(
      "SELECT COUNT(*) as count FROM sync_ops WHERE cell = ?",
      [CELL],
    );
    assert(
      rows[0]!.count < SYNC_DEFAULTS.compactOps,
      `the op-log holds ${rows[0]!.count} ops — past compactOps ` +
        `(${SYNC_DEFAULTS.compactOps}) and never folded`,
    );
    assert(await loadSnapshot(db, CELL), "a compaction snapshot was written");
  } finally {
    close();
  }
});
