// A `db:` binding (and a sync cell's op-log) writes `state.db` and is
// restored from it whatever `persist` says. Measured: `--no-persist` with a
// bound table wrote and restored the rows, and a cell's `persist: "none"` /
// `exclude: ["rows.secret"]` kept its bound rows — secret column included — on
// disk. Both were silent; boot now says so by name.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { aio, cell, pk, table, text } from "../mod.ts";
import { persistOffButStored } from "../src/server/aio-boot.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const b = [{
  table: "c_rows",
  path: ["c", "rows"],
  shape: "array",
  pk: "id",
}] as const;
const cfg = {
  shouldPersist: true,
  dbPath: undefined,
  syncCellIds: [] as string[],
  cellPersist: {},
};

Deno.test("persist: false names the bound tables and sync cells that still write the file", () => {
  const [m] = persistOffButStored(
    { ...cfg, shouldPersist: false, syncCellIds: ["doc"] },
    b as never,
  );
  assertMatch(m!, /db: table "c_rows", sync cell "doc" still write/);
  // In memory there is no file to write.
  assertEquals(
    persistOffButStored(
      { ...cfg, shouldPersist: false, dbPath: ":memory:" },
      b as never,
    ),
    [],
  );
});

Deno.test("a cell's persist filter that keeps its bound field off disk is named", () => {
  const said = (f: unknown) =>
    persistOffButStored({ ...cfg, cellPersist: { c: f } } as never, b as never);
  assertMatch(said("none")[0]!, /keeps "rows" off disk/);
  assertMatch(said({ exclude: ["rows.secret"] })[0]!, /keeps "rows.secret"/);
  assertMatch(said({ include: ["n"] })[0]!, /db: table "c_rows"/);
  assertEquals(said({ exclude: ["n"] }), []);
  assertEquals(said({ include: ["rows"] }), []);
  assertEquals(said("all"), []);
});

Deno.test("boot says it: persist: false with a bound table on a file", async () => {
  const dir = await tempDir("aio-persist-off-bound-");
  const warns: string[] = [];
  const orig = console.warn;
  const origLog = console.log;
  const grab = (...a: unknown[]) => warns.push(a.map(String).join(" "));
  console.warn = grab;
  console.log = grab;
  const c = cell("c", {
    state: { rows: [] as { id: number; name: string }[] },
    methods: {},
  });
  try {
    const app = await aio.run({
      cells: [c],
      appId: "persist-off-bound",
      client: "server-only",
      persist: false,
      libraryMode: true,
      singleton: false,
      port: 0,
      baseDir: dir,
      db: { "c.rows": table({ id: pk(), name: text() }) },
    });
    await app.close();
  } finally {
    console.warn = orig;
    console.log = origLog;
  }
  assert(
    warns.some((w) => w.includes('db: table "c_rows" still writes')),
    warns.join("\n"),
  );
});
