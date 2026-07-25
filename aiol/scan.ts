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

/** Per-offset flags: 1 = real code, 0 = comment / string / template / regex
 *  body. Same length as `src`. Pure. */
export function codeMask(src: string): Uint8Array {
  const mask = new Uint8Array(src.length).fill(1);
  // A `/` opens a regex literal (not a division) when the previous meaningful
  // char can't end an expression — the standard heuristic.
  const regexOk = (i: number): boolean => {
    for (let j = i - 1; j >= 0; j--) {
      const c = src[j]!;
      if (c === " " || c === "\t") continue;
      // A line start counts as "expression position" (ASI) — `/re/.test(x)` as
      // the first token of a line is a regex, never a division.
      if (c === "\n" || c === "\r") return true;
      return "([{,;:=!&|?+-*%~^<>".includes(c);
    }
    return true; // start of file
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    // Line comment — body (after `//`) is not code, the newline stays code.
    if (c === "/" && next === "/") {
      i += 2;
      while (i < src.length && src[i] !== "\n") mask[i++] = 0;
      continue;
    }
    // Block comment — body is not code; newlines inside stay newlines.
    if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        mask[i++] = 0;
      }
      i = Math.min(i + 2, src.length);
      continue;
    }
    // String / template literal — contents are not code, quotes are.
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          mask[i] = 0;
          mask[i + 1] = 0;
          i += 2;
          continue;
        }
        if (src[i] === c) break;
        // An unterminated single/double-quoted string can't cross a line —
        // bail so one stray apostrophe doesn't blind the rest of the file.
        if (c !== "`" && src[i] === "\n") break;
        mask[i++] = 0;
      }
      i++;
      continue;
    }
    // Regex literal — `/…/flags`; contents (incl. quotes) are not code.
    if (c === "/" && regexOk(i)) {
      let j = i + 1, cls = false, closed = false;
      for (; j < src.length && src[j] !== "\n"; j++) {
        if (src[j] === "\\") {
          j++;
          continue;
        }
        if (src[j] === "[") cls = true;
        else if (src[j] === "]") cls = false;
        else if (src[j] === "/" && !cls) {
          closed = true;
          break;
        }
      }
      if (closed) {
        for (let k = i + 1; k < j; k++) mask[k] = 0;
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return mask;
}

/** Keep only the regex matches whose start offset is real code. Pure. */
export function codeMatches(
  src: string,
  re: RegExp,
): RegExpMatchArray[] {
  const mask = codeMask(src);
  return [...src.matchAll(re)].filter((m) => mask[m.index!] === 1);
}

/** The source with every non-code span blanked to spaces (offsets and line
 *  breaks preserved). Use it for `.includes()`-style checks that must not fire
 *  on a mention inside a comment or a string — e.g. `"process.env"` written as
 *  a lint pattern is not a use of `process.env`. Pure. */
export function codeText(src: string): string {
  const mask = codeMask(src);
  let out = "";
  for (let i = 0; i < src.length; i++) {
    out += mask[i] === 1 || src[i] === "\n" ? src[i] : " ";
  }
  return out;
}
