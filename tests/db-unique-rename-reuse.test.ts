// Round 2 (db tier): a window that renames a UNIQUE value away from one row
// and gives it to a NEW row — a state with no duplicate in it — was planned
// INSERT-before-UPDATE. SQLite checks UNIQUE per statement, so the INSERT met
// the not-yet-renamed value and the batch was refused on every window after:
// the cell held, and both changes gone at the next boot.

import { assertEquals } from "@std/assert";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { aio, cell, pk, table, text } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

type U = { id: number; handle: string };

Deno.test("db: renaming a unique value and reusing it for a new row in one window lands", async () => {
  const dir = await tempDir("db-unique-reuse-");
  const dbPath = join(dir, "state.db");
  try {
    const people = cell("people", {
      state: { users: [] as U[] },
      methods: {
        seed(s: { users: U[] }) {
          s.users.push({ id: 1, handle: "bob" });
        },
        rename(s: { users: U[] }) {
          s.users[0]!.handle = "robert";
          s.users.push({ id: 2, handle: "bob" });
        },
      },
    });
    const errors: string[] = [];
    const app = await aio.run({
      cells: [people],
      appId: "db-unique-reuse",
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
      await people.rename();
      await new Promise((r) => setTimeout(r, 150)); // one persist window
    } finally {
      await app.close();
    }
    const check = new DatabaseSync(dbPath);
    const rows = check.prepare("SELECT id, handle FROM users ORDER BY id")
      .all().map((r: Record<string, unknown>) => ({ ...r }));
    check.close();
    assertEquals(rows, [{ id: 1, handle: "robert" }, { id: 2, handle: "bob" }]);
    assertEquals(errors.filter((m) => /UNIQUE/.test(m)), []);
  } finally {
    await dropTempDir(dir);
  }
});
