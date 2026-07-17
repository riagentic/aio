import {
  assertEquals,
  assertExists,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createDispatch } from "../src/state/dispatch.ts";
import type { AioError } from "../src/diagnostics/error.ts";

type Action = { type: string; payload?: unknown; _source?: string };
type Effect = { type: string; payload?: unknown };
type State = { count: number };

function makeDeps(overrides: Partial<{
  reduce: (s: State, a: Action) => { state: State; effects: Effect[] };
  execute: (e: Effect) => void | Promise<void>;
  onDone: () => void;
}> = {}) {
  let state: State = { count: 0 };
  const errors: AioError[] = [];
  return {
    deps: {
      reduce: overrides.reduce ?? ((s: State, a: Action) => {
        if (a.type === "throw") throw new Error("reduce boom");
        return { state: { ...s, count: s.count + 1 }, effects: [] as Effect[] };
      }),
      execute: overrides.execute ?? (() => {}),
      getState: () => state,
      setState: (s: State) => {
        state = s;
      },
      onDone: overrides.onDone ?? (() => {}),
      log: { debug: () => {}, warn: () => {}, error: () => {} },
      debug: false,
      reportOpts: { onError: (err: AioError) => errors.push(err) },
    },
    errors,
    getState: () => state,
  };
}

Deno.test("dispatch — reduce throw produces AioError with REDUCE_ERROR", async () => {
  const { deps, errors } = makeDeps();
  const dispatch = createDispatch(deps as never);
  // B-4: reducer throw rejects the awaiter — state did not apply.
  await assertRejects(
    () => dispatch({ type: "throw" } as never),
    Error,
    "reduce boom",
  );
  assertEquals(errors.length, 1);
  assertEquals(errors[0]!.code, "REDUCE_ERROR");
  assertEquals(errors[0]!.context.actionType, "throw");
  assertExists(errors[0]!.original);
  assertEquals(errors[0]!.original!.message, "reduce boom");
});

Deno.test("dispatch — sync effect throw produces EFFECT_ERROR", async () => {
  const { deps, errors } = makeDeps({
    reduce: (_s, _a) => ({ state: { count: 1 }, effects: [{ type: "boom" }] }),
    execute: () => {
      throw new Error("effect boom");
    },
  });
  const dispatch = createDispatch(deps as never);
  await dispatch({ type: "go" } as never);
  assertEquals(errors.length, 1);
  assertEquals(errors[0]!.code, "EFFECT_ERROR");
  assertEquals(errors[0]!.context.effectType, "boom");
});

Deno.test("dispatch — async effect rejection produces EFFECT_ASYNC_ERROR", async () => {
  const { deps, errors } = makeDeps({
    reduce: (_s, _a) => ({
      state: { count: 1 },
      effects: [{ type: "async-fail" }],
    }),
    execute: () => Promise.reject(new Error("async boom")),
  });
  const dispatch = createDispatch(deps as never);
  await dispatch({ type: "go" } as never);
  await new Promise((r) => setTimeout(r, 50));
  assertEquals(errors.length, 1);
  assertEquals(errors[0]!.code, "EFFECT_ASYNC_ERROR");
});

Deno.test("dispatch — continues processing after error", async () => {
  const { deps, errors, getState } = makeDeps();
  const dispatch = createDispatch(deps as never);
  await assertRejects(
    () => dispatch({ type: "throw" } as never),
    Error,
    "reduce boom",
  );
  await dispatch({ type: "ok" } as never);
  assertEquals(errors.length, 1);
  assertEquals(getState().count, 1);
});

Deno.test("dispatch — errorCount still works", async () => {
  const { deps } = makeDeps();
  const dispatch = createDispatch(deps as never);
  assertEquals(dispatch.errorCount(), 0);
  await assertRejects(
    () => dispatch({ type: "throw" } as never),
    Error,
    "reduce boom",
  );
  assertEquals(dispatch.errorCount(), 1);
});

Deno.test("dispatch — correlationId is set on errors", async () => {
  const { deps, errors } = makeDeps();
  const dispatch = createDispatch(deps as never);
  await assertRejects(
    () => dispatch({ type: "throw" } as never),
    Error,
    "reduce boom",
  );
  assertEquals(typeof errors[0]!.correlationId, "string");
  assertEquals(errors[0]!.correlationId !== "none", true);
});
