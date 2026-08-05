// tests/sync/compaction-boundary.test.ts — what the compaction snapshot
// CONTAINS and what compaction DELETES must be the same set.
//
// The snapshot is live state: every op the server has applied. The DELETE used
// a different decider — the server's own HLC — and an op can be applied while
// sitting ABOVE that mark, because `HLClock.receive` deliberately refuses to
// follow a remote clock more than `maxDrift` ahead (otherwise one bad clock
// hijacks causal order for everyone). A client whose wall clock is a few
// minutes fast is enough.
//
// Such an op is folded into the snapshot AND left in the log, so the boot
// replay (snapshot + surviving ops — see aio-boot's replaySyncOps) applies it
// twice. And it compounds: the next compaction snapshots the doubled state
// while the op still survives, so every restart adds another copy.
import { assertEquals } from "@std/assert";
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import {
  _resetServerTsForTest,
  loadOpsSince,
  loadSnapshot,
} from "../../src/sync/server-store.ts";
import { SYNC_DEFAULTS } from "../../src/sync/types.ts";
import type { HLC } from "../../src/sync/types.ts";
import { createTestDb, recordingSocket, until } from "./_test-db.ts";

const CELL = "notes";
const silentLog = { debug: () => {}, warn: () => {}, error: () => {} };

const reduce = (
  s: Record<string, unknown>,
  payload: unknown,
): Record<string, unknown> => ({
  items: [...(s.items as string[] ?? []), payload as string],
});

/** The boot path: seed from the compaction snapshot, fold the surviving log. */
async function bootReplay(
  db: ReturnType<typeof createTestDb>["db"],
): Promise<Record<string, unknown>> {
  let state: Record<string, unknown> = { items: [] };
  const snap = await loadSnapshot(db, CELL);
  if (snap) state = snap.state;
  for (const op of await loadOpsSince(db, CELL, null, null)) {
    state = reduce(state, op.payload);
  }
  return state;
}

Deno.test("an op from a fast-clocked client is compacted with the rest", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    let live: Record<string, unknown> = { items: [] };
    const handler = createServerSyncHandler({
      dispatch: (a) => {
        live = reduce(live, (a as { payload: unknown }).payload);
      },
      db,
      syncCellIds: [CELL],
      getCellState: () => live,
      getClientCellState: () => live,
      broadcastRaw: { fn: () => {} },
      log: silentLog,
    });
    const { socket, frames } = recordingSocket();

    // A normal op, and one from a client whose clock runs far ahead — beyond
    // maxDrift, so the server refuses to follow it forward.
    const ahead = Date.now() + 10 * SYNC_DEFAULTS.maxDrift;
    await handler.handleOp(
      {
        id: "a",
        hlc: [Date.now(), 0, "ok"] as HLC,
        cell: CELL,
        action: "add",
        payload: "a",
      },
      { id: "c" },
      socket,
    );
    await handler.handleOp(
      {
        id: "b",
        hlc: [ahead, 0, "fast"] as HLC,
        cell: CELL,
        action: "add",
        payload: "b",
      },
      { id: "c" },
      socket,
    );
    await until(
      () => frames.filter((f) => f.t === "sync-ack").length >= 2,
      "both ops acked",
    );
    assertEquals(live.items, ["a", "b"], "both applied to live state");

    // Compaction folds live state into the snapshot and rolls the log over.
    handler.noteServerWrite(CELL);
    await handler.flushServerWrites();

    assertEquals(
      await bootReplay(db),
      live,
      "a restart must reproduce live state exactly — an op that is in the " +
        "snapshot AND still in the log is applied twice, and compounds on " +
        "every further restart",
    );

    // …and it must not come back on the next restart either.
    handler.noteServerWrite(CELL);
    await handler.flushServerWrites();
    assertEquals(await bootReplay(db), live, "still exact after a second fold");
  } finally {
    close();
  }
});

Deno.test("compaction leaves nothing behind that the snapshot already holds", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    let live: Record<string, unknown> = { items: [] };
    const handler = createServerSyncHandler({
      dispatch: (a) => {
        live = reduce(live, (a as { payload: unknown }).payload);
      },
      db,
      syncCellIds: [CELL],
      getCellState: () => live,
      getClientCellState: () => live,
      broadcastRaw: { fn: () => {} },
      log: silentLog,
    });
    const { socket, frames } = recordingSocket();

    // Mixed clocks: behind, on time, far ahead.
    const now = Date.now();
    const clocks: HLC[] = [
      [now - 5_000, 0, "slow"],
      [now, 0, "ok"],
      [now + 10 * SYNC_DEFAULTS.maxDrift, 3, "fast"],
    ];
    for (let i = 0; i < clocks.length; i++) {
      await handler.handleOp(
        {
          id: `op${i}`,
          hlc: clocks[i]!,
          cell: CELL,
          action: "add",
          payload: `p${i}`,
        },
        { id: "c" },
        socket,
      );
    }
    await until(
      () => frames.filter((f) => f.t === "sync-ack").length >= clocks.length,
      "all acked",
    );

    handler.noteServerWrite(CELL);
    await handler.flushServerWrites();

    const left = await loadOpsSince(db, CELL, null, null);
    assertEquals(
      left.map((o) => o.id),
      [],
      "every op the snapshot contains must be gone from the log, whatever " +
        "HLC its author stamped it with",
    );
    assertEquals(await bootReplay(db), live);
  } finally {
    close();
  }
});
