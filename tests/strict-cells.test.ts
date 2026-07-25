// risoto 2026-07-24 Bad #2 (crash-only, piece 1): a cell that was defined
// (imported → cell() ran) but left out of aio.run({ cells }) dispatches into
// the void — a dead feature with green tests. `strictCells: true` turns that
// into a loud boot ERROR that names the orphaned cells.
import { assert, assertRejects } from "@std/assert";
import { aio } from "../src/server/aio.ts";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";

function twoCells() {
  // Both self-register in the global registry on definition.
  const used = cell("strict-used", {
    state: { n: 0 },
    methods: {
      inc(s: { n: number }) {
        s.n++;
      },
    },
  });
  const orphan = cell("strict-orphan", {
    state: { n: 0 },
    methods: {
      inc(s: { n: number }) {
        s.n++;
      },
    },
  });
  return { used, orphan };
}

Deno.test("strictCells: an imported-but-unregistered cell fails boot, named", async () => {
  _resetAioRuntime();
  const { used } = twoCells();
  const baseDir = await Deno.makeTempDir();
  const err = await assertRejects(
    () =>
      aio.run({
        cells: [used], // 'strict-orphan' is registered but omitted
        appId: "strict-cells-app",
        strictCells: true,
        libraryMode: true,
        persist: false,
        client: "server-only",
        baseDir,
      }),
    Error,
  );
  assert(/strictCells/.test(err.message), `got: ${err.message}`);
  assert(err.message.includes("strict-orphan"), "names the orphaned cell");
  assert(
    !err.message.includes("strict-used"),
    "the registered cell must not be flagged",
  );
  _resetAioRuntime();
});

Deno.test("strictCells: passing every cell boots fine", async () => {
  _resetAioRuntime();
  const { used, orphan } = twoCells();
  const app = await aio.run({
    cells: [used, orphan],
    appId: "strict-cells-ok",
    strictCells: true,
    libraryMode: true,
    persist: false,
    client: "server-only",
    baseDir: await Deno.makeTempDir(),
  });
  await app.close();
  _resetAioRuntime();
});

Deno.test("strictCells omitted: an orphan is tolerated (opt-in only)", async () => {
  _resetAioRuntime();
  const { used } = twoCells();
  const app = await aio.run({
    cells: [used], // orphan present, but strictCells not set → no throw
    appId: "strict-cells-off",
    libraryMode: true,
    persist: false,
    client: "server-only",
    baseDir: await Deno.makeTempDir(),
  });
  await app.close();
  _resetAioRuntime();
});
