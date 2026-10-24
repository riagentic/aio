// A snapshot saved by an OLDER build (before a field was added) loaded into
// this one: the restart path deep-merges the stored slice over the declared
// state, so the new field comes back at its default — the load path put the
// slice in as parsed. The cell then ran without the field until the next
// restart: `s.prefs.theme` threw REDUCE_ERROR on the first call. `--force`
// already fills a missing CELL with its declared state ("what every restart
// gives it"); a missing FIELD now gets the same. Nothing the snapshot holds is
// dropped or retyped here — that stays the shape-drift path's call.
import { assertEquals } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";

Deno.test("snapshot load: a declared field the snapshot lacks gets its declared default, as a restart gives it", async () => {
  const dir = await tempDir("aio-snap-fill-");
  const settings = cell("settings", {
    state: {
      name: "",
      prefs: { theme: "light", size: 12 },
      tags: [] as string[],
    },
    methods: {
      dark(s) {
        s.prefs.theme = "dark";
      },
    },
  });
  const app = await aio.run({
    cells: [settings],
    appId: `snapfill-${crypto.randomUUID().slice(0, 8)}`,
    client: "server-only",
    libraryMode: true,
    singleton: false,
    port: freePort(),
    appDir: dir,
    baseDir: dir,
    persist: false,
  });
  try {
    // Saved before `prefs` existed — and with `prefs.size` missing from a
    // later one; an extra stored field stays, as before.
    app.loadSnapshot!(JSON.stringify({ settings: { name: "kim", old: 1 } }));
    assertEquals(app.getState().settings, {
      name: "kim",
      old: 1,
      prefs: { theme: "light", size: 12 },
      tags: [],
    } as never);
    await settings.dark();
    assertEquals(
      (app.getState().settings as { prefs: { theme: string } }).prefs.theme,
      "dark",
    );
    app.loadSnapshot!(
      JSON.stringify({
        settings: { name: "", prefs: { theme: "x" }, tags: [] },
      }),
    );
    assertEquals(
      (app.getState().settings as { prefs: unknown }).prefs,
      { theme: "x", size: 12 },
    );
  } finally {
    await app.close();
    await dropTempDir(dir);
  }
});
