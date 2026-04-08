// Audit regression: mergeField null/undefined safety and conflict detection
import { assertEquals, assertThrows } from "@std/assert";
import { mergeField } from "../../src/sync/merge.ts";
import type { HLC } from "../../src/sync/types.ts";

const hlcA: HLC = [1, 0, "a"];
const hlcB: HLC = [2, 0, "b"];

Deno.test("set-add with null local and remote does not throw", () => {
  const r = mergeField("set-add", null, hlcA, null, hlcB);
  assertEquals(Array.isArray(r.value), true);
  assertEquals((r.value as unknown[]).length, 0);
});

Deno.test("set-add with undefined local and remote does not throw", () => {
  const r = mergeField("set-add", undefined, hlcA, undefined, hlcB);
  assertEquals(Array.isArray(r.value), true);
});

Deno.test("set-remove with null base does not throw", () => {
  const items = [{ id: "x", v: 1 }];
  const r = mergeField("set-remove", items, hlcA, items, hlcB, null);
  assertEquals(Array.isArray(r.value), true);
});

Deno.test("set-remove with undefined base does not throw", () => {
  const items = [{ id: "x", v: 1 }];
  const r = mergeField("set-remove", items, hlcA, items, hlcB, undefined);
  assertEquals(Array.isArray(r.value), true);
});

Deno.test("set-add detects conflict: same id, different content — LWW resolves", () => {
  const local = [{ id: "1", name: "Alice" }];
  const remote = [{ id: "1", name: "Bob" }];
  const r = mergeField("set-add", local, hlcA, remote, hlcB);
  assertEquals(r.conflict, true);
  // LWW: hlcB > hlcA → remote wins
  const items = r.value as { id: string; name: string }[];
  assertEquals(items[0]!.name, "Bob");
});

Deno.test("set-add no conflict when content identical", () => {
  const local = [{ id: "1", name: "Same" }];
  const remote = [{ id: "1", name: "Same" }];
  const r = mergeField("set-add", local, hlcA, remote, hlcB);
  assertEquals(r.conflict, false);
});

Deno.test("set-add throws when object missing id field", () => {
  const local = [{ noId: "oops" }];
  const remote: unknown[] = [];
  assertThrows(
    () => mergeField("set-add", local, hlcA, remote, hlcB),
    Error,
    'missing required id field "id"',
  );
});
