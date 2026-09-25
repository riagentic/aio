// Round 2 (db tier): with no reader pool, `db.query()` runs on the WRITER
// connection — the one a callback `db.transaction()` holds its BEGIN open on.
// A read from OUTSIDE the callback therefore saw the transaction's
// uncommitted rows, and a ROLLBACK a moment later made them rows that never
// existed. The read now waits for the transaction to settle.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createDB } from "../src/db/async-db.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("db: a read outside an open callback transaction never sees its uncommitted rows", async () => {
  const dir = await tempDir("db-dirty-read-");
  const db = createDB(join(dir, "state.db"));
  try {
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    let release!: () => void;
    const held = new Promise<void>((r) => release = r);
    let inserted!: () => void;
    const didInsert = new Promise<void>((r) => inserted = r);
    const tx = db.transaction(async (t) => {
      await t.execute("INSERT INTO t (id, v) VALUES (1, 'uncommitted')");
      // The callback's own reads still see its writes.
      assertEquals((await t.query("SELECT id FROM t")).rows.length, 1);
      inserted();
      await held;
      throw new Error("abort");
    }).then(() => "committed", (e: Error) => e.message);
    await didInsert;
    const outside = db.query<{ id: number }>("SELECT id FROM t");
    setTimeout(release, 30);
    assertEquals(
      (await outside).rows,
      [],
      "the rolled-back row was never visible",
    );
    assertEquals(await tx, "abort");
  } finally {
    await db.close();
    await dropTempDir(dir);
  }
});
