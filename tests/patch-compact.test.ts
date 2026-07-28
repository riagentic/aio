import { assertEquals } from "@std/assert";
import type { Patch } from "immer";
import { applyPatches, enablePatches } from "immer";
import {
  compactPatches,
  narrowArrayAppends,
} from "../src/state/patch-compact.ts";

// Helper to build a patch
enablePatches();

const replace = (path: (string | number)[], value: unknown): Patch => ({
  op: "replace",
  path,
  value,
});
const add = (path: (string | number)[], value: unknown): Patch => ({
  op: "add",
  path,
  value,
});
const remove = (path: (string | number)[]): Patch => ({
  op: "remove",
  path,
});

Deno.test("compactPatches: empty array", () => {
  assertEquals(compactPatches([]), []);
});

Deno.test("compactPatches: single op passes through", () => {
  const ops = [replace(["a"], 1)];
  assertEquals(compactPatches(ops), ops);
});

Deno.test("compactPatches: same-path replace collapses to last-write-wins", () => {
  const ops = [
    replace(["counter", "count"], 1),
    replace(["counter", "count"], 2),
    replace(["counter", "count"], 3),
  ];
  assertEquals(compactPatches(ops), [replace(["counter", "count"], 3)]);
});

Deno.test("compactPatches: different paths preserved in order", () => {
  const ops = [
    replace(["a"], 1),
    replace(["b"], 2),
    replace(["c"], 3),
  ];
  assertEquals(compactPatches(ops), ops);
});

Deno.test("compactPatches: mixed paths — duplicates collapsed, unique kept", () => {
  const ops = [
    replace(["a"], 1),
    replace(["b"], 10),
    replace(["a"], 2),
    replace(["c"], 30),
    replace(["b"], 20),
    replace(["a"], 3),
  ];
  assertEquals(compactPatches(ops), [
    replace(["c"], 30),
    replace(["b"], 20),
    replace(["a"], 3),
  ]);
});

Deno.test("compactPatches: add ops never collapsed", () => {
  const ops = [
    add(["items", 0], "a"),
    add(["items", 1], "b"),
    add(["items", 0], "c"),
  ];
  assertEquals(compactPatches(ops), ops);
});

Deno.test("compactPatches: remove ops never collapsed", () => {
  const ops = [
    remove(["items", 0]),
    remove(["items", 0]),
  ];
  assertEquals(compactPatches(ops), ops);
});

Deno.test("compactPatches: mixed op types — replace collapsed, add/remove preserved", () => {
  const ops = [
    replace(["price"], 100),
    add(["log", 0], "entry1"),
    replace(["price"], 200),
    add(["log", 1], "entry2"),
    replace(["price"], 300),
  ];
  assertEquals(compactPatches(ops), [
    add(["log", 0], "entry1"),
    add(["log", 1], "entry2"),
    replace(["price"], 300),
  ]);
});

Deno.test("compactPatches: deep nested paths disambiguated", () => {
  // ["a", "b"] vs ["a", "c"] are different paths
  const ops = [
    replace(["a", "b"], 1),
    replace(["a", "c"], 2),
    replace(["a", "b"], 3),
  ];
  const result = compactPatches(ops);
  assertEquals(result, [
    replace(["a", "c"], 2),
    replace(["a", "b"], 3),
  ]);
});

Deno.test("compactPatches: large object values collapsed correctly", () => {
  const big1 = { items: Array.from({ length: 100 }, (_, i) => i) };
  const big2 = { items: Array.from({ length: 100 }, (_, i) => i + 100) };
  const ops = [
    replace(["data"], big1),
    replace(["data"], big2),
  ];
  const result = compactPatches(ops);
  assertEquals(result.length, 1);
  assertEquals(result[0]!.value, big2);
});

// ── narrowArrayAppends ──────────────────────────────────────────────────────
// `s.items = [...s.items, ...batch]` is as idiomatic as `push`, but Immer can
// only describe it as "replace the whole array" — so a growing list re-shipped
// itself on every commit. These pin the rewrite AND, more importantly, that it
// declines every case where the prefix is not provably intact: getting this
// wrong loses state rather than bytes.

Deno.test("narrowArrayAppends: a grown array travels as its appends", () => {
  const a = { x: 1 }, b = { x: 2 }, c = { x: 3 };
  const prev = { items: [a, b], n: 2 };
  const ops = narrowArrayAppends(prev, [
    replace(["items"], [a, b, c]),
    replace(["n"], 3),
  ]);
  assertEquals(ops, [
    { op: "add", path: ["items", 2], value: c },
    replace(["n"], 3),
  ]);
});

Deno.test("narrowArrayAppends: applying the rewrite equals applying the original", () => {
  // The only property that really matters. Immer's own applyPatches is the
  // judge, on the shapes an app actually produces.
  const cases: Array<[unknown[], unknown[]]> = [
    [[1, 2, 3, 4], [1, 2, 3, 4, 5]],
    [[1, 2, 3, 4], [1, 2, 3, 4, 5, 6]],
    [["a"], ["a", "b"]], // grows, but tail >= prefix → left as replace
    [[], [1]], // empty prefix → left as replace
    [[1, 2, 3], [1, 2]], // shrank
    [[1, 2, 3], [3, 2, 1]], // reordered
    [[1, 2, 3], [1, 9, 3, 4]], // edited in place while growing
  ];
  for (const [before, after] of cases) {
    const prev = { items: before };
    const original = [replace(["items"], after)];
    const narrowed = narrowArrayAppends(prev, original);
    assertEquals(
      applyPatches(prev, narrowed),
      applyPatches(prev, original),
      `${JSON.stringify(before)} → ${JSON.stringify(after)}`,
    );
  }
});

Deno.test("narrowArrayAppends: identity, not equality, decides", () => {
  // Objects that merely LOOK like the old ones are a fresh array, and a fresh
  // array may have been rebuilt from anything. Only `===` proves the prefix
  // survived, and that is exactly what spreading preserves.
  const prev = { items: [{ x: 1 }] };
  const ops = [replace(["items"], [{ x: 1 }, { x: 2 }])];
  assertEquals(narrowArrayAppends(prev, ops), ops, "left alone");
});

Deno.test("narrowArrayAppends: nested paths and non-arrays are handled", () => {
  const a = { x: 1 }, b = { x: 2 };
  const prev = { deep: { list: [a] }, obj: { k: 1 } };
  // A path that no longer resolves, and a replace whose value is not an array,
  // must both pass through untouched rather than throw.
  assertEquals(
    narrowArrayAppends(prev, [replace(["missing", "gone"], [1, 2])]),
    [replace(["missing", "gone"], [1, 2])],
  );
  assertEquals(
    narrowArrayAppends(prev, [replace(["obj"], { k: 2 })]),
    [replace(["obj"], { k: 2 })],
  );
  // Nested list still narrows, with the full path preserved.
  const grown = [a, b, { x: 3 }];
  assertEquals(
    narrowArrayAppends({ deep: { list: [a, b] } }, [
      replace(["deep", "list"], grown),
    ]),
    [{ op: "add", path: ["deep", "list", 2], value: grown[2] }],
  );
});

Deno.test("narrowArrayAppends: untouched patch lists are returned as-is", () => {
  const ops = [replace(["a"], 1), add(["b", 0], 2)];
  assertEquals(narrowArrayAppends({ a: 0, b: [] }, ops) === ops, true);
});
