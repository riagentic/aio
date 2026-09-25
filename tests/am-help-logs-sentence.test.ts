// `am help logs` ended on a line reading just "keeps error events" — the tail
// of `e.g. "am logs error" keeps error events`, left behind when the flag and
// --json lines were inserted between it and the sentence it finishes. The
// example read as `am logs error` with no stated effect, and the orphan as a
// description of `.total`.
import { assert } from "@std/assert";
import { HELP_TEXT, helpBlock } from "../src/am/am-cmd-meta.ts";

Deno.test("am help logs: the filter example is one sentence, not an orphan line", () => {
  const block = helpBlock(HELP_TEXT, "logs");
  assert(block, "am help logs has a block");
  const prose = block.replace(/\s+/g, " ");
  assert(
    prose.includes(`e.g. "am logs error" keeps error events`),
    block,
  );
});
