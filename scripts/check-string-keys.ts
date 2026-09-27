#!/usr/bin/env -S deno run --allow-read
// check-string-keys.ts — two budgets for strings that are silently PARSED.
//
// Both rules are about the same mistake: text built from values is handed to
// something that reads structure back out of it, and a value that contains the
// structure's own syntax is mis-read — quietly, because the result is still a
// string of the right shape.
//
// 1. SORTED-JOIN IDENTITY KEYS — `[...set].sort().join(",")` as a Map / Set /
//    memo key. The separator is not escaped, so any part that contains it
//    collides with a different set: {"a,b"} and {"a","b"} are one key. The
//    server view-key cache (`server-broadcast.ts`, fixed in 3b67ab0) built
//    `${userKey}|${[...subs].sort().join(",")}` and served one client's
//    filtered snapshot to another subscription set. The unambiguous spelling
//    is `JSON.stringify([...parts].sort())` — its quoting IS the escaping.
//
//    RULE: `.sort().join(SEP)` where SEP is a string literal holding no
//    whitespace ("," "|" ":" "" …). A separator WITH whitespace — ", " — is
//    the prose spelling (`Valid keys: a, b, c.`) and is not counted: nobody
//    keys a Map on a sentence. This is deliberately wider than "assigned to a
//    variable named *key*": the bug that shipped assigned it to `subs` and
//    built the key two lines later, so a name-based rule would have missed the
//    one instance it exists for.
//
// 2. INTERPOLATED REPLACEMENT STRINGS — `s.replace(re, `…${v}…`)`. A string
//    replacement is a TEMPLATE LANGUAGE: `$&`, `$1`, `$<name>`, `$$`, `` $` ``
//    and `$'` are expanded in it. A value spliced in carries its dollars with
//    it, so an app title of `Tom $& Jerry` wrote the matched plist tag into
//    Info.plist (`macos-app.ts`, fixed in d5cb7a8). The fix is a replacer
//    FUNCTION — `s.replace(re, (_m, pre) => pre + v)` — whose return value is
//    never expanded.
//
//    RULE: `.replace(` / `.replaceAll(` whose SECOND argument is a template
//    literal with a `${…}` hole, or a `+` concatenation. A function (`=>`,
//    `function`) is the fix and never counts; a plain literal has no value to
//    smuggle a `$` in.
//
// Both on code only (scripts/source-mask.ts). Justify in place with
// `// aio-ok(string-key): <why>` / `// aio-ok(replace-template): <why>` on the
// line or the one above — e.g. a key whose parts provably cannot contain the
// separator, or an interpolated number.
//
//   deno run --allow-read scripts/check-string-keys.ts          report
//   deno run --allow-read scripts/check-string-keys.ts --list   every site
//   … --root=<dir>                                              replay
import {
  collect,
  holdBudget,
  justifiedAt,
  lineAt,
  scanRoot,
} from "./ratchet-kit.ts";
import { mask } from "./source-mask.ts";

/** Unjustified sorted-join keys in `src/`. Only ever edit DOWNWARD. */
const KEY_CEILING = 3;
/** Unjustified interpolated replacement strings in `src/`. DOWNWARD only. */
const REPLACE_CEILING = 8;

/** `.sort()` (optionally with a comparator) then `.join(` + a quote. */
const SORTED_JOIN = /\.sort\((?:[^()]|\([^()]*\))*\)\s*\.join\(\s*(["'`])/g;
const REPLACE = /\.replace(?:All)?\s*\(/g;

/** From `from` (just inside an argument list) to the next top-level `,` or
 *  the list's closing `)`. Masked text in: string bodies cannot hold one. */
function argEnd(src: string, from: number): number {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) return i;
      depth--;
    } else if (c === "," && depth === 0) return i;
  }
  return src.length;
}

/** Top-level characters of an argument (nested brackets skipped), so a `+`
 *  or `=>` inside a call in the argument is not the argument's own. */
function topLevel(arg: string): string {
  let depth = 0;
  let out = "";
  for (const c of arg) {
    if ("([{".includes(c)) {
      if (depth === 0) out += c;
      depth++;
    } else if (")]}".includes(c)) {
      depth--;
      if (depth === 0) out += c;
    } else if (depth === 0) out += c;
  }
  return out;
}

/** What one file contributes to each budget. Pure and exported —
 *  tests/check-string-keys.test.ts pins it on text. */
export function scanSource(
  raw: string,
): { keys: number[]; replaces: number[]; justified: number } {
  const src = mask(raw);
  const lines = raw.split("\n");
  const keys: number[] = [];
  const replaces: number[] = [];
  let justified = 0;
  const count = (at: number, rule: string, into: number[]) => {
    const line = lineAt(src, at);
    if (justifiedAt(lines, line, rule)) justified++;
    else into.push(line);
  };

  SORTED_JOIN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SORTED_JOIN.exec(src))) {
    const q = m[1]!;
    const open = m.index + m[0].length - 1;
    const close = raw.indexOf(q, open + 1);
    if (close === -1) continue;
    const sep = raw.slice(open + 1, close);
    if (q === "`" && sep.includes("${")) continue; // a computed separator
    if (/\s/.test(sep)) continue; // ", " — the prose spelling
    count(m.index, "string-key", keys);
  }

  REPLACE.lastIndex = 0;
  while ((m = REPLACE.exec(src))) {
    const first = m.index + m[0].length;
    const comma = argEnd(src, first);
    if (src[comma] !== ",") continue; // one argument: not a String#replace
    const end = argEnd(src, comma + 1);
    const arg = src.slice(comma + 1, end).trim();
    const top = topLevel(arg);
    if (arg === "") continue;
    if (/=>|^function\b|^async\b/.test(top)) continue; // a replacer: the fix
    const templ = arg.startsWith("`") && arg.includes("${");
    const concat = /(^|[^+])\+(?!\+)/.test(top);
    if (!templ && !concat) continue;
    count(m.index, "replace-template", replaces);
  }
  return { keys, replaces, justified };
}

if (import.meta.main) {
  const { root, foreign } = scanRoot();
  const { keys, replaces } = await collect(
    root,
    (raw) => {
      const r = scanSource(raw);
      return { keys: r.keys, replaces: r.replaces };
    },
    ["keys", "replaces"] as const,
  );
  const prefix = foreign ? root : "src/";
  const keysOk = holdBudget({
    hits: keys,
    ceiling: KEY_CEILING,
    what: "sorted-join string keys",
    name: "KEY_CEILING",
    script: "check-string-keys.ts",
    prefix,
    foreign,
    fix: `  .sort().join(",") does not escape its separator: {"a,b"} and\n` +
      `  {"a","b"} become the same key. Key on\n` +
      `      JSON.stringify([...parts].sort())\n` +
      `  or, if no part can ever hold the separator, say why in place:\n` +
      `      // aio-ok(string-key): <why>\n`,
  });
  const replOk = holdBudget({
    hits: replaces,
    ceiling: REPLACE_CEILING,
    what: "interpolated .replace() replacement strings",
    name: "REPLACE_CEILING",
    script: "check-string-keys.ts",
    prefix,
    foreign,
    fix:
      `  A replacement STRING expands $&, $1, $\` and $' — a value spliced\n` +
      `  into it brings its dollars along. Use a replacer function:\n` +
      `      s.replace(re, (_m, pre) => pre + value)\n` +
      `  or, if the value cannot hold a "$" (a number), say so in place:\n` +
      `      // aio-ok(replace-template): <why>\n`,
  });
  if (!keysOk || !replOk) Deno.exit(1);
  if (!foreign) {
    console.log(
      `✓ string keys: ${keys.length} sorted-join key${
        keys.length === 1 ? "" : "s"
      } (ceiling ${KEY_CEILING}) + ${replaces.length} interpolated replacement${
        replaces.length === 1 ? "" : "s"
      } (ceiling ${REPLACE_CEILING})`,
    );
  }
}
