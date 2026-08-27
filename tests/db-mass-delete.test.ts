// Audit 2026-08-27 (CRITICAL, data loss): a confirmed deletion, silently undone
// by a restart.
//
// `planTables` built ONE unbounded `DELETE … WHERE pk IN (?,…)` for every row a
// window removed. SQLite refuses a statement with more than
// SQLITE_MAX_VARIABLE_NUMBER (32766) host parameters — `too many SQL variables`
// — so pruning a big table rolled the whole shared transaction back. The `db:`
// baseline is deliberately NOT advanced on failure, so the identical batch was
// rebuilt and refused on EVERY debounce window forever, while the state
// snapshot kept committing alone: state said 1 row, the table held 40 000, and
// the next boot restored all 40 000 back into state.
//
// Reproduced before the fix at exactly these numbers (39 999 parameters in one
// statement → "too many SQL variables" → COUNT(*) still 40 000).

import { assert, assertEquals, assertThrows } from "@std/assert";
import { createDB } from "../src/db/async-db.ts";
import { initSchema, planTables } from "../src/db/state-sync.ts";
import {
  buildWhere,
  integer,
  pk,
  SQL_PARAM_CHUNK,
  SQLITE_MAX_VARS,
  table,
  text,
} from "../src/server/sql.ts";

const schema = { items: table({ id: pk(), name: text(), n: integer() }) };
const rowsOf = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `n${i}`, n: i }));

Deno.test("db: a mass delete is chunked — no statement exceeds the param cap", () => {
  const before = rowsOf(40_000);
  const stmts = planTables(schema, { items: [before[0]!] }, { items: before });
  const worst = Math.max(...stmts.map((s) => s.params?.length ?? 0));
  assert(
    worst <= SQL_PARAM_CHUNK,
    `a framework-built statement carried ${worst} host parameters — SQLite ` +
      `refuses over ${SQLITE_MAX_VARS} and the cap is ${SQL_PARAM_CHUNK}`,
  );
  // Every removed id is still asked for, exactly once — chunking must not lose
  // a single deletion.
  const deleted = stmts
    .filter((s) => s.sql.startsWith("DELETE FROM items WHERE id IN"))
    .flatMap((s) => s.params ?? []);
  assertEquals(deleted.length, 39_999);
  assertEquals(new Set(deleted).size, 39_999);
});

Deno.test("db: pruning 40k rows to 1 actually reaches SQLite", async () => {
  const db = createDB(":memory:");
  try {
    await initSchema(db, schema);
    const all = rowsOf(40_000);
    await db.transaction(planTables(schema, { items: all }, { items: [] }));
    assertEquals(
      (await db.query<{ c: number }>("SELECT COUNT(*) c FROM items")).rows[0]
        ?.c,
      40_000,
    );
    // The prune. Before the fix this threw `too many SQL variables`, the
    // transaction rolled back, and the count below was still 40 000.
    await db.transaction(
      planTables(schema, { items: [all[0]!] }, { items: all }),
    );
    assertEquals(
      (await db.query<{ c: number }>("SELECT COUNT(*) c FROM items")).rows[0]
        ?.c,
      1,
    );
  } finally {
    await db.close();
  }
});

Deno.test("db: the delete chunks share one transaction — all or none", async () => {
  const db = createDB(":memory:");
  try {
    await initSchema(db, schema);
    const all = rowsOf(2_000);
    await db.transaction(planTables(schema, { items: all }, { items: [] }));
    const stmts = planTables(schema, { items: [] }, { items: all });
    // A statement SQLite refuses, injected between the delete chunks: the
    // whole batch must roll back, leaving every row in place.
    stmts.splice(1, 0, { sql: "DELETE FROM no_such_table" });
    await db.transaction(stmts).then(
      () => assert(false, "expected the batch to be refused"),
      () => {},
    );
    assertEquals(
      (await db.query<{ c: number }>("SELECT COUNT(*) c FROM items")).rows[0]
        ?.c,
      2_000,
    );
  } finally {
    await db.close();
  }
});

Deno.test("db: a where-in over the SQLite ceiling names the limit and the fix", () => {
  // A WHERE fragment is ONE statement and cannot be chunked, so this is the
  // one variadic builder that refuses instead of splitting — loudly, at the
  // call site, rather than as a bare `too many SQL variables` from the worker.
  const ok = buildWhere({
    id: { in: Array.from({ length: 5000 }, (_, i) => i) },
  });
  assertEquals(ok.params.length, 5000);
  const e = assertThrows(
    () =>
      buildWhere({
        id: { in: Array.from({ length: SQLITE_MAX_VARS + 1 }, (_, i) => i) },
      }),
    Error,
  );
  assert(e.message.includes(String(SQLITE_MAX_VARS)), e.message);
  assert(e.message.includes("temporary table"), e.message);
});
