// A memoized selector cached its INPUTS before the combiner ran. A combiner
// that threw therefore left the new inputs remembered beside the OLD result,
// and the next call with those inputs returned the answer computed for
// different ones — silently wrong derived state — instead of throwing again.
import { assertEquals, assertThrows } from "@std/assert";
import { createSelector } from "../src/selector.ts";

type S = { items: number[] };

Deno.test("selector: a throwing combiner is not memoized as the previous result", () => {
  const sel = createSelector(
    (s: S) => s.items,
    (items) => {
      if (items.length === 0) throw new Error("empty");
      return items.reduce((a, b) => a + b, 0);
    },
  );
  assertEquals(sel({ items: [1, 2] }), 3);
  const empty: number[] = [];
  assertThrows(() => sel({ items: empty }), Error, "empty");
  // Same inputs again: must throw again, never hand back 3.
  assertThrows(() => sel({ items: empty }), Error, "empty");
});

Deno.test("selector: a first-call throw does not memoize `undefined`", () => {
  const bad: number[] = [];
  const sel = createSelector(
    (s: S) => s.items,
    (items) => {
      if (items.length === 0) throw new Error("empty");
      return items.length;
    },
  );
  assertThrows(() => sel({ items: bad }), Error, "empty");
  assertThrows(() => sel({ items: bad }), Error, "empty");
});
