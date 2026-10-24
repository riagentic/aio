// A reporter that throws never decides whether an action applies.
//
// Observe-only means observe-only: an over-budget reducer printed a perf line,
// a test's console stub threw on it, and the throw escaped the drain loop —
// the action was rejected DISPATCH_ABORTED and never committed. Every
// reporting call the dispatcher makes (its log, the error reporter, the
// diagnostic bus, onPerf, perfLog, reduceBreakdown) must be unable to do that.
import { assertEquals } from "@std/assert";
import { createDispatch } from "../src/state/dispatch.ts";

type Act = { type: string };
const boom = () => {
  throw new Error("reporter boom");
};

function make(over: Record<string, unknown> = {}) {
  let state = 0;
  const dispatch = createDispatch<number, Act, Act>({
    reduce: (s, a) => {
      if (a.type === "c:slow") {
        const end = performance.now() + 5;
        while (performance.now() < end) { /* over the 1 ms budget */ }
      }
      return {
        state: s + 1,
        // an invalid effect makes the loop WARN; a real one runs the effect path
        effects: [{ type: "c:fx" }, {} as Act],
      };
    },
    execute: () => {},
    getState: () => state,
    setState: (s) => void (state = s),
    onDone: () => {},
    log: { debug: boom, warn: boom, error: boom },
    debug: true,
    perfBudget: { reduce: 1, effect: 1 },
    perfLog: boom,
    onPerf: boom,
    reduceBreakdown: boom,
    reportOpts: { logger: { error: boom, warn: boom, info: boom } },
    ...over,
  });
  return { dispatch, state: () => state };
}

Deno.test("dispatch: throwing log/perfLog/onPerf/breakdown/logger + console — every action still commits", async () => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = boom;
  try {
    const { dispatch, state } = make();
    // an over-budget reduce (the B16 shape), then a normal one queued behind it
    const a = dispatch({ type: "c:slow" });
    const b = dispatch({ type: "c:ok" });
    await a;
    await b;
    assertEquals(state(), 2);
    // the lost reports are counted, not hidden
    assertEquals(dispatch.errorCount() > 0, true);
  } finally {
    Object.assign(console, saved);
  }
});

Deno.test("dispatch: a throwing log on the reduce-error path — the caller gets ITS error and the queued self-call still commits", async () => {
  let state = 0;
  let self: ((a: Act) => Promise<unknown>) | null = null;
  const dispatch = createDispatch<number, Act, Act>({
    reduce: (s, a) => {
      if (a.type === "c:bad") {
        self!({ type: "c:ok" }); // queued, survives the throw (and is WARNED)
        throw new Error("bad reducer");
      }
      return { state: s + 1, effects: [] };
    },
    execute: () => {},
    getState: () => state,
    setState: (s) => void (state = s),
    onDone: () => {},
    log: { debug: boom, warn: boom, error: boom },
    debug: false,
    reportOpts: { onError: () => {} },
  });
  self = dispatch;
  const err = await dispatch({ type: "c:bad" }).then(
    () => null,
    (e) => e as { code: string; message: string },
  );
  assertEquals(err?.message.includes("bad reducer"), true);
  assertEquals(state, 1);
});
