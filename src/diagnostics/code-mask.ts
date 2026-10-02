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
//
// JSX is opt-in (`jsx`). Without it the text an element shows is lexed as
// code, and prose is full of things that open a literal or a comment there: an
// apostrophe, the `//` of a URL, one backtick, `/*`. Each blanks the code that
// follows it on the line — a callback's parameter list, say — and a reader of
// the mask then misses a declaration. With `jsx`, a WHOLE element (its closing
// tag found, or self-closed) standing where an expression can start is read
// as JSX: its text is 0, its tags, attribute names and `{…}` containers stay
// code. Anything that does not parse as a whole element is lexed exactly as
// without the flag (`<T>(x: T) => x`, `<T>value`, `a < b` never close as an
// element). This is a lexer's best effort, not a parser: an old-style cast
// with its "closing tag" later in a comment or a string (`<Foo>bar; … //
// </Foo>`) reads as an element, and a tag it cannot parse leaves the text
// lexed as code. A reader that must not be wrong keeps its own guard.

/** Per-offset flags: 1 = real code, 0 = comment / string / template / regex
 *  body — and, with `jsx`, the text of a JSX element. Same length as `src`.
 *  Pure. */
export function codeMask(src: string, jsx = false): Uint8Array {
  if (jsx) return jsxRead(src).mask;
  const mask = new Uint8Array(src.length).fill(1);
  scanCode(src, mask, 0, null, false);
  return mask;
}

/** The JSX reading of `src`: its mask, and the offset of every closing tag
 *  (`</name>`, `</>`) that closed an element the reader took. A closing tag
 *  written anywhere else in the text is one the reader did not account for
 *  — the sign of an element it did not read. Pure. */
export function jsxRead(src: string): { mask: Uint8Array; closed: number[] } {
  const mask = new Uint8Array(src.length).fill(1);
  const jsx: Jsx = { failed: new Set(), closed: [] };
  scanCode(src, mask, 0, jsx, false);
  return { mask, closed: jsx.closed };
}

/** What a JSX reading keeps: the element starts already found not to be
 *  elements, and where each element read was closed. */
type Jsx = { failed: Set<number>; closed: number[] };

/** Lexes code from `i`, writing 0 over what is not code. `jsx` turns JSX
 *  reading on. `inBraces`:
 *  the code is a JSX `{…}` container — the scan returns the offset of the `}`
 *  that closes it, or -1 when nothing does. Otherwise it returns the end. */
function scanCode(
  src: string,
  mask: Uint8Array,
  i: number,
  jsx: Jsx | null,
  inBraces: boolean,
): number {
  let depth = 0;
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
      let [j, close] = literalEnd(src, i, true);
      // An interpolation that never closes is a lexing miss, not a verdict on
      // the template: fall back to the plain next-backtick scan (no `${…}`
      // awareness) — never to the first-newline cut, which read the rest of
      // a real multi-line template as code.
      if (close === -1 && c === "`") [j, close] = literalEnd(src, i, false);
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
      const j = regexEnd(src, i);
      if (j >= 0) {
        for (let k = i + 1; k < j; k++) mask[k] = 0;
        i = j + 1;
        continue;
      }
    }
    if (jsx) {
      if (c === "<") {
        const end = jsxElement(src, mask, i, jsx);
        if (end !== -1) {
          i = end;
          continue;
        }
      } else if (inBraces) {
        if (c === "{") depth++;
        else if (c === "}" && depth-- === 0) return i;
      }
    }
    i++;
  }
  return inBraces ? -1 : i;
}

/** Keywords after which an expression — so a JSX element — may start. */
const JSX_KEYWORDS: ReadonlySet<string> = new Set([
  "return",
  "yield",
  "default",
]);

/** What a tag or attribute name is made of: an identifier's characters —
 *  any script's letters, not ASCII's alone — and the `.` `:` `-` of a member,
 *  a namespace, a custom element. Asked one UTF-16 unit at a time, so a
 *  letter outside the basic plane is not taken: such a tag is not read. */
const NAME_START = /^[\p{ID_Start}_$]/u;
const TAG_CHAR = /[\p{ID_Continue}$.:-]/u;
const ATTRIBUTE = /^[\p{ID_Start}_$][\p{ID_Continue}$:-]*/u;

/** May the `<` at `i` open a JSX element? Only where an expression starts
 *  (after `(` `[` `{` `,` `=` `=>` `?` `:` `&&` `||` `??` `+` `!`, `return`,
 *  `yield`, `default`, or at the start of the text) and before a tag name or
 *  a fragment's `>`. After a name, a `)` or a literal it compares or opens a
 *  type-argument list: `a < b`, `f<T>(x)`, `x as Y<Z>`. Comments between
 *  the two are skipped — `mask` is already written up to `i`, so a comment
 *  is a blanked body behind `//`, or between a block comment's two ends. */
function jsxOpens(src: string, mask: Uint8Array, i: number): boolean {
  if (!NAME_START.test(src[i + 1] ?? "") && src[i + 1] !== ">") return false;
  let j = i - 1;
  for (;;) {
    while (j >= 0 && (mask[j] === 0 || /\s/.test(src[j]!))) j--;
    const two = j >= 1 ? src[j - 1]! + src[j]! : "";
    if (two === "//") j -= 2;
    else if (two === "*/") {
      j -= 2;
      while (j >= 0 && mask[j] === 0) j--;
      if (j < 1 || src[j] !== "*" || src[j - 1] !== "/") return false;
      j -= 2;
    } else break;
  }
  if (j < 0) return true;
  const c = src[j]!;
  if (isWord(c)) {
    let k = j;
    while (k > 0 && isWord(src[k - 1]!)) k--;
    return src[k - 1] !== "." && JSX_KEYWORDS.has(src.slice(k, j + 1));
  }
  if (c === ">") return src[j - 1] === "=";
  return "([{,=?:&|+!".includes(c);
}

/** The offset just past the JSX element (or fragment) opening at `lt`, with
 *  its text written 0 and its `{…}` containers lexed as code — or -1, with
 *  the mask left as it was, when no whole element stands there: the tag does
 *  not parse, the text holds a `>` or a `}` (never legal in JSX text), or
 *  the closing tag is missing or names another element. */
function jsxElement(
  src: string,
  mask: Uint8Array,
  lt: number,
  jsx: Jsx,
): number {
  const { failed } = jsx;
  if (failed.has(lt) || !jsxOpens(src, mask, lt)) return -1;
  let far = lt;
  const space = (j: number): number => {
    while (j < src.length && /\s/.test(src[j]!)) j++;
    return j;
  };
  /** Past the `{…}` container whose `{` is at `j`, or -1. */
  const braces = (j: number): number => {
    const close = scanCode(src, mask, j + 1, jsx, true);
    far = close === -1 ? src.length : Math.max(far, close);
    return close === -1 ? -1 : close + 1;
  };
  /** Past the `<…>` type-argument list opening at `j`, or -1: brackets
   *  balanced, the `>` of `=>` closing nothing, no string and no `;`. */
  const typeArguments = (j: number): number => {
    for (let depth = 0; j < src.length; j++) {
      const c = src[j]!;
      if ("<([{".includes(c)) depth++;
      else if (c === ">" && src[j - 1] === "=") continue;
      else if (">)]}".includes(c)) {
        if (--depth === 0) return j + 1;
      } else if ("\"'`;".includes(c)) return -1;
    }
    return -1;
  };
  const element = (at: number): number => {
    let j = at + 1;
    while (j < src.length && TAG_CHAR.test(src[j]!)) j++;
    const name = src.slice(at + 1, j);
    if (name !== "" && !NAME_START.test(name[0]!)) return -1;
    // Type arguments: `<List<Item> items={…}>`.
    if (name !== "" && src[j] === "<") {
      j = typeArguments(j);
      if (j === -1) return -1;
    }
    // The tag: attributes up to `>` or `/>`. A fragment has none.
    for (;;) {
      j = space(j);
      const c = src[j];
      // A comment between attributes.
      if (c === "/" && (src[j + 1] === "/" || src[j + 1] === "*")) {
        const line = src[j + 1] === "/";
        const close = src.indexOf(line ? "\n" : "*/", j + 2);
        if (close === -1) return -1;
        for (let k = j + 2; k < close; k++) mask[k] = 0;
        far = Math.max(far, close);
        j = close + (line ? 1 : 2);
        continue;
      }
      if (c === ">") {
        j++;
        break;
      }
      if (name === "" || c === undefined) return -1;
      if (c === "/" && src[j + 1] === ">") return j + 2;
      if (c === "{") {
        j = braces(j); // `{...spread}`
        if (j === -1) return -1;
        continue;
      }
      const attr = ATTRIBUTE.exec(src.slice(j, j + 200));
      if (!attr) return -1;
      j = space(j + attr[0].length);
      if (src[j] !== "=") continue;
      j = space(j + 1);
      const q = src[j];
      if (q === '"' || q === "'") {
        // An attribute string has no escapes and may span lines.
        const close = src.indexOf(q, j + 1);
        if (close === -1) return -1;
        for (let k = j + 1; k < close; k++) mask[k] = 0;
        far = Math.max(far, close);
        j = close + 1;
      } else if (q === "{") {
        j = braces(j);
        if (j === -1) return -1;
      } else if (q === "<") {
        j = element(j);
        if (j === -1) return -1;
      } else return -1;
    }
    // The children, up to this element's closing tag.
    for (;;) {
      const c = src[j];
      if (c === undefined || c === ">" || c === "}") return -1;
      if (c === "{") {
        j = braces(j);
        if (j === -1) return -1;
      } else if (c === "<" && src[j + 1] === "/") {
        const from = space(j + 2);
        let k = from;
        while (k < src.length && TAG_CHAR.test(src[k]!)) k++;
        if (src.slice(from, k) !== name) return -1;
        k = space(k);
        if (src[k] !== ">") return -1;
        jsx.closed.push(j);
        return k + 1;
      } else if (c === "<") {
        j = element(j);
        if (j === -1) return -1;
      } else {
        // Text: what the element shows. Its line breaks and indentation
        // stay as they are.
        if (!/\s/.test(c)) mask[j] = 0;
        far = Math.max(far, j);
        j++;
      }
    }
  };
  // What closed inside an element that then fails is forgotten with it: its
  // text is lexed as code after all.
  const closedBefore = jsx.closed.length;
  const end = element(lt);
  if (end === -1) {
    jsx.closed.length = closedBefore;
    mask.fill(1, lt, Math.min(src.length, far + 1));
    failed.add(lt);
  }
  return end;
}

/** `[stop, close]` for the string / template literal opening at `i`: `close`
 *  is its closing delimiter's offset, or -1 with `stop` where the scan gave
 *  up (a `'`/`"` stops at an unescaped newline). `interp` skips `${…}` whole. */
function literalEnd(
  src: string,
  i: number,
  interp: boolean,
): [number, number] {
  const c = src[i];
  let j = i + 1;
  for (; j < src.length; j++) {
    if (src[j] === "\\") {
      j++; // the escaped char is body, never a delimiter
      continue;
    }
    // `${…}` may hold its own strings and templates — a backtick in there
    // is not this literal's close. Still all template content (above).
    if (interp && c === "`" && src[j] === "$" && src[j + 1] === "{") {
      j = interpolationEnd(src, j + 2);
      if (j < 0) return [src.length, -1];
      continue;
    }
    if (src[j] === c) return [j, j];
    if (c !== "`" && src[j] === "\n") break;
  }
  return [j, -1];
}

/** The offset of the `}` closing a template interpolation whose body starts
 *  at `i`, or -1 when it never closes. The body is CODE and is lexed as such:
 *  strings, nested templates, comments and regex literals are skipped whole,
 *  so the quote in `/'/g` or `// it's` and the brace in `"}"` do not count. */
function interpolationEnd(src: string, i: number): number {
  for (let depth = 1; i < src.length; i++) {
    const c = src[i]!;
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
    else if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      if (i < 0) return -1;
    } else if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2) + 1;
      if (i === 0) return -1;
    } else if (c === "/" && regexStart(src, i)) {
      const end = regexEnd(src, i);
      if (end >= 0) i = end;
    } else if (c === '"' || c === "'" || c === "`") {
      i = literalEnd(src, i, true)[1];
      if (i < 0) return -1;
    }
  }
  return -1;
}

/** The offset of the `/` closing the regex literal opening at `i` — same
 *  line, `[…]` classes respected — or -1. */
function regexEnd(src: string, i: number): number {
  let cls = false;
  for (let j = i + 1; j < src.length && src[j] !== "\n"; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === "[") cls = true;
    else if (src[j] === "]") cls = false;
    else if (src[j] === "/" && !cls) return j;
  }
  return -1;
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
export function codeText(src: string, jsx = false): string {
  const mask = codeMask(src, jsx);
  let out = "";
  for (let i = 0; i < src.length; i++) {
    out += mask[i] === 1 || src[i] === "\n" ? src[i] : " ";
  }
  return out;
}
