import { assertEquals } from "jsr:@std/assert";
import {
  createTT,
  type PerfMetric,
  record,
  toBroadcast,
} from "../src/time-travel.ts";

Deno.test("PerfMetric with breakdown flows through record → toBroadcast", () => {
  let tt = createTT<Record<string, unknown>, { type: string }>();
  const perf: PerfMetric = {
    reduce: 42,
    effects: 3,
    budget: { reduce: 100, effect: 5 },
    breakdown: { produce: 30, clone: 8, spread: 1, routing: 2, listeners: 1 },
  };
  tt = record(tt, { type: "test:action" }, { test: {} }, perf);
  assertEquals(tt.entries[0]!.perf?.breakdown?.produce, 30);
  assertEquals(tt.entries[0]!.perf?.breakdown?.clone, 8);

  const broadcast = toBroadcast(tt);
  assertEquals(broadcast.entries[0]!.perf?.breakdown?.produce, 30);
});

import { createDispatch, type PerfTiming } from "../src/dispatch.ts";

Deno.test("PerfTiming accepts optional breakdown field", () => {
  const timing: PerfTiming = {
    actionType: "test:click",
    reduce: 50,
    effects: 2,
    budget: { reduce: 100, effect: 5 },
    breakdown: { produce: 35, clone: 10, spread: 2, routing: 2, listeners: 1 },
  };
  assertEquals(timing.breakdown?.produce, 35);
});

import { composeFeatures } from "../src/feature-compose.ts";
import type { FeatureEntry } from "../src/feature-types.ts";
import type { ReduceBreakdown } from "../src/time-travel.ts";

// Minimal feature for testing
function testFeature(id: string) {
  return {
    __aio: {
      id,
      state: { count: 0 },
      actions: { increment: `${id}:increment` as const },
      effects: {},
      selectors: {},
      actionKeys: ["increment"],
      effectKeys: [] as string[],
      actionTypeToKey: new Map([[`${id}:increment`, "increment"]]),
      foreignActions: [] as string[],
      machine: false as const,
      bound: false,
      reduce: (draft: unknown, _action: { type: string }) => {
        (draft as { count: number }).count++;
      },
      initType: `${id}:Init`,
      destroyType: `${id}:Destroy`,
      crossDispatchPrefixes: new Set<string>(),
      flowTriggers: undefined,
      flows: undefined,
      validate: undefined,
      execute: undefined,
      onInit: undefined,
      onDestroy: undefined,
    },
  };
}

Deno.test("composeFeatures with perfCheck exposes lastBreakdown()", () => {
  const composed = composeFeatures(
    [testFeature("counter")] as unknown as FeatureEntry[],
    { perfCheck: true },
  );

  // Before any reduce — no breakdown
  assertEquals(composed.lastBreakdown?.(), undefined);

  // After reduce — breakdown populated
  const result = composed.reduce(composed.initialState, {
    type: "counter:increment",
    payload: {},
  });
  assertEquals(typeof result.state, "object");

  const bd = composed.lastBreakdown!();
  assertEquals(typeof bd?.produce, "number");
  assertEquals(typeof bd?.clone, "number");
  assertEquals(typeof bd?.spread, "number");
  assertEquals(typeof bd?.routing, "number");
  assertEquals(typeof bd?.listeners, "number");
  assertEquals(bd!.produce >= 0, true);
});

Deno.test("composeFeatures without perfCheck — no lastBreakdown", () => {
  const composed = composeFeatures(
    [testFeature("counter")] as unknown as FeatureEntry[],
  );
  assertEquals(composed.lastBreakdown, undefined);
});

Deno.test("dispatch passes breakdown from reduce to onPerf callback", async () => {
  let state = { counter: { count: 0 } };
  let capturedBreakdown: ReduceBreakdown | undefined;

  const fakeBreakdown: ReduceBreakdown = {
    produce: 10,
    clone: 2,
    spread: 1,
    routing: 3,
    listeners: 1,
  };

  const dispatch = createDispatch({
    reduce: (_s: unknown, _a: unknown) => {
      state = { counter: { count: state.counter.count + 1 } };
      return { state, effects: [] };
    },
    execute: () => {},
    getState: () => state,
    setState: (s: unknown) => {
      state = s as typeof state;
    },
    onDone: () => {},
    log: { debug: () => {}, warn: () => {}, error: () => {} },
    debug: false,
    onPerf: (timing: PerfTiming) => {
      capturedBreakdown = timing.breakdown;
    },
    perfCheck: "on",
    reduceBreakdown: () => fakeBreakdown,
  });

  await dispatch({ type: "counter:increment", payload: {} });
  assertEquals(capturedBreakdown, fakeBreakdown);
});

Deno.test("dispatch omits breakdown when reduceBreakdown not provided", async () => {
  let state = { counter: { count: 0 } };
  let capturedTiming: PerfTiming | undefined;

  const dispatch = createDispatch({
    reduce: (_s: unknown, _a: unknown) => {
      state = { counter: { count: state.counter.count + 1 } };
      return { state, effects: [] };
    },
    execute: () => {},
    getState: () => state,
    setState: (s: unknown) => {
      state = s as typeof state;
    },
    onDone: () => {},
    log: { debug: () => {}, warn: () => {}, error: () => {} },
    debug: false,
    onPerf: (timing: PerfTiming) => {
      capturedTiming = timing;
    },
    perfCheck: "on",
  });

  await dispatch({ type: "counter:increment", payload: {} });
  assertEquals(capturedTiming?.breakdown, undefined);
});
