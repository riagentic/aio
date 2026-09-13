// Live queries refresh for every common FROM shape, and for writes sent
// through `query()` (src/db/reactive.ts over src/db/sql-shape.ts).
//
// Measured before the fix — after two inserts into `mail`, these live
// queries still said 0: `FROM main.mail` (tables ["main"]), `FROM [mail]`
// (tables []), `FROM folders, mail` (tables ["folders"]); and an
// `INSERT … RETURNING` through `query()` invalidated nothing at all.
import { assert, assertEquals } from "@std/assert";
import { createDB } from "../src/db/async-db.ts";
import { _resetReactiveWarnings, reactiveDB } from "../src/db/reactive.ts";

Deno.test("reactive: qualified, bracketed and comma-joined reads refresh on write", async () => {
  const db = reactiveDB(createDB(":memory:"));
  try {
    await db.execute("CREATE TABLE mail (id INTEGER PRIMARY KEY, f TEXT)");
    await db.execute("CREATE TABLE folders (name TEXT)");
    await db.execute("INSERT INTO folders (name) VALUES ('inbox')");
    const views = {
      qualified: await db.select<{ n: number }>(
        "SELECT COUNT(*) AS n FROM main.mail",
      ),
      bracketed: await db.select<{ n: number }>(
        "SELECT COUNT(*) AS n FROM [mail]",
      ),
      commaJoin: await db.select<{ n: number }>(
        "SELECT COUNT(*) AS n FROM folders, mail",
      ),
    };
    for (const [k, v] of Object.entries(views)) {
      assert(v.tables.has("mail"), `${k} must read mail: ${[...v.tables]}`);
    }
    await db.execute("INSERT INTO mail (f) VALUES ('inbox')");
    for (const [k, v] of Object.entries(views)) {
      assertEquals(v.rows[0]!.n, 1, `${k} after execute()`);
    }
    for (const v of Object.values(views)) v.dispose();
  } finally {
    await db.close().catch(() => {});
  }
});

Deno.test("reactive: a write through query() (INSERT … RETURNING, WITH … DELETE) refreshes", async () => {
  const db = reactiveDB(createDB(":memory:"));
  try {
    await db.execute("CREATE TABLE mail (id INTEGER PRIMARY KEY, f TEXT)");
    const q = await db.select<{ n: number }>("SELECT COUNT(*) AS n FROM mail");
    const seen: number[] = [];
    q.subscribe((rows) => seen.push(rows[0]!.n));
    const ins = await db.query<{ id: number }>(
      "INSERT INTO mail (f) VALUES ('inbox') RETURNING id",
    );
    assertEquals(ins.rows, [{ id: 1 }]);
    assertEquals(q.rows[0]!.n, 1, "INSERT … RETURNING via query()");
    await db.query(
      "WITH x AS (SELECT 1 AS id) DELETE FROM mail WHERE id IN (SELECT id FROM x)",
    );
    assertEquals(q.rows[0]!.n, 0, "WITH … DELETE via query()");
    assertEquals(seen, [1, 0]);
    // a plain read through query() does not re-run anything
    await db.query("SELECT * FROM mail");
    assertEquals(seen, [1, 0]);
    q.dispose();
  } finally {
    await db.close().catch(() => {});
  }
});

Deno.test("reactive: a live query whose FROM names no recognisable table says so", async () => {
  _resetReactiveWarnings();
  const warned: string[] = [];
  const orig = { warn: console.warn, error: console.error };
  const cap = (...a: unknown[]) => warned.push(a.map(String).join(" "));
  console.warn = cap;
  console.error = cap;
  const db = reactiveDB(createDB(":memory:"));
  try {
    await db.execute(`CREATE TABLE 測試 (id INTEGER PRIMARY KEY)`);
    await db.select(`SELECT COUNT(*) AS n FROM 測試`);
    await db.select("SELECT 1 AS n"); // no FROM: nothing to refresh, no noise
  } finally {
    await db.close().catch(() => {});
    console.warn = orig.warn;
    console.error = orig.error;
    _resetReactiveWarnings();
  }
  const hits = warned.filter((w) =>
    w.includes("could not tell which table this live query reads")
  );
  assertEquals(hits.length, 1, JSON.stringify(warned));
});
