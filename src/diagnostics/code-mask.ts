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
    //
    // The CLOSING delimiter is found FIRST, so an UNTERMINATED literal can be
    // handled as what it almost always is: a quote character in prose. It
    // blanks to the end of its line and no further.
    //
    // That bail existed for `'` and `"` (one apostrophe in `it's fine` must not
    // swallow the next line) and NOT for `` ` ``, whose literals may legally
    // cross lines. So one stray backtick — `press \` to search` in JSX copy —
    // blanked the mask from there to END OF FILE, and every rule that reads
    // masked code stopped firing for the rest of the file: silently, with no
    // output to notice, error-severity security rules included. Same bail now,
    // one spelling, all three delimiters; a TERMINATED template literal still
    // spans as many lines as it likes.
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let close = -1;
      for (; j < src.length; j++) {
        if (src[j] === "\\") {
          j++; // the escaped char is body, never a delimiter
          continue;
        }
        if (src[j] === c) {
          close = j;
          break;
        }
        if (c !== "`" && src[j] === "\n") break;
      }
      if (close === -1) {
        // Unterminated. For `'` / `"` the scan already stopped at the first
        // unescaped newline, and `j` is exactly where the old lexer stopped —
        // so a real line continuation (`"a\<newline>b"`) still spans, byte for
        // byte as before. A template literal has no such stop, so its bail is
        // the first newline outright: that is the whole point.
        const stop = c === "`"
          ? (src.indexOf("\n", i + 1) === -1
            ? src.length
            : src.indexOf("\n", i + 1))
          : j;
        for (let k = i + 1; k < stop; k++) mask[k] = 0;
        i = stop === src.length ? src.length : stop;
        continue;
      }
      for (let k = i + 1; k < close; k++) mask[k] = 0;
      i = close + 1;
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
