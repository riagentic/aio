// live queries (`reactiveDB`) that silently keep stale rows.
//
// docs/persistence/sqlite.md promises a live query "re-runs and notifies
// whenever a write through the same wrapper touches one of the tables it
// reads". Three shapes break that promise with no warning at all.

import { assertEquals } from "@std/assert";
import { createDB } from "../src/db/async-db.ts";
import { reactiveDB } from "../src/db/reactive.ts";
import type { DB, QueryResult } from "../src/db/types.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("reactive: ON DELETE CASCADE through the wrapper refreshes the child's live query", async () => {
  const db = reactiveDB(createDB(":memory:"));
  try {
    await db.execute("CREATE TABLE folders (id INTEGER PRIMARY KEY)");
    await db.execute(
      "CREATE TABLE mail (id INTEGER PRIMARY KEY, " +
        "folder INTEGER REFERENCES folders(id) ON DELETE CASCADE)",
    );
    await db.execute("INSERT INTO folders VALUES (1)");
    await db.execute("INSERT INTO mail VALUES (1, 1)");
    const q = await db.select("SELECT * FROM mail");
    assertEquals(q.rows.length, 1);
    // A write THROUGH the wrapper that deletes a mail row (by cascade).
    await db.execute("DELETE FROM folders WHERE id = 1");
    const truth = (await db.query("SELECT * FROM mail")).rows.length;
    assertEquals(truth, 0);
    assertEquals(
      q.rows.length,
      truth,
      "live query on `mail` still shows a row the cascade deleted",
    );
    q.dispose();
  } finally {
    await db.close();
  }
});

Deno.test("reactive: a trigger's write through the wrapper refreshes the live query on its target", async () => {
  const db = reactiveDB(createDB(":memory:"));
  try {
    await db.execute("CREATE TABLE mail (id INTEGER PRIMARY KEY)");
    await db.execute("CREATE TABLE audit (mail_id INTEGER)");
    await db.execute(
      "CREATE TRIGGER mail_audit AFTER INSERT ON mail " +
        "BEGIN INSERT INTO audit VALUES (new.id); END",
    );
    const q = await db.select("SELECT * FROM audit");
    assertEquals(q.rows.length, 0);
    await db.execute("INSERT INTO mail VALUES (1)");
    assertEquals(
      q.rows.length,
      1,
      "live query on `audit` missed the trigger-written row",
    );
    q.dispose();
  } finally {
    await db.close();
  }
});

Deno.test("reactive: a live query over a VIEW refreshes when its base table is written", async () => {
  const db = reactiveDB(createDB(":memory:"));
  try {
    await db.execute("CREATE TABLE mail (id INTEGER PRIMARY KEY)");
    await db.execute("CREATE VIEW recent AS SELECT * FROM mail");
    const q = await db.select("SELECT * FROM recent");
    await db.execute("INSERT INTO mail VALUES (1)");
    assertEquals(q.rows.length, 1, "live query over view `recent` is stale");
    q.dispose();
  } finally {
    await db.close();
  }
});

Deno.test("reactive: a write that commits while select()'s first fill is in flight is not lost", async () => {
  // A reader worker (readers > 0) answers the initial fill from a snapshot
  // taken BEFORE a concurrent write committed, and can deliver it AFTER that
  // write's invalidation already ran. `select()` only registers the query in
  // the change feed after the fill, so the invalidation found nothing and the
  // query keeps the pre-write rows until some unrelated later write. The
  // delay below pins that interleaving deterministically.
  const dir = await tempDir("zz-hunt-r11-db-race");
  const base = createDB(`${dir}/t.db`);
  let hold: Promise<void> | null = null;
  const slowReads: DB = {
    ...base,
    query: async <T>(sql: string, params?: unknown[]) => {
      const wait = hold; // captured at call time
      const r = await base.query<T>(sql, params) as QueryResult<T>;
      if (wait) await wait;
      return r;
    },
    execute: (sql, params) => base.execute(sql, params),
    transaction: base.transaction.bind(base) as DB["transaction"],
    close: () => base.close(),
  };
  const db = reactiveDB(slowReads);
  try {
    await db.execute("CREATE TABLE mail (id INTEGER PRIMARY KEY)");
    let release!: () => void;
    hold = new Promise<void>((r) => release = r);
    const pending = db.select("SELECT * FROM mail"); // fill read: 0 rows
    await new Promise((r) => setTimeout(r, 20));
    hold = null;
    await db.execute("INSERT INTO mail VALUES (1)"); // commits + invalidates
    release(); // the stale fill lands now
    const q = await pending;
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(
      q.rows.length,
      1,
      "live query registered after the write's invalidation — stale forever",
    );
    q.dispose();
  } finally {
    await db.close();
    await dropTempDir(dir);
  }
});

Deno.test("reactive: a live query with 200k rows can be selected and refreshed", async () => {
  const db = reactiveDB(createDB(":memory:"));
  try {
    await db.execute("CREATE TABLE n (v INTEGER)");
    await db.execute(
      "INSERT INTO n WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL " +
        "SELECT x + 1 FROM c WHERE x < 200000) SELECT x FROM c",
    );
    // rows.push(...res.rows) spreads every row as a call argument:
    // RangeError: Maximum call stack size exceeded past ~150k rows.
    const q = await db.select("SELECT v FROM n");
    assertEquals(q.rows.length, 200_000);
    q.dispose();
  } finally {
    await db.close();
  }
});
