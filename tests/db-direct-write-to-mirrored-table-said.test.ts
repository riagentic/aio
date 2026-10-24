// `app.db.execute()` into a table aio MIRRORS from state was silent and lost:
// with no pk the next save rewrote the table from state (the row vanished);
// with a pk the row stayed in SQLite but never reached state until a restart.
// Now the write is warned about at the write site, once per table, naming the
// table, the state path and what will happen. Warned, not refused — apps that
// do it today keep running. The framework's own saves never trigger it, and a
// SQL-only `db:` table is the app's to write.
import { assert, assertEquals } from "@std/assert";
import { aio, cell, integer, pk, table, text } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("app.db: a direct write to a state-mirrored table is said, once per table, with what happens", async () => {
  const dir = await tempDir("aio-db-mirror-warn-");
  const id = `mw${crypto.randomUUID().slice(0, 6)}`;
  const c = cell(id, {
    state: {
      keyed: [] as { id: number; v: string }[],
      loose: [] as { v: string }[],
      n: 1,
    },
    methods: {
      add(s, v: string) {
        s.keyed.push({ id: s.n++, v });
        s.loose.push({ v });
      },
    },
  });
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => warns.push(a.map(String).join(" "));
  const app = await aio.run({
    cells: [c],
    appId: `mw-${crypto.randomUUID().slice(0, 6)}`,
    client: "server-only",
    libraryMode: true,
    singleton: false,
    port: freePort(),
    appDir: dir,
    baseDir: dir,
    persistDebounceMs: 10,
    db: {
      [`${id}.keyed`]: table({ id: pk(), v: text() }),
      [`${id}.loose`]: table({ v: text() }),
      side: table({ id: pk(), n: integer() }),
    },
  });
  try {
    const said = (t: string) =>
      warns.filter((w) => w.includes(`app.db wrote to "${t}"`));
    // The framework's own saves go through the raw handle: no word.
    await c.add("a");
    const rows = async () =>
      (await app.db!.query<{ c: number }>(
        `SELECT count(*) AS c FROM ${id}_loose`,
      )).rows[0]!.c;
    const deadline = Date.now() + 5000;
    while (await rows() !== 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assertEquals(await rows(), 1, "the save ran");
    assertEquals(said(`${id}_keyed`).length + said(`${id}_loose`).length, 0);

    const db = app.db!;
    await db.execute(`INSERT INTO ${id}_keyed (id, v) VALUES (100, 'x')`);
    await db.execute(`UPDATE ${id}_keyed SET v = 'y' WHERE id = 100`);
    await db.transaction([{ sql: `INSERT INTO ${id}_loose (v) VALUES ('x')` }]);
    await db.transaction(async (tx) => {
      await tx.execute(`INSERT INTO ${id}_loose (v) VALUES ('z')`);
    });
    await db.execute("INSERT INTO side (id, n) VALUES (1, 1)");
    // Reads and the rest of the handle are untouched.
    assertEquals(
      (await db.query<{ c: number }>(`SELECT count(*) AS c FROM side`))
        .rows[0]!.c,
      1,
    );

    const keyed = said(`${id}_keyed`);
    assertEquals(keyed.length, 1, "once per table");
    assert(keyed[0]!.includes(`${id}.keyed`), keyed[0]);
    assert(keyed[0]!.includes("until a restart"), keyed[0]);
    const loose = said(`${id}_loose`);
    assertEquals(loose.length, 1, "array AND callback transactions are seen");
    assert(loose[0]!.includes("lost"), loose[0]);
    assertEquals(said("side").length, 0, "a SQL-only table is the app's");
  } finally {
    console.warn = orig;
    await app.close();
    await dropTempDir(dir);
  }
});
