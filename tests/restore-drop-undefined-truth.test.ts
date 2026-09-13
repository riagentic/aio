// The dev write watcher, on a value JSON never stores.
//
// `clear(s) { s.meta = { a: 2, b: undefined } }` over a declared `meta: { a: 1 }`
// warned "jn.meta.b (undefined) is being written but is not declared … the
// next boot will NOT restore it (dev refuses to boot over it …). Declare it
// with a default". None of it was true: JSON drops the key, so the next boot
// reads `b` absent — `undefined`, exactly what was written — and the boot
// check has nothing to refuse over. The advice sent the author to change a
// declaration to fix a loss that does not exist.
//
// Each claim is checked against what restore ACTUALLY does (JSON round-trip,
// the boot drift check, deepMerge), not against the message's own wording.
import { assert, assertEquals } from "@std/assert";
import {
  detectShapeDrift,
  restoreDropWatcher,
} from "../src/server/aio-boot.ts";
import { deepMerge } from "../src/state/deep-merge.ts";

const INITIAL = { jn: { meta: { a: 1 } as Record<string, unknown>, n: 0 } };

/** What the next boot reads back for a written document. */
const roundTrip = (doc: unknown) => JSON.parse(JSON.stringify(doc));

Deno.test("restoreDropWatcher: an undeclared key written as undefined is not reported — nothing is lost", () => {
  const warned: string[] = [];
  const watch = restoreDropWatcher(INITIAL, new Set(), (m) => warned.push(m));
  const doc = { jn: { meta: { a: 2, b: undefined }, n: 1 } };
  watch(doc);
  // The fact the silence rests on: the next boot sees no drift, and the
  // restored `b` is the `undefined` that was written.
  const stored = roundTrip(doc);
  assertEquals(detectShapeDrift(INITIAL, stored), []);
  const restored = deepMerge(INITIAL, stored) as typeof doc;
  assertEquals(restored.jn.meta.b, undefined);
  assertEquals(warned, [], warned.join("\n"));
});

Deno.test("restoreDropWatcher: a DECLARED key written as undefined says what restore really does", () => {
  const warned: string[] = [];
  const watch = restoreDropWatcher(INITIAL, new Set(), (m) => warned.push(m));
  const doc = { jn: { meta: { a: 1 }, n: undefined } };
  watch(doc);
  // Restore puts the declared default back, and dev has nothing to refuse.
  const stored = roundTrip(doc);
  assertEquals(detectShapeDrift(INITIAL, stored), []);
  assertEquals((deepMerge(INITIAL, stored) as typeof INITIAL).jn.n, 0);
  assertEquals(warned.length, 1, warned.join("\n"));
  const w = warned[0]!;
  assert(w.includes("jn.n is being written as undefined"), w);
  assert(w.includes("restores the declared number default"), w);
  assert(
    !w.includes("refuses to boot"),
    `claims a refusal that cannot happen: ${w}`,
  );
  assert(!w.includes("Declare it with a default"), w);
});

Deno.test("restoreDropWatcher: a real undeclared value is still reported with the refusal it causes", () => {
  const warned: string[] = [];
  const watch = restoreDropWatcher(INITIAL, new Set(), (m) => warned.push(m));
  const doc = { jn: { meta: { a: 2, b: 3 }, n: 1 } };
  watch(doc);
  // …and this one IS drift at the next boot, so the refusal wording stands.
  assertEquals(detectShapeDrift(INITIAL, roundTrip(doc)).length, 1);
  assertEquals(warned.length, 1, warned.join("\n"));
  assert(warned[0]!.includes("jn.meta.b (number)"), warned[0]);
  assert(warned[0]!.includes("dev refuses to boot over it"), warned[0]);
});
