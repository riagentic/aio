// Round 2 (db tier): SQLite column names are case-insensitive, but rows come
// back keyed by the STORED spelling. A `db:` column renamed only in case
// (`userid` → `userId`) was taken for a missing column: the boot was refused
// with "no value to put in them" for a column holding every value (and made
// nullable, as advised, every row loaded keyed `userid`). The stored column is
// now renamed to the declared spelling, losslessly.

import { assertEquals } from "@std/assert";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { aio, cell, integer, pk, table } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("db: a column renamed only in case boots and keeps its values", async () => {
  const dir = await tempDir("db-col-case-");
  const dbPath = join(dir, "state.db");
  try {
    const seed = new DatabaseSync(dbPath);
    seed.exec(
      "CREATE TABLE items (id INTEGER PRIMARY KEY, userid INTEGER NOT NULL)",
    );
    seed.exec("INSERT INTO items VALUES (1, 42)");
    seed.close();
    const shop = cell("shop", {
      state: { items: [] as { id: number; userId: number }[] },
      methods: {},
    });
    const app = await aio.run({
      cells: [shop],
      appId: "db-col-case",
      client: "server-only",
      libraryMode: true,
      port: freePort(),
      dbPath,
      baseDir: dir,
      persistDebounceMs: 10,
      db: { items: table({ id: pk(), userId: integer() }) },
    });
    try {
      const items = (app.getState() as {
        shop: { items: Record<string, unknown>[] };
      }).shop.items.map((r) => ({ ...r }));
      assertEquals(items, [{ id: 1, userId: 42 }]);
    } finally {
      await app.close();
    }
  } finally {
    await dropTempDir(dir);
  }
});
