// Round 2 (db tier): the persistence manager's boot baseline is what
// `loadTables` read — an ARRAY of rows per table — and it was installed as-is
// for a `shape: "map"` binding too. The boot-time shape gate then refused it
// ("bound with shape \"map\" to a state value that is not a plain object (it
// is an array)"), so EVERY app with a map binding failed to boot.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { aio, cell, integer, pk, table } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

type H = { id: number; qty: number };
type S = { byId: Record<string, H> };
const mk = () =>
  cell("inv", {
    state: { byId: {} as Record<string, H> },
    methods: {
      put(s: S, id: number, qty: number) {
        s.byId[String(id)] = { id, qty };
      },
      del(s: S, id: number) {
        delete s.byId[String(id)];
      },
    },
  });
const boot = (c: ReturnType<typeof mk>, dir: string) =>
  aio.run({
    cells: [c],
    appId: "db-map-binding-boots",
    client: "server-only",
    libraryMode: true,
    port: freePort(),
    dbPath: join(dir, "state.db"),
    baseDir: dir,
    persistDebounceMs: 10,
    db: {
      "inv.byId": { table: table({ id: pk(), qty: integer() }), shape: "map" },
    },
  });
const byIdOf = (app: { getState(): unknown }) =>
  (app.getState() as { inv: S }).inv.byId;

Deno.test('db: an app with a shape "map" binding boots, persists and restores', async () => {
  const dir = await tempDir("db-map-boot-");
  try {
    let c = mk();
    let app = await boot(c, dir);
    try {
      await c.put(1, 5);
      await c.put(2, 7);
    } finally {
      await app.close();
    }
    c = mk();
    app = await boot(c, dir);
    try {
      assertEquals(byIdOf(app), {
        "1": { id: 1, qty: 5 },
        "2": { id: 2, qty: 7 },
      });
      await c.del(1);
      await c.put(2, 9);
    } finally {
      await app.close();
    }
    c = mk();
    app = await boot(c, dir);
    try {
      assertEquals(byIdOf(app), { "2": { id: 2, qty: 9 } });
    } finally {
      await app.close();
    }
  } finally {
    await dropTempDir(dir);
  }
});
