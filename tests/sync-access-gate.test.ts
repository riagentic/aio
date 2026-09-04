// Regression: the cell `access` rule must be enforced on the SYNC-OP path, not
// only the action-dispatch path. A cell that is both `sync: true` and
// `access`-gated would otherwise be freely mutable by any connected client via
// an `op` frame (the sync path uses a different dispatch than the gated one).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import type { DB, QueryResult, Tx } from "../src/db/types.ts";
import { SYNC_SCHEMA } from "../src/sync/compact.ts";
import { createServerSyncHandler } from "../src/sync/server-handler.ts";
import { cellAccessAllowed } from "../src/server/server-auth.ts";
import type { HLC } from "../src/sync/types.ts";

// deno-lint-ignore no-explicit-any
const _p = (v: unknown[]): any[] => v;
function createTestDb(): DB {
  const sqlite = new DatabaseSync(":memory:");
  for (const stmt of SYNC_SCHEMA) sqlite.exec(stmt);
  const query = <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) =>
    Promise.resolve({
      rows: sqlite.prepare(sql).all(..._p(params ?? [])) as T[],
      changes: 0,
      lastInsertRowId: 0n,
    } as QueryResult<T>);
  const execute = (sql: string, params?: unknown[]) => {
    const r = sqlite.prepare(sql).run(..._p(params ?? []));
    return Promise.resolve({
      rows: [],
      changes: Number(r.changes),
      lastInsertRowId: BigInt(r.lastInsertRowid),
    } as QueryResult);
  };
  const transaction = (async (arg: unknown) => {
    if (typeof arg === "function") {
      return await (arg as (tx: Tx) => Promise<unknown>)({ query, execute });
    }
    const out: QueryResult[] = [];
    for (const s of arg as { sql: string; params?: unknown[] }[]) {
      out.push(await execute(s.sql, s.params));
    }
    return out;
    // deno-lint-ignore no-explicit-any
  }) as any;
  return { query, execute, transaction, close: () => Promise.resolve() };
}

const opFrame = (id: string, cell: string) => ({
  id,
  // Stamped NOW — an unknown op stamped older than the tombstone window is
  // refused by name (`STALE_OP_REASON`); this fixture is not about age.
  hlc: [Date.now(), 0, "client-a"] as HLC,
  cell,
  action: "add",
  payload: { text: "x" },
});

function harness(db: DB) {
  const dispatched: { type: string; user: unknown }[] = [];
  const sent: Record<string, unknown>[] = [];
  // admin-only cell "vault"; open cell "notes".
  const rules = new Map<string, "admin">([["vault", "admin"]]);
  const handler = createServerSyncHandler({
    dispatch: (a) => dispatched.push({ type: a.type, user: a._user }),
    db,
    syncCellIds: ["vault", "notes"],
    accessCheck: (cell, user) => {
      const rule = rules.get(cell);
      return rule === undefined ||
        cellAccessAllowed(rule, user as never, "sync");
    },
    getCellState: () => ({ items: [] }),
    getClientCellState: () => ({ items: [] }),
    broadcastRaw: { fn: () => {} },
    log: { debug: () => {}, warn: () => {}, error: () => {} },
  });
  const socket = {
    send: (m: string) => sent.push(JSON.parse(m)),
  } as unknown as WebSocket;
  return { handler, socket, dispatched, sent };
}

Deno.test("sync op: access-gated cell rejects an unauthorized user's op", async () => {
  const h = harness(createTestDb());
  await h.handler.handleOp(opFrame("op1", "vault"), {
    id: "c1",
    user: { id: "eve", role: "viewer" },
  }, h.socket);
  assertEquals(h.dispatched.length, 0, "denied op must not dispatch");
  const rejected = h.sent.find((m) => m.t === "op-rejected");
  assert(rejected, "client is told the op was rejected");
  assertEquals(
    (rejected!.d as { reason: string }).reason,
    "access denied",
  );
});

Deno.test("sync op: admin passes the gate and dispatch carries the identity", async () => {
  const h = harness(createTestDb());
  await h.handler.handleOp(opFrame("op2", "vault"), {
    id: "c2",
    user: { id: "root", role: "admin" },
  }, h.socket);
  assertEquals(h.dispatched.length, 1, "admin op dispatches");
  assertEquals(h.dispatched[0]!.type, "vault:add");
  assertEquals(
    (h.dispatched[0]!.user as { id: string }).id,
    "root",
    "sync dispatch tags the trusted _user (serverUser/beforeReduce see it)",
  );
});

Deno.test("sync op: un-gated cell is unaffected by the access check", async () => {
  const h = harness(createTestDb());
  await h.handler.handleOp(opFrame("op3", "notes"), {
    id: "c3",
    user: { id: "eve", role: "viewer" },
  }, h.socket);
  assertEquals(h.dispatched.length, 1, "open cell still accepts ops");
  assertEquals(h.dispatched[0]!.type, "notes:add");
});

// ── The reconnect-flush path carries the same two guarantees ──────────
//
// `handleSync`'s pending-ops loop is `handleOp` minus two safety checks, and it
// is the path that carries the STALEST ops — the ones queued while offline, so
// the ones most likely to fail validation or hit a permission that changed
// while the client was away. It was the least likely to say so.

/** `handleSync` deliberately returns void and does its work in a detached
 *  async IIFE (it is a socket message handler), so a test polls for the frame
 *  instead of awaiting the call. */
async function until(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const syncFrame = (ops: unknown[]) => ({
  clientId: "client-a",
  cells: {},
  pendingOps: ops,
});

Deno.test("sync pending op: a denied op is REPORTED, not silently dropped", async () => {
  const h = harness(createTestDb());
  await h.handler.handleSync(
    syncFrame([opFrame("p1", "vault")]),
    { id: "c1", user: { id: "eve", role: "viewer" } },
    h.socket,
  );
  await until(
    () => h.sent.some((m) => m.t === "op-rejected"),
    "the op-rejected frame",
  );
  assertEquals(h.dispatched.length, 0, "denied op must not dispatch");
  const rejected = h.sent.find((m) => m.t === "op-rejected");
  assert(
    rejected,
    "without this frame the client keeps the op pending forever and " +
      "re-sends it on every reconnect",
  );
  assertEquals((rejected!.d as { opId: string }).opId, "p1");
  assertEquals((rejected!.d as { reason: string }).reason, "access denied");
});

Deno.test("sync pending op: a validate-rejected op is deleted, not broadcast or acked", async () => {
  const { recordRejection } = await import(
    "../src/state/rejection-tracker.ts"
  );
  const db = createTestDb();
  const broadcast: unknown[] = [];
  const sent: Record<string, unknown>[] = [];
  const handler = createServerSyncHandler({
    // The validate hook refuses this op — exactly what the reducer records.
    dispatch: (a) =>
      recordRejection(a, {
        cell: String(a.type).split(":")[0]!,
        reason: "validate: quantity must be positive",
      }),
    db,
    syncCellIds: ["notes"],
    getCellState: () => ({ items: [] }),
    getClientCellState: () => ({ items: [] }),
    broadcastRaw: { fn: (m: unknown) => broadcast.push(m) },
    log: { debug: () => {}, warn: () => {}, error: () => {} },
  });
  const socket = {
    send: (m: string) => sent.push(JSON.parse(m)),
  } as unknown as WebSocket;

  await handler.handleSync(
    syncFrame([opFrame("p2", "notes")]),
    { id: "c2", user: undefined },
    socket,
  );

  await until(
    () => sent.some((m) => m.t === "op-rejected"),
    "the op-rejected frame",
  );
  assertEquals(broadcast.length, 0, "peers must not receive a refused op");
  assertEquals(
    sent.filter((m) => m.t === "sync-ack").length,
    0,
    "the origin must not be told its refused op was accepted",
  );
  const rejected = sent.find((m) => m.t === "op-rejected");
  assert(rejected, "the origin is told WHY (D11)");
  assertEquals(
    (rejected!.d as { reason: string }).reason,
    "validate: quantity must be positive",
  );
  // …and it is gone from the log, so a boot replay cannot resurrect it.
  const rows = await db.query("SELECT id FROM sync_ops WHERE id = ?", ["p2"]);
  assertEquals(rows.rows.length, 0, "the poison op is deleted from the log");
});

// a REDUCER THROW is not a validate refusal, and the two were handled
// asymmetrically. `dispatch` reports failure by rejecting its promise, so the
// un-awaited call's try/catch caught nothing: the op was persisted, ACKED (the
// origin marked it confirmed), BROADCAST (peers applied it) and then compacted
// — and compaction snapshots live state, which never received the effect,
// while deleting the op row. The write survived everywhere except on the
// server that owns the truth.
Deno.test("sync op: a dispatch that fails is not acked, broadcast or kept", async () => {
  const db = createTestDb();
  const broadcast: unknown[] = [];
  const sent: Record<string, unknown>[] = [];
  const handler = createServerSyncHandler({
    dispatch: () => Promise.reject(new Error("REDUCE_ERROR: boom")),
    db,
    syncCellIds: ["notes"],
    getCellState: () => ({ items: [] }),
    getClientCellState: () => ({ items: [] }),
    broadcastRaw: { fn: (m: unknown) => broadcast.push(m) },
    log: { debug: () => {}, warn: () => {}, error: () => {} },
  });
  const socket = {
    send: (m: string) => sent.push(JSON.parse(m)),
  } as unknown as WebSocket;

  await handler.handleOp(opFrame("d1", "notes"), { id: "c1" }, socket);

  assertEquals(
    sent.filter((m) => m.t === "sync-ack").length,
    0,
    "an op the server could not apply must never be acked",
  );
  assertEquals(broadcast.length, 0, "…nor handed to peers");
  const rejected = sent.find((m) => m.t === "op-rejected");
  assert(rejected, "the origin is told the op failed");
  assertStringIncludes(
    String((rejected!.d as { reason: string }).reason),
    "dispatch failed",
  );
  const rows = await db.query("SELECT id FROM sync_ops WHERE id = ?", ["d1"]);
  assertEquals(
    rows.rows.length,
    0,
    "and it is gone from the log, so no boot replay resurrects it",
  );
});

Deno.test("sync pending op: a dispatch that fails is not acked, broadcast or kept", async () => {
  const db = createTestDb();
  const broadcast: unknown[] = [];
  const sent: Record<string, unknown>[] = [];
  const handler = createServerSyncHandler({
    dispatch: () => Promise.reject(new Error("REDUCE_ERROR: boom")),
    db,
    syncCellIds: ["notes"],
    getCellState: () => ({ items: [] }),
    getClientCellState: () => ({ items: [] }),
    broadcastRaw: { fn: (m: unknown) => broadcast.push(m) },
    log: { debug: () => {}, warn: () => {}, error: () => {} },
  });
  const socket = {
    send: (m: string) => sent.push(JSON.parse(m)),
  } as unknown as WebSocket;

  handler.handleSync(syncFrame([opFrame("d2", "notes")]), { id: "c2" }, socket);
  await until(
    () => sent.some((m) => m.t === "op-rejected"),
    "the op-rejected frame",
  );
  assertEquals(sent.filter((m) => m.t === "sync-ack").length, 0);
  assertEquals(broadcast.length, 0);
  const rows = await db.query("SELECT id FROM sync_ops WHERE id = ?", ["d2"]);
  assertEquals(rows.rows.length, 0);
});
