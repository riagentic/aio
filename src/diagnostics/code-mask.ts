// code-mask.ts — "is this offset real code?" — THE decider, for every scanner
// in this repo that reads source with regexes instead of an AST.
//
// It walks the source once and marks every offset as code (1) or not-code (0):
// comment bodies and the *contents* of string / template / regex literals are
// 0, while the delimiters and surrounding code stay 1. **Offsets are preserved
// 1:1**, which is the whole point — a caller keeps matching against the
// ORIGINAL text and asks "was this in code?", so a line number computed from a
// match is the line the reader will see.
//
// It lives here, in dependency-free isomorphic code, because it was written
// TWICE. aiol got this version; `graph-validator.ts` hand-rolled
// `.replace(/\/\*[\s\S]*?\*\//g, "")`, which DELETES a block comment
// including its newlines, under a comment claiming "line count preserved —
// replacements are same-line". True of `//` comments, false of every JSDoc
// block: a field report measured 39 newlines destroyed in one 681-line file
// and a `// aio-ok: server-only` acknowledgement that could never be found,
// because the warning was reported 4 lines above the code it was about. Every
// file with JSDoc in it — which is most files — had an unreachable suppression.
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

/** The source with every non-code span blanked to spaces (offsets AND line
 *  breaks preserved). Use it for `.includes()`-style checks and for regex
 *  scans whose match position becomes a line number — e.g. `"process.env"`
 *  written as a lint pattern is not a use of `process.env`, and a `Deno.`
 *  inside a JSDoc example is not a call. Pure. */
export function codeText(src: string): string {
  const mask = codeMask(src);
  let out = "";
  for (let i = 0; i < src.length; i++) {
    out += mask[i] === 1 || src[i] === "\n" ? src[i] : " ";
  }
  return out;
}
