// tests/sync/clock-drift.test.ts — M5.
//
// `HLClock.receive` refuses to follow a remote clock more than `maxDrift`
// ahead, which protects the LOCAL clock — and nothing else. The drifted op was
// still persisted, dispatched, broadcast and stored with its future HLC, so
// every LWW comparison against it lost for the whole drift window: one machine
// with a wrong clock quietly won every conflict, everywhere, for as long as the
// skew lasted, and no one could see why.
//
// DECISION: refuse it, loudly, at the server.
//   - The server is the convergence authority and the only place one decision
//     binds every replica. CLAMPING would rewrite the HLC of an op the origin
//     (and any peer that already saw it) holds under its original stamp — one
//     op id with two orderings, which is a worse bug than the one being fixed.
//   - It is not silent: the origin gets `op-rejected` naming the skew and the
//     remedy, its optimistic view rolls back and `sync.onRejected` fires.
//   - Only the FUTURE direction is refused. An op stamped in the PAST is the
//     offline queue working as designed (retention defaults to 4h), and it
//     loses LWW on merit.
import { assert, assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import { _resetServerTsForTest } from "../../src/sync/server-store.ts";
import { SYNC_DEFAULTS } from "../../src/sync/types.ts";
import type { HLC } from "../../src/sync/types.ts";
import { createTestDb, recordingSocket, until } from "./_test-db.ts";

const CELL = "doc";
const silent = { debug: () => {}, warn: () => {}, error: () => {} };

function makeHandler(db: ReturnType<typeof createTestDb>["db"]) {
  let dispatched = 0;
  const handler = createServerSyncHandler({
    dispatch: () => {
      dispatched++;
    },
    db,
    syncCellIds: [CELL],
    getCellState: () => ({}),
    getClientCellState: () => ({}),
    broadcastRaw: { fn: () => {} },
    log: silent,
  });
  return { handler, dispatched: () => dispatched };
}

const opAt = (id: string, physical: number) => ({
  id,
  hlc: [physical, 0, "c1"] as HLC,
  cell: CELL,
  action: "set",
  payload: { v: 1 },
});

Deno.test("M5: an op stamped beyond maxDrift in the FUTURE is refused, never persisted", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    const { handler, dispatched } = makeHandler(db);
    const { socket, frames } = recordingSocket();
    const future = Date.now() + SYNC_DEFAULTS.maxDrift + 60_000;
    await handler.handleOp(opAt("drifted", future), { id: "s1" }, socket);

    assertEquals(dispatched(), 0, "a drifted op must not reach live state");
    assert(
      !frames.some((f) => f.t === "sync-ack"),
      "a refused op must not be acked",
    );
    const rejected = frames.find((f) => f.t === "op-rejected");
    assert(
      rejected,
      `expected op-rejected, got ${JSON.stringify(frames.map((f) => f.t))}`,
    );
    const reason = String(rejected.d.reason);
    assert(
      /clock/i.test(reason) && /ahead/.test(reason),
      `the reason must name the drift — got "${reason}"`,
    );
    assert(
      /time|clock/i.test(reason) && /(sync|set|correct)/i.test(reason),
      `the reason must name the fix — got "${reason}"`,
    );
    assertEquals(
      (await db.query("SELECT id FROM sync_ops")).rows.length,
      0,
      "a drifted op must never enter the log — every later LWW would lose to it",
    );
  } finally {
    close();
  }
});

Deno.test("M5: an op stamped in the PAST is accepted — that is the offline queue", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    const { handler, dispatched } = makeHandler(db);
    const { socket, frames } = recordingSocket();
    // Four hours old: the default offline retention. Refusing this would break
    // offline-first entirely.
    await handler.handleOp(
      opAt("queued", Date.now() - 4 * 3600_000),
      { id: "s1" },
      socket,
    );
    assertEquals(dispatched(), 1);
    assert(frames.some((f) => f.t === "sync-ack" && f.d.opId === "queued"));
  } finally {
    close();
  }
});

Deno.test("M5: a drifted op in a reconnect's pending queue is refused too", async () => {
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  try {
    const { handler, dispatched } = makeHandler(db);
    const { socket, frames } = recordingSocket();
    const future = Date.now() + SYNC_DEFAULTS.maxDrift + 60_000;
    handler.handleSync(
      {
        clientId: "c1",
        cells: { [CELL]: { lastHlc: null } },
        pendingOps: [{ ...opAt("drifted-pending", future), confirmed: false }],
      },
      { id: "s1" },
      socket,
    );
    await until(() => frames.some((f) => f.t === "sync-res"), "sync response");
    assertEquals(dispatched(), 0);
    assert(
      frames.some((f) =>
        f.t === "op-rejected" && f.d.opId === "drifted-pending"
      ),
      "the client must hear about it, or it re-sends this op forever",
    );
    assertEquals((await db.query("SELECT id FROM sync_ops")).rows.length, 0);
  } finally {
    close();
  }
});

Deno.test("M5: a refusal is FINAL — the same op re-sent later is refused again", async () => {
  // The drift check reads the SERVER's wall clock, and that moves. The same
  // op, delivered again a few minutes later (a duplicate still in flight, or
  // the pending buffer of a `sync-req` that was already on the wire when the
  // rejection went out), then measures under the limit — and used to be
  // ACCEPTED, persisted, dispatched and broadcast to every peer. Its origin
  // had already been told the change was refused: `sync.onRejected` fired, the
  // optimistic view rolled back, the op was pruned. The change existed
  // everywhere except on the client that made it, and nothing said so.
  //
  // D11 promises a DECISION, not a reading. The refusal sticks to the op id.
  // (Found by the chaos suite, seed 724, 2026-08-27.)
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  const time = new FakeTime();
  try {
    const { handler, dispatched } = makeHandler(db);
    const { socket, frames } = recordingSocket();
    const future = Date.now() + SYNC_DEFAULTS.maxDrift + 60_000;
    await handler.handleOp(opAt("drifted", future), { id: "s1" }, socket);
    assertEquals(dispatched(), 0, "the first delivery is refused");

    // The server's clock walks past the op's stamp.
    time.tick(10 * 60_000);
    assert(
      future - Date.now() <= SYNC_DEFAULTS.maxDrift,
      "precondition: the op now measures INSIDE the drift limit",
    );

    await handler.handleOp(opAt("drifted", future), { id: "s1" }, socket);

    assertEquals(dispatched(), 0, "a refused op must stay refused");
    assertEquals(
      (await db.query("SELECT id FROM sync_ops")).rows.length,
      0,
      "a refused op must never reach the log on a later delivery either",
    );
    assert(
      !frames.some((f) => f.t === "sync-ack"),
      "a refused op must never be acked",
    );
    assertEquals(
      frames.filter((f) => f.t === "op-rejected").length,
      2,
      "every delivery of a refused op is answered with the same refusal",
    );
    assertEquals(
      String(frames[0]!.d.reason),
      String(frames[1]!.d.reason),
      "the re-refusal must state the ORIGINAL reason, not a drift that has " +
        "since shrunk to nothing",
    );
  } finally {
    time.restore();
    close();
  }
});

Deno.test("M5: a refused op in a LATER reconnect's pending queue is refused again", async () => {
  // The same stickiness on the path that actually carries a resend: the client
  // never heard the first rejection (the connection died), so its whole
  // pending buffer comes back on the next `sync-req`.
  _resetServerTsForTest();
  const { db, close } = createTestDb();
  const time = new FakeTime();
  try {
    const { handler, dispatched } = makeHandler(db);
    const { socket, frames } = recordingSocket();
    const future = Date.now() + SYNC_DEFAULTS.maxDrift + 60_000;
    await handler.handleOp(opAt("drifted", future), { id: "s1" }, socket);
    time.tick(10 * 60_000);

    handler.handleSync(
      {
        clientId: "c1",
        cells: { [CELL]: { lastHlc: null } },
        pendingOps: [{ ...opAt("drifted", future), confirmed: false }],
      },
      { id: "s1" },
      socket,
    );
    // `handleSync` is fire-and-forget over resolved DB promises — drain the
    // microtask queue rather than a timer, which FakeTime owns here.
    for (let i = 0; i < 200; i++) await Promise.resolve();
    assert(
      frames.some((f) => f.t === "sync-res"),
      "precondition: the sync round completed",
    );

    assertEquals(dispatched(), 0);
    assertEquals((await db.query("SELECT id FROM sync_ops")).rows.length, 0);
    assertEquals(frames.filter((f) => f.t === "op-rejected").length, 2);
  } finally {
    time.restore();
    close();
  }
});
