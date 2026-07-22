// Regression: the cell `access` rule must be enforced on the SYNC-OP path, not
// only the action-dispatch path. A cell that is both `sync: true` and
// `access`-gated would otherwise be freely mutable by any connected client via
// an `op` frame (the sync path uses a different dispatch than the gated one).
import { assert, assertEquals } from "@std/assert";
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
  hlc: [1000, 0, "client-a"] as HLC,
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
