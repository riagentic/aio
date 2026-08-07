// aiol's signal, tested against aiol's own promises.
//
// A lint rule that matches NOTHING looks exactly like a clean codebase: the
// gate is green and everyone trusts it. A rule that fires on LEGAL code is
// worse than no rule at all — it teaches people to skim past the real ones,
// and this linter's value is entirely in the fact that its output is worth
// reading.
//
// So both halves are pinned here, mechanically:
//
//  1. POSITIVE — every `report(` call site in `aiol/checks.ts` has a fixture
//     that reaches it. The set of reached sites is collected from the stack at
//     report time and compared with the sites parsed out of the source, so a
//     rule added WITHOUT a fixture fails this file by line number. That is the
//     only way "this regex never fires" stays detectable: the rule and its
//     proof are added together or not at all.
//  2. NEGATIVE — the legal shapes each rule must stay silent about. Every case
//     here was a real false positive: a `Deno.readTextFile` named in a STRING
//     reported as server-only code (an ERROR — it fails the gate), an import
//     statement inside a code-generator's template literal, a schedule id
//     quoted in a comment, `password:` in a doc line, and two regexes that
//     backtracked past their own negative lookahead and reported a METHOD CALL
//     as a field read — printing a TRUNCATED identifier ("counter.incremen")
//     while doing it.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { ALL_CHECKS } from "../aiol/checks.ts";
import type { Issue } from "../aiol/types.ts";

// ── Harness ─────────────────────────────────────────────────────────

const AIOL_CHECKS = new URL("../aiol/checks.ts", import.meta.url).pathname;

/** Every `report(` call site in checks.ts, by 1-based line. */
function reportSites(): number[] {
  const lines = Deno.readTextFileSync(AIOL_CHECKS).split("\n");
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    // `report(` as a CALL — not the destructuring, not the type, not a mention
    // inside a comment.
    if (/(?<![\w.])report\(/.test(l) && !l.trim().startsWith("*")) {
      out.push(i + 1);
    }
  }
  return out;
}

/** Line in checks.ts of the innermost frame that called report(). */
function callSite(): number | null {
  for (const l of (new Error().stack ?? "").split("\n")) {
    const m = l.match(/aiol[/\\]checks\.ts:(\d+):/);
    if (m) return Number(m[1]);
  }
  return null;
}

const reached = new Set<number>();

async function lintFixture(
  files: Record<string, string>,
): Promise<Issue[]> {
  const dir = await Deno.makeTempDir({ prefix: "aiol-signal-" });
  try {
    for (const [rel, src] of Object.entries(files)) {
      const p = join(dir, rel);
      await Deno.mkdir(p.replace(/[^/\\]+$/, ""), { recursive: true });
      // `symlink:<target>` materializes a symlink (dangling is fine) — the
      // framework-pin rule reads `dep/aio` as a link, which no text file can
      // fake.
      if (src.startsWith("symlink:")) {
        await Deno.symlink(src.slice("symlink:".length), p);
      } else await Deno.writeTextFile(p, src);
    }
    const { ctx, report } = await buildContext(dir);
    const orig = ctx.report;
    ctx.report = ((...a: Parameters<typeof orig>) => {
      const site = callSite();
      if (site !== null) reached.add(site);
      return orig(...a);
    }) as typeof orig;
    for (const check of ALL_CHECKS) await check(ctx);
    return report.issues;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// ── A correct, minimal app — the base every fixture edits ────────────

const IMPORTS = {
  "aio": "jsr:@riagentic/aio@1.0.0",
  "aio/ui": "jsr:@riagentic/aio@1.0.0/ui",
  "aio/server": "jsr:@riagentic/aio@1.0.0/server",
  "aio/testing": "jsr:@riagentic/aio@1.0.0/testing",
};
const denoJson = (patch: Record<string, unknown> = {}) => {
  const base: Record<string, unknown> = {
    title: "probe",
    version: "0.1.0",
    nodeModulesDir: "auto",
    compilerOptions: { jsx: "react-jsx", jsxImportSource: "aio" },
    imports: IMPORTS,
    tasks: {
      dev: "deno run -A src/app.ts",
      test: "deno test -A tests/",
      "compile:browser": "deno run -A build.ts",
    },
  };
  return JSON.stringify({ ...base, ...patch }, null, 2);
};

const APP = `import { aio } from "aio";
import { counter } from "./cell.ts";
await aio.run({ appId: "probe", cells: { counter } });
`;
const CELL = `import { cell } from "aio";
export const counter = cell("counter", {
  state: { count: 0 },
  methods: { increment(s: { count: number }, by = 1) { s.count += by; } },
});
`;
const APP_TSX = `import { counter } from "./cell.ts";
export default function App() {
  return <button onClick={() => counter.increment(1)}>{counter.count}</button>;
}
`;
const TEST = `import { testCell } from "aio/testing";
import { counter } from "../src/cell.ts";
Deno.test("counter", async () => {
  await testCell(counter, async (c) => { await c.increment(1); });
});
`;

const BASE: Record<string, string> = {
  "deno.json": denoJson(),
  "src/app.ts": APP,
  "src/cell.ts": CELL,
  "src/App.tsx": APP_TSX,
  "tests/cell.test.ts": TEST,
};

/** BASE with files replaced; a `null` value DELETES that file. */
const app = (patch: Record<string, string | null>): Record<string, string> => {
  const out = { ...BASE };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
};

const cellFile = (name: string, body: string) =>
  `import { cell } from "aio";\nexport const ${name} = cell("${name}", ${body});\n`;

// ── 1. POSITIVE: every rule fires on a violation of itself ───────────

type Case = { name: string; files: Record<string, string>; expect: string };

const VIOLATIONS: Case[] = [
  // config
  {
    name: "no deno.json",
    files: app({ "deno.json": null }),
    expect: "deno.json not found",
  },
  {
    name: "appId in deno.json only",
    files: app({
      "deno.json": denoJson({ appId: "probe" }),
      "src/app.ts":
        `import { aio } from "aio";\nimport { counter } from "./cell.ts";\nawait aio.run({ cells: { counter } });\n`,
    }),
    expect: "move to aio.run",
  },
  {
    name: "appId in deno.json AND aio.run()",
    files: app({ "deno.json": denoJson({ appId: "probe" }) }),
    expect: "in deno.json AND aio.run()",
  },
  {
    name: 'obsolete unstable: ["kv"]',
    files: app({ "deno.json": denoJson({ unstable: ["kv"] }) }),
    expect: '"unstable": ["kv"] is no longer needed',
  },
  {
    name: "no aio import mapping",
    files: app({ "deno.json": denoJson({ imports: {} }) }),
    expect: 'missing "aio" import mapping',
  },
  {
    name: "react-dom mapped without react",
    files: app({
      "deno.json": denoJson({
        imports: { ...IMPORTS, "react-dom": "npm:react-dom@^18" },
      }),
    }),
    expect: 'missing "react" import',
  },
  {
    name: "react mapped without @types/react",
    files: app({
      "deno.json": denoJson({
        imports: { ...IMPORTS, react: "npm:react@^18" },
      }),
    }),
    expect: 'missing "@types/react"',
  },
  {
    name: "react mapped without esbuild",
    files: app({
      "deno.json": denoJson({
        imports: { ...IMPORTS, react: "npm:react@^18" },
      }),
    }),
    expect: 'missing "esbuild" import',
  },
  {
    name: "react mapped, jsx transform not configured",
    files: app({
      "deno.json": denoJson({
        imports: { ...IMPORTS, react: "npm:react@^18" },
        compilerOptions: {},
      }),
    }),
    expect: "compilerOptions.jsx",
  },
  {
    name: "no nodeModulesDir",
    files: app({ "deno.json": denoJson({ nodeModulesDir: undefined }) }),
    expect: '"nodeModulesDir": "auto"',
  },
  {
    name: "no dev task",
    files: app({ "deno.json": denoJson({ tasks: { test: "x" } }) }),
    expect: 'no "dev" task',
  },
  {
    name: "no test task",
    files: app({ "deno.json": denoJson({ tasks: { dev: "x" } }) }),
    expect: 'no "test" task',
  },
  {
    name: "no build task",
    files: app({ "deno.json": denoJson({ tasks: { dev: "x", test: "y" } }) }),
    expect: "no build task defined",
  },
  {
    name: "deprecated deno.json target key",
    files: app({ "deno.json": denoJson({ target: "browser" }) }),
    expect: 'is now spelled "client"',
  },
  // structure
  {
    name: "no entry point",
    files: app({ "src/app.ts": null }),
    expect: "no entry point found",
  },
  {
    name: "entry named main.ts",
    files: app({ "src/app.ts": null, "src/main.ts": APP }),
    expect: 'convention is "src/app.ts"',
  },
  {
    name: "App.tsx without export default",
    files: app({ "src/App.tsx": `export function App() { return <div/>; }\n` }),
    expect: "missing `export default`",
  },
  {
    name: "no App.tsx",
    files: app({ "src/App.tsx": null }),
    expect: "no App.tsx found",
  },
  {
    // Since alpha52 a dev task that runs the app entry keeps App.tsx one
    // pass-through flag away (`deno task dev --client=browser`, CLI beats
    // config), so the "unused" hint fires only when NOTHING can mount it:
    // headless client, no UI build target, and a dev task that never runs
    // the entry.
    name: "App.tsx with no UI target",
    files: app({
      "deno.json": denoJson({
        tasks: { dev: "deno run -A scripts/serve.ts" },
      }),
      "src/app.ts":
        `import { aio } from "aio";\nimport { counter } from "./cell.ts";\nawait aio.run({ appId: "p", client: "server-only", cells: { counter } });\n`,
    }),
    expect: "no target builds a UI",
  },
  {
    name: "cell files scattered",
    files: app({
      "src/a.ts": cellFile(
        "acell",
        `{ state: { a: 0 }, methods: { go() {} } }`,
      ),
      "src/b.ts": cellFile(
        "bcell",
        `{ state: { b: 0 }, methods: { go() {} } }`,
      ),
      "src/c.ts": cellFile(
        "ccell",
        `{ state: { c: 0 }, methods: { go() {} } }`,
      ),
      "src/d.ts": cellFile(
        "dcell",
        `{ state: { d: 0 }, methods: { go() {} } }`,
      ),
    }),
    expect: "cell files scattered",
  },
  {
    name: "no tests anywhere",
    files: app({ "tests/cell.test.ts": null }),
    expect: "no tests/ directory",
  },
  {
    name: "no appId resolvable",
    files: app({
      "deno.json": denoJson({ title: undefined, name: undefined }),
      "src/app.ts":
        `import { aio } from "aio";\nimport { counter } from "./cell.ts";\nawait aio.run({ cells: { counter } });\n`,
    }),
    expect: "no appId anywhere",
  },
  {
    name: "no app version resolvable",
    files: app({
      "deno.json": denoJson({ version: undefined }),
      "src/app.ts":
        `import { aio } from "aio";\nimport { counter } from "./cell.ts";\nawait aio.run({ cells: { counter } });\n`,
    }),
    expect: "no app version anywhere",
  },
  // cells
  {
    name: "no cells at all",
    files: app({
      "src/cell.ts": null,
      "src/App.tsx": null,
      "src/app.ts":
        `import { aio } from "aio";\nawait aio.run({ appId: "p", cells: {} });\n`,
      "tests/cell.test.ts": `Deno.test("x", () => {});\n`,
    }),
    expect: "no cell() calls found",
  },
  {
    name: "removed 1.x config key",
    files: app({
      "src/cell.ts": cellFile(
        "counter",
        `{ state: { count: 0 }, machine: { initial: "idle", states: {} } }`,
      ),
    }),
    expect: "machine",
  },
  {
    name: "symbol moved off the core entry",
    files: app({
      "src/x.ts": `import { draft } from "aio";\nexport const d = draft;\n`,
    }),
    expect: "was removed (pre-methods relic",
  },
  {
    name: "duplicate cell name",
    files: app({
      "src/twin.ts": cellFile(
        "counter",
        `{ state: { count: 0 }, methods: { go() {} } }`,
      ),
    }),
    expect: "duplicate cell name",
  },
  {
    name: "cell without state",
    files: app({
      "src/cell.ts": cellFile("counter", `{ methods: { go() {} } }`),
    }),
    expect: "has no state",
  },
  {
    name: "cell with empty state literal",
    files: app({
      "src/cell.ts": cellFile("counter", `{ state: {}, methods: { go() {} } }`),
    }),
    expect: "empty state object",
  },
  {
    name: "cell with neither methods nor actions",
    files: app({
      "src/cell.ts": cellFile("counter", `{ state: { count: 0 } }`),
    }),
    expect: "no methods and no actions",
  },
  {
    name: "cell mixing methods and actions",
    files: app({
      "src/cell.ts": cellFile(
        "counter",
        `{ state: { count: 0 }, methods: { go(s: { count: number }) { s.count++; } }, actions: { Go: 1 } }`,
      ),
    }),
    expect: "both methods and actions",
  },
  {
    name: "reserved state key",
    files: app({
      "src/cell.ts": cellFile(
        "counter",
        `{ state: { $p: 1, count: 0 }, methods: { go(s: { count: number }) { s.count++; } } }`,
      ),
    }),
    expect: 'reserved key "$p"',
  },
  {
    name: "__aio_ state key",
    files: app({
      "src/cell.ts": cellFile(
        "counter",
        `{ state: { __aio_status: 1, count: 0 }, methods: { go(s: { count: number }) { s.count++; } } }`,
      ),
    }),
    expect: "reserved for aio internals",
  },
  {
    name: "method colliding with a reserved property",
    files: app({
      "src/cell.ts": cellFile(
        "counter",
        `{ state: { count: 0 }, methods: { state(s: { count: number }) { s.count++; } } }`,
      ),
    }),
    expect: "collides with reserved property",
  },
  {
    name: "cell name not lowercase",
    files: app({
      "src/cell.ts":
        `import { cell } from "aio";\nexport const counter = cell("Counter", { state: { count: 0 }, methods: { go(s: { count: number }) { s.count++; } } });\n`,
    }),
    expect: "convention is lowercase",
  },
  {
    name: "worker cell reading a peer cell",
    files: app({
      "src/heavy.ts":
        `import { cell } from "aio";\nimport { counter } from "./cell.ts";\nexport const heavy = cell("heavy", {\n  worker: true,\n  state: { n: 0 },\n  methods: { go(s: { n: number }) { s.n = counter.count; } },\n});\n`,
    }),
    expect: "has worker: true and",
  },
  // performance
  {
    name: "useAio in a non-root component",
    files: app({
      "src/W.tsx":
        `import { useAio } from "aio/air";\nexport function W() { const { state } = useAio(); return <div>{String(state)}</div>; }\n`,
    }),
    expect: "useAio()",
  },
  {
    name: "sync I/O",
    files: app({
      "src/io.ts":
        `export const read = () => Deno.readTextFileSync("/tmp/x");\n`,
    }),
    expect: "sync I/O",
  },
  {
    name: "setTimeout in cell code",
    files: app({
      "src/cell.ts": cellFile(
        "counter",
        `{ state: { count: 0 }, methods: { go(s: { count: number }) { setTimeout(() => {}, 500); s.count++; } } }`,
      ),
    }),
    expect: "setTimeout/setInterval in cell code",
  },
  {
    name: "many state keys, no ui filter",
    files: app({
      "src/cell.ts": cellFile(
        "counter",
        `{ state: { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, g: 0, h: 0, i: 0, j: 0, k: 0, l: 0 }, methods: { go(s: { a: number }) { s.a++; } } }`,
      ),
    }),
    expect: "consider cell-level ui filters",
  },
  {
    name: "console.log in app code",
    files: app({
      "src/cell.ts": cellFile(
        "counter",
        `{ state: { count: 0 }, methods: { go(s: { count: number }) { console.log(s.count); s.count++; } } }`,
      ),
    }),
    expect: "console.log call(s)",
  },
  // security
  {
    name: "hardcoded token",
    files: app({
      "src/s.ts":
        `export const cfg = { token: "abcdefghijklmnopqrstuvwxyz" };\n`,
    }),
    expect: "hardcoded token",
  },
  {
    name: "hardcoded password",
    files: app({
      "src/s.ts": `export const cfg = { password: "hunter2!" };\n`,
    }),
    expect: "hardcoded password",
  },
  {
    name: "hardcoded secret",
    files: app({
      "src/s.ts": `export const cfg = { secret: "s3cr3tvalue" };\n`,
    }),
    expect: "hardcoded secret",
  },
  {
    name: "hardcoded api key",
    files: app({
      "src/s.ts": `export const cfg = { api_key: "abcdef123456" };\n`,
    }),
    expect: "hardcoded API key",
  },
  {
    name: "--expose without auth (pre-alpha52 pin — the key-default migration)",
    files: app({
      "src/app.ts":
        `import { aio } from "aio";\nimport { counter } from "./cell.ts";\nawait aio.run({ appId: "p", expose: true, cells: { counter } });\n`,
      "deno.json": denoJson({
        imports: { ...IMPORTS, "aio": "jsr:@riagentic/aio@1.0.0-alpha51" },
      }),
    }),
    expect: "generates a persisted shared key",
  },
  {
    name: "committed .env",
    files: app({ ".env": "SECRET=1\n" }),
    expect: ".env file found",
  },
  // persistence
  {
    name: "db config without a table schema",
    files: app({
      "src/app.ts":
        `import { aio } from "aio";\nimport { counter } from "./cell.ts";\nawait aio.run({ appId: "p", db: {}, cells: { counter } });\n`,
      "src/cell.ts": cellFile(
        "counter",
        `{ state: { count: 0 }, methods: { go(s: { count: number }) { s.count++; } } }`,
      ),
    }),
    expect: "no table() schema definition",
  },
  {
    name: "persist: false",
    files: app({
      "src/app.ts":
        `import { aio } from "aio";\nimport { counter } from "./cell.ts";\nawait aio.run({ appId: "p", persist: false, cells: { counter } });\n`,
    }),
    expect: "persist: false",
  },
  {
    name: "version + migrations",
    files: app({
      "src/app.ts":
        `import { aio } from "aio";\nimport { counter } from "./cell.ts";\nawait aio.run({ appId: "p", version: 2, migrations: [], cells: { counter } });\n`,
    }),
    expect: "version + migrations removed",
  },
  {
    name: "direct Deno.Kv",
    files: app({ "src/kv.ts": `export const open = () => Deno.openKv();\n` }),
    expect: "direct Deno.Kv usage",
  },
  // ui / browser boundary
  {
    name: "bare specifier not in the import map",
    files: app({
      "src/App.tsx":
        `import { z } from "zod";\nexport default function App() { return <div>{String(z)}</div>; }\n`,
    }),
    expect: "not found in deno.json imports",
  },
  {
    name: "side-effect import not in the import map",
    files: app({
      "src/App.tsx":
        `import "some-polyfill";\nexport default function App() { return <div/>; }\n`,
    }),
    expect: "side-effect import",
  },
  {
    name: "createRoot in App.tsx",
    files: app({
      "src/App.tsx":
        `import { createRoot } from "react-dom/client";\nexport default function App() { return <div>{String(createRoot)}</div>; }\n`,
    }),
    expect: "uses createRoot",
  },
  {
    name: "React imported in App.tsx",
    files: app({
      "src/App.tsx":
        `import React from "react";\nexport default function App() { return <React.Fragment/>; }\n`,
    }),
    expect: "imports React",
  },
  {
    name: "@std import in a cell file",
    files: app({
      "src/cell.ts":
        `import { cell } from "aio";\nimport { join } from "@std/path";\nexport const counter = cell("counter", { state: { count: 0 }, methods: { go(s: { count: number }) { s.count++; void join; } } });\n`,
    }),
    expect: "is server-only but this file contains a cell()",
  },
  {
    name: "server-only aio symbol in a cell file",
    files: app({
      "src/cell.ts":
        `import { cell, createDB } from "aio";\nexport const counter = cell("counter", { state: { count: 0 }, methods: { go(s: { count: number }) { s.count++; void createDB; } } });\n`,
    }),
    expect: "is server-only (SQLite/Worker)",
  },
  {
    name: "Deno.* in a cell file",
    files: app({
      "src/cell.ts": cellFile(
        "counter",
        `{ state: { count: 0 }, methods: { go(s: { count: number }) { s.count = Deno.pid; } } }`,
      ),
    }),
    expect: "Deno.pid is server-only",
  },
  {
    name: "transitive server-only import from App.tsx",
    files: app({
      "src/App.tsx":
        `import { label } from "./mid.ts";\nexport default function App() { return <div>{label()}</div>; }\n`,
      "src/mid.ts":
        `import { deep } from "./deep.ts";\nexport const label = () => deep();\n`,
      "src/deep.ts":
        `import { join } from "@std/path";\nexport const deep = () => join("a", "b");\n`,
    }),
    expect: "transitive server-only import",
  },
  {
    name: "static dynamic import of a server-only module",
    files: app({
      "src/App.tsx":
        `const load = () => import("./helpers.ts");\nexport default function App() { return <div onClick={load}>x</div>; }\n`,
      "src/helpers.ts":
        `import { join } from "@std/path";\nexport const p = () => join("a", "b");\n`,
    }),
    expect: "will be resolved by esbuild into browser bundle",
  },
  {
    name: "useCell without a loading state",
    files: app({
      "src/W.tsx":
        `import { useCell } from "aio/air";\nimport { counter } from "./cell.ts";\nexport function W() { const c = useCell(counter); return <div>{c.count}</div>; }\n`,
    }),
    expect: "without loading/fallback state",
  },
  {
    name: "useCell at all",
    files: app({
      "src/W.tsx":
        `import { useCell } from "aio/air";\nimport { counter } from "./cell.ts";\nexport function W() { const c = useCell(counter); return <div>Loading{c.count}</div>; }\n`,
    }),
    expect: "useCell() was REMOVED",
  },
  // testing
  {
    name: "cell without a test",
    files: app({ "tests/cell.test.ts": `Deno.test("nothing", () => {});\n` }),
    expect: "has no test file",
  },
  {
    name: "tests that never use testCell",
    files: app({
      "tests/cell.test.ts":
        `import { counter } from "../src/cell.ts";\nDeno.test("counter", () => { void counter; });\n`,
    }),
    expect: "none use testCell()",
  },
  {
    name: "no test task (testing)",
    files: app({
      "deno.json": denoJson({
        tasks: { dev: "x", "compile:browser": "y" },
      }),
    }),
    expect: 'no "test" task in deno.json',
  },
  // patterns
  {
    name: "more than three 'any'",
    files: app({
      "src/a.ts":
        `export const a: any = 1;\nexport const b: any = 2;\nexport const c: any = 3;\nexport const d: any = 4;\n`,
    }),
    expect: "uses of 'any'",
  },
  {
    name: "throw in cell code",
    files: app({
      "src/cell.ts": cellFile(
        "counter",
        `{ state: { count: 0 }, methods: { go(s: { count: number }) { if (s.count) throw new Error("x"); s.count++; } } }`,
      ),
    }),
    expect: "throw in cell code",
  },
  {
    name: "state read after an await",
    files: app({
      "src/cell.ts": cellFile(
        "counter",
        `{\n  state: { count: 0, name: "" },\n  methods: {\n    async go(s: { count: number; name: string }) {\n      await Promise.resolve();\n      const n = s.name;\n      s.count = n.length;\n    },\n  },\n}`,
      ),
    }),
    expect: "after an await",
  },
  {
    name: "legacy ../dep/aio/ import path",
    files: app({
      "src/legacy.ts":
        `import { cell } from "../dep/aio/mod.ts";\nexport const c = cell;\n`,
    }),
    expect: 'legacy import path "../dep/aio/..."',
  },
  {
    name: "Node.js API",
    files: app({ "src/n.ts": `export const d = __dirname;\n` }),
    expect: "Node.js API",
  },
  {
    name: "caller reads a cell field right after awaiting its method",
    files: app({
      "src/w.ts":
        `import { counter } from "./cell.ts";\nexport async function go() {\n  await counter.increment(1);\n  const n = counter.count;\n  return n;\n}\n`,
    }),
    expect: "right after",
  },
  // build
  {
    name: "esbuild not installed",
    files: app({}),
    expect: "esbuild not installed",
  },
  {
    name: "electron package without dist/",
    files: app({
      "deno.json": denoJson({
        tasks: { dev: "x", test: "y", "compile:electron": "z" },
      }),
      "node_modules/electron/package.json": `{ "name": "electron" }`,
    }),
    expect: "node_modules/electron/dist) is missing",
  },
  {
    name: "electron not installed",
    files: app({
      "deno.json": denoJson({
        tasks: { dev: "x", test: "y", "compile:electron": "z" },
      }),
    }),
    expect: "Electron not installed",
  },
  // inter-cell / scheduling / memo
  {
    name: "cross-cell direct state access",
    files: app({
      "src/other.ts":
        `import { cell } from "aio";\nexport const other = cell("other", { state: { n: 0 }, methods: { go(s: { n: number }, state: { counter: { count: number } }) { s.n = state.counter.count; } } });\n`,
    }),
    expect: "use selectors for loose coupling",
  },
  {
    name: "schedule id with invalid chars",
    files: app({
      "src/s.ts":
        `import { schedule } from "aio";\nexport const s = () => schedule.every("my job!", () => {});\n`,
    }),
    expect: "has invalid chars",
  },
  {
    name: "memo imported from react",
    files: app({
      "src/W.tsx":
        `import { memo } from "react";\nexport const W = memo(() => <div/>);\n`,
    }),
    expect: 'import { memo } from "react"',
  },
  {
    name: "memo components rendered via .map() without useProjection",
    files: app({
      "src/W.tsx":
        `import { memo } from "aio/air";\nconst Row = memo((p: { x: number }) => <div>{p.x}</div>);\nexport const W = ({ items }: { items: number[] }) => <div>{items.map((x) => <Row x={x} />)}</div>;\n`,
    }),
    expect: "without useProjection()",
  },
  // imports
  {
    name: "aio entry imported but not mapped",
    files: app({
      "deno.json": denoJson({ imports: { aio: "jsr:@riagentic/aio@1.0.0" } }),
      "src/db.ts": `import { table } from "aio/db";\nexport const t = table;\n`,
    }),
    expect: "is imported but not mapped",
  },
  {
    name: "an aio entry point that does not exist",
    files: app({
      "src/db.ts":
        `import { table } from "aio/dbb";\nexport const t = table;\n`,
    }),
    expect: "is not an aio entry point",
  },
  {
    name: "duplicate import binding",
    files: app({
      "src/d.ts":
        `import { cell } from "aio";\nimport { cell } from "aio/state-core";\nexport const x = cell;\n`,
    }),
    expect: "is imported again",
  },
  // upgrade
  {
    name: "call({ timeout })",
    files: app({
      "src/c.ts":
        `import { call } from "aio";\nexport const f = () => call({ timeout: 5000 }, () => {});\n`,
    }),
    expect: "was REMOVED in alpha52",
  },
  {
    name: "server-only symbol imported from aio",
    files: app({
      "src/s.ts":
        `import { createDB } from "aio";\nexport const d = createDB;\n`,
    }),
    expect: "server-only symbols moved",
  },
  {
    name: "dynamic import('aio') of a server-only symbol",
    files: app({
      "src/s.ts":
        `export const open = async () => { const { createDB } = await import("aio"); return createDB; };\n`,
    }),
    expect: "resolves to undefined at RUNTIME",
  },
  {
    name: "renamed TLS flags in a task",
    files: app({
      "deno.json": denoJson({
        tasks: { dev: "deno run -A src/app.ts --cert=/x.pem", test: "y" },
      }),
    }),
    expect: "were renamed to",
  },
  {
    name: "--headless on a run task",
    files: app({
      "deno.json": denoJson({
        tasks: { dev: "deno run -A src/app.ts --headless", test: "y" },
      }),
    }),
    expect: "is a BUILD flag",
  },
  {
    // The pin is the promise (alpha42) — dep/aio pointing at a version the
    // deno.json does not declare must be reported by lint, not only doctor.
    name: "framework pin does not match dep/aio",
    files: app({
      "deno.json": denoJson({ aioVersion: "v1.0.0-alpha1" }),
      "dep/aio": "symlink:/nonexistent/aio/versions/v1.0.0-alpha2",
    }),
    expect: "does not match dep/aio",
  },
  // alpha52 — the effect channel deprecations + the transaction MIGRATION
  {
    name: "alpha52: return-ed single effect",
    files: app({
      "src/cell.ts": cellFile(
        "counter",
        `{
  state: { count: 0 },
  methods: {
    arm(s: { count: number }) {
      return schedule.after("t", 10, { type: "counter:arm" });
    },
  },
}`,
      ).replace(
        'import { cell } from "aio";',
        'import { cell, schedule } from "aio";',
      ),
    }),
    expect: "returning effects from a method is deprecated",
  },
  {
    name: "alpha52: return-ed effects ARRAY",
    files: app({
      "src/cell.ts": cellFile(
        "counter",
        `{
  state: { count: 0 },
  methods: {
    arm(s: { count: number }) {
      return [schedule.after("t", 10, { type: "counter:arm" }), own.dispose("h")];
    },
  },
}`,
      ).replace(
        'import { cell } from "aio";',
        'import { cell, own, schedule } from "aio";',
      ),
    }),
    expect: "returning an effects ARRAY is deprecated",
  },
  {
    name: "alpha52: async cell with no transaction key (MIGRATION)",
    files: app({
      "src/cell.ts": cellFile(
        "counter",
        `{
  state: { count: 0 },
  methods: {
    async load(s: { count: number }) {
      await Promise.resolve();
      s.count += 1;
    },
  },
}`,
      ),
    }),
    expect: "alpha52 made `transaction: true` the async default",
  },
  {
    name: "alpha52: listensTo array form",
    files: app({
      "src/cell.ts": cellFile(
        "counter",
        `{
  state: { count: 0 },
  listensTo: ["other:bump"],
  methods: {},
}`,
      ),
    }),
    expect: "listensTo array form is deprecated",
  },
  {
    name: "alpha52: selector deps spread signature",
    files: app({
      "src/cell.ts": cellFile(
        "counter",
        `{
  state: { count: 0 },
  methods: {},
  selectors: {
    scaled: { deps: ["other"], fn: (s, other) => s.count },
  },
}`,
      ),
    }),
    expect: "selector deps now arrive as a TUPLE",
  },
  {
    name: "alpha52: schedule old argument order (opts 3rd)",
    files: app({
      "src/cell.ts": cellFile(
        "counter",
        `{
  state: { attempt: 0 },
  methods: {
    tick(s: { attempt: number }) {
      s.$do(schedule.backoff("rpc", s.attempt, { base: 1000 }, { type: "counter:tick" }));
    },
  },
}`,
      ).replace(
        'import { cell } from "aio";',
        'import { cell, schedule } from "aio";',
      ),
    }),
    expect: "is the deprecated order",
  },
  {
    name: "alpha52: poll `backoff` option key",
    files: app({
      "src/cell.ts": cellFile(
        "counter",
        `{
  state: { attempt: 0 },
  methods: {
    tick(s: { attempt: number }) {
      s.$do(schedule.poll("rpc", s.attempt, { type: "counter:tick" }, { every: 5000, backoff: 2 }));
    },
  },
}`,
      ).replace(
        'import { cell } from "aio";',
        'import { cell, schedule } from "aio";',
      ),
    }),
    expect: "`backoff` option key",
  },
  // alpha52 — the surface diet (Package 4)
  {
    name: "cell ui: key (renamed visible:)",
    files: app({
      "src/v.ts":
        `import { cell } from "aio";\nexport const v = cell("v", {\n  state: { a: 1, b: 2 },\n  methods: {},\n  ui: { exclude: ["b"] },\n});\n`,
    }),
    expect: "was renamed `visible:`",
  },
  {
    name: "access without visible on an exposed app",
    files: app({
      "src/app.ts":
        `import { aio } from "aio";\nimport { counter } from "./cell.ts";\nawait aio.run({ appId: "p", expose: true, key: true, cells: [counter] });\n`,
      "src/gated.ts":
        `import { cell } from "aio";\nexport const gated = cell("gated", {\n  state: { rows: [] },\n  methods: {},\n  access: "admin",\n});\n`,
    }),
    expect: "REFUSES to boot",
  },
  {
    name: "aio/db VALUE import (types-only entry since alpha52)",
    files: app({
      "src/d.ts":
        `import { createDB } from "aio/db";\nexport const open = createDB;\n`,
    }),
    expect: "types + pure helpers since",
  },
  {
    name: "import from the deleted aio/schedule entry",
    files: app({
      "src/s.ts":
        `import { schedule } from "aio/schedule";\nexport const x = schedule;\n`,
    }),
    expect: "was DELETED in",
  },
];

Deno.test("aiol: every rule fires on a violation of itself", async () => {
  const dead: string[] = [];
  for (const c of VIOLATIONS) {
    const issues = await lintFixture(c.files);
    if (!issues.some((i) => i.message.includes(c.expect))) {
      dead.push(
        `${c.name}: expected a finding containing "${c.expect}", got:\n    ` +
          issues.map((i) => `${i.severity} ${i.message}`).join("\n    "),
      );
    }
  }
  assertEquals(dead, [], `\n${dead.join("\n")}`);
});

// This is the gate that makes a silently-dead rule impossible: it runs AFTER
// the fixtures above (Deno runs tests in file order) and compares the report
// sites they reached with the sites that exist in the source.
Deno.test("aiol: every report() site in checks.ts has a fixture", () => {
  const sites = reportSites();
  assert(
    sites.length > 60,
    `expected to parse the sites, found ${sites.length}`,
  );
  // V8 reports the call position; allow ±1 for the `report(` line itself.
  const unproven = sites.filter((s) =>
    !reached.has(s) && !reached.has(s - 1) && !reached.has(s + 1)
  );
  assertEquals(
    unproven,
    [],
    `aiol/checks.ts: ${unproven.length} report() site(s) no fixture reaches — ` +
      `a rule nothing can trigger is indistinguishable from a clean project. ` +
      `Add a violating fixture to VIOLATIONS above for lines: ${
        unproven.join(", ")
      }`,
  );
});

// ── 2. NEGATIVE: legal code the rules must stay silent about ─────────

type Clean = { name: string; files: Record<string, string>; forbid: string };

const LEGAL: Clean[] = [
  {
    name: "a worker cell CALLING a peer method is not a peer READ",
    forbid: "has worker: true and",
    files: app({
      "src/heavy.ts":
        `import { cell } from "aio";\nimport { counter } from "./cell.ts";\nexport const heavy = cell("heavy", {\n  worker: true,\n  state: { n: 0 },\n  methods: { go(s: { n: number }) { counter.increment(1); s.n = 1; } },\n});\n`,
    }),
  },
  {
    name: "a method CALL after an await is not a field read",
    forbid: "right after",
    files: app({
      "src/w.ts":
        `import { counter } from "./cell.ts";\nexport async function go() {\n  await counter.increment(1);\n  counter.increment(2);\n}\n`,
    }),
  },
  {
    name: "useCell named in a comment is not a use",
    forbid: "useCell() was REMOVED",
    files: app({
      "src/note.ts":
        `// migrated off useCell(counter) — direct access now\nexport const x = 1;\n`,
    }),
  },
  {
    name: "a Deno.* API named in a STRING is not a call",
    forbid: "is server-only but this file contains a cell()",
    files: app({
      "src/cell.ts": cellFile(
        "counter",
        `{ state: { count: 0, hint: "run Deno.readTextFile on the server" }, methods: { go(s: { count: number }) { s.count++; } } }`,
      ),
    }),
  },
  {
    name: "an import statement inside a template literal is not an import",
    forbid: "not found in deno.json imports",
    files: app({
      "src/cell.ts":
        `import { cell } from "aio";\nconst TPL = \`import { x } from "some-npm-pkg";\`;\nexport const counter = cell("counter", { state: { count: 0, tpl: TPL }, methods: { go(s: { count: number }) { s.count++; } } });\n`,
    }),
  },
  {
    name: "a server-only import inside a template literal is not an import",
    forbid: "is server-only but this file contains a cell()",
    files: app({
      "src/cell.ts":
        `import { cell } from "aio";\nconst TPL = \`import { join } from "@std/path";\`;\nexport const counter = cell("counter", { state: { count: 0, tpl: TPL }, methods: { go(s: { count: number }) { s.count++; } } });\n`,
    }),
  },
  {
    name: "a schedule id quoted in a comment is not a schedule",
    forbid: "has invalid chars",
    files: app({
      "src/s.ts":
        `// example: schedule.every("my job!", fn)\nexport const x = 1;\n`,
    }),
  },
  {
    name: "a password named in a comment is not a hardcoded password",
    forbid: "hardcoded password",
    files: app({
      "src/doc.ts":
        `// never write password: "hunter2" into source\nexport const x = 1;\n`,
    }),
  },
  {
    name: "'as any' inside a string is not a use of any",
    forbid: "uses of 'any'",
    files: app({
      "src/s.ts":
        `export const docs = [\n  "avoid as any",\n  "as any is lazy",\n  "no as any",\n  "as any again",\n];\n`,
    }),
  },
  {
    name: "Deno.Kv named in a comment is not Deno.Kv usage",
    forbid: "direct Deno.Kv usage",
    files: app({
      "src/note.ts":
        `// we migrated off Deno.openKv in alpha28\nexport const x = 1;\n`,
    }),
  },
  {
    name: "the word memo in a comment is not a memo component",
    forbid: "without useProjection()",
    files: app({
      "src/W.tsx":
        `// deliberately not memo-ised — the rows are cheap\nexport const W = ({ items }: { items: number[] }) => <div>{items.map((x) => <span>{x}</span>)}</div>;\n`,
    }),
  },
  {
    // `aio.run()` REFUSES to boot with no cells, so every thin client
    // (electron-remote, android-remote, …) must carry exactly this stub. A
    // warning on the one spelling the framework requires is unfixable noise.
    name: "the thin-client registration stub is not an empty cell mistake",
    forbid: "empty state object",
    files: app({
      "src/app.ts":
        `import { aio, cell } from "aio";\ncell("app", { state: {}, methods: {} });\nawait aio.run();\n`,
      "src/cell.ts": null,
      "tests/cell.test.ts": null,
    }),
  },
  {
    // `compile:cli:remote` — a client that connects to a server running
    // elsewhere. It has no aio.run() and never will.
    name: "a connectCli thin client is an entry point",
    forbid: "no entry point found",
    files: app({
      "src/app.ts": null,
      "src/App.tsx": null,
      "src/client.ts":
        `import { connectCli } from "aio/server";\nconst cli = connectCli("ws://localhost:8000/ws");\nawait cli.ready;\nconsole.log(cli.state);\n`,
    }),
  },
  {
    // Two ERRORs used to land on this one line, and the browser-boundary one
    // advised `Add "aio/db": "npm:aio/db"` — a package that does not exist.
    // Following the linter left the app exactly as broken, one specifier over.
    name: "an unmapped aio entry is reported ONCE, by the rule that knows it",
    forbid: "not found in deno.json imports",
    files: app({
      "deno.json": denoJson({ imports: { aio: "jsr:@riagentic/aio@1.0.0" } }),
      "src/cell.ts":
        `import { cell } from "aio";\nimport { table } from "aio/db";\nexport const counter = cell("counter", { state: { count: 0 }, methods: { go(s: { count: number }) { s.count++; void table; } } });\n`,
    }),
  },
  {
    name: "a *.server.ts dynamic import is the sanctioned escape hatch",
    forbid: "server-only",
    files: app({
      "src/cell.ts": cellFile(
        "counter",
        `{ state: { count: 0 }, methods: { async go(s: { count: number }) { const m = await import("./io.server.ts"); s.count += await m.read(); } } }`,
      ),
      "src/io.server.ts":
        `export const read = async () => (await Deno.readTextFile("/tmp/x")).length;\n`,
    }),
  },
];

Deno.test("aiol: legal code is not reported", async () => {
  const wrong: string[] = [];
  for (const c of LEGAL) {
    const issues = await lintFixture(c.files);
    const hits = issues.filter((i) => i.message.includes(c.forbid));
    if (hits.length) {
      wrong.push(
        `${c.name}: false positive —\n    ` +
          hits.map((i) => `${i.severity} ${i.message}`).join("\n    "),
      );
    }
  }
  assertEquals(wrong, [], `\n${wrong.join("\n")}`);
});

// Two rules, one question. `checkUseCell` warns that useCell() is deprecated;
// the useAio rule used to answer "prefer useCell(ref)" — so following aiol's
// advice earned you aiol's next warning. Whatever the answer is, there is one.
Deno.test("aiol: no rule recommends an API another rule deprecates", async () => {
  const issues = await lintFixture(app({
    "src/W.tsx":
      `import { useAio } from "aio/air";\nexport function W() { const { state } = useAio(); return <div>{String(state)}</div>; }\n`,
  }));
  const advice = issues.map((i) => `${i.message} ${i.fix ?? ""}`).join("\n");
  assertStringIncludes(advice, "useAio()");
  assert(
    !/\buseCell\b/.test(advice),
    `aiol told this file to adopt useCell, which aiol deprecates:\n${advice}`,
  );
});

// A diagnostic that names a TRUNCATED identifier is worse than silence: it
// tells you to go look at code that doesn't exist. Both of these regexes ended
// `(\w+)…(?!\()`, and `\w+` simply backtracked one character so the negative
// lookahead never saw the `(` — `counter.increment(1)` was reported as a read
// of `counter.incremen`.
Deno.test("aiol: findings never name a truncated identifier", async () => {
  const issues = [
    ...await lintFixture(app({
      "src/heavy.ts":
        `import { cell } from "aio";\nimport { counter } from "./cell.ts";\nexport const heavy = cell("heavy", {\n  worker: true,\n  state: { n: 0 },\n  methods: { go(s: { n: number }) { counter.increment(1); s.n = 1; } },\n});\n`,
    })),
    ...await lintFixture(app({
      "src/w.ts":
        `import { counter } from "./cell.ts";\nexport async function go() {\n  await counter.increment(1);\n  counter.increment(2);\n}\n`,
    })),
  ];
  const truncated = issues.filter((i) => i.message.includes('incremen"'));
  assertEquals(
    truncated.map((i) => i.message),
    [],
    "a finding named `counter.incremen` — the identifier was cut short",
  );
});
