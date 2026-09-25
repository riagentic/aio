// Round 5 (db tier): the `am sql` route is READ-ONLY, and its guards scanned a
// copy of the query scrubbed by two regexes — comments first, then `'…'`
// literals. A `--` INSIDE a string literal is not a comment, but the first
// regex ate the rest of that line, the literal's closing quote with it; the
// second regex then paired the stray opening quote with the next quote in the
// query and blanked everything between them. So
//
//   WITH x AS (SELECT 1 LIMIT 1), y AS (SELECT '--')
//   DELETE FROM notes WHERE 'b' = 'b'
//
// scanned as `WITH … (SELECT ''b''b'` — no `;`, no DELETE, a LIMIT present —
// and the real query (one valid statement) ran on the writer and deleted
// every row. The guards now read the query through the db tier's SQL lexer,
// the one that knows a `--` inside quotes is text.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { aio } from "../src/server/aio.ts";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { pk, table, text } from "../src/server/sql.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("am sql: a `--` inside a string literal cannot smuggle a write past the read-only guard", async () => {
  const dir = await tempDir("am-sql-lexer-");
  _resetAioRuntime();
  const notes = cell("rosql", {
    state: { notes: [{ id: 1, body: "keep me" }] },
    methods: {},
  });
  const port = freePort();
  const app = await aio.run({
    cells: [notes],
    db: { "rosql.notes": table({ id: pk(), body: text() }) },
    appId: "rosql",
    dbPath: join(dir, "state.db"),
    port,
    persistDebounceMs: 5,
    libraryMode: true,
    client: "server-only",
    baseDir: dir,
  } as Any);
  const sql = async (query: string) => {
    const r = await fetch(`http://127.0.0.1:${port}/__aio/trojan/sql`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AIO": "1" },
      body: JSON.stringify({ query }),
    });
    return { status: r.status, body: await r.text() };
  };
  try {
    // The row is on disk before anything is attempted.
    const flushed = await fetch(
      `http://127.0.0.1:${port}/__aio/trojan/persist`,
      { method: "POST", headers: { "X-AIO": "1" } },
    );
    assertEquals(flushed.status, 200, await flushed.text());
    const before = await sql("SELECT id FROM rosql_notes");
    assertEquals(before.status, 200, before.body);
    assertEquals(JSON.parse(before.body), [{ id: 1 }]);

    const smuggled = [
      "WITH x AS (SELECT 1 LIMIT 1), y AS (SELECT '--')\n" +
      "DELETE FROM rosql_notes WHERE 'b' = 'b'",
      "WITH x AS (SELECT 1 LIMIT 1), y AS (SELECT '/*')\n" +
      "DELETE FROM rosql_notes WHERE '*/' = '*/'",
    ];
    for (const q of smuggled) {
      const r = await sql(q);
      assertEquals(r.status, 403, `refused as a write: ${q} → ${r.body}`);
    }
    const after = await sql("SELECT id FROM rosql_notes");
    assertEquals(JSON.parse(after.body), [{ id: 1 }], "no row was deleted");

    // Still answered: quotes and comments that hold write keywords or `;`.
    for (
      const q of [
        "SELECT '--' AS a, 'x;y' AS b FROM rosql_notes",
        "SELECT 'DROP TABLE x' AS note -- ; DELETE\nFROM rosql_notes",
      ]
    ) {
      const r = await sql(q);
      assertEquals(r.status, 200, `${q} → ${r.body}`);
    }
  } finally {
    await app.close();
    _resetAioRuntime();
    await dropTempDir(dir);
  }
});
