// Db tier: two EXISTING rows exchanging a UNIQUE value in one window — a final
// state with no duplicate in it — was planned as two row-by-row UPDATEs. SQLite
// checks UNIQUE per statement, so the first UPDATE met the not-yet-renamed
// second row and the batch was refused on every window after: the cell held,
// and the swap gone at the next boot. The sibling of
// tests/db-unique-rename-reuse.test.ts (UPDATE-vs-INSERT), for UPDATE-vs-UPDATE.

import { assertEquals, assertRejects } from "@std/assert";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { aio, cell, pk, table, text } from "../mod.ts";
import { createDB } from "../src/db/async-db.ts";
import { initSchema, syncTables } from "../src/db/state-sync.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

type U = { id: number; handle: string };

Deno.test("db: two rows exchanging a unique value in one window lands", async () => {
  const dir = await tempDir("db-unique-swap-");
  const dbPath = join(dir, "state.db");
  try {
    const people = cell("people", {
      state: { users: [] as U[] },
      methods: {
        seed(s: { users: U[] }) {
          s.users.push({ id: 1, handle: "alice" }, { id: 2, handle: "bob" });
        },
        swap(s: { users: U[] }) {
          s.users[0]!.handle = "bob";
          s.users[1]!.handle = "alice";
        },
      },
    });
    const errors: string[] = [];
    const app = await aio.run({
      cells: [people],
      appId: "db-unique-swap",
      client: "server-only",
      libraryMode: true,
      port: freePort(),
      dbPath,
      baseDir: dir,
      persistDebounceMs: 10,
      db: { users: table({ id: pk(), handle: text({ unique: true }) }) },
      onError: (e: { message?: string }) => errors.push(e.message ?? String(e)),
    });
    try {
      await people.seed();
      await new Promise((r) => setTimeout(r, 150)); // one persist window
      await people.swap();
      await new Promise((r) => setTimeout(r, 150)); // one persist window
    } finally {
      await app.close();
    }
    const check = new DatabaseSync(dbPath);
    const rows = check.prepare("SELECT id, handle FROM users ORDER BY id")
      .all().map((r: Record<string, unknown>) => ({ ...r }));
    check.close();
    assertEquals(errors.filter((m) => /UNIQUE/.test(m)).length, 0);
    assertEquals(rows, [{ id: 1, handle: "bob" }, { id: 2, handle: "alice" }]);
  } finally {
    await dropTempDir(dir);
  }
});

const schema = {
  users: table({ id: pk(), handle: text({ unique: true }), note: text() }),
};
const u = (id: number, handle: string, note = "") => ({ id, handle, note });

Deno.test("db: a three-row rotation of a unique value lands, other columns intact", async () => {
  const db = createDB(":memory:");
  try {
    await initSchema(db, schema);
    const prev = { users: [u(1, "a", "x"), u(2, "b", "y"), u(3, "c", "z")] };
    await syncTables(db, schema, prev, { users: [] });
    const next = { users: [u(1, "b", "x"), u(2, "c", "y2"), u(3, "a", "z")] };
    await syncTables(db, schema, next, prev);
    const { rows } = await db.query<Record<string, unknown>>(
      "SELECT id, handle, note FROM users ORDER BY id",
    );
    assertEquals(rows.map((r) => ({ ...r })), next.users);
  } finally {
    await db.close();
  }
});

Deno.test("db: a real duplicate among updated rows is still refused", async () => {
  const db = createDB(":memory:");
  try {
    await initSchema(db, schema);
    const prev = { users: [u(1, "a"), u(2, "b"), u(3, "c")] };
    await syncTables(db, schema, prev, { users: [] });
    // 1 takes 2's value, 2 moves on — but 3 ALSO ends at "b": a duplicate.
    const next = { users: [u(1, "b"), u(2, "d"), u(3, "b")] };
    await assertRejects(
      () => syncTables(db, schema, next, prev),
      Error,
      "UNIQUE",
    );
    const { rows } = await db.query<Record<string, unknown>>(
      "SELECT id, handle FROM users ORDER BY id",
    );
    // The refused transaction rolled back whole: no parked value leaked.
    assertEquals(rows.map((r) => ({ ...r })), [
      { id: 1, handle: "a" },
      { id: 2, handle: "b" },
      { id: 3, handle: "c" },
    ]);
  } finally {
    await db.close();
  }
});
