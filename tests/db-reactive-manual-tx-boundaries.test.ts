// A live query follows the app's OWN transaction boundaries.
//
// `db.execute("BEGIN")` → INSERT → `db.execute("ROLLBACK")`: with no reader
// pool the INSERT refreshed the live query on the writer connection (which
// sees its own uncommitted row), and the ROLLBACK names no table, so nothing
// refreshed again — the query kept a row that never existed. With
// `readers: 1` the refresh at the INSERT read a reader's committed snapshot
// (no row yet), and the COMMIT named no table either, so the committed row
// never appeared. Both silent. COMMIT/END/ROLLBACK (and ROLLBACK TO /
// RELEASE) now refresh what the transaction wrote.
import { assertEquals } from "@std/assert";
import { createDB } from "../src/db/async-db.ts";
import { reactiveDB } from "../src/db/reactive.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const count = "SELECT count(*) AS c FROM t";

Deno.test("live query: an app-opened transaction's ROLLBACK drops the rolled-back row (readers 0)", async () => {
  const db = reactiveDB(createDB(":memory:"));
  try {
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const q = await db.select<{ c: number }>(count);
    await db.execute("BEGIN");
    await db.execute("INSERT INTO t (id) VALUES (1)");
    await db.execute("ROLLBACK");
    assertEquals(q.rows[0]!.c, 0, "the rolled-back row is gone");
    q.dispose();
  } finally {
    await db.close();
  }
});

Deno.test("live query: ROLLBACK TO a savepoint refreshes too (readers 0)", async () => {
  const db = reactiveDB(createDB(":memory:"));
  try {
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const q = await db.select<{ c: number }>(count);
    await db.execute("BEGIN");
    await db.execute("SAVEPOINT sp");
    await db.execute("INSERT INTO t (id) VALUES (1)");
    await db.execute("ROLLBACK TO sp");
    assertEquals(q.rows[0]!.c, 0);
    await db.execute("INSERT INTO t (id) VALUES (2)");
    await db.execute("COMMIT");
    assertEquals(q.rows[0]!.c, 1);
    q.dispose();
  } finally {
    await db.close();
  }
});

Deno.test("live query: an app-opened transaction's COMMIT shows the committed row (readers 1)", async () => {
  const dir = await tempDir("aio-live-manual-tx-");
  const raw = createDB(`${dir}/t.db`, { readers: 1 });
  const db = reactiveDB(raw);
  try {
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    await db.execute("CREATE TABLE u (id INTEGER PRIMARY KEY)");
    await db.execute("CREATE TABLE w (id INTEGER PRIMARY KEY)");
    const q = await db.select<{ c: number }>(count);
    // Read the schema graph now: read while the app's BEGIN holds the
    // writer it cannot be, and the fallback (refresh everything) is a
    // separate, pre-existing superset this test is not about.
    await db.execute("INSERT INTO w (id) VALUES (1)");
    let refreshedU = 0;
    const qu = await db.select("SELECT * FROM u");
    qu.subscribe(() => refreshedU++);
    await db.execute("BEGIN");
    await db.execute("INSERT INTO t (id) VALUES (1)");
    await db.execute("COMMIT");
    assertEquals(q.rows[0]!.c, 1, "the committed row is shown");
    assertEquals(
      refreshedU,
      0,
      "a table the transaction never wrote is not refreshed",
    );
    // Also through the underlying handle (the write feed), with END.
    await raw.execute("BEGIN");
    await raw.execute("INSERT INTO t (id) VALUES (2)");
    await raw.execute("END");
    assertEquals(q.rows[0]!.c, 2);
    q.dispose();
    qu.dispose();
  } finally {
    await db.close();
    await dropTempDir(dir);
  }
});

Deno.test("live query: a transaction opened BEFORE the live query existed still refreshes at COMMIT (readers 1)", async () => {
  const dir = await tempDir("aio-live-manual-tx-");
  const raw = createDB(`${dir}/t.db`, { readers: 1 });
  const db = reactiveDB(raw);
  try {
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    await raw.execute("BEGIN");
    await raw.execute("INSERT INTO t (id) VALUES (1)");
    const q = await db.select<{ c: number }>(count);
    assertEquals(q.rows[0]!.c, 0, "the reader sees only committed rows");
    await raw.execute("COMMIT");
    assertEquals(q.rows[0]!.c, 1);
    q.dispose();
  } finally {
    await db.close();
    await dropTempDir(dir);
  }
});
