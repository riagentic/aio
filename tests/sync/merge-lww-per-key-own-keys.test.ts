// tests/sync/merge-lww-per-key-own-keys.test.ts — `lww-per-key` decides "is
// this key on both sides?" by OWN keys only.
//
// It used `key in record`, which is also true for every key Object.prototype
// carries. A record keyed by words or tags (`{ constructor: 3 }`) then had a
// remote-only key treated as shared: merged against the inherited native
// function, reported as a conflict nobody made, and — with local newer —
// replaced by that FUNCTION in the merged record.
import { assertEquals } from "@std/assert";
import { mergeField } from "../../src/sync/merge.ts";
import type { HLC } from "../../src/sync/types.ts";

const older: HLC = [1000, 0, "B"];
const newer: HLC = [2000, 0, "A"];

Deno.test("lww-per-key: a remote-only key named like an Object.prototype member is kept, not merged against it", () => {
  for (const [lh, rh] of [[newer, older], [older, newer]] as const) {
    const r = mergeField(
      "lww-per-key",
      { a: 1 },
      lh,
      { constructor: 3, toString: "x", valueOf: 7 },
      rh,
    );
    assertEquals(r, {
      value: { a: 1, constructor: 3, toString: "x", valueOf: 7 },
      conflict: false,
    });
  }
  // …and the mirror: local-only.
  const m = mergeField(
    "lww-per-key",
    { hasOwnProperty: true },
    older,
    { b: 2 },
    newer,
  );
  assertEquals(m, { value: { b: 2, hasOwnProperty: true }, conflict: false });
});
