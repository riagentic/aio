// a field report: a wallet wants `synchronous = FULL` for its own data —
// aio's default (WAL + NORMAL) is right for a cache and wrong for seeds, and
// there was no way to say so from aio.run().
import { assertEquals } from "@std/assert";
import { createDB, DEFAULT_PRAGMAS } from "../src/server-entry.ts";

Deno.test("createDB honours custom pragmas", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const db = createDB(`${dir}/t.db`, {
      pragmas: [
        "PRAGMA journal_mode = WAL",
        "PRAGMA synchronous = FULL",
      ],
    });
    const { rows } = await db.query<{ synchronous: number }>(
      "PRAGMA synchronous",
    );
    assertEquals(rows[0]?.synchronous, 2, "2 = FULL");
    await db.close();

    const dflt = createDB(`${dir}/d.db`);
    const r2 = await dflt.query<{ synchronous: number }>("PRAGMA synchronous");
    assertEquals(r2.rows[0]?.synchronous, 1, "default stays NORMAL");
    await dflt.close();
    assertEquals(DEFAULT_PRAGMAS.includes("PRAGMA synchronous = NORMAL"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
