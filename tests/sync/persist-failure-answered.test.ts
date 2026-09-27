// An op whose persist FAILS must be answered on the live connection.
//
// Both persist sites (the `op` frame and each `sync-req.pendingOps` entry)
// used to log `failed to persist …` server-side and return with "client will
// retry". But the client engine has no ack timeout on an open connection —
// its re-send triggers are engine boot, offline→online, a `sync-err` frame and
// the catch-up watchdog (armed only behind a held frame) — so the op sat
// "pending" until some unrelated reconnect and the app had nothing to show.
// D11: the origin is always told. The answer is `sync-err`, which the client
// already meets with a re-request carrying the still-pending op.
import { assert, assertEquals } from "@std/assert";
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import { createTestDb } from "./_test-db.ts";
import type { DB } from "../../src/db/types.ts";

const CELL = "notes";
type Frame = { t: string; d: Record<string, unknown> };

function setup() {
  const { db, close } = createTestDb();
  // The op-log INSERT fails (disk full / SQLITE_BUSY / I/O error).
  const failing: DB = {
    ...db,
    execute: (sql: string, params?: unknown[]) =>
      /INSERT OR IGNORE INTO sync_ops/.test(sql)
        ? Promise.reject(new Error("SQLITE_FULL: database or disk is full"))
        : db.execute(sql, params),
  };
  const frames: Frame[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: (m: string) => frames.push(JSON.parse(m)),
  } as unknown as WebSocket;
  const errors: string[] = [];
  const dispatched: unknown[] = [];
  const handler = createServerSyncHandler({
    dispatch: (a) => {
      dispatched.push(a);
    },
    db: failing,
    syncCellIds: [CELL],
    getCellState: () => ({ items: [] }),
    getClientCellState: () => ({ items: [] }),
    broadcastRaw: { fn: () => {} },
    log: { debug: () => {}, warn: () => {}, error: (m) => errors.push(m) },
  });
  return { handler, socket, frames, errors, dispatched, close };
}

Deno.test("sync handleOp: a persist failure is answered with sync-err, not silence", async () => {
  const { handler, socket, frames, errors, dispatched, close } = setup();
  try {
    const opId = "c1-s1-1.abcdef123456";
    await handler.handleOp(
      {
        id: opId,
        cell: CELL,
        action: "add",
        payload: { args: ["x"] },
        hlc: [Date.now(), 0, "c1"],
      },
      { id: "c1" },
      socket,
    );
    assert(
      errors.some((e) => e.includes("failed to persist op")),
      `precondition: persist should have failed: ${JSON.stringify(errors)}`,
    );
    const errs = frames.filter((f) => f.t === "sync-err");
    assertEquals(
      errs.length,
      1,
      `the origin must be told on the live connection — frames: ${
        JSON.stringify(frames)
      }`,
    );
    // The reason names the cell; the storage error (paths, schema) stays in
    // the server log.
    assert(
      String(errs[0]!.d.reason).includes(`"${CELL}"`),
      `the reason names the cell: ${JSON.stringify(errs[0])}`,
    );
    assert(
      !String(errs[0]!.d.reason).includes("SQLITE_FULL"),
      `raw storage error leaked to the client: ${JSON.stringify(errs[0])}`,
    );
    assert(
      errors.some((e) => e.includes("SQLITE_FULL")),
      "server log keeps it",
    );
    // Not acked, not refused, not applied: the op stays pending for the resend.
    assertEquals(
      frames.filter((f) => f.t === "sync-ack" || f.t === "op-rejected"),
      [],
    );
    assertEquals(dispatched, []);
  } finally {
    close();
  }
});

// ONE `sync-err` per request, however many of its pending ops failed. One
// frame already makes the client re-send the whole queue; a frame PER op made
// a client built before its single retry timer (≤1.0.9, a cached bundle) run
// one retry loop per frame — each loop re-sending the queue, each resend
// failing per op again: P loops, then P², for as long as the disk stayed full.
// The `sayHeld` door was closed for this; the persist-failure door was not.
Deno.test("sync-req pendingOps: several persist failures in one request are answered with ONE sync-err", async () => {
  const { handler, socket, frames, errors, close } = setup();
  try {
    handler.handleSync(
      {
        clientId: "c1",
        session: "s1",
        cells: { [CELL]: { lastHlc: null } },
        pendingOps: [1, 2, 3].map((i) => ({
          id: `c1-s1-${i}.abcdef12345${i}`,
          cell: CELL,
          action: "add",
          payload: { args: [`x${i}`] },
          hlc: [Date.now(), i, "c1"],
        })),
      },
      { id: "c1" },
      socket,
    );
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(
      errors.filter((e) => e.includes("failed to persist pending op")).length,
      3,
      "each failure stays in the server log",
    );
    assertEquals(
      frames.filter((f) => f.t === "sync-err").length,
      1,
      `one frame per request — frames: ${JSON.stringify(frames)}`,
    );
  } finally {
    close();
  }
});

Deno.test("sync-req pendingOps: a persist failure is answered with sync-err, not silence", async () => {
  const { handler, socket, frames, errors, dispatched, close } = setup();
  try {
    const opId = "c1-s1-2.abcdef123456";
    handler.handleSync(
      {
        clientId: "c1",
        session: "s1",
        cells: { [CELL]: { lastHlc: null } },
        pendingOps: [{
          id: opId,
          cell: CELL,
          action: "add",
          payload: { args: ["x"] },
          hlc: [Date.now(), 0, "c1"],
        }],
      },
      { id: "c1" },
      socket,
    );
    await new Promise((r) => setTimeout(r, 50));
    assert(
      errors.some((e) => e.includes("failed to persist pending op")),
      `precondition: persist should have failed: ${JSON.stringify(errors)}`,
    );
    const errs = frames.filter((f) => f.t === "sync-err");
    assertEquals(
      errs.length,
      1,
      `the origin must be told — frames: ${JSON.stringify(frames)}`,
    );
    assert(
      !String(errs[0]!.d.reason).includes("SQLITE_FULL"),
      `raw storage error leaked to the client: ${JSON.stringify(errs[0])}`,
    );
    assertEquals(
      frames.filter((f) => f.t === "sync-ack" || f.t === "op-rejected"),
      [],
    );
    assertEquals(dispatched, []);
  } finally {
    close();
  }
});
