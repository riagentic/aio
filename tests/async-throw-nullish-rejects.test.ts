// An async method that throws `null` / `undefined` — or awaits a promise
// rejected with no reason — used to RESOLVE its caller: every "did it fail?"
// test on the way out was truthiness. The error was logged, the caller was
// told it succeeded, and a `ttl` cached the failure as a success.
import { assertEquals, assertRejects } from "@std/assert";
import { cell } from "../mod.ts";
import { bootCells, testCell } from "../src/cell-test.ts";

const tick = () => new Promise((r) => setTimeout(r, 1));
let runs = 0;
const c = cell("nullish_throw", {
  state: { n: 0 },
  ttl: { cached: 60_000 },
  methods: {
    async tNull() {
      await tick();
      throw null;
    },
    async tUndef() {
      await tick();
      throw undefined;
    },
    async rejected() {
      await Promise.reject();
    },
    async cached() {
      runs++;
      await tick();
      throw null;
    },
  },
});

for (const m of ["tNull", "tUndef", "rejected"] as const) {
  Deno.test(`bootCells: ${m} rejects the caller, by name`, async () => {
    await using _h = await bootCells([c]);
    await assertRejects(() => c[m](), Error, `[nullish_throw:${m}] threw`);
  });
}

Deno.test("bootCells: a nullish failure is never cached by ttl", async () => {
  await using _h = await bootCells([c]);
  runs = 0;
  await assertRejects(() => c.cached());
  await assertRejects(() => c.cached());
  assertEquals(runs, 2);
});

testCell(c, "testCell: throw null rejects the caller", async (t) => {
  await assertRejects(() => t.send.tNull(), Error, "threw null");
});
