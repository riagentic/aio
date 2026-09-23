// Held — never refused — when the server is not taking input: the two layers
// of it, each pinned alone (the end-to-end outcome is in
// tests/sync-held-while-not-taking-input.test.ts).
//
//  1. The check runs UNDER the cell lock, right before the persist: an op
//     that passed the door while another held the lock meets a pause (or a
//     shutdown) that began meanwhile here — not at dispatch.
//  2. The backstop: dispatch refusing an op because it is not taking input
//     (DISPATCH_CLOSED / DISPATCH_DRAINING) holds it — `sync-err`, its row
//     out of the log, no `op-rejected`, no remembered refusal.
import { assert, assertEquals } from "@std/assert";
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import { _resetServerTsForTest } from "../../src/sync/server-store.ts";
import { createAioError } from "../../src/diagnostics/error.ts";
import { createTestDb, recordingSocket } from "./_test-db.ts";

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };
const op = (id: string) => ({
  id,
  hlc: [Date.now(), 0, "c1"] as [number, number, string],
  cell: "c",
  action: "add",
  payload: { args: [id] },
});
const rows = async (db: ReturnType<typeof createTestDb>["db"]) =>
  (await db.query<{ id: string }>("SELECT id FROM sync_ops")).rows.map((r) =>
    r.id
  );

Deno.test("sync held: an op queued on the lock meets a pause that began meanwhile before its persist", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    let held: string | undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const dispatched: string[] = [];
    const handler = createServerSyncHandler({
      dispatch: async (a) => {
        dispatched.push(a.type);
        if (dispatched.length === 1) await gate; // the first op holds the lock
      },
      heldBecause: () => held,
      db,
      syncCellIds: ["c"],
      getCellState: () => ({}),
      getClientCellState: () => ({}),
      broadcastRaw: { fn: () => {} },
      log: silentLog,
    });
    const { socket, frames } = recordingSocket();
    const first = handler.handleOp(op("a"), { id: "c1" }, socket);
    await new Promise((r) => setTimeout(r, 10));
    const second = handler.handleOp(op("b"), { id: "c1" }, socket); // past the door
    await new Promise((r) => setTimeout(r, 10));
    held = "paused";
    release();
    await Promise.all([first, second]);
    assertEquals(dispatched.length, 1, "b never reached dispatch");
    assertEquals(frames.filter((f) => f.t === "op-rejected"), []);
    assert(frames.some((f) => f.t === "sync-err"), JSON.stringify(frames));
    assertEquals(await rows(db), ["a"], "b was never persisted");
  } finally {
    close();
  }
});

Deno.test("sync held: dispatch refusing for not taking input holds the op — no refusal, no row", async () => {
  for (const code of ["DISPATCH_CLOSED", "DISPATCH_DRAINING"] as const) {
    _resetServerTsForTest();
    const { db, close } = createTestDb();
    try {
      let closed = true;
      const handler = createServerSyncHandler({
        dispatch: () =>
          closed
            ? Promise.reject(
              createAioError(code as "DISPATCH_CLOSED", "no", {}),
            )
            : undefined,
        db,
        syncCellIds: ["c"],
        getCellState: () => ({}),
        getClientCellState: () => ({}),
        broadcastRaw: { fn: () => {} },
        log: silentLog,
      });
      const { socket, frames } = recordingSocket();
      await handler.handleOp(op("a"), { id: "c1" }, socket);
      assertEquals(frames.filter((f) => f.t === "op-rejected"), [], code);
      assert(frames.some((f) => f.t === "sync-err"), code);
      assertEquals(await rows(db), [], `${code}: the row is out of the log`);
      // The resend lands — nothing remembered it as refused.
      closed = false;
      frames.length = 0;
      await handler.handleOp(op("a"), { id: "c1" }, socket);
      assert(frames.some((f) => f.t === "sync-ack"), JSON.stringify(frames));
      // …and so does the pending-op path (a reconnect's catch-up).
      closed = true;
      frames.length = 0;
      handler.handleSync(
        {
          clientId: "c1",
          reqId: 1,
          cells: { c: { lastHlc: null } },
          pendingOps: [op("p")],
        },
        { id: "c1" },
        socket,
      );
      await new Promise((r) => setTimeout(r, 30));
      assertEquals(frames.filter((f) => f.t === "op-rejected"), [], code);
      assert(frames.some((f) => f.t === "sync-err"), code);
      assertEquals(frames.filter((f) => f.t === "sync-res"), [], "held whole");
      assertEquals(await rows(db), ["a"]);
    } finally {
      close();
    }
  }
});

Deno.test("sync held: one held sync-err per socket until it asks again — an old client's retry-loop-per-frame stays ONE loop", async () => {
  // A v1.0.9 client (a cached bundle after a deploy) starts a retry loop on
  // EVERY sync-err it receives; each loop re-sends the whole queue. Modelled
  // here as what it is: one loop per sync-err frame.
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    let held: string | undefined = "paused";
    const handler = createServerSyncHandler({
      dispatch: () => {},
      heldBecause: () => held,
      db,
      syncCellIds: ["c"],
      getCellState: () => ({}),
      getClientCellState: () => ({}),
      broadcastRaw: { fn: () => {} },
      log: silentLog,
    });
    const { socket, frames } = recordingSocket();
    const loops = () => frames.filter((f) => f.t === "sync-err").length;
    for (let i = 0; i < 10; i++) {
      await handler.handleOp(op("o" + i), { id: "c1" }, socket);
    }
    assertEquals(loops(), 1, "10 held op frames, one retry loop");
    // The loop's retry (a sync-req with the queue) is answered — once.
    const retry = () =>
      handler.handleSync(
        {
          clientId: "c1",
          reqId: 1,
          cells: { c: { lastHlc: null } },
          pendingOps: [op("o0")],
        },
        { id: "c1" },
        socket,
      );
    retry();
    retry();
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(loops(), 3, "each ask gets its answer");
    // Another socket is its own client.
    const other = recordingSocket();
    await handler.handleOp(op("x"), { id: "c2" }, other.socket);
    assertEquals(other.frames.filter((f) => f.t === "sync-err").length, 1);
    // Taking input again, then held again: said again (the flag is cleared
    // by the accepted op, or the client would never hear of the new hold).
    held = undefined;
    await handler.handleOp(op("y"), { id: "c1" }, socket);
    held = "paused";
    await handler.handleOp(op("z"), { id: "c1" }, socket);
    assertEquals(loops(), 4);
  } finally {
    close();
  }
});
