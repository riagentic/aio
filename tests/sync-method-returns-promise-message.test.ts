// A plain (non-`async`) method that returns a promise —
// `save(s) { return api.save(s.x) }` — is refused, rightly. The refusal named
// one cause only, "your build transpiled async functions", which is the rare
// one; the common one is a method simply not declared `async`.
import { assertRejects } from "@std/assert";
import { cell } from "../mod.ts";
import { bootCells } from "../src/cell-test.ts";

const api = { save: (_x: number) => Promise.resolve(1) };
const c = cell("sync_ret_promise", {
  state: { x: 1 },
  methods: {
    save(s) {
      return api.save(s.x);
    },
  },
});

Deno.test("the refusal names the missing `async` first", async () => {
  await using _h = await bootCells([c]);
  await assertRejects(
    () => c.save(),
    Error,
    "it is not an `async` function, so it ran as a reducer and its writes " +
      "were discarded. If it returns a promise on purpose " +
      "(`save(s) { return api.save(s.x) }`), declare it `async`",
  );
});
