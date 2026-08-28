// D9 config-threading: `dbPath` must ARRIVE at the storage boot (// per-test isolation: ":memory:" keeps hermetic runs off the shared data.db).
import { assert, assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { parseCli } from "../src/extras/mod.ts";

Deno.test("dbPath: ':memory:' persists in-session without touching cwd/data.db", async () => {
  _resetAioRuntime();
  const dir = await Deno.makeTempDir();
  const prev = Deno.cwd();
  Deno.chdir(dir);
  try {
    const c = cell("dbp-counter", {
      state: { n: 0 },
      methods: {
        inc(s) {
          s.n += 1;
        },
      },
    });
    const app = await aio.run({
      appId: "dbp-test",
      cells: [c],
      libraryMode: true,
      client: "server-only",
      dbPath: ":memory:",
    });
    await c.inc();
    const st = app.getState() as Record<string, { n: number }>;
    assertEquals(st["dbp-counter"]?.n, 1);
    await app.close();
    // The whole point: nothing was written next to the test's cwd.
    let dataDb = false;
    for await (const e of Deno.readDir(dir)) {
      if (e.name === "data.db") dataDb = true;
    }
    assert(!dataDb, "data.db must NOT be created when dbPath=':memory:'");
  } finally {
    Deno.chdir(prev);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
    _resetAioRuntime();
  }
});

Deno.test("dbPath: --db-path CLI flag parses", () => {
  const flags = parseCli(["--db-path=:memory:"]);
  assertEquals(flags.dbPath, ":memory:");
});
