// Db tier: reconcileTable's "empty table → DROP + CREATE" rebuild
// (src/db/state-sync.ts) silently destroyed every index and trigger the app
// created on that table through app.db. The rebuild was justified as lossless
// ("No rows to preserve"), but an app's own `CREATE UNIQUE INDEX` — typically
// run once behind a `PRAGMA user_version` marker, the idiom aio documents as
// the app's — is schema, not rows: after the rebuild the constraint was gone,
// the app's marker said it already ran, and duplicates were accepted forever.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { createDB } from "../src/db/async-db.ts";
import { _resetDbReports, initSchema } from "../src/db/state-sync.ts";
import { integer, pk, table, text } from "../src/server/sql.ts";

Deno.test("db: adding a column to an EMPTY table keeps the app's indexes on it", async () => {
  const db = createDB(":memory:");
  try {
    // Boot 1: the declared table, plus the app's own unique index.
    await initSchema(db, { items: table({ id: pk(), name: text() }) });
    await db.execute("CREATE UNIQUE INDEX items_name ON items(name)");
    // Boot 2: a NOT NULL column is added while the table happens to be empty.
    await initSchema(db, {
      items: table({ id: pk(), name: text(), qty: integer() }),
    });
    const { rows } = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'items' AND sql IS NOT NULL",
    );
    assertEquals(rows.map((r) => r.name), ["items_name"]);
    // …and it still enforces.
    await db.execute(
      "INSERT INTO items (id, name, qty) VALUES (1, 'a', 1)",
    );
    await assertRejects(
      () => db.execute("INSERT INTO items (id, name, qty) VALUES (2, 'a', 1)"),
      Error,
      "UNIQUE",
    );
  } finally {
    await db.close();
  }
});

Deno.test("db: adding a column to an EMPTY table keeps the app's triggers on it", async () => {
  const db = createDB(":memory:");
  try {
    await initSchema(db, {
      items: table({ id: pk(), name: text() }),
      audit: table({ id: pk(), what: text() }),
    });
    await db.execute(
      "CREATE TRIGGER items_audit AFTER INSERT ON items BEGIN " +
        "INSERT INTO audit (id, what) VALUES (NEW.id, NEW.name); END",
    );
    await initSchema(db, {
      items: table({ id: pk(), name: text(), qty: integer() }),
      audit: table({ id: pk(), what: text() }),
    });
    await db.execute("INSERT INTO items (id, name, qty) VALUES (7, 'x', 1)");
    const { rows } = await db.query<{ what: string }>(
      "SELECT what FROM audit",
    );
    assertEquals(rows.map((r) => r.what), ["x"]);
  } finally {
    await db.close();
  }
});

Deno.test("db: an app index the rebuilt table cannot carry is skipped and named, never a boot failure", async () => {
  const db = createDB(":memory:");
  _resetDbReports();
  const seen: string[] = [];
  const orig = console.warn;
  try {
    await initSchema(db, { items: table({ id: pk(), name: text() }) });
    await db.execute("CREATE INDEX items_by_name ON items(name)");
    // `name` is no longer declared, and a NOT NULL `qty` forces the rebuild:
    // the index cannot follow. 1.0.12 booted this app (dropping the index) —
    // keep booting, but name the index and its SQL.
    console.warn = (...a: unknown[]) => void seen.push(a.map(String).join(" "));
    await initSchema(db, { items: table({ id: pk(), qty: integer() }) });
    console.warn = orig;
    const cols = await db.query<{ name: string }>(
      "SELECT name FROM pragma_table_info('items') ORDER BY cid",
    );
    assertEquals(cols.rows.map((r) => r.name), ["id", "qty"]);
    const idx = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'items' AND sql IS NOT NULL",
    );
    assertEquals(idx.rows.map((r) => r.name), []);
    assert(
      seen.some((w) =>
        w.includes(`index "items_by_name"`) && w.includes(`table "items"`) &&
        w.includes("CREATE INDEX items_by_name ON items(name)")
      ),
      `the skipped index is named with its SQL: ${seen.join(" | ")}`,
    );
  } finally {
    console.warn = orig;
    await db.close();
  }
});
