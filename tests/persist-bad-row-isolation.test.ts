// One row SQLite refuses must cost exactly that table — never the whole app's
// state.
//
// The `db:` tables and the `aio_kv` snapshot now commit in ONE transaction
// (see persist-store-atomicity.test.ts), which is right: they are two halves of
// one moment. But a shared transaction shares its failures, and the row checks
// that run BEFORE the statements are built do not cover the constraints aio's
// own CREATE TABLE declares — a NULL in a non-nullable column, a repeat in a
// `unique:` column, a duplicate rowid. Those reach SQLite, which rejects them,
// and the rollback takes the state snapshot with it.
//
// The consequence is unbounded: the offending array stays in state, so the same
// batch is rebuilt and rejected on EVERY debounce window, and from the first bad
// row onward NOTHING the app writes — no cell, no other table, no session — ever
// reaches disk again.
//
// Since a refused table HOLDS ITS CELL (1b1b90ff8), "costs exactly that table"
// has two halves, and both are pinned here in the mode the real boot runs —
// with `tableBindings`, which name the cell a table belongs to: the owning
// cell's snapshot stays at the last value that landed WITH its rows (never a
// counter describing rows that are not there), and every other cell keeps
// persisting. Without the bindings a table name is read as its own root key,
// a mode no booted app uses, so the hold was never exercised.

import { assert, assertEquals, assertMatch } from "@std/assert";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import { createPersistenceManager } from "../src/server/persistence.ts";
import { SKV_SCHEMA, sqliteKv } from "../src/server/skv-sqlite.ts";
import type { DB, QueryResult, Tx } from "../src/db/types.ts";
import { initSchema } from "../src/db/state-sync.ts";
import { integer, pk, table, text } from "../src/server/sql.ts";

// deno-lint-ignore no-explicit-any
const _p = (v: unknown[]): any[] => v;
// deno-lint-ignore no-explicit-any
type Any = any;

type Row = { id: number; v: string | null };

function realDb(): { db: DB; close: () => void } {
  const sqlite = new DatabaseSync(":memory:");
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
  // A real transaction: rolls back as a unit, exactly like the worker DB.
  const transaction = (async (arg: unknown) => {
    if (typeof arg === "function") {
      return await (arg as (tx: Tx) => Promise<unknown>)({ query, execute });
    }
    const stmts = arg as { sql: string; params?: unknown[] }[];
    sqlite.exec("BEGIN");
    try {
      const out: QueryResult[] = [];
      for (const s of stmts) out.push(await execute(s.sql, s.params));
      sqlite.exec("COMMIT");
      return out;
    } catch (e) {
      sqlite.exec("ROLLBACK");
      throw e;
    }
  }) as Any;
  return {
    db: { query, execute, transaction, close: () => Promise.resolve() },
    close: () => sqlite.close(),
  };
}

async function makeManager() {
  // `v` is NOT NULL (text() without `nullable`), exactly as aio declares it.
  const schema = { notes_items: table({ id: pk(), v: text() }) };
  const rec = realDb();
  await initSchema(rec.db, schema);
  await rec.db.execute(SKV_SCHEMA);

  const state = { notes: { items: [] as Row[], n: 0 }, other: { m: 0 } };
  const errors: unknown[] = [];
  const p = createPersistenceManager({
    appId: "bad-row-probe",
    persistKey: "bad-row-probe",
    persistMode: "single",
    persistMs: 2,
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as Any,
    getState: () => state as unknown as Record<string, unknown>,
    getDBState: (s: Record<string, unknown>) => s,
    getTableState: () => ({ notes_items: state.notes.items }),
    asyncDb: rec.db,
    dbSchema: schema,
    tableBindings: [{ table: "notes_items", path: ["notes", "items"] }],
    kvDb: sqliteKv(rec.db),
    getReportOpts: () => ({ onError: (e: unknown) => errors.push(e) }),
  } as Any);
  return { p, rec, state, errors };
}

const snapshot = async (db: DB): Promise<Any> => {
  const kv = (await db.query<{ v: string }>(
    "SELECT v FROM aio_kv WHERE k = 'bad-row-probe'",
  )).rows;
  return kv[0] ? JSON.parse(kv[0].v) : null;
};
const snapshotN = async (db: DB): Promise<number | null> =>
  (await snapshot(db))?.notes?.n ?? null;
const snapshotM = async (db: DB): Promise<number | null> =>
  (await snapshot(db))?.other?.m ?? null;

Deno.test("persist: a row SQLite refuses holds its own cell, and every other cell still persists", async () => {
  const { p, rec, state, errors } = await makeManager();
  try {
    // A good window first, so there is something to lose.
    state.notes = { items: [{ id: 1, v: "ok" }], n: 1 };
    state.other = { m: 1 };
    await p.flushPersist();
    assertEquals(await snapshotN(rec.db), 1, "precondition: the good window");
    assertEquals(await snapshotM(rec.db), 1, "precondition: the other cell");

    // Now a row SQLite will reject: NULL in a NOT NULL column. Everything ELSE
    // in this window is fine and must still be saved.
    state.notes = { items: [{ id: 1, v: "ok" }, { id: 2, v: null }], n: 2 };
    state.other = { m: 2 };
    await p.flushPersist();

    const said = errors.map((e) => String((e as Error)?.cause ?? e)).join("\n");
    assertMatch(
      said,
      /NOT NULL|notes/i,
      `the failure must be reported by what SQLite refused, not merely ` +
        `reported: ${said}`,
    );
    assertEquals(
      await snapshotM(rec.db),
      2,
      "one bad row costs its own cell — every OTHER cell's snapshot must " +
        "still be written. Sharing a transaction with the tables meant a " +
        "single unwritable row stopped every cell from ever persisting again.",
    );
    assertEquals(
      await snapshotN(rec.db),
      1,
      "the refused table's own cell HOLDS at the last value that landed with " +
        "its rows — a snapshot of n=2 beside a table without row 2 is a torn " +
        "cell at the next boot",
    );

    // And the app keeps saving after that, window after window.
    state.other = { m: 3 };
    await p.flushPersist();
    assertEquals(
      await snapshotM(rec.db),
      3,
      "and the other cell keeps saving while the bad row is still there",
    );
    assertEquals(
      await snapshotN(rec.db),
      1,
      "while the bad row stays, so does the hold",
    );

    // The table itself is untouched and consistent — never half-applied.
    const rows = (await rec.db.query("SELECT id FROM notes_items")).rows;
    assertEquals(rows.length, 1, "the rejected batch rolled back as a unit");
  } finally {
    p.setShuttingDown();
    rec.close();
  }
});

Deno.test("persist: the table catches up once the bad row is fixed", async () => {
  const { p, rec, state } = await makeManager();
  try {
    state.notes = { items: [{ id: 1, v: null }], n: 1 };
    await p.flushPersist();
    assertEquals(
      (await rec.db.query("SELECT id FROM notes_items")).rows.length,
      0,
      "nothing written yet",
    );
    // The developer fixes it. The baseline never advanced, so the row is still
    // seen as pending and lands now.
    state.notes = { items: [{ id: 1, v: "fixed" }], n: 2 };
    await p.flushPersist();
    assertEquals(
      (await rec.db.query<{ v: string }>("SELECT v FROM notes_items")).rows.map(
        (r) => r.v,
      ),
      ["fixed"],
      "a failed table sync must be retried, not declared done",
    );
    assertEquals(await snapshotN(rec.db), 2);
  } finally {
    p.setShuttingDown();
    rec.close();
  }
});

Deno.test("persist: two rows whose pk differs only in TYPE are named, not sent to SQLite", async () => {
  const schema = { notes_items: table({ id: pk(), n: integer() }) };
  const rec = realDb();
  await initSchema(rec.db, schema);
  await rec.db.execute(SKV_SCHEMA);
  const state = {
    notes: { items: [{ id: 1, n: 1 }, { id: "1", n: 2 }] as Any[], n: 0 },
  };
  const errors: Error[] = [];
  const p = createPersistenceManager({
    appId: "dup-pk-probe",
    persistKey: "dup-pk-probe",
    persistMode: "single",
    persistMs: 2,
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as Any,
    getState: () => state as unknown as Record<string, unknown>,
    getDBState: (s: Record<string, unknown>) => s,
    getTableState: () => ({ notes_items: state.notes.items }),
    asyncDb: rec.db,
    dbSchema: schema,
    tableBindings: [{ table: "notes_items", path: ["notes", "items"] }],
    kvDb: sqliteKv(rec.db),
    getReportOpts: () => ({ onError: (e: Error) => errors.push(e) }),
  } as Any);
  try {
    await p.flushPersist();
    // SQLite's INTEGER PRIMARY KEY is the rowid: `1` and `"1"` are the SAME
    // key there, so the second INSERT is rejected and the batch rolls back.
    // The duplicate-pk guard exists to name that BEFORE a statement is built.
    const msg = errors.map((e) => String((e as Any)?.cause ?? e)).join("\n");
    assert(
      /duplicate primary key/.test(msg),
      `the duplicate must be named by the row guard, not discovered by ` +
        `SQLite. Got:\n${msg}`,
    );
  } finally {
    p.setShuttingDown();
    rec.close();
  }
});
