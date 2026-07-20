// AIO-419 (risoto "the evil"): a `db:` table named after a cell's object slice
// silently overwrote that slice with a raw row array at boot, so the cell's
// methods exploded (`s.nfts.filter` when `s` is now the array). The only guard
// was a code comment. Now it throws loudly at boot, naming both. A table mapping
// to an ARRAY slice (the intended auto-sync store) is still allowed.

import { assert, assertRejects } from "jsr:@std/assert";

const PORT = 9360 + (Deno.pid % 150);

Deno.test("db: table named after an object-slice cell throws at boot", async () => {
  const { cell, aio, table, pk, text } = await import("../mod.ts");
  const nfts = cell("nfts", {
    state: { items: [] as Array<{ mint: string }> },
    methods: {
      add(s: { items: Array<{ mint: string }> }, mint: string) {
        s.items.push({ mint });
      },
    },
  });

  const err = await assertRejects(
    () =>
      aio.run({
        cells: [nfts],
        appId: "test-db-collision",
        appVersion: "0.0.0",
        client: "server-only",
        persist: false,
        libraryMode: true,
        port: PORT,
        baseDir: Deno.makeTempDirSync(),
        // Table named "nfts" — same as the cell → footgun.
        db: { nfts: table({ mint: pk(), image: text() }) },
      }),
    Error,
  );
  assert(
    /collides with cell "nfts"/.test(err.message),
    `error must name the collision: ${err.message}`,
  );
});

Deno.test("db: table with a non-colliding name boots fine", async () => {
  const { cell, aio, table, pk, text } = await import("../mod.ts");
  const nfts = cell("nfts2", {
    state: { items: [] as Array<{ mint: string }> },
    methods: { noop(_s: { items: unknown[] }) {} },
  });

  const app = await aio.run({
    cells: [nfts],
    appId: "test-db-nocollision",
    appVersion: "0.0.0",
    client: "server-only",
    persist: false,
    libraryMode: true,
    port: PORT + 1,
    baseDir: Deno.makeTempDirSync(),
    db: { nft_rows: table({ mint: pk(), image: text() }) }, // distinct name → ok
  });
  await app.close();
});
