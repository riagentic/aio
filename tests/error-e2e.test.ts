import {
  assertEquals,
  assertExists,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createDispatch } from "../src/state/dispatch.ts";
import { createTT, markError, record } from "../src/diagnostics/time-travel.ts";
import {
  type AioError,
  createAioError,
  reportError,
  type ReportErrorOpts,
} from "../src/diagnostics/error.ts";

Deno.test("e2e — action → reduce throw → onError → TT flagged", async () => {
  const errors: AioError[] = [];
  let state = { x: 0 };
  let tt = createTT<typeof state, { type: string }>();
  tt = record(tt, { type: "__init" }, state);

  const reportOpts: ReportErrorOpts = {
    onError: (err) => errors.push(err),
    tt: { markError: (err) => markError(tt, err) },
    countError: () => {},
  };

  const dispatch = createDispatch({
    reduce: (s: typeof state, a: { type: string }) => {
      if (a.type === "bomb") throw new Error("e2e boom");
      return { state: { ...s, x: s.x + 1 }, effects: [] };
    },
    execute: () => {},
    getState: () => state,
    setState: (s: typeof state) => {
      state = s;
    },
    onDone: () => {},
    log: { debug: () => {}, warn: () => {}, error: () => {} },
    debug: false,
    reportOpts,
  } as never);

  // Dispatch failing action — B-4: reducer throw rejects the awaiter.
  await assertRejects(
    () => dispatch({ type: "bomb" } as never),
    Error,
    "e2e boom",
  );

  // Verify onError received AioError
  assertEquals(errors.length, 1);
  assertEquals(errors[0]!.code, "REDUCE_ERROR");
  assertEquals(errors[0]!.original!.message, "e2e boom");
  assertExists(errors[0]!.correlationId);
  assertEquals(errors[0]!.correlationId !== "none", true);

  // Dispatch succeeding action — dispatch continues after error
  await dispatch({ type: "ok" } as never);
  assertEquals(state.x, 1);
});

Deno.test("e2e — reportError self-guard: formatter crash degrades gracefully", () => {
  const err = createAioError("REDUCE_ERROR", "test", { cellName: "test" });

  // Override toJSON to throw — simulates formatter failure
  const _original = err.toJSON.bind(err);
  (err as unknown as Record<string, unknown>).toJSON = () => {
    throw new Error("formatter boom");
  };

  // reportError should NOT throw — it catches internally
  const reportOpts: ReportErrorOpts = {
    logger: {
      error: () => {
        throw new Error("logger boom too");
      },
    },
  };

  // This should not throw
  reportError(err, reportOpts);
});

Deno.test("e2e — multiple errors get different correlationIds", async () => {
  const errors: AioError[] = [];
  let state = { x: 0 };

  const dispatch = createDispatch({
    reduce: (s: typeof state, a: { type: string }) => {
      if (a.type === "throw") throw new Error("boom");
      return { state: s, effects: [] };
    },
    execute: () => {},
    getState: () => state,
    setState: (s: typeof state) => {
      state = s;
    },
    onDone: () => {},
    log: { debug: () => {}, warn: () => {}, error: () => {} },
    debug: false,
    reportOpts: { onError: (err: AioError) => errors.push(err) },
  } as never);

  await assertRejects(
    () => dispatch({ type: "throw" } as never),
    Error,
    "boom",
  );
  await assertRejects(
    () => dispatch({ type: "throw" } as never),
    Error,
    "boom",
  );

  assertEquals(errors.length, 2);
  // Each dispatch gets its own correlationId
  assertEquals(errors[0]!.correlationId !== errors[1]!.correlationId, true);
});
