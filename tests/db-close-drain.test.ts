// `close()` awaited only requests already POSTED to the worker
// (`pending`). Writes serialize through a writer lock, so a write queued
// behind another has not been posted yet: it was neither awaited nor aborted,
// `terminate()` killed the worker under it, and its promise never settled. On
// a dirty shutdown that is the most recent state change, lost silently.
import { assert, assertEquals } from "@std/assert";
import { createDB } from "../src/db/mod.ts";

Deno.test("db.close(): writes queued behind the writer lock still land", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-db-close-" });
  const path = `${dir}/t.db`;
  try {
    const db = createDB(path);
    await db.execute(
      "CREATE TABLE items (id INTEGER PRIMARY KEY, v TEXT NOT NULL)",
    );

    // Fire a burst without awaiting: only the first can be posted immediately,
    // the rest sit in the writer-lock chain.
    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < 25; i++) {
      writes.push(db.execute("INSERT INTO items (v) VALUES (?)", [`w${i}`]));
    }

    await db.close(); // must not terminate the worker out from under them

    // Every promise settled (none left hanging forever).
    const settled = await Promise.all(
      writes.map((p) =>
        Promise.race([
          p.then(() => "ok", () => "err"),
          new Promise((r) => setTimeout(() => r("HUNG"), 2000)),
        ])
      ),
    );
    assert(!settled.includes("HUNG"), `no write may hang: ${settled}`);

    // And the data is really on disk — reopen and count.
    const db2 = createDB(path);
    const { rows } = await db2.query<{ n: number }>(
      "SELECT COUNT(*) as n FROM items",
    );
    await db2.close();
    assertEquals(
      rows[0]!.n,
      25,
      "every queued write must be durable after close()",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
