// docs/persistence/auto-persist.md: `force: true` loads a snapshot whose cell
// set does not match, giving each missing cell "what a restart gives it". An
// UNDECLARED cell in the file was kept in live state: `snapshot()` exported it
// and the next boot silently discarded it — memory and disk disagreed.
import { assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("app.loadSnapshot force: an undeclared cell is dropped, as a restart drops it", async () => {
  const counter = cell("counter", {
    state: { count: 1 },
    methods: {
      inc(s: { count: number }) {
        s.count++;
      },
    },
  });
  const dir = await tempDir("aio-loadsnap-force-");
  const app = await aio.run({
    cells: [counter],
    appId: `loadsnap-force-${crypto.randomUUID().slice(0, 8)}`,
    appDir: dir,
    client: "server-only",
    libraryMode: true,
    singleton: false,
    persist: false,
    port: freePort(),
    // deno-lint-ignore no-explicit-any
  } as any);
  try {
    app.loadSnapshot!('{"counter":{"count":9},"stranger":{"secret":1}}', {
      force: true,
    });
    assertEquals(app.getState(), { counter: { count: 9 } });
    assertEquals(JSON.parse(app.snapshot!()), { counter: { count: 9 } });
  } finally {
    await app.close();
    await dropTempDir(dir);
  }
});
