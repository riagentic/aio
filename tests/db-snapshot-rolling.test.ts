// Audit 2026-08-27 (MEDIUM, all reproduced):
//
//  • the documented rolling-snapshot recipe worked exactly ONCE. `VACUUM INTO`
//    refuses a destination that already exists ("output file already exists",
//    measured), so an app calling `db.snapshot(path)` on a schedule got an
//    unhandled rejection on every call after the first — and recovered to its
//    first-ever state.
//  • the copy was never verified, so a snapshot could silently be a corrupt
//    copy: the one file recovery falls back to.
//  • `dbPragmas` REPLACED the defaults, so naming one setting silently dropped
//    WAL, `busy_timeout` and the page cache with it.
//  • a worker error carried no SQL and no parameter count, which is how
//    finding #1 reached an operator as a bare `too many SQL variables`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createDB, DEFAULT_PRAGMAS } from "../src/server-entry.ts";
import { mergePragmas, pragmaName, pragmasFor } from "../src/db/async-db.ts";

Deno.test("db.snapshot: rolling snapshots on a schedule keep working", async () => {
  const dir = await Deno.makeTempDir({ prefix: "snap-roll-" });
  const db = createDB(join(dir, "a.db"));
  try {
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    await db.execute("INSERT INTO t (v) VALUES ('one')");
    const snap = join(dir, "a.db.snapshot");
    await db.snapshot!(snap);
    await db.execute("INSERT INTO t (v) VALUES ('two')");
    await db.snapshot!(snap); // this is the call that used to reject
    await db.snapshot!(snap);

    const check = createDB(snap, { readonly: true });
    const { rows } = await check.query<{ v: string }>("SELECT v FROM t");
    await check.close();
    assertEquals(rows.map((r) => r.v), ["one", "two"], "the LATEST snapshot");

    // No temp file left behind — the destination is replaced atomically.
    const names: string[] = [];
    for await (const e of Deno.readDir(dir)) names.push(e.name);
    assertEquals(
      names.filter((n) => n.includes(".tmp-")),
      [],
      `a snapshot never leaves a half-written file — saw ${names}`,
    );
  } finally {
    await db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("db.snapshot: the copy is verified before it replaces the previous one", async () => {
  // The verification runs on the COPY. Proving it fires needs a damaged copy,
  // which cannot be manufactured through VACUUM INTO — so this asserts the
  // observable contract instead: a good snapshot passes quick_check, and the
  // file that lands is one SQLite accepts.
  const dir = await Deno.makeTempDir({ prefix: "snap-verify-" });
  const db = createDB(join(dir, "a.db"));
  try {
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const snap = join(dir, "a.db.snapshot");
    await db.snapshot!(snap);
    const copy = createDB(snap, { readonly: true });
    const r = await copy.checkIntegrity!();
    await copy.close();
    assertEquals(r, { ok: true, problems: [] });
  } finally {
    await db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("dbPragmas: one override does not drop the other defaults", async () => {
  const merged = mergePragmas(DEFAULT_PRAGMAS, ["PRAGMA synchronous = FULL"]);
  assertEquals(merged.length, DEFAULT_PRAGMAS.length);
  assert(merged.includes("PRAGMA synchronous = FULL"));
  assert(merged.includes("PRAGMA foreign_keys = ON"));
  assert(merged.includes("PRAGMA busy_timeout = 5000"));
  assert(merged.includes("PRAGMA journal_mode = WAL"));
  // An unknown pragma is appended, not swallowed.
  assert(
    mergePragmas(DEFAULT_PRAGMAS, ["PRAGMA mmap_size = 1"]).includes(
      "PRAGMA mmap_size = 1",
    ),
  );
  assertEquals(pragmaName("PRAGMA  Synchronous = FULL"), "synchronous");
  // A readonly connection never gets a pragma that has to WRITE the file.
  assert(
    !pragmasFor(true).some((p) => p.includes("journal_mode")),
    "journal_mode = WAL on a readonly non-WAL file throws",
  );

  const dir = await Deno.makeTempDir({ prefix: "pragma-merge-" });
  const db = createDB(join(dir, "a.db"), {
    pragmas: ["PRAGMA synchronous = FULL"],
  });
  try {
    assertEquals(
      (await db.query<{ synchronous: number }>("PRAGMA synchronous")).rows[0]
        ?.synchronous,
      2,
      "the override applied",
    );
    assertEquals(
      (await db.query<{ timeout: number }>("PRAGMA busy_timeout")).rows[0]
        ?.timeout,
      5000,
      "and the defaults it did not name are still there",
    );
    assertEquals(
      (await db.query<{ journal_mode: string }>("PRAGMA journal_mode")).rows[0]
        ?.journal_mode,
      "wal",
    );
  } finally {
    await db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("db worker: an error names the statement and its parameter count", async () => {
  const db = createDB(":memory:");
  try {
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const one = await db.query("SELECT * FROM nope WHERE id = ?", [1]).then(
      () => null,
      (e: Error) => e.message,
    );
    assertStringIncludes(one!, "no such table: nope");
    assertStringIncludes(one!, "sql: SELECT * FROM nope");
    assertStringIncludes(one!, "params: 1");

    const tx = await db.transaction([
      { sql: "INSERT INTO t (id) VALUES (?)", params: [1] },
      { sql: "INSERT INTO t (id) VALUES (?)", params: [1] },
    ]).then(() => null, (e: Error) => e.message);
    assertStringIncludes(tx!, "UNIQUE constraint failed");
    assertStringIncludes(tx!, "transaction of 2 statement(s)");
    assertStringIncludes(tx!, "at statement 2");
    assertStringIncludes(tx!, "rolled back");
  } finally {
    await db.close();
  }
});

Deno.test("db worker: a request that can never answer fails instead of hanging", async () => {
  // No ceiling at all meant a worker that dies WITHOUT firing onerror left
  // every db.query() pending forever — on the dispatch path, that is a method
  // call that never returns.
  // The ceiling has to clear WORKER BOOT, not just the query. At 50ms the
  // setup statement below raced the worker's own startup: alone it won, under
  // a fully loaded suite it lost, and the test failed in 58ms on the CREATE
  // TABLE — never reaching the runaway query it exists to time out. Any value
  // is "instant" next to a query that never finishes, so pick one that cannot
  // lose that race.
  const db = createDB(":memory:", { requestTimeoutMs: 2000 });
  try {
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    // A statement that cannot finish inside the ceiling.
    const msg = await db.query(
      "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) " +
        "SELECT COUNT(*) FROM c",
    ).then(() => null, (e: Error) => e.message);
    assert(msg, "the request must not hang");
    assertStringIncludes(msg!, "did not answer");
    assertStringIncludes(msg!, "requestTimeoutMs");
  } finally {
    // The worker is wedged on the runaway query; terminate rather than drain.
    await Promise.race([
      db.close(),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
  }
});
