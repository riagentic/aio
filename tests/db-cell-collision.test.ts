// AIO-419: a `db:` table named after a cell's object slice silently overwrote
// that slice with a raw row array at boot, so the cell's methods exploded
// (`s.nfts.filter` when `s` is now the array). The guard was a hard boot throw
// — which, under the cells API, also made the DOCUMENTED shape unbootable
// (`examples/contacts`), because every root state key is a cell id.
//
// The overwrite is now structurally impossible: rows are placed at the state
// path a table is BOUND to (a cell's array field) and nowhere else. So this
// shape boots, the cell's slice is untouched, and the boot log names the
// working alternative. Decision table: tests/db-cell-binding.test.ts.

import { assert, assertEquals } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";
import { resolveDbBindings } from "../src/server/aio-boot.ts";

const PORT = freePort();
const PORT2 = freePort();

Deno.test("db: a table named after a cell never overwrites that cell's slice", async () => {
  const { cell, aio, table, pk, text } = await import("../mod.ts");
  const nfts = cell("nfts", {
    state: { items: [] as Array<{ mint: string }> },
    methods: {
      add(s: { items: Array<{ mint: string }> }, mint: string) {
        s.items.push({ mint });
      },
    },
  });

  const app = await aio.run({
    cells: [nfts],
    appId: "test-db-collision",
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port: PORT,
    baseDir: Deno.makeTempDirSync(),
    dbPath: ":memory:",
    // Table named "nfts" — same as the cell. The cell has no ARRAY field
    // "nfts", so nothing binds: the table is SQL-only, and boot says so.
    db: { nfts: table({ mint: pk(), image: text() }) },
  });

  try {
    // The cell still owns its slice, and its methods still work.
    await nfts.add("mint-1");
    const state = app.getState() as unknown as {
      nfts: { items: Array<{ mint: string }> };
    };
    assertEquals(state.nfts.items, [{ mint: "mint-1" }]);
  } finally {
    await app.close();
  }

  // …and the boot log names the near-miss and the fix (checked on the
  // resolver, which is where the message is produced).
  const warns: string[] = [];
  resolveDbBindings(
    { nfts: { items: [] } },
    { nfts: table({ mint: pk(), image: text() }) },
    { info: () => {}, warn: (m: string) => warns.push(m) },
  );
  assert(
    warns.some((m) =>
      m.includes("SQL-only") && m.includes(`Cell "nfts" exists`) &&
      m.includes("nfts.items")
    ),
    `the near-miss must be loud and name the fix: ${warns.join(" | ")}`,
  );
});

Deno.test("db: a table with a non-colliding name boots fine", async () => {
  const { cell, aio, table, pk, text } = await import("../mod.ts");
  const nfts = cell("nfts2", {
    state: { items: [] as Array<{ mint: string }> },
    methods: { noop(_s: { items: unknown[] }) {} },
  });

  const app = await aio.run({
    cells: [nfts],
    appId: "test-db-nocollision",
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port: PORT2,
    baseDir: Deno.makeTempDirSync(),
    dbPath: ":memory:",
    db: { nft_rows: table({ mint: pk(), image: text() }) }, // distinct name → ok
  });
  await app.close();
});
