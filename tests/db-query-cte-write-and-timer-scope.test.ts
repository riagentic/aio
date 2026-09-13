// Two async-db seams (src/db/async-db.ts), both reproduced before the fix:
//
// 1. `db.query("WITH x AS (…) DELETE …")` was not recognised as a write — the
//    writer-lock gate read only the LEADING keyword — so it joined a callback
//    transaction that was open on the writer and was undone by that
//    transaction's ROLLBACK. It resolved successfully; the row was still there.
// 2. A timer armed inside `db.transaction(cb)` inherits the async context, so
//    when it fired AFTER COMMIT its own sequential `db.transaction()` was
//    refused as "nested".
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createDB } from "../src/db/async-db.ts";

Deno.test("db.query(): a CTE-prefixed DELETE is not lost in another transaction's rollback", async () => {
  const db = createDB(":memory:");
  try {
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    await db.execute("INSERT INTO t (id, v) VALUES (100, 'victim'), (2, 'b')");
    let release!: () => void;
    const gate = new Promise<void>((r) => release = r);
    const tx = db.transaction(async (t) => {
      await t.execute("UPDATE t SET v = 'z' WHERE id = 2");
      await gate;
      throw new Error("roll back");
    }).catch((e: Error) => e.message);
    await new Promise((r) => setTimeout(r, 20));
    const del = db.query(
      "WITH x AS (SELECT 100 AS id) DELETE FROM t WHERE id IN (SELECT id FROM x)",
    );
    await new Promise((r) => setTimeout(r, 20));
    release();
    assertEquals(await tx, "roll back");
    await del;
    assertEquals(
      (await db.query("SELECT id, v FROM t ORDER BY id")).rows,
      [{ id: 2, v: "b" }],
      "the CTE delete resolved, so row 100 must be gone; row 2 was rolled back",
    );
  } finally {
    await db.close().catch(() => {});
  }
});

Deno.test("db.query(): INSERT … RETURNING reaches the writer even with reader workers", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-db-returning-" });
  const db = createDB(join(dir, "r.db"), { readers: 1 });
  try {
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const r = await db.query<{ id: number }>(
      "INSERT INTO t (v) VALUES ('a') RETURNING id",
    );
    assertEquals(r.rows, [{ id: 1 }]);
    const w = await db.query(
      "WITH x AS (SELECT 1 AS id) DELETE FROM t WHERE id IN (SELECT id FROM x) RETURNING id",
    );
    assertEquals(w.rows, [{ id: 1 }]);
  } finally {
    await db.close().catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("db.transaction(): a timer armed inside a callback may open its own transaction after COMMIT", async () => {
  const db = createDB(":memory:");
  try {
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    let later!: Promise<string>;
    await db.transaction(async (tx) => {
      await tx.execute("INSERT INTO t (v) VALUES ('a')");
      later = new Promise<string>((res) =>
        setTimeout(() => {
          try {
            db.transaction([{ sql: "INSERT INTO t (v) VALUES ('timer')" }])
              .then(() => res("ok"), (e) => res(`rejected: ${e.message}`));
          } catch (e) {
            res(`threw: ${(e as Error).message}`);
          }
        }, 20)
      );
    });
    assertEquals(await later, "ok");
    assertEquals(
      (await db.query("SELECT v FROM t ORDER BY id")).rows,
      [{ v: "a" }, { v: "timer" }],
    );
    // …and real nesting is still refused.
    const nested = await db.transaction(async () => {
      try {
        await db.transaction([{ sql: "SELECT 1" }]);
        return "ran";
      } catch (e) {
        return (e as Error).message;
      }
    });
    assertEquals(String(nested).includes("another transaction is open"), true);
  } finally {
    await db.close().catch(() => {});
  }
});
