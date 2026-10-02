// "exceeded budget: 5ms > 5ms" — a perf line must not state something false.
//
// The check compares the exact duration; the text rounded it. A reducer that
// took 5.4 ms against a 5 ms budget was reported as "5ms > 5ms", and the
// error an app sees (one decimal) had the same hole at 5.04 ms: "5.0ms > 5ms".
// The printed number now keeps as many digits as it takes to be over the
// budget it is said to exceed.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { overLimit } from "../src/diagnostics/fmt.ts";
import { logPerf } from "../src/diagnostics/logger-vitals.ts";
import type { LogEntry } from "../src/diagnostics/logger-types.ts";
import { createDispatch } from "../src/state/dispatch.ts";
import {
  type AioError,
  createAioError,
  generateTip,
} from "../src/diagnostics/error.ts";

Deno.test("overLimit: the text is over the limit whenever the value is", () => {
  // Well over: the usual precision, unchanged.
  assertEquals(overLimit(42.6, 16), "43");
  assertEquals(overLimit(15.23, 5, 1), "15.2");
  // Rounds down onto the limit: one more digit, and only as many as needed.
  assertEquals(overLimit(5.4, 5), "5.4");
  assertEquals(overLimit(5.04, 5), "5.04");
  assertEquals(overLimit(5.04, 5, 1), "5.04");
  assertEquals(overLimit(5.004, 5), "5.004");
  // Closer than three digits can show: the exact value.
  assertEquals(overLimit(5.0004, 5), "5.0004");
  // Rounds UP past the limit: already true at the usual precision.
  assertEquals(overLimit(5.6, 5), "6");
  // A fractional budget.
  assertEquals(overLimit(0.03, 0.001, 1), "0.03");
  // The property, over a sweep around the boundary.
  for (let i = 1; i <= 2000; i++) {
    const v = 5 + i / 1000;
    for (const digits of [0, 1]) {
      const text = overLimit(v, 5, digits);
      assert(Number(text) > 5, `${v} printed as ${text}`);
    }
  }
});

Deno.test("perf log: 5.4 ms against 5 ms is not printed as '5ms > 5ms'", () => {
  const entries: LogEntry[] = [];
  const write = (_p: string, e: LogEntry) => void entries.push(e);
  const run = (duration: number, breakdown?: Parameters<typeof logPerf>[4]) => {
    entries.length = 0;
    logPerf(
      "effect",
      "todo:add",
      duration,
      5,
      breakdown,
      write,
      (k) => k,
      false,
    );
    return entries[0]!;
  };
  const e = run(5.4);
  assertStringIncludes(e.msg, "exceeded budget: 5.4ms > 5ms");
  assertEquals((e.data as { duration: number }).duration, 5.4);
  assert(!run(5.04).msg.includes("5ms > 5ms"), run(5.04).msg);
  // With a breakdown: the same number.
  const b = { produce: 1, clone: 1, spread: 1, routing: 1, listeners: 1 };
  assertStringIncludes(run(5.4, b).msg, "exceeded budget: 5.4ms > 5ms (");
  // Far over: whole milliseconds, as before.
  assertStringIncludes(run(42.6).msg, "exceeded budget: 43ms > 5ms");
});

Deno.test("dispatch: a reduce barely over its budget reports a number over it", () => {
  const errors: AioError[] = [];
  const BUDGET = 5;
  const dispatch = createDispatch<{ n: number }, { type: "Spin" }, never>({
    // Returns the instant it is past the budget, so the measured time sits
    // just above it — where one decimal read "5.0ms > 5ms".
    reduce: (state) => {
      const t0 = performance.now();
      while (performance.now() - t0 <= BUDGET + 0.001) { /* spin */ }
      return { state, effects: [] };
    },
    execute: () => {},
    getState: () => ({ n: 0 }),
    setState: () => {},
    onDone: () => {},
    log: { debug: () => {}, warn: () => {}, error: () => {} },
    debug: false,
    reportOpts: { onError: (err) => errors.push(err) },
    perfCheck: "on",
    perfBudget: { reduce: BUDGET },
  });
  for (let i = 0; i < 8; i++) dispatch({ type: "Spin" });
  assertEquals(errors.length, 8);
  for (const err of errors) {
    const m = /exceeded budget: ([\d.]+)ms > ([\d.]+)ms/.exec(err.message);
    assert(m, err.message);
    assert(Number(m[1]) > Number(m[2]), err.message);
  }
});

Deno.test("budget tips: 'took Nms (budget: Nms)' never shows the same number twice", () => {
  const tip = (code: "BUDGET_REDUCE" | "BUDGET_EFFECT", duration: number) =>
    generateTip(createAioError(code, "x", { duration, budget: 5 })) ?? "";
  assertStringIncludes(tip("BUDGET_REDUCE", 5.4), "took 5.4ms (budget: 5ms)");
  assertStringIncludes(tip("BUDGET_EFFECT", 5.4), "took 5.4ms (budget: 5ms)");
  assertStringIncludes(tip("BUDGET_EFFECT", 15.2), "took 15ms (budget: 5ms)");
  // No duration recorded: said, not invented.
  assertStringIncludes(
    generateTip(createAioError("BUDGET_REDUCE", "x", { budget: 5 })) ?? "",
    "took ?ms (budget: 5ms)",
  );
});
