#!/usr/bin/env -S deno run --allow-read
// check-utf16-bytes.ts — the UTF-16-length-against-a-byte-limit budget.
//
// `s.length` on a string counts UTF-16 code units. A byte cap counts UTF-8
// bytes. They agree on ASCII — which is every test fixture anybody writes —
// and disagree by up to 3× on the text real users type: "é" is 1 unit and 2
// bytes, "€" is 1 unit and 3 bytes, an emoji is 2 units and 4 bytes. So a cap
// written `json.length > MAX_BYTES` passes its tests and lets through up to
// three times the bytes it names. It shipped in the am sql result cap
// (`serialized.length > TROJAN_SQL_MAX_RESULT_BYTES`, fixed in 33580d5 with
// `src/protocol/utf8-size.ts`, which is the helper to use: `utf8Size(s)` and
// `overUtf8(s, limit)` — the latter stops as soon as the limit is crossed).
//
// THE RULE (on code only, via scripts/source-mask.ts):
//
//   A `.length` compared with `<`, `<=`, `>`, `>=` against an expression that
//   names BYTES — an identifier matching /BYTES|Bytes|bytes|MAX_BODY/
//   (`MAX_BYTES`, `limitBytes`, `sum.bytes * k`, `MAX_BODY`) — in either
//   order (`x.length > MAX_BYTES`, `MAX_BYTES < x.length`).
//
// NOT counted: a `.length` whose RECEIVER is already bytes by its name —
// `bytes.length`, `buf.length`, `u8.length`, `encoded.length`,
// `….encode(s).length` — because a Uint8Array's length IS its byte count, and
// `.byteLength` (never matched: the rule wants the `.length` member exactly).
//
// A `.length` that genuinely is a byte count under a different name
// (`e.data.length` where `data` is always an ArrayBuffer view) says so in
// place:  `// aio-ok(utf16-bytes): <why this length is already bytes>`.
//
//   deno run --allow-read scripts/check-utf16-bytes.ts          report
//   deno run --allow-read scripts/check-utf16-bytes.ts --list   every site
//   … --root=<dir>                                              replay
import {
  collect,
  holdBudget,
  justifiedAt,
  lineAt,
  scanRoot,
} from "./ratchet-kit.ts";
import { mask } from "./source-mask.ts";

/** Unjustified `.length`-vs-byte-limit comparisons in `src/`. DOWNWARD only. */
const CEILING = 1;

/** An identifier that says it holds a byte count. */
const BYTE_NAME = /BYTES|Bytes|bytes|MAX_BODY/;
/** A receiver whose `.length` already IS a byte count. */
const BYTE_RECEIVER =
  /(?:bytes|Bytes|buf|Buf|u8|U8|encoded|Encoded)[\w$]*$|\.encode\([^()]*\)$/;
/** A relational operator — and not `=>`, `>>`, `<<`, `<>`-ish generic noise. */
const REL = /^\s*(<=|>=|<(?![<=])|>(?![>=]))/;

/** One side of a comparison: from `at` in direction `dir` until the
 *  expression's boundary — `;`, `,`, `?`, `:`, `{`, `}`, `&&`, `||`, or an
 *  unbalanced bracket. Masked text in, so strings cannot hold a boundary. */
function side(src: string, at: number, dir: 1 | -1): string {
  let depth = 0;
  let i = at;
  for (; dir === 1 ? i < src.length : i >= 0; i += dir) {
    const c = src[i]!;
    const open = dir === 1 ? "([" : ")]";
    const close = dir === 1 ? ")]" : "([";
    if (open.includes(c)) depth++;
    else if (close.includes(c)) {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0) {
      if (";,?:{}".includes(c)) break;
      const two = dir === 1 ? src.slice(i, i + 2) : src.slice(i - 1, i + 1);
      if (two === "&&" || two === "||" || two === "=>") break;
      // A lone `=` is an assignment — the comparison is inside its rhs.
      if (c === "=" && src[i + 1] !== "=" && !"=<>!".includes(src[i - 1]!)) {
        break;
      }
    }
  }
  return dir === 1 ? src.slice(at, i) : src.slice(i + 1, at + 1);
}

const namesBytes = (expr: string): boolean =>
  (expr.match(/[A-Za-z_$][\w$]*/g) ?? []).some((w) => BYTE_NAME.test(w));

/** What one file contributes: the lines of every counted comparison.
 *  Pure and exported — tests/check-utf16-bytes.test.ts pins it on text. */
export function scanSource(raw: string): { hits: number[]; justified: number } {
  const src = mask(raw);
  const lines = raw.split("\n");
  const hits: number[] = [];
  let justified = 0;
  const LEN = /\.length\b(?![\w$(])/g;
  let m: RegExpExecArray | null;
  while ((m = LEN.exec(src))) {
    const at = m.index;
    // The receiver — the member chain right before `.length`.
    const recv = src.slice(Math.max(0, at - 120), at).match(
      /[\w$#.]*(?:\([^()]*\))?[\w$#.]*$/,
    )?.[0] ?? "";
    if (BYTE_RECEIVER.test(recv)) continue;
    const after = at + ".length".length;
    let hit = false;
    // `x.length OP <rhs>`
    const rhs = side(src, after, 1);
    const op = REL.exec(rhs);
    if (op && namesBytes(rhs.slice(op[0].length))) hit = true;
    // `<lhs> OP x.length` (the lhs may itself be a sum: `n + x.length`)
    if (!hit) {
      const lhs = side(src, at - 1, -1);
      const k = Math.max(
        lhs.lastIndexOf("<"),
        lhs.lastIndexOf(">"),
      );
      if (
        k !== -1 && lhs[k - 1] !== "=" && lhs[k + 1] !== lhs[k] &&
        lhs[k - 1] !== lhs[k] && namesBytes(lhs.slice(0, k))
      ) hit = true;
    }
    if (!hit) continue;
    const line = lineAt(src, at);
    if (justifiedAt(lines, line, "utf16-bytes")) {
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
    what: "`.length` comparisons against a byte limit",
    name: "CEILING",
    script: "check-utf16-bytes.ts",
    prefix: foreign ? root : "src/",
    foreign,
    fix:
      `  A string's .length is UTF-16 units, not bytes — up to 3× under on\n` +
      `  non-ASCII text. Measure what the limit names:\n` +
      `      import { overUtf8, utf8Size } from "…/protocol/utf8-size.ts";\n` +
      `      if (overUtf8(json, MAX_BYTES)) …\n` +
      `  If this length already IS bytes (a Uint8Array), say so in place:\n` +
      `      // aio-ok(utf16-bytes): <why>\n`,
  });
  if (!ok) Deno.exit(1);
  if (!foreign) {
    console.log(
      `✓ utf16-bytes: ${hits.length} \`.length\` vs byte-limit comparisons (ceiling ${CEILING})`,
    );
  }
}
