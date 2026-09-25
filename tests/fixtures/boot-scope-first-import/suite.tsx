// Run as a CHILD `deno test` by tests/boot-scope-first-import.test.ts — the
// leak is test-to-test, so it needs a test file of its own. The report's
// repro, once per harness entry: a reducer's FIRST `import()` of a module
// (fresh: written by the parent into a temp dir) pinned Deno's ambient async
// context to the importing reducer's — its boot's fence — and the NEXT test's
// body ran inside it: its first cell call was refused as "dispatched into a
// torn-down runtime". Not named *.test.* so the suite never collects it.
import { cell } from "../../../mod.ts";
import { bootCells, testCell, testUI } from "../../../src/cell-test.ts";

const dir = Deno.env.get("AIO_FRESH_MODULE_DIR");
if (!dir) throw new Error("AIO_FRESH_MODULE_DIR unset — run via the parent");
const fresh = (name: string) => new URL(`file://${dir}/${name}.ts`).href;

// ── testUI ────────────────────────────────────────────────────────────────
const u = cell("bsfi_ui", {
  state: { n: 0 },
  methods: {
    go(s) {
      s.n++;
      void import(fresh("ui")).catch(() => {});
    },
    inc(s) {
      s.n++;
    },
  },
});
function Host() {
  return <div />;
}
testUI(Host, "testUI one: a reducer imports a fresh module", async (ui) => {
  u.go();
  await ui.settle();
  await new Promise((r) => setTimeout(r, 50)); // the import evaluates
});
testUI(Host, "testUI two: the next body's call is not refused", async (ui) => {
  u.inc();
  await ui.settle();
  await ui.expectCell(u, (s) => s.n === 1);
});
testUI(Host, "testUI three: the handle form too", async () => {
  await using ui = await testUI(Host);
  u.inc();
  await ui.settle();
  await ui.expectCell(u, (s) => s.n === 1);
});

// ── testCell ──────────────────────────────────────────────────────────────
const c = cell("bsfi_cell", {
  state: { n: 0 },
  methods: {
    go(s) {
      s.n++;
      void import(fresh("cell")).catch(() => {});
    },
    inc(s) {
      s.n++;
    },
  },
});
testCell(c, "one: a reducer imports a fresh module", async (t) => {
  t.send.go();
  await t.settle();
  await new Promise((r) => setTimeout(r, 50));
});
testCell(c, "two: the next body's call is not refused", async (t) => {
  t.send.inc();
  await t.settle();
  t.expect.state((s) => s.n === 1);
});

// ── bootCells ─────────────────────────────────────────────────────────────
const b = cell("bsfi_boot", {
  state: { n: 0 },
  methods: {
    go(s) {
      s.n++;
      void import(fresh("boot")).catch(() => {});
    },
    inc(s) {
      s.n++;
    },
  },
});
Deno.test("bootCells one: a reducer imports a fresh module", async () => {
  const h = await bootCells([b]);
  await b.go();
  await h.settle();
  await new Promise((r) => setTimeout(r, 50));
  await h.dispose();
});
Deno.test("bootCells two: the next body's call is not refused", async () => {
  const h = await bootCells([b]);
  await b.inc();
  await h.settle();
  if (b.n !== 1) throw new Error(`n = ${b.n}`);
  await h.dispose();
});
