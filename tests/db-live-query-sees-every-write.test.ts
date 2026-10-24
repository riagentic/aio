// A live query refreshes on EVERY write through the handle it wraps — not only
// on writes issued through the reactiveDB wrapper itself.
//
// `reactiveDB(app.db).select("SELECT count(*) FROM items")` over a BOUND
// table never refreshed: the framework persists bound rows through `app.db`
// directly, so the wrapper never saw them, and the live query kept its first
// answer forever with no word. Same for a plain `app.db.execute()` beside the
// wrapper. The handle now announces its committed writes, and a callback
// transaction announces exactly what it wrote.
import { assertEquals } from "@std/assert";
import { aio, cell, pk, table, text } from "../mod.ts";
import { createDB } from "../src/db/async-db.ts";
import { reactiveDB } from "../src/db/reactive.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("live query: a write through the UNDERLYING handle refreshes it; a callback transaction refreshes exactly what it wrote", async () => {
  const raw = createDB(":memory:");
  const db = reactiveDB(raw);
  try {
    await db.execute("CREATE TABLE a (id INTEGER PRIMARY KEY)");
    await db.execute("CREATE TABLE b (id INTEGER PRIMARY KEY)");
    const qa = await db.select<{ c: number }>("SELECT count(*) AS c FROM a");
    const qb = await db.select<{ c: number }>("SELECT count(*) AS c FROM b");
    let fa = 0, fb = 0;
    qa.subscribe(() => fa++);
    qb.subscribe(() => fb++);

    await raw.execute("INSERT INTO a (id) VALUES (1)");
    assertEquals(qa.rows[0]!.c, 1, "a write beside the wrapper is seen");
    await raw.transaction([{ sql: "INSERT INTO a (id) VALUES (2)" }]);
    assertEquals(qa.rows[0]!.c, 2);
    await raw.transaction(async (tx) => {
      await tx.execute("INSERT INTO a (id) VALUES (3)");
    });
    assertEquals(qa.rows[0]!.c, 3);
    assertEquals(fb, 0, "a write to `a` never refreshes the query on `b`");

    // Through the wrapper: refreshed once, not twice.
    await db.execute("INSERT INTO b (id) VALUES (1)");
    assertEquals([qb.rows[0]!.c, fb], [1, 1]);

    // A read-only callback announces nothing.
    const before = fa;
    await raw.transaction((tx) => tx.query("SELECT 1"));
    assertEquals(fa, before);
    qa.dispose();
    qb.dispose();
  } finally {
    await db.close();
  }
});

Deno.test("live query: a BOUND table refreshes when the state it mirrors persists", async () => {
  const dir = await tempDir("aio-live-bound-");
  const id = `liveb${crypto.randomUUID().slice(0, 6)}`;
  const items = cell(id, {
    state: { items: [] as { id: number; v: string }[], n: 1 },
    methods: {
      add(s, v: string) {
        s.items.push({ id: s.n++, v });
      },
    },
  });
  const app = await aio.run({
    cells: [items],
    appId: `liveb-${crypto.randomUUID().slice(0, 6)}`,
    client: "server-only",
    libraryMode: true,
    singleton: false,
    port: freePort(),
    appDir: dir,
    baseDir: dir,
    persistDebounceMs: 10,
    db: { [`${id}.items`]: table({ id: pk(), v: text() }) },
  });
  try {
    const live = reactiveDB(app.db!);
    const q = await live.select<{ c: number }>(
      `SELECT count(*) AS c FROM ${id}_items`,
    );
    await items.add("a");
    await items.add("b");
    const deadline = Date.now() + 5000;
    while (q.rows[0]!.c !== 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assertEquals(q.rows[0]!.c, 2, "the persisted rows reached the live query");
    q.dispose();
  } finally {
    await app.close();
    await dropTempDir(dir);
  }
});
