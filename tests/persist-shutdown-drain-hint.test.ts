// THE FINAL PERSIST MUST SEE THE ROWS THE DRAIN WROTE.
//
// Shutdown order (shutdown.ts): `onStopping` → `setShuttingDown()` →
// `dispatch.close()` → abort + DRAIN in-flight methods → `flushPersist()`.
// The drain exists so that a method already running when the window closed
// can finish its writes and have the final persist capture them — that is
// the whole promise of the `draining` phase (dispatch.ts INFLIGHT).
//
// But `schedulePersist(patches)` returned early while `shuttingDown`, BEFORE
// folding the commit's row hint into `_dirty`. So the picture the final flush
// planned from was whatever the last un-flushed window had left there — a
// NARROW hint naming other rows. `diffDirty` walked only those indices, its
// "nothing left" count guard passed (an in-place update changes no length),
// and `plan.commit()` advanced the baseline past the drained row: state said
// `CHANGED-1`, SQLite said `a1`, `lastCycleError()` was null, the exit looked
// clean, and the next boot read the old value back. An acked write from a
// method the drain deliberately waited for, dropped by the persist that was
// waiting for it.
//
// Reachable from any app: one debounce window still open (a click, then the
// window closed within `persistMs`) plus one in-flight method finishing an
// in-place row update on the way out — an Electron close, a Ctrl-C, a deploy.
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

/** One `replace` at row `i` — what a dispatch of `s.a[i].v = …` produces. */
const hint = (i: number): Any => [[
  "t",
  [{ op: "replace", path: ["a", i, "v"], value: "x" }],
]];

Deno.test("persist: a row committed during the shutdown drain reaches the final flush", async () => {
  const schema = { t_a: table({ id: pk(), v: text() }) };
  const rec = realDb();
  await initSchema(rec.db, schema);
  await rec.db.execute(SKV_SCHEMA);

  const state = { t: { a: [] as Row[] } };
  const errors: unknown[] = [];
  const p = createPersistenceManager({
    appId: "drain-hint",
    persistKey: "drain-hint",
    persistMode: "single",
    // Long, so the open window below is still open when shutdown begins —
    // the shape a user produces by closing the app within the debounce.
    persistMs: 60_000,
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

  try {
    // Window 0: the baseline lands.
    state.t = { a: [{ id: 1, v: "a0" }, { id: 2, v: "a1" }] };
    await p.flushPersist();
    assertEquals((await rows()).map((r) => r.v), ["a0", "a1"]);

    // Window 1: a click edits row 0. The debounce timer is armed and will
    // not fire before the flush below closes it.
    state.t = { a: [{ id: 1, v: "CHANGED-0" }, { id: 2, v: "a1" }] };
    p.schedulePersist(hint(0));

    // Shutdown begins: the door is marked BEFORE the drain (shutdown.ts
    // Phase 1), and an in-flight method finishes an in-place update of row 1
    // during it. Same length, different row — the narrowest edit there is.
    p.setShuttingDown();
    state.t = { a: [{ id: 1, v: "CHANGED-0" }, { id: 2, v: "CHANGED-1" }] };
    p.schedulePersist(hint(1));

    // The final persist — the last chance to write anything.
    await p.flushPersist();
    assertEquals(errors, [], "the final flush must not have been refused");
    assertEquals(p.lastCycleError(), null);
    assertEquals(
      (await rows()).map((r) => r.v),
      ["CHANGED-0", "CHANGED-1"],
      "row 1's drain-time update never reached SQLite — the shutdown gate " +
        "dropped its dirty hint and the final flush planned from a stale one",
    );
  } finally {
    rec.close();
  }
});

// The same gate, with NO window open when the drain writes: `_dirty` is empty
// then, the flush takes the full pass, and the row lands. This pins the
// narrow shape above as the one that mattered — and that the fix did not
// simply force every final flush onto the full pass.
Deno.test("persist: an unhinted drain-time write still takes the full pass", async () => {
  const schema = { t_a: table({ id: pk(), v: text() }) };
  const rec = realDb();
  await initSchema(rec.db, schema);
  await rec.db.execute(SKV_SCHEMA);

  const state = { t: { a: [] as Row[] } };
  const p = createPersistenceManager({
    appId: "drain-unhinted",
    persistKey: "drain-unhinted",
    persistMode: "single",
    persistMs: 60_000,
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    getState: () => state as unknown as Record<string, unknown>,
    getDBState: (s: Record<string, unknown>) => s,
    getTableState: () => ({ t_a: state.t.a }),
    asyncDb: rec.db,
    dbSchema: schema,
    kvDb: sqliteKv(rec.db),
    tableBindings: [{ table: "t_a", path: ["t", "a"] }],
    getReportOpts: () => ({}),
  } as Any);
  const rows = async () =>
    (await rec.db.query<Row>("SELECT id, v FROM t_a ORDER BY id")).rows;
  try {
    state.t = { a: [{ id: 1, v: "a0" }, { id: 2, v: "a1" }] };
    await p.flushPersist();
    p.setShuttingDown();
    // A restore / time-travel style write: no patch information at all.
    state.t = { a: [{ id: 1, v: "a0" }, { id: 2, v: "CHANGED-1" }] };
    p.schedulePersist();
    await p.flushPersist();
    assertEquals((await rows()).map((r) => r.v), ["a0", "CHANGED-1"]);
  } finally {
    rec.close();
  }
});
