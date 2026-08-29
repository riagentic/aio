// The harness measures what PRODUCTION measures.
//
// `testCell`/`testUI` boot the cells directly and never see `aio.run()`'s
// config, so every perf budget was the DEFAULT. A field report's app sets
// `perfBudget` to 60 for a method that legitimately takes ~15 ms; every UI test
// run printed:
//
//     WARN [BUDGET_EFFECT] effect exceeded budget: 15.2ms > 5ms …
//     Raise the budget for THIS method only:
//     perfBudget: { methods: { "dm:createIdentity": { effect: 40 } } }
//
// …recommending the override the app applied months ago. The cost is not the
// line: a suite that prints known-false warnings on every run teaches everyone
// to skim past the real ones.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";

const slow = cell("harness-budget", {
  state: { n: 0 },
  methods: {
    // Async, so the run counts as an EFFECT — and the burn is in the sync
    // prefix, which is the part the effect budget measures.
    async work(s) {
      const until = performance.now() + 25;
      while (performance.now() < until) {
        /* comfortably over the 5ms default */
      }
      s.n++;
      await Promise.resolve();
    },
  },
});

function capture(lines: string[]): LogSink {
  return {
    logDir: "",
    pub: (lvl: string, cat: string, msg: string) =>
      void lines.push(`${lvl} ${cat} ${msg}`),
    perf: () => {},
    flush: () => Promise.resolve(),
  } as unknown as LogSink;
}

async function budgetWarnings(
  perfBudget?: { effect?: number },
): Promise<string[]> {
  const lines: string[] = [];
  setLogger(capture(lines));
  try {
    const h = await bootCells([slow], { perfBudget });
    await slow.work();
    await h.settle();
    h.dispose();
  } finally {
    setLogger(null);
  }
  return lines.filter((l) => l.includes("exceeded budget"));
}

Deno.test("harness: without the app's budget, the default fires (the old behaviour)", async () => {
  const warns = await budgetWarnings(undefined);
  assert(
    warns.length > 0,
    "a 25 ms effect must exceed the 5 ms default — otherwise this test " +
      "proves nothing about the case below",
  );
});

Deno.test("harness: the app's perfBudget is honoured, so the warning does not fire", async () => {
  const warns = await budgetWarnings({ effect: 200 });
  assertEquals(
    warns,
    [],
    "the harness must measure against the app's own budget, not the default",
  );
});
