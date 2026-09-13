// A live query must notice every write, including the ones with a conflict
// clause.
//
// SQLite lets every INSERT and UPDATE carry one — `INSERT OR IGNORE INTO t`,
// `UPDATE OR ROLLBACK t SET …` — and the table-extracting pattern had no room
// for one. Two different failures came out of the same gap:
//
//   INSERT OR IGNORE INTO mail …  → matched NOTHING; the write invalidated
//                                   nothing, no subscriber fired, and the
//                                   live query kept serving its old rows.
//   UPDATE OR IGNORE mail SET …   → matched the table "or" — a WRONG answer
//                                   rather than a missing one.
//
// Measured before the fix: `q.rows` said 1 while the table held 2, with no
// subscriber notified and nothing logged. This file's own header says "Loud,
// never silent — a live query that stopped refreshing is a UI quietly showing
// stale rows, which is exactly what this file exists to prevent."
import { assert, assertEquals } from "@std/assert";
import { createDB } from "../src/server-entry.ts";
import { _resetReactiveWarnings, reactiveDB } from "../src/db/reactive.ts";
import { writeTablesIn } from "../src/db/sql-shape.ts";

Deno.test("reactive: a conflict-clause write refreshes the live query", async () => {
  const db = reactiveDB(createDB(":memory:"));
  try {
    await db.execute(
      "CREATE TABLE mail (id INTEGER PRIMARY KEY, folder TEXT NOT NULL, unread INTEGER NOT NULL)",
    );
    const q = await db.select<{ n: number }>("SELECT COUNT(*) AS n FROM mail");
    const seen: number[] = [];
    q.subscribe((rows) => seen.push(rows[0]!.n));

    await db.execute(
      "INSERT INTO mail (folder, unread) VALUES ('inbox', 1)",
    );
    assertEquals(q.rows[0]!.n, 1, "a plain insert always worked");

    await db.execute(
      "INSERT OR IGNORE INTO mail (folder, unread) VALUES ('inbox', 1)",
    );
    assertEquals(
      q.rows[0]!.n,
      2,
      "an INSERT OR IGNORE is still an insert — the live query must see it",
    );

    await db.execute("UPDATE OR IGNORE mail SET unread = 0");
    const unread = (await db.query<{ n: number }>(
      "SELECT SUM(unread) AS n FROM mail",
    )).rows[0]!.n;
    assertEquals(unread, 0, "the update really did land");
    assert(
      seen.length >= 3,
      `every write must notify — subscriber saw ${JSON.stringify(seen)}`,
    );

    q.dispose();
  } finally {
    await db.close().catch(() => {});
  }
});

// The pattern itself, since a live query going stale is invisible from the
// outside and a rule that matches the wrong thing is worse than one that
// matches nothing.
Deno.test("reactive: the write-table parser reads conflict clauses correctly", () => {
  // The parser the wrapper actually uses (it once tested a regex COPY, which
  // proved the copy).
  const t = (sql: string) => [...writeTablesIn(sql)].sort();

  assertEquals(t("INSERT INTO mail (a) VALUES (1)"), ["mail"]);
  assertEquals(t("INSERT OR IGNORE INTO mail (a) VALUES (1)"), ["mail"]);
  assertEquals(t("INSERT OR REPLACE INTO mail (a) VALUES (1)"), ["mail"]);
  assertEquals(t("INSERT OR ROLLBACK INTO mail (a) VALUES (1)"), ["mail"]);
  assertEquals(t("UPDATE mail SET a = 1"), ["mail"]);
  assertEquals(t("UPDATE OR IGNORE mail SET a = 1"), ["mail"]);
  assertEquals(t("UPDATE OR ROLLBACK mail SET a = 1"), ["mail"]);
  assertEquals(t("DELETE FROM mail WHERE a = 1"), ["mail"]);
  assertEquals(t("REPLACE INTO mail (a) VALUES (1)"), ["mail"]);
  // A table whose name merely STARTS with "or" is not a conflict clause.
  assertEquals(t("UPDATE ordered_items SET a = 1"), ["ordered_items"]);
  // A schema qualifier is not the table — this used to answer "main".
  assertEquals(t(`DELETE FROM main."t" WHERE id = 1`), ["t"]);
  assertEquals(t("UPDATE temp.mail SET a = 1"), ["mail"]);
  // …and SQLite's bracket quoting used to match nothing at all.
  assertEquals(t("INSERT INTO [mail] (a) VALUES (1)"), ["mail"]);
});

// The other half: a write this cannot attribute must be SAID. A silent miss is
// how the original defect stayed invisible.
Deno.test("reactive: a write it cannot attribute is reported, not dropped", async () => {
  _resetReactiveWarnings();
  const warned: string[] = [];
  const origWarn = console.warn;
  const origErr = console.error;
  const cap = (...a: unknown[]) => warned.push(a.map(String).join(" "));
  console.warn = cap;
  console.error = cap;
  const db = reactiveDB(createDB(":memory:"));
  try {
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    // A table name the pattern genuinely cannot read: SQLite accepts a BARE
    // non-ASCII identifier, and a bare name is matched from [A-Za-z_]. (The
    // quoted spelling, `"\u6e2c\u8a66"`, is attributed since sql-shape.ts.)
    await db.execute(`CREATE TABLE \u6e2c\u8a66 (id INTEGER PRIMARY KEY)`);
    await db.execute(`INSERT INTO \u6e2c\u8a66 (id) VALUES (1)`).catch(
      () => {},
    );
  } finally {
    await db.close().catch(() => {});
    console.warn = origWarn;
    console.error = origErr;
  }
  // At least the schema-qualified delete cannot be attributed.
  assert(
    warned.some((w) => w.includes("could not tell which table")),
    `an unattributable write must say so: ${JSON.stringify(warned)}`,
  );
  _resetReactiveWarnings();
});
