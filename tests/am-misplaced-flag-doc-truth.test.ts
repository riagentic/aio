// The app-manager doc said a misplaced global flag is "refused". It is not: am
// prints a warning to stderr and runs the verb anyway (am.ts — refusing a flag
// that was always accepted would break working scripts). A doc that promises a
// refusal teaches a reader to rely on a gate that never fires.
import { assert, assertStringIncludes } from "@std/assert";
import { misplacedFlagError } from "../src/am/am-flags.ts";

Deno.test("app-manager.md describes a misplaced global flag as what am does with it", async () => {
  const warning = misplacedFlagError("timeline", ["timeline", "--follow"]);
  assert(warning, "am timeline --follow is expected to be misplaced");
  assertStringIncludes(warning, "ignored");

  const doc = await Deno.readTextFile(
    new URL("../docs/clients/app-manager.md", import.meta.url),
  );
  const at = doc.indexOf("A global flag given to a verb that does not read it");
  assert(at >= 0, "the paragraph moved — re-point this test");
  const para = doc.slice(at, doc.indexOf("\n\n", at));
  assert(!/\brefused\b/.test(para), `still says refused:\n${para}`);
  assertStringIncludes(para, "ignored");
});
