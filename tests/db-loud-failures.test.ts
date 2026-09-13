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
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
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
  // …and what follows its END is counted. `CREATE TRIGGER` used to return a
  // flat 1 WITHOUT looking past the body, so anything after it rode in free:
  // SQLite prepared the trigger, discarded the rest, reported `changes` for
  // the trigger alone and raised nothing. That is the partial-migration
  // failure the rejection message describes AND the property that keeps the
  // `am sql` route from being a multi-statement injection surface.
  assertEquals(
    countSqlStatements(
      "CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; END; DROP TABLE x;",
    ),
    2,
  );
  assertEquals(
    countSqlStatements(
      "CREATE TEMP TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; END; DROP TABLE x; DROP TABLE y;",
    ),
    3,
  );
  // A CASE … END inside the body does not close it early.
  assertEquals(
    countSqlStatements(
      "CREATE TRIGGER t AFTER INSERT ON x BEGIN UPDATE y SET n = CASE WHEN 1 THEN 2 ELSE 3 END; END;",
    ),
    1,
  );
  // An `END` inside a string or a comment is text, not the body's close.
  assertEquals(
    countSqlStatements(
      "CREATE TRIGGER t AFTER INSERT ON x BEGIN INSERT INTO z VALUES ('END; DROP TABLE q;'); END;",
    ),
    1,
  );
  // A malformed trigger whose body never closes falls through to the ordinary
  // count — ≥2, so it is REFUSED. The safe direction for this guard.
  assert(
    countSqlStatements(
      "CREATE TRIGGER t AFTER INSERT ON x SELECT 1; SELECT 2;",
    ) >
      1,
  );
  assertEquals(multiStatementRejection("SELECT 1"), null);
  assert(
    multiStatementRejection(
      "CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; END; DROP TABLE x;",
    ),
    "a statement smuggled in after a trigger body must be refused",
  );
  const msg = multiStatementRejection(
    "CREATE TABLE a (id INT); CREATE TABLE b (id INT)",
  );
  assert(msg && msg.includes("db.transaction("), `names the fix: ${msg}`);
});

// ── A closed handle stays closed ──────────────────────────────────────
//
// `close()` ends with `ready = null; writerWorker = null`, which is exactly
// what `ensureWorkers()` reads as "never opened" — so one late `db.query()`
// (an effect, a timer, an `onStop` hook racing shutdown) spawned the whole
// worker pool again, answered happily, and left a live Worker holding the
// event loop open forever: 14 ms of work, then a `timeout` kill at 20 s. On
// `:memory:` the resurrected pool is a DIFFERENT, empty database, so the
// answer comes from nothing at all. This file already documents fixing that
// same "a live worker keeps the event loop open" failure on the OPEN path.
Deno.test("db: a query after close() is refused, not answered by a new pool", async () => {
  const db = createDB(":memory:");
  await db.execute("CREATE TABLE t (v TEXT)");
  await db.execute("INSERT INTO t VALUES ('a')");
  await db.close();
  const err = await assertRejects(() => db.query("SELECT v FROM t"));
  assertStringIncludes((err as Error).message, "CLOSED");
  assertStringIncludes((err as Error).message, "SELECT v FROM t");
  // Writes too — the same gate, so neither door re-opens it.
  await assertRejects(() => db.execute("INSERT INTO t VALUES ('b')"));
  // …and closing twice is still a no-op, not an error.
  await db.close();
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
