// The shutdown budget the docs QUOTE is the one the code spends.
//
// `docs/persistence/how-it-works.md` does not merely mention these numbers, it
// tells operators to configure a supervisor from them:
//
//   "Anything that waits for an aio app to exit before escalating to SIGKILL
//    must wait at least SHUTDOWN_BUDGET_MS (3 s + 5 s), or it cuts a
//    legitimate final flush short."
//
// So a `TimeoutStopSec` is written from that sentence, and if the constant
// later moves and the sentence does not, every supervisor configured from it
// starts SIGKILLing a legitimate final flush — losing the last persist window,
// silently, on machines nobody is watching.
//
// This drift has already happened once in this codebase, between `am` and the
// runtime: `shutdown-budget.ts`'s own header records that `am` "used to retype
// its own 3 s and 5 s next to a runtime that" could change them. That copy was
// removed by making one decider; the DOC is the copy that was left, and
// nothing referenced these constants from tests at all.
import { assertEquals } from "@std/assert";
import {
  DRAIN_TIMEOUT_MS,
  SHUTDOWN_BUDGET_MS,
  TEARDOWN_TIMEOUT_MS,
} from "../src/server/shutdown-budget.ts";

const DOC = "docs/persistence/how-it-works.md";

/** The seconds the doc states beside `name`, as a number of ms. */
function quotedMs(text: string, name: string): number[] {
  const out: number[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes(name)) continue;
    // "up to **3 s** (`DRAIN_TIMEOUT_MS`)" / "(3 s + 5 s)" — every duration on
    // the line that mentions the constant.
    for (const m of line.matchAll(/(\d+(?:\.\d+)?)\s*s\b/g)) {
      out.push(Math.round(Number(m[1]) * 1000));
    }
  }
  return out;
}

Deno.test("docs: the shutdown budget in prose is the one in code", async () => {
  const text = await Deno.readTextFile(new URL(`../${DOC}`, import.meta.url));

  const drain = quotedMs(text, "DRAIN_TIMEOUT_MS");
  assertEquals(
    drain.includes(DRAIN_TIMEOUT_MS),
    true,
    `${DOC} states ${drain.join(", ")} beside DRAIN_TIMEOUT_MS, which is ` +
      `${DRAIN_TIMEOUT_MS}ms — an operator sizing TimeoutStopSec from that ` +
      `sentence cuts the final flush short`,
  );

  const teardown = quotedMs(text, "TEARDOWN_TIMEOUT_MS");
  assertEquals(
    teardown.includes(TEARDOWN_TIMEOUT_MS),
    true,
    `${DOC} states ${teardown.join(", ")} beside TEARDOWN_TIMEOUT_MS, which ` +
      `is ${TEARDOWN_TIMEOUT_MS}ms`,
  );

  // The sentence a supervisor is configured from spells the budget as its two
  // halves — both must still be the real ones, and they must still add up.
  const budget = quotedMs(text, "SHUTDOWN_BUDGET_MS");
  assertEquals(
    budget.sort((a, b) => a - b),
    [DRAIN_TIMEOUT_MS, TEARDOWN_TIMEOUT_MS].sort((a, b) => a - b),
    `${DOC} spells SHUTDOWN_BUDGET_MS as ${budget.join(" + ")}ms; the code ` +
      `spends ${DRAIN_TIMEOUT_MS} + ${TEARDOWN_TIMEOUT_MS}`,
  );
  assertEquals(
    SHUTDOWN_BUDGET_MS,
    DRAIN_TIMEOUT_MS + TEARDOWN_TIMEOUT_MS,
    "the budget is the sum of its two halves",
  );
});
