// `ui:` / `db:` field filters — the projection an app declares must mean the
// same thing whichever side of the filter it is written on.
import { assert, assertEquals } from "@std/assert";
import { applyCellFieldFilter } from "../src/state/state-filter.ts";

// ── a dot path means the same thing on both sides of the filter ──────────
//
// `exclude: ["profile.token"]` pruned the sub-path; `include: ["profile.name"]`
// matched no key called "profile.name" and produced NOTHING — the field
// vanished silently. Failing closed is the right direction, saying nothing
// about it is not: the app asked for one sub-path and got an empty projection.
Deno.test("state-filter: include takes dot paths, like exclude does", () => {
  const state = {
    pub: 1,
    secret: 2,
    profile: { name: "n", token: "t", deep: { keep: 1, drop: 2 } },
  };
  assertEquals(
    applyCellFieldFilter({ include: ["profile.name"] }, state),
    { profile: { name: "n" } },
  );
  assertEquals(
    applyCellFieldFilter({ include: ["pub", "profile.deep.keep"] }, state),
    { pub: 1, profile: { deep: { keep: 1 } } },
  );
  // A path that is not there invents nothing.
  assertEquals(
    applyCellFieldFilter({ include: ["profile.nope"] }, state),
    {},
  );
  // …and the secret is still not in any of them.
  for (
    const f of [
      { include: ["profile.name"] },
      { include: ["pub", "profile.deep.keep"] },
    ]
  ) {
    assert(!JSON.stringify(applyCellFieldFilter(f, state)).includes("secret"));
    assert(!JSON.stringify(applyCellFieldFilter(f, state)).includes('"t"'));
  }
});

Deno.test("state-filter: include through an array applies to every element, like exclude", () => {
  const state = {
    rows: [
      { id: 1, name: "a", secret: "x" },
      { id: 2, name: "b", secret: "y" },
      { id: 3 }, // no name — keeps its slot, carries nothing
    ],
    other: 1,
  };
  assertEquals(
    applyCellFieldFilter({ include: ["rows.name"] }, state),
    { rows: [{ name: "a" }, { name: "b" }, {}] },
  );
  // Sibling paths merge into ONE projection — per key and per element.
  assertEquals(
    applyCellFieldFilter({ include: ["rows.id", "rows.name"] }, state),
    { rows: [{ id: 1, name: "a" }, { id: 2, name: "b" }, { id: 3 }] },
  );
  // …and the mirror: exclude of the same path strips it from every element.
  const ex = applyCellFieldFilter({ exclude: ["rows.secret"] }, state);
  assert(!JSON.stringify(ex).includes("secret"));
  assertEquals((ex!.rows as unknown[]).length, 3);
});
