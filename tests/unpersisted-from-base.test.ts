/**
 * `unpersistedFromBase` — the ONE reading of a cell's `persist` field filter
 * for a state that did not come from the store (journal replay, dev
 * checkpoint restore): every field the store keeps OUT comes back as a
 * restart would hold it.
 */
import { assertEquals, assertStrictEquals } from "@std/assert";
import { unpersistedFromBase } from "../src/state/cell-persist-filter.ts";

const base = { a: 1, secret: "", nest: { key: "", keep: 1 } };

Deno.test("unpersistedFromBase: all keeps now, none gives base", () => {
  const now = { a: 2, secret: "s", nest: { key: "k", keep: 2 } };
  assertStrictEquals(unpersistedFromBase("all", base, now), now);
  assertStrictEquals(unpersistedFromBase("none", base, now), base);
});

Deno.test("unpersistedFromBase: exclude puts top-level and dotted fields back, keeps the rest", () => {
  const now = { a: 2, secret: "s", nest: { key: "k", keep: 2 } };
  assertEquals(
    unpersistedFromBase({ exclude: ["secret", "nest.key"] }, base, now),
    { a: 2, secret: "", nest: { key: "", keep: 2 } },
  );
});

Deno.test("unpersistedFromBase: include keeps only the named keys; a field base lacks is removed", () => {
  const now = { a: 2, secret: "s", extra: 9, nest: { key: "k", keep: 2 } };
  assertEquals(
    unpersistedFromBase({ include: ["a"] }, base, now),
    { a: 2, secret: "", nest: { key: "", keep: 1 } },
  );
});

Deno.test("unpersistedFromBase: nothing to revert keeps identity", () => {
  const now = { a: 5, secret: "", nest: { key: "", keep: 3 } };
  assertStrictEquals(
    unpersistedFromBase({ exclude: ["secret", "nest.key"] }, base, now),
    now,
  );
});

Deno.test("unpersistedFromBase: an excluded field named after a prototype member is removed, not replaced by the native", () => {
  // `key in was` is true for `toString` on every plain object, so revert used
  // to assign `Object.prototype.toString` instead of deleting the key — a
  // journal/checkpoint restore then held a native function where the restart
  // would hold nothing. Same class as the persist-exclude / state-diff pins.
  const base = { a: 1 };
  const now = { a: 2, toString: "USER" };
  const out = unpersistedFromBase({ exclude: ["toString"] }, base, now);
  assertEquals(Object.hasOwn(out, "toString"), false, String(out.toString));
  assertEquals(out, { a: 2 });
});

Deno.test("unpersistedFromBase: include drops a prototype-named field base lacks", () => {
  const base = { a: 1 };
  const now = { a: 2, valueOf: 99 };
  const out = unpersistedFromBase({ include: ["a"] }, base, now);
  assertEquals(Object.hasOwn(out, "valueOf"), false, String(out.valueOf));
  assertEquals(out, { a: 2 });
});
