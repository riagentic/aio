// Regression: prototype pollution via __set* mutations + framework-internal action types
// from network sources (audit F-1).
//
// Two layers of defense:
//   1. server-ws.ts / server-trojan.ts reject any `cell:__name` or `__name` action type
//      from a network-sourced caller — these carry server-trusted payload shapes
//      (e.g. mutation lists) that bypass cell method bodies.
//   2. cell-impl.ts applyMutations rejects mutation paths that include
//      __proto__/constructor/prototype, are non-string/non-array, or exceed depth.
//
// Without these, an authenticated WS client could send
//   {type: "anycell:__setAnyMethod",
//    payload: {mutations: [{path: ["constructor","prototype","X"], value: true}]}}
// to pollute every object on the server.

import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.19";
import { applyMutations } from "../../src/state/cell-impl.ts";
import { _isFrameworkInternalActionType } from "../../src/server/server-ws.ts";

Deno.test("F-1: applyMutations rejects __proto__ in path", () => {
  const state: Record<string, unknown> = { count: 0 };
  assertThrows(
    () =>
      applyMutations(state, [
        { path: ["__proto__", "polluted"], value: true },
      ]),
    Error,
    "blocked unsafe mutation",
  );
  // deno-lint-ignore no-explicit-any
  assertEquals((Object.prototype as any).polluted, undefined);
  // deno-lint-ignore no-explicit-any
  assertEquals(({} as any).polluted, undefined);
});

Deno.test("F-1: applyMutations rejects constructor.prototype in path", () => {
  const state: Record<string, unknown> = { count: 0 };
  assertThrows(
    () =>
      applyMutations(state, [
        { path: ["constructor", "prototype", "pwned"], value: true },
      ]),
    Error,
    "blocked unsafe mutation",
  );
  // deno-lint-ignore no-explicit-any
  assertEquals((Object.prototype as any).pwned, undefined);
  // deno-lint-ignore no-explicit-any
  assertEquals(({} as any).pwned, undefined);
});

Deno.test("F-1: applyMutations rejects bare 'prototype' segment", () => {
  const state: Record<string, unknown> = { items: [{}] };
  assertThrows(
    () =>
      applyMutations(state, [
        { path: ["items", "prototype", "x"], value: 1 },
      ]),
    Error,
    "banned key",
  );
});

Deno.test("F-1: applyMutations rejects non-array path", () => {
  const state: Record<string, unknown> = {};
  assertThrows(
    () =>
      applyMutations(state, [
        // deno-lint-ignore no-explicit-any
        { path: "evil" as any, value: 1 },
      ]),
    Error,
    "blocked unsafe mutation",
  );
});

Deno.test("F-1: applyMutations rejects non-string path segments", () => {
  const state: Record<string, unknown> = {};
  assertThrows(
    () =>
      applyMutations(state, [
        // deno-lint-ignore no-explicit-any
        { path: ["a", 0 as any], value: 1 },
      ]),
    Error,
    "non-string segment",
  );
});

Deno.test("F-1: applyMutations rejects path exceeding depth limit", () => {
  const state: Record<string, unknown> = {};
  const deep = Array.from({ length: 50 }, (_, i) => `k${i}`);
  assertThrows(
    () => applyMutations(state, [{ path: deep, value: 1 }]),
    Error,
    "exceeds depth",
  );
});

Deno.test("F-1: applyMutations rejects unknown array op", () => {
  const state: Record<string, unknown> = { items: [1, 2, 3] };
  assertThrows(
    () =>
      applyMutations(state, [
        { path: ["items"], op: "constructor", args: [] },
      ]),
    Error,
    "unsupported array op",
  );
  // Confirm whitelisted ops still work
  applyMutations(state, [{ path: ["items"], op: "push", args: [4] }]);
  assertEquals(state.items, [1, 2, 3, 4]);
});

Deno.test("F-1: applyMutations rejects non-array mutations payload", () => {
  const state: Record<string, unknown> = {};
  assertThrows(
    () =>
      // deno-lint-ignore no-explicit-any
      applyMutations(state, "evil" as any),
    Error,
    "not an array",
  );
});

Deno.test("F-1: applyMutations rejects non-object mutation entry", () => {
  const state: Record<string, unknown> = {};
  assertThrows(
    () =>
      // deno-lint-ignore no-explicit-any
      applyMutations(state, ["evil" as any]),
    Error,
    "not an object",
  );
});

Deno.test("F-1: legitimate mutations still apply", () => {
  const state: Record<string, unknown> = { count: 0, items: [] as unknown[] };
  applyMutations(state, [
    { path: ["count"], value: 5 },
    { path: ["items"], op: "push", args: ["a"] },
    { path: ["items"], op: "push", args: ["b"] },
  ]);
  assertEquals(state.count, 5);
  assertEquals(state.items, ["a", "b"]);
});

Deno.test(
  "F-1: _isFrameworkInternalActionType identifies cell:__name and __name patterns",
  () => {
    // Framework-internal — must be rejected from network sources
    assertEquals(
      _isFrameworkInternalActionType("counter:__setIncrement"),
      true,
    );
    assertEquals(_isFrameworkInternalActionType("counter:__exec"), true);
    assertEquals(_isFrameworkInternalActionType("counter:__error"), true);
    assertEquals(_isFrameworkInternalActionType("counter:__flow"), true);
    assertEquals(_isFrameworkInternalActionType("counter:__FlowState"), true);
    assertEquals(_isFrameworkInternalActionType("counter:__Init"), true);
    assertEquals(_isFrameworkInternalActionType("counter:__Destroy"), true);
    assertEquals(_isFrameworkInternalActionType("__init"), true);
    // User-defined — must pass
    assertEquals(_isFrameworkInternalActionType("counter:increment"), false);
    assertEquals(_isFrameworkInternalActionType("auth:login"), false);
    assertEquals(_isFrameworkInternalActionType("cart:addItem"), false);
    // Single underscore — not the framework reservation pattern, must pass
    assertEquals(_isFrameworkInternalActionType("counter:_internal"), false);
    assertEquals(_isFrameworkInternalActionType("a:b"), false);
    assertEquals(_isFrameworkInternalActionType("plain"), false);
  },
);
