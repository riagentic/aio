// A REFUSED PERSIST WINDOW MUST NOT LOSE ITS DIRTY HINT.
//
// `_planSqlite` consumes the immer dirty hint and CLEARS it at plan time. When
// the plan then throws, or the transaction rolls back, the baselines are
// correctly left un-advanced — but the hint saying WHICH ROWS moved is gone.
// The next window supplies a NARROWER hint, `diffDirty` walks only those
// indices, its "nothing left" guard passes, and `plan.commit()` advances the
// baseline: the earlier row is never written, permanently, with nothing logged
// again and `lastCycleError()` null.
//
// Measured on a real app with an ordinary UNIQUE collision — one window sets
// `a[0] = "CHANGED-0"` and transiently collides on `a[1]`, the next resolves
// the collision. State held CHANGED-0, SQLite held the original, `am persist`
// answered 200, and a restart silently undid the accepted change. Reachable
// from every transient refusal SQLite has: UNIQUE, NOT NULL, a dangling
// `ref()`, "too many SQL variables", "database is locked", "disk is full".
//
// Neither test named for this could see it: `db-dirty-tracking.test.ts` ("a
// refused window is retried whole") calls the planner with NO dirty argument,
// and `persist-bad-row-isolation.test.ts` drives the manager without patches —
// both were already taking the full pass. So this drives the REAL manager with
// REAL patch hints, which is the only instrument that can see a hint dropped.
import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { createPersistenceManager } from "../src/server/persistence.ts";
import { pk, table, text } from "../src/server/sql.ts";
import { initSchema } from "../src/db/state-sync.ts";
import { SKV_SCHEMA, sqliteKv } from "../src/server/skv-sqlite.ts";
import type { DB, QueryResult } from "../src/db/types.ts";
import { createAioError, generateTip } from "../src/diagnostics/error.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
type Row = { id: number; v: string };

function realDb() {
  const sqlite = new DatabaseSync(":memory:");
  const execute = (sql: string, params: unknown[] = []) => {
    const st = sqlite.prepare(sql);
    const rows = /^\s*select/i.test(sql)
      ? st.all(...(params as Any[]))
      : (st.run(...(params as Any[])), []);
    return Promise.resolve({ rows } as QueryResult);
  };
  const transaction = (async (stmts: { sql: string; params?: unknown[] }[]) => {
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
    db: {
      query: execute,
      execute,
      transaction,
      close: () => Promise.resolve(),
    } as unknown as DB,
    close: () => sqlite.close(),
  };
}

/** The patch shape `schedulePersist` takes. A write to `a[i].v` is one
 *  `replace` at that index — what a real dispatch produces, and what narrows
 *  the hint to that row. */
const hint = (i: number): Any => [[
  "t",
  [{ op: "replace", path: ["a", i, "v"], value: "x" }],
]];

Deno.test("persist: a window refused by SQLite is retried WHOLE, not narrowed", async () => {
  const schema = { t_a: table({ id: pk(), v: text({ unique: true }) }) };
  const rec = realDb();
  await initSchema(rec.db, schema);
  await rec.db.execute(SKV_SCHEMA);

  const state = { t: { a: [] as Row[] } };
  const errors: unknown[] = [];
  const p = createPersistenceManager({
    appId: "refused-window",
    persistKey: "refused-window",
    persistMode: "single",
    persistMs: 1,
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    getState: () => state as unknown as Record<string, unknown>,
    getDBState: (s: Record<string, unknown>) => s,
    getTableState: () => ({ t_a: state.t.a }),
    asyncDb: rec.db,
    dbSchema: schema,
    kvDb: sqliteKv(rec.db),
    // The binding the hint is folded against — `t.a` feeds table `t_a`.
    tableBindings: [{ table: "t_a", path: ["t", "a"] }],
    // The binding the hint is folded against — `t.a` feeds table `t_a`.
    getReportOpts: () => ({ onError: (e: unknown) => errors.push(e) }),
  } as Any);

  const rows = async () =>
    (await rec.db.query<Row>("SELECT id, v FROM t_a ORDER BY id")).rows;

  try {
    // Window 0: the baseline lands. A fresh array each window, because that is
    // what an immer commit produces — the manager skips a table whose array is
    // the same object it saw last time.
    state.t = { a: [{ id: 1, v: "a0" }, { id: 2, v: "a1" }] };
    await p.flushPersist();
    assertEquals((await rows()).map((r) => r.v), ["a0", "a1"]);

    // Window 1: a valid edit to row 0, and row 1 transiently colliding on the
    // UNIQUE column — SQLite refuses the whole transaction.
    state.t = { a: [{ id: 1, v: "CHANGED-0" }, { id: 2, v: "CHANGED-0" }] };
    p.schedulePersist(hint(0));
    p.schedulePersist(hint(1));
    await p.flushPersist().catch(() => {
      // aio-ok: the refusal IS the setup — it is reported through
      // `getReportOpts` and rethrown here. What matters is the NEXT window.
    });
    assert(errors.length > 0, "the collision was not reported at all");
    assertEquals(
      (await rows()).map((r) => r.v),
      ["a0", "a1"],
      "the refused window must not have written anything",
    );

    // Window 2: resolve the collision on row 1 ONLY. Its hint names row 1;
    // row 0's edit was accepted a window ago and must still land.
    state.t = { a: [{ id: 1, v: "CHANGED-0" }, { id: 2, v: "CHANGED-1" }] };
    p.schedulePersist(hint(1));
    await p.flushPersist();
    assertEquals(
      (await rows()).map((r) => r.v),
      ["CHANGED-0", "CHANGED-1"],
      "row 0 kept its stale value — the refused window's dirty hint was lost " +
        "and that row was never re-examined",
    );
  } finally {
    rec.close();
  }
});

// The classifier that told an operator the opposite of the truth: node:sqlite
// surfaces SQLITE_FULL as the STRING "database or disk is full", which matched
// nothing — so the one message meaning "you are out of disk" was answered with
// "this does not look like a disk-space or permissions failure".
Deno.test("PERSIST_ERROR: the disk classifier reads the driver's words", () => {
  const tip = (m: string) =>
    generateTip(createAioError("PERSIST_ERROR", new Error(m), {})) ?? "";
  for (
    const m of [
      "database or disk is full",
      "disk I/O error",
      "attempt to write a readonly database",
      "database is locked",
    ]
  ) {
    assert(
      tip(m).includes("Check disk space"),
      `"${m}" was not recognised as a disk problem: ${tip(m)}`,
    );
  }
  // …and a row the store refused is still NOT sent to check the disk.
  assert(
    !tip('db: table "b" row #0 column "v" is an object').includes(
      "Check disk space",
    ),
  );
});
