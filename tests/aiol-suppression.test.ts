// `// aiol-ok` only worked on the flagged line, the message didn't
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

// ── one marker, two spellings, no trap ─────────────────────────────────────
//
// There were two markers one letter apart — `aio-ok` for the repo's own gates,
// `aiol-ok` for this linter — and they were placed by copying nearby code,
// which is exactly how you end up with the wrong one (vidtune §8.1: "one marker
// with a scope"). `aio-ok` wins on the count that matters, ~100 uses to 3, so it
// is accepted here too and is the one to write. The old spelling keeps working
// forever: a suppression that stops suppressing turns a silent, deliberate
// decision into a wall of new findings.

Deno.test("aiol: `aio-ok` suppresses, and `aiol-ok` still does", () => {
  for (const marker of ["aio-ok", "aiol-ok"]) {
    // On the line itself.
    assertEquals(
      isSuppressed([`const t = setTimeout(f, 1); // ${marker}: deliberate`], 0),
      true,
      `${marker} on the line did not suppress`,
    );
    // On the comment block above — where a justification naturally goes.
    assertEquals(
      isSuppressed(
        [
          `// ${marker}: deliberate`,
          "// because the drain deadline is real",
          "const t = setTimeout(f, 1);",
        ],
        2,
      ),
      true,
      `${marker} in the comment block above did not suppress`,
    );
  }
});

Deno.test("aiol: the marker match is a WORD, not a substring", () => {
  // `aiolo-ok`, `xaio-ok` and prose about the marker must not suppress. A
  // suppression that fires on a near-miss is worse than one that never fires:
  // it hides a finding nobody chose to hide.
  for (const near of ["aiolo-ok", "xaio-ok", "aio-oky"]) {
    assertEquals(
      isSuppressed([`const t = setTimeout(f, 1); // ${near}`], 0),
      false,
      `"${near}" suppressed a finding — it is not the marker`,
    );
  }
});
