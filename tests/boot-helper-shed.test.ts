// `bootCells` called from an async helper, after the helper's own `await`:
// its synchronous `_shedLeakedScopes()` then ran in the HELPER's continuation,
// never the test body's. A reducer's first `import()` in test one pins boot
// #1's fence as Deno's ambient context, so test two's body started fenced to
// the retired boot and its first call was refused as "dispatched into a
// torn-down runtime", naming the helper (a desktop app's field report). The
// harness now sheds at every test body's start (a `Deno.test.beforeEach`).
import { assertEquals } from "@std/assert";
import { bootCells } from "../src/testing/cell-test.ts";
import { cell } from "../src/state/cell-create.ts";

const c = cell("bootHelperShed", {
  state: { n: 0 },
  methods: {
    async load(s: { n: number }) {
      // A FRESH module, first evaluated inside the reducer's fence.
      await import("data:application/javascript,export default 1");
      s.n = 10;
    },
    inc(s: { n: number }) {
      s.n++;
    },
  },
});
// deno-lint-ignore no-explicit-any
const api = c as any;

/** The ordinary helper shape: its own `await` BEFORE it boots. */
async function rig() {
  await new Promise((r) => setTimeout(r, 0));
  const h = await bootCells([c]);
  await h.settle();
  return h;
}

Deno.test("helper boot: a reducer's first import() pins the ambient context", async () => {
  const h = await rig();
  await api.load();
  assertEquals(api.n, 10);
  h.dispose();
});

Deno.test("helper boot: the next test body is not fenced to the retired boot", async () => {
  const h = await rig();
  await api.inc();
  assertEquals(api.n, 1);
  h.dispose();
});
