import { assert } from "@std/assert";
import { deepExcludePaths } from "../src/state/state-filter.ts";

Deno.test("vfB: a record id equal to the excluded field name disables the filter", () => {
  const state = {
    accounts: {
      // A user-chosen id that happens to equal the excluded FIELD name.
      encSecKey: { note: "an ordinary record" },
      alice: { name: "a", encSecKey: "SECRET-alice" },
      bob: { name: "b", encSecKey: "SECRET-bob" },
    },
  };
  const wire = deepExcludePaths(state.accounts, [["encSecKey"]]);
  const json = JSON.stringify(wire);
  assert(
    !json.includes("SECRET-alice") && !json.includes("SECRET-bob"),
    `wire filter leaked: ${json}`,
  );
});

Deno.test("vfB: a prototype-chain field name disables the filter", () => {
  const state = { a: { alice: { constructor: "SECRET-c" } } };
  const wire = deepExcludePaths(state.a, [["constructor"]]);
  const json = JSON.stringify(wire);
  assert(!json.includes("SECRET-c"), `wire filter leaked: ${json}`);
});
