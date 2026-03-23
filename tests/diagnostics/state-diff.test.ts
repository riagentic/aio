import { assertEquals } from "@std/assert";
import { computeDiffs, formatDiff } from "../../src/diagnostics/state-diff.ts";

Deno.test("computeDiffs: no change returns empty", () => {
  const state = { counter: { count: 5 } };
  assertEquals(computeDiffs(state, state), []);
});

Deno.test("computeDiffs: referential equality skip", () => {
  const obj = { count: 5 };
  assertEquals(computeDiffs({ counter: obj }, { counter: obj }), []);
});

Deno.test("computeDiffs: detects single field change", () => {
  const prev = { counter: { count: 5, total: 10 } };
  const next = { counter: { count: 10, total: 10 } };
  const diffs = computeDiffs(prev, next);
  assertEquals(diffs.length, 1);
  assertEquals(diffs[0]!.feature, "counter");
  assertEquals(diffs[0]!.changes.length, 1);
  assertEquals(diffs[0]!.changes[0]!.key, "count");
});

Deno.test("computeDiffs: detects multiple field changes", () => {
  const prev = { counter: { count: 5, total: 10 } };
  const next = { counter: { count: 10, total: 25 } };
  const diffs = computeDiffs(prev, next);
  assertEquals(diffs[0]!.changes.length, 2);
});

Deno.test("computeDiffs: ignores unchanged features", () => {
  const shared = { status: "idle" };
  const prev = { counter: { count: 5 }, wallet: shared };
  const next = { counter: { count: 10 }, wallet: shared };
  const diffs = computeDiffs(prev, next);
  assertEquals(diffs.length, 1);
  assertEquals(diffs[0]!.feature, "counter");
});

Deno.test("formatDiff: truncates long values", () => {
  const line = formatDiff("counter", [{
    key: "data",
    from: "a".repeat(100),
    to: "b".repeat(100),
  }]);
  assertEquals(line.includes("…"), true);
});

Deno.test("formatDiff: formats simple change", () => {
  const line = formatDiff("counter", [{ key: "count", from: 5, to: 10 }]);
  assertEquals(line.includes("count"), true);
  assertEquals(line.includes("5"), true);
  assertEquals(line.includes("10"), true);
});
