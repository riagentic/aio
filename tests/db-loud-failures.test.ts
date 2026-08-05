// Two silent SQLite failures, made loud.
//
// 1. `db.execute()` ran only the FIRST statement of a multi-statement string:
//    `execute("CREATE TABLE a(…); CREATE TABLE b(…)")` created `a`, returned
//    `changes: 0`, and raised nothing — a pasted migration applied partially.
//    The fix is a REJECT, not multi-exec: one statement per call is the
//    property the `am sql` trojan route relies on.
//
// 2. One integer beyond ±2^53 in a table poisoned every read of it —
//    `node:sqlite` throws `RangeError: Value is too large…`, and at boot
//    `loadTables` re-threw a message naming neither table nor column.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createDB } from "../src/db/async-db.ts";
import {
  countSqlStatements,
  multiStatementRejection,
} from "../src/db/async-db.ts";
import { loadTables } from "../src/db/state-sync.ts";
import { integer, pk, table, text } from "../src/server/sql.ts";

// ── Statement counting ────────────────────────────────────────────────

Deno.test("sql: statement counting ignores literals, identifiers and comments", () => {
  assertEquals(countSqlStatements("SELECT 1"), 1);
  assertEquals(countSqlStatements("SELECT 1;"), 1);
  assertEquals(countSqlStatements("  SELECT 1 ;  \n "), 1);
  assertEquals(countSqlStatements("SELECT 1; SELECT 2"), 2);
  assertEquals(countSqlStatements("SELECT 1;;;SELECT 2;"), 2);
  // A semicolon inside a string / quoted identifier / comment is not a split.
  assertEquals(countSqlStatements("INSERT INTO t VALUES ('a;b')"), 1);
  assertEquals(countSqlStatements(`INSERT INTO t VALUES ('it''s; fine')`), 1);
  assertEquals(countSqlStatements(`SELECT "a;b" FROM t`), 1);
  assertEquals(countSqlStatements("SELECT [a;b] FROM t"), 1);
  assertEquals(countSqlStatements("SELECT 1 -- ; not a statement\n"), 1);
  assertEquals(countSqlStatements("SELECT 1 /* ; nope ; */"), 1);
  // A trigger body is one statement however many semicolons it holds.
  assertEquals(
    countSqlStatements(
      "CREATE TRIGGER t AFTER INSERT ON x BEGIN UPDATE y SET n = 1; DELETE FROM z; END;",
    ),
    1,
  );
  assertEquals(multiStatementRejection("SELECT 1"), null);
  const msg = multiStatementRejection(
    "CREATE TABLE a (id INT); CREATE TABLE b (id INT)",
  );
  assert(msg && msg.includes("db.transaction("), `names the fix: ${msg}`);
});

// ── The real thing ────────────────────────────────────────────────────

Deno.test("db: execute() refuses multi-statement SQL instead of applying half of it", async () => {
  const db = createDB(":memory:");
  try {
    await assertRejects(
      () =>
        db.execute(
          "CREATE TABLE a (id INTEGER PRIMARY KEY); CREATE TABLE b (id INTEGER PRIMARY KEY)",
        ),
      Error,
      "exactly ONE statement",
    );
    // Nothing was applied — not even the first half.
    const { rows } = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    assertEquals(rows.map((r) => r.name), []);

    // The documented way to run several statements still works, atomically.
    await db.transaction([
      { sql: "CREATE TABLE a (id INTEGER PRIMARY KEY)" },
      { sql: "CREATE TABLE b (id INTEGER PRIMARY KEY)" },
    ]);
    const after = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    assertEquals(after.rows.map((r) => r.name), ["a", "b"]);

    // …and a single statement with a semicolon inside a literal is fine.
    await db.execute("INSERT INTO a (id) VALUES (1) /* one; statement */");
    assertEquals((await db.query("SELECT id FROM a")).rows.length, 1);
  } finally {
    await db.close();
  }
});

Deno.test("db: a too-large integer names the table and the column", async () => {
  const db = createDB(":memory:");
  try {
    await db.execute(
      "CREATE TABLE ledger (id INTEGER PRIMARY KEY, memo TEXT NOT NULL, amount INTEGER NOT NULL)",
    );
    // Beyond 2^53 — SQLite stores it happily, JS cannot read it back.
    await db.execute(
      "INSERT INTO ledger (id, memo, amount) VALUES (1, 'big', 9007199254740993)",
    );

    const schema = {
      ledger: table({ id: pk(), memo: text(), amount: integer() }),
    };
    const err = await assertRejects(() => loadTables(db, schema), Error);
    assert(
      /table "ledger"/.test(err.message),
      `names the table: ${err.message}`,
    );
    assert(
      /column "amount"/.test(err.message),
      `names the column: ${err.message}`,
    );
    assert(
      /2\^53|too large/i.test(err.message),
      `explains the cause: ${err.message}`,
    );
    assert(/CAST\(amount AS TEXT\)/.test(err.message), err.message);
  } finally {
    await db.close();
  }
});

Deno.test("db: a table that reads fine is unaffected", async () => {
  const db = createDB(":memory:");
  try {
    await db.execute(
      "CREATE TABLE ok (id INTEGER PRIMARY KEY, v TEXT NOT NULL)",
    );
    await db.execute("INSERT INTO ok (id, v) VALUES (1, 'a')");
    const loaded = await loadTables(db, { ok: table({ id: pk(), v: text() }) });
    assertEquals(loaded.ok, [{ id: 1, v: "a" }]);
  } finally {
    await db.close();
  }
});
