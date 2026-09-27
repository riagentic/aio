// reactiveDB's schema graph (triggers, cascades, views): a failed read is
// retried rather than cached, and TEMP triggers count.
import { assertEquals } from "@std/assert";
import { createDB } from "../src/db/async-db.ts";
import { reactiveDB } from "../src/db/reactive.ts";
import type { DB } from "../src/db/types.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

Deno.test("reactive: one failed schema read is not cached — the next write refreshes only what it touched", async () => {
  const inner = createDB(":memory:");
  let busy = true;
  const flaky: DB = {
    ...inner,
    // deno-lint-ignore no-explicit-any
    transaction: ((arg: any) => {
      if (busy && typeof arg === "function") {
        busy = false;
        return Promise.reject(new Error("SQLITE_BUSY: database is locked"));
      }
      return (inner.transaction as (a: unknown) => Promise<unknown>)(arg);
    }) as DB["transaction"],
  } as DB;
  const db = reactiveDB(flaky);
  try {
    await db.execute("CREATE TABLE x (v INTEGER)");
    await db.execute("CREATE TABLE y (v INTEGER)");
    const qy = await db.select("SELECT * FROM y");
    let yRefreshes = 0;
    qy.subscribe(() => yRefreshes++);
    // The graph read fails: refresh everything (a superset, never stale).
    await db.execute("INSERT INTO x VALUES (1)");
    assertEquals(yRefreshes, 1);
    // The failure must not stick: this write touches only x.
    await db.execute("INSERT INTO x VALUES (2)");
    assertEquals(
      yRefreshes,
      1,
      "a write to x refreshed the live query on y — the failed schema read " +
        "was cached, so every write refreshes every live query",
    );
    qy.dispose();
  } finally {
    await db.close();
  }
});

for (const readers of [0, 1]) {
  Deno.test(`reactive: a TEMP trigger's write refreshes the live query on its target (readers: ${readers})`, async () => {
    // A temp trigger lives on the writer's connection only; with a reader pool
    // the schema must still be read there.
    const dir = await tempDir("aio-reactive-temp-");
    const db = reactiveDB(createDB(`${dir}/t.db`, { readers }));
    try {
      await db.execute("CREATE TABLE a (id INTEGER)");
      await db.execute("CREATE TABLE audit (id INTEGER)");
      await db.execute(
        "CREATE TEMP TRIGGER a_audit AFTER INSERT ON a " +
          "BEGIN INSERT INTO audit VALUES (new.id); END",
      );
      const q = await db.select("SELECT * FROM audit");
      assertEquals(q.rows.length, 0);
      await db.execute("INSERT INTO a VALUES (1)");
      assertEquals(
        q.rows.length,
        1,
        "live query on `audit` missed the TEMP trigger's row",
      );
      q.dispose();
    } finally {
      await db.close();
    }
  });
}
