// risoto #5 (e2e slice) — `am expect <path> <op> [value]`: assert on live server
// state over the real socket; the building block for a scripted test:e2e. The
// comparator is pure, so the assertion semantics are unit-tested here.
import { assertEquals } from "@std/assert";
import { compareValue } from "../src/am/am-cmd-state.ts";

const ok = (r: { ok: boolean }) => r.ok;

Deno.test("compareValue: eq / ne (deep, JSON-based)", () => {
  assertEquals(ok(compareValue(5, "eq", 5, true)), true);
  assertEquals(ok(compareValue("Ready", "eq", "Ready", true)), true);
  assertEquals(ok(compareValue(5, "eq", 6, true)), false);
  assertEquals(ok(compareValue({ a: 1 }, "eq", { a: 1 }, true)), true);
  assertEquals(ok(compareValue(5, "ne", 6, true)), true);
});

Deno.test("compareValue: numeric ordering", () => {
  assertEquals(ok(compareValue(10, "gt", 5, true)), true);
  assertEquals(ok(compareValue(5, "gt", 5, true)), false);
  assertEquals(ok(compareValue(5, "gte", 5, true)), true);
  assertEquals(ok(compareValue(3, "lt", 5, true)), true);
  assertEquals(ok(compareValue(5, "lte", 5, true)), true);
});

Deno.test("compareValue: contains (string + array)", () => {
  assertEquals(
    ok(compareValue("hello world", "contains", "world", true)),
    true,
  );
  assertEquals(ok(compareValue("hello", "contains", "xyz", true)), false);
  assertEquals(ok(compareValue([1, 2, 3], "contains", 2, true)), true);
  assertEquals(ok(compareValue([1, 2, 3], "contains", 9, true)), false);
  assertEquals(ok(compareValue(42, "contains", 4, true)), false); // not str/array
});

Deno.test("compareValue: exists / absent use found-ness (not the value)", () => {
  assertEquals(ok(compareValue(null, "exists", undefined, true)), true);
  assertEquals(ok(compareValue(undefined, "exists", undefined, false)), false);
  assertEquals(ok(compareValue(undefined, "absent", undefined, false)), true);
  assertEquals(ok(compareValue(0, "absent", undefined, true)), false);
});

Deno.test("compareValue: unknown op fails with guidance", () => {
  const r = compareValue(1, "bogus", 1, true);
  assertEquals(r.ok, false);
  assertEquals(r.reason.includes("unknown op"), true);
});
