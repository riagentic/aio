// Schema drift in a column's CONSTRAINTS is said at boot, like a retype.
//
// `CREATE TABLE IF NOT EXISTS` never alters an existing table: `unique: true`
// added to a column enforced nothing (duplicates accepted, no word), and
// `nullable: true` added to a stored NOT NULL column showed up only as a
// failed persist window. And the report for a column the app no longer
// declares said "it is not part of state" while every loaded row carried it.
import { assert, assertEquals } from "@std/assert";
import { createDB } from "../src/db/async-db.ts";
import { _resetDbReports, initSchema } from "../src/db/state-sync.ts";
import { integer, pk, table, text } from "../src/server/sql.ts";

async function bootWarns(
  seed: string[],
  schema: Parameters<typeof initSchema>[1],
): Promise<string[]> {
  _resetDbReports();
  const db = createDB(":memory:");
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => warns.push(a.map(String).join(" "));
  try {
    for (const sql of seed) await db.execute(sql);
    await initSchema(db, schema);
  } finally {
    console.warn = orig;
    await db.close();
    _resetDbReports();
  }
  return warns;
}

Deno.test("db drift: UNIQUE and NOT NULL changes on an existing table are reported, naming the column", async () => {
  const warns = await bootWarns(
    [
      "CREATE TABLE items (id INTEGER PRIMARY KEY, sku TEXT NOT NULL, " +
      "note TEXT NOT NULL, opt TEXT, code TEXT NOT NULL UNIQUE)",
      "INSERT INTO items VALUES (1, 'a', 'n', NULL, 'c')",
    ],
    {
      items: table({
        id: pk(),
        sku: text({ unique: true }),
        note: text({ nullable: true }),
        opt: text(),
        code: text(),
      }),
    },
  );
  const about = (col: string) =>
    warns.filter((w) => w.includes(`column "${col}" is`)).join(" | ");
  assert(
    about("sku").includes("declared UNIQUE but stored without"),
    about("sku"),
  );
  assert(
    about("note").includes("declared nullable but stored NOT NULL"),
    about("note"),
  );
  assert(
    about("opt").includes("declared NOT NULL but stored nullable"),
    about("opt"),
  );
  assert(
    about("code").includes("stored UNIQUE but declared without"),
    about("code"),
  );
});

Deno.test("db drift: matching constraints, an app's own UNIQUE INDEX and an empty rebuilt table say nothing", async () => {
  const declared = table({
    id: pk(),
    sku: text({ unique: true }),
    note: text({ nullable: true }),
    qty: integer(),
  });
  const quiet = (ws: string[]) =>
    ws.filter((w) => /declared|stored UNIQUE/.test(w) && /column "/.test(w));
  // Same shape aio itself would create.
  assertEquals(
    quiet(
      await bootWarns(
        ["CREATE TABLE items (id INTEGER PRIMARY KEY, sku TEXT NOT NULL UNIQUE, note TEXT, qty INTEGER NOT NULL)"],
        { items: declared },
      ),
    ),
    [],
  );
  // The app's own unique index satisfies `unique: true`; an index on a column
  // declared without `unique` is the app's, not drift.
  assertEquals(
    quiet(
      await bootWarns(
        [
          "CREATE TABLE items (id INTEGER PRIMARY KEY, sku TEXT NOT NULL, note TEXT, qty INTEGER NOT NULL)",
          "CREATE UNIQUE INDEX ix_sku ON items (sku)",
          "CREATE UNIQUE INDEX ix_qty ON items (qty)",
        ],
        { items: declared },
      ),
    ),
    [],
  );
  // Empty + a missing column → rebuilt in the declared shape: nothing stale.
  assertEquals(
    quiet(
      await bootWarns(
        ["CREATE TABLE items (id INTEGER PRIMARY KEY, sku TEXT)"],
        { items: declared },
      ),
    ),
    [],
  );
});

Deno.test("db drift: an undeclared stored column is described as it behaves — loaded, never written back", async () => {
  const warns = await bootWarns(
    ["CREATE TABLE items (id INTEGER PRIMARY KEY, v TEXT NOT NULL, tag TEXT)"],
    { items: table({ id: pk(), v: text() }) },
  );
  const w = warns.find((x) => x.includes(`column "tag"`)) ?? "";
  assert(w.includes("still loaded") && w.includes("never written back"), w);
  assert(!w.includes("not part of state"), w);
});
