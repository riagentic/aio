// ONE ordered, fatal boot schema runner (src/db/ddl.ts → runSchemaSetup).
// Schema setup used to be spread over the boot: the version ladder, the
// declared `db:` tables, the sync op-log tables — each with its own
// try/catch. Now the steps run in ONE order, the first failure refuses the
// boot by STEP NAME with its fix, and a re-boot on the same file is a no-op.
// Also here: the version read is honest — "no such table" is the one
// "nothing yet"; any other read failure throws instead of stamping over it.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { createDB } from "../src/db/async-db.ts";
import { initSchema } from "../src/db/state-sync.ts";
import type { DB } from "../src/db/types.ts";
import {
  DB_SCHEMA_VERSION,
  getAioSchemaVersion,
  runDdlSteps,
  runSchemaSetup,
  type SchemaStep,
  stampAioSchemaVersion,
} from "../src/db/ddl.ts";
import { pk, table, text } from "../src/server/sql.ts";

async function withDb(fn: (db: DB) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  const db = createDB(join(dir, "t.db"));
  try {
    await fn(db);
  } finally {
    await db.close();
    await Deno.remove(dir, { recursive: true });
  }
}

const schema = { things: table({ id: pk(), name: text() }) };
const steps = (): SchemaStep[] => [
  {
    name: "ladder",
    fix: "upgrade aio",
    run: async (db) => {
      await runDdlSteps(db);
    },
  },
  { name: "tables", fix: "fix the table", run: (db) => initSchema(db, schema) },
];

Deno.test("schema runner: fresh db — steps run in order, stamped, and a re-boot is a no-op walk", async () => {
  await withDb(async (db) => {
    assertEquals(await getAioSchemaVersion(db), 0);
    assertEquals(await runSchemaSetup(db, steps()), ["ladder", "tables"]);
    assertEquals(await getAioSchemaVersion(db), DB_SCHEMA_VERSION);
    await db.execute(`INSERT INTO things (id, name) VALUES (1, 'a')`);
    // Idempotent: same steps, same file, data untouched.
    assertEquals(await runSchemaSetup(db, steps()), ["ladder", "tables"]);
    const { rows } = await db.query(`SELECT * FROM things`);
    assertEquals(rows.length, 1);
  });
});

Deno.test("schema runner: an OLDER file walks the ladder up and lands at the current version", async () => {
  await withDb(async (db) => {
    // A legacy file: declared tables exist, no aio_schema at all (v0).
    await initSchema(db, schema);
    assertEquals(await getAioSchemaVersion(db), 0);
    await runSchemaSetup(db, steps());
    assertEquals(await getAioSchemaVersion(db), DB_SCHEMA_VERSION);
  });
});

Deno.test("schema runner: the first failing step refuses by name, with its fix, and nothing after it runs", async () => {
  await withDb(async (db) => {
    let laterRan = false;
    const err = await assertRejects(
      () =>
        runSchemaSetup(db, [
          ...steps(),
          {
            name: "sync",
            fix: "check the file is writable",
            run: async (d) => {
              await d.execute(`CREATE TABLE`); // SQLite refuses this
            },
          },
          {
            name: "later",
            fix: "n/a",
            run: () => {
              laterRan = true;
              return Promise.resolve();
            },
          },
        ]),
      Error,
    );
    const msg = (err as Error).message;
    assert(msg.includes('REFUSED at step "sync"'), msg);
    assert(msg.includes("after ladder → tables"), msg);
    assert(msg.includes("fix: check the file is writable"), msg);
    assert(!laterRan, "a step after the failure must not run");
    // The steps before it DID land — the refusal is not a rollback of them.
    assertEquals(await getAioSchemaVersion(db), DB_SCHEMA_VERSION);
  });
});

Deno.test("schema runner: a NEWER file (downgrade) is refused with both exits, and left untouched", async () => {
  await withDb(async (db) => {
    await stampAioSchemaVersion(db, DB_SCHEMA_VERSION + 5);
    const err = await assertRejects(() => runSchemaSetup(db, steps()), Error);
    const msg = (err as Error).message;
    assert(msg.includes('REFUSED at step "ladder"'), msg);
    assert(msg.includes("written by a NEWER aio"), msg);
    assert(msg.includes("upgrade aio"), msg);
    assert(msg.includes("backup"), msg);
    assertEquals(await getAioSchemaVersion(db), DB_SCHEMA_VERSION + 5);
    // "tables" never ran: no `things` table.
    await assertRejects(() => db.query(`SELECT * FROM things`));
  });
});

Deno.test("schema runner: a step listed twice is a malformed runner, refused before anything runs", async () => {
  await withDb(async (db) => {
    const err = await assertRejects(
      () => runSchemaSetup(db, [steps()[0]!, steps()[0]!]),
      Error,
    );
    assert((err as Error).message.includes("listed twice"));
    assertEquals(await getAioSchemaVersion(db), 0);
  });
});

Deno.test("schema version read: 'no such table' is the one honest 0 — any other failure throws by name", async () => {
  await withDb(async (real) => {
    assertEquals(await getAioSchemaVersion(real), 0);
    const broken: DB = {
      ...real,
      query: () => Promise.reject(new Error("database is locked")),
    };
    const err = await assertRejects(() => getAioSchemaVersion(broken), Error);
    assert(
      (err as Error).message.includes("could not read aio's schema version"),
    );
    assert((err as Error).message.includes("database is locked"));
  });
});
