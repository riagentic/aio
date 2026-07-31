import {
  assertEquals,
  assertInstanceOf,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type AioError,
  clearCorrelationId,
  createAioError,
  reportError,
  setCorrelationId,
} from "../src/diagnostics/error.ts";

Deno.test("createAioError — preserves original Error stack", () => {
  const original = new Error("kaboom");
  const err = createAioError("REDUCE_ERROR", original, {
    cellName: "orderer",
    actionType: "orderer:buy",
  });
  assertInstanceOf(err, Error);
  assertEquals(err.code, "REDUCE_ERROR");
  assertEquals(err.source, "reduce");
  assertEquals(err.context.cellName, "orderer");
  assertEquals(err.context.actionType, "orderer:buy");
  assertEquals(err.original, original);
  assertStringIncludes(err.original!.stack!, "error.test.ts");
});

Deno.test("createAioError — extracts stack from non-Error (string)", () => {
  const err = createAioError("EFFECT_ERROR", "network down", {
    cellName: "api",
  });
  assertEquals(err.message, "network down");
  assertEquals(err.original, undefined);
});

Deno.test("createAioError — correlationId from context", () => {
  setCorrelationId("test-123");
  const err = createAioError("REDUCE_ERROR", new Error("x"), {});
  assertEquals(err.correlationId, "test-123");
  clearCorrelationId();
});

Deno.test('createAioError — correlationId is "none" when no context', () => {
  clearCorrelationId();
  const err = createAioError("REDUCE_ERROR", new Error("x"), {});
  assertEquals(err.correlationId, "none");
});

Deno.test("AioError.toJSON — produces structured object", () => {
  const err = createAioError("EFFECT_ASYNC_ERROR", new Error("fail"), {
    cellName: "orderer",
    effectType: "orderer:exec",
  });
  const json = err.toJSON() as Record<string, unknown>;
  assertEquals(json.code, "EFFECT_ASYNC_ERROR");
  assertEquals(json.source, "effect");
  const ctx = json.context as Record<string, unknown>;
  assertEquals(ctx.effectType, "orderer:exec");
  assertEquals(typeof json.timestamp, "number");
  assertEquals(typeof json.stack, "string");
});

Deno.test("error code to source mapping", () => {
  assertEquals(createAioError("REDUCE_ERROR", "x", {}).source, "reduce");
  assertEquals(createAioError("EFFECT_ERROR", "x", {}).source, "effect");
  assertEquals(createAioError("EFFECT_TIMEOUT", "x", {}).source, "effect");
  assertEquals(createAioError("EFFECT_ASYNC_ERROR", "x", {}).source, "effect");
  assertEquals(createAioError("HOOK_ERROR", "x", {}).source, "hook");
  assertEquals(createAioError("INIT_ERROR", "x", {}).source, "init");
  assertEquals(createAioError("DESTROY_ERROR", "x", {}).source, "destroy");
  assertEquals(createAioError("MACHINE_BLOCKED", "x", {}).source, "machine");
  assertEquals(createAioError("QUEUE_OVERFLOW", "x", {}).source, "dispatch");
  assertEquals(createAioError("DISPATCH_LOOP", "x", {}).source, "dispatch");
  assertEquals(createAioError("MEMORY_PRESSURE", "x", {}).source, "memory");
  assertEquals(createAioError("MEMORY_CRITICAL", "x", {}).source, "memory");
  assertEquals(createAioError("BUDGET_REDUCE", "x", {}).source, "reduce");
  assertEquals(createAioError("BUDGET_EFFECT", "x", {}).source, "effect");
});
