// `persist.exclude: ["list.*.secret"]` over an ARRAY of records. The `*` of a
// persist path is "any key in that place", and an array's index is the key in
// that place — but the walker treated an index as consuming no segment, so the
// `*` was spent on the element's own fields and `secret` was looked for one
// level too deep: the excluded secret was written to state.db, with no word.
// (`"m.*.secret"` over a records-by-id map always worked; the array spelling
// of the same intent did not.) Both readings now apply: the index takes the
// `*`, and the old element-wise reading stays.
import { assertEquals } from "@std/assert";
import { applyCellFieldFilter } from "../src/state/state-filter.ts";
import { unpersistedFromBase } from "../src/state/cell-persist-filter.ts";

const FILTER = { exclude: ["list.*.secret"] };
const live = () => ({
  list: [{ name: "bob", secret: "S", inner: { secret: "T" } }],
});

Deno.test("persist wildcard over an array: the index takes the `*` — the element's field is not stored", () => {
  assertEquals(
    applyCellFieldFilter(FILTER, live(), { wildcard: true }),
    // `inner.secret` is the pre-existing (element-wise) reading — kept.
    { list: [{ name: "bob", inner: {} }] },
  );
  // A visible reading takes `*` literally, as before.
  assertEquals(applyCellFieldFilter(FILTER, live()), {
    list: [{ name: "bob", secret: "S", inner: { secret: "T" } }],
  });
});

Deno.test("persist wildcard over an array: journal replay puts back what a restart holds", () => {
  const base = { list: [{ name: "", secret: "", inner: { secret: "" } }] };
  assertEquals(
    unpersistedFromBase(FILTER, base, live()),
    { list: [{ name: "bob", secret: "", inner: { secret: "" } }] },
  );
});
