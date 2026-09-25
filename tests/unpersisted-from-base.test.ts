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
