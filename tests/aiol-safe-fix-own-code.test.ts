// `--safe-fix` rewrote code that was never aio's:
//
//   • a user's OWN `call` — a method with a return type, a typed parameter, an
//     interface member, `function call`, a local `const call`, a `call`
//     imported from another module — had `timeout` renamed to `timeoutMs`, and
//     the file stopped type-checking (`{ timeoutMs: t }: { timeout: number }`);
//   • an ACTION payload spelled without a literal `type:` key (`{ type, … }`,
//     a spread, a computed key) was taken for `schedule.poll`'s opts and had
//     its own `backoff` field renamed;
//   • JSX TEXT — `<code>useCell(counter).state.count</code>`, the app SHOWING
//     the old spelling — was reported as a use and rewritten. And the reverse:
//     a statement between two elements was taken for text, so a real use was
//     neither reported nor fixed, and lost its import to the fix of another.
//     A tag spelled in a comment or a string did the same;
//   • a call through something else named `call` — a private member
//     (`this.#call(…)`), a parameter — had its option renamed;
//   • a file's OWN `useCell`, `schedule` or `ExtractState` — declared there,
//     or imported from its own module — was rewritten as if it were aio's.
//
// And whatever is misread, an import is removed only from a file that no
// longer names it.
//
// Each case is checked at the decider, and once more end to end: lint, fix,
// fix again (same bytes), and `deno check` over what the fix left.
import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { lintProject } from "../aiol/mod.ts";
import {
  callTimeoutScan,
  callTimeoutSites,
  cellUse,
  codeMaskDeep,
  fixable,
  fixPollBackoffKey,
  fixRemoveCreateRootImport,
  fixRemoveImportReact,
  fixRenameWords,
  fixReturnEffectsToDo,
  fixScheduleBlocking,
  fixUiKeyToVisible,
  fixUseCellStateReads,
  inJsxText,
  pollBackoffCalls,
  returnEffectDecline,
  scheduleBlockingToTop,
  specKinds,
  stillNamed,
  useCellCalls,
  whose,
  withoutCreateRootImport,
  withoutReactImport,
  wordUses,
} from "../aiol/fixes.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

// An import map names a module by specifier, never by path: `C:\\x\\mod.ts`
// is the URL scheme `c:` to Deno.
const REPO = new URL("../", import.meta.url).href;
const AIO = `import { call } from "aio";\n`;

/** Whose the bare `name` is in this file, and why `cell(…)` is left. */
const nameBinding = (src: string, name: string, kinds = specKinds()) =>
  whose(src, kinds)(-1, name).who;
const cellDecline = (src: string) => cellUse(whose(src)(-1, "cell")) ?? "";
const pollBackoffSites = (src: string) =>
  pollBackoffCalls(src).flatMap((c) => c.keys);

Deno.test("aiol call-timeout: a definition or signature named `call` is never aio's call", () => {
  for (
    const own of [
      // a return type between `)` and the body
      `class C { call({ timeout: t }: { timeout: number }): number { return t; } }`,
      `const o = { call({ timeout: t }): number { return t; } };`,
      `const o = { a: 1, call({ timeout: t }): number { return t; } };`,
      // a typed parameter — an argument is never followed by `:`
      `class C { call({ timeout: t }: O) { return t; } }`,
      `interface I { call({ timeout: t }: O): void; }`,
      `interface I { call({ timeout: t }: O); }`,
      `abstract class A { abstract call({ timeout: t }: O): void; }`,
      `class C { static async call({ timeout: t }) { return t; } }`,
      // a function
      `function call({ timeout: t }) { return t; }`,
      `export function call({ timeout: t }: O): Promise<void> { return t; }`,
      `declare function call({ timeout: t }: O): void;`,
      `declare function call({ timeout: t });`,
      // a comment where the token before / after is looked for
      `const o = { /* own */ call({ timeout: t }) /* → */ : number { return t; } };`,
      // a member on its own line, after one that ended without `;`
      `class C {\n  x = 1\n  call({ timeout: t }): number { return t; }\n}`,
      `class C {\n  @dec()\n  call({ timeout: t }): number { return t; }\n}`,
      `class C {\n  @dec\n  call({ timeout: t }): number { return t; }\n}`,
      `interface I { a: 1\n  call({ timeout }): void }`,
      // an arrow after the parameter list is a definition, never a call
      `const o = { f: call({ timeout: t }) => t };`,
      // a private member is a member
      `class C { #call(o: O) { return o; } run() { return this.#call({ timeout: 5 }); } }`,
      `class C { run() { return this.# call({ timeout: 5 }); } }`,
    ]
  ) {
    assertEquals(callTimeoutSites(AIO + own), [], own);
  }
});

Deno.test("aiol call-timeout: a real call is still found — in a ternary, after a comment, as a statement", () => {
  for (
    const use of [
      `await call({ timeout: 5 }, () => x.y());`,
      // the `:` after the `)` is the ternary's, not a return type
      `const r = ok ? call({ timeout: 5 }, f) : null;`,
      `const r = ok ? await call({ timeout: 5 }, f) : null;`,
      // …on its own line too: what is before it still wants an operand
      `const r = ok\n  ? call({ timeout: 5 }, f)\n  : null;`,
      `const r = ok ?\n  call({ timeout: 5 }, f) : null;`,
      `const r = ok ? await\n  call({ timeout: 5 }, f) : null;`,
      `const r = ok ? x ||\n  call({ timeout: 5 }, f) : null;`,
      `const o = { a: call({ timeout: 5 }, f) };`,
      `run(1, call({ timeout: 5 }, f));`,
      `{ call({ timeout: 5 }, f); }`,
      `// why\ncall({ timeout: 5 }, f);`,
      // after an option whose value is a template with an interpolation
      "call({ name: `job-${id}`, timeout: 5 }, f);",
    ]
  ) {
    const src = AIO + use;
    const sites = callTimeoutSites(src);
    assertEquals(sites.length, 1, use);
    assert(src.startsWith("timeout: 5", sites[0]), use);
  }
});

Deno.test("aiol call-timeout: a `call` the file declares, or imports from elsewhere, is not aio's", () => {
  const use = `export const n = call({ timeout: 5 }, f);\n`;
  for (
    const mine of [
      `const call = (o: { timeout: number }, f: unknown) => o.timeout;\n`,
      `import { call } from "./rpc.ts";\n`,
      `import { call } from "some-rpc";\n`,
      `import { call } from "npm:some-rpc@2";\n`,
      `import { other as call } from "aio";\n`,
      `import * as call from "aio";\n`,
    ]
  ) {
    assertEquals(callTimeoutSites(mine + use), [], mine);
  }
  // No binding at all — its import went, or was commented out: nothing in
  // the file says whose it is. Named for a look, never rewritten.
  for (const none of [``, `// import { call } from "aio";\n`]) {
    const scan = callTimeoutScan(none + use);
    assertEquals(
      [scan.sites.length, scan.fix, scan.sure],
      [1, [], false],
      none,
    );
    assert(scan.why.includes("nothing in this file imports `call`"), scan.why);
  }
  // Through a namespace: aio's on an aio namespace, a candidate on the app's
  // own barrel, nobody's on any other object.
  const through = (head: string) =>
    callTimeoutScan(head + `export const n = fw.call({ timeout: 5 }, f);\n`);
  assertEquals(through(`import * as fw from "aio";\n`).fix.length, 1);
  // A local in a file that holds aio as a value may be taken from it.
  const local = through(`const { fw } = await import("aio");\n`);
  assertEquals([local.sites.length, local.fix.length], [1, 0]);
  assert(local.why.includes("holds aio"), local.why);
  const barrelled = through(`import * as fw from "./lib/aio.ts";\n`);
  assertEquals([barrelled.sites.length, barrelled.fix.length], [1, 0]);
  assert(barrelled.why.includes(`"./lib/aio.ts"`), barrelled.why);
  assertEquals(through(`import * as fw from "npm:some-rpc@2";\n`).sites, []);
  assertEquals(through(`const fw = rpc();\n`).sites, []);
  // A file with both: aio's is fixed, the candidate is named.
  const both = callTimeoutScan(
    `import * as fw from "./lib/aio.ts";\nimport { call } from "aio";\n` +
      `export const a = call({ timeout: 1 }, f);\nexport const b = fw.call({ timeout: 2 }, f);\n`,
  );
  assertEquals([both.sites.length, both.fix.length, !!both.why], [2, 1, true]);
  // The app's own module may be a barrel over aio: a candidate, with the
  // reason — never a rewrite.
  for (
    const barrel of [
      `import { call } from "./rpc.ts";\n`,
      `import { call } from "../lib/aio.ts";\n`,
      // …and so may a bare specifier no import map here explains.
      `import { call } from "some-rpc";\n`,
      `import { call } from "fw";\n`,
    ]
  ) {
    const scan = callTimeoutScan(barrel + use);
    assertEquals(scan.sites.length, 1, barrel);
    assert(scan.why.includes("aiol cannot tell whose it is"), scan.why);
  }
  assertEquals(callTimeoutScan(`import { call } from "node:rpc";\n` + use), {
    sites: [],
    fix: [],
    why: "",
    sure: false,
  });
  // What the app's import map resolves to aio is aio.
  const mapped = specKinds({
    aio: "jsr:@riagentic/aio@1.0.17-beta",
    fw: "jsr:@riagentic/aio@1.0.17-beta",
  });
  assertEquals(
    callTimeoutSites(`import { call } from "fw";\n` + use, mapped).length,
    1,
  );
  assertEquals(callTimeoutSites(`import { call } from "fw";\n` + use), []);
  for (
    const aio of [
      `import { call } from "aio";\n`,
      `import { cell, call } from 'aio'\n`,
      `import {\n  call, // the wrapper\n  cell,\n} from "aio";\n`,
      `import { call } from "jsr:@riagentic/aio@1.0.17-beta";\n`,
      `import { call } from "@riagentic/aio";\n`,
    ]
  ) {
    assertEquals(callTimeoutSites(aio + use).length, 1, aio);
  }
});

// No scope analyser: a file that names `call` any second way keeps its
// `call(`s as written, and the candidates are handed to a person.
Deno.test("aiol call-timeout: a file that names `call` another way is not rewritten", () => {
  for (
    const own of [
      `export const run = (call: Fn) => call({ timeout: 5 });`,
      `export const run = (a: number, call: Fn) => call({ timeout: 5 });`,
      `export const run = (call) => call({ timeout: 5 });`,
      `export const run = call => call({ timeout: 5 });`,
      `export function run(call?: Fn) { return call({ timeout: 5 }); }`,
      `export function run({ call }: P) { return call({ timeout: 5 }); }`,
      `export function run({ rpc: call }: P) { return call({ timeout: 5 }); }`,
      `function f() { const call = rpc; return call({ timeout: 5 }); }`,
      `function f() { let call; call = rpc; return call({ timeout: 5 }); }`,
      `function f() { var call = rpc; return call({ timeout: 5 }); }`,
      `function f() { const { call } = client; return call({ timeout: 5 }); }`,
      `function f() { const [call] = fns; return call({ timeout: 5 }); }`,
      `function f() { function call(o: O) { return o; } return call({ timeout: 5 }); }`,
      `try { go(); } catch (call) { call({ timeout: 5 }); }`,
      // …and the ways no declaration test here ever recognised: the name is
      // simply not, positively, a use.
      `let n = 1, call = mk; export const r = call({ timeout: 5 }, () => n);`,
      `let n, call: typeof mk; call = mk; export const r = call({ timeout: 5 });`,
      `for (let i = 0, call = mk; i < 1; i++) out.push(call({ timeout: 5 }));`,
      `class K { constructor(private call: F) { call({ timeout: 5 }); } }`,
      `export const g = ({ a: { b: call } }: P) => call({ timeout: 5 });`,
      `export const g = ({ x: [call] }: P) => call({ timeout: 5 });`,
      `function f() { using call = mk(); return call({ timeout: 5 }); }`,
      `async function f() { const { call } = await import("./rpc.ts"); return call({ timeout: 5 }); }`,
      `enum E { call }; export const r = call({ timeout: 5 }, f);`,
      `export const api = { call }; export const r = call({ timeout: 5 }, f);`,
      `run(call); export const r = call({ timeout: 5 }, f);`,
      `export { call }; export const r = call({ timeout: 5 }, f);`,
      `export function id<call>(x: call) { return x; } id(call({ timeout: 5 }, f));`,
    ]
  ) {
    const src = AIO + own;
    const scan = callTimeoutScan(src);
    assertEquals(scan.sites.length, 1, own);
    // The reason names the line that stopped it; a `call` that may be the
    // file's own is a hint, never an error.
    assert(scan.why.includes("line 2 writes `call`"), `${own}\n${scan.why}`);
    assertEquals(scan.sure, false, own);
    assertEquals(callTimeoutSites(src), [], own);
  }
  // The import itself, a member and a method are not a second name.
  for (
    const aio of [
      `export const r = () => call({ timeout: 5 }, f);`,
      `class C { call(o: O) { return o; } }\nexport const r = call({ timeout: 5 }, f);`,
      `export const a = rpc.call(1), b = rpc?.call(2), r = call({ timeout: 5 }, f);`,
      `export const a = call<number>({ timeoutMs: 1 }, g), r = call({ timeout: 5 }, f);`,
      `// const call = mine\nexport const s = "let call", r = call({ timeout: 5 }, f);`,
    ]
  ) {
    const scan = callTimeoutScan(AIO + aio);
    assertEquals(scan.why, "", aio);
    assertEquals(callTimeoutSites(AIO + aio).length, 1, aio);
  }
  // aio's `call`, proven — and still left to a person, loudly, where the fix
  // cannot write the new key: a shorthand, a quoted or a computed key, a call
  // in a template's interpolation, a call that sets both keys.
  for (
    const [odd, reason] of [
      [
        `export const r = (timeout: number) => call({ timeout }, f);`,
        "shorthand",
      ],
      [
        `export const r = (timeout: number) => call({ name, timeout, }, f);`,
        "shorthand",
      ],
      [`export const r = call({ "timeout": 5 }, f);`, "quoted"],
      [`export const r = call({ ["timeout"]: 5 }, f);`, "computed"],
      ["export const r = `v=${await call({ timeout: 5 }, f)}`;", "template"],
      [`export const r = call({ timeout: 5, timeoutMs: 6 }, f);`, "both"],
      [`export const r = call({ timeoutMs: 6, timeout: 5 }, f);`, "both"],
    ] as const
  ) {
    const scan = callTimeoutScan(AIO + odd);
    assertEquals([scan.sites.length, scan.fix, scan.sure], [1, [], true], odd);
    assert(scan.why.includes(reason), `${odd}\n${scan.why}`);
  }
  // A nested object's keys, and another option of that name, are not it —
  // nor is an object that merely follows `call` in the next interpolation.
  for (
    const not of [
      "export const s = `${call}${({ timeout: 5 })}`;",
      `export const r = call({ retry: { timeout }, name }, f);`,
      `export const r = call({ timeoutMs: 6, "time-out": 5, [timeout]: 1 }, f);`,
    ]
  ) assertEquals(callTimeoutScan(AIO + not).sites, [], not);
});

Deno.test("aiol poll-backoff: an action without a literal `type:` key is not the opts", () => {
  for (
    const action of [
      `schedule.poll("p", 0, { type, backoff: 2 }, { every: 1000 })`,
      `schedule.poll("p", 0, { ...tick, backoff: 2 }, { every: 1000 })`,
      `schedule.poll("p", 0, { ["type"]: "T", backoff: 2 }, { every: 1000 })`,
      `schedule.poll("p", 0, { type: "T", backoff: 2, every: 1 }, { every: 1000 })`,
    ]
  ) {
    assertEquals(pollBackoffSites(action), [], action);
  }
  // The opts — fourth, or third in the order the migration replaced — are
  // still found.
  for (
    const opts of [
      `schedule.poll("p", s.n, A.tick(), { every: 1000, backoff: 2 })`,
      `schedule.poll("p", 0, { every: 1000, backoff: 2 }, A.tick())`,
      `schedule.poll("p", 0, { type, backoff: 9 }, { every: 1000, backoff: 2 })`,
    ]
  ) {
    const sites = pollBackoffSites(opts);
    assertEquals(sites.length, 1, opts);
    assert(opts.startsWith("backoff: 2", sites[0]), opts);
  }
});

Deno.test("aiol inJsxText: prose an element shows is not code; code is", () => {
  const at = (src: string) => {
    const i = src.indexOf("useCell(");
    return inJsxText(src, i, i + "useCell(".length);
  };
  // After an opening tag, or up to a closing one: a child, so text.
  assert(at(`const A = () => <code>useCell(counter).state.count</code>;`));
  assert(at(`const A = () => <p>call useCell(x) here</p>;`));
  assert(at(`const A = () => <p>now useCell(c).state.x <br /></p>;`));
  assert(at(`const A = () => <p>was <b>x</b> useCell(c).state.x</p>;`));
  assert(at(`const A = () => <p><br /> useCell(c).state.x</p>;`));
  assert(at(`const A = () => <>useCell(c).state.x</>;`));
  assert(!at(`const n = useCell(counter).state.count;`));
  assert(!at(`const f = () => useCell(counter).state.count < 3;`));
  assert(!at(`const A = () => <p>{useCell(counter).state.count}</p>;`));
  assert(!at(`const ok = a > useCell(c).state.x && useCell(c).state.x < b;`));
  assert(!at(`const m = new Map<string, number>(); useCell(c).state.x; <p />`));
  assert(!at(`const m = new Set<string>(); useCell(c).state.x; <p />`));
  // Between two WHOLE elements nothing says which it is — and a statement
  // there is ordinary code. It reads as code (reported), never as prose.
  for (
    const code of [
      `const t = <h1>Hi</h1>;\n  const n = useCell(c).state.n;\n  return <p>{t}{n}</p>;`,
      `const t = <br />;\n  const n = useCell(c).state.n;\n  return <p>{t}{n}</p>;`,
      `const t = <h1>Hi</h1>\n  const n = useCell(c).state.n\n  return <p>{t}{n}</p>`,
      `const l = [<a />, useCell(c).state.n, <b />];`,
      `const t = <></>;\n  const n = useCell(c).state.n;\n  return <p>{t}{n}</p>;`,
      `const A = () => <p>was <b>x</b> useCell(c).state.x <br /></p>;`,
      // A tag spelled in a comment or a string is not an element…
      `// the <h1> title\n  const n = useCell(c).state.n;\n  return <p>{n}</p>;`,
      `// rendered inside <Layout>\n  const n = useCell(c).state.n;\n  return <p>{n}</p>;`,
      `/** Returns a <p>. */\n  const n = useCell(c).state.n;\n  return <p>{n}</p>;`,
      `const open = "<div>";\n  const n = useCell(c).state.n;\n  return <p>{n}</p>;`,
      `const open = \`<div>\`;\n  const n = useCell(c).state.n;\n  return <p>{n}</p>;`,
      `const t = <b>x</b>;\n  const n = useCell(c).state.n; // goes before </b>\n  return <p>{t}{n}</p>;`,
      `const t = <b>x</b>;\n  const n = useCell(c).state.n; const close = "</b>";`,
      // …and neither is a comparison spelled like one.
      `const big = a <b || c> 2;\n  const n = useCell(c).state.n;\n  return <p>{n}</p>;`,
      `const big = a <b && c> 2;\n  const n = useCell(c).state.n;\n  return <p>{n}</p>;`,
      `const big = f(a <b, c> 2);\n  const n = useCell(c).state.n;\n  return <p>{n}</p>;`,
      // What ends the run must be a tag: prose beside a `{…}` child is code.
      `const A = () => <p>useCell(c).state.x {a}</p>;`,
    ]
  ) assert(!at(code), code);
  // …and a statement after an element is code whatever its attributes hold.
  for (
    const el of [
      `<b onClick={() => go()}>x</b>`,
      `<br onClick={() => go()} />`,
      `<b title={a > b ? "x" : "y"} />`,
      `<b style={{ k: a > b }}>x</b>`,
    ]
  ) {
    const code =
      `const t = ${el};\n  const n = useCell(c).state.n;\n  return <p>{t}{n}</p>;`;
    assert(!at(code), code);
  }
  assert(!at(`const f = (a) => a > 1 ? { b } : useCell(c).state.x; <p />`));
  assert(!at(`const v = on ? () => { go(); } > useCell(c).state.x : <p />;`));
  // An element's attributes do not hide it — an expression that holds a `>`
  // (an arrow, a comparison), nested braces, a `}` in a string.
  for (
    const text of [
      `<button onClick={() => go()}>useCell(c).state.x</button>`,
      `<p hidden={a > b}>useCell(c).state.x</p>`,
      `<p hidden={a < b}>useCell(c).state.x</p>`,
      `<p hidden={a < b && c > d} title={<b>x</b>}>useCell(c).state.x</p>`,
      `<p style={{ color: a > b ? "red" : "blue" }}>useCell(c).state.x</p>`,
      `<p title={"}"} data-k="}">useCell(c).state.x</p>`,
      `<p {...(a > b ? x : y)} on={(e) => { go(e); }}>useCell(c).state.x</p>`,
      `<p\n  onClick={() => {\n    if (a > b) go();\n  }}\n>\n  useCell(c).state.x\n</p>`,
      `<p class="a > b" title='x'>useCell(c).state.x</p>`,
      `<p\n  class="a"\n  data-k={k}\n>\n  useCell(c).state.x\n</p>`,
      `<Row {...rest} wide>useCell(c).state.x</Row>`,
      `<input disabled />useCell(c).state.x</p>`,
    ]
  ) assert(at(`const A = () => ${text};`), text);
});

Deno.test("aiol useCell: a call in a template's `${…}` is code; the template's text is not", () => {
  const code = (src: string) =>
    [...src].map((ch, i) => codeMaskDeep(src)[i] === 1 ? ch : "·").join("");
  assertEquals(
    code('const t = `n=${f(c)} and ${ `in ${g(1)}` + "}" } \\${no}`;'),
    'const t = `····f(c)········ `·····g(1)·` + "·" ········`;',
  );
  const calls = (src: string) =>
    useCellCalls("a.ts", src).map((m) => src.slice(0, m.index).length);
  const tpl = "const t = `was useCell(c).state.n, now ${useCell(c).state.n}`;";
  assertEquals(calls(tpl), [tpl.lastIndexOf("useCell")]);
  assertEquals(calls("const t = `useCell(c) \\${useCell(c)}`;"), []);
  assertEquals(calls("// useCell(c)\nfunction useCell(c) {}"), []);
});

// The binding goes only when no use is left — whatever the fix could not
// rewrite, and however a use was (mis)read.
Deno.test("aiol useCell fix: the import is never removed while a use remains", async () => {
  const I = `import { useCell } from "aio";\nimport { c } from "./cell.ts";\n`;
  const dir = await tempDir("aiol-usecell-import-");
  const fixed = async (name: string, src: string) => {
    const path = join(dir, name);
    await Deno.writeTextFile(path, src);
    await fixUseCellStateReads(path)();
    return await Deno.readTextFile(path);
  };
  try {
    for (
      const [name, body, after] of [
        // a second use between two elements — once taken for JSX text
        [
          "View.tsx",
          `const a = useCell(c).state.n;\nconst t = <h1>Hi</h1>;\nconst b = useCell(c).state.n;\nexport const V = <p>{t}{a}{b}</p>;\n`,
          `const a = c.n;\nconst t = <h1>Hi</h1>;\nconst b = c.n;\nexport const V = <p>{t}{a}{b}</p>;\n`,
        ],
        // in a .ts file `<T>x` is a cast, and `<` after it a comparison
        [
          "cast.ts",
          `export const n = <number>useCell(c).state.n;\nexport const m = <number>n;\n`,
          `export const n = <number>c.n;\nexport const m = <number>n;\n`,
        ],
        // no use at all, and nothing else names it: the import alone goes
        ["dangling.ts", `export const a = c.n;\n`, `export const a = c.n;\n`],
        // a use in a template's `${…}` is a use
        [
          "tpl.ts",
          "export const a = useCell(c).state.n;\nexport const t = `n=${useCell(c).state.n}`;\n",
          "export const a = c.n;\nexport const t = `n=${c.n}`;\n",
        ],
      ] as const
    ) {
      const out = await fixed(name, I + body);
      assertEquals(out, `import { c } from "./cell.ts";\n` + after, name);
    }
    for (
      const [name, body, after] of [
        // forms the fix has no rewrite for keep their binding
        [
          "generic.ts",
          `export const a = useCell(c).state.n;\nexport const b = useCell<number>(c);\n`,
          `export const a = c.n;\nexport const b = useCell<number>(c);\n`,
        ],
        [
          "value.ts",
          `export const a = useCell(c).state.n;\nexport const u = useCell;\n`,
          `export const a = c.n;\nexport const u = useCell;\n`,
        ],
        [
          "whole.ts",
          `export const a = useCell(c).state.n;\nexport const s = useCell(c);\n`,
          `export const a = c.n;\nexport const s = useCell(c);\n`,
        ],
        [
          "whole-tpl.ts",
          "export const a = useCell(c).state.n;\nexport const s = `${String(useCell(c))}`;\n",
          "export const a = c.n;\nexport const s = `${String(useCell(c))}`;\n",
        ],
        // …and so does a file that still WRITES the name, wherever: whether
        // that mention is code is a judgement, and the import does not ride
        // on it.
        [
          "comment.ts",
          `export const a = useCell(c).state.n; // was useCell\n`,
          `export const a = c.n; // was useCell\n`,
        ],
        [
          "string.ts",
          `export const a = useCell(c).state.n;\nexport const s = "useCell";\n`,
          `export const a = c.n;\nexport const s = "useCell";\n`,
        ],
        [
          "template.ts",
          "export const a = useCell(c).state.n;\nexport const s = `useCell`;\n",
          "export const a = c.n;\nexport const s = `useCell`;\n",
        ],
        // In a file with JSX the name written where the mask blanks —
        // here, as shown text — is not proven aio's: nothing is rewritten.
        [
          "Shown.tsx",
          `export const V = <p><code>useCell(c).state.n</code>{useCell(c).state.n}</p>;\n`,
          `export const V = <p><code>useCell(c).state.n</code>{useCell(c).state.n}</p>;\n`,
        ],
      ] as const
    ) {
      assertEquals(await fixed(name, I + body), I + after, name);
    }
  } finally {
    await dropTempDir(dir);
  }
});

// A rewrite keyed on a name aio exports asks whose that name is HERE.
Deno.test("aiol nameBinding: aio's, the file's own, both, or nobody's", () => {
  const USE = `export const n = useCell(c).state.x;\n`;
  const is = (head: string, name = "useCell") => nameBinding(head + USE, name);
  for (
    const aio of [
      `import { useCell } from "aio";\n`,
      `import { cell, useCell } from "aio/air";\n`,
      `import { useCell } from "jsr:@riagentic/aio@1.0.17-beta";\n`,
      `import { useCell } from "@riagentic/aio";\n`,
      `import { useCell } from "../../dep/aio/mod.ts";\n`,
      // beside what is POSITIVELY a use of that import, or another object's
      `import { useCell } from "aio";\nconst f = (h: typeof useCell) => h;\n`,
      `import { useCell } from "aio";\nconst v = useCell<N>(c), w = o.useCell;\n`,
      `import { useCell } from "aio";\nclass K { useCell(c: C) { return c; } }\n`,
      `import { useCell } from "aio";\n// const useCell = mine\n`,
      `import { useCell as hook, useCell } from "aio";\n`,
    ]
  ) assertEquals(is(aio), "aio", aio);
  // Written any other way beside the import — passed along, a key, a
  // shorthand — the file is not rewritten: nothing here reads that as a use.
  for (
    const unread of [
      `const o = { useCell };\n`,
      `run(a, useCell);\n`,
      `const l = [useCell];\n`,
      `const f = (o: { useCell: F }) => o;\n`,
      `const o = { useCell: 1 }; o.useCell;\n`,
      `const { useCell: when } = cfg;\n`,
      `function f({ useCell: when }: Cfg) {}\n`,
      `export { useCell };\n`,
      `export default useCell;\n`,
      `export const V = () => <X on={useCell} />;\n`,
      `namespace useCell.inner { export const a = 1; }\n`,
      `export const f = useCell => 1;\n`,
    ]
  ) {
    const use = whose(`import { useCell } from "aio";\n` + unread + USE)(
      -1,
      "useCell",
    );
    assertEquals(use.who, "shadowed", unread);
    assert(use.why.includes("line 2 writes `useCell`"), use.why);
  }
  for (
    const own of [
      `import { useCell } from "jsr:@hooks/core@1";\n`,
      `import { useCell } from "node:hooks";\n`,
      `import { useCell } from "npm:hooks@1";\n`,
      `import { useCell } from "https://esm.sh/hooks";\n`,
      `import * as useCell from "./hooks.ts";\n`,
      `import { other as useCell } from "aio";\n`,
      `function useCell(c: C) { return { state: c }; }\n`,
      `export function* useCell() {}\n`,
      `const useCell = hooks.useCell;\n`,
      `let useCell: F;\n`,
      `class useCell {}\n`,
      `const { useCell } = hooks;\n`,
      `const { cell: useCell } = hooks;\n`,
      `const [useCell] = hooks;\n`,
      `const { useCell } = await import("npm:some-lib@1");\n`,
      `export const f = (useCell: F) => useCell(c).state.x;\n`,
      `export const f = (a: A, useCell?: F) => 1;\n`,
      `export const f = useCell => 1;\n`,
      `export function f({ useCell }: H) { return 1; }\n`,
      `export function f({ cell: useCell }: H): number { return 1; }\n`,
      `export function f(...useCell: F[]) { return 1; }\n`,
      `try { go(); } catch (useCell) { go(); }\n`,
    ]
  ) {
    assertEquals(is(own), "other", own);
    // Beside aio's import it is a second binding: one of the two is meant.
    assertEquals(is(`import { useCell } from "aio";\n` + own), "shadowed", own);
    // …so the rule has nothing to say about it.
    assertEquals(useCellCalls("a.ts", own + USE), [], own);
  }
  // The app's own MODULE may be a barrel over aio: possibly aio's — said,
  // with the module's name, and left to a person.
  for (
    const barrel of [
      `import { useCell } from "./hooks.ts";\n`,
      `import { useCell } from "../lib/aio.ts";\n`,
      `import { useCell } from "/srv/app/aio.ts";\n`,
      `import useCell from "./hooks.ts";\n`,
      `import { hook as useCell } from "./hooks.ts";\n`,
      `const { useCell } = await import("./lib/aio.ts");\n`,
      // A bare specifier no import map explains is unknown, not "a package".
      `import { useCell } from "some-lib";\n`,
      `import { useCell } from "fw";\n`,
      `const { useCell } = await import("some-lib");\n`,
    ]
  ) {
    assertEquals(is(barrel), "maybe", barrel);
    assertEquals(useCellCalls("a.ts", barrel + USE).length, 1, barrel);
    const use = whose(barrel + USE)(-1, "useCell");
    assert(
      /imported from "[^"]+" — aiol cannot tell whose/.test(use.why),
      use.why,
    );
  }
  // `await import("aio")` binds inside one function: which uses it reaches
  // is a question of scope. Named, never rewritten.
  for (
    const held of [
      `const { useCell } = await import("aio");\n`,
      `const { cell, useCell: useCell } = await import("aio/air");\n`,
    ]
  ) {
    assertEquals(is(held), "maybe", held);
    const use = whose(held + USE)(-1, "useCell");
    assert(use.why.includes("is bound by `await import("), use.why);
  }
  // Whatever the app's import map resolves to aio is aio.
  const kinds = specKinds({
    "aio": "/srv/aio/mod.ts",
    "fw": "/srv/aio/mod.ts",
    "@aio/core": "jsr:@riagentic/aio@1.0.17-beta",
    "vendored": "./dep/aio/mod.ts",
    "@/": "./src/",
    "sheets": "npm:sheets@1",
  });
  for (
    const [spec, who] of [
      ["fw", "aio"],
      ["@aio/core", "aio"],
      ["vendored", "aio"],
      ["/srv/aio/mod.ts", "aio"],
      ["@/lib/aio.ts", "maybe"],
      ["sheets", "other"],
      ["unmapped", "maybe"],
    ] as const
  ) {
    const src = `import { useCell } from "${spec}";\n` + USE;
    assertEquals(nameBinding(src, "useCell", kinds), who, spec);
  }
  // What is not a map of strings is no map; the longest prefix wins; the
  // registry's own URL and `jsr:/` spelling are aio.
  for (const none of [null, undefined, ["fw"], "x", 5]) {
    assertEquals(specKinds(none)("fw"), "maybe", String(none));
    assertEquals(specKinds(none)("aio/air"), "aio", String(none));
  }
  const odd = specKinds({
    "fw": null,
    "aio": 5,
    "x/": {},
    "@/": "./src/",
    "@/fw/": "/srv/aio/",
    "@/fw/deep/": "npm:deep@1/",
    "web": "https://jsr.io/@riagentic/aio/1.0.16-beta/mod.ts",
    "slash/": "jsr:/@riagentic/aio@^1.0.0/",
    "cdn": "https://esm.sh/x",
  });
  assertEquals(
    ["fw", "@/a.ts", "@/fw/mod.ts", "@/fw/deep/x.ts", "web", "slash/air", "cdn"]
      .map((spec) => odd(spec)),
    ["maybe", "maybe", "maybe", "other", "aio", "aio", "other"],
  );
  assertEquals(
    specKinds({
      "aio": "/srv/aio/mod.ts",
      "@/": "./src/",
      "@/fw/": "/srv/aio/",
    })(
      "@/fw/mod.ts",
    ),
    "aio",
  );
  // A file that holds aio as a VALUE: a local may be taken from it, so
  // "declared here" proves nothing — unless no value can stand behind it.
  for (
    const taken of [
      `import * as a from "aio";\nconst { useCell } = a;\n`,
      `import * as a from "aio";\nconst useCell = a.useCell;\n`,
      `const m = await import("aio");\nconst { useCell } = m;\n`,
      `export const e = import("aio").then(({ useCell }) => 1);\n`,
      `export const f = (useCell: typeof import("aio").useCell) => 1;\n`,
      `import * as a from "./lib/aio.ts";\nconst { useCell } = a;\n`,
      `const useCell = (await import(where)).useCell;\n`,
    ]
  ) {
    assertEquals(is(taken), "maybe", taken);
    assertEquals(useCellCalls("a.ts", taken + USE).length, 1, taken);
    assert(whose(taken + USE)(-1, "useCell").why.includes("holds aio"), taken);
  }
  for (
    const mine of [
      `import * as a from "aio";\nfunction useCell() {}\n`,
      `import * as a from "aio";\nclass useCell {}\n`,
      `import * as a from "npm:hooks@1";\nconst { useCell } = a;\n`,
      `const m = await import("node:hooks");\nconst { useCell } = m;\n`,
    ]
  ) assertEquals(is(mine), "other", mine);
  // `import { useCell as hook }` binds `hook`; a `useCell` beside it is the
  // file's own, and none at all is nobody's.
  assertEquals(is(`import { useCell as hook } from "aio";\n`), "none");
  assertEquals(
    is(`import { useCell as hook } from "aio";\nconst useCell = hooks.mine;\n`),
    "other",
  );

  // A MEMBER is the object's own — unless the object is aio, as a namespace.
  const at = (src: string, kinds = specKinds()) =>
    whose(src, kinds)(src.lastIndexOf("useCell"), "useCell");
  for (
    const member of [
      `export const n = p.useCell(c).state.x;`,
      `export const n = p?.useCell(c).state.x;`,
      `export const n = this.hooks.useCell(c).state.x;`,
      `export const n = this.#useCell(c).state.x;`,
      `export const n = hooks()\n  .useCell(c).state.x;`,
      `import * as aio from "aio";\nexport const n = this.aio.useCell(c).state.x;`,
      `import * as sh from "npm:sheets@1";\nexport const n = sh.useCell(c).state.x;`,
      // in a file that holds aio as a value, too — where nothing can be it
      `import * as aio from "aio";\nexport const n = this.useCell(c).state.x;`,
      `import * as aio from "aio";\nfunction mk() {}\nexport const n = mk.useCell(c).state.x;`,
      `import * as aio from "aio";\nexport const n = a.b.useCell(c).state.x;`,
      `import * as aio from "aio";\nexport const n = list[0].useCell(c).state.x;`,
      `import * as aio from "aio";\nconst b = aio;\nexport const n = this.b.useCell(c).state.x;`,
      `import { useCell } from "aio";\nexport const n = p.useCell(c).state.x;`,
    ]
  ) {
    assertEquals([at(member).who, at(member).member], ["other", true], member);
    assertEquals(
      useCellCalls("a.ts", member).length,
      0,
      member,
    );
  }
  assertEquals(
    at(`import * as aio from "aio";\nexport const n = aio.useCell(c).state.x;`)
      .who,
    "aio",
  );
  assertEquals(
    at(
      `import * as fw from "./lib/aio.ts";\nexport const n = fw.useCell(c).state.x;`,
    ).who,
    "maybe",
  );
  assertEquals(
    at(`export const l = [...useCell(c).state.list];`).member,
    false,
  );
  // `const ns = await import("aio")` holds aio — inside one function.
  assertEquals(
    at(
      `const ns = await import("aio");\nexport const n = ns.useCell(c).state.x;`,
    )
      .who,
    "maybe",
  );
  // A namespace written any way but as a receiver is not proven either.
  for (
    const passed of [
      `import * as aio from "aio";\nrun(aio);\nexport const n = aio.useCell(c).state.x;`,
      `import * as aio from "aio";\nexport const f = (aio: A) => aio.useCell(c).state.x;`,
      `import * as aio from "aio";\nexport { aio };\nexport const n = aio.useCell(c).state.x;`,
    ]
  ) assertEquals(at(passed).who, "maybe", passed);
  assertEquals(
    at(`import * as aio from "aio";\nexport const n = aio!.useCell(c).state.x;`)
      .who,
    "aio",
  );
  // Where the file holds aio as a value, an expression or a local that may
  // BE it is not proven the app's own.
  for (
    const maybe of [
      `import * as aio from "aio";\nexport const n = (aio).useCell(c).state.x;`,
      `import * as aio from "aio";\nconst b = aio;\nexport const n = b.useCell(c).state.x;`,
      `export const n = (await import("aio")).useCell(c).state.x;`,
      `export const f = (p: P) => import("aio").then(() => p.useCell(c).state.x);`,
      `import * as aio from "aio";\nexport const n = pick.one(aio).useCell(c).state.x;`,
      `import * as fw from "some-lib";\nexport const n = fw.useCell(c).state.x;`,
    ]
  ) {
    assertEquals([at(maybe).who, at(maybe).member], ["maybe", true], maybe);
    assertEquals(useCellCalls("a.ts", maybe).length, 1, maybe);
  }
  // A property the file names itself is never aio's export.
  for (
    const key of [
      `const o = { useCell: 1 };`,
      `const o = { a: 1, useCell };`,
      `const o = { useCell, a: 1 };`,
      `const { useCell: hook } = hooks;`,
      `type T = { useCell: F; a: 1 };`,
      `type T = {\n  a: 1\n  useCell?: F\n};`,
      `interface I { readonly useCell: F }`,
      `class K {\n  x = 1\n  useCell = 2;\n}`,
      `class K { static useCell = 2; }`,
      `class K { useCell(c: C) { return c; } }`,
      `const o = { async useCell(c: C) { return c; } };`,
    ]
  ) {
    const use = whose(`import { useCell } from "aio";\n` + key)(
      key.indexOf("useCell") + `import { useCell } from "aio";\n`.length,
      "useCell",
    );
    assertEquals([use.who, use.member], ["other", true], key);
  }
  for (
    const value of [
      `const o = { a: useCell };`,
      `const o = { a: ok ? useCell : other };`,
      `const l = [a, useCell, b];`,
      `run(a, useCell, b);`,
      `export { useCell };`,
      `export { a, useCell, b };`,
      `import x, { useCell, y } from "z";`,
      `export const V = () => <X on={useCell} />;`,
      `{\n  useCell(c);\n}`,
      `switch (x) {\n  case useCell:\n    break;\n}`,
      `const t: Map<string, useCell> = m;`,
    ]
  ) {
    const head = `import { useCell } from "aio";\n`;
    const use = whose(head + value)(
      head.length + value.indexOf("useCell"),
      "useCell",
    );
    // None of them is a KEY — and only the call is, positively, a use.
    assertEquals(
      [use.who, use.member],
      [value.includes("useCell(c)") ? "aio" : "shadowed", false],
      value,
    );
  }
  assertEquals(is(``), "none");
  assertEquals(is(`// import { useCell } from "aio";\n`), "none");
  // A TYPE used in a parameter's annotation is a reference, not a parameter.
  const T = `import type { CellAccess } from "aio";\n`;
  for (
    const ref of [
      `export const f = (a: CellAccess) => a;\n`,
      `export function f(a: X | CellAccess, b: CellAccess[]) {}\n`,
      `export function f(a: Box<CellAccess>): CellAccess { return a[1]; }\n`,
      `export const v: CellAccess = x as CellAccess;\n`,
      `export type A = CellAccess<T> & Other;\n`,
      `export interface I extends CellAccess { a: CellAccess; b: CellAccess | null }\n`,
      `export const l = mk<CellAccess>();\nexport class K implements CellAccess {}\n`,
    ]
  ) assertEquals(nameBinding(T + ref, "CellAccess"), "aio", ref);
  // A position where a DECLARATION could stand as well is not read as a use.
  for (
    const unread of [
      `export function f(b: Map<string, CellAccess>) {}\n`,
      `export function f(a: [string, CellAccess]) {}\n`,
      `export function f(o: { a: CellAccess }) { return o; }\n`,
      `export type Box<CellAccess> = { v: 1 };\n`,
      `export function id<CellAccess>(x: number) { return x; }\n`,
      `export const id = <CellAccess,>(x: number) => x;\n`,
      `export class K { id<CellAccess>(x: number) { return x; } }\n`,
    ]
  ) assertEquals(nameBinding(T + unread, "CellAccess"), "shadowed", unread);
  // …and so is one that is an arrow's RETURN type.
  assertEquals(
    nameBinding(
      T + `export const h = <X extends CellAccess>(x: X): CellAccess => x;\n`,
      "CellAccess",
    ),
    "aio",
  );
  // `type` in an import list is a modifier, not a declaration.
  for (
    const inline of [
      `import { cell, type CellAccess } from "aio";\n`,
      `import { type JSX, type CellAccess } from "aio";\n`,
      `import {\n  type CellAccess,\n} from "aio";\n`,
    ]
  ) {
    assertEquals(
      nameBinding(inline + `export type A = CellAccess;\n`, "CellAccess"),
      "aio",
      inline,
    );
  }
  for (
    const decl of [
      `type CellAccess = string;\n`,
      `export type CellAccess<T> = T[];\n`,
      `interface CellAccess { a: 1 }\n`,
      `enum CellAccess { A }\n`,
      `namespace CellAccess { export const a = 1; }\n`,
      `declare const CellAccess: unique symbol;\n`,
      `declare function CellAccess(): void;\n`,
    ]
  ) {
    assertEquals(
      nameBinding(decl + `export type A = CellAccess;\n`, "CellAccess"),
      "other",
      decl,
    );
    assertEquals(nameBinding(T + decl, "CellAccess"), "shadowed", decl);
  }
  // A re-export is neither an import nor a declaration.
  assertEquals(
    nameBinding(`export type { CellAccess } from "aio";\n`, "CellAccess"),
    "none",
  );
});

Deno.test("aiol name-keyed fixes: the file's own name, and a name nothing binds, is left byte for byte; aio's is fixed", async () => {
  const dir = await tempDir("aiol-own-name-");
  const fixed = async (
    fix: (path: string) => () => Promise<boolean>,
    src: string,
  ) => {
    const path = join(dir, "x.ts");
    await Deno.writeTextFile(path, src);
    await fix(path)();
    return await Deno.readTextFile(path);
  };
  const words = (path: string) =>
    fixRenameWords(path, [["ExtractState", "StateOf"]]);
  try {
    for (
      const [fix, own, use, aio, after] of [
        [
          fixUseCellStateReads,
          [
            `import { useCell } from "./hooks.ts";\n`,
            `function useCell<T>(c: T) { return { state: c }; }\n`,
            `import { useCell } from "aio";\nexport const f = (useCell: F) => useCell(c).state.n;\n`,
          ],
          `export const n = useCell(c).state.n;\n`,
          `import { useCell } from "aio";\n`,
          `export const n = c.n;\n`,
        ],
        [
          fixPollBackoffKey,
          [
            `import { schedule } from "./jobs.ts";\n`,
            `const schedule = makeScheduler();\n`,
            `import { schedule } from "aio";\nexport const f = (schedule: S) => schedule.now();\n`,
          ],
          `export const p = schedule.poll("p", 0, A.tick(), { every: 1, backoff: 2 });\n`,
          `import { schedule } from "aio";\n`,
          `import { schedule } from "aio";\nexport const p = schedule.poll("p", 0, A.tick(), { every: 1, factor: 2 });\n`,
        ],
        [
          fixScheduleBlocking,
          [
            `import { schedule } from "./jobs.ts";\n`,
            `const { schedule } = jobs;\n`,
          ],
          `export const b = schedule.blocking("id", () => 1, 0);\n`,
          `import { schedule } from "aio";\n`,
          `import { schedule, blocking } from "aio";\nexport const b = blocking("id", () => 1, 0);\n`,
        ],
        [
          words,
          [
            `import type { ExtractState } from "./types.ts";\n`,
            `type ExtractState<T> = T extends { state: infer S } ? S : never;\n`,
            `interface ExtractState { a: 1 }\n`,
          ],
          `export type S = ExtractState<typeof c>;\n`,
          `import type { ExtractState } from "aio";\n`,
          `import type { StateOf } from "aio";\nexport type S = StateOf<typeof c>;\n`,
        ],
      ] as const
    ) {
      assert(own.length >= 2);
      for (const head of own) {
        assertEquals(await fixed(fix, head + use), head + use, head);
      }
      // No binding at all — the use an import was deleted from under:
      // nothing says whose it is, so it is left as written.
      assertEquals(await fixed(fix, use), use, use);
      // Imported from aio: fixed.
      assertEquals(await fixed(fix, aio + use), after, use);
    }
    // A member of the app's own object is not the name aio exports.
    const devtools = (path: string) =>
      fixRenameWords(path, [["connectDevTools", "connectReduxDevTools"]]);
    const members = [
      [
        fixUseCellStateReads,
        `export const V = (p: Hooks) => p.useCell(c).state.n;\n`,
      ],
      [
        fixPollBackoffKey,
        `class S {\n  tick() {\n    return this.schedule.poll("p", 0, A.tick(), { every: 1, backoff: 2 });\n  }\n}\n`,
      ],
      [
        fixScheduleBlocking,
        `export const v = (deps: Deps) => deps.schedule.blocking("id");\n`,
      ],
      [
        fixScheduleBlocking,
        `class S {\n  run() {\n    return this.schedule.blocking("id", () => 1, 0);\n  }\n}\n`,
      ],
      [
        fixUiKeyToVisible,
        `export const g = grid.cell("a1", { ui: ["bold"] });\nexport const h = grid\n  .cell("b2", { ui: [] });\n`,
      ],
      [devtools, `export const on = () => panel.connectDevTools();\n`],
    ] as const;
    assertEquals(members.length, 6);
    for (const [fix, src] of members) {
      assertEquals(await fixed(fix, src), src, src);
      // …whatever the file imports from aio beside it.
      const beside = `import { cell, schedule, useCell } from "aio";\n` + src;
      assertEquals(await fixed(fix, beside), beside, src);
    }
    // A renamed WORD that is also a property the file names itself is left
    // whole: renaming the import and not the property (or half of the
    // property) changes what the program reads.
    const KEYED = [
      `import { connectDevTools } from "aio";\n` + members[5][1],
      `import { connectDevTools } from "aio";\nexport const api = { connectDevTools };\nexport const go = () => api.connectDevTools();\n`,
      `export const opts = { connectDevTools: true, port: 1 };\nexport const on = () => (opts.connectDevTools ? "dev" : "prod");\n`,
      `const cfg = { connectDevTools: true };\nconst { connectDevTools: dev } = cfg;\nexport const on = () => dev && cfg.connectDevTools;\n`,
      `import { connectDevTools } from "aio";\nexport class Reg {\n  connectDevTools = 1;\n  read() {\n    return this.connectDevTools;\n  }\n}\nconnectDevTools();\n`,
    ];
    for (const src of KEYED) {
      assertEquals(await fixed(devtools, src), src, src);
      const uses = wordUses(src, "connectDevTools", "connectReduxDevTools");
      assert(uses.length >= 2, src);
      assertEquals(uses.filter((u) => fixable(u.use)), [], src);
      // …and where the file imports aio's, that is said, with the line.
      const said = uses.filter((u) => u.use.who !== "other");
      assertEquals(said.length > 0, src.includes(`from "aio"`), src);
      for (const u of said) {
        assert(
          /line \d+ writes `connectDevTools` in a way aiol cannot read/.test(
            u.use.why,
          ),
          u.use.why,
        );
      }
    }
    // `const { name } = await import("aio")` binds inside one function:
    // named for a look, not renamed.
    const DYNAMIC = `const { connectDevTools, other } = await ` +
      `import("aio");\nconnectDevTools();\n`;
    assertEquals(await fixed(devtools, DYNAMIC), DYNAMIC);
    assertEquals(
      wordUses(DYNAMIC, "connectDevTools", "connectReduxDevTools")
        .map((u) => u.use.who),
      ["maybe", "maybe"],
    );
    // ALL OR NOTHING: every place the file writes the word is renamed, or
    // none is. One that is not positively a use of the import stops them all.
    const WHOLE = (name: string, tail = "") =>
      `import { ${name} } from "aio";\nexport const on = () => ${name}();\n` +
      `export const t: typeof ${name} = ${name};\n` +
      "export const s = `${" + name + "()}`;\n" +
      `export { ${name} as cdt };\n` + tail;
    assertEquals(
      await fixed(devtools, WHOLE("connectDevTools")),
      WHOLE("connectReduxDevTools"),
    );
    for (
      const stop of [
        `export const api = { on: connectDevTools };\n`,
        `export { connectDevTools };\n`,
        `run(connectDevTools);\n`,
        `export { connectDevTools as other } from "aio";\n`,
        `export const f = (connectDevTools: F) => 1;\n`,
        // the new name already means something else here
        `const connectReduxDevTools = 1;\n`,
      ]
    ) {
      const src = WHOLE("connectDevTools", stop);
      assertEquals(await fixed(devtools, src), src, stop);
      const uses = wordUses(src, "connectDevTools", "connectReduxDevTools");
      assertEquals(uses.filter((u) => fixable(u.use)), [], stop);
      assert(
        uses.some((u) => /line (6|7)\b/.test(u.use.why)),
        `${stop}\n${uses.map((u) => u.use.why).join("\n")}`,
      );
    }
    // The new name already imported from aio beside the old: one binding.
    assertEquals(
      await fixed(
        (path) => fixRenameWords(path, [["CellAccess", "Access"]]),
        `import { type Access, type CellAccess } from "aio";\nexport type A = Access | CellAccess;\n`,
      ),
      `import { type Access } from "aio";\nexport type A = Access | Access;\n`,
    );
    // …and next to a real use, only the real use is rewritten.
    assertEquals(
      await fixed(
        fixScheduleBlocking,
        `import { schedule } from "aio";\nexport const a = schedule.blocking("id", f, 0);\n` +
          members[2][1],
      ),
      `import { schedule, blocking } from "aio";\nexport const a = blocking("id", f, 0);\n` +
        members[2][1],
    );
    assertEquals(
      scheduleBlockingToTop(`x.schedule.blocking(1);\n`, specKinds()),
      null,
    );
    // `blocking` lives in aio's MAIN entry: a `schedule` that came through a
    // sub-entry, or a namespace of one, has no import to add it to.
    const MAPPED = specKinds({
      "aio": "/srv/aio/mod.ts",
      "aio/extras": "/srv/aio/src/extras/mod.ts",
      "fw": "/srv/aio/mod.ts",
      "extras": "/srv/aio/src/extras/mod.ts",
    });
    const BLOCK = `export const e = schedule.blocking("id", f, 0);\n`;
    for (
      const [spec, to] of [
        ["aio", true],
        ["fw", true],
        ["@riagentic/aio", true],
        ["jsr:@riagentic/aio@1.0.17-beta", true],
        ["../dep/aio/mod.ts", true],
        ["aio/extras", false],
        ["extras", false],
        ["jsr:@riagentic/aio@1.0.17-beta/extras", false],
        ["../dep/aio/src/extras/mod.ts", true],
        ["../dep/aio/src/extras.ts", false],
      ] as const
    ) {
      const src = `import { schedule } from "${spec}";\n` + BLOCK;
      assertEquals(
        scheduleBlockingToTop(src, MAPPED),
        to
          ? `import { schedule, blocking } from "${spec}";\n` +
            `export const e = blocking("id", f, 0);\n`
          : null,
        spec,
      );
      const ns =
        `import * as fw from "${spec}";\nexport const e = fw.schedule.blocking("id", f, 0);\n`;
      assertEquals(
        scheduleBlockingToTop(ns, MAPPED) !== null,
        to,
        spec,
      );
    }
    // An aio NAMESPACE is aio: the prefix goes with the call, however the
    // two are joined.
    for (const dot of [".", "!.", "?.", " . ", "!\n  ."]) {
      assertEquals(
        await fixed(
          fixUseCellStateReads,
          `import * as aio from "aio";\nexport const n = aio${dot}useCell(c).state.n;\n`,
        ),
        `import * as aio from "aio";\nexport const n = c.n;\n`,
        dot,
      );
    }
    assertEquals(
      await fixed(
        fixUiKeyToVisible,
        `import * as aio from "aio";\nexport const c = aio.cell("c", { ui: ["a"] });\n`,
      ),
      `import * as aio from "aio";\nexport const c = aio.cell("c", { visible: ["a"] });\n`,
    );
    // aio's own: fixed, as before.
    assertEquals(
      await fixed(
        words,
        `import type { ExtractState } from "aio";\nexport type S = ExtractState<typeof c>;\n`,
      ),
      `import type { StateOf } from "aio";\nexport type S = StateOf<typeof c>;\n`,
    );
    const poll = await fixed(
      fixPollBackoffKey,
      `import { schedule } from "aio";\nexport const p = schedule.poll("p", 0, tick, { every: 1, backoff: 2 });\n`,
    );
    assert(poll.endsWith(`tick, { every: 1, factor: 2 });\n`), poll);
  } finally {
    await dropTempDir(dir);
  }
});

// `cell("name", {…})`: only a `cell` that is PROVEN aio's — or has no binding
// at all — is rewritten. Through the app's own module that takes the module
// being one of the files the run holds.
Deno.test("aiol cell-shaped fixes: only a `cell` proven aio's is rewritten — through a barrel when the run holds it", async () => {
  const UI =
    `export const c = cell("c", {\n  state: { n: 0 },\n  ui: { exclude: ["n"] },\n});\n`;
  const EFFECT =
    `export const d = cell("d", {\n  state: { n: 0 },\n  methods: {\n    tick(s) {\n      s.n++;\n      return schedule.after(1000, { type: "d:tick" });\n    },\n  },\n});\n`;
  const S = `import { schedule } from "aio";\n`;
  const dir = await tempDir("aiol-own-cell-");
  const fixed = async (
    fix: (path: string) => () => Promise<boolean>,
    src: string,
  ) => {
    const path = join(dir, "x.ts");
    await Deno.writeTextFile(path, src);
    await fix(path)();
    return await Deno.readTextFile(path);
  };
  try {
    const aios = [
      `import { cell } from "aio";\n`,
      `import { cell } from "jsr:@riagentic/aio@1.0.17-beta";\n`,
    ];
    assertEquals(aios.length, 2);
    for (const head of aios) {
      assertEquals(cellDecline(head + UI), "", head);
      const ui = await fixed(fixUiKeyToVisible, head + UI);
      assert(ui.includes(`visible: { exclude: ["n"] }`), head + ui);
      assertEquals(
        returnEffectDecline(S + head + EFFECT, 0)?.includes("cell"),
        false,
        head,
      );
      const eff = await fixed(fixReturnEffectsToDo, S + head + EFFECT);
      assert(eff.includes("s.$do(schedule.after("), head + eff);
    }
    const own = [
      `import { cell } from "npm:sheets@1";\n`,
      `import { cell } from "jsr:@grid/core";\n`,
      `import { cell } from "https://esm.sh/sheets";\n`,
      `import { cell } from "sheets";\n`,
      `import cell from "sheets";\n`,
      // the app's own module, which this call cannot open
      `import { cell } from "./aio.ts";\n`,
      `import { cell } from "../lib/aio.ts";\n`,
      `import { cell } from "/srv/app/aio.ts";\n`,
      `const cell = (name: string, o: object) => ({ name, ...o });\n`,
      `function cell(name: string, o: object) { return { name, ...o }; }\n`,
      `import { cell } from "aio";\nexport const f = (cell: Cell) => cell.id;\n`,
      // nothing binds it, or `await import(…)` does inside one function:
      // nothing here proves whose it is
      ``,
      `const { cell } = await import("aio");\n`,
      `import { cell } from "aio";\nexport const cells = { cell };\n`,
    ];
    assertEquals(own.length, 14);
    for (const head of own) {
      assert(cellDecline(head + UI).startsWith("the safe fix declines"), head);
      assertEquals(await fixed(fixUiKeyToVisible, head + UI), head + UI, head);
      // One reason for both rules (the line it names is one further down
      // under the extra import).
      const line = (why: string | null) =>
        why?.replace(/line \d+/, (l) => `line ${+l.slice(5) + 1}`);
      assertEquals(
        returnEffectDecline(S + head + EFFECT, 0),
        line(cellDecline(head + UI)),
        head,
      );
      assertEquals(
        await fixed(fixReturnEffectsToDo, S + head + EFFECT),
        S + head + EFFECT,
        head,
      );
    }
    // The app's own module, when the run holds it: a barrel over aio is aio
    // (and fixed), a module with its own `cell` is not.
    const held = (barrel: string) => (path: string) =>
      fixUiKeyToVisible(
        path,
        specKinds({}, {
          root: dir,
          from: path,
          source: (p) =>
            p === join(dir, "aio.ts")
              ? barrel
              // ONE hop: what this one re-exports is not followed.
              : p === join(dir, "deeper.ts")
              ? `export * from "aio";\n`
              : undefined,
        }),
      );
    const via = `import { cell } from "./aio.ts";\n` + UI;
    for (
      const barrel of [
        // the module gives `cell` exactly ONE source, and it is aio
        `export * from "aio";\n`,
        `export { cell, schedule } from "aio";\n`,
        `export { cell } from "aio";\nexport * from "./deeper.ts";\n`,
        `// cell comes from aio\nexport * from "aio";\nexport const s = "cell";\n`,
      ]
    ) {
      assert(
        (await fixed(held(barrel), via)).includes(
          `visible: { exclude: ["n"] }`,
        ),
        barrel,
      );
    }
    for (
      const barrel of [
        `export const cell = (name: string, o: object) => ({ name, ...o });\n`,
        `export * from "aio";\nexport function cell() {}\n`,
        `export { sheet as cell } from "aio";\n`,
        `export * from "./deeper.ts";\n`,
        `export * as cell from "aio";\n`,
        `export const other = 1;\n`,
        // a local the module may have taken from somewhere, beside `*`
        `export * from "aio";\nimport * as a from "./x.ts";\nexport const { cell } = a;\n`,
        // aio's `cell` under ANOTHER name is not what `cell` imports
        `export { cell as sheet } from "aio";\n`,
        // the second hop
        `import { cell } from "./deeper.ts";\nexport { cell };\n`,
        // a wrapper: everything from aio, and `cell` its own
        `export * from "aio";\nexport { cell } from "./own.ts";\n`,
        `export * from "aio";\nimport { mine } from "./own.ts";\nexport { mine as cell };\n`,
        `export * from "aio";\nexport { default as cell } from "./own.ts";\n`,
        `export * from "aio";\nexport let n = 1, cell = mk;\n`,
        `import { cell } from "aio";\nimport { mine } from "./own.ts";\nexport { mine as cell, cell as aioCell };\n`,
        // two modules that may each supply it
        `export * from "aio";\nexport * from "./own.ts";\n`,
        `export { cell } from "aio";\nexport { cell } from "./own.ts";\n`,
        // named any other way than the one re-export
        `import { cell } from "aio";\nexport { cell };\n`,
        `export { cell } from "aio";\nexport const sheet = { cell: 1 };\n`,
        `export * from "aio";\nconst helpers = { cell };\n`,
      ]
    ) assertEquals(await fixed(held(barrel), via), via, barrel);
    // `cellDefaults.ui` is aio.run's own key, whatever `cell` is here.
    const defaults = own[8] +
      `await aio.run({ cellDefaults: { ui: { exclude: [] } } });\n`;
    assert(
      (await fixed(fixUiKeyToVisible, defaults)).includes(
        "cellDefaults: { visible:",
      ),
    );
    // The returned call's own name: the file's `schedule` is not an effect.
    for (
      const mine of [
        `import { schedule } from "./jobs.ts";\n`,
        `const schedule = makeScheduler();\n`,
        `const own = registry();\n` + S,
      ]
    ) {
      const src = mine + `import { cell } from "aio";\n` + EFFECT;
      assert(
        returnEffectDecline(src, 0)?.startsWith("the safe fix declines"),
        mine,
      );
      assertEquals(await fixed(fixReturnEffectsToDo, src), src, mine);
    }
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("aiol stillNamed: a name is a whole token, anywhere in the text", () => {
  for (
    const rest of [
      `useCell(c)`,
      `// useCell`,
      `"useCell"`,
      "`${useCell}`",
      `<code>useCell</code>`,
      `x.useCell`,
    ]
  ) assert(stillNamed(rest, "useCell"), rest);
  for (const rest of [``, `useCells`, `myuseCell`, `$useCell`, `usecell`]) {
    assert(!stillNamed(rest, "useCell"), rest);
  }
});

Deno.test("aiol React / createRoot fixes: the import stays while the file names it", async () => {
  const dir = await tempDir("aiol-react-import-");
  const fixed = async (
    fix: (path: string) => () => Promise<boolean>,
    src: string,
  ) => {
    const path = join(dir, "App.tsx");
    await Deno.writeTextFile(path, src);
    await fix(path)();
    return await Deno.readTextFile(path);
  };
  const BODY = `export default () => <p>hi</p>;\n`;
  try {
    const R = `import React from "react";\n`;
    assertEquals(await fixed(fixRemoveImportReact, R + BODY), BODY);
    for (
      const named of [
        `export const F = React.Fragment;\n`,
        "export const s = `${React.version}`;\n",
        `// React.StrictMode goes here\n`,
        `export const s = "React";\n`,
      ]
    ) {
      const src = R + BODY + named;
      assertEquals(await fixed(fixRemoveImportReact, src), src, named);
    }

    const C = `import { createRoot } from "react-dom/client";\n`;
    assertEquals(await fixed(fixRemoveCreateRootImport, C + BODY), BODY);
    for (
      const named of [
        `createRoot(document.body);\n`,
        "export const s = `${createRoot(document.body)}`;\n",
        `// createRoot(el).render(<App />)\n`,
      ]
    ) {
      const src = C + BODY + named;
      assertEquals(await fixed(fixRemoveCreateRootImport, src), src, named);
    }
    // The statement goes whole, so every name it binds is asked about.
    for (
      const [list, use] of [
        [`createRoot, hydrateRoot`, `hydrateRoot(document.body, null);\n`],
        [
          `createRoot, hydrateRoot as hydrate`,
          `hydrate(document.body, null);\n`,
        ],
        [`createRoot, type Root`, `export type R = Root;\n`],
      ]
    ) {
      const src = `import { ${list} } from "react-dom/client";\n` + BODY + use;
      assertEquals(await fixed(fixRemoveCreateRootImport, src), src, list);
    }
  } finally {
    await dropTempDir(dir);
  }
});

// `[fixable]` exactly when --safe-fix will act: the label and the fix ask one
// function.
Deno.test("aiol React / createRoot hints: [fixable] when the fix applies, [manual] when it declines", async () => {
  const label = async (app: string, needle: string) => {
    const dir = await tempDir("aiol-react-label-");
    try {
      await Deno.mkdir(join(dir, "src"));
      await Deno.writeTextFile(
        join(dir, "deno.json"),
        JSON.stringify({ imports: { aio: `${REPO}mod.ts` } }),
      );
      await Deno.writeTextFile(join(dir, "src/app.ts"), FILES["src/app.ts"]!);
      await Deno.writeTextFile(join(dir, "src/cell.ts"), FILES["src/cell.ts"]!);
      const path = join(dir, "src/App.tsx");
      await Deno.writeTextFile(path, app);
      const hit = (await lintProject(dir)).issues
        .filter((i) => i.message.includes(needle));
      assertEquals(hit.length, 1, needle);
      const applied = hit[0]!.safeFix ? await hit[0]!.safeFix(dir) : false;
      return {
        fixable: !!hit[0]!.safeFix,
        manual: !!hit[0]!.manual,
        applied,
        changed: await Deno.readTextFile(path) !== app,
      };
    } finally {
      await dropTempDir(dir);
    }
  };
  const yes = { fixable: true, manual: false, applied: true, changed: true };
  const no = { fixable: false, manual: true, applied: false, changed: false };
  const BODY = `export default () => <p>hi</p>;\n`;
  const R = `import React from "react";\n`;
  assertEquals(await label(R + BODY, "imports React"), yes);
  assertEquals(withoutReactImport(R + BODY), BODY);
  for (
    const kept of [
      R + BODY + `export const F = React.Fragment;\n`,
      R + BODY + `// React 18\n`,
      `import React, { useState } from "react"; // ok\n` + BODY,
    ]
  ) {
    assertEquals(await label(kept, "imports React"), no, kept);
    assertEquals(withoutReactImport(kept), null, kept);
  }
  const C = `import { createRoot } from "react-dom/client";\n`;
  assertEquals(await label(C + BODY, "uses createRoot"), yes);
  const mounted = C + BODY + `createRoot(document.body);\n`;
  assertEquals(await label(mounted, "uses createRoot"), no);
  assertEquals(withoutCreateRootImport(mounted), null);
});

// ── End to end: lint, fix, fix again, type-check ─────────────────────

const FILES: Record<string, string> = {
  "src/app.ts":
    `import { aio } from "aio";\nimport { counter } from "./cell.ts";\nawait aio.run({ appId: "myapp", cells: { counter } });\n`,
  "src/cell.ts":
    `import { cell } from "aio";\nexport const counter = cell("counter", {\n  state: { count: 0 },\n  methods: { increment(s: { count: number }) { s.count++; } },\n});\n`,
  // Own `call`s beside aio's: only aio's option is renamed.
  "src/own.ts": `import { call } from "aio";
type O = { timeout: number };
export class Client {
  call({ timeout: t }: { timeout: number }): number {
    return t;
  }
}
export const typed: { call(o: O): number } = {
  call({ timeout: t }): number {
    return t;
  },
};
export const real = (ok: boolean) =>
  ok ? call({ timeout: 5000 }, () => Promise.resolve(1)) : null;
`,
  "src/rpc.ts":
    `export function call({ timeout: t }: { timeout: number }): Promise<number> {\n  return Promise.resolve(t);\n}\n`,
  "src/uses-rpc.ts":
    `import { call } from "./rpc.ts";\nexport const viaRpc = () => call({ timeout: 5 });\n`,
  "src/local.ts":
    `const call = (o: { timeout: number }) => o.timeout;\nexport const local = call({ timeout: 5 });\n`,
  "src/poll.ts": `import { schedule } from "aio";
const type = "t:tick";
const tick = { type: "t:tick" };
export const shorthand = () =>
  schedule.poll("a", 0, { type, backoff: 2 }, { every: 1000 });
export const spread = () =>
  schedule.poll("b", 0, { ...tick, backoff: 2 }, { every: 1000 });
export const computed = () =>
  schedule.poll("c", 0, { ["type"]: "t:tick", backoff: 2 }, { every: 1000 });
`,
  "src/Doc.tsx": `import { counter } from "./cell.ts";
export const Doc = () => (
  <p>
    <code>useCell(counter).state.count</code> became {counter.count}
  </p>
);
`,
  // Shown AND used in one file: a file with JSX that writes the name where
  // the mask blanks is left whole, for a person.
  "src/Mixed.tsx": `import { useCell } from "aio";
import { counter } from "./cell.ts";
export const Mixed = () => (
  <p>
    <code>useCell(counter).state.count</code> is {useCell(counter).state.count}
  </p>
);
`,
  // A use between two elements is a statement, not their text.
  "src/View.tsx": `import { useCell } from "aio";
import { counter } from "./cell.ts";
export function View() {
  const total = useCell(counter).state.count;
  const title = <h1>Hi</h1>;
  const n = useCell(counter).state.count;
  return <p>{title}{n}{total}</p>;
}
`,
  "src/View2.tsx": `import { useCell } from "aio";
import { counter } from "./cell.ts";
export function View2() {
  const title = <h1>Hi</h1>;
  const n = useCell(counter).state.count;
  return <p>{title}{n}</p>;
}
`,
  // A tag spelled in a comment or a string before a statement is no element.
  "src/CommentTag.tsx": `import { useCell } from "aio";
import { counter } from "./cell.ts";
export function CommentTag() {
  const total = useCell(counter).state.count;
  // the <h1> title
  const n = useCell(counter).state.count;
  return <p>{n}{total}</p>;
}
`,
  "src/CommentTagOnly.tsx": `import { useCell } from "aio";
import { counter } from "./cell.ts";
export function CommentTagOnly() {
  // rendered inside <Layout>
  const n = useCell(counter).state.count;
  return <p>{n}</p>;
}
`,
  "src/StringTag.tsx": `import { useCell } from "aio";
import { counter } from "./cell.ts";
export function StringTag() {
  const total = useCell(counter).state.count;
  const open = "<div>";
  const n = useCell(counter).state.count;
  return <p>{n}{total}{open}</p>;
}
`,
  "src/ClosingComment.tsx": `import { useCell } from "aio";
import { counter } from "./cell.ts";
export function ClosingComment() {
  const total = useCell(counter).state.count;
  const t = <b>x</b>;
  const n = useCell(counter).state.count; // goes before </b>
  return <p>{n}{total}{t}</p>;
}
`,
  "src/Compare.tsx": `import { useCell } from "aio";
import { counter } from "./cell.ts";
export function Compare(a: number, b: number, c: number) {
  const big = a <b || c> 2;
  const n = useCell(counter).state.count;
  return <p>{n}{String(big)}</p>;
}
`,
  // A use in a template's interpolation is a use.
  "src/tpl.ts": `import { useCell } from "aio";
import { counter } from "./cell.ts";
export const plain = useCell(counter).state.count;
export const text = \`n=\${useCell(counter).state.count}\`;
`,
  // Not aio's \`call\`: a private member, and a parameter of that name.
  "src/private.ts": `import { call } from "aio";
type O = { timeout: number };
export class Rpc {
  #call({ timeout: t }: O) {
    return t;
  }
  run() {
    return this.#call({ timeout: 5 });
  }
}
export const k = call;
`,
  "src/shadow.ts": `import { call } from "aio";
type Fn = (o: { timeout: number }) => number;
export const run = (call: Fn) => call({ timeout: 5 });
export const k = call;
`,
  // The app's own names that aio also has (or had): none of it is aio's.
  "src/hooks.ts": `export function useCell<T>(c: T): { state: T } {
  return { state: c };
}
type Opts = { every: number; backoff: number };
export const schedule = {
  poll: (_id: string, _n: number, _a: unknown, o: Opts) => o,
  blocking: (_id: string, fn: () => number, _arg: number) => fn(),
};
export type ExtractState<T> = T extends { state: infer S } ? S : never;
`,
  "src/OwnHook.tsx": `import { useCell } from "./hooks.ts";
import { counter } from "./cell.ts";
export const OwnHook = () => <p>{useCell(counter).state.count}</p>;
`,
  "src/LocalHook.tsx": `import { counter } from "./cell.ts";
function useCell<T>(c: T): { state: T } {
  return { state: c };
}
export const LocalHook = () => <p>{useCell(counter).state.count}</p>;
`,
  "src/own-names.ts": `import { type ExtractState, schedule } from "./hooks.ts";
export const p = schedule.poll("p", 0, { type: "t" }, { every: 9, backoff: 2 });
export const b = schedule.blocking("id", () => 1, 0);
export type S = ExtractState<{ state: number }>;
`,
  // A METHOD of the app's own object, spelled like aio's API: never aio's.
  "src/own-members.ts": `class Scheduler {
  blocking(id: string, f: () => number, n: number) {
    return f() + n + id.length;
  }
  poll(a: string, b: number, c: { type: string }, d: { every: number; backoff: number }) {
    return a + b + c.type + d.every + d.backoff;
  }
}
export class Svc {
  schedule = new Scheduler();
  run() {
    return this.schedule.blocking("id", () => 1, 0);
  }
  tick() {
    return this.schedule.poll("rpc", 0, { type: "t" }, { every: 5, backoff: 2 });
  }
}
type Deps = { schedule: { blocking(id: string): number } };
export const viaDeps = (deps: Deps) => deps.schedule.blocking("id");
const grid = { cell: (name: string, o: { ui: string[] }) => ({ name, ...o }) };
export const g = grid.cell("a1", { ui: ["bold"] });
export const h = grid
  .cell("b2", { ui: [] });
`,
  "src/OwnMember.tsx": `import { counter } from "./cell.ts";
type Hooks = { useCell: (c: unknown) => { state: { count: number } } };
export const OwnMember = (p: Hooks) => <p>{p.useCell(counter).state.count}</p>;
`,
  // Through the app's own barrel, which the run holds: a barrel that only
  // passes aio on is proven aio's, and its users are fixed. One that NAMES
  // what it re-exports hands the old name out by that name: it and its users
  // are left to a person, together.
  "src/barrel.ts": `export * from "aio";\n`,
  "src/via-barrel.ts": `import { call } from "./barrel.ts";
export const viaBarrel = () => call({ timeout: 5 }, () => Promise.resolve(1));
`,
  "src/named.ts": `export type { ExtractState } from "aio";\n`,
  "src/via-named.ts": `import type { ExtractState } from "./named.ts";
export type ViaNamed = ExtractState<{ state: number }>;
`,
  // …and the import nothing calls any more, through the same barrel.
  "src/left-barrel.ts":
    `import { useCell } from "./barrel.ts";\nexport const leftBarrel = 1;\n`,
  // Through a module the run does not hold: possibly aio's — said, never
  // rewritten.
  "vendor/rpc.ts":
    `export const call = (o: { timeout: number }, f: () => unknown) => [o.timeout, f];
export function useCell<T>(c: T): { state: T } {
  return { state: c };
}
`,
  "src/via-outside.ts": `import { call } from "../vendor/rpc.ts";
export const viaOutside = () => call({ timeout: 5 }, () => 1);
`,
  // A renamed word that is also a property the file names itself: left whole.
  "src/keyed.ts": `import type { ExtractState } from "aio";
export type M = { ExtractState: ExtractState<{ state: number }> };
export const read = (m: M) => m.ExtractState;
`,
  // A local taken from an aio namespace: aio's, but nothing here proves it.
  "src/Taken.tsx": `import * as fw from "aio";
import { counter } from "./cell.ts";
const { useCell } = fw as unknown as { useCell: <T,>(c: T) => { state: T } };
export const Taken = () => <p>{useCell(counter).state.count}</p>;
`,
  // An effect returned through an aio NAMESPACE is aio's removed spelling;
  // the fix knows only the bare one. A method of the app's own object that
  // returns its own \`schedule.…(\` is neither.
  "src/ns-effects.ts": `import * as fw from "aio";
export const nsfx = fw.cell("nsfx", {
  state: { n: 0 },
  methods: {
    one(s: { n: number }) {
      s.n++;
      return fw.schedule.after("a", 10, { type: "nsfx:one" });
    },
    two(s: { n: number }) {
      s.n++;
      return [fw.schedule.after("b", 10, { type: "nsfx:one" }), fw.own.dispose("h")];
    },
  },
});
const mine = { schedule: { after: (id: string) => id } };
export const three = () => {
  return mine.schedule.after("c");
};
`,
  // A candidate (through the app's own module) BEFORE aio's own use: the one
  // the fix rewrites is the one reported, and only that one is rewritten.
  "src/Both.tsx": `import { useCell } from "aio";
import * as lib from "../vendor/rpc.ts";
import { counter } from "./cell.ts";
export const Both = () => (
  <p>
    {lib.useCell(counter).state.count}
    {useCell(counter).state.count}
  </p>
);
`,
  // Through an import-map alias of aio: aio's — for every rule that asks.
  "src/ViaAlias.tsx": `import { useCell } from "fw";
import { counter } from "./cell.ts";
export const ViaAlias = () => <p>{useCell(counter).state.count}</p>;
`,
  "src/via-alias.ts": `import { call } from "fw";
export const viaAlias = () => call({ timeout: 5 }, () => Promise.resolve(1));
`,
  // A \`cell("name", {…})\` that is the file's own function.
  "src/sheet.ts": `type Opts = { ui: string[] };
const cell = (name: string, o: Opts) => ({ name, ...o });
export const a1 = cell("a1", { ui: ["bold"] });
`,
  // The spelling in a comment and a string is not a call.
  "src/Note.tsx": `// useCell(counter) is gone
export const Note = () => <p title="useCell(counter)">see the guide</p>;
`,
  // Text after a tag whose attribute holds a \`>\` is still text.
  "src/Arrow.tsx": `export const Arrow = (go: () => void, a: number) => (
  <div>
    <button onClick={() => go()}>useCell(counter).state.count</button>
    <p title={a > 1 ? "}" : "x"}>useCell(counter).state.count</p>
  </div>
);
`,
};

const USE = "useCell(counter).state.count";
const noImport = (src: string) =>
  src.replace(`import { useCell } from "aio";\n`, "");

/** What each file must be after `--safe-fix`: itself, except the ONE real
 *  aio call. */
const FIXED: Record<string, string> = {
  ...FILES,
  "src/own.ts": FILES["src/own.ts"]!.replace(
    "call({ timeout: 5000 }",
    "call({ timeoutMs: 5000 }",
  ),
  ...Object.fromEntries(
    ["src/via-alias.ts", "src/via-barrel.ts"].map((f) => [
      f,
      FILES[f]!.replace("call({ timeout: 5 }", "call({ timeoutMs: 5 }"),
    ]),
  ),
  "src/left-barrel.ts": `export const leftBarrel = 1;\n`,
  "src/ViaAlias.tsx": FILES["src/ViaAlias.tsx"]!
    .replace(`import { useCell } from "fw";\n`, "")
    .replace(USE, "counter.count"),
  "src/Both.tsx": FILES["src/Both.tsx"]!.replace(
    `    {useCell(counter).state.count}`,
    "    {counter.count}",
  ),
  "src/Mixed.tsx": FILES["src/Mixed.tsx"]!,
  // A closing tag written in a comment is one the element reader did not
  // account for: the file is left whole, for a person.
  "src/ClosingComment.tsx": FILES["src/ClosingComment.tsx"]!,
  ...Object.fromEntries(
    [
      "src/View.tsx",
      "src/View2.tsx",
      "src/CommentTag.tsx",
      "src/CommentTagOnly.tsx",
      "src/StringTag.tsx",
      "src/Compare.tsx",
      "src/tpl.ts",
    ].map((f) => [f, noImport(FILES[f]!).replaceAll(USE, "counter.count")]),
  ),
};

Deno.test("aiol --safe-fix: own `call`s, action payloads and JSX text survive; twice is once; the result type-checks", async () => {
  const dir = await tempDir("aiol-own-code-");
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        title: "myapp",
        version: "0.1.0",
        compilerOptions: {
          lib: ["deno.ns", "deno.unstable", "dom", "dom.iterable"],
          jsx: "react-jsx",
          jsxImportSource: "aio",
        },
        imports: {
          "aio": `${REPO}mod.ts`,
          "aio/jsx-runtime": `${REPO}src/jsx-runtime.ts`,
          "fw": `${REPO}mod.ts`,
        },
        tasks: { dev: "deno run -A src/app.ts", test: "deno test -A tests/" },
      }),
    );
    await Deno.mkdir(join(dir, "vendor"));
    for (const [rel, src] of Object.entries(FILES)) {
      await Deno.writeTextFile(join(dir, rel), src);
    }
    const read = async () =>
      Object.fromEntries(
        await Promise.all(
          Object.keys(FILES).map(async (rel) =>
            [rel, await Deno.readTextFile(join(dir, rel))] as const
          ),
        ),
      );
    const fixAll = async () => {
      const report = await lintProject(dir);
      for (const i of report.issues) if (i.safeFix) await i.safeFix(dir);
      return report;
    };

    const first = await fixAll();
    // Reported: the one real call. Not reported: anything else here.
    const named = (needle: string) =>
      first.issues.filter((i) => i.message.includes(needle)).map((i) => i.file);
    // …and the call that may be the file's own: named, never fixed.
    const labelled = (needle: string) =>
      first.issues.filter((i) => i.message.includes(needle))
        .map((i) => [i.file, i.severity, !!i.safeFix, !!i.manual].join(" "))
        .sort();
    assertEquals(labelled("call({ timeout })"), [
      "src/own.ts error true false",
      "src/shadow.ts hint false true",
      "src/via-alias.ts error true false",
      // the app's barrel over aio, which the run holds: proven, fixed
      "src/via-barrel.ts error true false",
      // a module the run does not hold: a look, no rewrite
      "src/via-outside.ts hint false true",
    ]);
    // `call`, `schedule`, `useCell` from a module of the run that declares
    // them itself (`rpc.ts`, `hooks.ts`): proven the app's own — nothing said.
    assertEquals(labelled("schedule.poll({ backoff })"), []);
    assertEquals(labelled("schedule.blocking"), []);
    // The barrel that hands the old name out BY NAME, and its user: left to
    // a person, together — a rename of one without the other would not build.
    assertEquals(labelled("ExtractState"), [
      // …and the word that is also the file's own property: left whole.
      "src/keyed.ts error false true",
      "src/named.ts error false true",
      "src/via-named.ts hint false true",
    ]);
    assertEquals(
      first.issues.filter((i) => i.file === "src/ns-effects.ts" && i.manual)
        .map((i) => [i.severity, i.line, i.manual]),
      [7, 11].map((line) => [
        "error",
        line,
        "the safe fix declines: the effect is written through the " +
        "namespace `fw.` — move it into s.$do(…) by hand",
      ]),
    );
    // A method of the app's own object is not a finding of these rules.
    assertEquals(
      first.issues.filter((i) =>
        /own-members|OwnMember/.test(i.file ?? "") &&
        /REMOVED|was removed/.test(i.message)
      ),
      [],
    );
    // What is left to a person does not say "aiol --safe-fix does it".
    for (const i of first.issues.filter((i) => i.manual)) {
      assert(!/--safe-fix (does|rewrites) it/.test(i.message), i.message);
      assert(i.manual!.startsWith("the safe fix declines: "), i.manual);
    }
    for (const own of ["OwnHook", "LocalHook", "own-names", "hooks", "Arrow"]) {
      assertEquals(
        first.issues.filter((i) =>
          i.file?.includes(own) && i.severity !== "hint"
        ),
        [],
        own,
      );
    }
    // The own `cell(…)`: named, with the reason, and not renamed.
    assertEquals(
      first.issues.filter((i) => i.message.includes("cell({ ui })"))
        .map((
          i,
        ) => [i.file, !!i.safeFix, i.manual?.includes("declares a `cell`")]),
      [["src/sheet.ts", false, true]],
    );
    // The loading-state hint is about a CALL of aio's useCell — not the
    // spelling shown as text or kept in a comment, not the app's own hook.
    assertEquals(named("without loading/fallback state").sort(), [
      "src/Both.tsx",
      "src/ClosingComment.tsx",
      "src/CommentTag.tsx",
      "src/CommentTagOnly.tsx",
      "src/Compare.tsx",
      "src/Mixed.tsx",
      "src/StringTag.tsx",
      "src/ViaAlias.tsx",
      "src/View.tsx",
      "src/View2.tsx",
    ]);
    assertEquals(labelled("useCell() was REMOVED"), [
      "src/Both.tsx error true false",
      "src/ClosingComment.tsx error false true",
      "src/CommentTag.tsx error true false",
      "src/CommentTagOnly.tsx error true false",
      "src/Compare.tsx error true false",
      "src/Mixed.tsx error false true",
      "src/StringTag.tsx error true false",
      // a local taken from an aio namespace: a look
      "src/Taken.tsx hint false true",
      "src/ViaAlias.tsx error true false",
      "src/View.tsx error true false",
      "src/View2.tsx error true false",
      "src/tpl.ts error true false",
    ]);
    assertEquals(await read(), FIXED);

    const second = await fixAll();
    assertEquals(await read(), FIXED, "a second --safe-fix changed something");
    // The uses the fix left behind are the ones it declined, still said.
    assertEquals(
      second.issues.filter((i) =>
        i.message.includes("useCell() was REMOVED") && i.severity === "error"
      ).map((i) => `${i.file} ${!!i.safeFix} ${!!i.manual}`).sort(),
      ["src/ClosingComment.tsx false true", "src/Mixed.tsx false true"],
    );

    const check = await new Deno.Command(Deno.execPath(), {
      // Every file a fix could have touched; the entry is only there to be
      // linted as an app.
      args: ["check", ...Object.keys(FILES).filter((f) => f !== "src/app.ts")],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    // One error, and it was there before the fix: Mixed.tsx, left whole,
    // imports something aio does not export. Nothing a fix touched
    // lost a name it uses (TS2304) or an option its callee takes (TS2561).
    const stderr = new TextDecoder().decode(check.stderr)
      .replace(/\x1b\[[0-9;]*m/g, "");
    // Of the project's own files: aio's sources are read through the import
    // map, and what the compiler says about THEM is not this test's subject.
    const own = `${toFileUrl(await Deno.realPath(dir)).href}/`;
    assertEquals(
      [...stderr.matchAll(
        /^(TS\d+) [^\n]*\n(?:[^\n]*\n)*?\s+at (file:\/\/\S+?):\d+:\d+$/gm,
      )]
        .filter((m) => m[2]!.startsWith(own))
        .map((m) => `${m[1]} ${m[2]!.slice(own.length)}`),
      // …and the word `keyed.ts` and `named.ts` kept, which aio no longer
      // exports.
      [
        "TS2305 src/Both.tsx",
        "TS2305 src/ClosingComment.tsx",
        "TS2305 src/Mixed.tsx",
        "TS2305 src/keyed.ts",
        "TS2305 src/named.ts",
      ],
      stderr,
    );
  } finally {
    await dropTempDir(dir);
  }
});
