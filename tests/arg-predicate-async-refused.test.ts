// docs/state/methods.md: "An asynchronous schema is refused by name." An
// `async (v) => …` PREDICATE was refused too — but as "the check returned
// false", a false the predicate never returned, so the reader hunted the
// predicate's logic instead of its `async`.
import { assert, assertThrows } from "@std/assert";
import { validateMethodArgs } from "../src/state/arg-schema.ts";

Deno.test("an async args predicate is refused by name, not as 'the check returned false'", () => {
  // deno-lint-ignore require-await
  const asyncPredicate = async (v: unknown) => typeof v === "number";
  const msg = String(
    assertThrows(() =>
      validateMethodArgs(
        "c",
        "m",
        [asyncPredicate as unknown as (v: unknown) => true],
        [1],
      )
    ),
  );
  assert(msg.includes("ASYNCHRONOUS"), msg);
  assert(!msg.includes("the check returned false"), msg);
  assert(msg.includes("[c:m] argument 1"), msg);
  assert(msg.includes("fix:"), msg);
});
