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

/** Offsets of the TOP-LEVEL `<key>:` positions inside the object literal whose
 *  `{` sits at `open`. Depth-aware and mask-aware, so a key of a NESTED object
 *  is not this object's key and a `key:` inside a string or comment is nothing
 *  at all.
 *
 *  It exists because `\{[^}]*\}` does not stop at a nested `{`: it stops at the
 *  first `}`, which for `call({ retry: { timeout: 30 } })` is the INNER one, so
 *  the user's own `retry.timeout` field was read as the call's deprecated
 *  option — reported as an error, and REWRITTEN to `timeoutMs` by --safe-fix,
 *  against that fix's own "no behaviour change" guarantee. One decider, used by
 *  the rule and by the fix, so the two can never disagree about which key they
 *  are looking at. Pure. */
export function topLevelKeyOffsets(
  src: string,
  open: number,
  key: string,
): number[] {
  if (src[open] !== "{") return [];
  const mask = codeMask(src);
  const out: number[] = [];
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (mask[i] !== 1) continue; // string / comment / regex body
    const ch = src[i]!;
    if (ch === "{" || ch === "[" || ch === "(") {
      depth++;
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      if (depth <= 0) break; // this object closed
      continue;
    }
    if (depth !== 1 || !src.startsWith(key, i)) continue;
    // A key is preceded (past whitespace) by the opening `{` or a comma —
    // never by anything else. Without that, `{ ms: cond ? timeout : 0 }` reads
    // its ternary's `:` as a key's colon.
    let b = i - 1;
    while (b > open && /\s/.test(src[b]!)) b--;
    if (src[b] !== "{" && src[b] !== ",") continue;
    let a = i + key.length;
    while (a < src.length && /\s/.test(src[a]!)) a++;
    if (src[a] !== ":") continue;
    out.push(i);
  }
  return out;
}
