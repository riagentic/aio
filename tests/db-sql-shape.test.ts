// One lexer for "does this SQL write?" and "which tables?" (src/db/sql-shape.ts).
//
// Each shape below was a real miss: `WITH … DELETE` through `db.query()` took
// the read path and was undone by another caller's ROLLBACK; `FROM main.mail`
// read as the table "main", `FROM [mail]` as nothing, and `FROM folders, mail`
// as "folders" alone — so the live queries built on them never refreshed.
import { assertEquals } from "@std/assert";
import {
  looksLikeWrite,
  readTablesIn,
  writesRows,
  writeTablesIn,
} from "../src/db/sql-shape.ts";

const reads = (sql: string) => [...readTablesIn(sql).tables].sort();
const writes = (sql: string) => [...writeTablesIn(sql)].sort();

Deno.test("sql-shape: a CTE-prefixed or RETURNING write is a write", () => {
  for (
    const sql of [
      "WITH x AS (SELECT 100 AS id) DELETE FROM t WHERE id IN (SELECT id FROM x)",
      "with recursive r(n) as (select 1) insert into t select n from r",
      "WITH x AS (SELECT 1) UPDATE t SET v = 1",
      "INSERT INTO t (v) VALUES ('a') RETURNING id",
      "/* note */ -- more\n INSERT INTO t (id) VALUES (7)",
      "REPLACE INTO t (id) VALUES (1)",
    ]
  ) {
    assertEquals(writesRows(sql), true, sql);
    assertEquals(looksLikeWrite(sql), true, sql);
  }
  assertEquals(looksLikeWrite("PRAGMA foreign_keys = ON"), true);
  assertEquals(looksLikeWrite("CREATE TABLE t (id INTEGER)"), true);
});

Deno.test("sql-shape: reads stay reads — keywords in strings, identifiers, comments and replace() do not count", () => {
  for (
    const sql of [
      "SELECT 1",
      "WITH x AS (SELECT 3 AS n) SELECT n FROM x",
      "SELECT * FROM t WHERE note = 'please delete me'",
      `SELECT "update" FROM t`,
      "SELECT [delete] FROM t",
      "SELECT replace(v, 'a', 'b') FROM t",
      "WITH x AS (SELECT replace(v,'a','b') AS v FROM t) SELECT * FROM x",
      "SELECT 1 -- then DELETE FROM t",
      "SELECT /* INSERT INTO t */ 1",
      "SELECT updated_at, deleted FROM t",
      "WITH x AS (SELECT updated_at, deleted, inserted FROM t) SELECT * FROM x",
    ]
  ) {
    assertEquals(looksLikeWrite(sql), false, sql);
    assertEquals(writesRows(sql), false, sql);
  }
});

Deno.test("sql-shape: read tables — qualifiers, every quoting, comma joins, aliases", () => {
  assertEquals(reads("SELECT COUNT(*) AS n FROM mail"), ["mail"]);
  assertEquals(reads("SELECT COUNT(*) AS n FROM main.mail"), ["mail"]);
  assertEquals(reads("SELECT * FROM [mail]"), ["mail"]);
  assertEquals(reads(`SELECT * FROM "Mail Box"`), ["mail box"]);
  assertEquals(reads("SELECT * FROM `mail`"), ["mail"]);
  assertEquals(reads("SELECT * FROM 'mail'"), ["mail"]);
  assertEquals(reads(`SELECT * FROM main . "mail" m`), ["mail"]);
  assertEquals(reads("SELECT * FROM folders, mail"), ["folders", "mail"]);
  assertEquals(
    reads("SELECT * FROM folders AS f, main.mail m, tags WHERE f.x = m.y"),
    ["folders", "mail", "tags"],
  );
  assertEquals(
    reads("SELECT * FROM Items i LEFT JOIN tags t ON t.id = i.tag"),
    ["items", "tags"],
  );
  assertEquals(
    reads("SELECT * FROM (SELECT * FROM mail) AS s JOIN folders ON 1"),
    ["folders", "mail"],
  );
  assertEquals(
    reads("SELECT n FROM mail WHERE id IN (SELECT mail_id FROM flags)"),
    ["flags", "mail"],
  );
  // a comma join AFTER a subquery, with a `)` inside a string in the subquery
  assertEquals(
    reads("SELECT * FROM (SELECT ')' AS p FROM flags) s, mail WHERE 1"),
    ["flags", "mail"],
  );
  // a comment hiding a table is not a table
  assertEquals(reads("SELECT * FROM mail -- , secrets"), ["mail"]);
});

Deno.test("sql-shape: a FROM that names no table is flagged; table-valued functions and no-FROM are not", () => {
  assertEquals(readTablesIn("SELECT 1").unattributed, false);
  assertEquals(readTablesIn("SELECT date('now')").unattributed, false);
  assertEquals(
    readTablesIn("SELECT value FROM json_each(?)").unattributed,
    false,
  );
  assertEquals(readTablesIn("SELECT * FROM mail").unattributed, false);
  // SQLite accepts a bare non-ASCII identifier; this lexer does not read it.
  assertEquals(
    readTablesIn("SELECT * FROM 測試").unattributed,
    true,
  );
});

Deno.test("sql-shape: write tables — qualifiers, quoting, conflict clauses, CTE-prefixed", () => {
  assertEquals(writes("INSERT OR IGNORE INTO main.mail (a) VALUES (1)"), [
    "mail",
  ]);
  assertEquals(writes("UPDATE OR ROLLBACK [mail] SET a = 1"), ["mail"]);
  assertEquals(writes(`DELETE FROM "Mail Box" WHERE 1`), ["mail box"]);
  assertEquals(
    writes("WITH x AS (SELECT 1 AS id) DELETE FROM mail WHERE id IN x"),
    ["mail"],
  );
  assertEquals(writes("UPDATE ordered_items SET a = 1"), ["ordered_items"]);
  // a keyword inside a comment names nothing
  assertEquals(writes("SELECT 1 /* DELETE FROM mail */"), []);
});
