import { assertEquals, assertRejects } from "@std/assert";
import { createDispatch, deepFreeze } from "../src/state/dispatch.ts";
import type { AioError } from "../src/diagnostics/error.ts";
import { initDiagnostics } from "../src/diagnostics/mod.ts";
import { computeDiffs, formatDiff } from "../src/diagnostics/state-diff.ts";

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

Deno.test("dispatch: System ':__destroy' teardown still runs after close()", () => {
  // Shutdown closes dispatch up front (reject late client input before the
  // final persist), but cell teardown is dispatched afterwards from
  // destroyAll(). That lifecycle action must still apply — and must NOT warn.
  let state = { n: 0 };
  let warned = false;

  const dispatch = createDispatch<
    typeof state,
    { type: string; _source?: string },
    never
  >({
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

  dispatch.close();

  // System-sourced teardown → applied, no warning.
  dispatch({ type: "doc:__destroy", _source: "System" });
  assertEquals(state.n, 1);
  assertEquals(warned, false);

  // A client ':__destroy' (no System source) is NOT lifecycle → still dropped.
  let rejected: AioError | null = null;
  dispatch({ type: "doc:__destroy" }).catch((e) => {
    rejected = e as AioError;
  });
  // A non-teardown System action is also still dropped.
  dispatch({ type: "doc:tick", _source: "System" }).catch(() => {});
  assertEquals(state.n, 1); // unchanged by the dropped actions
  assertEquals(warned, true);
  return Promise.resolve().then(() => {
    assertEquals((rejected as unknown as AioError)?.code, "DISPATCH_CLOSED");
  });
});

Deno.test("dispatch: dropped action rejects with QUEUE_OVERFLOW (B-4)", async () => {
  let state = { n: 0 };
  let dispatchRef: ((a: { type: string }) => Promise<unknown>) | null = null;
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

Deno.test("dispatch: bad reducer output is logged and skipped", async () => {
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

  // B-4: malformed reduce shape rejects the awaiter — state did not apply.
  await assertRejects(
    () => dispatch({ type: "BAD" }),
    Error,
    "reduce() must return",
  );
  assertEquals(state.n, 0); // state unchanged
  assertEquals(
    errors.some((e) =>
      e.code === "REDUCE_ERROR" && e.message.includes("reduce() must return")
    ),
    true,
  );

  // Valid action still works after bad one
  await dispatch({ type: "GOOD" });
  assertEquals(state.n, 1);
});

Deno.test("dispatch: reducer throw is caught and skipped", async () => {
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

  // B-4: reducer throw rejects the awaiter — state did not apply.
  await assertRejects(() => dispatch({ type: "THROW" }), Error, "kaboom");
  assertEquals(state.n, 0);
  assertEquals(errors.some((e) => e.code === "REDUCE_ERROR"), true);

  // Subsequent valid action still works — queue is not poisoned.
  await dispatch({ type: "OK" });
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

Deno.test("dispatch: reportOpts.onError callback receives reduce errors", async () => {
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
  await assertRejects(() => dispatch({ type: "X" }), Error, "boom");
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

Deno.test("dispatch: Promise rejects on reduce error (B-4 contract)", async () => {
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

  // B-4: a reducer throw means the state change never applied — awaiter must
  // learn the action failed, not resolve as if it had succeeded.
  await assertRejects(() => dispatch({ type: "BAD" }), Error, "boom");
  assertEquals(state.n, 0);
});

Deno.test("dispatch: re-entrant dispatch returns Promise that resolves after processing", async () => {
  let state = { count: 0 };
  let dispatchRef: ((a: { type: string }) => Promise<unknown>) | null = null;

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

// ── B-4: dropped actions on DISPATCH_MAX overflow reject (not resolve) ──

Deno.test("dispatch: DISPATCH_MAX overflow rejects dropped actions (B-4)", async () => {
  let state = { n: 0 };
  let dispatchRef: ((a: { type: string }) => Promise<unknown>) | null = null;
  const rejections: AioError[] = [];

  const dispatch = createDispatch<
    typeof state,
    { type: string },
    { type: string }
  >({
    reduce: (s) => ({ state: { n: s.n + 1 }, effects: [{ type: "LOOP" }] }),
    execute: () => {
      // Re-entrant dispatch — each effect queues one more, exceeding DISPATCH_MAX.
      dispatchRef!({ type: "LOOP" }).catch((e: AioError) => {
        if (e.code === "DISPATCH_LOOP") rejections.push(e);
      });
    },
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {},
    log: noop,
    debug: false,
    reportOpts: { onError: () => {} },
  });

  dispatchRef = dispatch;
  // The initial action resolves (it was processed before overflow). The
  // re-entrant actions queued past DISPATCH_MAX must reject with DISPATCH_LOOP.
  await dispatch({ type: "LOOP" });
  // Allow microtasks for the queued re-entrant rejections to settle.
  await Promise.resolve().then(() => Promise.resolve());
  assertEquals(
    rejections.length > 0,
    true,
    "actions dropped by DISPATCH_MAX overflow must reject with DISPATCH_LOOP (B-4)",
  );
});

Deno.test("dispatch: an in-flight effect can still commit while draining", async () => {
  // Field report (a local-LLM chat app): a chat streamed from a local inference server when the
  // window closed. Shutdown closes dispatch and THEN drains in-flight
  // effects — so the streaming method's next draft write hit a closed queue,
  // the method died with EFFECT_ASYNC_ERROR mid-reply, and the state it was
  // about to write never reached the final persist. Late CLIENT input is what
  // close() is for; the framework's own drain is not.
  let state = { n: 0 };
  let release!: () => void;
  const gate = new Promise<void>((r) => release = r);
  let dispatchRef!: (a: { type: string; _source?: string }) => Promise<unknown>;
  let commit: Promise<unknown> | null = null;

  const dispatch = createDispatch<
    typeof state,
    { type: string; _source?: string },
    { type: string }
  >({
    reduce: (s, a) => ({
      state: { n: a.type === "COMMIT" ? s.n + 1 : s.n },
      effects: a.type === "START" ? [{ type: "STREAM" }] : [],
    }),
    execute: async () => {
      await gate; // the "stream", still open when shutdown starts
      // What a cell method's write-set looks like on the wire.
      commit = dispatchRef({ type: "COMMIT", _source: "Effect" });
      await commit;
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

  dispatch({ type: "START" });
  dispatch.close();

  // Client input after close() still drops — that is what close() is for.
  await assertRejects(() => dispatch({ type: "TYPED", _source: "UI" }));
  // So does a scheduled tick: shutdown must not start new work, only let
  // work that is already running finish writing.
  await assertRejects(() => dispatch({ type: "POLL" }));

  const drained = dispatch.drain(1000);
  release();
  await drained;

  await commit; // must have resolved, not rejected
  assertEquals(state.n, 1, "the draining effect's commit must land");

  // Sealed after the drain: persist has read the state, nothing may move it.
  await assertRejects(() => dispatch({ type: "LATE" }));
});

Deno.test("dispatch: drain(timeout) seals rather than waiting forever", async () => {
  // An effect that ignores its abort signal must not hold the window open.
  let state = { n: 0 };
  const dispatch = createDispatch<
    typeof state,
    { type: string; _source?: string },
    { type: string }
  >({
    reduce: (_s, a) => ({
      state: { n: 0 },
      effects: a.type === "START" ? [{ type: "HANG" }] : [],
    }),
    execute: () => new Promise<void>(() => {}), // never settles
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {},
    log: noop,
    debug: false,
  });

  dispatch({ type: "START" });
  dispatch.close();
  const t0 = Date.now();
  await dispatch.drain(50);
  assertEquals(Date.now() - t0 < 2000, true, "drain must respect its deadline");
  await assertRejects(() => dispatch({ type: "LATE" }));
  // The SEAL is the load-bearing half: the hung effect above still holds
  // `effectPromises` open, so without the seal a late `_source:"Effect"`
  // commit would be accepted AFTER the deadline broke the drain — after
  // `flushPersist` already read the state it would change. Pin it: even the
  // effect-tagged path must reject once the drain has ended.
  await assertRejects(() => dispatch({ type: "LATE", _source: "Effect" }));
});

// ── afterAction is OBSERVE-ONLY: it may never break dispatch ────────────────
// (restart fuzzer, 2026-08) An unguarded `deps.afterAction(...)` let a throwing
// diagnostics hook unwind the drain loop: the method promise never settled and
// the escaping rejection killed the process. One BigInt in state — which the
// diagnostics differ hands to JSON.stringify — was enough.

/** "settled" if p finishes within ms, "hung" otherwise. Never leaks a timer. */
async function settledWithin(
  p: Promise<unknown>,
  ms: number,
): Promise<"settled" | "hung"> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"hung">((r) => {
    t = setTimeout(() => r("hung"), ms);
  });
  const outcome = await Promise.race([
    p.then(() => "settled" as const, () => "settled" as const),
    timeout,
  ]);
  if (t !== undefined) clearTimeout(t);
  return outcome;
}

function counterDispatch(
  afterAction: (p: { n: number }, n: { n: number }, a: unknown) => void,
  errors: AioError[],
) {
  let state = { n: 0 };
  const dispatch = createDispatch<
    { n: number },
    { type: string },
    { type: string }
  >({
    reduce: (s) => ({ state: { n: s.n + 1 }, effects: [] }),
    execute: () => {},
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {},
    afterAction: afterAction as (
      p: { n: number },
      n: { n: number },
      a: { type: string },
    ) => void,
    reportOpts: { onError: (e) => errors.push(e) },
    log: noop,
    debug: false,
  });
  return { dispatch, get: () => state };
}

Deno.test("dispatch: a throwing afterAction is reported and swallowed — the promise still settles", async () => {
  const errors: AioError[] = [];
  const { dispatch, get } = counterDispatch(() => {
    throw new TypeError("Do not know how to serialize a BigInt");
  }, errors);

  assertEquals(
    await settledWithin(dispatch({ type: "INC" }), 1000),
    "settled",
    "the method promise must settle even though the hook threw",
  );
  assertEquals(get().n, 1, "the action itself was applied");
  // and the loop is not wedged — a later action still processes
  await dispatch({ type: "INC" });
  assertEquals(get().n, 2);

  assertEquals(errors.length, 1, "reported once per action type, not silent");
  assertEquals(errors[0]?.code, "HOOK_ERROR");
  assertEquals(
    errors[0]!.message.includes("BigInt"),
    true,
    "the original cause is carried through",
  );
});

Deno.test("dispatch: a throwing afterAction never blocks the queue behind it", async () => {
  const errors: AioError[] = [];
  const { dispatch, get } = counterDispatch(() => {
    throw new Error("hook down");
  }, errors);
  const all = Promise.all([
    dispatch({ type: "A" }),
    dispatch({ type: "B" }),
    dispatch({ type: "C" }),
  ]);
  assertEquals(await settledWithin(all, 1000), "settled");
  assertEquals(get().n, 3, "every queued action was applied");
  assertEquals(errors.length, 3, "one report per distinct action type");
});

Deno.test("dispatch: an afterAction that REJECTS asynchronously is caught too", async () => {
  const errors: AioError[] = [];
  const { dispatch, get } = counterDispatch(
    (() => Promise.reject(new Error("async hook down"))) as unknown as (
      p: { n: number },
      n: { n: number },
      a: unknown,
    ) => void,
    errors,
  );
  assertEquals(await settledWithin(dispatch({ type: "INC" }), 1000), "settled");
  await new Promise((r) => setTimeout(r, 10)); // let the rejection land
  assertEquals(get().n, 1);
  assertEquals(errors.length, 1, "reported, not an unhandled rejection");
  assertEquals(errors[0]?.code, "HOOK_ERROR");
});

Deno.test("dispatch: BigInt state survives the REAL diagnostics hook (differ included)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "diag-bigint-" });
  try {
    const hooks = initDiagnostics(
      { dev: { stateDiffs: true, crashHandler: false, checkpoint: false } },
      false,
      dir,
    );
    assertEquals(hooks !== null, true);
    const errors: AioError[] = [];
    let state: Record<string, unknown> = { c: { big: 0n } };
    const dispatch = createDispatch<
      Record<string, unknown>,
      { type: string },
      { type: string }
    >({
      reduce: (s) => ({
        state: { ...s, c: { big: (s.c as { big: bigint }).big + 1n } },
        effects: [],
      }),
      execute: () => {},
      getState: () => state,
      setState: (s) => {
        state = s;
      },
      onDone: () => {},
      afterAction: (p, n, a) =>
        hooks!.afterAction(
          p as Record<string, unknown>,
          n as Record<string, unknown>,
          a as { type: string },
        ),
      reportOpts: { onError: (e) => errors.push(e) },
      log: noop,
      debug: false,
    });

    assertEquals(
      await settledWithin(dispatch({ type: "c:bump" }), 1000),
      "settled",
      "a BigInt in state must not hang the method promise",
    );
    assertEquals((state.c as { big: bigint }).big, 1n, "the action applied");
    assertEquals(errors, [], "nothing broke — the differ is BigInt-safe now");
    await hooks!.onStop();

    // …and the diagnostic itself still WORKS: the BigInt is RENDERED, not
    // merely survived. (The hook logs at debug level, so assert on the
    // formatter the hook calls.)
    const [d] = computeDiffs({ c: { big: 0n } }, state);
    assertEquals(
      formatDiff(d!.cell, d!.changes),
      "c: big 0n→1n",
      "BigInt rendered instead of throwing",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
