// Round 5 (db tier): boot reconciles a `db:` table's schema against the file —
// a column ADDED, REMOVED or re-CASED is resolved or named — but a column
// RETYPED (`text()` → `integer()`) passed in silence. `CREATE TABLE IF NOT
// EXISTS` is a no-op, so the stored column kept its old affinity, and the
// write-time affinity check reads the DECLARED type, so it said nothing either:
// state held 42, the TEXT column stored "42.0", and the next boot put the
// string "42.0" into a field the app types as a number. Boot now names the
// retyped column once (a warning — the table still works, only the values
// coerce), with the way out.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createDB } from "../src/db/async-db.ts";
import { _resetDbReports, initSchema } from "../src/db/state-sync.ts";
import { integer, pk, table, text } from "../src/server/sql.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

async function capturingWarn(fn: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void seen.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.warn = orig;
  }
  return seen;
}

Deno.test("db schema: a column retyped between runs is named at boot, not coerced in silence", async () => {
  const dir = await tempDir("db-retyped-");
  const db = createDB(join(dir, "state.db"));
  _resetDbReports();
  try {
    await initSchema(db, { items: table({ id: pk(), n: text() }) });
    await db.execute("INSERT INTO items (id, n) VALUES (1, 'hello')");

    const retyped = await capturingWarn(() =>
      initSchema(db, { items: table({ id: pk(), n: integer() }) })
    );
    assert(
      retyped.some((w) =>
        w.includes('"items"') && w.includes('"n"') && w.includes("TEXT") &&
        w.includes("INTEGER")
      ),
      `the retyped column is named with both types: ${retyped.join(" | ")}`,
    );

    // Same affinity under another spelling, and an unchanged schema: silent.
    _resetDbReports();
    await db.execute("CREATE TABLE hand (id INTEGER PRIMARY KEY, n INT)");
    const same = await capturingWarn(async () => {
      await initSchema(db, { hand: table({ id: pk(), n: integer() }) });
      await initSchema(db, { items: table({ id: pk(), n: text() }) });
    });
    assertEquals(
      same.filter((w) => w.includes("type")),
      [],
      "no false alarm for INT vs INTEGER, nor for an untouched column",
    );
  } finally {
    _resetDbReports();
    await db.close();
    await dropTempDir(dir);
  }
});
