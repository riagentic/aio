// A table sync that FAILS on a scheduled persist must (a) be reported, not just
// logged, and (b) leave the baseline untouched so the next window re-writes the
// rows it missed. Both halves matter: a table that quietly stops syncing while
// the app looks healthy is the exact failure the persist path exists to prevent.
//
// The shutdown-flush half of this contract is pinned by
// tests/persist-flush-error-report.test.ts; this pins the SCHEDULED half and the
// recovery, which nothing covered.
import { assert, assertEquals } from "@std/assert";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import { createPersistenceManager } from "../src/server/persistence.ts";
import type { DB, QueryResult, Tx } from "../src/db/types.ts";
import { initSchema } from "../src/db/state-sync.ts";
import { pk, table, text } from "../src/server/sql.ts";

// deno-lint-ignore no-explicit-any
const _p = (v: unknown[]): any[] => v;

/** Real in-memory SQLite with a switch that makes writes fail (a full disk). */
function flakyDb(): { db: DB; fail: (on: boolean) => void; close: () => void } {
  const sqlite = new DatabaseSync(":memory:");
  let failing = false;
  const query = <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> =>
    Promise.resolve({
      rows: sqlite.prepare(sql).all(..._p(params ?? [])) as T[],
      changes: 0,
      lastInsertRowId: 0n,
    });
  const execute = (sql: string, params?: unknown[]): Promise<QueryResult> => {
    const r = sqlite.prepare(sql).run(..._p(params ?? []));
    return Promise.resolve({
      rows: [],
      changes: Number(r.changes),
      lastInsertRowId: BigInt(r.lastInsertRowid),
    });
  };
  const transaction = (async (arg: unknown) => {
    if (failing) throw new Error("disk is full");
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
  return {
    db: { query, execute, transaction, close: () => Promise.resolve() },
    fail: (on: boolean) => {
      failing = on;
    },
    close: () => sqlite.close(),
  };
}

Deno.test("a scheduled table sync that fails is reported AND retried, losing no row", async () => {
  const schema = { notes_items: table({ id: pk(), v: text() }) };
  const { db, fail, close } = flakyDb();
  await initSchema(db, schema);

  const errors: string[] = [];
  const logged: string[] = [];
  let items: { id: number; v: string }[] = [];
  const state = { notes: { items } };

  const p = createPersistenceManager({
    appId: "sqlite-retry-probe",
    persistKey: "sqlite-retry-probe",
    persistMode: "single",
    persistMs: 5,
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (m: string) => logged.push(m),
      // deno-lint-ignore no-explicit-any
    } as any,
    getState: () => state as unknown as Record<string, unknown>,
    getDBState: (s: Record<string, unknown>) => s,
    getTableState: () => ({ notes_items: state.notes.items }),
    asyncDb: db,
    dbSchema: schema,
    kvDb: null,
    getReportOpts: () => ({
      onError: (e: { message?: string }) => {
        errors.push(String(e?.message ?? e));
      },
    }),
    // deno-lint-ignore no-explicit-any
  } as any);

  const settle = async () => {
    // Two debounce windows plus slack — the manager re-schedules itself.
    for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 5));
  };

  try {
    // 1. A write that FAILS.
    fail(true);
    items = [{ id: 1, v: "one" }];
    state.notes.items = items;
    p.schedulePersist();
    await settle();

    assert(
      errors.length > 0,
      "a failed table sync on the SCHEDULED path must reach onError, not " +
        `only the log (log lines: ${JSON.stringify(logged)})`,
    );
    assert(
      errors.some((e) => /disk is full/i.test(e)),
      `the report must carry the real cause, got ${JSON.stringify(errors)}`,
    );
    assertEquals(
      (await db.query("SELECT id FROM notes_items")).rows.length,
      0,
      "nothing landed — that is the premise",
    );

    // 2. The disk comes back and a LATER change is persisted. The row the
    //    failed window carried must ride along: the baseline may not have
    //    advanced past a write that never committed.
    fail(false);
    items = [{ id: 1, v: "one" }, { id: 2, v: "two" }];
    state.notes.items = items;
    p.schedulePersist();
    await settle();

    const rows = (await db.query<{ id: number; v: string }>(
      "SELECT id, v FROM notes_items ORDER BY id",
    )).rows;
    assertEquals(
      rows,
      [{ id: 1, v: "one" }, { id: 2, v: "two" }],
      "the row from the FAILED window must be re-written once the db recovers " +
        "— a table that silently stops syncing is the bug this guards",
    );
  } finally {
    p.setShuttingDown();
    close();
  }
});
