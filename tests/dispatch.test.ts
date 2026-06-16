import { assertEquals } from "@std/assert";
import { createDispatch, deepFreeze } from "../src/dispatch.ts";
import type { AioError } from "../src/error.ts";

const noop = { debug: () => {}, warn: () => {}, error: () => {} };

Deno.test("dispatch: basic action → reduce → effect", () => {
  let state = { count: 0 };
  const effects: string[] = [];

  const dispatch = createDispatch<
    typeof state,
    { type: string; payload: { by: number } },
    { type: string }
  >({
    reduce: (s, a) => ({
      state: { count: s.count + a.payload.by },
      effects: [{ type: "LOG" }],
    }),
    execute: (e) => {
      effects.push(e.type);
    },
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {},
    log: noop,
    debug: false,
  });

  dispatch({ type: "INC", payload: { by: 5 } });
  assertEquals(state.count, 5);
  assertEquals(effects, ["LOG"]);
});

Deno.test("dispatch: re-entrant — effects can dispatch follow-up actions", () => {
  let state = { count: 0 };
  let dispatchRef: ((a: { type: string }) => void) | null = null;

  const dispatch = createDispatch<
    typeof state,
    { type: string },
    { type: string }
  >({
    reduce: (s, a) => {
      if (a.type === "DOUBLE") {
        return { state: { count: s.count + 1 }, effects: [{ type: "AGAIN" }] };
      }
      if (a.type === "SINGLE") {
        return { state: { count: s.count + 10 }, effects: [] };
      }
      return { state: s, effects: [] };
    },
    execute: (e) => {
      if (e.type === "AGAIN") dispatchRef!({ type: "SINGLE" });
    },
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {},
    log: noop,
    debug: false,
  });

  dispatchRef = dispatch;
  dispatch({ type: "DOUBLE" });
  assertEquals(state.count, 11); // 1 from DOUBLE + 10 from SINGLE
});

Deno.test("dispatch: overflow guard prevents infinite loop", () => {
  let state = { n: 0 };
  const errors: AioError[] = [];
  let dispatchRef: ((a: { type: string }) => void) | null = null;

  const dispatch = createDispatch<
    typeof state,
    { type: string },
    { type: string }
  >({
    reduce: (s) => ({ state: { n: s.n + 1 }, effects: [{ type: "LOOP" }] }),
    execute: () => {
      dispatchRef!({ type: "LOOP" });
    },
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {},
    log: noop,
    debug: false,
    reportOpts: { onError: (err) => errors.push(err) },
  });

  dispatchRef = dispatch;
  dispatch({ type: "LOOP" });
  assertEquals(errors.some((e) => e.code === "DISPATCH_LOOP"), true);
});

Deno.test("dispatch: close() prevents further dispatching", () => {
  let state = { n: 0 };
  let warned = false;

  const dispatch = createDispatch<typeof state, { type: string }, never>({
    reduce: (s) => ({ state: { n: s.n + 1 }, effects: [] }),
    execute: () => {},
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {},
    log: {
      ...noop,
      warn: () => {
        warned = true;
      },
    },
    debug: false,
  });

  dispatch({ type: "A" });
  assertEquals(state.n, 1);

  dispatch.close();
  // B-4: a dropped action rejects — caller must not proceed as if applied.
  let rejected: AioError | null = null;
  dispatch({ type: "B" }).catch((e) => {
    rejected = e as AioError;
  });
  assertEquals(state.n, 1); // unchanged
  assertEquals(warned, true);
  // Allow the microtask to settle, then assert the rejection.
  return Promise.resolve().then(() => {
    assertEquals(rejected !== null, true);
    assertEquals((rejected as unknown as AioError).code, "DISPATCH_CLOSED");
  });
});

Deno.test("dispatch: dropped action rejects with QUEUE_OVERFLOW (B-4)", async () => {
  let state = { n: 0 };
  let dispatchRef: ((a: { type: string }) => Promise<void>) | null = null;
  let flood = false;
  const overflowRejections: AioError[] = [];

  const dispatch = createDispatch<typeof state, { type: string }, never>({
    reduce: (s) => ({ state: { n: s.n + 1 }, effects: [] }),
    execute: () => {},
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {
      if (flood) {
        flood = false;
        for (let i = 0; i < 10_001; i++) {
          dispatchRef!({ type: "QUEUED" }).catch((e: AioError) => {
            if (e.code === "QUEUE_OVERFLOW") overflowRejections.push(e);
          });
        }
      }
    },
    log: noop,
    debug: false,
  });

  dispatchRef = dispatch;
  flood = true;
  await dispatch({ type: "TRIGGER" });
  // The action(s) beyond QUEUE_MAX reject rather than silently resolving.
  assertEquals(overflowRejections.length > 0, true);
});

Deno.test("dispatch: bad reducer output is logged and skipped", () => {
  let state = { n: 0 };
  const errors: AioError[] = [];

  const dispatch = createDispatch<typeof state, { type: string }, never>({
    reduce: (s, a) => {
      if (a.type === "BAD") {
        return "not an object" as unknown as {
          state: typeof state;
          effects: never[];
        };
      }
      return { state: { n: s.n + 1 }, effects: [] };
    },
    execute: () => {},
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {},
    log: noop,
    debug: false,
    reportOpts: { onError: (err) => errors.push(err) },
  });

  dispatch({ type: "BAD" });
  assertEquals(state.n, 0); // state unchanged
  assertEquals(
    errors.some((e) =>
      e.code === "REDUCE_ERROR" && e.message.includes("reduce() must return")
    ),
    true,
  );

  // Valid action still works after bad one
  dispatch({ type: "GOOD" });
  assertEquals(state.n, 1);
});

Deno.test("dispatch: reducer throw is caught and skipped", () => {
  let state = { n: 0 };
  const errors: AioError[] = [];

  const dispatch = createDispatch<typeof state, { type: string }, never>({
    reduce: (s, a) => {
      if (a.type === "THROW") throw new Error("kaboom");
      return { state: { n: s.n + 1 }, effects: [] };
    },
    execute: () => {},
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {},
    log: noop,
    debug: false,
    reportOpts: { onError: (err) => errors.push(err) },
  });

  dispatch({ type: "THROW" });
  assertEquals(state.n, 0);
  assertEquals(errors.some((e) => e.code === "REDUCE_ERROR"), true);

  dispatch({ type: "OK" });
  assertEquals(state.n, 1);
});

Deno.test("dispatch: invalid effects (missing .type) are skipped", () => {
  let state = { n: 0 };
  const executed: string[] = [];
  let warned = false;

  const dispatch = createDispatch<
    typeof state,
    { type: string },
    { type: string }
  >({
    reduce: (s) => ({
      state: { n: s.n + 1 },
      effects: [
        { type: "VALID" },
        { noType: true } as unknown as { type: string },
        null as unknown as { type: string },
      ],
    }),
    execute: (e) => {
      executed.push(e.type);
    },
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {},
    log: {
      ...noop,
      warn: () => {
        warned = true;
      },
    },
    debug: false,
  });

  dispatch({ type: "X" });
  assertEquals(state.n, 1);
  assertEquals(executed, ["VALID"]); // only valid effect executed
  assertEquals(warned, true);
});

Deno.test("dispatch: effect throw is caught, other effects still run", () => {
  let state = { n: 0 };
  const executed: string[] = [];
  const errors: AioError[] = [];

  const dispatch = createDispatch<
    typeof state,
    { type: string },
    { type: string }
  >({
    reduce: (s) => ({
      state: { n: s.n + 1 },
      effects: [{ type: "FIRST" }, { type: "BOOM" }, { type: "THIRD" }],
    }),
    execute: (e) => {
      if (e.type === "BOOM") throw new Error("effect error");
      executed.push(e.type);
    },
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {},
    log: noop,
    debug: false,
    reportOpts: { onError: (err) => errors.push(err) },
  });

  dispatch({ type: "X" });
  assertEquals(executed, ["FIRST", "THIRD"]);
  assertEquals(errors.some((e) => e.code === "EFFECT_ERROR"), true);
});

Deno.test("dispatch: effectTimeout hard-cancels slow async effects", async () => {
  const errors: AioError[] = [];
  let state = { n: 0 };
  const dispatch = createDispatch<
    typeof state,
    { type: string },
    { type: string }
  >({
    reduce: (s) => ({ state: { n: s.n + 1 }, effects: [{ type: "SLOW" }] }),
    execute: (e) => {
      if (e.type === "SLOW") return new Promise((r) => setTimeout(r, 200));
    },
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {},
    log: noop,
    debug: false,
    effectTimeout: 50,
    reportOpts: { onError: (err) => errors.push(err) },
  });
  dispatch({ type: "A" });
  await new Promise((r) => setTimeout(r, 300));
  assertEquals(
    errors.some((e) =>
      e.code === "EFFECT_TIMEOUT" && e.message.includes("SLOW")
    ),
    true,
  );
});

Deno.test("dispatch: effectTimeout cleared when async effect completes quickly", async () => {
  let warnMsg = "";
  let state = { n: 0 };
  const dispatch = createDispatch<
    typeof state,
    { type: string },
    { type: string }
  >({
    reduce: (s) => ({ state: { n: s.n + 1 }, effects: [{ type: "FAST" }] }),
    execute: (e) => {
      if (e.type === "FAST") return new Promise((r) => setTimeout(r, 10));
    },
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {},
    log: {
      debug: () => {},
      warn: (m) => {
        warnMsg = m;
      },
      error: () => {},
    },
    debug: false,
    effectTimeout: 200,
  });
  dispatch({ type: "A" });
  await new Promise((r) => setTimeout(r, 300));
  assertEquals(warnMsg, ""); // no warning — effect completed before timeout
});

Deno.test("dispatch: effectTimeout=0 disables timeout", async () => {
  let warnMsg = "";
  let state = { n: 0 };
  const dispatch = createDispatch<
    typeof state,
    { type: string },
    { type: string }
  >({
    reduce: (s) => ({ state: { n: s.n + 1 }, effects: [{ type: "SLOW" }] }),
    execute: (e) => {
      if (e.type === "SLOW") return new Promise((r) => setTimeout(r, 100));
    },
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {},
    log: {
      debug: () => {},
      warn: (m) => {
        warnMsg = m;
      },
      error: () => {},
    },
    debug: false,
    effectTimeout: 0,
  });
  dispatch({ type: "A" });
  await new Promise((r) => setTimeout(r, 200));
  assertEquals(warnMsg, ""); // disabled — no warning
});

// ── Additional dispatch coverage ──

Deno.test("dispatch: deepFreeze state when freezeState=true", () => {
  let state = { count: 0 };
  const dispatch = createDispatch<typeof state, { type: string }, never>({
    reduce: (s) => ({ state: { count: s.count + 1 }, effects: [] }),
    execute: () => {},
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {},
    log: noop,
    debug: false,
    freezeState: true,
  });
  dispatch({ type: "A" });
  assertEquals(state.count, 1);
  assertEquals(Object.isFrozen(state), true);
});

Deno.test("dispatch: reportOpts.onError callback receives reduce errors", () => {
  let state = { n: 0 };
  const errors: AioError[] = [];
  const dispatch = createDispatch<typeof state, { type: string }, never>({
    reduce: () => {
      throw new Error("boom");
    },
    execute: () => {},
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {},
    log: noop,
    debug: false,
    reportOpts: { onError: (err) => errors.push(err) },
  });
  dispatch({ type: "X" });
  assertEquals(errors.length, 1);
  assertEquals(errors[0]!.source, "reduce");
  assertEquals(errors[0]!.code, "REDUCE_ERROR");
});

Deno.test("dispatch: onPerf callback receives timing info", () => {
  let state = { n: 0 };
  // deno-lint-ignore no-explicit-any
  let perfInfo: any = null;
  const dispatch = createDispatch<typeof state, { type: string }, never>({
    reduce: (s) => ({ state: { n: s.n + 1 }, effects: [] }),
    execute: () => {},
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {},
    log: noop,
    debug: false,
    onPerf: (t) => {
      perfInfo = t as { actionType: string; reduce: number };
    },
  });
  dispatch({ type: "Test" });
  assertEquals(perfInfo?.actionType, "Test");
  assertEquals(typeof perfInfo?.reduce, "number");
});

Deno.test("dispatch: errorCount tracks accumulated errors", () => {
  let state = { n: 0 };
  const dispatch = createDispatch<typeof state, { type: string }, never>({
    reduce: (_, a) => {
      if (a.type === "BAD") throw new Error("x");
      return { state: { n: 0 }, effects: [] };
    },
    execute: () => {},
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {},
    log: noop,
    debug: false,
  });
  dispatch({ type: "BAD" });
  dispatch({ type: "BAD" });
  dispatch({ type: "OK" });
  assertEquals(dispatch.errorCount(), 2);
});

Deno.test("dispatch: perfCheck on warns on budget violation via reportOpts", () => {
  let state = { n: 0 };
  const errors: AioError[] = [];
  const dispatch = createDispatch<typeof state, { type: string }, never>({
    reduce: (s) => {
      // Burn some time
      const end = performance.now() + 2;
      while (performance.now() < end) { /* spin */ }
      return { state: { n: s.n + 1 }, effects: [] };
    },
    execute: () => {},
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {},
    log: noop,
    debug: false,
    perfCheck: "on",
    perfBudget: { reduce: 0.01 }, // tiny budget to trigger
    reportOpts: { onError: (err) => errors.push(err) },
  });
  dispatch({ type: "SLOW" });
  assertEquals(errors.some((e) => e.code === "BUDGET_REDUCE"), true);
});

Deno.test("dispatch: debug mode logs action and state changes", () => {
  let state = { count: 0 };
  const debugLogs: string[] = [];
  const dispatch = createDispatch<
    typeof state,
    { type: string; payload: { by: number } },
    never
  >({
    reduce: (s, a) => ({
      state: { count: s.count + a.payload.by },
      effects: [],
    }),
    execute: () => {},
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {},
    log: { debug: (m) => debugLogs.push(m), warn: () => {}, error: () => {} },
    debug: true,
  });
  dispatch({ type: "INC", payload: { by: 1 } });
  assertEquals(debugLogs.some((l) => l.includes("action → reduce")), true);
  assertEquals(debugLogs.some((l) => l.includes("state: changed")), true);
});

Deno.test("dispatch: multiple actions queued are all processed", () => {
  let state = { n: 0 };
  let doneCalls = 0;
  const dispatch = createDispatch<typeof state, { type: string }, never>({
    reduce: (s) => ({ state: { n: s.n + 1 }, effects: [] }),
    execute: () => {},
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {
      doneCalls++;
    },
    log: noop,
    debug: false,
  });
  dispatch({ type: "A" });
  dispatch({ type: "B" });
  dispatch({ type: "C" });
  assertEquals(state.n, 3);
  assertEquals(doneCalls, 3); // each dispatch drains independently
});

Deno.test("deepFreeze: handles nested objects", () => {
  const obj = { a: { b: { c: 1 } }, d: [1, 2] };
  deepFreeze(obj);
  assertEquals(Object.isFrozen(obj), true);
  assertEquals(Object.isFrozen(obj.a), true);
  assertEquals(Object.isFrozen(obj.a.b), true);
});

Deno.test("deepFreeze: handles null and primitives", () => {
  assertEquals(deepFreeze(null), null);
  assertEquals(deepFreeze(42), 42);
  assertEquals(deepFreeze("str"), "str");
});

Deno.test("deepFreeze: skips already frozen", () => {
  const obj = Object.freeze({ x: 1 });
  const result = deepFreeze(obj);
  assertEquals(result, obj);
  assertEquals(Object.isFrozen(result), true);
});

Deno.test("dispatch: onDone called once after queue fully drains", () => {
  let state = { n: 0 };
  let doneCalls = 0;
  let dispatchRef: ((a: { type: string }) => void) | null = null;

  const dispatch = createDispatch<
    typeof state,
    { type: string },
    { type: string }
  >({
    reduce: (s, a) => {
      if (a.type === "FIRST") {
        return { state: { n: s.n + 1 }, effects: [{ type: "CHAIN" }] };
      }
      return { state: { n: s.n + 10 }, effects: [] };
    },
    execute: (e) => {
      if (e.type === "CHAIN") dispatchRef!({ type: "SECOND" });
    },
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {
      doneCalls++;
    },
    log: noop,
    debug: false,
  });

  dispatchRef = dispatch;
  dispatch({ type: "FIRST" });
  assertEquals(state.n, 11);
  assertEquals(doneCalls, 1); // called once, not per action
});

Deno.test("dispatch: queue depth limit drops actions beyond QUEUE_MAX", () => {
  let state = { n: 0 };
  const errors: AioError[] = [];
  let dispatchRef: ((a: { type: string }) => void) | null = null;

  // Use a reducer that queues a burst of re-entrant dispatches via onDone
  // The key is to fill the queue while dispatch is processing (dispatching=true)
  // so re-entrant calls go to queue without draining
  let floodOnDone = false;

  const dispatch = createDispatch<typeof state, { type: string }, never>({
    reduce: (s) => ({ state: { n: s.n + 1 }, effects: [] }),
    execute: () => {},
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {
      if (floodOnDone) {
        floodOnDone = false;
        // While inside onDone, dispatching=true, so these all queue
        for (let i = 0; i < 10_001; i++) {
          dispatchRef!({ type: "QUEUED" });
        }
      }
    },
    log: noop,
    debug: false,
    reportOpts: { onError: (err) => errors.push(err) },
  });

  dispatchRef = dispatch;
  floodOnDone = true;
  dispatch({ type: "TRIGGER" });
  // Queue depth exceeded error should fire for the action beyond 10_000
  assertEquals(errors.some((e) => e.code === "QUEUE_OVERFLOW"), true);
});

Deno.test("dispatch: onDone throw does not wedge dispatch loop", () => {
  let state = { n: 0 };
  const errors: AioError[] = [];

  const dispatch = createDispatch<typeof state, { type: string }, never>({
    reduce: (s) => ({ state: { n: s.n + 1 }, effects: [] }),
    execute: () => {},
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {
      throw new Error("onDone crash");
    },
    log: noop,
    debug: false,
    reportOpts: { onError: (err) => errors.push(err) },
  });

  dispatch({ type: "A" });
  assertEquals(state.n, 1);
  assertEquals(
    errors.some((e) =>
      e.code === "EFFECT_ERROR" && e.context.actionType === "onDone"
    ),
    true,
  );

  // Dispatch still works after onDone crash
  dispatch({ type: "B" });
  assertEquals(state.n, 2);
});

// ── Promise-returning dispatch tests ──

Deno.test("dispatch: returns Promise<void> that resolves after reduce + effects", async () => {
  let state = { count: 0 };
  const effects: string[] = [];

  const dispatch = createDispatch<
    typeof state,
    { type: string; payload: { by: number } },
    { type: string }
  >({
    reduce: (s, a) => ({
      state: { count: s.count + a.payload.by },
      effects: [{ type: "LOG" }],
    }),
    execute: (e) => {
      effects.push(e.type);
    },
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {},
    log: noop,
    debug: false,
  });

  const promise = dispatch({ type: "INC", payload: { by: 3 } });
  assertEquals(promise instanceof Promise, true);
  // State already updated synchronously before await
  assertEquals(state.count, 3);
  assertEquals(effects, ["LOG"]);
  // Promise resolves cleanly
  await promise;
});

Deno.test("dispatch: Promise resolves even on reduce error", async () => {
  let state = { n: 0 };
  const dispatch = createDispatch<typeof state, { type: string }, never>({
    reduce: () => {
      throw new Error("boom");
    },
    execute: () => {},
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {},
    log: noop,
    debug: false,
  });

  // Should not hang — Promise resolves even on error
  await dispatch({ type: "BAD" });
  assertEquals(state.n, 0);
});

Deno.test("dispatch: re-entrant dispatch returns Promise that resolves after processing", async () => {
  let state = { count: 0 };
  let dispatchRef: ((a: { type: string }) => Promise<void>) | null = null;

  const dispatch = createDispatch<
    typeof state,
    { type: string },
    { type: string }
  >({
    reduce: (s, a) => {
      if (a.type === "FIRST") {
        return { state: { count: s.count + 1 }, effects: [{ type: "CHAIN" }] };
      }
      if (a.type === "SECOND") {
        return { state: { count: s.count + 10 }, effects: [] };
      }
      return { state: s, effects: [] };
    },
    execute: (e) => {
      if (e.type === "CHAIN") dispatchRef!({ type: "SECOND" });
    },
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {},
    log: noop,
    debug: false,
  });

  dispatchRef = dispatch;
  const p = dispatch({ type: "FIRST" });
  assertEquals(state.count, 11); // both processed synchronously
  await p; // resolves cleanly
});

// ── structuredClone fail-loudly (audit F-8) ──

Deno.test(
  "dispatch: non-cloneable effect is reported and dropped (not JSON-coerced)",
  () => {
    const errors: AioError[] = [];
    let state = { n: 0 };
    // Effects containing a function cannot be structuredCloned.
    // Audit F-8: we no longer silently JSON-coerce (which lost undefined,
    // NaN, Infinity, Date, Map, Set). We report EFFECT_ERROR and drop the effect.
    const uncloneable = { type: "BAD", fn: () => {} };
    const executed: string[] = [];

    const dispatch = createDispatch<
      typeof state,
      { type: string },
      { type: string; fn?: () => void }
    >({
      reduce: (s) => ({
        state: { n: s.n + 1 },
        effects: [uncloneable],
      }),
      execute: (e) => {
        executed.push(e.type);
      },
      getState: () => state,
      setState: (s) => {
        state = s;
      },
      onDone: () => {},
      log: noop,
      debug: false,
      reportOpts: { onError: (err) => errors.push(err) },
    });

    dispatch({ type: "A" });
    // Reduce still succeeds — state advances.
    assertEquals(state.n, 1);
    // Effect is dropped rather than shipped with a corrupted payload.
    assertEquals(executed.length, 0);
    // A loud EFFECT_ERROR is reported so the app author sees the failure.
    assertEquals(errors.length, 1);
    assertEquals(errors[0]!.code, "EFFECT_ERROR");
  },
);

// ── effectTimeout hard-cancel — no double-report ──

Deno.test("dispatch: timed-out effect error suppressed if timeout already fired", async () => {
  const errors: AioError[] = [];
  let state = { n: 0 };
  const dispatch = createDispatch<
    typeof state,
    { type: string },
    { type: string }
  >({
    reduce: (s) => ({
      state: { n: s.n + 1 },
      effects: [{ type: "FAIL_LATE" }],
    }),
    execute: (e) => {
      if (e.type === "FAIL_LATE") {
        // Rejects AFTER timeout fires
        return new Promise((_, reject) =>
          setTimeout(() => reject(new Error("late")), 200)
        );
      }
    },
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {},
    log: noop,
    debug: false,
    effectTimeout: 50,
    reportOpts: { onError: (err) => errors.push(err) },
  });
  dispatch({ type: "A" });
  await new Promise((r) => setTimeout(r, 400));
  // Should get EFFECT_TIMEOUT only, not EFFECT_ASYNC_ERROR (no double-report)
  assertEquals(errors.filter((e) => e.code === "EFFECT_TIMEOUT").length, 1);
  assertEquals(errors.filter((e) => e.code === "EFFECT_ASYNC_ERROR").length, 0);
});

// ── AIO-118: double onDone on dispatch overflow ───────────────────────

Deno.test("AIO-118: onDone called exactly once on DISPATCH_MAX overflow", () => {
  let state = { n: 0 };
  let onDoneCount = 0;

  const dispatch = createDispatch<
    typeof state,
    { type: string },
    { type: string }
  >({
    reduce: (s, _a) => ({
      state: s,
      effects: [{ type: "LOOP" }],
    }),
    execute: (_e) => {
      // Re-entrant dispatch to trigger overflow
      dispatch({ type: "loop" });
    },
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {
      onDoneCount++;
    },
    log: noop,
    debug: false,
    reportOpts: { onError: () => {} },
  });

  dispatch({ type: "start" });

  assertEquals(
    onDoneCount,
    1,
    "onDone should be called exactly once on overflow, not twice",
  );
});
