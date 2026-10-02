#!/usr/bin/env -S deno run --allow-read
// check-proto-in.ts — the prototype-lookup-on-data budget.
//
// `key in obj` answers for the object AND its prototype chain. On a class
// instance or a host object that is the point. On DATA — state, parsed or
// stored JSON, a records-by-id map — it is a bug waiting for a key: every
// plain object inherits `toString`, `constructor`, `valueOf`,
// `hasOwnProperty`, `__proto__`, … from `Object.prototype`, so a stored key
// that happens to be spelled like a builtin is "already there" before anyone
// wrote it. It shipped three times in one month:
//
//   • cell-migrate  — `!(k in out)` skipped a stored `constructor` key, so a
//                     restore silently dropped it (and `!(key in decl)`
//                     treated an undeclared `toString` as declared).
//   • sync/merge    — a `__proto__` key in lww-per-key merged into the
//                     prototype instead of the record.
//   • am state path — `resolvePath` walked `a.constructor.name` on state and
//                     answered with a native function instead of "not found".
//
// The fix is `Object.hasOwn(obj, key)` every time. Too many `in` uses to have
// each re-argued in one pass, so — like the swallowed errors — they are made
// COUNTABLE and SHRINKING.
//
// THE RULE (on code only — comments, strings, template text and regex bodies
// are masked out by scripts/source-mask.ts; see ratchet-kit.ts for why that
// mask and not src/diagnostics/code-mask.ts):
//
//   A binary `in` whose LEFT operand is not a literal: an identifier, a member
//   access, a call or an index (`k in o`, `!(k in o)`, `a.b in o`, `f() in o`).
//
// NOT counted, each for a stated reason:
//   • `for (… in …)` — iteration, not a membership test (and a different
//     rule's business: `for…in` walks inherited enumerables too).
//   • TS mapped types `[K in keyof T]` / `[P in Keys]` — a type position.
//   • A STRING literal on the left — `"value" in d`, `"then" in x` — the
//     feature/shape checks on host objects and unions. The author chose the
//     key, so it cannot collide with a builtin by accident… UNLESS the literal
//     IS a builtin name (`"constructor" in x`, `"toString" in x`), which is
//     always true of a plain object and is counted.
//   • A NUMERIC literal on the left — no numeric key lives on a prototype.
//
// A use on a genuine instance / host object / `Object.create(null)` record
// says so in place:  `// aio-ok(proto-in): <why the prototype cannot answer>`.
//
//   deno run --allow-read scripts/check-proto-in.ts          report
//   deno run --allow-read scripts/check-proto-in.ts --list   every site
//   … --root=<dir>                                           replay on a tree
import {
  collect,
  holdBudget,
  justifiedAt,
  lineAt,
  scanRoot,
} from "./ratchet-kit.ts";
import { mask } from "./source-mask.ts";

/** Unjustified non-literal `in` tests in `src/`. Only ever edit DOWNWARD. */
const CEILING = 54;

/** Every name `Object.prototype` answers `in` for, on any plain object. */
const PROTO_NAMES: ReadonlySet<string> = new Set([
  "constructor",
  "toString",
  "toLocaleString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

/** `for (` + optional declaration + a binding pattern, ending right where the
 *  `in` sits — a for-in head. `;`, `=` and `(` inside the head are excluded,
 *  so `for (let i = 0; k in o; i++)` is still a membership test. */
const FOR_IN_HEAD = /\bfor\s*\(\s*(?:(?:const|let|var)\s+)?[\w$\s,[\]{}:.]*$/;
/** `[K` / `[ P` directly before — a mapped type key. (`-readonly [K in …]`
 *  and `+readonly` end the same way.) */
const MAPPED_TYPE = /\[\s*[A-Za-z_$][\w$]*\s*$/;

/** What one file contributes: the lines of every counted `in`.
 *
 *  Pure and exported so the gate is tested on TEXT (tests/check-proto-in.test.ts):
 *  a scanner whose blind spot is exactly the thing it exists to find has
 *  happened in this repo before. */
export function scanSource(raw: string): { hits: number[]; justified: number } {
  const src = mask(raw);
  const lines = raw.split("\n");
  const hits: number[] = [];
  let justified = 0;
  const IN = /\bin\b/g;
  let m: RegExpExecArray | null;
  while ((m = IN.exec(src))) {
    const at = m.index;
    if (src[at - 1] === "." || src[at - 1] === "$") continue; // `.in`, `$in`
    // The right operand must START an expression: `{ in: 1 }`, `in?:`,
    // `(in)` are property names / params, not the operator.
    const after = src.slice(at + 2).match(/^\s*(\S)/)?.[1] ?? "";
    if (!/[\w$([{!"'`]/.test(after)) continue;
    // The left operand must END an expression.
    let j = at - 1;
    while (j >= 0 && /\s/.test(src[j]!)) j--;
    const end = src[j] ?? "";
    if (!/[\w$)\]"'`]/.test(end)) continue; // `<in T>` variance etc.
    const head = src.slice(Math.max(0, at - 240), at);
    if (FOR_IN_HEAD.test(head)) continue;
    if (MAPPED_TYPE.test(head)) continue;
    if (end === '"' || end === "'" || end === "`") {
      // A literal key. Read it from the RAW text — the mask blanked it.
      const open = raw.lastIndexOf(end, j - 1);
      const lit = raw.slice(open + 1, j);
      if (end === "`" && lit.includes("${")) { /* built key: counts */ }
      else if (!PROTO_NAMES.has(lit)) continue;
    } else if (/[\w$]/.test(end)) {
      let k = j;
      while (k > 0 && /[\w$]/.test(src[k - 1]!)) k--;
      const word = src.slice(k, j + 1);
      if (/^\d/.test(word)) continue; // numeric literal
      // A keyword before `in` is not an operand (`const in`-style
      // declarations cannot occur; `typeof in` is not JS).
      if (/^(?:const|let|var|typeof|return|case|of|new)$/.test(word)) continue;
    }
    const line = lineAt(src, at);
    if (justifiedAt(lines, line, "proto-in")) {
      justified++;
      continue;
    }
    hits.push(line);
  }
  return { hits, justified };
}

if (import.meta.main) {
  const { root, foreign } = scanRoot();
  const { hits } = await collect(
    root,
    (raw) => ({ hits: scanSource(raw).hits }),
    ["hits"] as const,
  );
  const ok = holdBudget({
    hits,
    ceiling: CEILING,
    what: "non-literal `in` tests (prototype lookups)",
    name: "CEILING",
    script: "check-proto-in.ts",
    prefix: foreign ? root : "src/",
    foreign,
    fix:
      `  \`k in obj\` is also true for toString / constructor / valueOf / …\n` +
      `  on EVERY plain object. On data (state, JSON, records-by-id) use\n` +
      `      Object.hasOwn(obj, k)\n` +
      `  On a real instance or host object, say why the prototype is wanted:\n` +
      `      // aio-ok(proto-in): <why>\n`,
  });
  if (!ok) Deno.exit(1);
  if (!foreign) {
    console.log(
      `✓ proto-in: ${hits.length} non-literal \`in\` tests (ceiling ${CEILING})`,
    );
  }
}
