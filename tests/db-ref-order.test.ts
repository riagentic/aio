// `ref()` is the documented way to relate two `db:` tables. aio opens every
// app db with `PRAGMA foreign_keys = ON`, and a persist window writes ALL the
// changed tables in one transaction, table by table in the order the `db:`
// object declares them — so a child row inserted before its parent hit an
// immediate FOREIGN KEY check and took the whole batch down with it.
//
// Declaration order in a config object is not something a developer chooses on
// purpose, and nothing about `db: { comments: …, posts: … }` says it is the
// wrong way round. The same two tables the other way round worked.
//
// The fix is what SQLite provides for exactly this: the constraints are checked
// at COMMIT, over the finished state, instead of statement by statement. A
// reference that is genuinely dangling when the window ends must still fail.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createDB } from "../src/db/async-db.ts";
import { initSchema, loadTables, syncTables } from "../src/db/state-sync.ts";
import { pk, ref, table, text } from "../src/server/sql.ts";
import type { TableDef } from "../src/server/sql.ts";

// The child is declared FIRST — the order that used to lose every write.
const SCHEMA: Record<string, TableDef> = {
  comments: table({ id: pk(), postId: ref("posts"), body: text() }),
  posts: table({ id: pk(), title: text() }),
};

async function withDb(fn: (db: ReturnType<typeof createDB>) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "aio-ref-order-" });
  const db = createDB(join(dir, "state.db"));
  try {
    await initSchema(db, SCHEMA);
    await fn(db);
  } finally {
    await db.close().catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test({
  name: "db ref: a child table declared before its parent still persists",
  fn: () =>
    withDb(async (db) => {
      await syncTables(
        db,
        SCHEMA,
        {
          comments: [{ id: 1, postId: 1, body: "hi" }],
          posts: [{ id: 1, title: "p" }],
        },
        { comments: [], posts: [] },
      );
      const loaded = await loadTables(db, SCHEMA);
      assertEquals(
        loaded.posts,
        [{ id: 1, title: "p" }],
        "the parent row must be stored",
      );
      assertEquals(
        loaded.comments,
        [{ id: 1, postId: 1, body: "hi" }],
        "the child row must be stored — declaration order in the `db:` object " +
          "is not a data-loss switch",
      );
    }),
});

Deno.test({
  name: "db ref: deleting a parent and its children in one window works",
  fn: () =>
    withDb(async (db) => {
      const full = {
        comments: [{ id: 1, postId: 1, body: "hi" }],
        posts: [{ id: 1, title: "p" }],
      };
      await syncTables(db, SCHEMA, full, { comments: [], posts: [] });
      await syncTables(db, SCHEMA, { comments: [], posts: [] }, full);
      const loaded = await loadTables(db, SCHEMA);
      assertEquals(loaded.posts, []);
      assertEquals(loaded.comments, []);
    }),
});

Deno.test({
  name: "db ref: a reference that is still dangling at COMMIT is refused",
  fn: () =>
    withDb(async (db) => {
      let threw: unknown = null;
      try {
        await syncTables(
          db,
          SCHEMA,
          { comments: [{ id: 1, postId: 99, body: "orphan" }], posts: [] },
          { comments: [], posts: [] },
        );
      } catch (e) {
        threw = e;
      }
      assert(
        threw !== null,
        "deferring the check must not disable it — an orphan row is still an " +
          "error, it is just reported over the finished transaction",
      );
      assertEquals(
        (await loadTables(db, SCHEMA)).comments,
        [],
        "and nothing is left behind",
      );
    }),
});
