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

/** One slot of an import/export `{…}` list — the text between two code
 *  commas (or a brace and a comma). */
export type ListEntry = {
  /** The slot's CODE, comments dropped and whitespace collapsed: `a`,
   *  `type A`, `a as b`. Empty for the slot after a trailing comma. */
  readonly text: string;
  /** The code span in the source: first char, one past the last. Both equal
   *  `slotStart` when `text` is empty. */
  readonly start: number;
  readonly end: number;
  /** The whole slot, separators excluded (comments and layout included). */
  readonly slotStart: number;
  readonly slotEnd: number;
};

/** A static `import … from "x"` / `export … from "x"` / `import "x"`. */
export type ModuleStatement = {
  readonly kind: "import" | "export";
  /** Offset of the `import`/`export` keyword. */
  readonly start: number;
  /** One past the closing quote of the specifier (a `;` is not included). */
  readonly end: number;
  /** `import type …` / `export type …` — erased before any bundler runs. */
  readonly typeOnly: boolean;
  /** The clause between the keyword (and `type`) and `from`, as code with
   *  comments blanked; "" for a side-effect `import "x"`. */
  readonly clause: string;
  readonly spec: string;
  readonly specStart: number;
  readonly specEnd: number;
  /** The `{…}` list, when the clause has one. */
  readonly list: {
    readonly open: number;
    readonly close: number;
    readonly entries: readonly ListEntry[];
  } | null;
};

/** A list slot's code as written: comments dropped and whitespace collapsed
 *  — except inside a quoted name (`"x-y" as xy`), whose body `codeText`
 *  blanked and is restored from `src` verbatim. `slot` is the slot's
 *  `codeText` with comment delimiters blanked; offsets are 1:1 with `src`. */
function entryText(src: string, slot: string, at: number): string {
  const quoted: string[] = [];
  let bare = "";
  for (let j = 0; j < slot.length; j++) {
    const q = slot[j]!;
    const close = q === '"' || q === "'" ? slot.indexOf(q, j + 1) : -1;
    if (close === -1) {
      bare += q;
      continue;
    }
    quoted.push(src.slice(at + j, at + close + 1));
    bare += "\0";
    j = close;
  }
  let k = 0;
  return bare.trim().replace(/\s+/g, " ").replace(/\0/g, () => quoted[k++]!);
}

/** Every static module statement of `src`, in source order, multi-line safe.
 *  Pure.
 *
 *  THE import-clause reader for aiol's rules and fixes. They each used to
 *  carry a one-line regex — `(?:import|export)\s+.*?\s+from` — and `.` never
 *  crosses a newline, so the multi-line import `deno fmt` itself writes for a
 *  long specifier list was invisible: the same `@std/fs` import was an ERROR on
 *  one line and silence on three. The fixes split `{…}` on every "," and
 *  re-joined it on ONE line, so a `// comment` after a specifier swallowed the
 *  rest of the statement (`} from "aio";` landed inside the comment) and
 *  --safe-fix left a file that no longer parsed.
 *
 *  The structure is matched on `codeText` (comments and string bodies
 *  blanked, offsets preserved), so a statement inside a comment or a
 *  generator's template literal is nothing, a comment inside a list is never
 *  a specifier, and a comma inside a comment never splits one. The clause is
 *  constrained to the shapes the grammar allows (`type`? default? `{…}` or
 *  `* as ns`), so a match can never run from one statement into the next. */
export function moduleStatements(src: string): ModuleStatement[] {
  const code = codeText(src);
  const out: ModuleStatement[] = [];
  const re =
    /\b(import|export)\b(?:\s*(type\b\s*)?((?:[\w$]+\s*,\s*)?(?:\{[^{}]*\}|\*(?:\s*as\s+[\w$]+)?|[\w$]+))\s*from)?\s*(['"])/g;
  for (const m of code.matchAll(re)) {
    const kind = m[1] as "import" | "export";
    const at = m.index!;
    if (code[at - 1] === "." || code[at - 1] === "$") continue; // `x.import`
    const clauseRaw = m[3];
    if (clauseRaw === undefined && kind === "export") continue; // not a form
    const q = at + m[0].length - 1;
    const specEnd = src.indexOf(src[q]!, q + 1);
    if (specEnd === -1 || src.slice(q + 1, specEnd).includes("\n")) continue;
    let list: ModuleStatement["list"] = null;
    const open = clauseRaw === undefined ? -1 : code.indexOf("{", at);
    if (open !== -1 && open < q) {
      const close = code.indexOf("}", open);
      const entries: ListEntry[] = [];
      let slotStart = open + 1;
      for (let i = open + 1; i <= close; i++) {
        if (code[i] !== "," && i !== close) continue;
        // Comment BODIES are already blank in `code`; their `//` `/*` `*/`
        // delimiters are not, and no `/` or `*` is legal inside a list.
        const slot = code.slice(slotStart, i).replace(/[/*]/g, " ");
        const lead = slot.length - slot.trimStart().length;
        const start = slotStart + (slot.trim() ? lead : 0);
        const end = slot.trim() ? slotStart + slot.trimEnd().length : start;
        entries.push({
          text: entryText(src, slot, slotStart),
          start,
          end,
          slotStart,
          slotEnd: i,
        });
        slotStart = i + 1;
      }
      list = { open, close, entries };
    }
    out.push({
      kind,
      start: at,
      end: specEnd + 1,
      typeOnly: m[2] !== undefined,
      clause: (clauseRaw ?? "").replace(/\/\/|\/\*|\*\//g, " ")
        .replace(/\s+/g, " ").trim(),
      spec: src.slice(q + 1, specEnd),
      specStart: q + 1,
      specEnd,
      list,
    });
  }
  return out;
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
    //
    // Comments between are skipped too: `{\n  // why\n  timeout: 5 }` is the
    // same key, and walking back over whitespace alone stopped on the comment's
    // last character — so a commented option was invisible to the rule (a
    // REMOVED option that throws at runtime, reported clean) and to the fix.
    // Comment bodies are mask 0; their `//` `/*` `*/` delimiters are code.
    let b = i - 1;
    for (;;) {
      while (b > open && (/\s/.test(src[b]!) || mask[b] !== 1)) b--;
      if (b > open + 1 && src[b] === "/" && src[b - 1] === "/") {
        b -= 2; // a line comment's opener
      } else if (b > open + 1 && src[b] === "/" && src[b - 1] === "*") {
        b -= 2; // a block comment's closer — walk to its opener
        while (b > open + 1 && !(src[b] === "*" && src[b - 1] === "/")) b--;
        b -= 2;
      } else break;
    }
    if (src[b] !== "{" && src[b] !== ",") continue;
    let a = i + key.length;
    while (a < src.length && /\s/.test(src[a]!)) a++;
    if (src[a] !== ":") continue;
    out.push(i);
  }
  return out;
}

/** The source span `[start, end)` of the `index`-th (0-based) argument of the
 *  call whose `(` sits at `paren`, or null when the call has fewer arguments.
 *  Nesting, strings, templates and comments are respected through
 *  `codeMask`. Pure — the locator a rule/fix uses to name an ARGUMENT instead
 *  of guessing one from a bare regex over the whole call. */
export function argumentSpan(
  src: string,
  paren: number,
  index: number,
): [number, number] | null {
  if (src[paren] !== "(") return null;
  const mask = codeMask(src);
  let depth = 0;
  let arg = 0;
  let start = paren + 1;
  for (let i = paren; i < src.length; i++) {
    if (mask[i] !== 1) continue; // string / comment / regex body
    const ch = src[i]!;
    if (ch === "(" || ch === "{" || ch === "[") {
      depth++;
      continue;
    }
    if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return arg === index ? [start, i] : null;
      continue;
    }
    if (ch === "," && depth === 1) {
      if (arg === index) return [start, i];
      arg++;
      start = i + 1;
    }
  }
  return null;
}
