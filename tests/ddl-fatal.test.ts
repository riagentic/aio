// Fatal DDL — a schema the app cannot evolve is a BOOT failure, named at boot.
//
// Both schema-evolution seams (`applySyncMigrations` in src/sync/compact.ts,
// `reconcileTable` in src/db/state-sync.ts) apply ALTER TABLE statements on
// boot. The already-applied case ("duplicate column name") is the expected
// steady state and stays tolerated; any OTHER DDL failure used to be logged
// and skipped — after which the app ran against a schema it did not have, and
// every query on the missing column failed at some random later moment. Now it
// throws, naming the table, the statement and the file.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { applySyncMigrations, SYNC_SCHEMA } from "../src/sync/compact.ts";
import { initSchema } from "../src/db/state-sync.ts";
import { createDB } from "../src/db/mod.ts";
import type { DB } from "../src/db/types.ts";
import { pk, table, text } from "../src/server/sql.ts";

async function withDb(
  fn: (db: DB, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const db = createDB(join(dir, "t.db"));
  try {
    await fn(db, dir);
  } finally {
    await db.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("sync DDL: duplicate column stays tolerated (already-applied is the steady state)", async () => {
  await withDb(async (db) => {
    for (const sql of SYNC_SCHEMA) await db.execute(sql);
    // Fresh SYNC_SCHEMA already contains the migrated columns, so every
    // migration fails with "duplicate column name" — the tolerated case.
    // Twice, to prove idempotence.
    await applySyncMigrations(db);
    await applySyncMigrations(db);
  });
});

Deno.test("sync DDL: a genuinely failing migration is FATAL and names table + statement + file", async () => {
  await withDb(async (db) => {
    // No sync tables at all → ALTER TABLE fails with "no such table", which
    // is NOT the duplicate-column steady state and must throw.
    const err = await assertRejects(
      () => applySyncMigrations(db),
      Error,
    );
    const msg = (err as Error).message;
    assert(msg.includes("sync_meta"), `names the table:\n${msg}`);
    assert(msg.includes("ALTER TABLE"), `names the statement:\n${msg}`);
    assert(msg.includes("src/sync/compact.ts"), `names the file:\n${msg}`);
  });
});

Deno.test("db DDL: reconcileTable tolerates duplicate column (raced boot / out-of-band add)", async () => {
  // Stub DB: delegate everything except the ALTER, which reports the column
  // as already present — the goal state is reached, so boot must proceed.
  await withDb(async (real) => {
    const schema = { things: table({ id: pk(), name: text() }) };
    await initSchema(real, schema);
    await real.execute(`INSERT INTO things (id, name) VALUES (1, 'a')`);

    const evolved = {
      things: table({
        id: pk(),
        name: text(),
        tag: text({ nullable: true }),
      }),
    };
    let altered = 0;
    const stub: DB = {
      ...real,
      execute(sql: string, params?: unknown[]) {
        if (/ALTER TABLE/i.test(sql)) {
          altered++;
          return Promise.reject(new Error("duplicate column name: tag"));
        }
        return real.execute(sql, params);
      },
    };
    await initSchema(stub, evolved); // must NOT throw
    assertEquals(altered, 1, "the ALTER was attempted exactly once");
  });
});

Deno.test("db DDL: a DDL SQLite refuses is FATAL and names table + statement + file", async () => {
  await withDb(async (db) => {
    const schema = { things: table({ id: pk(), name: text() }) };
    await initSchema(db, schema);
    await db.execute(`INSERT INTO things (id, name) VALUES (1, 'a')`);

    // A UNIQUE column cannot be ADDed to an existing table — SQLite refuses
    // the ALTER itself ("Cannot add a UNIQUE column"). Real failure, real
    // SQLite, no stub.
    const evolved = {
      things: table({
        id: pk(),
        name: text(),
        email: text({ unique: true, nullable: true }),
      }),
    };
    const err = await assertRejects(() => initSchema(db, evolved), Error);
    const msg = (err as Error).message;
    assert(msg.includes(`"things"`), `names the table:\n${msg}`);
    assert(
      msg.includes("ALTER TABLE things ADD COLUMN"),
      `names the statement:\n${msg}`,
    );
    assert(msg.includes("src/db/state-sync.ts"), `names the file:\n${msg}`);
  });
});
