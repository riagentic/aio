import { assertEquals } from "@std/assert";
import { createDispatch, type DispatchDeps } from "../src/dispatch.ts";
import type { AioError } from "../src/error.ts";

// ── Performance Budget Tests ─────────────────────────────────────────

type TestState = { count: number };
type TestAction = { type: "Inc"; payload?: { by?: number } };
type TestEffect = { type: "Log"; payload: { msg: string } };

const noop = { debug: () => {}, warn: () => {}, error: () => {} };

function createTestDeps(
  overrides: Partial<DispatchDeps<TestState, TestAction, TestEffect>> = {},
): DispatchDeps<TestState, TestAction, TestEffect> {
  return {
    reduce: (state, action) => {
      if (action.type === "Inc") {
        return {
          state: { count: state.count + (action.payload?.by ?? 1) },
          effects: [],
        };
      }
      return { state, effects: [] };
    },
    execute: () => {},
    getState: () => ({ count: 0 }),
    setState: () => {},
    onDone: () => {},
    log: noop,
    debug: false,
    ...overrides,
  };
}

// ── perfCheck: on (default) ──────────────────────────────────────────

Deno.test("perf: perfCheck on - slow reduce reports BUDGET_REDUCE", async () => {
  const errors: AioError[] = [];
  let reduceCount = 0;

  const deps = createTestDeps({
    reduce: () => {
      reduceCount++;
      // Simulate slow reduce (>100ms)
      const start = performance.now();
      while (performance.now() - start < 150) {}
      return { state: { count: reduceCount }, effects: [] };
    },
    reportOpts: { onError: (err) => errors.push(err) },
    perfCheck: "on",
  });

  const dispatch = createDispatch(deps);
  dispatch({ type: "Inc" });

  assertEquals(errors.length, 1);
  assertEquals(errors[0]!.code, "BUDGET_REDUCE");
  assertEquals(errors[0]!.message.includes("exceeded budget"), true);
});

Deno.test("perf: perfCheck on - slow effect reports BUDGET_EFFECT", () => {
  const errors: AioError[] = [];

  const deps = createTestDeps({
    reduce: () => ({
      state: { count: 1 },
      effects: [{ type: "Log", payload: { msg: "test" } }],
    }),
    execute: () => {
      // Simulate slow sync effect (>5ms)
      const start = performance.now();
      while (performance.now() - start < 20) {}
    },
    reportOpts: { onError: (err) => errors.push(err) },
    perfCheck: "on",
  });

  const dispatch = createDispatch(deps);
  dispatch({ type: "Inc" });

  assertEquals(errors.length, 1);
  assertEquals(errors[0]!.code, "BUDGET_EFFECT");
  assertEquals(errors[0]!.message.includes("exceeded budget"), true);
});

Deno.test("perf: perfCheck on - fast reduce does not report", () => {
  const errors: AioError[] = [];

  const deps = createTestDeps({
    reportOpts: { onError: (err) => errors.push(err) },
    perfCheck: "on",
  });

  const dispatch = createDispatch(deps);
  dispatch({ type: "Inc" });
  dispatch({ type: "Inc" });
  dispatch({ type: "Inc" });

  assertEquals(errors.length, 0);
});

Deno.test("perf: perfCheck on - async effect not measured for duration", () => {
  const errors: AioError[] = [];

  const deps = createTestDeps({
    reduce: () => ({
      state: { count: 1 },
      effects: [{ type: "Log", payload: { msg: "test" } }],
    }),
    execute: () => {
      // Async effect returns immediately
      return Promise.resolve();
    },
    reportOpts: { onError: (err) => errors.push(err) },
    perfCheck: "on",
  });

  const dispatch = createDispatch(deps);
  dispatch({ type: "Inc" });

  assertEquals(errors.length, 0);
});

// ── perfCheck: off ────────────────────────────────────────────────────

Deno.test("perf: perfCheck off - slow reduce is silent", () => {
  const errors: AioError[] = [];

  const deps = createTestDeps({
    reduce: () => {
      const start = performance.now();
      while (performance.now() - start < 150) {}
      return { state: { count: 1 }, effects: [] };
    },
    reportOpts: { onError: (err) => errors.push(err) },
    perfCheck: "off",
  });

  const dispatch = createDispatch(deps);
  dispatch({ type: "Inc" });

  assertEquals(errors.length, 0);
});

Deno.test("perf: perfCheck off - slow effect is silent", () => {
  const errors: AioError[] = [];

  const deps = createTestDeps({
    reduce: () => ({
      state: { count: 1 },
      effects: [{ type: "Log", payload: { msg: "test" } }],
    }),
    execute: () => {
      const start = performance.now();
      while (performance.now() - start < 20) {}
    },
    reportOpts: { onError: (err) => errors.push(err) },
    perfCheck: "off",
  });

  const dispatch = createDispatch(deps);
  dispatch({ type: "Inc" });

  assertEquals(errors.length, 0);
});

// ── Custom budgets ───────────────────────────────────────────────────

Deno.test("perf: custom reduce budget", () => {
  const errors: AioError[] = [];

  const deps = createTestDeps({
    reduce: () => {
      const start = performance.now();
      while (performance.now() - start < 30) {}
      return { state: { count: 1 }, effects: [] };
    },
    reportOpts: { onError: (err) => errors.push(err) },
    perfCheck: "on",
    perfBudget: { reduce: 10 }, // Very tight budget
  });

  const dispatch = createDispatch(deps);
  dispatch({ type: "Inc" });

  assertEquals(errors.length, 1);
  assertEquals(errors[0]!.code, "BUDGET_REDUCE");
  assertEquals(errors[0]!.context.budget, 10);
});

Deno.test("perf: custom effect budget", () => {
  const errors: AioError[] = [];

  const deps = createTestDeps({
    reduce: () => ({
      state: { count: 1 },
      effects: [{ type: "Log", payload: { msg: "test" } }],
    }),
    execute: () => {
      const start = performance.now();
      while (performance.now() - start < 15) {}
    },
    reportOpts: { onError: (err) => errors.push(err) },
    perfCheck: "on",
    perfBudget: { effect: 10 },
  });

  const dispatch = createDispatch(deps);
  dispatch({ type: "Inc" });

  assertEquals(errors.length, 1);
  assertEquals(errors[0]!.code, "BUDGET_EFFECT");
  assertEquals(errors[0]!.context.budget, 10);
});

Deno.test("perf: relaxed budget allows more time", () => {
  const errors: AioError[] = [];

  const deps = createTestDeps({
    reduce: () => {
      const start = performance.now();
      while (performance.now() - start < 150) {}
      return { state: { count: 1 }, effects: [] };
    },
    reportOpts: { onError: (err) => errors.push(err) },
    perfCheck: "on",
    perfBudget: { reduce: 200 }, // Relaxed budget
  });

  const dispatch = createDispatch(deps);
  dispatch({ type: "Inc" });

  assertEquals(errors.length, 0);
});

// ── Both reduce and effect slow ───────────────────────────────────────

Deno.test("perf: reports both reduce and effect violations", () => {
  const errors: AioError[] = [];

  const deps = createTestDeps({
    reduce: () => {
      const start = performance.now();
      while (performance.now() - start < 150) {}
      return {
        state: { count: 1 },
        effects: [{ type: "Log", payload: { msg: "test" } }],
      };
    },
    execute: () => {
      const start = performance.now();
      while (performance.now() - start < 20) {}
    },
    reportOpts: { onError: (err) => errors.push(err) },
    perfCheck: "on",
  });

  const dispatch = createDispatch(deps);
  dispatch({ type: "Inc" });

  assertEquals(errors.length, 2);
  assertEquals(errors[0]!.code, "BUDGET_REDUCE");
  assertEquals(errors[1]!.code, "BUDGET_EFFECT");
});

// ── Default budgets when not specified ────────────────────────────────

Deno.test("perf: default budgets are 100ms reduce, 5ms effect", () => {
  const errors: AioError[] = [];

  const deps = createTestDeps({
    reduce: () => {
      const start = performance.now();
      while (performance.now() - start < 150) {}
      return {
        state: { count: 1 },
        effects: [{ type: "Log", payload: { msg: "test" } }],
      };
    },
    execute: () => {
      const start = performance.now();
      while (performance.now() - start < 20) {}
    },
    reportOpts: { onError: (err) => errors.push(err) },
    perfCheck: "on",
    // No perfBudget specified
  });

  const dispatch = createDispatch(deps);
  dispatch({ type: "Inc" });

  assertEquals(errors.length, 2);
  assertEquals(errors[0]!.code, "BUDGET_REDUCE");
  assertEquals(errors[0]!.context.budget, 100); // reduce default
  assertEquals(errors[1]!.code, "BUDGET_EFFECT");
  assertEquals(errors[1]!.context.budget, 5); // effect default
});

// ── effectTimeout ────────────────────────────────────────────────────

Deno.test("perf: effectTimeout reports EFFECT_TIMEOUT when async effect exceeds limit", async () => {
  const errors: AioError[] = [];

  const deps = createTestDeps({
    reduce: () => ({
      state: { count: 1 },
      effects: [{ type: "Log", payload: { msg: "slow" } }],
    }),
    execute: () => new Promise<void>((r) => setTimeout(r, 80)), // takes 80ms
    effectTimeout: 30, // 30ms limit — should fire
    reportOpts: { onError: (err) => errors.push(err) },
  });

  const dispatch = createDispatch(deps);
  dispatch({ type: "Inc" });

  // Wait for the timeout to fire
  await new Promise((r) => setTimeout(r, 120));

  assertEquals(errors.some((e) => e.code === "EFFECT_TIMEOUT"), true);
  const timeoutErr = errors.find((e) => e.code === "EFFECT_TIMEOUT")!;
  assertEquals(timeoutErr.source, "effect");
  assertEquals(timeoutErr.context.effectType, "Log");
  assertEquals(timeoutErr.message.includes("timeout"), true);
});

Deno.test("perf: effectTimeout=0 disables timeout", async () => {
  const errors: AioError[] = [];

  const deps = createTestDeps({
    reduce: () => ({
      state: { count: 1 },
      effects: [{ type: "Log", payload: { msg: "ok" } }],
    }),
    execute: () => new Promise<void>((r) => setTimeout(r, 50)),
    effectTimeout: 0, // disabled
    reportOpts: { onError: (err) => errors.push(err) },
  });

  const dispatch = createDispatch(deps);
  dispatch({ type: "Inc" });

  await new Promise((r) => setTimeout(r, 80));

  assertEquals(errors.length, 0);
});

Deno.test("perf: effectTimeout does not fire when effect completes in time", async () => {
  const errors: AioError[] = [];

  const deps = createTestDeps({
    reduce: () => ({
      state: { count: 1 },
      effects: [{ type: "Log", payload: { msg: "fast" } }],
    }),
    execute: () => new Promise<void>((r) => setTimeout(r, 10)),
    effectTimeout: 200, // generous limit
    reportOpts: { onError: (err) => errors.push(err) },
  });

  const dispatch = createDispatch(deps);
  dispatch({ type: "Inc" });

  await new Promise((r) => setTimeout(r, 250));

  assertEquals(errors.length, 0);
});

// ── perfLog callback wiring ──────────────────────────────────────────

Deno.test("perf: perfLog callback fires on budget violation", () => {
  const logged: {
    source: string;
    type: string;
    duration: number;
    budget: number;
  }[] = [];

  const deps = createTestDeps({
    reduce: () => {
      const start = performance.now();
      while (performance.now() - start < 150) {}
      return { state: { count: 1 }, effects: [] };
    },
    perfCheck: "on",
    perfBudget: { reduce: 100 },
    perfLog: (source, type, duration, budget) => {
      logged.push({ source, type, duration, budget });
    },
  });

  const dispatch = createDispatch(deps);
  dispatch({ type: "Inc" });

  assertEquals(logged.length, 1);
  assertEquals(logged[0]!.source, "reduce");
  assertEquals(logged[0]!.type, "Inc");
  assertEquals(logged[0]!.budget, 100);
  assertEquals(logged[0]!.duration > 100, true);
});

Deno.test("perf: perfLog fires even when action type is missing", () => {
  const logged: { source: string; type: string }[] = [];

  const deps = createTestDeps({
    reduce: () => {
      const start = performance.now();
      while (performance.now() - start < 150) {}
      return { state: { count: 1 }, effects: [] };
    },
    perfCheck: "on",
    perfBudget: { reduce: 100 },
    perfLog: (source, type) => {
      logged.push({ source, type });
    },
  });

  const dispatch = createDispatch(deps);
  // deno-lint-ignore no-explicit-any
  dispatch({ payload: {} } as any); // no type field

  assertEquals(logged.length, 1);
  assertEquals(logged[0]!.type, "unknown");
});
