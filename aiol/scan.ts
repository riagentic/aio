// scan.ts — "is this offset real code?" for aiol's regex-based checks.
//
// aiol reads sources with regexes (no AST — it must lint files it can't type
// check). The cost is that a `cell("counter", …)` written inside a doc comment
// or inside a code-generator's template literal looks exactly like a declared
// cell, so a project with an example in a JSDoc block gets phantom cells — and
// a phantom `duplicate cell name` ERROR it can never fix.
//
// `codeMask` walks the source once and marks every offset as code (1) or
// not-code (0): comment bodies and the *contents* of string / template /
// regex literals are 0. The delimiters and the surrounding code stay 1, so a
// real `cell("x")` still matches (the `cell(` token is code) while one inside
// a comment or a template does not. Offsets are preserved 1:1, so a caller can
// keep matching against the ORIGINAL text and just ask "was this in code?".
//
// Deliberate simplification: `${…}` interpolations count as template content,
// not code. A cell declared inside a template's interpolation is generated
// text, not a cell of this project — exactly what we want skipped.
//
// The MASK ITSELF lives in `src/diagnostics/code-mask.ts` and is re-exported
// here unchanged: aiol had this implementation and `graph-validator.ts`
// hand-rolled a worse one that destroyed line numbers. One fact, one spelling.
import { codeMask, codeText } from "../src/diagnostics/code-mask.ts";
export { codeMask, codeText };

/** Keep only the regex matches whose start offset is real code. Pure. */
export function codeMatches(
  src: string,
  re: RegExp,
): RegExpMatchArray[] {
  const mask = codeMask(src);
  return [...src.matchAll(re)].filter((m) => mask[m.index!] === 1);
}
