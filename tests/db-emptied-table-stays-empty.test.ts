// Round 2 (db tier): boot could not tell an empty `db:` table that was never
// written (a first run with a `state:` seed, a new binding — adopt the array)
// from one the app EMPTIED. It always assumed the first, so a list seeded
// with a welcome row and cleared by the user came back with the welcome row
// after every restart — a confirmed deletion undone. The sync now records the
// tables it has committed (SYNCED_TABLES, same transaction as the rows).

import { assertEquals } from "@std/assert";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { aio, cell, pk, table, text } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

type T = { id: number; text: string };
const mk = () =>
  cell("todo", {
    state: { n: 0, todos: [{ id: 1, text: "welcome" }] as T[] },
    methods: {
      clear(s: { todos: T[]; n: number }) {
        s.todos = [];
        s.n++;
      },
    },
  });
const boot = (c: ReturnType<typeof mk>, dir: string) =>
  aio.run({
    cells: [c],
    appId: "db-emptied-stays-empty",
    client: "server-only",
    libraryMode: true,
    port: freePort(),
    dbPath: join(dir, "state.db"),
    baseDir: dir,
    persistDebounceMs: 10,
    db: { todos: table({ id: pk(), text: text() }) },
  });
const todosOf = (app: { getState(): unknown }) =>
  (app.getState() as { todo: { todos: T[] } }).todo.todos;

Deno.test("db: a table the app emptied restores empty — the seeded default does not come back", async () => {
  const dir = await tempDir("db-emptied-");
  try {
    let c = mk();
    let app = await boot(c, dir);
    try {
      // First run: the seed is adopted and written.
      assertEquals(todosOf(app), [{ id: 1, text: "welcome" }]);
      await c.clear();
      await new Promise((r) => setTimeout(r, 150)); // one persist window
    } finally {
      await app.close();
    }
    const check = new DatabaseSync(join(dir, "state.db"));
    assertEquals(check.prepare("SELECT * FROM todos").all().length, 0);
    check.close();

    c = mk();
    app = await boot(c, dir);
    try {
      assertEquals(
        (app.getState() as { todo: { n: number } }).todo.n,
        1,
        "the snapshot half restored",
      );
      assertEquals(todosOf(app), [], "the deleted seed row stays deleted");
    } finally {
      await app.close();
    }
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("db: a never-written empty table still adopts the seed (first run, and a file from an older aio)", async () => {
  const dir = await tempDir("db-emptied-seed-");
  try {
    // A file an older aio wrote: the table exists, empty, and no sync record.
    const seed = new DatabaseSync(join(dir, "state.db"));
    seed.exec(
      "CREATE TABLE todos (id INTEGER PRIMARY KEY, text TEXT NOT NULL)",
    );
    seed.close();
    const c = mk();
    const app = await boot(c, dir);
    try {
      assertEquals(todosOf(app), [{ id: 1, text: "welcome" }]);
    } finally {
      await app.close();
    }
    const check = new DatabaseSync(join(dir, "state.db"));
    const rows = check.prepare("SELECT id, text FROM todos").all().map((
      r: Record<string, unknown>,
    ) => ({ ...r }));
    check.close();
    assertEquals(
      rows,
      [{ id: 1, text: "welcome" }],
      "adopted seed was written",
    );
  } finally {
    await dropTempDir(dir);
  }
});
