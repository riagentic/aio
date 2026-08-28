// AIO-421: `createDB(":memory:")` is the ephemeral, file-less
// DB mode for tests — a single Worker, closeable, no temp file. And an in-memory
// DB can't be shared across Workers, so a stray `readers > 0` is ignored (each
// reader would open its own empty :memory: DB and silently return no rows).

import { assert, assertEquals } from "jsr:@std/assert";
import { createDB } from "../src/server-entry.ts";

Deno.test("createDB(:memory:) round-trips without a file", async () => {
  const db = createDB(":memory:");
  try {
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    await db.execute("INSERT INTO t (id, v) VALUES (?, ?)", [1, "hi"]);
    const { rows } = await db.query<{ id: number; v: string }>(
      "SELECT * FROM t ORDER BY id",
    );
    assertEquals(rows, [{ id: 1, v: "hi" }]);
  } finally {
    await db.close();
  }
});

Deno.test("createDB(:memory:, {readers}) stays single-Worker — reads see writes", async () => {
  // Without the guard, a reader Worker opens a separate empty :memory: DB and
  // round-robined queries return []. The guard forces writer-only.
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => {
    const s = a.map(String).join(" ");
    if (s.includes(":memory:") || s.includes("readers")) warnings.push(s);
  };
  const db = createDB(":memory:", { readers: 2 });
  try {
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    await db.execute("INSERT INTO t (id) VALUES (1)");
    // Multiple reads — every one must see the row (single shared DB).
    for (let i = 0; i < 5; i++) {
      const { rows } = await db.query<{ id: number }>("SELECT * FROM t");
      assertEquals(rows, [{ id: 1 }], `read ${i} sees the write`);
    }
  } finally {
    console.warn = orig;
    await db.close();
  }
  assert(
    warnings.some((w) => w.includes("ignored for an in-memory DB")),
    `must warn that readers are ignored for :memory: — got ${
      JSON.stringify(warnings)
    }`,
  );
});
