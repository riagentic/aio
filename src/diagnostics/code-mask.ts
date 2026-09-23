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
    if (c === "/" && regexStart(src, i)) {
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

/** Is the `/` at `i` the start of a REGEX literal rather than a division?
 *  The one rule, shared by this mask and `scripts/source-mask.ts`.
 *
 *  A previous-CHARACTER set alone read `return /x/` and `if (a) /x/` as
 *  division (the regex body then scanned as code — a quote or backtick in it
 *  derailed the rest of the file) and `b++ / 2` as a regex (blanking code), so
 *  it also knows expression keywords, statement heads and postfix `++`/`--`.
 *  Pinned case by case in tests/code-mask.test.ts. Pure. */
export function regexStart(src: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && (src[j] === " " || src[j] === "\t")) j--;
  if (j < 0) return true; // start of file
  const c = src[j]!;
  // A line start counts as "expression position" (ASI) — `/re/.test(x)` as
  // the first token of a line is a regex, never a division.
  if (c === "\n" || c === "\r") return true;
  // A WORD: a keyword that takes an expression (`return /x/`, `typeof /x/`,
  // `case /x/:`, `else /x/.test(s)`) is followed by one; any other word — a
  // name, a number, `this`, a member `.return` — is a value, so `/` divides.
  if (isWord(c)) {
    let k = j;
    while (k > 0 && isWord(src[k - 1]!)) k--;
    if (src[k - 1] === ".") return false;
    return EXPR_KEYWORDS.has(src.slice(k, j + 1));
  }
  // `)` ends a VALUE (`f(x) / 2`) unless it closes the head of an
  // `if`/`while`/`for`/`with`, after which a statement — a regex — may begin.
  if (c === ")") {
    const open = matchingOpen(src, j);
    if (open < 0) return false;
    let k = open - 1;
    while (k >= 0 && /\s/.test(src[k]!)) k--;
    const end = k;
    while (k >= 0 && isWord(src[k]!)) k--;
    return HEAD_KEYWORDS.has(src.slice(k + 1, end + 1)) && src[k] !== ".";
  }
  // Postfix `b++ / 2` and `b-- / 2`: the operand is complete, so it divides.
  // (A PREFIX `++` cannot precede a regex — it needs an assignable operand.)
  if ((c === "+" || c === "-") && src[j - 1] === c) return false;
  // `<` is NOT in this set: in a .tsx file the `/` after it is the start of a
  // closing tag (`</div>`), never a regex — and a `<` before a real regex
  // (`x < /re/.source.length`) has no counterpart in this tree.
  return "([{,;:=!&|?+-*%~^>".includes(c);
}

const isWord = (c: string): boolean => /[\w$]/.test(c);

/** Keywords after which an EXPRESSION starts (so `/` opens a regex). */
const EXPR_KEYWORDS: ReadonlySet<string> = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);
/** Statement heads whose `(…)` is followed by a statement, not a value. */
const HEAD_KEYWORDS: ReadonlySet<string> = new Set([
  "if",
  "while",
  "for",
  "with",
]);

/** The `(` matching the `)` at `j`, or -1. Brackets inside strings are rare
 *  enough in a condition that a plain depth count is the honest trade. */
function matchingOpen(src: string, j: number): number {
  let depth = 0;
  for (let k = j; k >= 0; k--) {
    if (src[k] === ")") depth++;
    else if (src[k] === "(" && --depth === 0) return k;
  }
  return -1;
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
