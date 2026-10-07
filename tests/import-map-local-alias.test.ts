// Local import-map aliases in UI code, dev == build.
//
// `"fmt": "./lib/fmt.ts"` in deno.json bundles fine (esbuild `alias`), but
// the dev graph check resolved the value against the IMPORTER's folder — or,
// for a map without it, told the author to add `"fmt": "npm:fmt"` for an
// alias already mapped — and the dev server served `import "fmt"` as written,
// which no browser import map resolves. A PREFIX key (`"@/": "./src/"`)
// crashed the build with esbuild's raw "Invalid alias name" and got the same
// wrong `npm:` advice in dev. Now: an exact alias works in dev as in the
// build, and a prefix alias gets ONE aio sentence from both.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join, resolve, toFileUrl } from "@std/path";
import * as esbuild from "esbuild";
import { bundleClient, judgeClientBundle } from "../src/build/client-bundle.ts";
import { stopEsbuildService } from "../src/build/esbuild-shared.ts";
import {
  BLOCKING_CATEGORIES,
  type ErrorCategory,
  validateGraph,
} from "../src/server/graph-validator.ts";
import {
  buildBrowserImportMap,
  devLocalAliases,
  graphImportMap,
  isBrowserEntry,
  prefixAliasMessage,
  readAppDenoImports,
  readAppLocalAliases,
} from "../src/server/server-html-importmap.ts";
import { _rewriteAliasImports } from "../src/server/server-static.ts";
import { dynamicImportsOutsideMethods } from "../src/server/server-only-specs.ts";
import { lint } from "../src/server/aio.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  _resetVendorCache,
  loadVendorImmer,
} from "../src/server/server-vendor.ts";
import { freePort } from "../src/testing/server-test.ts";
import { createServer } from "../src/server/server.ts";
import { stopEsbuild } from "../src/server/server-transpile.ts";
import { scaffold, writeScaffold } from "../src/am/am-cmd-create.ts";
import { setLogger } from "../src/diagnostics/logger-api.ts";
import { fixtureNodeModules } from "./symlink-helper.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";

const REPO = fromFileUrl(new URL("../", import.meta.url));
const passThrough = (s: string) => Promise.resolve(s);

/** A project: deno.json at the root, the UI in `src/`, `lib/fmt.ts`. */
async function project(app: string): Promise<string> {
  const root = await tempDir("aio-local-alias-");
  await Deno.mkdir(join(root, "src"));
  await Deno.mkdir(join(root, "lib"));
  await Deno.writeTextFile(
    join(root, "deno.json"),
    JSON.stringify({ imports: { "fmt": "./lib/fmt.ts", "#lib/": "./lib/" } }),
  );
  await Deno.writeTextFile(
    join(root, "lib", "fmt.ts"),
    `export const label = (n: number) => "n=" + n;`,
  );
  await Deno.writeTextFile(join(root, "src", "App.tsx"), app);
  // The framework's `immer`, for the tests that bundle: the project's own
  // node_modules, as in a real app (the checkout root has none).
  await fixtureNodeModules(root, "npm:immer@10.2.0");
  return root;
}

const graphMap = (src: string) =>
  graphImportMap(src, buildBrowserImportMap(readAppDenoImports(src) ?? {}));

Deno.test("local alias: an exact alias resolves against the deno.json folder in the dev graph", async () => {
  const root = await project(
    `import { label } from "fmt";\nexport default () => label(1);`,
  );
  try {
    const src = join(root, "src");
    assertEquals(
      readAppLocalAliases(src).fmt,
      toFileUrl(join(root, "lib", "fmt.ts")).href,
    );
    const g = await validateGraph(
      join(src, "App.tsx"),
      graphMap(src),
      passThrough,
    );
    assertEquals(g.errors, []);
    assert(g.modules.has(join(root, "lib", "fmt.ts")), "walked into the alias");
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("local alias: the dev server rewrites an exact alias to its file's url", () => {
  // The host's absolute path: on Windows a `file:` url holds a drive letter.
  const file = resolve("/p/lib/fmt.ts");
  const aliases = { fmt: toFileUrl(file).href, "#lib/": "./lib/" };
  const seen: string[] = [];
  const out = _rewriteAliasImports(
    `import { a } from "fmt";\nimport "fmtx";\nconst m = import("fmt");\n` +
      `import { b } from "#lib/x.ts";\nimport c from "./fmt";`,
    aliases,
    (file) => (seen.push(file), "/__aio-src/lib/fmt.ts"),
  );
  assertEquals(
    out,
    `import { a } from "/__aio-src/lib/fmt.ts";\nimport "fmtx";\n` +
      `const m = import("/__aio-src/lib/fmt.ts");\n` +
      `import { b } from "#lib/x.ts";\nimport c from "./fmt";`,
  );
  assertEquals(seen, [file, file]);
});

Deno.test("local alias: the startup lint does not call a mapped alias unresolvable", async () => {
  const root = await project(
    `import { label } from "fmt";\nexport default () => label(1);`,
  );
  try {
    const r = await lint(
      {},
      { reduce: () => {}, execute: () => {} },
      join(root, "src"),
    );
    assertEquals(r.warn.filter((w) => w.includes(`"fmt"`)), []);
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("local alias: a prefix alias gets the SAME aio sentence in dev and build", async () => {
  const root = await project(
    `import { label } from "#lib/fmt.ts";\nexport default () => label(1);`,
  );
  const said = prefixAliasMessage("#lib/fmt.ts", "#lib/", "./lib/");
  try {
    const src = join(root, "src");
    // dev: the graph check
    const g = await validateGraph(
      join(src, "App.tsx"),
      graphMap(src),
      passThrough,
    );
    assertEquals(g.errors.map((e) => e.message), [said]);
    assert(!g.errors[0]!.fix?.includes("npm:"), "no npm: advice");
    // dev: the startup lint
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, src);
    assert(r.warn.some((w) => w.includes(said)), r.warn.join("\n"));
    assert(!r.warn.some((w) => w.includes("npm:#lib")), r.warn.join("\n"));
    // build: the bundle
    const b = await bundleClient({
      esbuild,
      root,
      appDir: src,
      uiEntry: "App.tsx",
      standalone: false,
      imports: JSON.parse(await Deno.readTextFile(join(root, "deno.json")))
        .imports,
      shares: [],
      frameworkSrcDir: join(REPO, "src"),
    });
    assert(!b.ok);
    const text = b.errors.join("\n");
    assertStringIncludes(text, said);
    assert(!text.includes("Invalid alias name"), text);
  } finally {
    await dropTempDir(root);
    await stopEsbuildService(() => esbuild.stop());
  }
});

Deno.test("local alias: an exact alias still bundles next to a prefix key", async () => {
  const root = await project(
    `import { label } from "fmt";\nexport default () => label(1);`,
  );
  try {
    const b = await bundleClient({
      esbuild,
      root,
      appDir: join(root, "src"),
      uiEntry: "App.tsx",
      standalone: false,
      imports: JSON.parse(await Deno.readTextFile(join(root, "deno.json")))
        .imports,
      shares: [],
      frameworkSrcDir: join(REPO, "src"),
    });
    assert(b.ok, b.errors.join("\n"));
    assertStringIncludes(b.code, "n=");
  } finally {
    await dropTempDir(root);
    await stopEsbuildService(() => esbuild.stop());
  }
});

Deno.test("local alias: a framework entry wins over the app's local prefix key in the bundle", async () => {
  const root = await project(
    `import { Show } from "aio/air";\nexport default () => String(Show);`,
  );
  try {
    const b = await bundleClient({
      esbuild,
      root,
      appDir: join(root, "src"),
      uiEntry: "App.tsx",
      standalone: false,
      imports: { "aio/": "./dep/aio/src/" },
      shares: [],
      frameworkSrcDir: join(REPO, "src"),
    });
    assert(b.ok, b.errors.join("\n"));
  } finally {
    await dropTempDir(root);
    await stopEsbuildService(() => esbuild.stop());
  }
});

/** Serve `/App.tsx` + `/cell.ts` from a dev server on `baseDir`; the bodies and every
 *  warning the server logged while serving it. */
async function devServeApp(
  baseDir: string,
): Promise<{ status: number; body: string; warns: string[] }> {
  const warns: string[] = [];
  setLogger({
    pub: (lvl: string, _cat: string, msg: string) => {
      if (lvl === "warn") warns.push(msg);
    },
  } as unknown as LogSink);
  const port = freePort();
  const server = createServer(
    {
      port,
      title: "alias-dev",
      appId: "alias-dev",
      getUIState: () => ({}),
      dispatch: () => {},
      baseDir,
      debug: () => {},
      prod: false,
    } as unknown as Parameters<typeof createServer>[0],
  );
  try {
    let status = 200, body = "";
    for (const f of ["/App.tsx", "/cell.ts"]) {
      const res = await fetch(`http://127.0.0.1:${port}${f}`);
      status = Math.max(status, res.status);
      body += await res.text();
    }
    return { status, body, warns };
  } finally {
    await server.shutdown();
    await stopEsbuild();
    setLogger(null);
  }
}

Deno.test('local alias: an `am create` app ("aio": "./dep/aio/mod.ts") keeps its aio imports in dev', async () => {
  const dir = await tempDir("aio-local-alias-create-");
  try {
    await writeScaffold(dir, scaffold("alias-dev", "counter", true), {
      aioPath: REPO,
    });
    // The scaffold maps every aio entry to ./dep/aio/… — the browser map's
    // `aio` must win in the dev rewrite, as it does in the graph and bundle.
    assertEquals(readAppDenoImports(join(dir, "src"))?.aio, "./dep/aio/mod.ts");
    const r = await devServeApp(join(dir, "src"));
    assertEquals(r.status, 200);
    assert(!r.body.includes("dep/aio"), r.body);
    assert(!r.body.includes("/__aio-src/"), r.body);
    assert(/from\s*"aio"/.test(r.body), r.body);
    assert(/from\s*"aio\/jsx-runtime"/.test(r.body), r.body);
    assertEquals(r.warns.filter((w) => w.includes("outside this project")), []);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("local alias: the repo's examples serve with no false 'outside this project' warning", async () => {
  const r = await devServeApp(join(REPO, "examples", "counter", "src"));
  assertEquals(r.status, 200);
  assert(/from\s*"aio"/.test(r.body), r.body);
  assertEquals(r.warns.filter((w) => w.includes("outside this project")), []);
});

// Dev and the build must give ONE verdict for every aio entry UI code
// imports. Dev's rewrite took any aio entry the browser map lacked
// (`"aio/sync": "./dep/aio/src/sync/mod.ts"` in an `am create` app) and sent
// the page to `/__aio-src/dep/aio/…`, a silent 403 and a blank page, while the
// bundle took the same import (tree-shaken to what happened to load). Now an
// entry loads in both exactly when the browser map serves it, and is refused
// loudly in both otherwise. A DYNAMIC import of any entry is the server-side
// escape hatch and passes in both; dev once blocked it as "not in the import
// map" while the build took it.
Deno.test("local alias: dev and build give every published aio entry the same verdict", async () => {
  const deno = JSON.parse(Deno.readTextFileSync(join(REPO, "deno.json"))) as {
    exports: Record<string, string>;
  };
  const dir = await tempDir("aio-local-alias-verdict-");
  try {
    await writeScaffold(dir, scaffold("alias-verdict", "counter", true), {
      aioPath: REPO,
    });
    await fixtureNodeModules(dir, "npm:immer@10.2.0");
    const src = join(dir, "src");
    const imports = readAppDenoImports(src) ?? {};
    const verdicts = async (code: string) => {
      await Deno.writeTextFile(join(src, "App.tsx"), code);
      const map = buildBrowserImportMap(imports);
      const g = await validateGraph(
        join(src, "App.tsx"),
        graphImportMap(src, map),
        passThrough,
      );
      const b = await bundleClient({
        esbuild,
        root: dir,
        appDir: src,
        uiEntry: "App.tsx",
        standalone: false,
        imports,
        shares: [],
        frameworkSrcDir: join(REPO, "src"),
      });
      const built = b.ok && (await judgeClientBundle(b, dir)).ok;
      return { g, built, warned: b.warnings ?? [] };
    };
    const blocks = (
      g: { errors: { category: string; deferred?: boolean }[] },
    ) =>
      g.errors.some((e) =>
        !e.deferred && BLOCKING_CATEGORIES.has(e.category as ErrorCategory)
      );
    const devWarns = (
      g: { errors: { message: string }[] },
      spec: string,
    ) => g.errors.some((e) => e.message.includes(`import("${spec}")\` sits`));
    const disagree: string[] = [];
    const keys = Object.keys(deno.exports);
    assert(keys.length > 20, "deno.json exports read");
    for (const key of keys) {
      const spec = key === "." ? "aio" : "aio" + key.slice(1);
      // Never rewritten to a dev url — the framework owns every entry.
      assertEquals(
        devLocalAliases(src, buildBrowserImportMap(imports))[spec],
        undefined,
        spec,
      );
      const { g, built } = await verdicts(
        `import * as m from "${spec}";\n` +
          `export default () => String(Object.keys(m).length);\n`,
      );
      const dev = !g.errors.some((e) => !e.deferred);
      if (dev !== built || dev !== isBrowserEntry(spec)) {
        disagree.push(`${spec}: dev ${dev}, build ${built}`);
      }
      // A DYNAMIC import is accepted by both, for every entry — silently
      // inside a cell method (it runs on the server); anywhere else, an entry
      // a page cannot load is WARNED by both (the page would run it and die
      // right then, "Failed to resolve module specifier").
      // `client`: a `scope: "client"` cell's methods run in the tab (sync
      // only, so the import is fire-and-forget there).
      for (const where of ["method", "UI", "client"]) {
        const inMethod = where === "method";
        const load = `async () => (await import("${spec}")).default`;
        const d = await verdicts(
          (where !== "UI"
            ? `import { cell } from "aio";\n` +
              `export const c = cell("dyn", { ${
                inMethod ? "" : `scope: "client", `
              }state: {}, methods: {\n` +
              `  load: ${inMethod ? load : `() => void import("${spec}")`},\n` +
              `} });\n`
            : `export const load = ${load};\n`) +
            `export default () => <button onClick={${
              where === "UI" ? load : "() => {}"
            }}>x</button>;\n`,
        );
        const want = !inMethod && !isBrowserEntry(spec);
        const dDev = !blocks(d.g), dWarn = devWarns(d.g, spec);
        const bWarn = d.warned.some((w) =>
          w.includes(`import("${spec}")\` sits`)
        );
        if (!dDev || !d.built || dWarn !== want || bWarn !== want) {
          disagree.push(
            `dynamic ${spec} (${where}): dev ${dDev} ` +
              `warn ${dWarn}, build ${d.built} warn ${bWarn}, want warn ${want}`,
          );
        }
      }
    }
    assertEquals(disagree, []);
    // A TYPE import of a server entry is erased — fine in both.
    const t = await verdicts(
      `import type { DB } from "aio/db";\n` +
        `type S = typeof import("aio/server");\n` +
        `export default (d?: DB, e?: import("aio/db").DB, s?: S) =>\n` +
        `  String(d ?? e ?? s);\n`,
    );
    assertEquals([t.g.errors.filter((e) => !e.deferred), t.built, t.warned], [
      [],
      true,
      [],
    ]);
  } finally {
    await dropTempDir(dir);
    await stopEsbuildService(() => esbuild.stop());
  }
});

// The decider both halves use: a method body (nested braces and all) is
// silent, and so is a module-level helper; a JSX handler warns; a TYPE position
// and an acknowledged line do not.
Deno.test("local alias: a server-entry import() warns only in a JSX handler", () => {
  const src = [
    `type S = typeof import("aio/server");`,
    `let e: import("aio/db").DB | undefined;`,
    `const c = cell("a", { state: {}, methods: {`,
    `  async f() { const m = await import("aio/db"); if (m) { return "}"; } },`,
    `  g: async () => (await import("aio/extras")).x,`,
    `} });`,
    `export const h = () => import("aio/extras").then((m) => m);`,
    `// aio-ok: server-only — only methods call it`,
    `const q = () => import("aio/db");`,
    `const v = <b onClick={async () => (await import("aio/sync")).x()} />;`,
    `const ok = () => import("aio/ui");`,
  ].join("\n");
  assertEquals(
    dynamicImportsOutsideMethods(src, (s) => s !== "aio/ui"),
    [{ spec: "aio/sync", line: 10 }],
  );
});

// Every one of these is correct server-side code; each warned on every dev
// launch because the decider knew only a literal `methods: {` body (and a
// nested template's `}` desynced it). The warning is now for code that is
// browser code BY SYNTAX: a JSX event handler, a `scope: "client"` cell.
Deno.test("local alias: a server-entry import() in server code never warns; a client cell's does", () => {
  const warns = (src: string) =>
    dynamicImportsOutsideMethods(src, (s) => s !== "aio/ui");
  for (
    const src of [
      `const methods = { async a(s) { await import("aio/server"); } };\n` +
      `export const c = cell({ state: {}, methods });`,
      `cell({ state: {}, "methods": { async a() { await import("aio/server"); } } });`,
      `cell({ state: {}, methods: ({ async a() { await import("aio/server"); } }) });`,
      `cell({ state: {}, methods: {},\n` +
      `  async onInit() { await import("aio/server"); },\n` +
      `  onDestroy: async () => { await import("aio/db"); } });`,
      "cell({ state: {}, methods: {\n" +
      "  a(s) { s.x = `${s.o ? `}` : ''}`; },\n" +
      `  async b() { await import("aio/server"); },\n} });`,
      `let _db = null;\nasync function db() {\n` +
      `  if (!_db) { const { createDB } = await import("aio/server"); ` +
      `_db = createDB("x"); }\n  return _db;\n}`,
      `const onSave = { run: () => import("aio/server") };`,
      `cell("a", { state: { scope: "client" }, methods: {\n` +
      `  async a() { await import("aio/server"); } } });`,
    ]
  ) assertEquals(warns(src), [], src);
  assertEquals(
    warns(
      `export const c = cell("t", { scope: "client", state: {}, methods: {\n` +
        `  async a() { await import("aio/server"); },\n} });`,
    ),
    [{ spec: "aio/server", line: 2 }],
  );
});

// The most common browser shape is a NAMED handler (`onClick={save}`), and a
// typed cell's generic (`cell<{ f: () => void }>`) holds parens: both were
// silent. The name resolves to its declaration in the same file — only that
// declaration's own statement counts, never the code after it.
Deno.test("local alias: a named JSX handler and a typed client cell warn too", () => {
  const warns = (src: string) =>
    dynamicImportsOutsideMethods(src, (s) => s !== "aio/ui");
  assertEquals(
    warns(
      `const save = async () => (await import("aio/extras")).x();\n` +
        `export default () => <button onClick={save}>x</button>;`,
    ),
    [{ spec: "aio/extras", line: 1 }],
  );
  assertEquals(
    warns(
      `export default function App() {\n` +
        `  async function load() {\n    await import("aio/db");\n  }\n` +
        `  const go = async () =>\n    (await import("aio/sync")).x();\n` +
        `  return <b onClick={ load } onInput={go} />;\n}`,
    ),
    [{ spec: "aio/db", line: 3 }, { spec: "aio/sync", line: 6 }],
  );
  assertEquals(
    warns(
      `export const c = cell<{ f: () => void }>("t", { scope: "client",\n` +
        `  state: {}, methods: { async a() { await import("aio/server"); } } });`,
    ),
    [{ spec: "aio/server", line: 2 }],
  );
  // A named handler CALLED from an inline one runs in the page just the same.
  for (
    const h of [`() => save()`, `() => { save(); }`, `() => void save(1)`]
  ) {
    assertEquals(
      warns(
        `const save = async () => (await import("aio/extras")).x();\n` +
          `export default () => <b onClick={${h}} />;`,
      ),
      [{ spec: "aio/extras", line: 1 }],
      h,
    );
  }
  // Server code stays silent: a handler named like a METHOD, and the code
  // after a named handler's declaration.
  for (
    const src of [
      `cell({ state: {}, methods: { async save() { await import("aio/db"); } } });\n` +
      `export default () => <b onClick={save} />;`,
      `const save = () => send("save");\n` +
      `const db = async () => (await import("aio/server")).createDB("x");\n` +
      `export default () => <b onClick={save} />;`,
      // A member call or an imported function is not a local handler.
      `import { save } from "./api.ts";\n` +
      `const log = { x: async () => (await import("aio/db")).y() };\n` +
      `export default () => <b onClick={() => { console.log(); save(); ` +
      `log.x(); }} />;`,
      `const save = () => send("save") // no semicolons here /\n` +
      `const db = async () => (await import("aio/server")).createDB("x")\n` +
      `export default () => <b onClick={save} />`,
      `cell<{ f: () => void }>("t", { state: { scope: "client" }, methods: {\n` +
      `  async a() { await import("aio/server"); } } });`,
    ]
  ) assertEquals(warns(src), [], src);
});

// A called name resolves to the ONE binding the handler sees — the innermost
// visible declaration — not every same-named one in the file: a `save`
// helper local to a server method is another function. A function's body is
// past its return type, and a body-less signature has none.
Deno.test("local alias: a named handler resolves to its own binding and body only", () => {
  const warns = (src: string) =>
    dynamicImportsOutsideMethods(src, (s) => s !== "aio/ui");
  const method = `export const app = cell({ state: {}, methods: {\n` +
    `  async backup() {\n` +
    `    const save = async () => { await import("aio/db"); };\n` +
    `    await save();\n  } } });\n`;
  for (
    const src of [
      method + `export function App() {\n  const save = () => app.backup();\n` +
      `  return <b onClick={() => save()} />;\n}`,
      method + `const save = () => app.backup();\n` +
      `export const App = () => <b onClick={save} />;`,
      `declare function f<T>(): T extends 1 ? { a: 1 } : keyof { b: 1 };\n` +
      `const g = async () => { await import("aio/db"); };\n` +
      `export const App = () => <b onClick={f} />;`,
      `declare function f(): void;\n` +
      `const g = async () => { await import("aio/db"); };\n` +
      `export const App = () => <b onClick={f} />;`,
    ]
  ) assertEquals(warns(src), [], src);
  // The visible binding still warns: shadowing a module-level one, and a
  // body past an object-literal / arrow return type.
  assertEquals(
    warns(
      `const save = () => 1;\nexport function App() {\n` +
        `  const save = async () => { await import("aio/db"); };\n` +
        `  return <b onClick={save} />;\n}`,
    ),
    [{ spec: "aio/db", line: 3 }],
  );
  assertEquals(
    warns(
      `export function App() {\n  function save(): void;\n` +
        `  function save(x?: number) { import("aio/db"); }\n` +
        `  return <b onClick={save} />;\n}`,
    ),
    [{ spec: "aio/db", line: 3 }],
  );
  for (
    const ret of [
      `{ a: 1 }`,
      `Promise<{ a: () => { b: 1 } }>`,
      `() => { a: 1 }`,
      `keyof { a: 1 }`,
      `readonly { a: 1 }[]`,
      `T extends string ? { a: 1 } : { b: 2 }`,
      `x is { a: 1 }`,
      `asserts x is { a: 1 }`,
      `T extends { a: infer U extends { b: 1 } } ? U : never`,
      `{ [K in keyof T]: T[K] } | { c: 1 }`,
      `"lit"`,
      `NS.is`,
      `new () => { a: 1 }`,
    ]
  ) {
    assertEquals(
      warns(
        `async function f<T>(x: T): ${ret} {\n  await import("aio/db");\n}\n` +
          `export const App = () => <b onClick={f} />;`,
      ),
      [{ spec: "aio/db", line: 2 }],
      ret,
    );
  }
});

// Every dev reload runs this: names resolve once each, in one declaration
// scan — one full-source regex per handler per name was quadratic.
Deno.test("local alias: the named-handler scan stays linear on a big component", () => {
  let src = "";
  for (let i = 0; i < 300; i++) {
    src += `const set${i} = (v) => app.set${i}(v);\n`;
  }
  src += "export const App = () => <div>\n";
  for (let i = 0; i < 3000; i++) {
    src += `  <b onClick={() => set${i % 300}(t(${i}))} ` +
      `onInput={(e) => set${(i + 1) % 300}(f(e))}>b</b>\n`;
  }
  src += "</div>;\n";
  const t0 = performance.now();
  assertEquals(dynamicImportsOutsideMethods(src, () => true), []);
  const ms = performance.now() - t0;
  assert(ms < 200, `6000 handlers took ${ms.toFixed(0)} ms`);
});

// An app that vendors immer (`"immer": "./vendor/immer.js"`) got the
// FRAMEWORK's immer in dev (the browser map's `immer` won the alias clash)
// and its OWN copy in the build (the bundler's alias took it) — two
// different immers for one app. The app's own copy now wins in both: the
// build aliases it for the app and the framework alike, and the dev vendor
// route serves that same file.
Deno.test("local alias: an app's own local immer is THE immer in dev and in the build", async () => {
  _resetVendorCache();
  const real = loadVendorImmer();
  assert(real, "a local immer to vendor");
  const root = await project(
    `import { produce, appImmer } from "immer";\n` +
      `export default () => appImmer + String(produce);`,
  );
  try {
    await Deno.writeTextFile(
      join(root, "deno.json"),
      JSON.stringify({ imports: { "immer": "./vendor/immer.js" } }),
    );
    await Deno.mkdir(join(root, "vendor"));
    await Deno.writeTextFile(
      join(root, "vendor", "immer.js"),
      real + `\nexport const appImmer = "APP-IMMER";\n`,
    );
    const b = await bundleClient({
      esbuild,
      root,
      appDir: join(root, "src"),
      uiEntry: "App.tsx",
      standalone: false,
      imports: { "immer": "./vendor/immer.js" },
      shares: [],
      frameworkSrcDir: join(REPO, "src"),
    });
    assert(b.ok, b.errors.join("\n"));
    assertStringIncludes(b.code, "APP-IMMER");

    const port = freePort();
    const server = createServer(
      {
        port,
        title: "immer-dev",
        appId: "immer-dev",
        getUIState: () => ({}),
        dispatch: () => {},
        baseDir: join(root, "src"),
        debug: () => {},
        prod: false,
      } as unknown as Parameters<typeof createServer>[0],
    );
    try {
      const get = async (p: string) =>
        await (await fetch(`http://127.0.0.1:${port}${p}`)).text();
      assertStringIncludes(await get("/"), `"immer":"/__aio/vendor/immer.js"`);
      assertStringIncludes(await get("/__aio/vendor/immer.js"), "APP-IMMER");
      assert(/from\s*"immer"/.test(await get("/App.tsx")));
    } finally {
      await server.shutdown();
      await stopEsbuild();
    }
  } finally {
    _resetVendorCache();
    await dropTempDir(root);
    await stopEsbuildService(() => esbuild.stop());
  }
});
