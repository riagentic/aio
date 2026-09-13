// `am expect` PASSED on a path that is not there.
//
// `am expect todo.itmes.length ne 0` — a typo in the path — compared
// `undefined` with 0, found them different, and printed PASS: exactly the
// assertion a script writes to prove a list is non-empty. `eq` with no value
// compared `undefined` with a missing path and passed too, and a fourth word
// was dropped without a sound. Measured by a hunter running `am` as a user.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { compareValue, expectUsageError } from "../src/am/am-cmd-state.ts";

Deno.test("am expect: every op but absent/exists FAILS on a missing path", () => {
  for (
    const [op, v] of [
      ["ne", 0],
      ["eq", undefined],
      ["eq", null],
      ["gt", -1],
      ["lte", 5],
      ["contains", "x"],
    ] as const
  ) {
    const r = compareValue(undefined, op, v, false);
    assertEquals(r.ok, false, `${op} passed on a path that does not exist`);
    assertStringIncludes(r.reason, "path not found");
  }
  // The two ops that are ABOUT found-ness keep their meaning.
  assertEquals(compareValue(undefined, "absent", undefined, false).ok, true);
  assertEquals(compareValue(undefined, "exists", undefined, false).ok, false);
  // A present value still compares.
  assertEquals(compareValue(3, "ne", 0, true).ok, true);
  assertEquals(compareValue(null, "eq", null, true).ok, true);
});

Deno.test("am expect: a comparison with no value is a usage error", () => {
  const e = expectUsageError(["todo.items.length", "eq"]);
  assert(e, "`am expect p eq` compared against undefined");
  assertStringIncludes(e, "needs a value");
  assertEquals(expectUsageError(["todo.items", "exists"]), null);
  assertEquals(expectUsageError(["n", "gt", "1"]), null);
});

Deno.test("am expect: extra positionals are refused, not dropped", () => {
  const e = expectUsageError(["title", "eq", "hello", "world"]);
  assert(e, "`am expect title eq hello world` asserted `hello`");
  assertStringIncludes(e, "world");
  assert(expectUsageError(["p", "absent", "x"]), "absent takes no value");
});

Deno.test("am expect: an unknown op is refused before any polling", () => {
  assertStringIncludes(expectUsageError(["p", "equals", "1"])!, "unknown op");
  assert(expectUsageError(["p"]));
  assert(expectUsageError([]));
});
