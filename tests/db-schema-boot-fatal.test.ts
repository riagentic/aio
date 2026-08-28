// A `db:` schema the database REFUSES must stop the boot.
//
// aio-boot wrapped createDB + integrity + initSchema in one try/catch whose
// failure mode was `log.warn("sqlite: unavailable") ; asyncDb = null`. The
// persistence block a few lines down then re-opened the very same database for
// the KV snapshot — so the app came up, served traffic and persisted state,
// with NONE of the tables it declared. Every `db:` read returned nothing and
// every write went nowhere, behind one warning in the boot log.
//
// `initSchema` was already made precise (it names the table, the column and the
// keyword — tests/db-sync-integrity.test.ts); this pins that the precise error
// survives the boot path instead of being flattened into a warning.
import { assert, assertRejects } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";

const PORT = freePort();

Deno.test("boot: a table SQLite refuses is fatal, and says exactly what is wrong", async () => {
  const { cell, aio, table, pk, text } = await import("../mod.ts");
  const notes = cell("dbsfnotes", {
    state: { items: [] as Array<{ id: number; order: string }> },
    methods: {
      add(s: { items: Array<{ id: number; order: string }> }, order: string) {
        s.items.push({ id: s.items.length + 1, order });
      },
    },
  });

  const dir = Deno.makeTempDirSync();
  const err = await assertRejects(
    () =>
      aio.run({
        cells: [notes],
        appId: "test-db-schema-fatal",
        client: "server-only",
        persist: false,
        libraryMode: true,
        singleton: false,
        port: PORT,
        baseDir: dir,
        dbPath: ":memory:",
        // `order` is a SQL keyword — SQLite refuses it bare at CREATE TABLE.
        db: { "dbsfnotes.items": table({ id: pk(), order: text() }) },
      }),
    Error,
  );

  assert(
    !/sqlite: unavailable/i.test(err.message),
    `a schema error must not be flattened into "unavailable": ${err.message}`,
  );
  assert(
    /dbsfnotes_items|dbsfnotes\.items/.test(err.message),
    `names the table: ${err.message}`,
  );
  assert(/\border\b/.test(err.message), `names the column: ${err.message}`);
  assert(/keyword/i.test(err.message), `says why: ${err.message}`);
});
