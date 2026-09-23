// The store's foreign-write flag (server/store-gen.ts): another connection's
// write to a store row sets it; this build's saves clear it in their own
// transaction.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import { createDB } from "../src/db/async-db.ts";
import { SKV_SCHEMA } from "../src/server/skv-sqlite.ts";
import {
  bootStoreGen,
  planStoreGenRecord,
  recordStoreGen,
  STORE_GEN_TABLE,
} from "../src/server/store-gen.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const WM = "app:__journal_wm";

async function setup(dir: string) {
  const path = join(dir, "state.db");
  const db = createDB(path);
  await db.execute(SKV_SCHEMA);
  await db.execute(`CREATE TABLE "my rows" (id INTEGER PRIMARY KEY, t TEXT)`);
  return { db, path };
}
const dirty = (path: string): number => {
  const d = new DatabaseSync(path);
  try {
    return (d.prepare(`SELECT dirty FROM ${STORE_GEN_TABLE} WHERE id = 1`)
      .get() as { dirty: number }).dirty;
  } finally {
    d.close();
  }
};
/** Another process: 1.0.9, or a tool. */
const foreign = (path: string, sql: string) => {
  const d = new DatabaseSync(path);
  try {
    d.exec(sql);
  } finally {
    d.close();
  }
};

Deno.test("store gen: a foreign write to any store row sets the flag — single row, multi row, bound table, delete; this build's save leaves it clear", async () => {
  const writes = [
    `UPDATE aio_kv SET v = '{"k":1}' WHERE k = 'state'`,
    `INSERT INTO aio_kv (k, v) VALUES ('state' || char(31) || 'b', '2')`,
    `DELETE FROM aio_kv WHERE k = 'state' || char(31) || 'a'`,
    `INSERT INTO "my rows" (t) VALUES ('y')`,
    `DELETE FROM "my rows"`,
  ];
  for (const w of writes) {
    const dir = await tempDir("aio-store-gen-");
    const { db, path } = await setup(dir);
    try {
      await bootStoreGen(db, "app", "state", ["my rows"], WM, true);
      await recordStoreGen(db, "app", WM);
      // This build's save: rows of every kind, then its closing statements.
      await db.transaction([
        { sql: `INSERT INTO aio_kv (k, v) VALUES ('state', '{}')` },
        {
          sql:
            `INSERT INTO aio_kv (k, v) VALUES ('state' || char(31) || 'a', '1')`,
        },
        { sql: `INSERT INTO "my rows" (t) VALUES ('x')` },
        ...planStoreGenRecord("app", WM),
      ]);
      assertEquals(dirty(path), 0, "this build's save");
      // Not a store row: another prefix, the journal's own keys.
      foreign(path, `INSERT INTO aio_kv (k, v) VALUES ('stately', '1')`);
      foreign(path, `INSERT INTO aio_kv (k, v) VALUES ('${WM}x', '3')`);
      assertEquals(dirty(path), 0, "only store rows count");
      foreign(path, w);
      assertEquals(dirty(path), 1, w);
    } finally {
      await db.close();
      await dropTempDir(dir);
    }
  }
});

Deno.test("store gen: foreign ⇔ the flag set while the journal watermark stayed; a journalling writer moves it", async () => {
  for (const moveWm of [false, true]) {
    const dir = await tempDir("aio-store-gen-boot-");
    const { db, path } = await setup(dir);
    try {
      await bootStoreGen(db, "app", "state", [], WM, true);
      await db.execute(`INSERT INTO aio_kv (k, v) VALUES (?, '5')`, [WM]);
      await recordStoreGen(db, "app", WM);
      await db.close();
      foreign(path, `INSERT INTO aio_kv (k, v) VALUES ('state', '{}')`);
      if (moveWm) foreign(path, `UPDATE aio_kv SET v = '9' WHERE k = '${WM}'`);
      const db2 = createDB(path);
      try {
        const { foreign: f } = await bootStoreGen(
          db2,
          "app",
          "state",
          [],
          WM,
          true,
        );
        assertEquals(f, !moveWm);
      } finally {
        await db2.close();
      }
    } finally {
      await dropTempDir(dir);
    }
  }
});

Deno.test("store gen: a journal-off boot drops the triggers — no cost, no flag", async () => {
  const dir = await tempDir("aio-store-gen-off-");
  const { db, path } = await setup(dir);
  try {
    await bootStoreGen(db, "app", "state", ["my rows"], WM, true);
    await bootStoreGen(db, "app", "state", ["my rows"], WM, false);
    const d = new DatabaseSync(path);
    try {
      const n = (d.prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'`,
      ).get() as { n: number }).n;
      assertEquals(n, 0);
    } finally {
      d.close();
    }
    foreign(path, `INSERT INTO aio_kv (k, v) VALUES ('state', '{}')`);
    assertEquals(dirty(path), 0);
  } finally {
    await db.close();
    await dropTempDir(dir);
  }
});
