// reactive SQL views: a select() re-runs + notifies when a write
// through the wrapper touches a table it reads.
import { assert, assertEquals } from "@std/assert";
import { createDB } from "../src/db/async-db.ts";
import { reactiveDB, tablesIn } from "../src/db/reactive.ts";

const READ = /\b(?:from|join)\s+["'`]?([A-Za-z_]\w*)/gi;
const WRITE =
  /\b(?:insert\s+into|update|delete\s+from|replace\s+into)\s+["'`]?([A-Za-z_]\w*)/gi;

Deno.test("tablesIn: parses read + write tables (case-insensitive, aliases)", () => {
  assertEquals([...tablesIn("SELECT * FROM Items i JOIN tags t", READ)], [
    "items",
    "tags",
  ]);
  assertEquals([...tablesIn("INSERT INTO Items(a) VALUES(1)", WRITE)], [
    "items",
  ]);
  assertEquals([...tablesIn("DELETE FROM tags WHERE x=1", WRITE)], ["tags"]);
});

Deno.test("reactive select: re-emits when a write hits its table", async () => {
  const db = reactiveDB(createDB(":memory:"));
  try {
    await db.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, n INTEGER)");
    await db.execute("INSERT INTO items (n) VALUES (1)");
    const q = await db.select<{ id: number; n: number }>(
      "SELECT * FROM items ORDER BY id",
    );
    assertEquals(q.rows.length, 1);

    const seen: number[] = [];
    const off = q.subscribe((rows) => seen.push(rows.length));
    await db.execute("INSERT INTO items (n) VALUES (2)");
    await db.execute("INSERT INTO items (n) VALUES (3)");
    assertEquals(q.rows.length, 3, "live rows updated in place");
    assertEquals(seen, [2, 3], "subscriber notified per invalidating write");

    // A write to an UNRELATED table must not fire.
    await db.execute("CREATE TABLE other (id INTEGER)");
    await db.execute("INSERT INTO other (id) VALUES (9)");
    assertEquals(seen, [2, 3], "unrelated table write does not invalidate");

    off();
    await db.execute("INSERT INTO items (n) VALUES (4)");
    assertEquals(seen, [2, 3], "unsubscribed callback stops firing");
    assertEquals(q.rows.length, 4, "but the live view still refreshes");
  } finally {
    await db.close();
  }
});

Deno.test("reactive select: dispose removes it from the change feed", async () => {
  const db = reactiveDB(createDB(":memory:"));
  try {
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const q = await db.select("SELECT * FROM t");
    let fires = 0;
    q.subscribe(() => fires++);
    q.dispose();
    await db.execute("INSERT INTO t (id) VALUES (1)");
    assertEquals(fires, 0, "a disposed query is not re-run");
  } finally {
    await db.close();
  }
});

Deno.test("reactive select: array transaction invalidates affected tables", async () => {
  const db = reactiveDB(createDB(":memory:"));
  try {
    await db.execute("CREATE TABLE items (id INTEGER PRIMARY KEY)");
    const q = await db.select("SELECT * FROM items");
    let fires = 0;
    q.subscribe(() => fires++);
    await db.transaction([
      { sql: "INSERT INTO items (id) VALUES (1)" },
      { sql: "INSERT INTO items (id) VALUES (2)" },
    ]);
    assertEquals(fires, 1, "one invalidation after the transaction commits");
    assertEquals(q.rows.length, 2);
  } finally {
    await db.close();
  }
});
