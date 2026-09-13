// `am create` writes a CLAUDE.md, because Claude Code reads that and not
// AGENTS.md.
//
// Measured by an agent that scaffolded and built an app end to end: the
// pointer to `am agent` lived only in AGENTS.md, which Claude Code never
// loads, so the one agent most likely to be driving aio started without the
// brief. The file is one line that IMPORTS AGENTS.md (`@AGENTS.md`), so there
// is still a single pointer to keep true, not two.
import { assert, assertStringIncludes } from "@std/assert";
import { scaffold } from "../src/am/am-cmd-create.ts";
import { TEMPLATES } from "../src/am/am-help-text.ts";

Deno.test("am create: every template writes a CLAUDE.md that imports AGENTS.md", () => {
  assert(
    TEMPLATES.length >= 5,
    "the template list is not what am create offers",
  );
  for (const template of TEMPLATES) {
    const files = scaffold("demo", template, true);
    assert("AGENTS.md" in files, `${template}: no AGENTS.md`);
    const claude = files["CLAUDE.md"];
    assert(claude !== undefined, `${template}: no CLAUDE.md`);
    assertStringIncludes(claude, "@AGENTS.md", template);
    assertStringIncludes(claude, "am agent", template);
    assert(
      claude.trim().split("\n").length === 1,
      `${template}: CLAUDE.md is a pointer, not a second copy of the brief`,
    );
  }
});
