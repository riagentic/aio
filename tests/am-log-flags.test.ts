// `am logs --level=error` used to be the TEXT filter "--level=error": zero
// matches, read as "no errors". An unknown flag is a refusal naming the
// accepted ones.
//
// `--level=`, `--tag=` and `--since=` are REAL flags since beta1 (watcher §6,
// §8.8; composer §9.8), so the example that founded this test is now supported.
// The rule it exists for is unchanged and is what the cases below pin: a flag
// `am logs` does not know must never be silently demoted to a search word,
// because "no matches" and "that is not a filter" look identical in the output.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { LOG_FLAGS, logFlagError } from "../src/am/am-cmd-inspect.ts";

Deno.test("an unrecognised --flag is refused, naming the accepted flags", () => {
  const e = logFlagError(["--levle=error"])!; // a typo, the realistic case
  assertStringIncludes(e, "unknown flag --levle=error");
  for (const f of LOG_FLAGS) assertStringIncludes(e, f);
  assertStringIncludes(e, "am logs error");
  assertEquals(logFlagError([]), null);
  assertEquals(logFlagError(["error"]), null);
  // The runtime's --client=<kind> is forwarded on purpose (the client's log).
  assertEquals(logFlagError(["--client=browser"]), null);
  assert(logFlagError(["error", "-x"]) !== null);
});

Deno.test("the structured filters are accepted, not demoted to search words", () => {
  // The whole point of the original bug: a flag treated as text matches
  // nothing and reads as "there is nothing to report".
  for (
    const f of [
      "--level=error",
      "--level=warn",
      "--tag=cell:todo",
      "--tag=cell",
      "--since=15m",
      "--since=2026-09-08T10:00",
    ]
  ) {
    assertEquals(logFlagError([f]), null, `${f} was refused as unknown`);
  }
  // And they appear in the accepted list, so the refusal above can teach them.
  const listed = LOG_FLAGS.join(" ");
  for (const name of ["--level", "--tag", "--since"]) {
    assertStringIncludes(listed, name);
  }
});
