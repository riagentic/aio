// The include projection (`pickPath`) and the top-level include tested keys
// with `in`, which sees Object.prototype: an include path ending in
// `toString`/`constructor` picked the NATIVE FUNCTION for a field the state
// does not have, instead of reporting it missing.
import { assertEquals } from "@std/assert";
import { applyCellFieldFilter } from "../src/state/state-filter.ts";

Deno.test("visible.include: a builtin-named path the state lacks projects to nothing", () => {
  const out = applyCellFieldFilter(
    { include: ["profile.toString", "constructor", "name"] },
    { profile: { a: 1 }, name: "x" },
  ) as Record<string, unknown>;
  assertEquals(JSON.parse(JSON.stringify(out)), { name: "x" });
  assertEquals(Object.hasOwn(out, "constructor"), false);
  assertEquals(Object.hasOwn(out, "profile"), false);
});
