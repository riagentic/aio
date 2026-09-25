// A `db:`-bound state path is omitted from the KV snapshot by design — SQLite
// owns those rows. The boot's "declared field(s) not in the stored data" walk
// read that omission as news, so EVERY restart of EVERY app with a `db:`
// binding logged that the bound table was "new in this build, or a method
// deleted it" — a false alarm that buried the real line when a field WAS new.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { aio, cell, integer, pk, table, text } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

type Item = { id: number; t: string };
type H = { id: number; qty: number };
const mk = () =>
  cell("shop", {
    state: {
      items: [] as Item[],
      byId: {} as Record<string, H>,
      n: 0,
    },
    methods: {
      add(s, id: number) {
        s.items.push({ id, t: "x" });
        s.byId[String(id)] = { id, qty: 1 };
        s.n += 1;
      },
    },
  });

Deno.test("db: a bound array and a bound map are not reported as new fields on restart", async () => {
  const dir = await tempDir("db-bound-not-new-");
  const said: string[] = [];
  const orig = { log: console.log, info: console.info };
  const spy = (...a: unknown[]) => said.push(a.map(String).join(" "));
  const boot = (c: ReturnType<typeof mk>) =>
    aio.run({
      cells: [c],
      appId: "db-bound-not-new",
      client: "server-only",
      libraryMode: true,
      port: freePort(),
      dbPath: join(dir, "state.db"),
      baseDir: dir,
      persistDebounceMs: 10,
      db: {
        "shop.items": table({ id: pk(), t: text() }),
        "shop.byId": {
          table: table({ id: pk(), qty: integer() }),
          shape: "map",
        },
      },
    });
  try {
    let c = mk();
    let app = await boot(c);
    try {
      await c.add(1);
    } finally {
      await app.close();
    }
    console.log = spy;
    console.info = spy;
    c = mk();
    try {
      app = await boot(c);
    } finally {
      console.log = orig.log;
      console.info = orig.info;
    }
    try {
      const st = (app.getState() as { shop: { items: Item[]; n: number } })
        .shop;
      // The restart really restored from both stores — the premise.
      assertEquals(st.items, [{ id: 1, t: "x" }]);
      assertEquals(st.n, 1);
      assert(said.length > 0, "the boot logged nothing — spy not wired");
      assertEquals(
        said.filter((l) => l.includes("not in the stored data")),
        [],
      );
    } finally {
      await app.close();
    }
  } finally {
    await dropTempDir(dir);
  }
});
