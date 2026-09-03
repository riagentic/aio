#!/usr/bin/env -S deno run --allow-read
// check-vacuous.ts — the vacuous-test detector.
//
// A red test proves a bug exists. A GREEN test proves nothing at all unless
// its assertions actually ran, on the value they claim to be about. Eight
// separate audits of this repo in one week found green tests that proved
// nothing, and every one of them had the same handful of shapes:
//
//   • an assertion inside `for (const x of xs)` where `xs` was empty — the
//     body never executed and the test was a no-op. (A vdom test looped
//     `if (nodeName === "B")` for the very element the bug DELETED; a
//     virtual-list test asserting "clamps to available items" iterated an
//     empty collection.)
//   • `assert(err.length > 0)` — true of every non-empty string, including
//     one that says nothing about the failure it is supposed to describe.
//   • `assertEquals(await f(x), await f(x))` — the function compared against
//     itself. It passed for ANY deterministic implementation, and it was
//     guarding sha256, the integrity primitive of the whole release system.
//   • `assert(typeof api.thing === "function")` — proves the export exists,
//     never that it does anything.
//   • `try { assertEquals(...) } catch {}` — passes whether the assertion
//     holds, fails, or the code under test throws before reaching it.
//   • a `Deno.test` body with no assertion in it at all.
//
// These are STATIC shapes, so they are statically detectable. This is that
// detector.
//
// It is a LEDGER THAT ONLY SHRINKS, like `tests/one-fact-one-spelling.test.ts`
// and `scripts/check-silent-catch.ts`: the offenders that existed the day it
// landed are frozen in `LEDGER` so it could go green immediately, and:
//
//   • a NEW offender — any shape above in a test not on the ledger — is RED,
//     reported with file:line and the rule it broke.
//   • an offender that has been FIXED is also RED, telling you to delete its
//     ledger line. A ratchet allowed to sit above the real count is a ceiling,
//     and a ceiling rots.
//
// Being on the ledger is not absolution. It is a debt with your name on it.
//
//   deno task check:vacuous              report (exit 1 if the ledger moved)
//   deno task check:vacuous --all        list every offender, ledger included
//   deno task check:vacuous --print-ledger   paste-ready regenerated ledger
//
// A shape that is genuinely fine — an assertion in a loop whose collection is
// proven non-empty by construction three calls earlier, say — is silenced in
// place with the repo's existing acknowledgement convention, on the offending
// line or the one above it:
//
//     // aio-ok: `targets` is the literal array two lines up.
//
// …which is a claim a reviewer can check, unlike a ledger entry nobody reads.

/** Rules, in the order they are reported. */
export type Rule =
  | "empty-loop"
  | "nonempty-string"
  | "typeof-function"
  | "self-comparison"
  | "swallowing-try"
  | "no-assertions";

export type Offender = {
  rule: Rule;
  file: string;
  line: number;
  test: string;
  detail: string;
};

/** `<rule>|<file>|<test name>` — the key is deliberately line-free so that
 *  moving a test around does not churn the ledger. */
export const key = (o: Offender): string => `${o.rule}|${o.file}|${o.test}`;

// ─── source masking ────────────────────────────────────────────────────────
// Every structural rule below runs over a copy of the source in which string
// literals, template literals, regexes and comments have been replaced by
// spaces of the SAME length. Offsets therefore still line up with the
// original, and a `for (const x of xs)` written inside a doc comment or an
// assertion message can never be mistaken for code.

/** Is the `/` at `i` the start of a REGEX literal rather than division?
 *
 *  The classic ambiguity, resolved the classic way: look back at the previous
 *  meaningful character. After a value (identifier, `)`, `]`, digit) a `/` is
 *  division; after an operator, a comma, an opening bracket or a keyword it
 *  begins a literal. Biased toward "regex" on a tie, because guessing regex on
 *  a division blanks a short arithmetic span and costs nothing, while guessing
 *  division on a regex is the bug this exists to fix. */
function _regexStart(src: string, i: number): boolean {
  let k = i - 1;
  while (k >= 0 && /\s/.test(src[k]!)) k--;
  if (k < 0) return true;
  const p = src[k]!;
  // No `<`: `</div>` in a .test.tsx file is a closing tag, not a regex.
  if ("=(,:[!&|?{};+-*%~^>".includes(p)) return true;
  // `return /re/`, `typeof /re/`, `case /re/` … — a keyword, not a value.
  const word = /[A-Za-z_$][\w$]*$/.exec(src.slice(0, k + 1))?.[0];
  return word !== undefined &&
    [
      "return",
      "typeof",
      "case",
      "in",
      "of",
      "new",
      "delete",
      "void",
      "throw",
      "do",
      "else",
      "yield",
      "await",
    ]
      .includes(word);
}

export function mask(src: string): string {
  const out = src.split("");
  let i = 0;
  const n = src.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      const e = src.indexOf("\n", i);
      const end = e === -1 ? n : e;
      blank(i, end);
      i = end;
    } else if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e === -1 ? n : e + 2;
      blank(i, end);
      i = end;
    } else if (c === "/" && _regexStart(src, i)) {
      // A REGEX LITERAL, blanked like a string — because its CONTENTS can hold
      // a quote or a backtick, and treating one of those as a string opener
      // swallows everything after it. `/["'`]/` did exactly that: the backtick
      // opened a phantom template literal that ran to the next backtick in the
      // file, hiding the assertion below it, and the test was reported as
      // proving nothing. (The apostrophe half of this was fixed once already;
      // this is the same hole one character wider.)
      let k = i + 1;
      let inClass = false;
      while (k < n) {
        const ch = src[k]!;
        if (ch === "\\") {
          k += 2;
          continue;
        }
        if (ch === "\n") break; // unterminated — it was division after all
        if (inClass) {
          if (ch === "]") inClass = false;
        } else if (ch === "[") inClass = true;
        else if (ch === "/") break;
        k++;
      }
      blank(i + 1, k);
      i = Math.min(k + 1, n);
    } else if (c === '"' || c === "'" || c === "`") {
      let k = i + 1;
      while (k < n) {
        if (src[k] === "\\") k += 2;
        else if (src[k] === c) break;
        else k++;
      }
      blank(i + 1, k);
      i = Math.min(k + 1, n);
    } else i++;
  }
  return out.join("");
}

/** Forward brace/paren match from the index of an opening delimiter. */
function matchAt(masked: string, open: number): number {
  const o = masked[open]!;
  const c = o === "(" ? ")" : o === "{" ? "}" : "]";
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === o) depth++;
    else if (ch === c && --depth === 0) return i;
  }
  return masked.length;
}

const lineOf = (src: string, idx: number): number =>
  src.slice(0, idx).split("\n").length;

/** The acknowledgement marker, spelled the way the rest of the repo spells
 *  it (`scripts/check-silent-catch.ts`, `src/server/graph-validator.ts`). */
const JUSTIFIED = /\baio-ok\b\s*[:\-—]\s*\S/;

/** True when the offending line, or the line above it, carries `aio-ok: …`. */
function justified(src: string, idx: number): boolean {
  const lines = src.slice(0, idx).split("\n");
  const cur = src.split("\n")[lines.length - 1] ?? "";
  const prev = lines[lines.length - 2] ?? "";
  return JUSTIFIED.test(cur) || JUSTIFIED.test(prev);
}

// ─── test blocks ───────────────────────────────────────────────────────────

export type Block = { name: string; start: number; end: number };

/** Every `Deno.test(...)` call in a file, as an offset range. */
export function blocks(src: string): Block[] {
  const m = mask(src);
  const out: Block[] = [];
  const re = /\bDeno\.test\s*\(/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(m))) {
    const open = hit.index + hit[0].length - 1;
    // A regex literal holding an unbalanced paren would run the match past the
    // end of the block and swallow every test after it, silently reattributing
    // their offenders. The next `Deno.test(` is a hard stop.
    const next = m.slice(open + 1).search(/\bDeno\.test\s*\(/);
    const limit = next === -1 ? m.length : open + 1 + next;
    const end = Math.min(matchAt(m, open), limit);
    const head = src.slice(open, Math.min(open + 400, end));
    const name = /^\(\s*["'`]([^"'`]*)/.exec(head)?.[1] ??
      /name\s*:\s*["'`]([^"'`]*)/.exec(head)?.[1] ??
      /^\(\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(head)?.[1] ??
      "<anonymous>";
    out.push({ name, start: open, end });
    re.lastIndex = end;
  }
  return out;
}

const ASSERT = /\bassert[A-Za-z]*\s*\(|\bexpect[A-Za-z]*\s*\(|\bfail\s*\(/;
const ASSERT_G = /\bassert[A-Za-z]*\s*\(|\bexpect[A-Za-z]*\s*\(|\bfail\s*\(/g;

/** The base identifier of an iterated expression: `a.b.c()` → `a`. */
const base = (expr: string): string =>
  /^[A-Za-z_$][\w$]*/.exec(expr.trim())?.[0] ?? "";

// ─── the rules ─────────────────────────────────────────────────────────────

function scanBlock(
  file: string,
  src: string,
  m: string,
  b: Block,
  push: (o: Offender) => void,
): void {
  const body = m.slice(b.start, b.end);
  // The masked copy is right for STRUCTURE and wrong for IDENTITY: masking
  // turns `f("app-a")` and `f("app-b")` into the same text. Rules that ask
  // "is this the same computation?" read the original.
  const raw = src.slice(b.start, b.end);
  const at = (i: number) => b.start + i;
  const add = (rule: Rule, i: number, detail: string) => {
    if (justified(src, at(i))) return;
    push({ rule, file, line: lineOf(src, at(i)), test: b.name, detail });
  };

  // ── no-assertions: the whole block asserts nothing.
  //    A guarded `throw` is an assertion written longhand — `if (!x) throw new
  //    Error("…")` can fail on exactly the same input `assert(x)` can, and is
  //    the natural spelling when the check loops over the parts a message must
  //    contain. Only an UNguarded body (nothing that can decide to fail) is
  //    vacuous.
  const GUARDED_THROW =
    /\bif\s*\([\s\S]{0,200}?\)[\s\S]{0,120}?\bthrow\s+new\s+\w*Error\s*\(/;
  if (!ASSERT.test(body) && !GUARDED_THROW.test(body)) {
    add(
      "no-assertions",
      0,
      "the test body contains no assertion — it can only fail by throwing",
    );
  }

  // ── empty-loop: an assertion inside a loop over a collection that is never
  //    proven non-empty. If the collection is empty the body never runs and
  //    the test passes having checked nothing.
  const loops = [
    // for (const x of xs) / for await (const x of xs)
    /\bfor\s*(?:await\s+)?\(\s*(?:const|let|var)\s+[^;()]*?\bof\s+([^;)]+?)\s*\)/g,
    // xs.forEach(…) / xs.map(…) with an assertion inside the callback
    /([A-Za-z_$][\w$.\[\]]*)\s*\.\s*(?:forEach|map)\s*\(/g,
    // for (let i = 0; i < xs.length; i++)
    /\bfor\s*\(\s*(?:let|var)\s+\w+\s*=\s*0\s*;\s*\w+\s*<\s*([A-Za-z_$][\w$.\[\]]*)\.length/g,
  ];
  for (const re of loops) {
    let hit: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((hit = re.exec(body))) {
      const coll = (hit[1] ?? "").trim();
      const id = base(coll);
      if (!id) continue;
      // Body of the loop: the next `{` (or the callback's `{`) after the head.
      const after = hit.index + hit[0].length;
      const brace = body.indexOf("{", after);
      if (brace === -1 || brace - after > 60) continue;
      // For `xs.map(` / `xs.forEach(` the brace must be the CALLBACK's own
      // block. Without this, `push(a.map(String).join(" "));` followed a few
      // characters later by an unrelated `try {` reads as a loop whose body is
      // that try block — and every assertion inside it gets blamed on a `map`
      // that never had a callback at all.
      const between = body.slice(after, brace);
      if (
        /\.\s*(?:forEach|map)\s*\($/.test(hit[0]) &&
        !/(?:=>|\bfunction\b[^)]*\))\s*$/.test(between)
      ) continue;
      const close = matchAt(body, brace);
      const inner = body.slice(brace, close);
      if (!ASSERT.test(inner)) continue;
      // Proof that the collection is non-empty. Any of:
      //   • an assertion naming `<coll>.length` / `.size` anywhere in the test
      //   • an assertion on a counter after the loop (`assertEquals(seen, 3)`)
      //   • the collection is a literal array/entries of a literal
      const nonEmpty = new RegExp(
        `\\bassert[A-Za-z]*\\s*\\([^;]{0,200}\\b${
          id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        }\\b[\\w$.\\[\\]()]*\\.(length|size)\\b`,
      );
      const counter =
        /\bassert[A-Za-z]*\s*\(\s*(seen|count|found|hits|calls|n|total|ran|matched)\b/;
      // `assertEquals(xs.map(f), ["a", "b"])` proves `xs` non-empty just as
      // well as an assertion on its length does.
      const vsLiteral = new RegExp(
        `\\bassert[A-Za-z]*\\s*\\([^;]{0,300}\\b${
          id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        }\\b[^;]{0,300}?\\[\\s*[^\\]\\s]`,
      );
      if (
        nonEmpty.test(body) || vsLiteral.test(body) ||
        counter.test(body.slice(close)) || boundToLiteral(coll, m)
      ) continue;
      add(
        "empty-loop",
        hit.index,
        `assertion inside a loop over \`${coll}\`, which is never proven ` +
          `non-empty — if it is empty the assertion never runs. Assert its ` +
          `length first, or count the iterations and assert the count.`,
      );
    }
  }

  // ── nonempty-string: `assert(err.length > 0)` — true of every non-empty
  //    string, including a constant that describes nothing.
  {
    const re =
      /\bassert[A-Za-z]*\s*\(\s*([A-Za-z_$][\w$.\[\]()]*)\s*\.\s*length\s*(?:>\s*0|>=\s*1|!==\s*0)/g;
    let hit: RegExpExecArray | null;
    while ((hit = re.exec(body))) {
      const name = hit[1]!;
      if (
        !/err|msg|message|out|stderr|stdout|text|output|log|reason|hint|warn|detail|body|content/i
          .test(name)
      ) continue;
      const id = base(name);
      // …unless it is an ARRAY. `out.length > 0` on a string is true of every
      // non-empty string; on a collection it is the claim "something was
      // found", which is the whole point of the test. Only the declaration in
      // this block can tell them apart.
      const arrayDecl = new RegExp(
        `\\b(?:const|let|var)\\s+${id}\\s*(?::\\s*[^=;]*(?:\\[\\]|Array<[^;=]*>)\\s*)?=\\s*(?:\\[|new\\s+Array\\b)`,
      );
      if (arrayDecl.test(body)) continue;
      // …unless the test goes on to say what it must CONTAIN. Then the
      // non-emptiness is a precondition, not the whole claim.
      const contentChecked = new RegExp(
        `\\bassert[A-Za-z]*\\s*\\([^;]{0,200}\\b${id}\\b\\s*(\\[|\\.(some|find|filter|join|includes|map|at)\\b)`,
      );
      if (contentChecked.test(body)) continue;
      add(
        "nonempty-string",
        hit.index,
        `\`${name}.length > 0\` passes for ANY non-empty string. Assert what ` +
          `the message must SAY (assertStringIncludes) — the reason it is ` +
          `worth producing at all.`,
      );
    }
  }

  // ── typeof-function: proves an export exists, never that it works.
  {
    const re =
      /\bassert[A-Za-z]*\s*\(\s*typeof\s+([\w$.\[\]"'`]+)\s*===\s*["'`]function["'`]/g;
    let hit: RegExpExecArray | null;
    while ((hit = re.exec(body))) {
      add(
        "typeof-function",
        hit.index,
        `\`typeof ${hit[1]} === "function"\` proves the symbol is exported ` +
          `and nothing else. Call it and assert what it returns or does.`,
      );
    }
  }

  // ── self-comparison: the function under test compared against itself.
  {
    const re = /\bassert(?:Equals|StrictEquals|NotEquals)\s*\(/g;
    let hit: RegExpExecArray | null;
    while ((hit = re.exec(body))) {
      const open = hit.index + hit[0].length - 1;
      const close = matchAt(body, open);
      const args = splitArgs(raw.slice(open + 1, close));
      if (args.length < 2) continue;
      const a = norm(args[0]!), c = norm(args[1]!);
      if (!a || !c) continue;
      // A shared call counts only when it is the SAME call — same callee AND
      // the same argument text. `strip(plain)` vs `strip(colored)` compares
      // two different things through one helper and is perfectly sound;
      // `sha256Hex(bin("abc"))` on both sides compares nothing at all.
      const shared = [...callTexts(a)].filter((t) =>
        callTexts(c).has(t) && !SAFE_BOTH_SIDES.has(calleeOf(t))
      );
      if (a === c) {
        add(
          "self-comparison",
          hit.index,
          `both sides of the assertion are the same expression \`${
            a.slice(0, 60)
          }\` — it holds for any implementation.`,
        );
      } else if (shared.length > 0) {
        add(
          "self-comparison",
          hit.index,
          `\`${
            shared[0]!.slice(0, 60)
          }\` appears on BOTH sides — the function is compared against ` +
            `itself, so the assertion holds for any deterministic ` +
            `implementation. Compare against a literal expected value.`,
        );
      }
    }
  }

  // ── swallowing-try: an assertion in a `try` whose `catch` does nothing.
  //    The test passes whether the assertion holds, fails, or the code under
  //    test throws before ever reaching it.
  {
    const re = /\btry\s*\{/g;
    let hit: RegExpExecArray | null;
    while ((hit = re.exec(body))) {
      const open = hit.index + hit[0].length - 1;
      const close = matchAt(body, open);
      const tryBody = body.slice(open, close);
      const rest = body.slice(close);
      const cm = /^\s*\}?\s*catch\s*(?:\([^)]*\))?\s*\{/.exec(rest);
      if (!cm) continue;
      const cOpen = close + cm[0].length - 1;
      const cBody = body.slice(cOpen + 1, matchAt(body, cOpen));
      const catchActs = /\b(assert|expect|fail)[A-Za-z]*\s*\(|\bthrow\b|=/
        .test(cBody);
      if (!/\bassert[A-Za-z]*\s*\(/.test(tryBody) || catchActs) continue;
      add(
        "swallowing-try",
        hit.index,
        `the assertions in this \`try\` are cancelled by a \`catch\` that ` +
          `does nothing — the test passes whether they hold, fail, or are ` +
          `never reached.`,
      );
    }
  }
}

/** Calls whose appearance on both sides of an equality is normal and says
 *  nothing about the subject: they are transports, not the thing under test. */
const SAFE_BOTH_SIDES = new Set([
  "String",
  "Number",
  "Boolean",
  "BigInt",
  "Array",
  "Object",
  "Set",
  "Map",
  "JSON",
  "parse",
  "stringify",
  "join",
  "split",
  "trim",
  "map",
  "filter",
  "sort",
  "slice",
  "at",
  "get",
  "keys",
  "values",
  "entries",
  "from",
  "of",
  "toString",
  "replace",
  "replaceAll",
  "concat",
  "flat",
  "push",
  "includes",
  "indexOf",
  "length",
  "Date",
  "URL",
  "RegExp",
  "Error",
]);

/** `f(a, b)` → the whole call text, for every call in an expression. Used to
 *  decide whether two sides of an equality are the same computation. */
function callTexts(expr: string): Set<string> {
  const out = new Set<string>();
  for (const m of expr.matchAll(/([A-Za-z_$][\w$.]*)\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const end = matchAt(expr, open);
    if (end >= expr.length && expr[expr.length - 1] !== ")") continue;
    out.add(norm(expr.slice(m.index!, end + 1)));
  }
  return out;
}

const calleeOf = (call: string): string =>
  /([A-Za-z_$][\w$]*)\s*\($/.exec(call.slice(0, call.indexOf("(") + 1))?.[1] ??
    "";

/** True when the iterated expression bottoms out in a NON-EMPTY literal that
 *  is right there in the file — `const TABLE = [ … ]`, `Object.entries(SPEC)`
 *  where SPEC is such a const, or an inline array. A table written in the test
 *  cannot silently become empty; a collection derived at runtime can, and that
 *  is the whole bug class. */
function boundToLiteral(coll: string, masked: string): boolean {
  if (/^\[\s*[^\]\s]/.test(coll.trim())) return true;
  const m = /^(?:Object\.(?:entries|keys|values)\s*\(\s*)?([A-Za-z_$][\w$]*)/
    .exec(coll.trim());
  const id = m?.[1];
  if (!id) return false;
  const decl = new RegExp(`\\b(?:const|let|var)\\s+${id}\\b`).exec(masked);
  if (!decl) return false;
  // Skip the type annotation, which may itself contain `[`, `{` and `=>`:
  // walk to the first top-level `=` that is not `=>`, `==` or `!=`.
  let i = decl.index + decl[0].length, depth = 0;
  for (; i < masked.length; i++) {
    const c = masked[i]!;
    if ("([{<".includes(c)) depth++;
    else if (")]}>".includes(c)) depth--;
    else if (c === ";" && depth <= 0) return false;
    else if (
      c === "=" && depth <= 0 && masked[i + 1] !== ">" && masked[i + 1] !== "="
    ) break;
  }
  const open = masked.slice(i + 1).search(/\S/) + i + 1;
  const ch = masked[open];
  if (ch !== "[" && ch !== "{") return false;
  return /\S/.test(masked.slice(open + 1, matchAt(masked, open)));
}

/** Top-level comma split of an argument list (already masked). */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0, last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(s.slice(last, i));
      last = i + 1;
    }
  }
  out.push(s.slice(last));
  return out;
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

// ─── the scan ──────────────────────────────────────────────────────────────

export const TEST_ROOTS = ["tests", "amui/src"];

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) yield* walk(p);
    else if (/\.test\.tsx?$/.test(e.name)) yield p;
  }
}

/** Every offender in the repo, sorted by file then line. */
export async function scan(root: string): Promise<Offender[]> {
  const out: Offender[] = [];
  for (const r of TEST_ROOTS) {
    let ok = true;
    try {
      ok = (await Deno.stat(`${root}${r}`)).isDirectory;
    } catch {
      ok = false;
    }
    if (!ok) continue;
    for await (const f of walk(`${root}${r}`)) {
      const rel = f.slice(root.length);
      const src = await Deno.readTextFile(f);
      const m = mask(src);
      for (const b of blocks(src)) {
        scanBlock(rel, src, m, b, (o) => out.push(o));
      }
    }
  }
  return out.sort((a, c) =>
    a.file === c.file ? a.line - c.line : a.file < c.file ? -1 : 1
  );
}

// ─── the ledger ────────────────────────────────────────────────────────────
//
// Frozen on the day the detector landed. It may ONLY get shorter. Every line
// is a green test that proves less than it claims; deleting one means going
// and making that test real.

export const LEDGER: readonly string[] = [
  "no-assertions|tests/aio-run.test.ts|buildOnPerf: no-op when tt.entries is empty",
  "no-assertions|tests/aio33-state-integrity.test.ts|state integrity: captures initial shape on first call",
  "no-assertions|tests/aio33-state-integrity.test.ts|state integrity: detects missing key without crashing",
  "no-assertions|tests/aio33-state-integrity.test.ts|state integrity: skips non-object states",
  "no-assertions|tests/aio33-state-integrity.test.ts|state integrity: reset clears initial shape",
  "empty-loop|tests/air-conformance.test.ts|conformance: keyed list — 50 random rounds keep DOM order, count, and node identity",
  "empty-loop|tests/alpha52-surface.test.ts|server-only symbols: ONE set drives the graph validator (incl. the alpha52 db additions)",
  "empty-loop|tests/am-pin-preflight.test.ts|preflight: every cell-config removal can be detected in real source",
  "empty-loop|tests/am-process-safety.test.ts|#7 kill --stale: every aio lock dir is read, not only this scope",
  "empty-loop|tests/android-version.test.ts|android template: the generated constant matches the source directory",
  "empty-loop|tests/android-version.test.ts|build-android substitutes both version placeholders",
  "no-assertions|tests/app-dirs.test.ts|writeAppMeta: a read-only home never fails a boot",
  "no-assertions|tests/app-dirs.test.ts|sweepAppPayloadDir: a never-unpacked app is not an error",
  "empty-loop|tests/app-theme.test.ts|theme: every shadow token is a value box-shadow can take",
  "no-assertions|tests/audit-regression/compact-boundary.test.ts|compact skips when op count below threshold",
  "no-assertions|tests/auth-client.test.ts|authClient: requestReset never throws / never enumerates",
  "empty-loop|tests/auth-fuzz.test.ts|auth fuzz: the account state machine, seeded, against a real server",
  "empty-loop|tests/auth-fuzz.test.ts|auth fuzz: the account state machine, seeded, against a real server",
  "empty-loop|tests/auth-fuzz.test.ts|auth fuzz: the account state machine, seeded, against a real server",
  "empty-loop|tests/auth-fuzz.test.ts|auth fuzz: the account state machine, seeded, against a real server",
  "empty-loop|tests/auth-fuzz.test.ts|auth fuzz: the account state machine, seeded, against a real server",
  "empty-loop|tests/blobs.test.ts|blobs: delete removes bytes + metadata; list reflects it",
  "empty-loop|tests/browser-ack.test.ts|2.2: _rejectAllPending rejects all in-flight acks",
  "no-assertions|tests/browser-air.test.ts|browser-air: ensureConnected is idempotent",
  "no-assertions|tests/browser-subscribe.test.ts|subscribe: _useAioSubscribe wraps _subscribe (listener count tracks)",
  "no-assertions|tests/browser-subscribe.test.ts|subscribe: transient gap recovery — cleanup cancelled within 300ms",
  "no-assertions|tests/browser-subscribe.test.ts|subscribe: timer resets on rapid unsub/resub cycles",
  "no-assertions|tests/browser-subscribe.test.ts|subscribe: post-teardown resubscribe works cleanly",
  "no-assertions|tests/browser-subscribe.test.ts|subscribe: unsubscribe does NOT immediately null state (regression)",
  "empty-loop|tests/build-e2e.test.ts|fleet: ",
  "empty-loop|tests/build-flags.test.ts|scaffold: ",
  "empty-loop|tests/build-flags.test.ts|scaffold: the build/compile tasks use flags the FLEET understands",
  "empty-loop|tests/build-platforms.test.ts|platforms: every entry is a real deno compile triple shape",
  "empty-loop|tests/build-platforms.test.ts|platforms: only deno-compile targets may cross-compile",
  "empty-loop|tests/build-platforms.test.ts|compileArgs: every platform",
  "empty-loop|tests/build-platforms.test.ts|build-all: cross-compiled artifact names are recognised",
  "empty-loop|tests/build-platforms.test.ts|v8FlagsArg: a malformed entry is refused, never silently dropped",
  "empty-loop|tests/build.test.ts|build-all: an artifact",
  "empty-loop|tests/build.test.ts|build-all: every target has a valid, non-conflicting flag set",
  "empty-loop|tests/build.test.ts|android manifest: the template asks for the cleartext decision",
  "empty-loop|tests/capabilities.test.ts|scanCapabilities: the *Sync spellings count — every scanned FS API, both ways",
  "empty-loop|tests/capabilities.test.ts|capabilities: the scanned-API list and the read/write regexes agree",
  "no-assertions|tests/cell-machine.test.ts|valid: simple 2-state machine",
  "no-assertions|tests/cell-machine.test.ts|valid: 3-state cycle",
  "no-assertions|tests/cell-machine.test.ts|valid: complex multi-state with branching",
  "no-assertions|tests/cell-machine.test.ts|valid: foreign action with colon skips actionKeys check",
  "no-assertions|tests/cell-workers.test.ts|worker cells: a supported cell passes validation",
  "no-assertions|tests/cli-ack-contract.test.ts|cli bind: close() gives the cell definitions back (rebindable)",
  "no-assertions|tests/config-enum-values.test.ts|every documented ui.theme value actually boots",
  "no-assertions|tests/config-validation.test.ts|validateConfig: accepts all valid AioConfig keys",
  "no-assertions|tests/config-validation.test.ts|validateConfig: accepts all valid CellsConfig keys",
  "no-assertions|tests/config-validation.test.ts|validateConfig: accepts all valid UiConfig keys",
  "empty-loop|tests/cron-differential-fuzz.test.ts|fuzz: nextCronTime matches an independent constructive reference",
  "no-assertions|tests/db-cell-collision.test.ts|db: a table with a non-colliding name boots fine",
  "empty-loop|tests/db-worker-include.test.ts|aio/build exports dbWorkerInclude — the include args, not folklore",
  "no-assertions|tests/db.test.ts|db: close resolves without error",
  "no-assertions|tests/db.test.ts|db: double close does not throw",
  "no-assertions|tests/db.test.ts|db: read replicas — close terminates all workers",
  "no-assertions|tests/ddl-fatal.test.ts|sync DDL: duplicate column stays tolerated (already-applied is the steady state)",
  "no-assertions|tests/direct-call-return.test.ts|fire-and-forget async method that throws does NOT leak an unhandled rejection",
  "empty-loop|tests/docs-snippets-check.test.ts|doc ts/tsx code blocks type-check against the real API",
  "empty-loop|tests/docs-snippets-check.test.ts|doc ts/tsx code blocks type-check against the real API",
  "no-assertions|tests/e2e-blank-screen.test.ts|blank-screen guard: App renders nothing → empty-render diagnostic",
  "empty-loop|tests/electron-cross-build.test.ts|electron-cross: every aio platform maps to an Electron release asset",
  "no-assertions|tests/electron-main-relay.test.ts|electron main: renderer-ready with no backend reports the outage",
  "empty-loop|tests/electron-main-relay.test.ts|electron main: relay fuzz — nothing lost, reordered or corrupted",
  "empty-loop|tests/electron-main-relay.test.ts|electron main: relay fuzz — nothing lost, reordered or corrupted",
  "no-assertions|tests/electron.test.ts|electron: generated main.cjs is syntactically valid JS",
  "empty-loop|tests/entry-surface-parity.test.ts|entries: every entry",
  "empty-loop|tests/entry-surface-parity.test.ts|entries: the scaffold maps every importable entry (both modes)",
  "no-assertions|tests/error-e2e.test.ts|e2e — reportError self-guard: formatter crash degrades gracefully",
  "no-assertions|tests/error-memory.test.ts|memory monitor — stop clears interval",
  "empty-loop|tests/esbuild-plugin.test.ts|plugin: does NOT intercept regular imports",
  "empty-loop|tests/every-message-has-a-level.test.ts|output: the allowlist is real — every entry still exists and still prints",
  "no-assertions|tests/examples-boot.test.ts|example ${dir}: boots and serves", // aio-ok: a LEDGER of test names read from source, where the name is still a template
  "no-assertions|tests/examples-ui.test.ts|example UI ${label}: user clicks drive the rendered counter", // aio-ok: a LEDGER of test names read from source, where the name is still a template
  "no-assertions|tests/examples.test.ts|example targets/${target}: boots + counter increments over WS", // aio-ok: a LEDGER of test names read from source, where the name is still a template
  "no-assertions|tests/examples.test.ts|example counter: boots + counter increments over WS",
  "no-assertions|tests/examples.test.ts|example todo: boots + serves UI",
  "no-assertions|tests/examples.test.ts|example ${target}: boots + serves connect page", // aio-ok: a LEDGER of test names read from source, where the name is still a template
  "no-assertions|tests/examples.test.ts|example cli-remote: client drives the cli example server via stdin",
  "no-assertions|tests/field-filter-validation.test.ts|filter: valid nested exclude is accepted (head resolves)",
  "no-assertions|tests/field-filter-validation.test.ts|filter: valid top-level include/exclude accepted",
  "no-assertions|tests/field-filter-validation.test.ts|filter: valid ui.publicFields is accepted",
  "no-assertions|tests/field-filter-validation.test.ts|filter: ",
  "empty-loop|tests/foruser-leak.test.ts|forUser: a filter that throws sends NOTHING for that cell (fail closed)",
  "no-assertions|tests/library-mode.test.ts|libraryMode: same appId boots twice (no singleton lock)",
  "no-assertions|tests/listeners.test.ts|listeners: notify with no listeners is safe",
  "empty-loop|tests/local-control.test.ts|am: presents the control credential on the trojan, and nowhere else",
  "no-assertions|tests/logger.test.ts|logger: public log API falls back to console when no logger set",
  "empty-loop|tests/multi-client.test.ts|multi-client: both surfaces dispatching at once — no lost update",
  "empty-loop|tests/multi-client.test.ts|multi-client: concurrent appends from 3 surfaces all survive",
  "empty-loop|tests/own-churn-fuzz.test.ts|fuzz: own survives acquire/replace/dispose churn",
  "empty-loop|tests/own-churn-fuzz.test.ts|fuzz: own survives acquire/replace/dispose churn",
  "empty-loop|tests/rejection-attribution-fuzz.test.ts|D11 property: acked ⟺ applied, op-rejected ⟺ refused",
  "empty-loop|tests/removals-registry.test.ts|removals: lastGood is the release BEFORE the removal",
  "empty-loop|tests/removals-registry.test.ts|removals: every guide named by a row exists",
  "empty-loop|tests/removals-registry.test.ts|removals: the escape-hatch pin is a real tag",
  "empty-loop|tests/removals-registry.test.ts|removals: the message carries BOTH exits — migrate, or pin",
  "empty-loop|tests/removals-registry.test.ts|removals: cell() rejects every removed key with the registry message",
  "empty-loop|tests/removals-registry.test.ts|removals: aiol flags every removed key BEFORE the app boots",
  "empty-loop|tests/renderer-differential.test.ts|differential: hydrate ADOPTS the server",
  "empty-loop|tests/renderer-differential.test.ts|differential: a signal-valued prop renders exactly what the plain value does",
  "empty-loop|tests/renderer-differential.test.ts|differential: a keyed diff MOVES the node it already has — never re-creates it",
  "empty-loop|tests/renderer-differential.test.ts|differential: a form control holds the same live state after SSR+hydrate as after mount",
  "empty-loop|tests/renderer-differential.test.ts|differential: a form control holds the same live state after SSR+hydrate as after mount",
  "empty-loop|tests/renderer-differential.test.ts|differential: a form control holds the same live state after SSR+hydrate as after mount",
  "empty-loop|tests/return-value-fuzz.test.ts|return-value: every value class is exact, or the guard says what changed",
  "no-assertions|tests/return-value-transport.test.ts|e2e return-value: ASYNC method resolves the browser await with its value",
  "no-assertions|tests/return-value-transport.test.ts|e2e return-value: non-serializable return resolves to undefined (no hang)",
  "no-assertions|tests/security-audit-regression.test.ts|an equally-gated source is fine — the check is escalation, not listensTo",
  "self-comparison|tests/ship.test.ts|manifestCore: cell insertion order cannot change the signed core",
  "no-assertions|tests/single-instance-lock.test.ts|AppLock: release is idempotent",
  "no-assertions|tests/single-instance-lock.test.ts|AppLock: release only removes own lock",
  "no-assertions|tests/strict-cells.test.ts|strictCells: passing every cell boots fine",
  "no-assertions|tests/strict-cells.test.ts|strictCells omitted: an orphan is tolerated (opt-in only)",
  "no-assertions|tests/sync-method-return.test.ts|427: inferred return types (compile-time)",
  "empty-loop|tests/sync/sync-replay-versions.test.ts|schema: an older database gains the columns with UNKNOWN (-1), and a fresh one already has them",
  "no-assertions|tests/testui-absent-and-t.test.tsx|absent(): composes with waitFor",
  "no-assertions|tests/testui-revealed-controls.test.tsx|testUI: the same reveal, three actions deep",
  "empty-loop|tests/transport-chaos-fuzz.test.ts|chaos: one intent, one outcome — under drop / kill / reconnect",
  "no-assertions|tests/transport-exactly-once.test.ts|uds: a patch that fails to apply asks the server to resync",
  "no-assertions|tests/uds-accept-resilience.test.ts|uds: an unserializable state does not throw out of broadcastState",
  "empty-loop|tests/ui-kit-semantic.test.tsx|fuzz: every interactive element is reachable and drivable by name",
  "empty-loop|tests/ui-kit-semantic.test.tsx|fuzz: every interactive element is reachable and drivable by name",
  "empty-loop|tests/ui-surface-text-cap.test.tsx|surface: text is always a string — empty, never undefined",
  "nonempty-string|tests/updates-apply.test.ts|unpack: a missing tool is named, not swallowed",
  "no-assertions|tests/updates-apply.test.ts|pruneKeepingNewest: a directory that never existed is not an error",
  "nonempty-string|tests/updates-e2e.test.ts|updates e2e: a missing channel reports the reason, not silence",
  "empty-loop|tests/virtual-list.test.ts|virtualList: item offsets are correct multiples of itemHeight",
  "no-assertions|tests/visibility-warnings.test.ts|visibility (AIO-426): a credential that",
  "empty-loop|tests/wire-envelope.test.ts|envelope: every kind round-trips through enc/dec",
  "empty-loop|tests/wire-serves.test.ts|SERVES only names catalogued kinds",
  "empty-loop|tests/wire-serves.test.ts|SERVES only names catalogued kinds",
  "empty-loop|tests/wire-serves.test.ts|ignorable kinds never appear in SERVES (skipped, not routed)",
  "empty-loop|tests/wire-serves.test.ts|ignorable kinds never appear in SERVES (skipped, not routed)",
];

export type Verdict = {
  offenders: Offender[];
  added: Offender[];
  fixed: string[];
};

export function verdict(offenders: Offender[], ledger: readonly string[]) {
  const seen = new Set(offenders.map(key));
  const known = new Set(ledger);
  return {
    offenders,
    added: offenders.filter((o) => !known.has(key(o))),
    fixed: [...known].filter((k) => !seen.has(k)).sort(),
  };
}

export function report(v: Verdict): string {
  const lines: string[] = [];
  if (v.added.length) {
    lines.push(
      `${v.added.length} test${
        v.added.length === 1 ? "" : "s"
      } that pass while proving nothing:\n`,
    );
    for (const o of v.added) {
      lines.push(`  ${o.file}:${o.line}  [${o.rule}]  "${o.test}"`);
      lines.push(`      ${o.detail}`);
    }
    lines.push(
      `\n  Fix them, or — if the shape is genuinely fine here — say why on ` +
        `the line:\n      // aio-ok: <the reason this cannot be vacuous>`,
    );
  }
  if (v.fixed.length) {
    lines.push(
      `\n${v.fixed.length} ledger entr${
        v.fixed.length === 1 ? "y is" : "ies are"
      } no longer vacuous — good. Delete these lines from LEDGER in ` +
        `scripts/check-vacuous.ts and commit:\n`,
    );
    for (const k of v.fixed) lines.push(`  ${JSON.stringify(k)},`);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const root = new URL("../", import.meta.url).pathname;
  const all = await scan(root);
  const v = verdict(all, LEDGER);
  if (Deno.args.includes("--print-ledger")) {
    for (const o of all) console.log(`  ${JSON.stringify(key(o))},`);
    Deno.exit(0);
  }
  if (Deno.args.includes("--all")) {
    for (const o of all) {
      console.log(`${o.file}:${o.line}  [${o.rule}]  "${o.test}"`);
    }
    console.log(`\n${all.length} offenders, ${LEDGER.length} on the ledger`);
  }
  const text = report(v);
  if (text) {
    console.error(text);
    Deno.exit(1);
  }
  console.log(
    `check:vacuous — clean. ${all.length} known vacuous test${
      all.length === 1 ? "" : "s"
    } on the ledger, no new ones.`,
  );
}
