// a field report #9 (their wishlist #2): every method in that app does real I/O —
// spawns cmake for minutes, reads a 2 MB GGUF header, drains a subprocess pipe.
// With one global budget, the 1 s polls logged a violation on EVERY tick, and
// there was no way to say "slow because it shells out" instead of "slow because
// it is badly written". The only remedy was raising both budgets globally:
// `{ reduce: 100, effect: 1000 }` + `effectTimeoutMs: 30_000` — "and lost the
// signal everywhere to silence one poller".
//
// A budget is a claim about what SHOULD be fast. Making that claim per method is
// the correct granularity: tight reducers keep a strict budget while the method
// whose job is to take four minutes is allowed to.
import { assertEquals } from "@std/assert";
import { createDispatch } from "../src/state/dispatch.ts";

type S = { n: number };
type A = { type: string; payload?: unknown };

/** A dispatch loop whose effects burn `ms` synchronously, recording every perf
 *  violation the framework reports. */
function harness(
  perfBudget: {
    effect?: number;
    methods?: Record<string, { effect?: number }>;
  },
  burnMs: number,
) {
  const violations: { type: string; actionType?: string; budget: number }[] =
    [];
  const dispatch = createDispatch<S, A, A>({
    reduce: (s: S, a: A) =>
      a.type.endsWith(":__exec")
        ? { state: s, effects: [a] }
        : { state: { n: s.n + 1 }, effects: [] },
    execute: () => {
      const until = performance.now() + burnMs;
      while (performance.now() < until); // sync burn — what a budget measures
    },
    getState: () => state,
    setState: (s: S) => {
      state = s;
    },
    perfBudget,
    perfLog: (
      source: string,
      actionType: string,
      _d: number,
      budget: number,
    ) => {
      violations.push({ type: source, actionType, budget });
    },
    onDone: () => {},
    log: {
      debug() {},
      info() {},
      warn() {},
      error() {},
      trace() {},
    } as unknown as Parameters<typeof createDispatch>[0]["log"],
    debug: false,
  });
  let state: S = { n: 0 };
  return { dispatch, violations };
}

const exec = (cell: string, method: string): A => ({
  type: `${cell}:__exec`,
  payload: { _method: method, _args: [], _callId: crypto.randomUUID() },
});

Deno.test("perf: a slow method trips the global budget by default", async () => {
  const h = harness({ effect: 5 }, 25);
  await h.dispatch(exec("builds", "compile"));
  assertEquals(h.violations.length, 1, "25ms against a 5ms budget is reported");
  assertEquals(h.violations[0]!.budget, 5);
});

Deno.test("perf: a per-method budget exempts the method that is MEANT to be slow", async () => {
  const h = harness({
    effect: 5, // everything stays strict…
    methods: { "builds:compile": { effect: 5_000 } }, // …except the one that shells out
  }, 25);
  await h.dispatch(exec("builds", "compile"));
  assertEquals(
    h.violations,
    [],
    "the method allowed to take seconds does not report a violation",
  );
});

Deno.test("perf: the strict budget still applies to every OTHER method", async () => {
  const h = harness({
    effect: 5,
    methods: { "builds:compile": { effect: 5_000 } },
  }, 25);
  // Same cell, different method — raising one budget must not blind the rest,
  // which is exactly what the global workaround did.
  await h.dispatch(exec("builds", "status"));
  assertEquals(h.violations.length, 1);
  assertEquals(
    h.violations[0]!.actionType,
    "builds:status",
    "the violation names the METHOD, not the shared `:__exec` effect type",
  );
  assertEquals(h.violations[0]!.budget, 5);
});

Deno.test("perf: a per-method budget is keyed by cell:method, not by cell", async () => {
  const h = harness({
    effect: 5,
    methods: { "other:compile": { effect: 5_000 } },
  }, 25);
  await h.dispatch(exec("builds", "compile"));
  assertEquals(
    h.violations.length,
    1,
    "a budget for another cell's same-named method must not apply here",
  );
});
