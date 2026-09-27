// A cursor this server issued is never "foreign" — even after the op row at
// its position was deleted.
//
// The foreign-cursor check (see foreign-cursor.test.ts) flags a client cursor
// above the log's high-water mark as a different history. But `server_ts` is
// ONE sequence across all cells, and a refused op's row is DELETEd: a catch-up
// for cell B that reserves its cursor while cell A's soon-refused op is the
// log's maximum hands out that op's position, and once the row is gone the
// durable mark sits BELOW it. The client's next, ordinary catch-up was then
// declared a "different history (restored backup, wiped data dir, or another
// app on this port)": cursor reset, a snapshot, and a false warning.
import { assert, assertEquals } from "@std/assert";
import {
  _resetServerTsForTest,
  reserveServerTs,
} from "../../src/sync/server-store.ts";
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import { createTestDb, recordingSocket, until } from "./_test-db.ts";

Deno.test("sync cursor: a refused op's deleted row does not make a live client's cursor foreign", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  const warns: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let dispatched = false;
  const state: Record<string, Record<string, unknown>> = {
    a: { n: 0 },
    b: { n: 0 },
  };
  const handler = createServerSyncHandler({
    dispatch: async (act) => {
      if (act.type === "a:bad") {
        dispatched = true;
        await gate; // the method is still running…
        throw new Error("validation failed"); // …and then refuses
      }
    },
    db,
    syncCellIds: ["a", "b"],
    getCellState: (c) => state[c]!,
    getClientCellState: (c) => state[c]!,
    broadcastRaw: { fn: () => {} },
    log: { debug: () => {}, warn: (m) => warns.push(m), error: () => {} },
  });
  const writer = recordingSocket();
  const reader = recordingSocket();
  try {
    // Writer's op on cell A: persisted (the log's new maximum), dispatch
    // still running.
    const opDone = handler.handleOp(
      {
        id: "w1-s1-1.abc",
        hlc: [Date.now(), 0, "w1"],
        cell: "a",
        action: "bad",
        payload: { args: [] },
      },
      { id: "writer" },
      writer.socket,
    );
    await until(() => dispatched, "the op reached dispatch");

    // Reader catches up on cell B meanwhile — its cursor is the global max.
    handler.handleSync(
      {
        clientId: "r1",
        session: "s9",
        reqId: 1,
        cells: { b: { lastHlc: null } },
        pendingOps: [],
      },
      { id: "reader" },
      reader.socket,
    );
    await until(() => reader.frames.some((f) => f.t === "sync-res"));
    const res1 = reader.frames.find((f) => f.t === "sync-res")!;
    const cursor = (res1.d.lastServerTs as Record<string, number>).b!;
    assert(cursor > 0, "precondition: reader got a cursor for b");

    // A's op is refused → its row is deleted.
    release();
    await opDone;
    assert(
      writer.frames.some((f) => f.t === "op-rejected"),
      "precondition: the op was refused",
    );
    assert(
      (await reserveServerTs(db)) < cursor,
      "precondition: the durable mark fell below the issued cursor",
    );

    // The reader's next ordinary catch-up, with the cursor THIS server issued.
    reader.frames.length = 0;
    handler.handleSync(
      {
        clientId: "r1",
        session: "s9",
        reqId: 2,
        cells: { b: { lastHlc: null, lastServerTs: cursor } },
        pendingOps: [],
      },
      { id: "reader" },
      reader.socket,
    );
    await until(() => reader.frames.some((f) => f.t === "sync-res"));
    const res2 = reader.frames.find((f) => f.t === "sync-res")!;
    assertEquals(
      res2.d.reset,
      undefined,
      "the server declared a cursor it issued itself 'foreign' and reset it",
    );
    assertEquals(
      res2.d.mode,
      "incremental",
      "served from the log, no snapshot",
    );
    assertEquals(
      warns.filter((w) => w.includes("different history")),
      [],
      "false 'restored backup / wiped data dir' warning",
    );
  } finally {
    close();
    _resetServerTsForTest();
  }
});
