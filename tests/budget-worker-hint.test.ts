// `worker: true` was the best thing a field report adopted, and they found it
// by hand-rolling one first.
//
// quant §3: "Unambiguously the best thing I adopted this cycle — it deleted a
// hand-rolled worker and came out 456 lines lighter… The only criticism is
// discoverability: I hand-rolled first and found the built-in later. If a
// cell's tick regularly exceeds a frame budget, a dev-mode hint ('this cell
// blocked the loop for 340ms — consider `worker: true`') would route people to
// it at exactly the moment they care."
//
// The budget tips already named `blocking("id", fn, arg)` — the answer for ONE
// slow call. They never named the answer for a cell that is heavy every tick.
import { assert, assertEquals } from "@std/assert";
import { createAioError, generateTip } from "../src/diagnostics/error.ts";
import { _budgetMissCount, _resetBudgetMisses } from "../src/state/dispatch.ts";

const tipFor = (repeat: boolean, cell = "catalog") =>
  generateTip(
    createAioError("BUDGET_REDUCE", "slow", {
      cellName: cell,
      duration: 340,
      budget: 16,
      repeatOffender: repeat,
    }),
  ) ?? "";

Deno.test("budget tip: one slow call gets `blocking()`, not a thread", () => {
  const tip = tipFor(false);
  assert(tip.includes("blocking("), tip);
  assert(
    !tip.includes("worker: true"),
    `a FIRST violation must not advise a thread — a cold start, a first big ` +
      `import and one unlucky GC are each one slow tick: ${tip}`,
  );
});

Deno.test("budget tip: a repeat offender is routed to `worker: true`, by name", () => {
  const tip = tipFor(true);
  assert(tip.includes("worker: true"), tip);
  // Named, so the reader does not have to work out which cell.
  assert(tip.includes('cell("catalog"'), tip);
  assert(tip.includes("cell-workers.md"), "…and where to read about it");
  // Both answers stay available: the per-call one is still right for the
  // method that happens to be slow inside a cell that mostly is not.
  assert(tip.includes("blocking("), tip);
});

Deno.test("budget tip: the effect budget routes the same way", () => {
  const effect = (repeat: boolean) =>
    generateTip(
      createAioError("BUDGET_EFFECT", "slow", {
        cellName: "catalog",
        duration: 340,
        budget: 5,
        repeatOffender: repeat,
      }),
    ) ?? "";
  assert(!effect(false).includes("worker: true"));
  assert(effect(true).includes("worker: true"));
});

Deno.test("budget tip: the counter needs THREE, and is bounded", () => {
  _resetBudgetMisses();
  try {
    // A cold start, a first big import and one unlucky GC are each ONE slow
    // tick. Advising a thread on the strength of one is how a hint becomes
    // noise, so the third is the earliest honest moment.
    assertEquals(_budgetMissCount("a"), false);
    assertEquals(_budgetMissCount("a"), false);
    assertEquals(_budgetMissCount("a"), true, "three is the threshold");
    // Per cell, not global — a second cell starts its own count.
    assertEquals(_budgetMissCount("b"), false);
    // Bounded: a runaway app must not grow this map without limit.
    for (let i = 0; i < 200; i++) _budgetMissCount(`cell-${i}`);
    for (let i = 0; i < 3; i++) {
      // A cell that arrives after the cap is never promoted to "repeat".
      assertEquals(_budgetMissCount("late-arrival"), false);
    }
  } finally {
    _resetBudgetMisses();
  }
});
