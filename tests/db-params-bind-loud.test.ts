// A parameter SQLite cannot bind is refused by name — never stored as NULL.
//
// node:sqlite reads an object in the FIRST position as a bag of named
// parameters; a Date (no own keys) bound nothing, so the `?` became NULL and
// the INSERT reported `changes: 1`. A non-array `params` was spread by the
// worker (a string into its characters). The empty statement answered "not
// an error" as its error, and a boolean/undefined/huge-integer failure named
// a position or a number but never the fix.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createDB } from "../src/db/async-db.ts";

async function withDb(fn: (db: ReturnType<typeof createDB>) => Promise<void>) {
  const db = createDB(":memory:");
  try {
    await db.execute(
      "CREATE TABLE ev (id INTEGER PRIMARY KEY, at TEXT, n INTEGER)",
    );
    await fn(db);
  } finally {
    await db.close();
  }
}

const count = async (db: ReturnType<typeof createDB>) =>
  (await db.query<{ c: number }>("SELECT count(*) AS c FROM ev")).rows[0]!.c;

Deno.test("db params: a Date in the first position is refused, not stored as NULL — every door", async () => {
  await withDb(async (db) => {
    const sql = "INSERT INTO ev (at) VALUES (?)";
    for (
      const run of [
        () => db.execute(sql, [new Date()]),
        () => db.query(sql + " RETURNING id", [new Date()]),
        () => db.transaction([{ sql, params: [new Date()] }]),
        () => db.transaction((tx) => tx.execute(sql, [new Date()])),
      ]
    ) {
      await assertRejects(run, Error, "toISOString");
    }
    for (const v of [new Map(), new Set(), new Uint8Array(2).buffer, [1]]) {
      await assertRejects(() => db.execute(sql, [v]), Error, "NULL");
    }
    assertEquals(await count(db), 0, "nothing was written as NULL");
    // A plain object stays the named-parameter bag it always was.
    await db.execute("INSERT INTO ev (at) VALUES (:at)", [{ at: "named" }]);
    assertEquals(await count(db), 1);
  });
});

Deno.test("db params: a non-array params is refused, not spread", async () => {
  await withDb(async (db) => {
    await assertRejects(
      () => db.query("SELECT ? AS a, ? AS b", "xy" as unknown as unknown[]),
      Error,
      "must be an ARRAY",
    );
    await assertRejects(
      () =>
        db.execute("INSERT INTO ev (n) VALUES (?)", 5 as unknown as unknown[]),
      Error,
      "Wrap a single value",
    );
  });
});

Deno.test("db: an empty statement says so instead of 'not an error'", async () => {
  await withDb(async (db) => {
    for (const sql of ["", "  ", "-- nothing", ";"]) {
      const e = await assertRejects(() => db.execute(sql), Error);
      assert(e.message.includes("no statement"), e.message);
      await assertRejects(() => db.query(sql), Error, "no statement");
    }
  });
});

Deno.test("db: a boolean/undefined parameter and a >2^53 read name the fix", async () => {
  await withDb(async (db) => {
    const sql = "INSERT INTO ev (at, n) VALUES (?, ?)";
    await assertRejects(
      () => db.execute(sql, ["x", true]),
      Error,
      "pass 1 or 0",
    );
    await assertRejects(
      () => db.execute(sql, ["x", undefined]),
      Error,
      "pass null",
    );
    await assertRejects(
      () => db.transaction([{ sql, params: ["x", false] }]),
      Error,
      "parameter 2 is a boolean",
    );
    // A named bag's index is not a position: no positional hint is invented.
    const named = await assertRejects(
      () => db.execute("INSERT INTO ev (n) VALUES (:n)", [{ n: true }]),
      Error,
    );
    assert(!named.message.includes("parameter 1 is"), named.message);
    await db.execute(sql, ["x", 2n ** 60n]);
    await assertRejects(
      () => db.query("SELECT n FROM ev"),
      Error,
      "CAST(col AS TEXT)",
    );
  });
});
