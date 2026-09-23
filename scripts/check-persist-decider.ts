#!/usr/bin/env -S deno run --allow-read
// check-persist-decider.ts — no runtime may write cell state around the filter.
//
// 1.0.7-beta shipped a runtime that did. `src/standalone-air.ts` persisted the
// whole composed state (`getDBState = (s) => s`), so a cell that declared
// `persist: "none"` — a session token, a draft — was fsync'd to the phone on
// every dispatch and restored on the next launch, while `deno task dev` on the
// same app.ts dropped it. The fix put the rule in ONE module,
// `src/state/cell-persist-filter.ts`, and made both hosts import it. Nothing
// kept a THIRD host from being written the old way. This does.
//
// `tests/hosts` (the runtime lane) proves each EXISTING host drops the slice
// end to end. It cannot see a host nobody has told it about. This is the
// static half: it finds hosts from the code itself, so a new one is judged the
// day it lands, not the day somebody adds it to a list.
//
// THE RULE — a composed app's state reaches a store only through the decider
// module. Mechanised as four checks over `src/` (comments and strings masked,
// so a doc comment that NAMES the filter is not a call to it):
//
//   decider-module  Exactly one file DECLARES `buildDBStateGetter` and
//                   `persistingCellIds`. Located by that fact, never by path —
//                   and if it moves or splits, this is red rather than vacuous.
//   host            Every `composeCells(…)` call site is a host. A host file
//                   must CALL both deciders — the write half and the restore
//                   half — or say on the call line why its composition never
//                   reaches a store: `// aio-ok(persist-decider): <why>`.
//                   `composeCells(…).initialState` is exempt by shape: a value
//                   read, no reducer, no runtime, nothing that could persist.
//   whole-state     A DB-state getter slot (`getDBState`, `_getDBState`,
//                   `autoGetDBState` …: the store layers' own parameter name)
//                   bound or defaulted to the IDENTITY function is the exact
//                   1.0.7 shape. Allowed once, with a marker: the raw
//                   `initStandalone`, which has no cells to filter.
//   second-decider  Resolving a cell's `persist` — `__aio.persist` compared
//                   with `"none"`, or defaulted with `?? "all"` — anywhere but
//                   the decider module. A restated rule is a second decider,
//                   and two deciders drift (aio-cells-bridge.ts had two copies
//                   the day this landed; they now ask `persistingCellIds` /
//                   `persistFilterOf`).
//
//   deno task check:persist-decider      exit 1 on any finding

import { justified as okMarker } from "../src/diagnostics/ok-marker.ts";
import { mask } from "./source-mask.ts";

export const GATE = "persist-decider";

/** The two functions the rule lives in. Everything else is derived. */
export const DECIDERS = ["buildDBStateGetter", "persistingCellIds"] as const;

export type Finding = {
  file: string;
  line: number;
  rule: "decider-module" | "host" | "whole-state" | "second-decider";
  detail: string;
};

/** A file to judge. `masked` may be handed in by a caller that already masked
 *  it (check-dead-wiring runs this over its own cached read of src/). */
export type Source = { path: string; src: string; masked?: string };

const lineOf = (src: string, idx: number): number =>
  src.slice(0, idx).split("\n").length;

/** The line at `idx`, or the one above it, carries a marker for this gate. */
function justifiedAt(src: string, idx: number): boolean {
  const lines = src.split("\n");
  const n = lineOf(src, idx) - 1;
  return okMarker(lines[n] ?? "", GATE) || okMarker(lines[n - 1] ?? "", GATE);
}

/** The index of the `)` closing the `(` at `open`, in masked code. */
function closeParen(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return code.length;
}

const declares = (code: string, name: string): boolean =>
  new RegExp(`\\bexport\\s+function\\s+${name}\\b`).test(code);

/** A real CALL of `name` — not its declaration, not an import binding. */
const calls = (code: string, name: string): boolean =>
  new RegExp(`(?<![\\w$.]|function\\s)${name}\\s*\\(`).test(code);

const COMPOSE_CALL = /(?<![\w$.]|function\s)composeCells\s*\(/g;

/** `<slot> <op> (x) => x` — a DB-state slot bound to the identity function,
 *  as a default (`??`, `||`), an assignment, or an object property. */
/** A cell's `persist` resolved outside the decider module — `__aio.persist`
 *  (or `__aio?.persist`) defaulted with `?? "all"`, or compared with `"none"`
 *  in either order and with either operator. Matched on the ORIGINAL text
 *  (the literals are masked away); group 1 / the `__aio` offset is then
 *  confirmed to be code in the masked copy. */
const SECOND_DECIDER = [
  /__aio\s*\??\.\s*persist\b(?!Transform)(?:\s*\?\?\s*["'`]all["'`]|\s*\)?\s*[!=]==?\s*["'`]none["'`])/g,
  /["'`]none["'`]\s*[!=]==?\s*\(?\s*[\w$.?\s]*?(__aio)\s*\??\.\s*persist\b(?!Transform)/g,
];

// ─── whole-state: a tiny reader over the MASKED code ─────────────────────
//
// "A DB-state slot bound to the identity function" has too many spellings for
// one regex (`s => s`, `(s: S): S => s`, `<T,>(s: T) => s`, `function (s) {
// return s; }`, method shorthand, a named function, extra wrapping parens).
// So the slot is found by name and what follows is READ: skip to the function
// value, take its first parameter, and ask whether the body only returns it.

const WS = /\s/;
const IDENT = /^[A-Za-z_$][\w$]*/;

function skipWs(c: string, i: number): number {
  while (i < c.length && WS.test(c[i]!)) i++;
  return i;
}

/** Index just past the bracket that closes the one at `i`. */
function closeOf(c: string, i: number): number {
  const open = c[i]!,
    shut =
      ({ "(": ")", "<": ">", "{": "}", "[": "]" } as Record<string, string>)[
        open
      ]!;
  let d = 0;
  for (let k = i; k < c.length; k++) {
    if (c[k] === "=" && c[k + 1] === ">") {
      k++;
      continue;
    }
    if (c[k] === open) d++;
    else if (c[k] === shut && --d === 0) return k + 1;
  }
  return -1;
}

/** Past an optional `: ReturnType`, stopping at `=>` (arrow) or `{` (block)
 *  at bracket depth 0. */
function skipReturnType(c: string, i: number, arrow: boolean): number {
  i = skipWs(c, i);
  if (c[i] !== ":") return i;
  let d = 0;
  for (let k = i + 1; k < c.length; k++) {
    const ch = c[k]!;
    if (d === 0 && arrow && ch === "=" && c[k + 1] === ">") return k;
    if (d === 0 && !arrow && ch === "{") return k;
    if (ch === "=" && c[k + 1] === ">") {
      k++;
      continue;
    }
    if ("(<[{".includes(ch)) d++;
    else if (")>]}".includes(ch)) d--;
    if (d < 0 || (d === 0 && ";,".includes(ch))) return -1;
  }
  return -1;
}

/** Does the expression at `i` evaluate to exactly `param` (parens, `as T`,
 *  `satisfies T` allowed) and end there? */
function returnsParam(c: string, i: number, param: string): boolean {
  i = skipWs(c, i);
  while (c[i] === "(") i = skipWs(c, i + 1);
  const id = IDENT.exec(c.slice(i));
  if (!id || id[0] !== param) return false;
  const k = skipWs(c, i + param.length);
  const next = c[k];
  if (next === undefined || ");,}".includes(next)) return true;
  return /^(?:as|satisfies)\b/.test(c.slice(k));
}

/** `{ return <param>; … }` — the block's first statement returns the param. */
function blockReturnsParam(c: string, i: number, param: string): boolean {
  i = skipWs(c, i);
  if (c[i] !== "{") return false;
  i = skipWs(c, i + 1);
  if (!/^return\b/.test(c.slice(i))) return false;
  return returnsParam(c, i + "return".length, param);
}

/** Parameter list at `i` (`(a, …)` or a bare `a`): [first param, end]. */
function readParams(c: string, i: number): [string, number] | null {
  i = skipWs(c, i);
  if (c[i] === "(") {
    const end = closeOf(c, i);
    if (end < 0) return null;
    const first = IDENT.exec(c.slice(skipWs(c, i + 1)));
    return first ? [first[0], end] : null;
  }
  const bare = IDENT.exec(c.slice(i));
  return bare ? [bare[0], i + bare[0].length] : null;
}

const skipGenerics = (c: string, i: number): number => {
  i = skipWs(c, i);
  return c[i] === "<" ? closeOf(c, i) : i;
};

/** Is the function VALUE starting at `i` the identity? Handles arrows,
 *  `function` expressions, `async`, generics, return types, wrapping parens. */
function isIdentityValue(c: string, i: number, depth = 0): boolean {
  i = skipWs(c, i);
  const rest = c.slice(i);
  const asy = /^async\b/.exec(rest);
  if (asy) i = skipWs(c, i + asy[0].length);
  if (/^function\b/.test(c.slice(i))) {
    i = skipWs(c, i + "function".length);
    if (c[i] === "*") i = skipWs(c, i + 1);
    const name = IDENT.exec(c.slice(i));
    if (name) i += name[0].length;
    return isMethodTail(c, i);
  }
  const g = skipGenerics(c, i);
  if (g >= 0) {
    const p = readParams(c, g);
    if (p) {
      const at = skipReturnType(c, p[1], true);
      if (at >= 0 && c.startsWith("=>", skipWs(c, at))) {
        const body = skipWs(c, skipWs(c, at) + 2);
        if (c[body] === "{") return blockReturnsParam(c, body, p[0]);
        return returnsParam(c, body, p[0]);
      }
    }
  }
  // `((s) => s)` — a wrapping paren around the whole value.
  return depth < 3 && c[i] === "(" && isIdentityValue(c, i + 1, depth + 1);
}

/** After a method / function NAME: `<T>(p): R { return p; }`. */
function isMethodTail(c: string, i: number): boolean {
  const g = skipGenerics(c, i);
  if (g < 0) return false;
  const p = readParams(c, g);
  if (!p || c[skipWs(c, g)] !== "(") return false;
  const at = skipReturnType(c, p[1], false);
  return at >= 0 && blockReturnsParam(c, at, p[0]);
}

/** `getDBState: persist` where `persist` is a same-file `const`/`let`/`var`
 *  or `function` declared as the identity — followed ONE level (an alias of
 *  an alias is not chased; the rule is a tripwire for the 1.0.7 shape, not a
 *  data-flow analysis). */
function isIdentityBinding(c: string, v: number): boolean {
  const i = skipWs(c, v);
  const name = IDENT.exec(c.slice(i))?.[0];
  if (!name || /^(?:async|function)$/.test(name)) return false;
  const after = skipWs(c, i + name.length);
  if (c[after] === "(" || c[after] === "." || c[after] === "[") return false;
  const esc = name.replace(/\$/g, "\\$");
  for (
    const d of c.matchAll(
      new RegExp(`\\b(?:const|let|var)\\s+${esc}\\b\\s*(?::[^=]*)?=`, "g"),
    )
  ) if (isIdentityValue(c, d.index + d[0].length)) return true;
  for (const d of c.matchAll(new RegExp(`\\bfunction\\s+${esc}\\b`, "g"))) {
    if (isMethodTail(c, d.index + d[0].length)) return true;
  }
  return false;
}

const SLOT = /\b\w*(?:getDBState|GetDBState)\b/g;

/** Every DB-state slot in masked code that is bound to the identity. */
export function wholeStateSlots(c: string): { index: number; slot: string }[] {
  const out: { index: number; slot: string }[] = [];
  for (const m of c.matchAll(SLOT)) {
    let i = skipWs(c, m.index + m[0].length);
    let before = m.index - 1;
    while (before >= 0 && WS.test(c[before]!)) before--;
    const prevWord = /(\w+)\s*$/.exec(
      c.slice(Math.max(0, before - 12), before + 1),
    );
    let hit = false;
    if (
      prevWord?.[1] === "function" ||
      (before < 0 || "{,;}".includes(c[before]!))
    ) {
      // method shorthand / named function: `getDBState(s) { return s; }`
      if (c[i] === "(" || c[i] === "<") hit = isMethodTail(c, i);
    }
    if (!hit) {
      if (c[i] === "?" && c[i + 1] !== "?" && c[i + 1] !== ".") {
        i = skipWs(c, i + 1);
      }
      let v = -1;
      if (c.startsWith("??", i) || c.startsWith("||", i)) v = i + 2;
      else if (c[i] === "=" && c[i + 1] !== "=" && c[i + 1] !== ">") v = i + 1;
      else if (c[i] === ":") v = i + 1;
      if (v >= 0) hit = isIdentityValue(c, v) || isIdentityBinding(c, v);
    }
    if (hit) out.push({ index: m.index, slot: m[0] });
  }
  return out;
}

export function check(files: readonly Source[]): Finding[] {
  const out: Finding[] = [];
  const masked = new Map(files.map((f) => [f.path, f.masked ?? mask(f.src)]));

  const home = files.filter((f) =>
    DECIDERS.every((d) => declares(masked.get(f.path)!, d))
  );
  if (home.length !== 1) {
    out.push({
      file: "src/",
      line: 0,
      rule: "decider-module",
      detail: `expected exactly one file declaring ${
        DECIDERS.join(" + ")
      }, found ${home.length}${
        home.length ? ` (${home.map((f) => f.path).join(", ")})` : ""
      } — the persist rule must live in ONE module`,
    });
  }
  const deciderFile = home[0]?.path;

  for (const f of files) {
    const code = masked.get(f.path)!;

    // ── host ──
    const missing = DECIDERS.filter((d) => !calls(code, d));
    for (const m of code.matchAll(COMPOSE_CALL)) {
      const open = m.index + m[0].length - 1;
      const after = code.slice(closeParen(code, open) + 1);
      if (/^\s*\.\s*initialState\b/.test(after)) continue;
      if (justifiedAt(f.src, m.index)) continue;
      if (missing.length === 0) continue;
      out.push({
        file: f.path,
        line: lineOf(f.src, m.index),
        rule: "host",
        detail: `composes cells but never calls ${
          missing.join(" / ")
        } — whatever it persists skips \`persist: "none"\``,
      });
    }

    // ── whole-state ──
    for (const m of wholeStateSlots(code)) {
      if (justifiedAt(f.src, m.index)) continue;
      out.push({
        file: f.path,
        line: lineOf(f.src, m.index),
        rule: "whole-state",
        detail: `\`${m.slot}\` is the identity function — the WHOLE state ` +
          `reaches the store, filter skipped`,
      });
    }

    // ── second-decider ──
    if (f.path === deciderFile) continue;
    for (const m of SECOND_DECIDER.flatMap((re) => [...f.src.matchAll(re)])) {
      const at = m[1] === undefined
        ? m.index
        : m.index + m[0].lastIndexOf("__aio");
      if (!code.startsWith("__aio", at)) continue; // comment or string
      if (justifiedAt(f.src, m.index)) continue;
      out.push({
        file: f.path,
        line: lineOf(f.src, m.index),
        rule: "second-decider",
        detail: `resolves a cell's \`persist\` by hand (\`${
          m[0].replace(/\s+/g, " ")
        }\`) — ask persistingCellIds / persistFilterOf instead`,
      });
    }
  }
  return out.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1
  );
}

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) yield* walk(p);
    else if (/\.tsx?$/.test(e.name) && !/\.(test|d)\.tsx?$/.test(e.name)) {
      yield p;
    }
  }
}

/** Every source file under `<root>src/`, paths relative to root. */
export async function readSrc(root: string): Promise<Source[]> {
  const out: Source[] = [];
  for await (const p of walk(`${root}src`)) {
    out.push({ path: p.slice(root.length), src: await Deno.readTextFile(p) });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

export function report(findings: readonly Finding[]): string {
  return findings.map((f) => `  ${f.file}:${f.line}  [${f.rule}] ${f.detail}`)
    .join("\n");
}

if (import.meta.main) {
  const root = new URL("../", import.meta.url).pathname;
  const findings = check(await readSrc(root));
  if (findings.length) {
    console.error(
      `check:persist-decider — ${findings.length} way(s) cell state can ` +
        `reach a store around src/state/cell-persist-filter.ts:\n\n` +
        report(findings) +
        `\n\n  Route it through buildDBStateGetter + persistingCellIds, or — ` +
        `if this composition can never reach a store — say so on the line:\n` +
        `      // aio-ok(${GATE}): <why nothing it composes is persisted>`,
    );
    Deno.exit(1);
  }
  console.log(
    "check:persist-decider — clean. Every host routes through the one filter.",
  );
}
