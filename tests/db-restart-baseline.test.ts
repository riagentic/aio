// Audit 2026-07-24 (HIGH, data loss): the persistence manager captured its
// `db:` table baseline from the CALLER's state variable, which still held
// initialState — `loadTables` merges the restored rows into the boot result,
// which the caller only assigns afterwards. So on every run after the first,
// the baseline said "no rows" while state held the restored ones, and the first
// flush re-INSERTed every existing row: UNIQUE violation → the whole
// transaction rolled back → that flush's real writes were lost. And because the
// baseline only advances on success, it repeated forever.

import { assert, assertEquals } from "@std/assert";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { aio, cell, pk, table, text } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";

const PORT = freePort();

Deno.test("db: a restart with existing rows flushes cleanly (no duplicate INSERT)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "db-restart-" });
  const dbPath = join(dir, "data.db");
  try {
    // Simulate "a previous run persisted rows": the table already has data
    // before aio boots, exactly as it would on the second start of an app.
    const seed = new DatabaseSync(dbPath);
    seed.exec(
      "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
    );
    seed.prepare("INSERT INTO users (id, name) VALUES (?, ?)").run(1, "ada");
    seed.close();

    const ticker = cell("ticker", {
      state: { n: 0 },
      methods: {
        bump(s: { n: number }) {
          s.n++;
        },
      },
    });

    const errors: string[] = [];
    const app = await aio.run({
      cells: [ticker],
      appId: "db-restart-baseline",
      appVersion: "0.0.0",
      client: "server-only",
      libraryMode: true,
      port: PORT,
      dbPath,
      baseDir: dir,
      persistDebounceMs: 10,
      db: { users: table({ id: pk(), name: text() }) },
      onError: (e: { message?: string }) => errors.push(e.message ?? String(e)),
    });

    try {
      // The rows are restored into state…
      const state = app.getState() as unknown as {
        users: Array<{ id: number; name: string }>;
      };
      assertEquals(state.users.length, 1, "existing row restored into state");

      // …and any state change schedules a flush, which diffs tables against
      // the baseline. With a stale baseline this is where it blew up.
      await ticker.bump();
      await new Promise((r) => setTimeout(r, 250));

      assertEquals(
        errors.filter((m) => /UNIQUE|constraint/i.test(m)),
        [],
        "flush must not re-insert rows that are already in the table",
      );
    } finally {
      await app.close();
    }

    // The row is still there exactly once — nothing was duplicated or wiped.
    const check = new DatabaseSync(dbPath);
    const rows = check.prepare("SELECT id, name FROM users").all() as Array<
      { id: number; name: string }
    >;
    check.close();
    assertEquals(rows.length, 1, "row survives the restart flush");
    assert(rows[0]!.name === "ada", "row content intact");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
