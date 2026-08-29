// `ui:` / `db:` field filters — the projection an app declares must mean the
// same thing whichever side of the filter it is written on.
import { assert, assertEquals } from "@std/assert";
import {
  applyCellFieldFilter,
  filterPatchesByStrategy,
} from "../src/state/state-filter.ts";
import { applyWirePatches } from "../src/protocol/patch-ops.ts";
import { enablePatches } from "immer";

// The delta case below applies real Immer patches; `src/state-core.ts` does
// this for the framework, and a test file that skips it fails on the plugin
// rather than on the behaviour.
enablePatches();

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

// ── An include projection keeps the array's SHAPE ────────────────────
//
// `include: ["rows.token"]` on a cell whose list is empty used to drop `rows`
// from the projection entirely: the client read `undefined` where the server
// held `[]`, and a component's `state.rows.map(…)` threw on the one state
// every app starts in. Worse on the delta path — the patch stream keeps
// sending index ops for that array, so the first `add rows[0]` could not
// resolve against a projection with no `rows` and the client had to fall back
// to a full resync to catch up.
//
// The mixed case (SOME element has the path) always produced `{}` for the
// others precisely to keep indices aligned. These pin the two cases that did
// not read the same way.
Deno.test("include: an empty array projects to an empty array", () => {
  assertEquals(
    applyCellFieldFilter({ include: ["rows.token"] }, {
      rows: [],
      secret: "s",
    }),
    { rows: [] },
  );
});

Deno.test("include: an array whose elements all lack the path keeps its length", () => {
  assertEquals(
    applyCellFieldFilter({ include: ["rows.token"] }, {
      rows: [{ id: 1 }, { id: 2 }],
      secret: "s",
    }),
    { rows: [{}, {}] },
    "the length is what index-addressed patches resolve against",
  );
});

Deno.test("include: a patched projection equals the projection of the patched state", () => {
  // The property `scripts/audit-round.ts 28` fuzzes, as one concrete case:
  // a list that starts empty, one row added.
  const filter = { include: ["rows.token"] };
  const prev = { rows: [] as { token: string }[], secret: "s" };
  const next = { rows: [{ token: "t" }], secret: "s" };
  const ops = filterPatchesByStrategy(
    [{
      cell: "c",
      ops: [{ op: "add", path: ["rows", 0], value: next.rows[0] }],
    }],
    new Map([["c", "filter"]]),
    new Map([["c", {
      mode: "include",
      fields: new Set<string>(),
      deepIncludes: [["rows", "token"]],
    }]]),
  );
  assert(ops !== undefined, "an include filter must not force a full fallback");
  assertEquals(
    applyWirePatches(applyCellFieldFilter(filter, prev), ops![0]!.ops),
    applyCellFieldFilter(filter, next),
  );
});
