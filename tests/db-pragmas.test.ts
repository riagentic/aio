// tests/db-pragmas.test.ts
// Behavior tests for DEFAULT_PRAGMAS + createDB (src/db/mod.ts → async-db.ts).
//
// Strategy: real worker-backed SQLite on temp files (same tmpDb() convention
// as tests/db.test.ts). createDB passes opts.pragmas ?? DEFAULT_PRAGMAS to the
// worker's open message, which execs each one — so we verify the pragmas are
// actually in effect by querying PRAGMA values back and by exercising
// foreign-key enforcement. Every test closes its DB so sanitizers pass.

import { assertEquals, assertRejects } from "@std/assert";
import { createDB, DEFAULT_PRAGMAS } from "../src/db/mod.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function tmpDb(): string {
  return Deno.makeTempFileSync({ suffix: ".db" });
}

// ── DEFAULT_PRAGMAS shape ────────────────────────────────────────────

Deno.test("db-pragmas: DEFAULT_PRAGMAS is a list of PRAGMA statements with the documented settings", () => {
  assertEquals(DEFAULT_PRAGMAS.length, 5);
  assertEquals(
    DEFAULT_PRAGMAS.every((p) =>
      typeof p === "string" && p.startsWith("PRAGMA ")
    ),
    true,
    "every entry must be a PRAGMA statement string",
  );
  const has = (re: RegExp) => DEFAULT_PRAGMAS.some((p) => re.test(p));
  assertEquals(has(/journal_mode\s*=\s*WAL/), true, "WAL journal mode");
  assertEquals(has(/synchronous\s*=\s*NORMAL/), true, "NORMAL synchronous");
  assertEquals(has(/cache_size\s*=\s*-64000/), true, "64MB cache");
  assertEquals(has(/busy_timeout\s*=\s*5000/), true, "5s busy timeout");
  assertEquals(has(/foreign_keys\s*=\s*ON/), true, "foreign keys ON");
});

// ── createDB applies DEFAULT_PRAGMAS ─────────────────────────────────

Deno.test("db-pragmas: createDB applies DEFAULT_PRAGMAS to the opened database", async () => {
  const path = tmpDb();
  const db = createDB(path);
  try {
    const journal = await db.query<{ journal_mode: string }>(
      "PRAGMA journal_mode",
    );
    assertEquals(journal.rows[0]?.journal_mode, "wal");

    const fk = await db.query<{ foreign_keys: number }>("PRAGMA foreign_keys");
    assertEquals(fk.rows[0]?.foreign_keys, 1);

    const busy = await db.query<{ timeout: number }>("PRAGMA busy_timeout");
    assertEquals(busy.rows[0]?.timeout, 5000);

    const cache = await db.query<{ cache_size: number }>("PRAGMA cache_size");
    assertEquals(cache.rows[0]?.cache_size, -64000);
  } finally {
    await db.close();
  }
});

Deno.test("db-pragmas: opts.pragmas replaces DEFAULT_PRAGMAS entirely", async () => {
  const path = tmpDb();
  const db = createDB(path, { pragmas: ["PRAGMA journal_mode = DELETE"] });
  try {
    const journal = await db.query<{ journal_mode: string }>(
      "PRAGMA journal_mode",
    );
    assertEquals(journal.rows[0]?.journal_mode, "delete", "custom pragma wins");

    // DEFAULT_PRAGMAS were NOT applied — busy_timeout stays at SQLite's default (0),
    // not the 5000ms that DEFAULT_PRAGMAS would set.
    const busy = await db.query<{ timeout: number }>("PRAGMA busy_timeout");
    assertEquals(busy.rows[0]?.timeout, 0, "defaults must not leak in");
  } finally {
    await db.close();
  }
});

// ── createDB end-to-end: create, write, read back, persist ───────────

Deno.test("db-pragmas: createDB round-trip — create table, write, read back, persists across close", async () => {
  const path = tmpDb();
  const db = createDB(path);
  try {
    await db.execute(
      "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)",
    );
    const ins1 = await db.execute("INSERT INTO notes (body) VALUES (?)", [
      "first",
    ]);
    assertEquals(ins1.changes, 1);
    assertEquals(ins1.lastInsertRowId, 1n);
    const ins2 = await db.execute("INSERT INTO notes (body) VALUES (?)", [
      "second",
    ]);
    assertEquals(ins2.lastInsertRowId, 2n);

    const res = await db.query<{ id: number; body: string }>(
      "SELECT id, body FROM notes ORDER BY id",
    );
    assertEquals(res.rows.length, 2);
    assertEquals(res.rows[0]?.body, "first");
    assertEquals(res.rows[1]?.body, "second");
  } finally {
    await db.close();
  }

  // Reopen the same file — data must have been durably written (WAL mode).
  const db2 = createDB(path);
  try {
    const res = await db2.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM notes",
    );
    assertEquals(res.rows[0]?.n, 2, "rows must survive close/reopen");
  } finally {
    await db2.close();
  }
});

// ── foreign_keys pragma is actually enforced ─────────────────────────

Deno.test("db-pragmas: default foreign_keys=ON is enforced (orphan insert rejects)", async () => {
  const path = tmpDb();
  const db = createDB(path);
  try {
    await db.execute("CREATE TABLE parents (id INTEGER PRIMARY KEY)");
    await db.execute(
      "CREATE TABLE children (id INTEGER PRIMARY KEY, parentId INTEGER NOT NULL REFERENCES parents(id))",
    );

    await assertRejects(
      () => db.execute("INSERT INTO children (parentId) VALUES (999)"),
      Error,
      "FOREIGN KEY",
    );

    // Valid parent → child insert succeeds, proving only the violation failed.
    await db.execute("INSERT INTO parents (id) VALUES (1)");
    const ok = await db.execute("INSERT INTO children (parentId) VALUES (1)");
    assertEquals(ok.changes, 1);
  } finally {
    await db.close();
  }
});
