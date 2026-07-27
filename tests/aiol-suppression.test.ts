// llama.md #7: `// aiol-ok` only worked on the flagged line, the message didn't
// say so, and `deno fmt` reflowed a marker parked on a long line — so the hint
// came back somewhere else. Clearing eight hints took four passes.
//
// It now also counts on the comment line immediately above: where the reason
// belongs, where other linters accept it, and where the formatter can't move it.
import { assert, assertEquals } from "@std/assert";
import { isSuppressed } from "../aiol/checks.ts";

Deno.test("aiol-ok: on the flagged line", () => {
  const lines = ["const t = setTimeout(f, 100); // aiol-ok — deliberate"];
  assert(isSuppressed(lines, 0));
});

Deno.test("aiol-ok: on the comment line above (where the reason goes)", () => {
  const lines = [
    "// aiol-ok — one-shot yield, not a schedulable timer",
    "const t = setTimeout(f, 100);",
  ];
  assert(
    isSuppressed(lines, 1),
    "the natural place for a justification must work — deno fmt cannot move a " +
      "whole comment line, which is the point",
  );
});

Deno.test("aiol-ok: a blank line breaks the association", () => {
  const lines = [
    "// aiol-ok — this justifies the call BELOW the blank line? no.",
    "",
    "const t = setTimeout(f, 100);",
  ];
  assertEquals(
    isSuppressed(lines, 2),
    false,
    "otherwise a stray marker higher up silently covers unrelated code",
  );
});

Deno.test("aiol-ok: a non-comment line above does not suppress", () => {
  const lines = [
    'const label = "aiol-ok";',
    "const t = setTimeout(f, 100);",
  ];
  assertEquals(
    isSuppressed(lines, 1),
    false,
    "a mention in code is not a suppression",
  );
});

Deno.test("aiol-ok: unsuppressed stays unsuppressed", () => {
  assertEquals(isSuppressed(["const t = setTimeout(f, 100);"], 0), false);
});
