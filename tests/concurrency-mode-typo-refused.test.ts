// docs/state/methods.md:1063-1096 names exactly three `concurrency` modes —
// "newest", "first", "queue" — and :1123-1125 says the option is "checked at
// cell() time". Its siblings refuse a bad VALUE at cell() (`ttl: { m: "5m" }`
// → "must be a positive number of milliseconds"; `transaction` has
// refuseMalformedTransaction), and CLAUDE.md/pitfalls make a silent misconfig
// a bug ("a misspelled key is a stopped app, not a mystery").
//
// `concurrency: { go: "Newest" }` (or "latest", "drop", …) is accepted and
// silently means NO policy: both calls run to completion concurrently. The
// dev server transpiles without type-checking, so the `ConcurrencyMode` union
// does not stop it. src/state/cell-methods-factory.ts only checks the method
// name and that it is async, then `if (mode !== "newest") continue;`.
import { assertEquals, assertThrows } from "@std/assert";
import { cell } from "../mod.ts";
import { testCell } from "../src/cell-test.ts";

for (const bad of ["Newest", "latest", "drop", ""]) {
  Deno.test(`concurrency: an unknown mode ${JSON.stringify(bad)} throws at cell()`, () => {
    assertThrows(
      () =>
        cell(`r9conc${bad || "empty"}`, {
          state: { n: 0 },
          // deno-lint-ignore no-explicit-any
          concurrency: { go: bad as any },
          methods: {
            async go(s) {
              await 0;
              s.n++;
            },
          },
        }),
      Error,
      "concurrency",
    );
  });
}

// `{ go: cond ? "queue" : undefined }` type-checks and meant "no policy" on
// 1.0.12 — an explicit `undefined` is not a typo, so cell() must accept it
// and the method runs as if no policy were named.
const noPolicy = cell("r9concundef", {
  state: { n: 0 },
  concurrency: { go: undefined },
  methods: {
    async go(s) {
      await 0;
      s.n++;
    },
  },
});
testCell(
  noPolicy,
  "concurrency: an explicit undefined mode means no policy, not a throw",
  async (t) => {
    await t.send.go();
    await t.send.go();
    assertEquals(t.getState().n, 2);
  },
);
