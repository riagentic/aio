// "did you mean --app=x?" — the round trip a true-but-useless message cost.
//
// `am` takes its target through `--app`, because the first positional of most
// verbs is already a state path, an action or a client index. That grammar is
// defensible and easy to forget, and forgetting it produced:
//
//     $ am surface my-app
//     client index must be a number (got "my-app")
//
// true, unhelpful, and silent about the flag that was meant. Measured in a real
// session: it cost a round trip. A message that knows the answer and does not
// say it is a message with a bug in it.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { appMeantHint, parseNumArg } from "../src/am/am-utils.ts";

Deno.test("am hint: a plain typo still gets the plain message", () => {
  const r = parseNumArg("2s", "--timeout");
  assert(!r.ok);
  assertStringIncludes(r.error, "must be a number");
  assertEquals(
    r.error.includes("--app="),
    false,
    '"2s" names no app, so guessing at one would be noise',
  );
});

Deno.test("am hint: numbers and flags never trigger it", () => {
  for (const v of ["3", "-1", "0.5", "--json", ""]) {
    assertEquals(appMeantHint(v), "", `"${v}" must not look like an app name`);
  }
  assertEquals(appMeantHint(undefined), "");
});

Deno.test("am hint: it never throws, whatever it is handed", () => {
  // A hint that can fail is worse than no hint: it turns a readable error into
  // an unreadable one, on the path where the user is already confused.
  for (const v of [" ", "../..", "a".repeat(5000), "a b c", "]["]) {
    assertEquals(typeof appMeantHint(v), "string", v.slice(0, 20));
  }
});

Deno.test("am hint: a real number parses, hint or not", () => {
  const r = parseNumArg("7", "--index", { integer: true, min: 0 });
  assert(r.ok);
  assertEquals(r.value, 7);
});

Deno.test("am hint: the bound checks keep their own messages", () => {
  const lo = parseNumArg("-1", "--index", { min: 0 });
  assert(!lo.ok);
  assertStringIncludes(lo.error, "0");
  const frac = parseNumArg("1.5", "--index", { integer: true });
  assert(!frac.ok);
  assertStringIncludes(frac.error, "whole number");
});
