// Round 5 (db tier): the one-statement rule, where it was missing and where it
// misfired.
//
//  • `db.transaction([{ sql: "A; B" }])` — the batch form never asked. The
//    worker `prepare()`s each entry, which compiles the FIRST statement and
//    drops the rest: A committed, the call resolved, B never ran. The exact
//    silent partial migration `execute()` has refused since it learned to.
//  • A `CREATE TRIGGER` whose body touches a column like `end_at` or
//    `case_no` — the trigger lexer read letters only, so it saw the keyword
//    END (or CASE) inside the identifier, closed the body early (or never),
//    and refused a valid one-statement trigger as "3 statements".

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { countSqlStatements, createDB } from "../src/db/async-db.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("db: a transaction entry holding two statements runs as 1.0.11 did, and says what it dropped", async () => {
  // 1.0.11 RESOLVED this batch (A ran, B was dropped by `prepare()`), and the
  // surface is frozen: refusing it now would break an app that works today.
  // So the behaviour stays and the drop is said, once, naming the entry.
  const dir = await tempDir("db-one-stmt-");
  const db = createDB(join(dir, "state.db"));
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ["log", "warn", "error"] as const) {
    console[k] = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  }
  try {
    await db.execute("CREATE TABLE a (v INTEGER)");
    const batch = [
      { sql: "INSERT INTO a (v) VALUES (0)" },
      { sql: "INSERT INTO a (v) VALUES (1); INSERT INTO a (v) VALUES (2)" },
    ];
    await db.transaction(batch);
    await db.transaction(batch);
    assertEquals(
      (await db.query("SELECT v FROM a ORDER BY rowid")).rows,
      [{ v: 0 }, { v: 1 }, { v: 0 }, { v: 1 }],
      "1.0.11's result: each entry's FIRST statement ran",
    );
    const said = lines.filter((l) => l.includes("exactly ONE statement"));
    assertEquals(said.length, 1, `said once: ${lines.join(" | ")}`);
    assert(said[0]!.includes("VALUES (2)"), `names the entry: ${said[0]}`);
  } finally {
    Object.assign(console, orig);
    await db.close();
    await dropTempDir(dir);
  }
});

Deno.test("db: a trigger touching end_*/case_*/begin_* columns is ONE statement", async () => {
  const bodies = [
    "UPDATE a SET end_at = 1 WHERE rowid = new.rowid;",
    "UPDATE a SET case_no = 1 WHERE rowid = new.rowid;",
    "UPDATE a SET begin_at = 1 WHERE rowid = new.rowid;",
  ];
  const triggers = bodies.map((b, i) =>
    `CREATE TRIGGER tr${i} AFTER INSERT ON a BEGIN ${b} END`
  );
  assertEquals(triggers.map(countSqlStatements), [1, 1, 1]);
  // …and a statement after such a trigger is still counted.
  assertEquals(countSqlStatements(`${triggers[0]}; DROP TABLE a;`), 2);

  const dir = await tempDir("db-one-stmt-trig-");
  const db = createDB(join(dir, "state.db"));
  try {
    await db.execute(
      "CREATE TABLE a (v INTEGER, end_at INTEGER, case_no INTEGER, begin_at INTEGER)",
    );
    for (const t of triggers) await db.execute(t);
    await db.execute("INSERT INTO a (v) VALUES (7)");
    assertEquals(
      (await db.query("SELECT end_at, case_no, begin_at FROM a")).rows,
      [{ end_at: 1, case_no: 1, begin_at: 1 }],
    );
  } finally {
    await db.close();
    await dropTempDir(dir);
  }
});

// "Once per entry, at most 100" — past the cap an entry was no longer
// remembered, so it warned on EVERY call: a batch whose SQL carries inlined
// values (a new text per call) logged one line per call for the life of the
// process, the flood the cap exists to prevent.
Deno.test("db: the multi-statement entry warning stays bounded past its cap", async () => {
  const dir = await tempDir("db-one-stmt-cap-");
  const db = createDB(join(dir, "state.db"));
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ["log", "warn", "error"] as const) {
    console[k] = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  }
  try {
    await db.execute("CREATE TABLE a (v INTEGER)");
    const batch = Array.from({ length: 120 }, (_, i) => ({
      sql: `INSERT INTO a (v) VALUES (${i}); SELECT ${i}`,
    }));
    assertEquals(batch.length, 120);
    const said = () =>
      lines.filter((l) => l.includes("exactly ONE statement")).length;
    await db.transaction(batch);
    const first = said();
    assert(first > 0 && first <= 100, `bounded: ${first}`);
    await db.transaction(batch);
    assertEquals(said(), first, "no entry is warned about twice");
  } finally {
    Object.assign(console, orig);
    await db.close();
    await dropTempDir(dir);
  }
});
