// A `db.transaction()` callback that ran `tx.execute("COMMIT")` ended the
// transaction the callback owns: its later statements ran in autocommit, and a
// throw after it rolled NOTHING back — "rolled back on throw" was false, and
// the framework's own ROLLBACK error ("no transaction is active") was
// swallowed. Transaction control through `tx.*` is refused by name; the
// savepoint statements, which nest inside it, still run.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { createDB } from "../src/db/async-db.ts";
import { controlsTransaction } from "../src/db/sql-shape.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("db: tx.execute(COMMIT) then a throw — refused, the whole callback rolls back", async () => {
  const dir = await tempDir("db-tx-control-");
  const db = createDB(join(dir, "state.db"));
  try {
    await db.execute("CREATE TABLE a (v TEXT)");
    await assertRejects(
      () =>
        db.transaction(async (tx) => {
          await tx.execute("INSERT INTO a VALUES ('before')");
          await tx.execute("COMMIT");
          await tx.execute("INSERT INTO a VALUES ('after')");
          throw new Error("app failure");
        }),
      Error,
      '"COMMIT" is refused inside a db.transaction() callback',
    );
    assertEquals(
      (await db.query("SELECT v FROM a")).rows,
      [],
      "nothing the callback wrote survived its failure",
    );
  } finally {
    await db.close();
    await dropTempDir(dir);
  }
});

Deno.test("db: savepoints still nest inside a callback transaction", async () => {
  const dir = await tempDir("db-tx-savepoint-");
  const db = createDB(join(dir, "state.db"));
  try {
    await db.execute("CREATE TABLE a (v TEXT)");
    await db.transaction(async (tx) => {
      await tx.execute("INSERT INTO a VALUES ('kept')");
      await tx.execute("SAVEPOINT sp");
      await tx.execute("INSERT INTO a VALUES ('undone')");
      await tx.execute("ROLLBACK TO sp");
      await tx.execute("RELEASE sp");
    });
    assertEquals(
      (await db.query<{ v: string }>("SELECT v FROM a")).rows.map((r) => r.v),
      ["kept"],
    );
  } finally {
    await db.close();
    await dropTempDir(dir);
  }
});

Deno.test("controlsTransaction: the statements that end the connection's transaction", () => {
  for (
    const sql of [
      "COMMIT",
      " commit transaction",
      "END",
      "ROLLBACK",
      "rollback transaction",
      "/* x */ BEGIN IMMEDIATE",
      "-- c\nCOMMIT",
    ]
  ) assert(controlsTransaction(sql), sql);
  for (
    const sql of [
      "ROLLBACK TO sp",
      "ROLLBACK TRANSACTION TO SAVEPOINT sp",
      "SAVEPOINT sp",
      "RELEASE sp",
      "INSERT INTO a VALUES ('COMMIT')",
      "SELECT 1",
    ]
  ) assert(!controlsTransaction(sql), sql);
});
