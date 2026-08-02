// the compaction cursor and the delivery cursor were keyed differently.
//
// Compaction DELETES ops by HLC boundary; delivery READS them by `server_ts`.
// The snapshot-vs-incremental decision consulted only `lastHlc` — but a client
// can hold a `lastServerTs` with `lastHlc` still null (the cursor-echo path in
// sync-engine advances the server_ts cursor on a response that delivered zero
// ops). Such a client fell to the incremental branch, asked for ops above its
// cursor, and received nothing: the rows it needed had been compacted away. It
// was told it was up to date while its confirmed state silently diverged.
//
// The fix records the highest server_ts compaction removed (`compacted_ts`) and
// serves a snapshot to any cursor at or below it.
import { assert, assertEquals } from "@std/assert";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import type { DB, QueryResult, Tx } from "../../src/db/types.ts";
import {
  applySyncMigrations,
  compactSyncOps,
  SYNC_SCHEMA,
} from "../../src/sync/compact.ts";
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import { getCompactedTs } from "../../src/sync/server-store.ts";
import type { HLC } from "../../src/sync/types.ts";

// deno-lint-ignore no-explicit-any
const _p = (v: unknown[]): any[] => v;
function createDb(): DB {
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

/** Insert an op row exactly as `persistOp` would. */
async function addOp(
  db: DB,
  id: string,
  hlc: HLC,
  serverTs: number,
): Promise<void> {
  await db.execute(
    `INSERT INTO sync_ops (id, cell, action, payload, hlc_phys, hlc_cnt, hlc_node, server_ts)
     VALUES (?, 'notes', 'add', ?, ?, ?, ?, ?)`,
    [id, JSON.stringify({ text: id }), hlc[0], hlc[1], hlc[2], serverTs],
  );
}

Deno.test("compaction records the server_ts watermark it deleted through", async () => {
  const db = createDb();
  await addOp(db, "o1", [1000, 0, "peer"], 1);
  await addOp(db, "o2", [1000, 1, "peer"], 2);
  await addOp(db, "o3", [9999, 0, "peer"], 3); // above the boundary — survives

  await compactSyncOps({
    db,
    cell: "notes",
    getState: () => ({ items: ["a", "b"] }),
    serverHlc: [1000, 1, "server"], // deletes o1 + o2
    compactOps: 1, // force
    log: { debug: () => {}, warn: () => {}, error: () => {} },
  });

  const left = await db.query<{ id: string }>(
    "SELECT id FROM sync_ops ORDER BY id",
  );
  assertEquals(left.rows.map((r) => r.id), ["o3"], "o1/o2 were compacted away");
  assertEquals(
    await getCompactedTs(db, "notes"),
    2,
    "the watermark is the highest server_ts that no longer exists",
  );
});

Deno.test("a server_ts cursor below the compaction watermark gets a SNAPSHOT", async () => {
  const db = createDb();
  await addOp(db, "o1", [1000, 0, "peer"], 1);
  await addOp(db, "o2", [1000, 1, "peer"], 2);
  await compactSyncOps({
    db,
    cell: "notes",
    getState: () => ({ items: ["a", "b"] }),
    serverHlc: [1000, 1, "server"],
    compactOps: 1,
    log: { debug: () => {}, warn: () => {}, error: () => {} },
  });

  const sent: Record<string, unknown>[] = [];
  const handler = createServerSyncHandler({
    dispatch: () => {},
    db,
    syncCellIds: ["notes"],
    getCellState: () => ({ items: ["a", "b"] }),
    broadcastRaw: { fn: () => {} },
    log: { debug: () => {}, warn: () => {}, error: () => {} },
  });
  const socket = {
    send: (m: string) => sent.push(JSON.parse(m)),
  } as unknown as WebSocket;

  // The exact shape the cursor-echo path leaves behind: a server_ts cursor
  // from a response that delivered nothing, and NO lastHlc.
  handler.handleSync(
    {
      clientId: "idle-client",
      cells: { notes: { lastHlc: null, lastServerTs: 1 } },
      pendingOps: [],
    },
    { id: "c1" },
    socket,
  );

  for (let i = 0; i < 200 && !sent.some((m) => m.t === "sync-res"); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const res = sent.find((m) => m.t === "sync-res");
  assert(res, "a sync response is sent");
  const d = res!.d as { mode: string; snapshot?: Record<string, unknown> };
  assertEquals(
    d.mode,
    "snapshot",
    "the ops this client needs no longer exist — incremental would lie",
  );
  assert(d.snapshot?.notes, "and the snapshot carries the cell's state");
});

Deno.test("a caught-up cursor above the watermark still gets incremental", async () => {
  const db = createDb();
  await addOp(db, "o1", [1000, 0, "peer"], 1);
  await compactSyncOps({
    db,
    cell: "notes",
    getState: () => ({ items: ["a"] }),
    serverHlc: [1000, 0, "server"],
    compactOps: 1,
    log: { debug: () => {}, warn: () => {}, error: () => {} },
  });
  await addOp(db, "o2", [2000, 0, "peer"], 5); // after the compaction

  const sent: Record<string, unknown>[] = [];
  const handler = createServerSyncHandler({
    dispatch: () => {},
    db,
    syncCellIds: ["notes"],
    getCellState: () => ({ items: ["a"] }),
    broadcastRaw: { fn: () => {} },
    log: { debug: () => {}, warn: () => {}, error: () => {} },
  });
  const socket = {
    send: (m: string) => sent.push(JSON.parse(m)),
  } as unknown as WebSocket;

  handler.handleSync(
    {
      clientId: "fresh-client",
      // Cursor at the watermark: everything deleted was already seen.
      cells: { notes: { lastHlc: null, lastServerTs: 1 } },
      pendingOps: [],
    },
    { id: "c2" },
    socket,
  );

  for (let i = 0; i < 200 && !sent.some((m) => m.t === "sync-res"); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const d = sent.find((m) => m.t === "sync-res")!.d as {
    mode: string;
    ops: unknown[];
  };
  assertEquals(
    d.mode,
    "incremental",
    "no snapshot needed — nothing was missed",
  );
  assertEquals(d.ops.length, 1, "just the op it hasn't seen");
});

Deno.test("sync migrations are idempotent and safe on an existing database", async () => {
  const db = createDb();
  const warnings: string[] = [];
  const logs = {
    debug: () => {},
    warn: (m: string) => warnings.push(m),
  };
  await applySyncMigrations(db, logs); // column already present from SYNC_SCHEMA
  await applySyncMigrations(db, logs); // and again
  assertEquals(warnings, [], "an already-applied migration is not a warning");
  assertEquals(await getCompactedTs(db, "notes"), 0);
});
