// `isSuppressed`'s "formatter-wrapped continuation" branch treated ANY line
// ending in `,` as an opener (`/[=(,[]$/`), so a marker written for one array
// element / argument / object entry also silenced the NEXT sibling — though a
// complete code line sits between them. docs/basics/pitfalls.md: the marker
// "counts on the flagged line, or anywhere in the contiguous comment block
// directly above it … so a stray marker higher up cannot silently cover
// unrelated code". The third sibling is (correctly) still reported, which
// showed the second one was covered by accident.
import { assertEquals } from "@std/assert";
import { isSuppressed } from "../aiol/checks.ts";

Deno.test("isSuppressed: a marker for one list element does not cover the next", () => {
  const lines = [
    "const els = [",
    "  // aio-ok: honeypot field, deliberately unnamed",
    '  <input type="text" />,',
    '  <input type="text" />,',
    '  <input type="text" />,',
    "];",
  ];
  assertEquals(
    isSuppressed(lines, 2),
    true,
    "control: the element under the marker",
  );
  assertEquals(isSuppressed(lines, 4), false, "control: the third element");
  assertEquals(
    isSuppressed(lines, 3),
    false,
    "the second element has no marker on it or in a comment block above it",
  );
});

Deno.test("isSuppressed: a marker for one argument does not cover the next", () => {
  const lines = [
    "report(",
    "  // aio-ok: deliberate",
    "  setTimeout(a, 1),",
    "  setTimeout(b, 1),",
    ");",
  ];
  assertEquals(isSuppressed(lines, 2), true);
  assertEquals(isSuppressed(lines, 3), false);
});

Deno.test("isSuppressed: a formatter-wrapped statement is still covered from above", () => {
  // The case the continuation branch exists for — `=`, `(`, `[` openers.
  for (
    const opener of ["const ANSI =", "const t = setTimeout(", "const xs = ["]
  ) {
    const lines = ["// aio-ok: deliberate", opener, "  /x/g;"];
    assertEquals(isSuppressed(lines, 2), true, opener);
  }
});
