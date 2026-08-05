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
  assertEquals(diffs[0]!.cell, "counter");
  assertEquals(diffs[0]!.changes.length, 1);
  assertEquals(diffs[0]!.changes[0]!.key, "count");
});

Deno.test("computeDiffs: detects multiple field changes", () => {
  const prev = { counter: { count: 5, total: 10 } };
  const next = { counter: { count: 10, total: 25 } };
  const diffs = computeDiffs(prev, next);
  assertEquals(diffs[0]!.changes.length, 2);
});

Deno.test("computeDiffs: ignores unchanged cells", () => {
  const shared = { status: "idle" };
  const prev = { counter: { count: 5 }, wallet: shared };
  const next = { counter: { count: 10 }, wallet: shared };
  const diffs = computeDiffs(prev, next);
  assertEquals(diffs.length, 1);
  assertEquals(diffs[0]!.cell, "counter");
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

// A DIAGNOSTIC may never be the thing that kills the app: state legally holds
// values JSON.stringify throws on. The differ used to hand a BigInt straight to
// JSON.stringify, from inside the observe-only afterAction hook — process down.
Deno.test("formatDiff: a BigInt is rendered, not thrown on", () => {
  const line = formatDiff("wallet", [{ key: "balance", from: 0n, to: 42n }]);
  assertEquals(line, "wallet: balance 0n→42n");
});

Deno.test("formatDiff: a BigInt nested inside an object is rendered", () => {
  const line = formatDiff("wallet", [{
    key: "acct",
    from: { id: 1n },
    to: { id: 2n },
  }]);
  assertEquals(line, `wallet: acct {"id":"1n"}→{"id":"2n"}`);
});

Deno.test("formatDiff: a circular value degrades instead of throwing", () => {
  const a: Record<string, unknown> = { name: "a" };
  a.self = a;
  const line = formatDiff("cell", [{ key: "k", from: null, to: a }]);
  assertEquals(line.includes("Circular"), true);
});

Deno.test("formatDiff: an unserializable value degrades to a label", () => {
  const hostile = {
    toJSON() {
      throw new Error("nope");
    },
  };
  const line = formatDiff("cell", [{ key: "k", from: 1, to: hostile }]);
  assertEquals(line, "cell: k 1→[unserializable object]");
});
