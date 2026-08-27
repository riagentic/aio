// `cloneState`'s fallback rung used to be `JSON.parse(JSON.stringify(...))`,
// which does not clone — it TRANSLATES. A `Date` came back a string,
// `undefined`/function-valued keys vanished, `Map`/`Set` became `{}`,
// `NaN`/`Infinity` became `null`. And it ran precisely when `structuredClone`
// had failed, i.e. on the states that already contain something unusual.
//
// `freezeInitial` feeds that result to every reset/seed/fallback in the app,
// so an app's DECLARED initial state was quietly not the state it declared.
import { assert, assertEquals } from "@std/assert";
import { cloneState } from "../src/state/immutable.ts";

Deno.test("cloneState: a value structuredClone refuses is still cloned faithfully", () => {
  const when = new Date("2020-01-02T03:04:05.000Z");
  const state = {
    when,
    tags: new Set(["a", "b"]),
    index: new Map<string, number>([["a", 1]]),
    bytes: new Uint8Array([1, 2, 3]),
    nums: [Number.NaN, Infinity, -0],
    nested: { deep: { n: 1 } },
    missing: undefined,
    // THE reason structuredClone fails — one function anywhere in the tree.
    onDone: () => {},
  };
  const c = cloneState(state);

  assert(c.when instanceof Date, "Date became a string");
  assertEquals(c.when.getTime(), when.getTime());
  assert(c.when !== when, "Date was not cloned");
  assert(c.tags instanceof Set, "Set became a plain object");
  assertEquals([...c.tags], ["a", "b"]);
  assert(c.index instanceof Map, "Map became a plain object");
  assertEquals(c.index.get("a"), 1);
  assert(c.bytes instanceof Uint8Array, "typed array became a plain object");
  assertEquals([...c.bytes], [1, 2, 3]);
  assert(Number.isNaN(c.nums[0]), "NaN became null");
  assertEquals(c.nums[1], Infinity, "Infinity became null");
  assertEquals("missing" in c, true, "an explicit undefined key was dropped");
  assertEquals(typeof c.onDone, "function", "the function key was dropped");
  // …and it is a CLONE, not the same tree.
  assert(c.nested !== state.nested);
  assert(c.nested.deep !== state.nested.deep);
  c.nested.deep.n = 99;
  assertEquals(state.nested.deep.n, 1, "the clone aliased the original");
});

Deno.test("cloneState: a cycle in an uncloneable tree does not hang", () => {
  const a: Record<string, unknown> = { fn: () => {} };
  a.self = a;
  const c = cloneState(a) as Record<string, unknown>;
  assertEquals(c.self, c);
});

Deno.test("cloneState: a class instance is shared, never turned into a lookalike", () => {
  class Handle {
    constructor(public id: string) {}
    describe(): string {
      return `handle:${this.id}`;
    }
  }
  const state = { h: new Handle("x"), fn: () => {} };
  const c = cloneState(state);
  // Copying its own keys onto a bare object produces something that has lost
  // every method — worse than not copying. Shared by reference, and said so.
  assertEquals(c.h.describe(), "handle:x");
});
