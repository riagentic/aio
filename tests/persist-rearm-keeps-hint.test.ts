// A COMMIT THAT LANDS WHILE A WINDOW IS WRITING KEEPS ITS ROW HINT.
//
// `schedulePersist(patches)` during an in-flight cycle folds the patches into
// `_dirty` (`_markDirty`) and marks `persistNeeded`; when the cycle ends,
// `_runPersistCycle`'s `finally` re-armed the timer by calling
// `schedulePersist()` — with NO patches, which is the spelling for "an
// unhinted commit: take the full pass" and sets `_dirty = null`. The hint the
// commit had just supplied was thrown away, and the next window walked every
// bound table by identity. Correct, and exactly the cost the dirty tracking
// exists to avoid (`db-dirty-tracking.test.ts` measures the difference at 10k
// rows) — paid on every window that overlaps a commit, which under any steady
// write rate is every other window.
//
// Both shapes write the same rows, so only the pass shape can tell them
// apart: the manager's `_windowStats` probe counts, per changed table, whether
// the planner was handed a row-set hint or walked the table.
import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { createPersistenceManager } from "../src/server/persistence.ts";
import { pk, table, text } from "../src/server/sql.ts";
import { initSchema } from "../src/db/state-sync.ts";
import { SKV_SCHEMA, sqliteKv } from "../src/server/skv-sqlite.ts";
import type { DB, QueryResult } from "../src/db/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
type Row = { id: number; v: string };

/** A real SQLite whose transactions are SLOW, and announce when they begin —
 *  so a test can land a commit inside a window's write, the way a busy app
 *  does on every window. */
function slowDb(onTxStart: { fn: () => void }) {
  const sqlite = new DatabaseSync(":memory:");
  const execute = (sql: string, params: unknown[] = []) => {
    const st = sqlite.prepare(sql);
    const rows = /^\s*select/i.test(sql)
      ? st.all(...(params as Any[]))
      : (st.run(...(params as Any[])), []);
    return Promise.resolve({ rows } as QueryResult);
  };
  const transaction = (async (stmts: { sql: string; params?: unknown[] }[]) => {
    onTxStart.fn();
    await new Promise((r) => setTimeout(r, 15));
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

const hint = (i: number): Any => [[
  "t",
  [{ op: "replace", path: ["a", i, "v"], value: "x" }],
]];

async function until(pred: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 400; i++) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

Deno.test("persist: the window re-armed after an overlapping commit is still hinted", async () => {
  const schema = { t_a: table({ id: pk(), v: text() }) };
  const onTxStart = { fn: () => {} };
  const rec = slowDb(onTxStart);
  await initSchema(rec.db, schema);
  await rec.db.execute(SKV_SCHEMA);

  const state = { t: { a: [] as Row[] } };
  const errors: unknown[] = [];
  const p = createPersistenceManager({
    appId: "rearm",
    persistKey: "rearm",
    persistMode: "single",
    persistMs: 1,
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    getState: () => state as unknown as Record<string, unknown>,
    getDBState: (s: Record<string, unknown>) => s,
    getTableState: () => ({ t_a: state.t.a }),
    asyncDb: rec.db,
    dbSchema: schema,
    kvDb: sqliteKv(rec.db),
    tableBindings: [{ table: "t_a", path: ["t", "a"] }],
    getReportOpts: () => ({ onError: (e: unknown) => errors.push(e) }),
  } as Any);
  const rows = async () =>
    (await rec.db.query<Row>("SELECT id, v FROM t_a ORDER BY id")).rows;
  const stats = () => p._windowStats!();

  try {
    state.t = {
      a: [{ id: 1, v: "a0" }, { id: 2, v: "a1" }, { id: 3, v: "a2" }],
    };
    await p.flushPersist();
    const before = stats();

    // Window A: a hinted edit to row 0 arms the timer. While its transaction
    // is being written, a second commit edits row 1 — hinted too. That commit
    // is what marks `persistNeeded` and makes the cycle re-arm.
    let injected = false;
    onTxStart.fn = () => {
      if (injected) return;
      injected = true;
      state.t = {
        a: [{ id: 1, v: "CHANGED-0" }, { id: 2, v: "CHANGED-1" }, {
          id: 3,
          v: "a2",
        }],
      };
      p.schedulePersist(hint(1));
    };
    state.t = {
      a: [{ id: 1, v: "CHANGED-0" }, { id: 2, v: "a1" }, { id: 3, v: "a2" }],
    };
    p.schedulePersist(hint(0));

    await until(
      async () =>
        (await rows()).map((r) => r.v).join() === "CHANGED-0,CHANGED-1,a2",
      "both windows to land",
    );
    assertEquals(errors, []);
    const after = stats();
    assertEquals(
      after.full - before.full,
      0,
      "the re-armed window walked the table — the hint the overlapping " +
        "commit supplied was thrown away by the unhinted re-arm",
    );
    assertEquals(
      after.hinted - before.hinted,
      2,
      "two windows, two hinted passes",
    );
  } finally {
    rec.close();
  }
});
