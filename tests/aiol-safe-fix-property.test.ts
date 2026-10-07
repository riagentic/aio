// `--safe-fix` over a generated project: no file loses a name it still uses.
//
// The fix for `useCell(c).state.x` decides what is a use by reading text, and
// three times a shape it misread — a statement between two elements, a tag
// spelled in a comment, a call inside a template — kept its `useCell(…)` while
// the import was removed by the fix of another use in the same file: a file
// that no longer builds, from a fix whose contract is "harmless". The same for
// `call({ timeout })` rewritten on a `call` that was the file's own.
//
// So the shapes are multiplied instead of listed: what stands BEFORE a use ×
// how the use is written × what else in the file names `useCell`. Every file
// is fixed by the real linter, compared with the text it must become, and the
// whole project is type-checked ONCE — the compiler, not the fix's own
// reading, says whether a name went missing.
import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { codeMaskDeep } from "../aiol/fixes.ts";
import { lintProject } from "../aiol/mod.ts";
import type { Issue } from "../aiol/types.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

// An import map names a module by specifier, never by path: `C:\\x\\mod.ts`
// is the URL scheme `c:` to Deno.
const REPO = new URL("../", import.meta.url).href;
const IMPORT = `import { useCell } from "aio";\n`;
const CELL = `import { counter } from "./cell.ts";\n`;
const USE = "useCell(counter).state.count";

/** A statement before the use — each one something a tag-reading heuristic
 *  could take for an element, or for the end of one. */
const BEFORE: readonly string[] = [
  ``,
  `// the <h1> title`,
  `// rendered inside <Layout>`,
  `/* closes with </p> */`,
  `/** Returns a <p> with the count. */`,
  `const open = "<div>";`,
  "const open = `<div>`;",
  `const close = '</div>';`,
  `const title = <h1>Hi</h1>;`,
  `const title = <h1 class="a > b">Hi</h1>;`,
  `const br = <br />;`,
  `const frag = <></>;`,
  `const big = a < b || b > 2;`,
  `const big = a <b || c> 2;`,
  `const id = <T,>(x: T) => x;`,
  `const id = <T extends unknown>(x: T): T => x;`,
  `const m = new Map<string, number>();`,
  `const f = (x: number) => x > 1;`,
  `const re = /<p>/;`,
  // an element whose attribute holds a `>` of its own
  `const btn = <button onClick={() => console.log(a > b)}>x</button>;`,
  `const cmp = <br title={String(a > b)} />;`,
];

/** The body's lines around `@`, a real use. Every one is code. */
const USES: readonly (readonly [stmt: string, ret: string])[] = [
  [`const n = @;`, `<p>{n}</p>`],
  [`const n = @; // goes before </b>`, `<p>{n}</p>`],
  ["const n = `n=${@}`;", `<p>{n}</p>`],
  [`const n = @ > 0 ? @ : 0;`, `<p title={String(@)}>{n}{@}</p>`],
  [`const n = 1;`, `<><b>a</b>{n}{@}</>`],
];

/** What else names `useCell`. The first four only MENTION it, where the mask
 *  blanks — and every file here holds JSX, where a name written in such a
 *  place is not proven aio's: the file is left whole, with a `[manual]`. The
 *  last two are uses the fix has no rewrite for: the import must stay. */
const MENTIONS = 4;
const REST: readonly (readonly [stmt: string, ret: string])[] = [
  [`// was ${USE}`, ``],
  [`const doc = "${USE}";`, ``],
  ["const doc = `" + USE + "`;", ``],
  [``, `<code>${USE}</code>`],
  [`const whole = useCell(counter);`, ``],
  ["const whole = `${String(useCell(counter))}`;", ``],
];

const view = (
  before: string,
  [stmt, ret]: readonly [string, string],
  rest: readonly [string, string] = ["", ""],
) =>
  `export function V(a: number, b: number, c: number) {\n` +
  [before, stmt, rest[0]].filter(Boolean).map((l) => `  ${l}\n`).join("") +
  `  return <div>${rest[1]}${ret}</div>;\n}\n`;

type Case = { src: string; fixed: string; error?: string; manual?: true };

/** A closing tag written where no element is — in a comment, a string: in
 *  a file with JSX it is one the element reader did not account for, and
 *  the file is left whole, with a `[manual]`. */
const STRAY = (text: string) =>
  /^(?:\/[/*]|const \w+ = ['"`]).*<\//.test(text) ||
  /\/\/.*<\//.test(text);

const CASES: Record<string, Case> = {};
BEFORE.forEach((before, b) => {
  USES.forEach((use, u) => {
    const body = view(before, use);
    const stray = STRAY(before) || STRAY(use[0]);
    CASES[`src/u${b}-${u}.tsx`] = {
      src: IMPORT + CELL + body.replaceAll("@", USE),
      fixed: stray
        ? IMPORT + CELL + body.replaceAll("@", USE)
        : CELL + body.replaceAll("@", "counter.count"),
      ...(stray ? { manual: true as const, error: "TS2305" } : {}),
    };
  });
  REST.forEach((rest, r) => {
    const body = view(before, USES[0]!, rest);
    CASES[`src/r${b}-${r}.tsx`] = {
      src: IMPORT + CELL + body.replaceAll("@", USE),
      fixed: IMPORT + CELL +
        body.replaceAll(
          "@",
          r < MENTIONS || STRAY(before) ? USE : "counter.count",
        ),
      ...(r < MENTIONS || STRAY(before) ? { manual: true as const } : {}),
      // The import was not removable, and it names what aio does not export —
      // as it did before the fix.
      error: "TS2305",
    };
  });
});

// ── A `useCell` that is the file's own ───────────────────────────────
// Imported from the app's module, or declared in the file: not aio's, so the
// same spelling is left byte for byte.
const HOOK =
  `function useCell<T>(c: T): { state: T } {\n  return { state: c };\n}\n`;
USES.forEach((use, u) => {
  const body = view("", use).replaceAll("@", USE);
  const imported = `import { useCell } from "./hooks.ts";\n` + CELL + body;
  CASES[`src/own-import${u}.tsx`] = { src: imported, fixed: imported };
  const local = CELL + HOOK + body;
  CASES[`src/own-local${u}.tsx`] = { src: local, fixed: local };
});
CASES["src/hooks.ts"] = { src: `export ${HOOK}`, fixed: `export ${HOOK}` };

// ── Text an element shows, after a tag whose attribute holds a `>` ───
[
  `<button onClick={() => console.log(a)}>${USE}</button>`,
  `<p title={a > b ? "x" : "y"}>${USE}</p>`,
  `<p title={[{ k: a > b }].length > c ? "}" : ">"}>${USE}</p>`,
  `<p\n      onClick={() => {\n        if (a > b) console.log(c);\n      }}\n    >\n      ${USE}\n    </p>`,
].forEach((el, i) => {
  const src = view("", ["", el]);
  CASES[`src/text${i}.tsx`] = { src, fixed: src };
});

// ── A `cell("name", {…})` and a `schedule` that are the file's own ───
[
  `type Opts = { ui: string[] };\nconst cell = (name: string, o: Opts) => ({ name, ...o });\nexport const a1 = cell("a1", { ui: ["bold"] });\n`,
  `type Opts = { ui: string[] };\nfunction cell(name: string, o: Opts) {\n  return { name, ...o };\n}\nexport const b2 = cell("b2", { ui: [] });\n`,
  `const schedule = { after: (ms: number, n: number) => ms + n };\nexport const jobs = {\n  tick(s: { n: number }) {\n    s.n++;\n    return schedule.after(1000, s.n);\n  },\n};\n`,
].forEach((src, i) => {
  CASES[`src/own-cell${i}.ts`] = { src, fixed: src };
});

// ── call({ timeout }) ────────────────────────────────────────────────
const CALL = `import { call } from "aio";\n` +
  `type Fn = (o: { timeout: number }) => number;\n` +
  `const rpc: Fn = (o) => o.timeout;\n`;
const TAIL = `export const keep = [call, rpc];\n`;

/** `call(` through a name the file binds itself: left exactly as written. */
const OWN: readonly string[] = [
  `export const run = (call: Fn) => call({ timeout: 5 });`,
  `export const run = (a: number, call: Fn) => call({ timeout: a });`,
  `export function run(call: Fn = rpc) { return call({ timeout: 5 }); }`,
  `export function run({ call }: { call: Fn }) { return call({ timeout: 5 }); }`,
  `export function run({ rpc: call }: { rpc: Fn }) { return call({ timeout: 5 }); }`,
  `export function run() { const call = rpc; return call({ timeout: 5 }); }`,
  `export function run() { let call = rpc; call = rpc; return call({ timeout: 5 }); }`,
  `export function run() { const { call } = { call: rpc }; return call({ timeout: 5 }); }`,
  `export function run() { const [call] = [rpc]; return call({ timeout: 5 }); }`,
  `export function run() { function call(o: { timeout: number }) { return o.timeout; } return call({ timeout: 5 }); }`,
  `export class A { #call(o: { timeout: number }) { return o.timeout; } run() { return this.#call({ timeout: 5 }); } }`,
  `export class A { call = rpc; run() { return this.call({ timeout: 5 }); } }`,
  `export const o = { call: rpc }; export const r = o.call({ timeout: 5 });`,
];
OWN.forEach((own, i) => {
  const src = CALL + own + "\n" + TAIL;
  CASES[`src/own${i}.ts`] = { src, fixed: src };
});

// ── A `call` an inner scope binds, beside aio's ──────────────────────
// The files above also write `[call, rpc]`, which alone stops the fix. Here
// NOTHING else does: aio's own use stands in the file, and a scope below it
// binds a `call` of its own — a parameter, a local, a nested function —
// which that scope then calls. How the name is bound × where the scope is:
// the file is left whole, and aio's use is named, `[manual]`.
/** How a scope binds its own `call`: in its parameters, or in its body. */
const BINDS: readonly (readonly [params: string, body: string])[] = [
  ["call: Fn", ""],
  ["a: number, call: Fn", ""],
  ["call: Fn = rpc", ""],
  ["call = rpc", ""],
  ["{ call }: { call: Fn }", ""],
  ["{ rpc: call }: { rpc: Fn }", ""],
  ["{ call = rpc }: { call?: Fn }", ""],
  ["", "const call = rpc;"],
  ["", "const call: Fn = rpc;"],
  ["", "let call: Fn; call = rpc;"],
  ["", "var call = rpc;"],
  ["", "const a = 1, call = a ? rpc : rpc;"],
  ["", "const { call } = { call: rpc };"],
  ["", "const { rpc: call } = { rpc };"],
  ["", "const [call] = [rpc] as const;"],
  ["", "function call(o: { timeout: number }) { return o.timeout; }"],
  ["", "function\n  call(o: { timeout: number }) { return o.timeout; }"],
  ["", "function /* own */ call(o: { timeout: number }) { return o.timeout; }"],
  ["", "async function call(o: { timeout: number }) { return o.timeout; }"],
  ["", "function* call(o: { timeout: number }) { yield o.timeout; }"],
  [
    "",
    "function call<T extends { timeout: number }>(o: T) { return o.timeout; }",
  ],
  ["", "function call({ timeout }: { timeout: number }) { return timeout; }"],
  ["", "function call(...a: { timeout: number }[]) { return a.length; }"],
];
/** Where that scope is: `@P` its parameters, `@B` its body, `@U` the use.
 *  The last declares AFTER the `return` — a hoisted `function` only. */
const SCOPES: readonly string[] = [
  `export function run(@P) { @B return @U; }`,
  `export const run = (@P) => { @B return @U; };`,
  `export const run = async function (@P) { @B return @U; };`,
  `export const run = { go(@P) { @B return @U; } };`,
  `export class A { go(@P) { @B return @U; } }`,
  `export const run = () => [1].map(() => (@P) => { @B return @U; });`,
  `export function run(@P) { return @U; @B }`,
];
const TOP =
  `export const top = () => call({ timeout: 1 }, () => Promise.resolve(1));\n`;
BINDS.forEach(([params, body], b) => {
  SCOPES.forEach((scope, s) => {
    if (s === SCOPES.length - 1 && !body.startsWith("function")) return;
    const inner = scope.replace("@P", params).replace("@B", body)
      .replace("@U", "call({ timeout: 5 })") + "\n";
    // aio's use before the scope, and after it.
    const src = (b + s) % 2 ? CALL + TOP + inner : CALL + inner + TOP;
    // aio's `timeout`, left for a person, is the type error it was.
    CASES[`src/inner${b}-${s}.ts`] = {
      src,
      fixed: src,
      manual: true,
      error: "TS2561",
    };
  });
});

/** aio's `call`: the one key renamed. */
const AIOS: readonly string[] = [
  `export const r = () => call({ timeout: 5 }, () => Promise.resolve(1));`,
  `export const r = (ok: boolean) =>\n  ok ? call({ timeout: 5 }, () => Promise.resolve(1)) : null;`,
  `export const r = { a: call({ timeout: 5 }, () => Promise.resolve(1)) };`,
  `export class B {\n  x = 1\n  call(o: { timeout: number }) { return o.timeout + this.x }\n}\nexport const r = () =>\n  call({ timeout: 5 }, () => Promise.resolve(1))`,
];
AIOS.forEach((aio, i) => {
  const src = `import { call } from "aio";\n` + aio + "\n";
  CASES[`src/aio${i}.ts`] = {
    src,
    fixed: src.replace("call({ timeout: 5 }", "call({ timeoutMs: 5 }"),
  };
});

// ── GROUND TRUTH: the road a name takes into a file × the rule on it ──
// The generator knows what the linter has to work out: for every file,
// whether the name IS aio's (`true`), is NOT (`false`), or cannot be known
// from what a lint run holds (`null`). Three invariants follow, whatever the
// road and whatever the rule:
//   false → the file is byte-identical — silent where the linter can PROVE
//           it is not aio's, `[manual]` where it cannot;
//   true  → it is reported — fixed, or `[manual]` — never silent;
//   null  → it is `[manual]`, never rewritten.
// `does` pins which one a file gets: a rewrite takes a narrow, positive
// proof, and everything short of it is left as written.
type Truth = true | false | null;
type Does = "fixed" | "manual" | "silent";
type Rule = {
  name: string;
  ext: "ts" | "tsx";
  /** A type: no dynamic import hands one over. */
  type?: true;
  /** The use; `@` is where a namespace goes. */
  expr: string;
  line: (expr: string) => string;
  /** What is gone from a fixed file. */
  old: string;
};
type Road = {
  truth: Truth;
  does: Does;
  /** …except for these rules (by index in `RULES`). */
  per?: Record<number, Does>;
  head: (rule: Rule) => string;
  at?: string;
  /** The whole statement, when the road changes its shape. */
  wrap?: (rule: Rule, expr: string) => string;
  /** No type can take this road. */
  values?: true;
  only?: string;
  project?: "mapped";
  /** `deno check` cannot resolve what this road imports (no network). */
  unresolved?: true;
};
const named = (rule: Rule, spec: string, extra = "") =>
  `import ${extra}{ ${
    rule.type ? "type " : ""
  }${rule.name} } from "${spec}";\n`;
const DECLARED: Record<string, string> = {
  useCell:
    `function useCell<T>(c: T): { state: T } {\n  return { state: c };\n}\n`,
  call:
    `const call = (o: { timeout: number }, f: () => unknown) => [o.timeout, f];\n`,
  schedule: `const schedule = {
  poll: (
    id: string,
    n: number,
    a: { type: string },
    o: { every: number; backoff: number },
  ) => [id, n, a, o],
  blocking: (id: string, f: () => number, n: number) => f() + n + id.length,
};
`,
  ExtractState:
    `type ExtractState<T> = T extends { state: infer S } ? S : never;\n`,
};
const OWN_API = Object.values(DECLARED).map((d) => `export ${d}`).join("");
const ROADS: Record<string, Road> = {
  // ── aio's, proven ──
  named: { truth: true, does: "fixed", head: (r) => named(r, "aio") },
  space: {
    truth: true,
    does: "fixed",
    head: () => `import * as fw from "aio";\n`,
    at: "fw.",
  },
  defaultNamed: {
    truth: true,
    does: "fixed",
    head: (r) => named(r, "aio", "aio, ") + `export const k = aio;\n`,
  },
  alias: { truth: true, does: "fixed", head: (r) => named(r, "fw") },
  aliasInMapFile: {
    truth: true,
    does: "fixed",
    head: (r) => named(r, "fw"),
    project: "mapped",
  },
  prefix: { truth: true, does: "fixed", head: (r) => named(r, "fwdir/mod.ts") },
  longestPrefix: {
    truth: true,
    does: "fixed",
    head: (r) => named(r, "@/fw/mod.ts"),
  },
  // A barrel that NAMES what it re-exports hands on exactly those names:
  // an option of aio's `call` is fixed through it; `blocking` (which it does
  // not list) and a renamed word (which it lists by its OLD name) are not.
  barrelNamed: {
    truth: true,
    does: "fixed",
    per: { 3: "manual", 4: "manual" },
    head: (r) => named(r, "./lib/named.ts"),
  },
  barrelStar: {
    truth: true,
    does: "fixed",
    head: (r) => named(r, "./lib/star.ts"),
  },
  barrelStarSpace: {
    truth: true,
    does: "fixed",
    head: () => `import * as fw from "./lib/star.ts";\n`,
    at: "fw.",
  },
  barrelThroughMap: {
    truth: true,
    does: "fixed",
    head: (r) => named(r, "@/lib/star.ts"),
  },
  // …where the map file's own directory is what its targets start from.
  barrelThroughMapFile: {
    truth: true,
    does: "fixed",
    head: (r) => named(r, "@lib/star.ts"),
    project: "mapped",
  },
  // ── aio's, but nothing in the file proves it ──
  // `await import(…)` binds inside one function; which uses it reaches is a
  // question of scope.
  dynamicDestructured: {
    truth: true,
    does: "manual",
    head: (r) => `const { ${r.name} } = await import("aio");\n`,
    values: true,
  },
  dynamicBound: {
    truth: true,
    does: "manual",
    head: () => `const fw = await import("aio");\n`,
    at: "fw.",
    values: true,
  },
  // The import is aio's, and the name is also written where it is not,
  // positively, a use of that import.
  passedAlong: {
    truth: true,
    does: "manual",
    head: (r) => named(r, "aio") + `export const kept = [${r.name}];\n`,
    values: true,
  },
  shorthand: {
    truth: true,
    does: "manual",
    head: (r) => named(r, "aio") + `export const api = { ${r.name} };\n`,
    values: true,
  },
  reexported: {
    truth: true,
    does: "manual",
    head: (r) => named(r, "aio") + `export { ${r.name} };\n`,
  },
  innerDeclarator: {
    truth: true,
    does: "manual",
    head: (r) =>
      named(r, "aio") +
      `export function inner(x: unknown) {\n  const n = 1, ${r.name} = x;\n  return [n, ${r.name}];\n}\n`,
    values: true,
  },
  innerDynamic: {
    truth: true,
    does: "manual",
    head: (r) =>
      named(r, "aio") +
      `export async function inner() {\n  const { ${r.name} } = await import("./own-api.ts");\n  return ${r.name};\n}\n`,
    values: true,
  },
  genericParameter: {
    truth: true,
    does: "manual",
    head: (r) =>
      named(r, "aio") +
      `export function id<${r.name}>(x: ${r.name}): ${r.name} {\n  return x;\n}\n`,
  },
  dynamicThen: {
    truth: true,
    does: "manual",
    head: () => "",
    wrap: (r, expr) =>
      `export const e = import("aio").then(({ ${r.name} }) => ${expr});\n`,
    values: true,
  },
  derivedDestructure: {
    truth: true,
    does: "manual",
    head: (r) => `import * as a from "aio";\nconst { ${r.name} } = a;\n`,
    values: true,
  },
  derivedAssign: {
    truth: true,
    does: "manual",
    head: (r) => `import * as a from "aio";\nconst ${r.name} = a.${r.name};\n`,
    values: true,
  },
  dynamicTwoStep: {
    truth: true,
    does: "manual",
    head: (r) => `const m = await import("aio");\nconst { ${r.name} } = m;\n`,
    values: true,
  },
  parenSpace: {
    truth: true,
    does: "manual",
    head: () => `import * as fw from "aio";\n`,
    at: "(fw).",
    values: true,
  },
  importType: {
    truth: true,
    does: "manual",
    head: () => "",
    at: `import("aio").`,
    only: "ExtractState",
  },
  keyed: {
    truth: true,
    does: "manual",
    head: (r) =>
      named(r, "aio") +
      `export type M = { ExtractState: number };\nexport const read = (m: M) => m.ExtractState;\n`,
    only: "ExtractState",
  },
  // ── cannot be known from what the run holds ──
  // Nothing in the file binds the name: a global, an import that went.
  unbound: { truth: null, does: "manual", head: () => "" },
  barrelOutside: {
    truth: null,
    does: "manual",
    head: (r) => named(r, "../../outside/aio.ts"),
  },
  barrelOutsideSpace: {
    truth: null,
    does: "manual",
    head: () => `import * as fw from "../../outside/aio.ts";\n`,
    at: "fw.",
  },
  unlisted: {
    truth: null,
    does: "manual",
    head: (r) => named(r, "mystery"),
    unresolved: true,
  },
  // ── not aio's, proven ──
  otherPackage: {
    truth: false,
    does: "silent",
    head: (r) => named(r, "npm:other-lib@1"),
    unresolved: true,
  },
  otherPackageThroughMap: {
    truth: false,
    does: "silent",
    head: (r) => named(r, "otherlib"),
    unresolved: true,
  },
  declared: { truth: false, does: "silent", head: (r) => DECLARED[r.name]! },
  ownModule: {
    truth: false,
    does: "silent",
    head: (r) => named(r, "./own-api.ts"),
  },
  ownSpace: {
    truth: false,
    does: "silent",
    head: () => `import * as lib from "./own-api.ts";\n`,
    at: "lib.",
  },
  member: {
    truth: false,
    does: "silent",
    head: () => `import * as lib from "./own-api.ts";\nconst deps = { lib };\n`,
    at: "deps.lib.",
    values: true,
  },
  memberBesideAios: {
    truth: false,
    does: "silent",
    head: (r) =>
      `import * as lib from "./own-api.ts";\nimport { cell } from "aio";\n` +
      `const deps = { lib, ${r.name}: 1, cell };\nexport const keep = deps.${r.name};\n`,
    at: "deps.lib.",
    values: true,
  },
  ownKey: {
    truth: false,
    does: "silent",
    head: () =>
      `export type M = { ExtractState: number };\nexport const read = (m: M) => m.ExtractState;\ntype Own<T> = T;\n`,
    wrap: () => `export type S = Own<M["ExtractState"]>;\n`,
    only: "ExtractState",
  },
};
const RULES: readonly Rule[] = [
  {
    name: "useCell",
    ext: "tsx",
    expr: `@useCell(counter).state.count`,
    line: (e) => `export const V = () => <p>{${e}}</p>;\n`,
    old: "useCell(counter).state",
  },
  {
    name: "call",
    ext: "ts",
    expr: `@call({ timeout: 5 }, () => Promise.resolve(1))`,
    line: (e) => `export const r = () => ${e};\n`,
    old: "timeout: 5",
  },
  {
    name: "schedule",
    ext: "ts",
    expr: `@schedule.poll("p", 0, { type: "t" }, { every: 9, backoff: 2 })`,
    line: (e) => `export const p = () => ${e};\n`,
    old: "backoff: 2",
  },
  {
    name: "schedule",
    ext: "ts",
    expr: `@schedule.blocking("id", () => 1, 0)`,
    line: (e) => `export const b = () => ${e};\n`,
    old: "schedule.blocking(",
  },
  {
    name: "ExtractState",
    ext: "ts",
    type: true,
    expr: `@ExtractState<{ state: number }>`,
    line: (e) => `export type S = ${e};\n`,
    old: "ExtractState",
  },
];
type Generated = Road & { rule: Rule; src: string };
const TRUTH: Record<string, Generated> = {};
for (const [name, road] of Object.entries(ROADS)) {
  RULES.forEach((rule, i) => {
    if (road.values && rule.type) return;
    if (road.only && road.only !== rule.name) return;
    const expr = rule.expr.replaceAll("@", road.at ?? "");
    TRUTH[`src/t-${name}-${i}.${rule.ext}`] = {
      ...road,
      does: road.per?.[i] ?? road.does,
      rule,
      src: road.head(rule) + (rule.ext === "tsx" ? CELL : "") +
        (road.wrap?.(rule, expr) ?? rule.line(expr)),
    };
  });
}
/** What both projects hold beside the generated files. */
const SHARED: Record<string, string> = {
  "src/cell.ts":
    `import { cell } from "aio";\nexport const counter = cell("counter", {\n  state: { count: 0 },\n  methods: { increment(s: { count: number }) { s.count++; } },\n});\n`,
};
const BARRELS: Record<string, string> = {
  "src/own-api.ts": OWN_API,
  "src/lib/star.ts": `export * from "aio";\n`,
  "src/lib/named.ts":
    `export { call, schedule } from "aio";\nexport { useCell } from "aio";\nexport type { ExtractState } from "aio";\n`,
};

// ── SHAPES: one file each, as an app writes them ─────────────────────
// Where the matrix above multiplies roads by rules, these are single files
// with their truth: wrapper barrels that override what `export *` hands on,
// declarations no declaration test ever listed, a name bound twice, uses the
// fix cannot write (and must still name), a re-export of somebody else's
// name. `does` adds `partly`: one name fixed, another left, in one file.
type Shape = {
  src: string;
  truth: Truth;
  does: Does | "partly";
  /** What the file must (not) hold afterwards. */
  has?: string[];
  lacks?: string[];
  /** `deno check` cannot take this file (a syntax error, the network). */
  unchecked?: true;
};
const BLK = `schedule.blocking("id", () => 1, 0)`;
const OWNB = `schedule.blocking("id")`;
const POLL = `schedule.poll("p", 0, { type: "t" }, { every: 9, backoff: 2 })`;
const OWN_CALL =
  `export const call = (o: { timeout: number }, f: () => unknown) => [o, f];\n`;
const F_TYPE =
  `type F = (o: { timeout: number }, f: () => unknown) => unknown;\n`;
const P1 = `() => Promise.resolve(1)`;
const shape = (
  truth: Truth,
  does: Shape["does"],
  src: string,
  more: Partial<Shape> = {},
): Shape => ({ src, truth, does, ...more });
const SHAPES: Record<string, Shape> = {
  // ── the app's own modules ──
  "src/v/cell.ts": shape(
    false,
    "silent",
    `export { counter } from "../cell.ts";\n`,
  ),
  "src/v/lib/mine.ts": shape(
    false,
    "silent",
    `export const schedule = { blocking: (id: string) => id, poll: (...a: unknown[]) => a.length };\nexport const mySchedule = schedule;\n${OWN_CALL}export const blocking = (id: string) => id;\nexport const connectDevTools = () => 1;\nexport type ExtractState<T> = T;\nexport default schedule;\n`,
  ),
  "src/v/lib/rpc.ts": shape(false, "silent", OWN_CALL),
  "src/v/lib/mine-ns.ts": shape(
    false,
    "silent",
    `export const blocking = (id: string) => id;\n`,
  ),
  "src/v/lib/typedef.ts": shape(
    false,
    "silent",
    `type T = { a: 1 };\nexport default T;\n`,
  ),
  "src/v/globals.d.ts": shape(
    false,
    "silent",
    `declare function call(o: { timeout: number }, f: () => unknown): unknown;\n`,
  ),
  // Wrappers: everything from aio — and a name of their own over it.
  "src/v/lib/over.ts": shape(
    false,
    "silent",
    `export * from "aio";\nexport { schedule, call } from "./mine.ts";\n`,
  ),
  "src/v/lib/over2.ts": shape(
    false,
    "silent",
    `export * from "aio";\nimport { mySchedule } from "./mine.ts";\nexport { mySchedule as schedule };\n`,
  ),
  "src/v/lib/over3.ts": shape(
    false,
    "silent",
    `export * from "aio";\nexport { default as schedule } from "./mine.ts";\n`,
  ),
  "src/v/lib/over4.ts": shape(
    false,
    "silent",
    `import { schedule } from "aio";\nimport { mySchedule } from "./mine.ts";\nexport { mySchedule as schedule, schedule as aioSchedule };\n`,
  ),
  "src/v/lib/over6.ts": shape(
    false,
    "silent",
    `export * from "aio";\nexport * as schedule from "./mine-ns.ts";\n`,
  ),
  "src/v/lib/over7.ts": shape(
    false,
    "silent",
    `export * from "aio";\nexport let n = 1, schedule = { blocking: (id: string) => id };\n`,
  ),
  // A barrel that hands aio's renamed words on BY NAME: itself aio's, and
  // left — whatever imports from it would have to change in the same breath.
  "src/v/lib/named.ts": shape(
    true,
    "manual",
    `export { connectDevTools, disconnectDevTools } from "aio";\nexport type { ExtractState } from "aio";\n`,
  ),
  "src/v/lib/index.ts": shape(false, "silent", `export * from "./named.ts";\n`),
  // ── through a wrapper: the name is the app's ──
  "src/v/N-over.ts": shape(
    false,
    "manual",
    `import { schedule } from "./lib/over.ts";\nexport const e = ${OWNB};\n`,
  ),
  "src/v/N-over-call.ts": shape(
    false,
    "manual",
    `import { call } from "./lib/over.ts";\nexport const r = call({ timeout: 5 }, () => 1);\n`,
  ),
  "src/v/N-over-map.ts": shape(
    false,
    "manual",
    `import { schedule } from "viaover";\nexport const e = ${OWNB};\n`,
  ),
  "src/v/N-over2.ts": shape(
    false,
    "manual",
    `import { schedule } from "./lib/over2.ts";\nexport const e = ${OWNB};\n`,
  ),
  "src/v/N-over3.ts": shape(
    false,
    "silent",
    `import { schedule } from "./lib/over3.ts";\nexport const e = ${OWNB};\n`,
  ),
  "src/v/N-over4.ts": shape(
    false,
    "manual",
    `import { schedule } from "./lib/over4.ts";\nexport const e = ${OWNB};\n`,
  ),
  "src/v/N-over6.ts": shape(
    false,
    "manual",
    `import { schedule } from "./lib/over6.ts";\nexport const e = ${OWNB};\n`,
  ),
  "src/v/N-over7.ts": shape(
    false,
    "manual",
    `import { schedule } from "./lib/over7.ts";\nexport const e = ${OWNB};\n`,
  ),
  // ── aio's import, and the app's own binding inside a function ──
  "src/v/S-static-dyn.ts": shape(
    true,
    "manual",
    `import { call } from "aio";\nexport const top = () => call({ timeoutMs: 5 }, ${P1});\nexport async function f() {\n  const { call } = await import("./lib/rpc.ts");\n  return call({ timeout: 5 }, () => 1);\n}\n`,
  ),
  "src/v/S-two-dyn.ts": shape(
    true,
    "manual",
    `export async function g() {\n  const { call } = await import("aio");\n  return call({ timeoutMs: 5 }, ${P1});\n}\nexport async function f() {\n  const { call } = await import("./lib/rpc.ts");\n  return call({ timeout: 5 }, () => 1);\n}\n`,
  ),
  "src/v/S-two-dyn-own-first.ts": shape(
    true,
    "manual",
    `export async function f() {\n  const { call } = await import("./lib/rpc.ts");\n  return call({ timeoutMs: 5 }, () => 1);\n}\nexport async function g() {\n  const { call } = await import("aio");\n  return call({ timeout: 5 }, ${P1});\n}\n`,
  ),
  "src/v/S-second-declarator.ts": shape(
    true,
    "manual",
    `import { schedule } from "aio";\nimport { schedule as mine } from "./lib/mine.ts";\nexport const outer = ${BLK};\nexport function f() {\n  const n = 1, schedule = mine;\n  return [n, ${OWNB}];\n}\n`,
  ),
  "src/v/S-inner-const.ts": shape(
    true,
    "manual",
    `import { schedule } from "aio";\nimport { schedule as mine } from "./lib/mine.ts";\nexport const outer = ${BLK};\nexport function f() {\n  const schedule = mine;\n  return [${OWNB}];\n}\n`,
  ),
  "src/v/S-forof.ts": shape(
    true,
    "manual",
    `import { schedule } from "aio";\nimport { schedule as mine } from "./lib/mine.ts";\nexport const outer = ${BLK};\nexport const f = () => { for (const schedule of [mine]) return [${OWNB}]; };\n`,
  ),
  "src/v/S-catch.ts": shape(
    true,
    "manual",
    `import { schedule } from "aio";\nexport const outer = ${BLK};\nexport const f = () => { try { throw 1; } catch (schedule) { return (schedule as { blocking(i: string): string }).blocking("id"); } };\n`,
  ),
  "src/v/S-using.ts": shape(
    true,
    "manual",
    `import { call } from "aio";\nexport const top = () => call({ timeoutMs: 5 }, ${P1});\nexport function f() {\n  using call = Object.assign((o: { timeout: number }) => o, { [Symbol.dispose]() {} });\n  return call({ timeout: 5 });\n}\n`,
  ),
  "src/v/S-enum-member.ts": shape(
    true,
    "manual",
    `import { schedule } from "aio";\nexport enum E { schedule, call }\nexport const outer = ${BLK};\n`,
  ),
  // ── the app's own, bound in a way no declaration test lists ──
  "src/v/N-bom-other.ts": shape(
    false,
    "silent",
    `﻿import { call } from "./lib/rpc.ts";\r\nexport const r = call({ timeout: 5 }, () => 1);\r\n`,
  ),
  "src/v/N-mapped-own.ts": shape(
    false,
    "silent",
    `import { schedule } from "mylib";\nexport const e = ${OWNB};\n`,
  ),
  "src/v/N-prefix-own.ts": shape(
    false,
    "silent",
    `import { schedule } from "@/v/lib/mine.ts";\nexport const e = ${OWNB};\n`,
  ),
  "src/v/N-second-declarator.ts": shape(
    false,
    "manual",
    `import { call as mk } from "./lib/rpc.ts";\nlet n = 1, call = mk;\nexport const r = call({ timeout: 5 }, () => n++);\n`,
  ),
  "src/v/N-var-list.ts": shape(
    false,
    "manual",
    `import { call as mk } from "./lib/rpc.ts";\nlet n, call: typeof mk;\ncall = mk;\nexport const r = call({ timeout: 5 }, () => n);\n`,
  ),
  "src/v/N-import-equals.ts": shape(
    false,
    "silent",
    `// deno-lint-ignore no-namespace\nnamespace Lib {\n  ${OWN_CALL}}\nimport call = Lib.call;\nexport const r = call({ timeout: 5 }, () => 1);\n`,
  ),
  "src/v/N-param-prop.ts": shape(
    false,
    "manual",
    `${F_TYPE}export class K {\n  r: unknown;\n  constructor(private call: F) {\n    this.r = call({ timeout: 5 }, () => 1);\n  }\n  again() { return this.call; }\n}\n`,
  ),
  "src/v/N-for-init.ts": shape(
    false,
    "manual",
    `import { call as mk } from "./lib/rpc.ts";\nexport const out: unknown[] = [];\nfor (let i = 0, call = mk; i < 1; i++) out.push(call({ timeout: 5 }, () => i));\n`,
  ),
  "src/v/N-deep-param.ts": shape(
    false,
    "manual",
    `${F_TYPE}export const g = ({ a: { b: call } }: { a: { b: F } }) => call({ timeout: 5 }, () => 1);\n`,
  ),
  "src/v/N-arr-in-obj-param.ts": shape(
    false,
    "manual",
    `${F_TYPE}export const g = ({ x: [call] }: { x: [F] }) => call({ timeout: 5 }, () => 1);\n`,
  ),
  // …and a global, which only `globals.d.ts` declares.
  "src/v/N-global.ts": shape(
    false,
    "manual",
    `export const r = call({ timeout: 5 }, () => 1);\n`,
  ),
  // aio's `schedule` handed on as a value is a use nothing here reads: said.
  "src/v/N-own-prop-and-aio.ts": shape(
    false,
    "manual",
    `import { schedule } from "aio";\nimport * as third from "./lib/mine.ts";\nexport const e = third.${OWNB};\nexport const k = schedule;\nexport const z = third.default.blocking("z");\n`,
  ),
  "src/v/N-strings.ts": shape(
    false,
    "silent",
    `export const a = "schedule.blocking(1) call({ timeout: 5 }) CellAccess connectDevTools";\n// schedule.blocking("x"); useCell(c).state.x\n/* call({ timeout: 5 }) */\nexport const t = \`ExtractState \${1} connectDevTools()\`;\nexport const r = /call\\(\\{ timeout: 5 \\}\\)/;\n`,
  ),
  "src/v/N-computed-key.ts": shape(
    false,
    "silent",
    `const connectDevTools = "k";\nexport const o = { [connectDevTools]: 1 };\nexport class CellAccess { static [connectDevTools] = 2; }\n`,
  ),
  "src/v/N-label.ts": shape(
    false,
    "silent",
    `export function f() {\n  schedule: for (;;) { break schedule; }\n  call: { break call; }\n}\n`,
  ),
  "src/v/N-ts-namespace.ts": shape(
    false,
    "silent",
    `// deno-lint-ignore no-namespace\nexport namespace Lib {\n  export const schedule = { blocking: (id: string) => id };\n  export const e = ${OWNB};\n}\n`,
  ),
  "src/v/N-class-static.ts": shape(
    false,
    "silent",
    `export class schedule {\n  static blocking(id: string) { return id; }\n}\nexport const e = ${OWNB};\n`,
  ),
  "src/v/N-this-and-super.ts": shape(
    false,
    "silent",
    `class B { schedule = { blocking: (id: string) => id }; call(o: { timeout: number }) { return o; } }\nexport class D extends B {\n  go() { return [this.${OWNB}, super.call({ timeout: 5 }), this.call({ timeout: 5 })]; }\n}\n`,
  ),
  "src/v/N-minified.ts": shape(
    false,
    "silent",
    `import{call}from"./lib/rpc.ts";export const r=call({timeout:5},()=>1);\n`,
  ),
  "src/v/N-string-import.ts": shape(
    false,
    "manual",
    `import { "call" as call } from "./lib/rpc.ts";\nexport const r = call({ timeout: 5 }, () => 1);\n`,
  ),
  "src/v/N-default-plus.ts": shape(
    false,
    "manual",
    `import schedule, { call } from "./lib/mine.ts";\nexport const e = ${OWNB};\nexport const r = call({ timeout: 5 }, () => 1);\n`,
  ),
  "src/v/N-type-default.ts": shape(
    false,
    "manual",
    `import type ExtractState from "./lib/typedef.ts";\nexport type S = ExtractState;\n`,
  ),
  // A type PARAMETER called like a renamed word is a declaration.
  "src/v/N-generic-param.ts": shape(
    false,
    "manual",
    `export type Box<ExtractState> = { v: ExtractState };\nexport function id<CellAccess>(x: CellAccess): CellAccess { return x; }\n`,
  ),
  "src/v/N-syntax-error.ts": shape(
    false,
    "silent",
    `import { call } from "./lib/rpc.ts";\nexport const r = call({ timeout: 5 }, () => 1;\nconst x = {{{ ;\n`,
    { unchecked: true },
  ),
  // ── aio's `schedule.blocking(`, and a `blocking` the file already has ──
  "src/v/T-local-blocking.ts": shape(
    true,
    "manual",
    `import { schedule } from "aio";\nconst blocking = true;\nexport const e = ${BLK};\nexport const b = blocking;\n`,
  ),
  "src/v/T-imported-blocking.ts": shape(
    true,
    "manual",
    `import { schedule } from "aio";\nimport { blocking } from "./lib/mine.ts";\nexport const e = ${BLK};\nexport const b = blocking("x");\n`,
  ),
  "src/v/T-param-blocking.ts": shape(
    true,
    "manual",
    `import { schedule } from "aio";\nexport const run = (blocking: boolean) => blocking ? ${BLK} : null;\n`,
  ),
  // …and where `blocking` goes: beside the `schedule` it replaces, never
  // into an `import type`, and nowhere when the call goes through a namespace.
  "src/v/T-type-first.ts": shape(
    true,
    "fixed",
    `import type { Effect } from "aio";\nimport { schedule } from "aio";\nexport const e = ${BLK};\nexport type E = Effect;\n`,
    {
      has: [
        `import type { Effect } from "aio";\nimport { schedule, blocking } from "aio";`,
      ],
    },
  ),
  "src/v/T-ns-only.ts": shape(
    true,
    "fixed",
    `import * as aio from "aio";\nexport const e = aio.${BLK};\n`,
    {
      has: [`aio.blocking("id"`],
      lacks: ["import { blocking }", "{ blocking"],
    },
  ),
  "src/v/T-default-and-ns.ts": shape(
    true,
    "fixed",
    `import aio, * as ns from "aio";\nexport const k = aio;\nexport const e = ns.${BLK};\n`,
    { has: [`ns.blocking("id"`], lacks: ["import { blocking }", "{ blocking"] },
  ),
  // …and never beside a `schedule` that came from a SUB-entry of aio:
  // `blocking` is in the main entry only.
  "src/v/T-sub-entry.ts": shape(
    true,
    "manual",
    `import { schedule } from "aio/extras";\nexport const e = ${BLK};\n`,
  ),
  "src/v/lib/sub.ts": shape(false, "silent", `export * from "aio/extras";\n`),
  "src/v/T-sub-barrel.ts": shape(
    true,
    "manual",
    `import { schedule } from "./lib/sub.ts";\nexport const e = ${BLK};\n`,
  ),
  "src/v/A-nonnull-ns.ts": shape(
    true,
    "fixed",
    `import * as aio from "aio";\nexport const e = aio!.${BLK};\n`,
    { has: [`aio!.blocking("id"`], lacks: ["{ blocking"] },
  ),
  // ── aio's `call`, with the option written a way the fix does not write ──
  "src/v/T-both-keys.ts": shape(
    true,
    "manual",
    `import { call } from "aio";\nexport const r = () => call({ timeout: 5, timeoutMs: 6 }, ${P1});\n`,
  ),
  "src/v/T-shorthand.ts": shape(
    true,
    "manual",
    `import { call } from "aio";\nexport const r = (timeout: number) => call({ timeout }, ${P1});\n`,
  ),
  "src/v/T-shorthand-multi.ts": shape(
    true,
    "manual",
    `import { call } from "aio";\nexport const r = (timeout: number, name: string) => call({ name, timeout, }, ${P1});\n`,
  ),
  "src/v/A-quoted.ts": shape(
    true,
    "manual",
    `import { call } from "aio";\nexport const r = () => call({ "timeout": 5 }, ${P1});\n`,
  ),
  "src/v/A-computed.ts": shape(
    true,
    "manual",
    `import { call } from "aio";\nexport const r = () => call({ ["timeout"]: 5 }, ${P1});\n`,
  ),
  "src/v/A-opts-var.ts": shape(
    true,
    "manual",
    `import { call } from "aio";\nconst opts = { timeout: 5 };\nexport const r = () => call(opts, ${P1});\n`,
  ),
  "src/v/A-spread-then.ts": shape(
    true,
    "fixed",
    `import { call } from "aio";\nconst base = { name: "x" };\nexport const r = () => call({ ...base, timeout: 5 }, ${P1});\n`,
    { has: ["{ ...base, timeoutMs: 5 }"] },
  ),
  // ── a renamed word through a module that lists it, or two hops away ──
  "src/v/T-two-hop.ts": shape(
    true,
    "manual",
    `import { connectDevTools } from "./lib/index.ts";\nexport const on = () => connectDevTools();\n`,
  ),
  "src/v/T-named-key.ts": shape(
    true,
    "manual",
    `import { connectDevTools } from "./lib/named.ts";\nexport const o = { connectDevTools: true };\nexport const on = () => connectDevTools();\n`,
  ),
  "src/v/T-named-plain.ts": shape(
    true,
    "manual",
    `import { connectDevTools } from "./lib/named.ts";\nexport const on = () => connectDevTools();\n`,
  ),
  "src/v/T-named-type.ts": shape(
    true,
    "manual",
    `import type { ExtractState } from "./lib/index.ts";\nimport { counter } from "./cell.ts";\nexport type S = ExtractState<typeof counter>;\n`,
  ),
  // ── aio's, in every layout: fixed ──
  "src/v/A-template.ts": shape(
    true,
    "fixed",
    `import { schedule } from "aio";\nexport const s = \`a.\${${BLK}}.\${ ${BLK} }\`;\n`,
    { lacks: ["schedule.blocking("], has: ["`a.${blocking("] },
  ),
  "src/v/A-crlf.ts": shape(
    true,
    "fixed",
    `import { call, schedule } from "aio";\r\nexport const e = ${BLK};\r\nexport const r = () =>\r\n  call({\r\n    timeout: 5,\r\n  }, ${P1});\r\n`,
    { has: ["    timeoutMs: 5,\r\n", `export const e = blocking("id"`] },
  ),
  "src/v/A-class-field.ts": shape(
    true,
    "fixed",
    `import { schedule } from "aio";\nexport class K {\n  e = ${BLK}\n  f = ${BLK};\n  static g = ${BLK};\n}\n`,
    { lacks: ["schedule.blocking("] },
  ),
  "src/v/A-block-first.ts": shape(
    true,
    "fixed",
    `import { call, schedule } from "aio";\nexport const f = () => { ${BLK}; };\nexport const g = () => { call({ timeout: 5 }, ${P1}); };\nexport const h = () => {\n  call({ timeout: 5 }, ${P1})\n}\n`,
    { lacks: ["schedule.blocking(", "timeout:"] },
  ),
  "src/v/A-unicode.ts": shape(
    true,
    "fixed",
    `import { schedule } from "aio";\nconst ünï = { ψ: "…".length };\nexport const e = [ünï.ψ, ${BLK}];\n// 😀 schedule.blocking("x")\nexport const s = "😀 schedule.blocking(1)";\nexport const r = /schedule.blocking\\(/;\n`,
    {
      has: [
        `[ünï.ψ, blocking("id"`,
        `// 😀 schedule.blocking("x")\nexport const s = "😀 schedule.blocking(1)";\nexport const r = /schedule.blocking\\(/;`,
      ],
    },
  ),
  "src/v/A-typeof.ts": shape(
    true,
    "fixed",
    `import { connectDevTools, type ExtractState } from "aio";\nimport { counter } from "./cell.ts";\nexport type T = typeof connectDevTools;\nexport type S = ExtractState<typeof counter>;\nexport { connectDevTools as cdt };\n`,
    {
      has: [
        `import { connectReduxDevTools, type StateOf } from "aio";`,
        `export { connectReduxDevTools as cdt };`,
      ],
    },
  ),
  "src/v/A-long.ts": shape(
    true,
    "fixed",
    `import { schedule } from "aio";\nexport const e = [${
      Array(400).fill(`"${"x".repeat(40)}"`).join(", ")
    }, ${BLK}];\n`,
    { lacks: ["schedule.blocking("] },
  ),
  // One name fixed, another left, in one file — each all or nothing.
  "src/v/A-jsx-member.tsx": shape(
    true,
    "partly",
    `import * as aio from "aio";\nimport { connectDevTools } from "aio";\nconst UI = { Box: (p: { on?: unknown; children?: unknown }) => <div>{p.children as string}</div> };\nexport const V = () => <UI.Box on={connectDevTools}>{String(aio.${BLK})}</UI.Box>;\n`,
    {
      has: [
        `import { connectDevTools } from "aio";`,
        `on={connectDevTools}`,
        `aio.blocking("id"`,
      ],
    },
  ),
  "src/v/A-syntax-error.ts": shape(
    true,
    "fixed",
    `import { call } from "aio";\nexport const r = () => call({ timeout: 5 }, ${P1};\nfunction (\n`,
    { has: ["call({ timeoutMs: 5 }"], unchecked: true },
  ),
  // ── a second app-shaped tree: a wrapper barrel for everything ──
  "src/w/cell.ts": shape(
    false,
    "silent",
    `export { counter } from "../cell.ts";\n`,
  ),
  "src/w/fw.ts": shape(
    false,
    "silent",
    `export * from "aio";\nexport { useCell } from "./hooks.ts";\nexport { schedule, call } from "./own.ts";\nexport { connectDevTools } from "./own.ts";\nexport type { ExtractState } from "./own.ts";\nexport { myCell as cell } from "./own.ts";\n`,
  ),
  "src/w/hooks.ts": shape(
    false,
    "silent",
    `export const useCell = <T,>(c: T) => ({ state: { count: 1, c } });\n`,
  ),
  "src/w/own.ts": shape(
    false,
    "silent",
    `export const schedule = { blocking: (...a: unknown[]) => a, poll: (...a: unknown[]) => a.length, after: (...a: unknown[]) => a };\n${OWN_CALL}export const connectDevTools = () => 1;\nexport type ExtractState<T> = T;\nexport const myCell = (name: string, o: { state: unknown; ui: string[]; methods: Record<string, (...a: never[]) => unknown> }) => ({ name, ...o });\n`,
  ),
  "src/w/N-usecell.tsx": shape(
    false,
    "manual",
    `import { useCell } from "./fw.ts";\nimport { counter } from "./cell.ts";\nexport const V = () => <p>{useCell(counter).state.count}</p>;\n`,
  ),
  "src/w/N-call.ts": shape(
    false,
    "manual",
    `import { call } from "./fw.ts";\nexport const r = () => call({ timeout: 5 }, () => 1);\n`,
  ),
  "src/w/N-poll.ts": shape(
    false,
    "manual",
    `import { schedule } from "./fw.ts";\nexport const p = () => ${POLL};\n`,
  ),
  "src/w/N-blocking.ts": shape(
    false,
    "manual",
    `import { schedule } from "./fw.ts";\nexport const b = () => ${BLK};\n`,
  ),
  "src/w/N-word.ts": shape(
    false,
    "manual",
    `import { connectDevTools, type ExtractState } from "./fw.ts";\nexport type S = ExtractState<number>;\nexport const on = () => connectDevTools();\n`,
  ),
  "src/w/N-cell-ui.ts": shape(
    false,
    "manual",
    `import { cell } from "./fw.ts";\nexport const g = cell("grid", {\n  state: { a: 1, b: 2 },\n  ui: ["a"],\n  methods: {},\n});\n`,
  ),
  "src/w/N-return-effect.ts": shape(
    false,
    "manual",
    `import { cell, schedule } from "./fw.ts";\nexport const h = cell("h", {\n  state: { a: 1 },\n  ui: [],\n  methods: {\n    tick(_s: { a: number }) {\n      return schedule.after("t", 5, { type: "h:x" });\n    },\n  },\n});\n`,
  ),
  // A barrel that DECLARES the name in an export of its own: proven the
  // app's, and silent.
  "src/w/fw2.ts": shape(
    false,
    "silent",
    `export * from "aio";\nexport const schedule = { blocking: (...a: unknown[]) => a };\nexport function useCell<T>(c: T) { return { state: { count: 1, c } }; }\n`,
  ),
  "src/w/N-declared-barrel.tsx": shape(
    false,
    "silent",
    `import { schedule, useCell } from "./fw2.ts";\nimport { counter } from "./cell.ts";\nexport const b = () => ${BLK};\nexport const V = () => <p>{useCell(counter).state.count}</p>;\n`,
  ),
  // …and one that only passes aio on: really aio's, fixed.
  "src/w/fw3.ts": shape(false, "silent", `export * from "aio";\n`),
  "src/w/A-star-barrel.ts": shape(
    true,
    "fixed",
    `import { call, schedule } from "./fw3.ts";\nexport const b = () => ${BLK};\nexport const r = () => call({ timeout: 5 }, ${P1});\n`,
    {
      has: [`import { call, schedule, blocking } from "./fw3.ts";`],
      lacks: ["schedule.blocking(", "timeout:"],
    },
  ),
  // In a template's `${…}`: fixed where the fix edits text, named where it
  // reads arguments.
  "src/w/A-tpl-usecell.tsx": shape(
    true,
    "fixed",
    `import { useCell } from "aio";\nimport { counter } from "./cell.ts";\nexport const V = () => <p>{\`n=\${useCell(counter).state.count}\`}</p>;\n`,
    { lacks: ["useCell"] },
  ),
  "src/w/A-tpl-call.ts": shape(
    true,
    "manual",
    `import { call } from "aio";\nexport const r = async () => \`v=\${await call({ timeout: 5 }, ${P1})}\`;\n`,
  ),
  "src/w/A-tpl-poll.ts": shape(
    true,
    "manual",
    `import { schedule } from "aio";\nexport const p = () => \`\${String(${POLL})}\`;\n`,
  ),
  "src/w/A-tpl-blocking.ts": shape(
    true,
    "fixed",
    `import { schedule } from "aio";\nexport const b = () => \`\${String(${BLK})}\`;\n`,
    { lacks: ["schedule.blocking("] },
  ),
  "src/w/A-tpl-word.ts": shape(
    true,
    "fixed",
    `import { connectDevTools } from "aio";\nexport const on = () => \`\${connectDevTools()}\`;\n`,
    {
      has: [
        `import { connectReduxDevTools } from "aio";`,
        "`${connectReduxDevTools()}`",
      ],
    },
  ),
  "src/w/A-tpl-tagged.tsx": shape(
    true,
    "fixed",
    `import { useCell } from "aio";\nimport { counter } from "./cell.ts";\nconst css = (s: TemplateStringsArray, ...v: unknown[]) => s.join(String(v));\nexport const k = () => css\`width: \${useCell(counter).state.count}px\`;\n`,
    { lacks: ["useCell"] },
  ),
  // ── re-exports of somebody else's name, and a module only known at run
  //    time ──
  "src/x/lib/rpc.ts": shape(
    false,
    "silent",
    `${OWN_CALL}export const schedule = { blocking: (...a: unknown[]) => a };\nexport const connectDevTools = () => 1;\n`,
  ),
  "src/x/api.ts": shape(
    false,
    "silent",
    `export { connectDevTools } from "./lib/rpc.ts";\n`,
  ),
  "src/x/use.ts": shape(
    false,
    "manual",
    `import { connectDevTools } from "./api.ts";\nexport const on = () => connectDevTools();\n`,
  ),
  "src/x/N-reexport-npm.ts": shape(
    false,
    "silent",
    `export { connectDevTools, type CellAccess } from "npm:some-devtools@1";\n`,
    { unchecked: true },
  ),
  "src/x/N-reexport-as.ts": shape(
    false,
    "silent",
    `export { connectDevTools as connect } from "./lib/rpc.ts";\nexport * as connectDevTools from "./lib/rpc.ts";\n`,
  ),
  "src/x/fw.ts": shape(
    false,
    "silent",
    `export * from "aio";\nexport { call } from "./lib/rpc.ts";\n`,
  ),
  "src/x/use-fw.ts": shape(
    false,
    "manual",
    `import { call } from "./fw.ts";\nexport const r = call({ timeout: 5 }, () => 1);\n`,
  ),
  "src/x/U-dyn-nonliteral.ts": shape(
    null,
    "manual",
    `const spec = "./lib/rpc.ts";\nconst m = await import(spec);\nexport const r = m.call({ timeout: 5 }, () => 1);\nconst { call } = await import(spec);\nexport const q = call({ timeout: 5 }, () => 1);\n`,
  ),
};

// ── JSX PROSE: what an element shows is not code, and hides none ─────
// Text in an element may hold anything a lexer takes for the start of a
// literal or a comment: an apostrophe, the `//` of a URL, one backtick,
// `/*`. Lexed as code, each blanks what follows it on the line — here a
// callback's parameter named like aio's export, whose body on the NEXT line
// then read as a use of aio's and was rewritten. Per kind of prose and per
// rule, two files with their truth:
//   `hidden` — aio's use, and the app's own parameter of the same name
//              declared after the prose: nothing is rewritten, `[manual]`;
//   `plain`  — aio's use standing after the prose: fixed (a mention of the
//              name IN the prose, written like a declaration, is `[manual]`).
const J_CELL = `import { counter } from "../cell.ts";\n`;
const J_SCHEDULE = `import { schedule } from "aio";\n`;
const J_RULES: {
  id: string;
  head: string;
  /** aio's use, as an expression. */
  use: string;
  /** The app's own: a callback whose parameter has the name. */
  own: string;
  /** The prop the callback is called through. */
  prop: string;
}[] = [
  {
    id: "usecell",
    head: `import { useCell } from "aio";\n` + J_CELL,
    use: `useCell(counter).state.count`,
    own: `p.hooks.map((useCell) =>\n  useCell(counter).state.count)`,
    prop: `hooks: ((c: typeof counter) => { state: { count: number } })[]`,
  },
  {
    id: "call",
    head: `import { call } from "aio";\n`,
    use: `String(call({ timeout: 5 }, ${P1}))`,
    own: `p.fns.map((call) =>\n  String(call({ timeout: 5 })))`,
    prop: `fns: ((o: { timeout: number }) => unknown)[]`,
  },
  {
    id: "poll",
    head: J_SCHEDULE,
    use: `String(${POLL})`,
    own: `p.all.map((schedule) =>\n  String(${POLL}))`,
    prop:
      `all: { poll: (id: string, n: number, a: { type: string }, o: { every: number; backoff: number }) => unknown }[]`,
  },
  {
    id: "blocking",
    head: J_SCHEDULE,
    use: `String(${BLK})`,
    own: `p.all.map((schedule) =>\n  ${OWNB})`,
    prop: `all: { blocking: (id: string) => string }[]`,
  },
  {
    id: "word",
    head: `import { connectDevTools } from "aio";\n`,
    use: `String(connectDevTools())`,
    own: `p.fns.map((connectDevTools) =>\n  String(connectDevTools()))`,
    prop: `fns: (() => unknown)[]`,
  },
  {
    id: "type",
    head: `import type { ExtractState } from "aio";\n` + J_CELL,
    use: `String(null as unknown as ExtractState<typeof counter>)`,
    own: `p.mk(<ExtractState,>(x: ExtractState) =>\n  x as ExtractState)`,
    prop: `mk: (f: <T>(x: T) => T) => string`,
  },
];
/** `[before, after]` the expression container; `named`: the prose writes
 *  the rule's name like a declaration (`@` is the name). */
const J_PROSE: Record<string, { text: [string, string]; named?: true }> = {
  apostrophe: { text: ["Don't forget: ", ""] },
  url: { text: ["See http://x.y for ", ""] },
  backtick: { text: ["Run `am start`, then ` ", " once"] },
  block: { text: ["a /* b: ", ""] },
  braces: { text: ["{'}'} don't ", ""] },
  entity: { text: ["it&apos;s here: ", ""] },
  named: { text: ["the (@) hook's value: ", ""], named: true },
  lines: { text: ["first line\n  it's the second: ", ""] },
  around: { text: ["can't ", " won't"] },
};
for (const rule of J_RULES) {
  const name = /\{ (?:type )?([\w$]+) \}/.exec(rule.head)![1]!;
  const top = `export const A = () => <p>{${rule.use}}</p>;\n`;
  for (const [kind, prose] of Object.entries(J_PROSE)) {
    const [before, after] = prose.text.map((t) => t.replaceAll("@", name));
    SHAPES[`src/j/hidden-${kind}-${rule.id}.tsx`] = shape(
      true,
      "manual",
      rule.head + top +
        `export const B = (p: { ${rule.prop} }) => <p>${before}{${rule.own}}${after}</p>;\n`,
    );
    SHAPES[`src/j/plain-${kind}-${rule.id}.tsx`] = shape(
      true,
      prose.named ? "manual" : "fixed",
      rule.head +
        `export const B = () => <p>${before}{${rule.use}}${after}</p>;\n`,
    );
  }
  // Prose in an element that stands in an expression of another element.
  SHAPES[`src/j/hidden-nested-${rule.id}.tsx`] = shape(
    true,
    "manual",
    rule.head + top +
      `export const B = (p: { ok: boolean; ${rule.prop} }) => <p>{p.ok && <b>it's {${rule.own}}</b>} don't</p>;\n`,
  );
  SHAPES[`src/j/plain-nested-${rule.id}.tsx`] = shape(
    true,
    "fixed",
    rule.head +
      `export const B = (p: { ok: boolean }) => <p>{p.ok && <b>it's {${rule.use}}</b>} don't</p>;\n`,
  );
}
// The five files this was measured on, as written.
const J_TYPES =
  `export type Mine = { blocking(id: string): string; poll(...a: unknown[]): number; after(...a: unknown[]): unknown };
export type Rpc = (o: { timeout: number }, f?: () => unknown) => unknown;
export const mine: Mine = { blocking: (id) => id, poll: (...a) => a.length, after: (...a) => a };
export const rpc: Rpc = (o, f) => [o, f];
export const render = (f: (s: Mine) => string) => f(mine);
export const hooks = [(c: { count: number }) => ({ state: c })];
`;
Object.assign(SHAPES, {
  "src/j/lib/types.ts": shape(false, "silent", J_TYPES),
  "src/j/M-31-jsx-url.tsx": shape(
    true,
    "manual",
    `import { call } from "aio";\nimport type { Mine, Rpc } from "./lib/types.ts";\nexport const r = () => call({ timeout: 5 }, ${P1});\nexport const Links = (p: { fns: Rpc[] }) => <p>See http://x.y for {p.fns.map((call) =>\n  String(call({ timeout: 5 })))}</p>;\n`,
  ),
  "src/j/M-32-jsx-backticks.tsx": shape(
    true,
    "manual",
    `import { call } from "aio";\nimport type { Mine, Rpc } from "./lib/types.ts";\nexport const r = () => call({ timeout: 5 }, ${P1});\nexport const Help = (p: { fns: Rpc[] }) => <p>Run \`am start\`, then \` {p.fns.map((call) =>\n  String(call({ timeout: 5 })))} once</p>;\n`,
  ),
  "src/j/M-40-apostrophe-schedule.tsx": shape(
    true,
    "manual",
    `import { schedule } from "aio";\nimport { type Mine, render } from "./lib/types.ts";\nexport const top = ${BLK};\nexport const Row = (p: { who: string }) => <p>{p.who}'s next: {render((schedule: Mine) =>\n  ${OWNB})}</p>;\n`,
  ),
  "src/j/M-41-apostrophe-usecell.tsx": shape(
    true,
    "manual",
    `import { useCell } from "aio";\n${J_CELL}import { hooks } from "./lib/types.ts";\nexport const A = () => <p>{useCell(counter).state.count}</p>;\nexport const B = () => <p>Don't forget: {hooks.map((useCell) =>\n  useCell(counter).state.count)}</p>;\n`,
  ),
  "src/j/M-42-url-poll.tsx": shape(
    true,
    "manual",
    `import { schedule } from "aio";\nimport { type Mine, render } from "./lib/types.ts";\nexport const p = () => ${POLL};\nexport const L = () => <p>docs: https://x.y/z {render((schedule: Mine) =>\n  String(${POLL}))}</p>;\n`,
  ),
  // ── a call with type arguments is a call ──
  "src/j/A-call-generic.ts": shape(
    true,
    "fixed",
    `import { call } from "aio";\nexport const e = () => call<number>({ timeout: 5 }, ${P1});\nexport const f = () => call<Array<() => number> | number>({ timeout: 6 }, ${P1});\n`,
    { lacks: ["timeout:"] },
  ),
  // `blocking` takes one type argument where `schedule.blocking` took two.
  "src/j/T-blocking-generic.ts": shape(
    true,
    "manual",
    `import { schedule } from "aio";\nexport const d = schedule.blocking<number, number>("id", () => 1, 0);\n`,
  ),
  "src/j/T-usecell-generic.tsx": shape(
    true,
    "manual",
    `import { useCell as use } from "aio";\n${J_CELL}export const V = () => <p>{use<typeof counter>(counter).state.count}</p>;\n`,
  ),
  // A comparison is no type-argument list: `call` is compared here, not
  // called — a use no rule reads, and said (read as a call it would be
  // silent).
  "src/j/N-compare.ts": shape(
    false,
    "manual",
    `import { call } from "aio";\nconst a = 1, b = 2;\nexport const c = (call as unknown as number) < a || b > (a);\nexport const r = call({ retries: 1 }, ${P1});\n`,
  ),
  // ── the rules follow the LOCAL name of the binding ──
  "src/j/A-alias.ts": shape(
    true,
    "fixed",
    `import { call as c, schedule as sch } from "aio";\nexport const e = sch.blocking("id", () => 1, 0);\nexport const r = () => c({ timeout: 5 }, ${P1});\nexport const p = () => sch.poll("p", 0, { type: "t" }, { every: 9, backoff: 2 });\n`,
    {
      has: [`{ call as c, schedule as sch, blocking } from "aio"`],
      lacks: ["timeout:", "backoff:", "sch.blocking"],
    },
  ),
  "src/j/T-alias-usecell.tsx": shape(
    true,
    "manual",
    `import { useCell as use } from "aio";\n${J_CELL}export const V = () => <p>{use(counter).state.count}</p>;\n`,
  ),
  // A member named like the alias is the object's own.
  "src/j/N-alias-member.ts": shape(
    false,
    "silent",
    `import { call as c } from "aio";\nconst o = { c: (x: { timeout: number }) => x.timeout };\nexport const r = o.c({ timeout: 5 });\nexport const k = c({ retries: 1 }, ${P1});\n`,
  ),
  // The alias of ANOTHER export is not aio's `call`.
  "src/j/N-alias-other.ts": shape(
    false,
    "silent",
    `import { own as call } from "aio";\nexport const r = (call as unknown as (o: { timeout: number }) => number)({ timeout: 5 });\n`,
  ),
  // …and through the app's own barrel that renames what it hands on.
  "src/j/b/renamed.ts": shape(
    false,
    "silent",
    `export { schedule as sched, call as invoke } from "aio";\n`,
  ),
  "src/j/T-renamed.ts": shape(
    true,
    "manual",
    `import { invoke, sched } from "./b/renamed.ts";\nexport const e = sched.blocking("id", () => 1, 0);\nexport const r = () => invoke({ timeout: 5 }, ${P1});\n`,
  ),
  "src/j/T-dynamic-alias.ts": shape(
    true,
    "manual",
    `const { call: c } = await import("aio");\nexport const r = () => c({ timeout: 5 }, ${P1});\n`,
  ),
  // ── uses the rules do not read are said ──
  "src/j/T-optional.ts": shape(
    true,
    "manual",
    `import { schedule } from "aio";\nexport const a = schedule?.blocking?.("id", () => 1, 0);\n`,
  ),
  "src/j/T-bracket.ts": shape(
    true,
    "manual",
    `import { schedule } from "aio";\n// deno-lint-ignore no-explicit-any\nexport const b = (schedule as any)["blocking"]("id", () => 1, 0);\n`,
  ),
  "src/j/T-destructure.ts": shape(
    true,
    "manual",
    `import { schedule } from "aio";\nexport const { blocking } = schedule as unknown as { blocking: unknown };\n`,
  ),
  "src/j/T-value.ts": shape(
    true,
    "manual",
    `import { schedule } from "aio";\nexport const c = schedule.blocking;\nexport const d = [1].map(schedule.blocking.bind(schedule));\n`,
  ),
  "src/j/T-indirect.ts": shape(
    true,
    "manual",
    `import { call } from "aio";\nexport const d = () => (0, call)({ timeout: 5 }, ${P1});\nexport const c = () => call.apply(null, [{ timeout: 5 }, ${P1}]);\n`,
  ),
  "src/j/T-poll-built.ts": shape(
    true,
    "manual",
    `import { schedule } from "aio";\nconst o = { every: 9, backoff: 2 };\nexport const s = () => schedule.poll("p", 0, { type: "t" }, o);\n`,
  ),
  "src/j/A-multiline.ts": shape(
    true,
    "fixed",
    `import { schedule } from "aio";\nexport const d = schedule\n  .blocking("id", () => 1, 0);\nexport const e = schedule . blocking ("id", () => 1, 0);\nexport const f = schedule./* c */blocking("id", () => 1, 0);\n`,
    { lacks: ["schedule\n", "schedule ."] },
  ),
  // Uses the rules DO read, and the list that hands the name on: silent.
  "src/j/N-read.ts": shape(
    false,
    "silent",
    `import { call, schedule } from "aio";\nexport { call, schedule };\nexport const a = schedule.after("t", 5, { type: "x" });\nexport const b = call({ retries: 1 }, ${P1});\nexport const c = call<number>({ timeoutMs: 5 }, ${P1});\n`,
  ),
});

// ── The backstop: a name written where the mask blanks ───────────────
// The element reader is a best effort; the guarantee is a rule that does not
// depend on it. In a file that may hold JSX (`</` or `/>` somewhere), a name
// written ANYWHERE the mask blanks is not proven: nothing of that name is
// rewritten, and the use is `[manual]`. So the name is planted in every kind
// of blanked place, under each rule — with JSX in the file, and without
// (where the plain lexer is the language's own, and the fix runs).
const K_REGIONS: Record<string, string> = {
  "line-tail": `export const k = 1; // @ again`,
  "line-own": `// (@) => 1`,
  "line-use": `// was @(x).y`,
  block: `/* the @ */`,
  jsdoc: `/**\n * Wraps @.\n */\nexport const k = 1;`,
  double: `export const k = "@";`,
  single: `export const k = 'a (@) => b';`,
  template: "export const k = `the @`;",
  regex: `export const k = /@/;`,
};
/** Text an element shows, and an attribute's string: JSX only. */
const K_TEXT: Record<string, string> = {
  text: `<p>the @ hook</p>`,
  "text-apostrophe": `<p>don't @ it</p>`,
  "text-url": `<p>see http://x.y/ @ here</p>`,
  "text-backtick": "<p>run `@` once</p>",
  "text-block": `<p>a /* @</p>`,
  attribute: `<p title="@">x</p>`,
};
/** A generic component: its tag takes type arguments, and a string among
 *  them is more than the element reader takes — the element's text is then
 *  lexed as code. */
const K_LIST =
  `const List = <T,>(p: { items: T[]; children?: unknown }) => <ul>{String(p.children)}</ul>;\n`;
for (const rule of J_RULES) {
  const name = /\{ (?:type )?([\w$]+) \}/.exec(rule.head)![1]!;
  const top = `export const A = () => <p>{${rule.use}}</p>;\n`;
  for (const [kind, region] of Object.entries(K_REGIONS)) {
    const planted = region.replaceAll("@", name) + "\n";
    SHAPES[`src/k/jsx-${kind}-${rule.id}.tsx`] = shape(
      true,
      "manual",
      rule.head + top + planted,
    );
    SHAPES[`src/k/plain-${kind}-${rule.id}.ts`] = shape(
      true,
      "fixed",
      rule.head + `export const a = () => ${rule.use};\n` + planted,
    );
  }
  for (const [kind, el] of Object.entries(K_TEXT)) {
    SHAPES[`src/k/jsx-${kind}-${rule.id}.tsx`] = shape(
      true,
      "manual",
      rule.head + top +
        `export const K = () => ${el.replaceAll("@", name)};\n`,
    );
  }
  // A line of an element's text that starts with `//`, the callback's
  // parameter declared on it: after a comment before the root element, and
  // in an element the reader does not take.
  SHAPES[`src/k/slashes-${rule.id}.tsx`] = shape(
    true,
    "manual",
    rule.head + top +
      `export const B = (p: { ${rule.prop} }) => (\n  // layout\n  <pre>\n    // usage {${rule.own}}\n  </pre>\n);\n`,
  );
  SHAPES[`src/k/unread-tag-${rule.id}.tsx`] = shape(
    true,
    "manual",
    rule.head + K_LIST + top +
      `export const B = (p: { ${rule.prop} }) => <List<"a" | "b"> items={[]}>\n    // usage {${rule.own}}\n  </List>;\n`,
  );
}
// The name a fix would WRITE, declared where the mask blanks: inside the
// callback `blocking(…)` would call the parameter.
SHAPES["src/k/new-name-hidden.tsx"] = shape(
  true,
  "manual",
  J_SCHEDULE + K_LIST +
    `export const B = (p: { xs: ((id: string) => string)[] }) => <List<"a" | "b"> items={[]}>\n    // usage {p.xs.map((blocking) =>\n  String(${BLK}))}\n  </List>;\n`,
);
// `function` closing a `//` line of text, the name opening the next: the one
// declaration whose name the mask leaves in sight.
SHAPES["src/k/keyword-hidden.tsx"] = shape(
  true,
  "manual",
  `import { call } from "aio";\n` + K_LIST +
    `export const r = () => call({ timeout: 5 }, ${P1});\n` +
    `export const B = () => <List<"a" | "b"> items={[]}>\n    // usage {String(function\n  call(o?: { timeout: number }): unknown { return o ? 1 : call({ timeout: 5 }); })}\n  </List>;\n`,
);

// Shapes the element reader was measured on, as written: own code beside
// aio's in each `M-` file (left whole), aio's alone in each `A-` file.
const K_HDR =
  `import { call } from "aio";\nimport type { Rpc } from "./lib/types.ts";\nexport const r = () => call({ timeout: 5 }, () => Promise.resolve(1));\n`;
const K_USE = `  String(call({ timeout: 5 })))}`;
const K_CB = `{p.fns.map((call) =>\n${K_USE}`;
const kBody = (prose: string, tag = "p", attrs = "") =>
  `export const V = (p: { fns: Rpc[]; rest?: Record<string, string> }) => <${tag}${attrs}>${prose} ${K_CB}</${
    tag.split(" ")[0]
  }>;\n`;
Object.assign(SHAPES, {
  "src/k/lib/types.ts": shape(
    false,
    "silent",
    `export type Rpc = (o: { timeout: number }, f?: () => unknown) => unknown;\nexport const rpc: Rpc = (o, f) => [o, f];\nexport type Foo = unknown;\n`,
  ),
  "src/k/M-j01-generic-arrow.tsx": shape(
    true,
    "manual",
    K_HDR + `export const W = <T,>(x: T) => <p>it's {String(x)}</p>;\n` +
      kBody("don't"),
  ),
  "src/k/M-j02-comparison.tsx": shape(
    true,
    "manual",
    K_HDR +
      `export const lt = (a: number, b: number, c: number, d: number) => a < b && c > d;\n` +
      kBody("it's"),
  ),
  "src/k/M-j03-as-generic.tsx": shape(
    true,
    "manual",
    K_HDR +
      `export const big = (x: unknown) => (x as Map<string, number>).size > 0;\n` +
      kBody("it's"),
  ),
  "src/k/M-j05-assert-comment.ts": shape(
    true,
    "manual",
    K_HDR +
      `import type { Foo } from "./lib/types.ts";\nexport function g(bar: unknown, fns: Rpc[]) {\n  const a = <Foo>bar; for (const call of fns) // </Foo>\n    call({ timeout: 5 });\n  return a;\n}\n`,
  ),
  "src/k/M-j06-assert-string.ts": shape(
    true,
    "manual",
    K_HDR +
      `import type { Foo } from "./lib/types.ts";\nexport function g(bar: unknown, fns: Rpc[]) {\n  const a = <Foo>bar; let call: Rpc = fns[0]!; const s = "</Foo>";\n  call({ timeout: 5 });\n  return [a, s];\n}\n`,
  ),
  "src/k/M-j08-brace-text.tsx": shape(
    true,
    "manual",
    K_HDR + kBody("a {'}'} it's"),
  ),
  "src/k/M-j09-apos-entity.tsx": shape(
    true,
    "manual",
    K_HDR + kBody("it&apos;s &nbsp;&mdash;&#39; don't"),
  ),
  "src/k/M-j10-arrow-text.tsx": shape(
    true,
    "manual",
    K_HDR + kBody("a =&gt; b = c isn't"),
  ),
  "src/k/M-j11-name-text.tsx": shape(
    true,
    "manual",
    K_HDR + kBody("the (call) hook isn't"),
  ),
  "src/k/M-j12-comment-container.tsx": shape(
    true,
    "manual",
    K_HDR + kBody("{/* don't */} it's"),
  ),
  "src/k/M-j14-multiline-urls.tsx": shape(
    true,
    "manual",
    K_HDR +
      `export const V = (p: { fns: Rpc[] }) => <p>\n  see http://a.b/c and\n  https://d.e/f, it's at //g.h — ${K_CB}\n</p>;\n`,
  ),
  "src/k/M-j15-attr-gt.tsx": shape(
    true,
    "manual",
    K_HDR + kBody("don't", "a", ` title="a > b's" href='x>y "q"'`),
  ),
  "src/k/M-j16-spread.tsx": shape(
    true,
    "manual",
    K_HDR + kBody("don't", "p", ` {...p.rest}`),
  ),
  "src/k/M-j17-conditional.tsx": shape(
    true,
    "manual",
    K_HDR + kBody(`{p.fns.length ? <b>x's</b> : "y's"} it's`),
  ),
  "src/k/M-j18-nested5.tsx": shape(
    true,
    "manual",
    K_HDR +
      `export const V = (p: { fns: Rpc[] }) => <div>a's<section>b's<article>c's<p>d's<span>e's ${K_CB}</span>d'</p>c'</article>b'</section>a'</div>;\n`,
  ),
  "src/k/M-j19-fragment.tsx": shape(
    true,
    "manual",
    K_HDR +
      `export const V = (p: { fns: Rpc[] }) => <>it's <></> ${K_CB}</>;\n`,
  ),
  "src/k/M-j20-selfclose.tsx": shape(
    true,
    "manual",
    K_HDR + kBody("<br /> don't <hr/> isn't"),
  ),
  "src/k/M-j21-template-attr.tsx": shape(
    true,
    "manual",
    K_HDR +
      "export const V = (p: { fns: Rpc[] }) => <p title={`${String(<b>it's</b>)} '`}>don't " +
      K_CB + "</p>;\n",
  ),
  "src/k/M-j23-style-raw.tsx": shape(
    true,
    "manual",
    K_HDR +
      `export const V = (p: { fns: Rpc[] }) => <div><style>{"p::after { content: '</' }"}</style>don't ${K_CB}</div>;\n`,
  ),
  "src/k/M-j24-namespace-tag.tsx": shape(
    true,
    "manual",
    K_HDR +
      `export const V = (p: { fns: Rpc[] }) => <svg><svg:rect width="1" />it's ${K_CB}</svg>;\n`,
  ),
  "src/k/M-j25-same-line.tsx": shape(
    true,
    "manual",
    K_HDR +
      `export const V = (p: { fns: Rpc[] }) => <p>don't {p.fns.map((call) => String(call({ timeout: 5 })))} isn't</p>;\n`,
  ),
  "src/k/M-j25b-twenty-later.tsx": shape(
    true,
    "manual",
    K_HDR +
      `export const V = (p: { fns: Rpc[] }) => <p>don't ${
        "{p.fns.length}\n".repeat(20)
      }{p.fns.map((call) => 1)}</p>;\nexport const z = (call: Rpc) =>\n  call({ timeout: 5 });\n`,
  ),
  "src/k/M-j26-comment-before-root.tsx": shape(
    true,
    "manual",
    K_HDR +
      `export const V = (p: { fns: Rpc[] }) => (\n  // layout\n  <p>don't ${K_CB}</p>\n);\n`,
  ),
  "src/k/M-j27-comment-root-slashes.tsx": shape(
    true,
    "manual",
    K_HDR +
      `export const V = (p: { fns: Rpc[] }) => (\n  // layout\n  <pre>\n    // usage {p.fns.map((call) =>\n${K_USE}\n  </pre>\n);\n`,
  ),
  "src/k/M-j27b-slashes-only.tsx": shape(
    true,
    "manual",
    K_HDR +
      `export const V = (p: { fns: Rpc[] }) => (\n  <pre>\n    // usage {p.fns.map((call) =>\n${K_USE}\n  </pre>\n);\n`,
  ),
  "src/k/M-j28-block-comment-before.tsx": shape(
    true,
    "manual",
    K_HDR +
      `export function V(p: { fns: Rpc[] }) {\n  return /* the row */ <p>don't ${K_CB}</p>;\n}\n`,
  ),
  "src/k/M-j29-generic-tag.tsx": shape(
    true,
    "manual",
    K_HDR +
      `const List = <T,>(p: { items: T[]; children?: unknown }) => <ul>{String(p.children)}</ul>;\nexport const V = (p: { fns: Rpc[] }) => <List<Rpc> items={p.fns}>don't ${K_CB}</List>;\n`,
  ),
  "src/k/M-j30-comment-in-tag.tsx": shape(
    true,
    "manual",
    K_HDR +
      `export const V = (p: { fns: Rpc[] }) => <p /* why */ title="x">don't ${K_CB}</p>;\n`,
  ),
  "src/k/M-j31-generic-tag-slashes.tsx": shape(
    true,
    "manual",
    K_HDR +
      `const List = <T,>(p: { items: T[]; children?: unknown }) => <ul>{String(p.children)}</ul>;\nexport const V = (p: { fns: Rpc[] }) => <List<Rpc> items={p.fns}>\n    // usage {p.fns.map((call) =>\n${K_USE}\n  </List>;\n`,
  ),
  "src/k/M-j32-logical.tsx": shape(
    true,
    "manual",
    K_HDR +
      `export const V = (p: { fns: Rpc[] }) => p.fns.length > 0 && <p>don't ${K_CB}</p>;\n`,
  ),
  "src/k/M-j33-ternary-else.tsx": shape(
    true,
    "manual",
    K_HDR +
      `export const V = (p: { fns: Rpc[] }) => p.fns.length < 1 ? null : <p>don't ${K_CB}</p>;\n`,
  ),
  "src/k/M-j34-after-paren.tsx": shape(
    true,
    "manual",
    K_HDR +
      `const wrap = (x: unknown) => x;\nexport const V = (p: { fns: Rpc[] }) => wrap(wrap)(<p>don't ${K_CB}</p>);\n`,
  ),
  "src/k/M-j35-plus.tsx": shape(
    true,
    "manual",
    K_HDR +
      `export const V = (p: { fns: Rpc[] }) => [0 + +<p>don't ${K_CB}</p>, !<p>isn't {p.fns.map((call) =>\n${K_USE}</p>];\n`,
  ),
  "src/k/M-j36-typed-arrow-return.tsx": shape(
    true,
    "manual",
    K_HDR +
      `import type { JSX } from "aio/jsx-runtime";\nexport const V = (p: { fns: Rpc[] }): JSX.Element => <p>don't ${K_CB}</p>;\nexport function W(p: { fns: Rpc[] }): JSX.Element {\n  const el: JSX.Element = <p>don't ${K_CB}</p>;\n  return el;\n}\n`,
  ),
  "src/k/A-j40-aio-after-prose.tsx": shape(
    true,
    "fixed",
    `import { call, schedule } from "aio";\nexport const V = () => <p>don't {String(call({ timeout: 5 }, () => Promise.resolve(1)))} it's http://x.y {String(schedule.blocking("id", () => 1, 0))}</p>;\n`,
  ),
  "src/k/A-j41-ts-assert.ts": shape(
    true,
    "fixed",
    `import { call } from "aio";\nexport const n = (x: unknown) => <number>x; // it's </number>\nexport const m = (x: unknown) => (<string>x).length < 3 && 'a' > "b";\nexport const r = () => call({ timeout: 5 }, () => Promise.resolve(1));\n`,
  ),
  "src/k/A-j42-html-string.ts": shape(
    true,
    "manual",
    `import { call } from "aio";\nexport const html = (x: string) => "<p>it's " + x + "</p>";\nexport const re = /<\\/p>/;\nexport const r = () => call({ timeout: 5 }, () => Promise.resolve(1));\n`,
  ),
});

// ── No name is proven in the file ────────────────────────────────────
// An identifier spelled with a `\u` escape declares a name no reading of the
// text finds; an element the reader did not take has its text lexed as code.
// Either one, and nothing in the file is rewritten.
const K_SHOWN = J_SCHEDULE + K_LIST + `export const run = 1;\n`;
Object.assign(SHAPES, {
  // The parameter IS `call`. In a file without JSX too.
  "src/k/M-k16-escape.ts": shape(
    true,
    "manual",
    K_HDR + `export const g = (c\\u0061ll: Rpc) => call({ timeout: 5 });\n`,
  ),
  "src/k/M-k14-escape.tsx": shape(
    true,
    "manual",
    K_HDR +
      `export const V = (p: { fns: Rpc[] }) => (\n  // layout\n  <pre>\n    // usage {p.fns.map((c\\u0061ll) =>\n${K_USE}\n  </pre>\n);\n`,
  ),
  // …and where the mask blanks it: an element at a place the reader never
  // tries, its closing tag blanked by an apostrophe of its own text.
  "src/k/M-escape-hidden.tsx": shape(
    true,
    "manual",
    K_HDR +
      `export const V = (p: { fns: Rpc[] }) => void <pre>\n    // usage {p.fns.map((c\\u{61}ll) =>\n${K_USE} isn't</pre>;\n`,
  ),
  // Shown text that spells an old call, in an element the reader gave up on…
  "src/k/T-k17-shown.tsx": shape(
    false,
    "manual",
    K_SHOWN +
      `export const V = () => <List<"a" | "b"> items={[]}>schedule.blocking(run) is the call</List>;\n`,
  ),
  // …its closing tag blanked by the text's own apostrophe…
  "src/k/T-shown-apostrophe.tsx": shape(
    false,
    "manual",
    K_SHOWN +
      `export const V = () => <List<"a" | "b"> items={[]}>schedule.blocking(run) isn't the call</List>;\n`,
  ),
  // …and in an element at a place the reader never tries: its closing tag
  // in code, blanked by the text's own apostrophe, after another keyword,
  // inside an element the reader did take.
  "src/k/T-shown-untried.tsx": shape(
    false,
    "manual",
    J_SCHEDULE +
      `export const run = 1;\nexport const V = () => void <p>\n    schedule.blocking(run) is the call\n  </p>;\n`,
  ),
  "src/k/T-shown-untried-blanked.tsx": shape(
    false,
    "manual",
    J_SCHEDULE +
      `export const run = 1;\nexport const V = () => void <p>schedule.blocking(run) isn't it</p>;\n`,
  ),
  "src/k/T-shown-typeof.tsx": shape(
    false,
    "manual",
    J_SCHEDULE +
      `export const run = 1;\nexport const V = () => typeof <>schedule.blocking(run) isn't it</>;\n`,
  ),
  // However the closing tag is written — none of it is asked: a comment in
  // it, a component named in another script, a namespaced tag. (Where the
  // reader takes the element — a name in another script, an element after
  // the comma operator — its text is text: nothing to find.)
  "src/k/T-n14-comment-close.tsx": shape(
    false,
    "manual",
    K_SHOWN +
      `export const V = () => <List<"a" | "b"> items={[]}>schedule.blocking(run) is the call</List /* end */>;\n`,
  ),
  "src/k/T-n13-unicode-tag.tsx": shape(
    false,
    "silent",
    J_SCHEDULE +
      `export const run = 1;\nconst Élément = (p: { children?: unknown }) => <i>{String(p.children)}</i>;\nexport const V = () => <Élément>schedule.blocking(run) is the call</Élément>;\n`,
  ),
  "src/k/T-unicode-untried.tsx": shape(
    false,
    "manual",
    J_SCHEDULE +
      `export const run = 1;\nconst Élément = (p: { children?: unknown }) => <i>{String(p.children)}</i>;\nexport const V = () => void <Élément>schedule.blocking(run) is the call</Élément>;\n`,
  ),
  "src/k/T-namespaced.tsx": shape(
    false,
    "manual",
    J_SCHEDULE +
      `export const run = 1;\nexport const V = () => void <svg:text>schedule.blocking(run) is the call</svg:text>;\n`,
  ),
  "src/k/T-after-comma.tsx": shape(
    false,
    "silent",
    J_SCHEDULE +
      `export const run = 1;\nexport const V = () => (run, <p>schedule.blocking(run) is the call</p>);\n`,
  ),
  "src/k/T-shown-inside.tsx": shape(
    false,
    "manual",
    J_SCHEDULE +
      `export const run = 1;\nexport const V = () => <div>{void <p>schedule.blocking(run) isn't it</p>}</div>;\n`,
  ),
});

/** The words aio renamed, and the one call it moved: per name and per file,
 *  a fix renames every place the code writes it, or none. */
const RENAMED = [
  "CellAccess",
  "ServerFnAccess",
  "ExtractState",
  "connectDevTools",
  "disconnectDevTools",
  "schedule.blocking(",
];

/** What a report says about `file` by a rule about a NAME: "no test file"
 *  and "this import is not in deno.json" are about other things, and true. */
const about = (issues: readonly Issue[], file: string) =>
  issues.filter((i) =>
    i.file === file && i.area !== "testing" &&
    !i.message.includes("not found in deno.json")
  );

/** How often `src` writes `word` in CODE — a template's `${…}` included, a
 *  comment and a string not. `word` may end in `(`. */
function written(src: string, word: string): number {
  const mask = codeMaskDeep(src);
  const re = new RegExp(
    `(?<![\\w$])${word.replace(/[.(]/g, "\\$&")}${
      /\w$/.test(word) ? "(?![\\w$])" : ""
    }`,
    "g",
  );
  return [...src.matchAll(re)].filter((m) => mask[m.index] === 1).length;
}

/** `TScode src/file` of every type error under `dir`. */
async function typeErrors(dir: string, files: string[]): Promise<string[]> {
  const check = await new Deno.Command(Deno.execPath(), {
    args: ["check", ...files],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stderr = new TextDecoder().decode(check.stderr)
    .replace(/\x1b\[[0-9;]*m/g, "");
  // A module that does not resolve stops the check before it checks anything.
  if (!/^Check /m.test(stderr) && check.code !== 0) throw new Error(stderr);
  // Of the project's own files: aio's sources are read through the import
  // map, and what the compiler says about THEM is not this test's subject.
  const own = `${toFileUrl(await Deno.realPath(dir)).href}/`;
  return [...stderr.matchAll(
    /^(TS\d+) [^\n]*\n(?:[^\n]*\n)*?\s+at (file:\/\/\S+?):\d+:\d+$/gm,
  )].filter((m) => m[2]!.startsWith(own))
    .map((m) => `${m[1]} ${m[2]!.slice(own.length)}`).sort();
}

Deno.test("aiol --safe-fix: over every generated shape, each file is what it must become and none lost a name it uses", async () => {
  const root = await tempDir("aiol-fix-property-");
  const dir = join(root, "app");
  const mapped = join(root, "mapped");
  try {
    const compilerOptions = {
      lib: ["deno.ns", "deno.unstable", "dom", "dom.iterable"],
      jsx: "react-jsx",
      jsxImportSource: "aio",
    };
    const aio = {
      "aio": `${REPO}mod.ts`,
      "aio/jsx-runtime": `${REPO}src/jsx-runtime.ts`,
      "fw": `${REPO}mod.ts`,
    };
    const tasks = {
      dev: "deno run -A src/app.ts",
      test: "deno test -A tests/",
    };
    const put = async (base: string, rel: string, text: string) => {
      await Deno.mkdir(join(base, rel, ".."), { recursive: true });
      await Deno.writeTextFile(join(base, rel), text);
    };
    await put(
      dir,
      "deno.json",
      JSON.stringify({
        title: "myapp",
        version: "0.1.0",
        compilerOptions,
        imports: {
          ...aio,
          "fwdir/": REPO,
          "@/": "./src/",
          "@/fw/": REPO,
          "otherlib": "https://other.invalid/lib/mod.ts",
          "aio/extras": `${REPO}src/extras/mod.ts`,
          "mylib": "./src/v/lib/mine.ts",
          "viaover": "./src/v/lib/over.ts",
        },
        tasks,
      }),
    );
    // The alias lives in an import-map FILE here.
    await put(
      mapped,
      "deno.json",
      JSON.stringify({
        title: "mapped",
        version: "0.1.0",
        compilerOptions,
        importMap: "./maps/import_map.json",
        tasks,
      }),
    );
    await put(
      mapped,
      "maps/import_map.json",
      JSON.stringify({ imports: { ...aio, "@lib/": "../src/lib/" } }),
    );
    await put(mapped, "src/lib/star.ts", BARRELS["src/lib/star.ts"]!);
    // A module no lint run holds: it is in neither project.
    await put(root, "outside/aio.ts", OWN_API);
    await put(
      dir,
      "src/app.ts",
      `import { aio } from "aio";\nimport { counter } from "./cell.ts";\nawait aio.run({ appId: "myapp", cells: { counter } });\n`,
    );
    for (const base of [dir, mapped]) {
      for (const [f, text] of Object.entries(SHARED)) await put(base, f, text);
    }
    for (const [f, text] of Object.entries(BARRELS)) await put(dir, f, text);
    const files = Object.keys(CASES);
    for (const f of files) await put(dir, f, CASES[f]!.src);
    const truths = Object.keys(TRUTH);
    const baseOf = (f: string) => TRUTH[f]?.project ? mapped : dir;
    for (const f of truths) await put(baseOf(f), f, TRUTH[f]!.src);
    const shapes = Object.keys(SHAPES);
    for (const f of shapes) await put(dir, f, SHAPES[f]!.src);
    const checked = (base: string) => [
      ...(base === dir
        ? [
          ...files,
          ...Object.keys(BARRELS),
          ...shapes.filter((f) => !SHAPES[f]!.unchecked),
        ]
        : []),
      ...truths.filter((f) => baseOf(f) === base && !TRUTH[f]!.unresolved),
    ];
    /** Every file a fix could touch, with the text it was written with. */
    const all: Record<string, string> = {
      ...Object.fromEntries(files.map((f) => [f, CASES[f]!.src])),
      ...Object.fromEntries(truths.map((f) => [f, TRUTH[f]!.src])),
      ...Object.fromEntries(shapes.map((f) => [f, SHAPES[f]!.src])),
      ...BARRELS,
      ...SHARED,
    };
    const before = {
      app: await typeErrors(dir, checked(dir)),
      mapped: await typeErrors(mapped, checked(mapped)),
    };

    const reports = {
      app: await lintProject(dir),
      mapped: await lintProject(mapped),
    };
    for (const i of reports.app.issues) if (i.safeFix) await i.safeFix(dir);
    for (const i of reports.mapped.issues) {
      if (i.safeFix) await i.safeFix(mapped);
    }

    const wrong: string[] = [];
    for (const f of files) {
      const got = await Deno.readTextFile(join(dir, f));
      if (got !== CASES[f]!.fixed) wrong.push(`${f}\n${got}`);
      // A file left for a person says so, on the use it left.
      if (
        CASES[f]!.manual &&
        !about(reports.app.issues, f).some((i) => i.manual && !i.safeFix)
      ) wrong.push(`${f}: no [manual]`);
    }
    assertEquals(wrong, [], `${wrong.length} of ${files.length} files`);
    assert(files.filter((f) => CASES[f]!.manual).length > 110);

    // The three invariants, file by file.
    const broken: string[] = [];
    const tally = { fixed: 0, manual: 0, silent: 0 };
    for (const f of truths) {
      const t = TRUTH[f]!;
      const got = await Deno.readTextFile(join(baseOf(f), f));
      const found = about((t.project ? reports.mapped : reports.app).issues, f);
      const said = found.some((i) => i.safeFix)
        ? "fixed"
        : found.some((i) => i.manual)
        ? "manual"
        : found.length
        ? "reported"
        : "silent";
      const same = got === t.src;
      const ok = t.truth === false
        ? same && (said === "silent" || said === "manual")
        : t.truth === null
        ? same && said === "manual"
        : said === "fixed"
        ? !same && !got.includes(t.rule.old) && !found.some((i) => i.manual)
        : same && said === "manual";
      // …and which of the two a `true` gets is pinned: a rewrite takes proof.
      if (!ok || said !== t.does) {
        broken.push(
          `${f}: truth ${t.truth}, expected ${t.does}, said ${said}, ` +
            `${same ? "unchanged" : "rewritten"}\n${got}`,
        );
      }
      tally[t.does]++;
    }
    assertEquals(broken, [], `${broken.length} of ${truths.length} files`);
    // A fixed `useCell` takes its import with it, by whichever road a
    // STATEMENT imported it.
    const gone = [
      "named",
      "alias",
      "prefix",
      "barrelNamed",
      "barrelStar",
      "barrelThroughMap",
    ];
    for (const road of gone) {
      const got = await Deno.readTextFile(join(dir, `src/t-${road}-0.tsx`));
      assert(!got.includes("useCell"), got);
    }
    // Every class of the truth is exercised.
    assert(
      tally.fixed > 40 && tally.manual > 20 && tally.silent > 20,
      JSON.stringify(tally),
    );
    for (const truth of [true, false, null]) {
      assert(truths.some((f) => TRUTH[f]!.truth === truth), String(truth));
    }

    // The single shapes, by the same invariants.
    const misread: string[] = [];
    const seen = { fixed: 0, manual: 0, silent: 0, partly: 0 };
    for (const f of shapes) {
      const t = SHAPES[f]!;
      // The table itself: what is aio's is never silent, what cannot be
      // known is `[manual]`, and nothing that is not aio's is rewritten.
      assert(
        t.truth === true
          ? t.does !== "silent"
          : t.truth === null
          ? t.does === "manual"
          : t.does === "silent" || t.does === "manual",
        f,
      );
      const got = await Deno.readTextFile(join(dir, f));
      const found = about(reports.app.issues, f);
      const same = got === t.src;
      const fixable = found.some((i) => i.safeFix);
      const manual = found.some((i) => i.manual);
      const said = found.length === 0
        ? "silent"
        : fixable && manual
        ? "partly"
        : fixable
        ? "fixed"
        : manual
        ? "manual"
        : "reported";
      const holds = (t.has ?? []).every((x) => got.includes(x)) &&
        (t.lacks ?? []).every((x) => !got.includes(x));
      if (
        said !== t.does || !holds ||
        same !== (t.does === "silent" || t.does === "manual")
      ) {
        misread.push(
          `${f}: truth ${t.truth}, expected ${t.does}, said ${said}, ` +
            `${same ? "unchanged" : "rewritten"}\n${got}`,
        );
      }
      seen[t.does]++;
    }
    assertEquals(misread, [], `${misread.length} of ${shapes.length} shapes`);
    assert(
      seen.fixed > 120 && seen.manual > 250 && seen.silent > 30 && seen.partly,
      JSON.stringify(seen),
    );

    // ALL OR NOTHING, over every file of both projects: a name aio renamed
    // is, after the fix, written as often as before — or not at all. Never a
    // renamed import beside a use that kept the old name, nor the reverse.
    const halves: string[] = [];
    const after1: Record<string, string> = {};
    for (const [f, src] of Object.entries(all)) {
      const got = await Deno.readTextFile(join(baseOf(f), f));
      after1[f] = got;
      for (const name of RENAMED) {
        const [was, is] = [written(src, name), written(got, name)];
        if (is !== 0 && is !== was) halves.push(`${f}: ${name} ${was} → ${is}`);
      }
    }
    assertEquals(halves, []);
    assert(Object.keys(all).length > 500, String(Object.keys(all).length));

    // Twice is once.
    for (const base of [dir, mapped]) {
      for (const i of (await lintProject(base)).issues) {
        if (i.safeFix) await i.safeFix(base);
      }
    }
    const again: string[] = [];
    for (const f of Object.keys(all)) {
      if (await Deno.readTextFile(join(baseOf(f), f)) !== after1[f]) {
        again.push(f);
      }
    }
    assertEquals(again, [], "a second --safe-fix changed something");

    // The compiler's word, once per project: the fixed tree has no error the
    // original lacks.
    const after = {
      app: await typeErrors(dir, checked(dir)),
      mapped: await typeErrors(mapped, checked(mapped)),
    };
    for (const project of ["app", "mapped"] as const) {
      const had = new Set(before[project]);
      assertEquals(after[project].filter((e) => !had.has(e)), [], project);
      assert(checked(project === "app" ? dir : mapped).length > 4, project);
    }
    // …and of the first generation of shapes, exactly the kept stale imports.
    const first = new Set(files);
    assertEquals(
      after.app.filter((e) => first.has(e.split(" ")[1]!)),
      files.filter((f) => CASES[f]!.error).map((f) => `${CASES[f]!.error} ${f}`)
        .sort(),
    );
  } finally {
    await dropTempDir(root);
  }
});

// ── The same alias, under every shape of config ──────────────────────
// `import { schedule } from "fw"` + `schedule.blocking(`: what `fw` is comes
// from the project's config, and a config the linter cannot read is not
// "another package" — it is unknown: said, as `[manual]`, never silent.
const ALIASED =
  `import { schedule } from "fw";\nexport const e = schedule.blocking("id", () => 1, 0);\n`;
const AIO = `${REPO}mod.ts`;
// The same module with no `//` in its spelling (`file:/x/mod.ts`): this
// reader takes a `//` inside a string for a comment — the case
// "a jsonc the reader cannot parse" below is that limit, pinned.
const AIO_1 = AIO.replace("file:///", "file:/");
type Variant = {
  says: "fixable" | "manual" | "silent";
  files: Record<string, string>;
  /** The file asked about, when it is not `src/a.ts`. */
  file?: string;
};
/** The app's own module, with a `schedule` of its own. */
const OWN_RPC =
  `export const schedule = { blocking: (...a: unknown[]) => a };\n`;
const OWN_USE = (spec: string) =>
  `import { schedule } from "${spec}";\nexport const e = schedule.blocking("id");\n`;
const json = (o: unknown) => JSON.stringify(o);
const CONFIGS: Record<string, Variant> = {
  // proven aio's
  "alias beside aio": {
    says: "fixable",
    files: { "deno.json": json({ imports: { aio: AIO, fw: AIO } }) },
  },
  "alias to the registry": {
    says: "fixable",
    files: {
      "deno.json": json({ imports: { fw: "jsr:@riagentic/aio@^1.0.0" } }),
    },
  },
  "alias to the registry's URL": {
    says: "fixable",
    files: {
      "deno.json": json({
        imports: { fw: "https://jsr.io/@riagentic/aio/1.0.16-beta/mod.ts" },
      }),
    },
  },
  "importMap file": {
    says: "fixable",
    files: {
      "deno.json": json({ importMap: "./import_map.json" }),
      "import_map.json": json({ imports: { aio: AIO, fw: AIO } }),
    },
  },
  "jsonc with comments": {
    says: "fixable",
    files: {
      "deno.jsonc":
        `{\n  // the framework\n  "imports": { "aio": "${AIO_1}", "fw": "${AIO_1}" } /* c */\n}`,
    },
  },
  "a key that is no prefix": {
    says: "fixable",
    files: {
      "deno.json": json({ imports: { aio: AIO, f: "./src/", fw: AIO } }),
    },
  },
  "longest prefix": {
    says: "fixable",
    files: {
      "deno.json": json({
        imports: { aio: AIO, "@/": "./src/", "@/fw/": REPO },
      }),
      "src/a.ts": ALIASED.replace(`"fw"`, `"@/fw/mod.ts"`),
    },
  },
  "prefix onto the registry": {
    says: "fixable",
    files: {
      "deno.json": json({
        imports: { "fw/": "jsr:/@riagentic/aio@^1.0.0/" },
      }),
      "src/a.ts": ALIASED.replace(`"fw"`, `"fw/mod.ts"`),
    },
  },
  "the registry name as the key, no `aio` key at all": {
    says: "fixable",
    files: {
      "deno.json": json({ imports: { "@riagentic/aio": AIO, fw: AIO } }),
    },
  },
  "…and imported by that name": {
    says: "fixable",
    files: {
      "deno.json": json({ imports: { "@riagentic/aio": AIO } }),
      "src/a.ts": ALIASED.replace(`"fw"`, `"@riagentic/aio"`),
    },
  },
  // `scopes`: the map a file is read through depends on where the file is.
  "a scope that does not hold the file": {
    says: "fixable",
    files: {
      "deno.json": json({
        imports: { aio: AIO, fw: AIO },
        scopes: { "./src/scoped/": { fw: "./src/lib/rpc.ts" } },
      }),
      "src/lib/rpc.ts": OWN_RPC,
    },
  },
  "a scope that maps the alias to aio for this file only": {
    says: "fixable",
    files: {
      "deno.json": json({
        imports: { aio: AIO, fw: "./src/lib/rpc.ts" },
        scopes: { "./src/scoped/": { fw: AIO } },
      }),
      "src/lib/rpc.ts": OWN_RPC,
      "src/scoped/a.ts": ALIASED,
    },
    file: "src/scoped/a.ts",
  },
  "scopes in an importMap file, relative to that file": {
    says: "fixable",
    files: {
      "deno.json": json({ importMap: "./maps/map.json" }),
      "maps/map.json": json({
        imports: { aio: AIO, fw: "../src/lib/rpc.ts" },
        scopes: { "../src/scoped/": { fw: AIO } },
      }),
      "src/lib/rpc.ts": OWN_RPC,
      "src/scoped/a.ts": ALIASED,
    },
    file: "src/scoped/a.ts",
  },
  // nothing the linter reads says what `fw` is
  "no config": { says: "manual", files: {} },
  // …where a map in a directory above may send `aio` itself anywhere.
  "…and `aio` itself, with no config at all": {
    says: "manual",
    files: { "src/a.ts": ALIASED.replace(`"fw"`, `"aio"`) },
  },
  "malformed": {
    says: "manual",
    files: { "deno.json": `{ "imports": { "fw": ` },
  },
  "imports: null": {
    says: "manual",
    files: { "deno.json": `{ "imports": null }` },
  },
  "imports: an array": {
    says: "manual",
    files: { "deno.json": `{ "imports": ["fw"] }` },
  },
  "imports: a string": {
    says: "manual",
    files: { "deno.json": `{ "imports": "x" }` },
  },
  "values that are no strings": {
    says: "manual",
    files: {
      "deno.json": `{ "imports": { "fw": null, "aio": 5, "x/": {} } }`,
    },
  },
  "a target that is a list": {
    says: "manual",
    files: {
      "deno.json": json({
        imports: { aio: AIO, fw: ["./src/lib/rpc.ts"], num: 5, obj: { a: 1 } },
      }),
      "src/lib/rpc.ts": OWN_RPC,
    },
  },
  "a prefix whose target is a list": {
    says: "manual",
    files: {
      "deno.json": json({ imports: { aio: AIO, "fw/": ["./src/lib/"] } }),
      "src/lib/rpc.ts": OWN_RPC,
      "src/a.ts": ALIASED.replace(`"fw"`, `"fw/rpc.ts"`),
    },
  },
  "a longer prefix with no usable target, over a usable one": {
    says: "manual",
    files: {
      "deno.json": json({ imports: { aio: AIO, "fw/": REPO, "fw/x/": 5 } }),
      "src/a.ts": ALIASED.replace(`"fw"`, `"fw/x/mod.ts"`),
    },
  },
  "`aio` itself with no usable target": {
    says: "manual",
    files: {
      "deno.json": json({ imports: { aio: ["x"] } }),
      "src/a.ts": ALIASED.replace(`"fw"`, `"aio"`),
    },
  },
  // aio's, but `blocking` is in the main entry and this is another one
  "a sub-entry of aio through a prefix": {
    says: "manual",
    files: {
      "deno.json": json({
        imports: { "fw/": "jsr:/@riagentic/aio@^1.0.0/" },
      }),
      "src/a.ts": ALIASED.replace(`"fw"`, `"fw/air"`),
    },
  },
  "a sub-entry of aio by its own key": {
    says: "manual",
    files: {
      "deno.json": json({
        imports: { aio: AIO, "aio/extras": `${REPO}src/extras/mod.ts` },
      }),
      "src/a.ts": ALIASED.replace(`"fw"`, `"aio/extras"`),
    },
  },
  "…and an alias of that sub-entry": {
    says: "manual",
    files: {
      "deno.json": json({
        imports: {
          aio: AIO,
          "aio/extras": `${REPO}src/extras/mod.ts`,
          fw: `${REPO}src/extras/mod.ts`,
        },
      }),
    },
  },
  "imports and importMap both: the file is not read": {
    says: "manual",
    files: {
      "deno.json": json({ imports: {}, importMap: "./import_map.json" }),
      "import_map.json": json({ imports: { aio: AIO, fw: AIO } }),
    },
  },
  "importMap that is no path": {
    says: "manual",
    files: { "deno.json": json({ importMap: 5 }) },
  },
  "importMap file that is a list": {
    says: "manual",
    files: {
      "deno.json": json({ importMap: "./import_map.json" }),
      "import_map.json": `[]`,
    },
  },
  "…and `aio` itself, when the map could not be read": {
    says: "manual",
    files: {
      "deno.json": json({ importMap: "./gone.json" }),
      "src/a.ts": ALIASED.replace(`"fw"`, `"aio"`),
    },
  },
  "a scope whose targets are no strings": {
    says: "manual",
    files: {
      "deno.json": json({
        imports: { aio: AIO, fw: AIO },
        scopes: { "./src/": { fw: 5 } },
      }),
    },
  },
  "a scope that is no path": {
    says: "manual",
    files: {
      "deno.json": json({
        imports: { aio: AIO, fw: AIO },
        scopes: { "https://esm.sh/": { fw: "./src/lib/rpc.ts" } },
      }),
    },
  },
  "importMap file that is missing": {
    says: "manual",
    files: { "deno.json": json({ importMap: "./gone.json" }) },
  },
  "importMap file that is no JSON": {
    says: "manual",
    files: {
      "deno.json": json({ importMap: "./import_map.json" }),
      "import_map.json": `{ "imports": `,
    },
  },
  "alias to a path, no aio beside it": {
    says: "manual",
    files: { "deno.json": json({ imports: { fw: AIO } }) },
  },
  "alias to a module outside the run": {
    says: "manual",
    files: {
      "deno.json": json({ imports: { fw: "../../../outside/mod.ts" } }),
    },
  },
  "a jsonc the reader cannot parse": {
    says: "manual",
    files: {
      "deno.jsonc":
        `{\n  "imports": { "aio": "${AIO}", "fw": "${AIO}", "x": "https://esm.sh/x" }\n}`,
    },
  },
  "workspace member, map at the root": {
    says: "manual",
    files: {
      "../deno.json": json({
        workspace: ["./app"],
        imports: { aio: AIO, fw: AIO },
      }),
      "deno.json": `{ "name": "@x/app" }`,
    },
  },
  // proven the app's own
  "`aio` is the app's own module": {
    says: "silent",
    files: {
      "deno.json": json({ imports: { aio: "./src/lib/rpc.ts", real: AIO } }),
      "src/lib/rpc.ts": OWN_RPC,
      "src/a.ts": OWN_USE("aio"),
    },
  },
  "…and an alias of that": {
    says: "silent",
    files: {
      "deno.json": json({
        imports: { aio: "./src/lib/rpc.ts", fw: "./src/lib/rpc.ts" },
      }),
      "src/lib/rpc.ts": OWN_RPC,
      "src/a.ts": OWN_USE("fw"),
    },
  },
  "a scope that maps the alias to the app's own module": {
    says: "silent",
    files: {
      "deno.json": json({
        imports: { aio: AIO, fw: AIO },
        scopes: { "./src/scoped/": { fw: "./src/lib/rpc.ts" } },
      }),
      "src/lib/rpc.ts": OWN_RPC,
      "src/scoped/a.ts": OWN_USE("fw"),
    },
    file: "src/scoped/a.ts",
  },
  "the most specific scope wins": {
    says: "silent",
    files: {
      "deno.json": json({
        imports: { aio: AIO, fw: AIO },
        scopes: {
          "./src/": { fw: AIO },
          "./src/scoped/": { fw: "./src/lib/rpc.ts" },
        },
      }),
      "src/lib/rpc.ts": OWN_RPC,
      "src/scoped/a.ts": OWN_USE("fw"),
    },
    file: "src/scoped/a.ts",
  },
  "`aio` under a registry of somebody else's": {
    says: "silent",
    files: {
      "deno.json": json({ imports: { aio: "npm:other@1" } }),
      "src/a.ts": ALIASED.replace(`"fw"`, `"aio"`),
    },
  },
  // proven another package
  "alias to another package": {
    says: "silent",
    files: { "deno.json": json({ imports: { fw: "npm:other@1" } }) },
  },
  "alias to another URL": {
    says: "silent",
    files: {
      "deno.json": json({ imports: { fw: "https://other.invalid/mod.ts" } }),
    },
  },
};

Deno.test("aiol: an alias of aio under every shape of config — fixed when proven, [manual] when unknown, silent only when proven another package", async () => {
  const root = await tempDir("aiol-fix-configs-");
  try {
    const got: Record<string, string> = {};
    let n = 0;
    for (const [name, v] of Object.entries(CONFIGS)) {
      const dir = join(root, String(n++), "app");
      const file = v.file ?? "src/a.ts";
      for (
        const [f, text] of Object.entries({ [file]: ALIASED, ...v.files })
      ) {
        await Deno.mkdir(join(dir, f, ".."), { recursive: true });
        await Deno.writeTextFile(join(dir, f), text);
      }
      const before = await Deno.readTextFile(join(dir, file));
      // Whatever the config holds, reading it never throws.
      const report = await lintProject(dir);
      const rows = report.issues.filter((i) =>
        i.file === file && i.message.includes("schedule.blocking")
      );
      for (const i of rows) if (i.safeFix) await i.safeFix(dir);
      const same = before === await Deno.readTextFile(join(dir, file));
      got[name] = rows.some((i) => i.safeFix)
        ? (same ? "fixable, not rewritten" : "fixable")
        : rows.some((i) => i.manual)
        ? (same ? "manual" : "manual, REWRITTEN")
        : rows.length
        ? "reported"
        : (same ? "silent" : "silent, REWRITTEN");
    }
    assertEquals(
      got,
      Object.fromEntries(
        Object.entries(CONFIGS).map(([name, v]) => [name, v.says]),
      ),
    );
    assert(n > 40);
  } finally {
    await dropTempDir(root);
  }
});
