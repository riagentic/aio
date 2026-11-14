// A plain object in the first position that cannot be a named-parameter bag
// is refused by name — never shifts the positional params.
//
// node:sqlite reads ANY plain object in params[0] as a bag of named
// parameters and binds the REST positionally from there: `execute("INSERT
// INTO ev (meta, n) VALUES (?, ?)", [{}, 5])` stored meta = 5 and n = NULL,
// reported `changes: 1`, and said nothing. A bag is real only alone, with
// keys (`[{ v: 1 }]` for `:v`).
import { assertEquals, assertRejects } from "@std/assert";
import { createDB } from "../src/db/async-db.ts";

async function withDb(fn: (db: ReturnType<typeof createDB>) => Promise<void>) {
  const db = createDB(":memory:");
  try {
    await db.execute(
      "CREATE TABLE ev (id INTEGER PRIMARY KEY, meta TEXT, n INTEGER)",
    );
    await fn(db);
  } finally {
    await db.close();
  }
}

const count = async (db: ReturnType<typeof createDB>) =>
  (await db.query<{ c: number }>("SELECT count(*) AS c FROM ev")).rows[0]!.c;

Deno.test("db params: a plain object followed by more params, or an empty one, is refused at every door", async () => {
  await withDb(async (db) => {
    const two = "INSERT INTO ev (meta, n) VALUES (?, ?)";
    const one = "INSERT INTO ev (meta) VALUES (?)";
    for (
      const [sql, params] of [
        [two, [{}, 5]],
        [two, [{ a: 1 }, 5]],
        [one, [{}]],
      ] as [string, unknown[]][]
    ) {
      for (
        const run of [
          () => db.execute(sql, params),
          () => db.query(sql + " RETURNING id", params),
          () => db.transaction([{ sql, params }]),
          () => db.transaction((tx) => tx.execute(sql, params)),
          () => db.transaction((tx) => tx.query("SELECT ?, ?", params)),
        ]
      ) {
        await assertRejects(run, Error, "JSON.stringify");
      }
    }
    assertEquals(await count(db), 0, "nothing was stored");
  });
});

Deno.test("db params: a real named-parameter bag still binds", async () => {
  await withDb(async (db) => {
    await db.execute("INSERT INTO ev (meta, n) VALUES (:m, :n)", [
      { m: "x", n: 5 },
    ]);
    const r = await db.query<{ meta: string; n: number }>(
      "SELECT meta, n FROM ev WHERE n = :n",
      [{ n: 5 }],
    );
    assertEquals(r.rows, [{ meta: "x", n: 5 }]);
  });
});

Deno.test("db params: an empty bag on a statement with no parameter still runs", async () => {
  await withDb(async (db) => {
    const r = await db.query<{ v: number }>("SELECT 1 AS v", [{}]);
    assertEquals(r.rows, [{ v: 1 }]);
  });
});
