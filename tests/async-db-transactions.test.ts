// Audit a4 (D, E): the async DB's transaction and query surface.
//
// D. "Nested transaction" was decided by an instance-wide `_inTransaction`
//    flag set BEFORE the writer lock was taken. So two INDEPENDENT callback
//    transactions started on the same tick — two requests, or a method's
//    transaction racing the persistence loop's own batch — were refused as
//    "nested" (the second saw the first's flag), while the only case the check
//    exists for — a `db.transaction()` reached from INSIDE a callback — is a
//    deadlock, not a race. Nesting is now answered by the async context
//    (AsyncLocalStorage): only code running inside a callback sees the scope;
//    a sibling simply queues on the writer lock.
// E. `db.query("A; B")` ran A and silently dropped B — `prepare()` compiles
//    the first statement only. `execute()` already refused multi-statement
//    SQL; `query()` and `tx.query()` now go through the same gate.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createDB } from "../src/db/async-db.ts";

const setup = async () => {
  const db = createDB(":memory:");
  await db.execute("CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER)");
  return db;
};

Deno.test("db: two CONCURRENT callback transactions both commit (not 'nested')", async () => {
  const db = await setup();
  try {
    // The second starts while the first is MID-FLIGHT (a second request
    // arriving while the first one's transaction is open) — neither is
    // inside the other.
    const first = db.transaction(async (tx) => {
      await tx.execute("INSERT INTO t VALUES ('a', 1)");
      await new Promise((r) => setTimeout(r, 20));
      await tx.execute("INSERT INTO t VALUES ('a2', 1)");
      return "a";
    });
    await new Promise((r) => setTimeout(r, 5));
    const second = db.transaction(async (tx) => {
      await tx.execute("INSERT INTO t VALUES ('b', 2)");
      return "b";
    });
    const [a, b] = await Promise.all([first, second]);
    assertEquals([a, b], ["a", "b"]);
    const { rows } = await db.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM t",
    );
    assertEquals(rows[0]!.n, 3, "both transactions landed");
  } finally {
    await db.close();
  }
});

Deno.test("db: a batch transaction issued while a callback transaction is open queues behind it", async () => {
  const db = await setup();
  try {
    const order: string[] = [];
    const cb = db.transaction(async (tx) => {
      await tx.execute("INSERT INTO t VALUES ('cb', 1)");
      await new Promise((r) => setTimeout(r, 30));
      order.push("callback-commit");
    });
    // The persistence manager's shape: an array batch from OUTSIDE the
    // callback while the callback is mid-flight.
    await new Promise((r) => setTimeout(r, 5));
    const batch = db.transaction([{ sql: "INSERT INTO t VALUES ('batch', 2)" }])
      .then(() => order.push("batch-commit"));
    await Promise.all([cb, batch]);
    assertEquals(order, ["callback-commit", "batch-commit"]);
    const { rows } = await db.query<{ k: string }>(
      "SELECT k FROM t ORDER BY k",
    );
    assertEquals(rows.map((r) => r.k), ["batch", "cb"]);
  } finally {
    await db.close();
  }
});

Deno.test("db: REAL nesting — db.transaction() from inside a callback — is refused, not deadlocked", async () => {
  const db = await setup();
  try {
    const err = await assertRejects(() =>
      db.transaction(async (tx) => {
        await tx.execute("INSERT INTO t VALUES ('outer', 1)");
        // Reached through an await — the async context, not a sync flag,
        // must carry the answer.
        await new Promise((r) => setTimeout(r, 5));
        await db.transaction([{ sql: "INSERT INTO t VALUES ('inner', 2)" }]);
      })
    );
    assert(
      /another transaction is open/.test((err as Error).message),
      (err as Error).message,
    );
    const { rows } = await db.query("SELECT * FROM t");
    assertEquals(rows.length, 0, "the outer transaction rolled back");
    // And the connection is still usable afterwards.
    await db.execute("INSERT INTO t VALUES ('after', 3)");
  } finally {
    await db.close();
  }
});

Deno.test("db: query() refuses multi-statement SQL instead of running the first", async () => {
  const db = await setup();
  try {
    await db.execute("INSERT INTO t VALUES ('x', 1)");
    const err = await assertRejects(() => db.query("SELECT 1; DELETE FROM t"));
    assert(
      /db\.query\(\) runs exactly ONE statement/.test((err as Error).message),
    );
    const { rows } = await db.query("SELECT * FROM t");
    assertEquals(rows.length, 1, "nothing ran");
    await db.transaction(async (tx) => {
      const e2 = await assertRejects(() => tx.query("SELECT 1; SELECT 2"));
      assert(
        /tx\.query\(\) runs exactly ONE statement/.test((e2 as Error).message),
      );
    });
  } finally {
    await db.close();
  }
});
