// Run as a CHILD `deno test` by tests/boot-scope-first-import.test.ts — the
// worker-scope half. A `worker: true` cell's reducer runs inside the in-process
// worker scope (`_workerScope`, boot-refusals.ts); its FIRST `import()` of a
// module pinned that scope as Deno's ambient context, so the NEXT test's body
// read as the worker's own code: its read of a peer cell was refused with
// "peer read in worker" words, and its method call met the unbound guard.
// Not named *.test.* so the suite never collects it.
import { cell } from "../../../mod.ts";
import { bootCells } from "../../../src/cell-test.ts";

const dir = Deno.env.get("AIO_FRESH_MODULE_DIR");
if (!dir) throw new Error("AIO_FRESH_MODULE_DIR unset — run via the parent");

const peer = cell("bsfiw_peer", {
  state: { v: 7 },
  methods: {
    bump(s) {
      s.v++;
    },
  },
});
const heavy = cell("bsfiw_heavy", {
  worker: true,
  state: { n: 0 },
  methods: {
    go(s) {
      s.n++;
      void import(new URL(`file://${dir}/worker.ts`).href).catch(() => {});
    },
  },
});

Deno.test("worker one: a worker cell's reducer imports a fresh module", async () => {
  const h = await bootCells([peer, heavy]);
  await heavy.go();
  await h.settle();
  await new Promise((r) => setTimeout(r, 50)); // the import evaluates
  await h.dispose();
});
Deno.test("worker two: the next body is no worker's code", async () => {
  const h = await bootCells([peer, heavy]);
  if (peer.v !== 7) throw new Error(`peer.v = ${peer.v}`);
  await peer.bump();
  await h.settle();
  if ((peer.v as number) !== 8) throw new Error(`peer.v = ${peer.v}`);
  await h.dispose();
});
