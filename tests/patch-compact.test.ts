import { assertEquals } from "@std/assert";
import type { Patch } from "immer";
import { compactPatches } from "../src/state/patch-compact.ts";

// Helper to build a patch
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
