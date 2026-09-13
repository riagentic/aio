// A write issued through `db.query()` must not be swallowed by someone else's
// rollback.
//
// The serial writer lock's own comment says it exists so that "all writes
// (execute + transaction) queue through this so standalone execute() calls can
// never interleave into an open transaction". `query()` was not in that set —
// and with the default `readers: 0` it runs on the WRITER worker, the same
// connection the open transaction is using.
//
// So a `DELETE` issued through `query()` while a callback transaction was open
// JOINED that transaction, and went down with its ROLLBACK. Measured: the call
// resolved `true` with `changes: 0`, the transaction reported the rollback,
// and the row was still there. Nothing was logged. `docs/persistence/sqlite.md`
// draws `query()` as the readonly path, so nothing teaches an author otherwise
// until a write disappears inside an unrelated failure.
import { assert, assertEquals } from "@std/assert";
import { createDB } from "../src/server-entry.ts";

Deno.test("db.query(): a write through it is not lost in another transaction's rollback", async () => {
  const db = createDB(":memory:");
  try {
    await db.execute(
      "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)",
    );
    await db.execute("INSERT INTO t (id, v) VALUES (1,'a'), (2,'b')");

    // A transaction that works for a while and then fails its business rule.
    const tx = db.transaction(async (t) => {
      await t.execute("UPDATE t SET v = 'z' WHERE id = 2");
      await new Promise((r) => setTimeout(r, 50));
      throw new Error("business rule failed — roll back");
    }).catch((e: unknown) => `rolled back: ${(e as Error).message}`);

    // …and an unrelated delete, issued mid-flight through `query()`.
    await new Promise((r) => setTimeout(r, 10));
    const del = db.query("DELETE FROM t WHERE id = 1");

    const txResult = await tx;
    await del;
    assert(
      String(txResult).startsWith("rolled back"),
      `the transaction must still roll back: ${txResult}`,
    );

    const rows = (await db.query<{ id: number; v: string }>(
      "SELECT id, v FROM t ORDER BY id",
    )).rows;
    assertEquals(
      rows,
      [{ id: 2, v: "b" }],
      "the DELETE resolved successfully, so its row must be gone — and row 2 " +
        "must be back to 'b' because THAT write was the one rolled back",
    );
  } finally {
    await db.close().catch(() => {});
  }
});

// The rule that decides whether a statement takes the lock. A false positive
// costs one turn of the lock; a false negative is the silent loss above, so it
// is deliberately generous — and pinned here, because a rule that matches
// nothing would restore the bug in full while every other test still passed.
Deno.test("db.query(): reads still take the read path, writes take the lock", async () => {
  const db = createDB(":memory:");
  try {
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    // Plain reads keep working, including the shapes a leading comment or
    // whitespace produces.
    assertEquals((await db.query("SELECT 1 AS n")).rows, [{ n: 1 }]);
    assertEquals(
      (await db.query("  -- a note\n  SELECT 2 AS n")).rows,
      [{ n: 2 }],
    );
    assertEquals(
      (await db.query("WITH x AS (SELECT 3 AS n) SELECT n FROM x")).rows,
      [{ n: 3 }],
    );
    // …and a write behind a comment is still recognised as a write.
    await db.query("/* set up */ INSERT INTO t (id) VALUES (7)");
    assertEquals((await db.query("SELECT id FROM t")).rows, [{ id: 7 }]);
  } finally {
    await db.close().catch(() => {});
  }
});
