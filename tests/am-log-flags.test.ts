// `am logs --level=error` used to be the TEXT filter "--level=error": zero
// matches, read as "no errors". An unknown flag is a refusal naming the
// accepted ones.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { LOG_FLAGS, logFlagError } from "../src/am/am-cmd-inspect.ts";

Deno.test("an unrecognised --flag is refused, naming the accepted flags", () => {
  const e = logFlagError(["--level=error"])!;
  assertStringIncludes(e, "unknown flag --level=error");
  for (const f of LOG_FLAGS) assertStringIncludes(e, f);
  assertStringIncludes(e, "am logs error");
  assertEquals(logFlagError([]), null);
  assertEquals(logFlagError(["error"]), null);
  // The runtime's --client=<kind> is forwarded on purpose (the client's log).
  assertEquals(logFlagError(["--client=browser"]), null);
  assert(logFlagError(["error", "-x"]) !== null);
});
