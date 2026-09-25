// Round 5 (db tier): a callback `db.transaction()` whose own BEGIN was
// REFUSED still sent ROLLBACK — its catch said "Only ROLLBACK if BEGIN
// succeeded" and did not check. BEGIN is refused exactly when a transaction is
// ALREADY open on the writer connection (an app's `execute("BEGIN")` …
// `execute("COMMIT")` spanning awaits), so that ROLLBACK undid SOMEONE ELSE'S
// transaction: its first half vanished, its later statements ran in autocommit
// and landed alone, and its COMMIT failed — one atomic unit torn in two.

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { createDB } from "../src/db/async-db.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("db: a callback transaction whose BEGIN is refused never rolls back the transaction already open", async () => {
  const dir = await tempDir("db-foreign-begin-");
  const db = createDB(join(dir, "state.db"));
  try {
    await db.execute("CREATE TABLE a (v TEXT)");
    await db.execute("CREATE TABLE b (v TEXT)");
    await db.execute("BEGIN");
    await db.execute("INSERT INTO a VALUES ('first')");
    await assertRejects(
      () =>
        db.transaction(async (tx) => {
          await tx.execute("INSERT INTO b VALUES ('cb')");
        }),
      Error,
      "within a transaction",
    );
    await db.execute("INSERT INTO a VALUES ('second')");
    await db.execute("COMMIT"); // the open transaction is still there
    assertEquals(
      (await db.query<{ v: string }>("SELECT v FROM a ORDER BY rowid")).rows
        .map((r) => r.v),
      ["first", "second"],
      "the open transaction landed WHOLE",
    );
    assertEquals((await db.query("SELECT v FROM b")).rows, []);
  } finally {
    await db.close();
    await dropTempDir(dir);
  }
});
