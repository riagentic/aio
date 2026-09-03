// ONE decider for "what is in the browser bundle, and why it is refused".
//
// For two weeks a field app's graph validator said "no BLOCKING server-only
// imports — all behind dynamic imports" while `deno task build` refused the
// same source for seven leaks. The validator treated ANY dynamic import as the
// escape hatch; the bundler's truth is that only a dynamic import of a
// `*.server.ts` module is external — every other dynamic target is FOLLOWED,
// and its static `@std/path` one hop further is in the bundle. And a module
// touching `Buffer` at module scope was refused by NOBODY: dev never evaluates
// a module nothing calls, and the first evaluation of the graph happened on a
// user's machine as a blank page.
//
// This file pins the four verdicts, on both consumers, from one fixture each:
//   (a) a static `*.server.ts` import            → BOTH refuse
//   (b) dynamic import of a plain module that
//       statically imports `@std/path`            → BOTH refuse (BLOCKING)
//   (c) dynamic import of a `*.server.ts` module → BOTH allow
//   (d) `Buffer` at module scope                  → BOTH refuse, naming the file
//   (e) `Buffer` in a static class field — the static scan cannot see it,
//       EVALUATION does                           → BOTH refuse, naming the file
//   (f) `Buffer` at module scope with a shim that
//       defines it FIRST — it loads               → BOTH allow, with a note
// …and that the words are the same.
//
// And the counter-rule (f) exists for: the scan is a suspicion, the
// EVALUATION is the verdict. Refusing on the scan alone refused an app whose
// bundle evaluated clean in both shells — 13 of its 14 findings were the
// CommonJS spelling of `require`/`module` (which esbuild supplies), and the
// 14th was a `Buffer` a shim had already defined.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  auditClientGraph,
  type MetaInputs,
  scanNodeGlobals,
} from "../src/build/graph-audit.ts";
import { evaluateBundle } from "../src/build/graph-eval.ts";
import {
  createProdGraphCheck,
  validateGraph,
} from "../src/server/graph-validator.ts";
import { transpile } from "../src/server/server-transpile.ts";
import { buildBrowserImportMap } from "../src/server/server-html-importmap.ts";
import { ESBUILD_SPEC } from "../src/build/esbuild-shared.ts";
import { BUNDLE_ENTRY_KEY } from "../src/build/client-bundle.ts";
import { childCoverageDir } from "../src/testing/temp-dir.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const _childCovDir = childCoverageDir();

const IMPORTS = {
  "aio": `${ROOT}mod.ts`,
  "aio/jsx-runtime": `${ROOT}src/jsx-runtime.ts`,
  "aio/server": `${ROOT}src/server.ts`,
  "immer": "npm:immer@10.2.0",
  "@std/path": "jsr:@std/path@^1",
};

/** A minimal real app: deno.json + files, in a temp dir with node_modules. */
async function makeApp(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "aio-parity-" });
  await Deno.writeTextFile(
    `${dir}/deno.json`,
    JSON.stringify({
      title: "Parity Probe",
      nodeModulesDir: "auto",
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "aio" },
      imports: IMPORTS,
    }),
  );
  await Deno.symlink(`${ROOT}node_modules`, `${dir}/node_modules`);
  for (const [name, body] of Object.entries(files)) {
    await Deno.writeTextFile(`${dir}/${name}`, body);
  }
  return dir;
}

/** The VALIDATOR's verdict — `validateGraph` with the prod-graph judge, the
 *  way the dev server and `check:graph` call it. */
async function validatorVerdict(dir: string) {
  const importMap = buildBrowserImportMap(IMPORTS, { vendorImmer: false });
  const result = await validateGraph(
    `${dir}/App.tsx`,
    importMap,
    (s, f) => transpile(s, f),
    undefined,
    createProdGraphCheck({ absBaseDir: dir, uiEntry: "App.tsx" }),
  );
  const refused = result.errors.filter((e) => e.category === "bundle-refused");
  return { valid: result.valid, refused, result };
}

/** The BUILDER's verdict — the real `runBundle`, in a subprocess (it exits
 *  the process on refusal). */
async function builderVerdict(
  dir: string,
): Promise<{ code: number; stderr: string; js: string }> {
  const runner = `${dir}/.aio-build/runner.ts`;
  await Deno.mkdir(`${dir}/.aio-build`, { recursive: true });
  await Deno.writeTextFile(
    runner,
    `import { runBundle } from "${ROOT}src/build/build-bundle.ts";
import { resolveAppDir } from "${ROOT}src/build/build-config.ts";
const root = ${JSON.stringify(dir)};
const mainConfig = JSON.parse(await Deno.readTextFile(root + "/deno.json"));
const configEntry = "app.ts";
await runBundle({
  root, dist: root + "/dist", out: root + "/dist/app.js",
  frameworkSrcDir: ${JSON.stringify(ROOT + "src")},
  frameworkBase: new URL(${JSON.stringify("file://" + ROOT + "src/")}),
  isRemote: false, doAndroid: false, doForce: true,
  configEntry, appDir: resolveAppDir(root, configEntry), uiEntry: "App.tsx",
  // deno-lint-ignore no-explicit-any
} as any, mainConfig);
`,
  );
  const out = await new Deno.Command(Deno.execPath(), {
    env: { DENO_COVERAGE_DIR: _childCovDir },
    args: ["run", "-A", runner],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const d = new TextDecoder();
  return {
    code: out.code,
    stderr: d.decode(out.stderr),
    js: await Deno.readTextFile(`${dir}/dist/app.js`).catch(() => ""),
  };
}

async function stopEsbuild() {
  const mod = await import(ESBUILD_SPEC);
  await mod.stop();
  await new Promise((r) => setTimeout(r, 10));
}

const APP = (body: string, pre = "") =>
  `${pre}
export default function App() { return <div>${body}</div>; }
`;

Deno.test({
  name:
    "parity (a): a STATIC *.server.ts import — validator and builder both refuse, same words",
  sanitizeOps: false, // aio-ok: esbuild's service is a shared child stopped once per test
  sanitizeResources: false, // aio-ok: same esbuild service
  async fn() {
    const dir = await makeApp({
      "io.server.ts": `export const secret = "PARITY_SECRET_A";`,
      "App.tsx": APP("{secret}", `import { secret } from "./io.server.ts";`),
    });
    try {
      const v = await validatorVerdict(dir);
      // The walker already blocks this one (static + eager); the bundle judge
      // is skipped so ONE cause is reported once — but the app is refused.
      assertEquals(v.valid, false, "validator must refuse a static leak");
      const b = await builderVerdict(dir);
      assertEquals(b.code, 1, `builder must refuse\n${b.stderr}`);
      assert(
        !b.js.includes("PARITY_SECRET_A"),
        "the secret was IN dist/app.js",
      );
      assertStringIncludes(b.stderr, "io.server.ts");
    } finally {
      await stopEsbuild();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "parity (b): a dynamic import of a PLAIN module that statically imports @std/path is BLOCKING in both",
  sanitizeOps: false, // aio-ok: esbuild's service is a shared child stopped once per test
  sanitizeResources: false, // aio-ok: same esbuild service
  async fn() {
    const dir = await makeApp({
      "helpers.ts": `import { join } from "@std/path";
export const where = (a: string, b: string) => join(a, b);`,
      "App.tsx": APP(
        `<button onClick={async () => { const h = await import("./helpers.ts"); console.log(h.where("a", "b")); }}>go</button>`,
      ),
    });
    try {
      const v = await validatorVerdict(dir);
      assertEquals(
        v.valid,
        false,
        "the validator called this 'behind a dynamic import' for two weeks — the bundler FOLLOWS it",
      );
      assertEquals(v.refused.length, 1);
      const err = v.refused[0]!;
      assertStringIncludes(err.message, '"@std/path" is server-only');
      assertStringIncludes(err.file, "helpers.ts");
      assertStringIncludes(
        err.message,
        "via",
        "the chain from the entry is named",
      );
      assertStringIncludes(
        err.fix,
        "only a dynamic import of a *.server.ts module is external",
      );
      const b = await builderVerdict(dir);
      assertEquals(b.code, 1, `builder must refuse\n${b.stderr}`);
      // The SAME words.
      assertStringIncludes(b.stderr, '"@std/path" is server-only');
      assertStringIncludes(
        b.stderr,
        "helpers.ts — " + err.message.split(" (via")[0],
      );
      assertStringIncludes(b.stderr, "via App.tsx → helpers.ts");
    } finally {
      await stopEsbuild();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "parity (c): a dynamic import of a *.server.ts module is the escape hatch in both",
  sanitizeOps: false, // aio-ok: esbuild's service is a shared child stopped once per test
  sanitizeResources: false, // aio-ok: same esbuild service
  async fn() {
    const dir = await makeApp({
      "io.server.ts":
        `import { join } from "@std/path"; export const secret = "PARITY_SECRET_C"; export const p = (a: string) => join(a, "x");`,
      "App.tsx": APP(
        `<button onClick={async () => { const io = await import("./io.server.ts"); console.log(io.p("a")); }}>go</button>`,
      ),
    });
    try {
      const v = await validatorVerdict(dir);
      assertEquals(v.refused, [], "the escape hatch must stay open");
      assertEquals(v.valid, true);
      assert(
        v.result.bundleMs !== undefined,
        "the prod graph was judged (not skipped)",
      );
      const b = await builderVerdict(dir);
      assertEquals(b.code, 0, `builder must accept\n${b.stderr}`);
      assert(!b.js.includes("PARITY_SECRET_C"), "and ship nothing of it");
    } finally {
      await stopEsbuild();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "parity (d): Buffer at module scope — refused in both, the module and the fix named",
  sanitizeOps: false, // aio-ok: esbuild's service is a shared child stopped once per test
  sanitizeResources: false, // aio-ok: same esbuild service
  async fn() {
    const dir = await makeApp({
      "buf.ts": `export const magic = Buffer.from("hi").toString("hex");`,
      "App.tsx": APP("{magic}", `import { magic } from "./buf.ts";`),
    });
    try {
      const v = await validatorVerdict(dir);
      assertEquals(v.valid, false);
      assertEquals(v.refused.length, 1);
      const err = v.refused[0]!;
      assertStringIncludes(err.file, "buf.ts");
      assertEquals(err.line, 1);
      assertStringIncludes(err.message, "Buffer is referenced at module scope");
      assertStringIncludes(
        err.message,
        "ReferenceError: Buffer is not defined",
      );
      assertStringIncludes(err.fix, "does not polyfill Node globals");
      assertStringIncludes(err.fix, "*.server.ts");
      const b = await builderVerdict(dir);
      assertEquals(b.code, 1, `builder must refuse\n${b.stderr}`);
      assertStringIncludes(
        b.stderr,
        "buf.ts:1 — " + err.message.split(" (via")[0],
      );
      assertStringIncludes(b.stderr, "ReferenceError: Buffer is not defined");
      assertEquals(
        b.js,
        "",
        "a bundle that cannot load never becomes an artifact",
      );
    } finally {
      await stopEsbuild();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "parity (e): Buffer the static scan cannot see (a static class field) — EVALUATION refuses in both, naming the module",
  sanitizeOps: false, // aio-ok: esbuild's service is a shared child stopped once per test
  sanitizeResources: false, // aio-ok: same esbuild service
  async fn() {
    const src = `export class Codec { static empty = Buffer.alloc(0); }`;
    assertEquals(
      scanNodeGlobals(src),
      [],
      "premise: the static floor misses a class field (depth 1)",
    );
    const dir = await makeApp({
      "codec.ts": src,
      "App.tsx": APP("{Codec.name}", `import { Codec } from "./codec.ts";`),
    });
    try {
      const v = await validatorVerdict(dir);
      assertEquals(
        v.valid,
        false,
        "evaluation must catch what the scan cannot",
      );
      const err = v.refused[0]!;
      assertStringIncludes(err.message, "the browser bundle cannot load");
      assertStringIncludes(
        err.message,
        "ReferenceError: Buffer is not defined",
      );
      assertStringIncludes(err.file, "codec.ts", "attributed to the module");
      const b = await builderVerdict(dir);
      assertEquals(b.code, 1, `builder must refuse\n${b.stderr}`);
      assertStringIncludes(b.stderr, "the browser bundle cannot load");
      assertStringIncludes(b.stderr, "codec.ts");
      assertEquals(b.js, "");
    } finally {
      await stopEsbuild();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "parity (f): a module-scope Buffer that a shim DEFINES first — both allow it, and say so",
  sanitizeOps: false, // aio-ok: esbuild's service is a shared child stopped once per test
  sanitizeResources: false, // aio-ok: same esbuild service
  async fn() {
    // The shape a real wallet ships: a dependency touches `Buffer` while it
    // evaluates, and the app defines the global from a module imported BEFORE
    // it — the fix aio's own refusal names. The static scan sees the touch and
    // cannot see the shim; the evaluation sees a bundle that loads.
    const dir = await makeApp({
      "shim.ts":
        `(globalThis as Record<string, unknown>).Buffer ??= { from: (s: string) => s };`,
      "dep.ts": `export const magic = Buffer.from("hi");`,
      "App.tsx": APP(
        "{String(magic)}",
        `import "./shim.ts";\nimport { magic } from "./dep.ts";`,
      ),
    });
    try {
      const v = await validatorVerdict(dir);
      assertEquals(v.refused, [], "a bundle that LOADS is not refused");
      assertEquals(v.valid, true);
      const b = await builderVerdict(dir);
      assertEquals(b.code, 0, `builder must accept\n${b.stderr}`);
      assert(b.js.length > 0, "and the artifact is written");
    } finally {
      await stopEsbuild();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "prod-graph judge: cached by graph hash — an unchanged graph costs nothing on reload",
  sanitizeOps: false, // aio-ok: esbuild's service is a shared child stopped once per test
  sanitizeResources: false, // aio-ok: same esbuild service
  async fn() {
    const dir = await makeApp({ "App.tsx": APP("hi") });
    try {
      const judge = createProdGraphCheck({
        absBaseDir: dir,
        uiEntry: "App.tsx",
      });
      const first = await judge("h1");
      assertEquals(first.cached, false);
      assert(first.ms > 0);
      const again = await judge("h1");
      assertEquals(again.cached, true);
      assertEquals(again.ms, 0);
      const changed = await judge("h2");
      assertEquals(changed.cached, false);
    } finally {
      await stopEsbuild();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "aio-ok: node-global silences the STATIC scan only — the evaluation still refuses a line that really throws",
  sanitizeOps: false, // aio-ok: esbuild's service is a shared child stopped once per test
  sanitizeResources: false, // aio-ok: same esbuild service
  async fn() {
    // (1) a wrong-scope heuristic, acknowledged: no static finding, either
    //     spelling (same line / line above).
    assertEquals(
      scanNodeGlobals(
        `const f = (x) =>\n  Buffer.from(x); // aio-ok: node-global — arrow body, runs later\n`,
      ),
      [],
    );
    assertEquals(
      scanNodeGlobals(
        `// aio-ok: node-global — arrow body, runs later\nconst g = (x) =>\n  process.cwd();\nconst h = Buffer;`,
      ).map((h) => h.name),
      ["Buffer"],
      "the acknowledgement covers ONE line",
    );
    // (2) a WRONG acknowledgement — the line really runs at load. The static
    //     scan is silent; the evaluation is not, in the validator and the build.
    const dir = await makeApp({
      "buf.ts":
        `export const magic = Buffer.from("hi").toString("hex"); // aio-ok: node-global — (wrong) never runs in the browser`,
      "App.tsx": APP("{magic}", `import { magic } from "./buf.ts";`),
    });
    try {
      const v = await validatorVerdict(dir);
      assertEquals(v.valid, false, "a wrong ack cannot ship a blank page");
      const err = v.refused[0]!;
      assertStringIncludes(err.message, "the browser bundle cannot load");
      assertStringIncludes(err.message, "Buffer is not defined");
      assertStringIncludes(err.file, "buf.ts");
      const b = await builderVerdict(dir);
      assertEquals(b.code, 1, `builder must refuse\n${b.stderr}`);
      assertStringIncludes(b.stderr, "the BROWSER bundle cannot load");
      assertEquals(b.js, "");
    } finally {
      await stopEsbuild();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// ── the pure decider, on a hand-written metafile ──

const M = (
  imports: Record<string, Array<[string, "static" | "dynamic", boolean?]>>,
): MetaInputs =>
  Object.fromEntries(
    Object.entries(imports).map(([k, v]) => [k, {
      imports: v.map(([path, kind, external]) => ({
        path,
        kind: kind === "static" ? "import-statement" : "dynamic-import",
        external,
      })),
    }]),
  );

Deno.test("audit: the escape-hatch rule is 'dynamic import OF a *.server.ts' — nothing broader", () => {
  const inputs = M({
    "entry.tsx": [["App.tsx", "static"]],
    "App.tsx": [
      ["helpers.ts", "dynamic"], // followed
      ["io.server.ts", "dynamic", true], // external — the hatch
    ],
    "helpers.ts": [["aio-server-only:@std/path", "static"]],
    "aio-server-only:@std/path": [],
  });
  const v = auditClientGraph({
    entry: "entry.tsx",
    inputs,
    source: () => "",
    hideEntry: true,
  });
  assertEquals(v.ok, false);
  assertEquals(v.findings.length, 1);
  assertEquals(v.findings[0]!.file, "helpers.ts");
  assertEquals(v.findings[0]!.target, "@std/path");
  assertEquals(v.findings[0]!.chain, ["App.tsx", "helpers.ts"]);
  assert(!v.reached.includes("io.server.ts"), "external is not reached");
});

Deno.test("audit: a DYNAMIC node:/@std import is dead code in a method — allowed", () => {
  const inputs = M({
    "entry.tsx": [["App.tsx", "static"]],
    "App.tsx": [["aio-server-only:node:fs", "dynamic"]],
    "aio-server-only:node:fs": [],
  });
  const v = auditClientGraph({ entry: "entry.tsx", inputs, source: () => "" });
  assertEquals(v.ok, true);
});

Deno.test("audit: a *.server.* file esbuild read is a leak however it got in (alias, computed import)", () => {
  const inputs = M({
    "entry.tsx": [["App.tsx", "static"]],
    "App.tsx": [["src/vault.server.tsx", "static"]],
    "src/vault.server.tsx": [],
    "src/glob.server.ts": [], // inlined by a computed import(); no edge
  });
  const v = auditClientGraph({ entry: "entry.tsx", inputs, source: () => "" });
  assertEquals(v.findings.map((f) => f.target).sort(), [
    "src/glob.server.ts",
    "src/vault.server.tsx",
  ]);
});

Deno.test("audit: `require`/`module` in a CommonJS input are esbuild's to supply — not a refusal", () => {
  const inputs: MetaInputs = {
    "entry.tsx": {
      imports: [{ path: "cjs.js", kind: "import-statement" }, {
        path: "esm.js",
        kind: "import-statement",
      }],
    },
    // esbuild wraps this one: `module` is a parameter, `require` becomes
    // `__require`. Both exist in the bundle.
    "cjs.js": { imports: [], format: "cjs" },
    // The same spelling in an ESM input is a real ReferenceError.
    "esm.js": { imports: [], format: "esm" },
  };
  const src =
    `const a = require("x");\nmodule.exports = a;\nconst b = Buffer.alloc(1);\n`;
  const v = auditClientGraph({
    entry: "entry.tsx",
    inputs,
    source: (p) => p.endsWith(".js") ? src : "",
  });
  const of = (f: string) =>
    v.findings.filter((x) => x.file === f).map((x) => x.target).sort();
  assertEquals(
    of("cjs.js"),
    ["Buffer"],
    "only the global esbuild does NOT supply",
  );
  assertEquals(of("esm.js"), ["Buffer", "module", "require"]);
});

Deno.test("scanNodeGlobals: module scope only, guards and own bindings excluded, esbuild's NODE_ENV define excluded", () => {
  const hits = (s: string) =>
    scanNodeGlobals(s).map((h) => `${h.name}@${h.line}`);
  assertEquals(hits(`const x = Buffer.alloc(1);`), ["Buffer@1"]);
  assertEquals(hits(`function f() { return Buffer.alloc(1); }`), []);
  assertEquals(hits(`const f = (x) => Buffer.from(x);`), []);
  assertEquals(hits(`const f = (x) => {\n  return process.cwd();\n};`), []);
  assertEquals(
    hits(`const has = typeof Buffer !== "undefined" ? Buffer : null;`),
    [],
  );
  assertEquals(
    hits(`import { Buffer } from "buffer";\nconst b = Buffer.alloc(1);`),
    [],
  );
  assertEquals(
    hits(`const process = { env: {} };\nconst e = process.env;`),
    [],
  );
  assertEquals(hits(`const o = { process: 1, module: 2 };`), []);
  assertEquals(hits(`const e = process.env.NODE_ENV !== "production";`), []);
  assertEquals(hits(`const e = process.env.FOO;`), ["process@1"]);
  assertEquals(
    hits(`// Buffer.alloc(1)\nconst s = "Buffer.alloc";\nconst d = __dirname;`),
    [
      "__dirname@3",
    ],
  );
  assertEquals(hits(`const x = foo.process;`), []);
  assertEquals(hits(`const m = require("x");\nconst n = module.exports;`), [
    "require@1",
    "module@2",
  ]);
});

Deno.test("evaluateBundle: a browser's globals, not a worker's — Buffer/process/Deno are absent, document is present", async () => {
  const bad = await evaluateBundle(`export const b = Buffer.alloc(1);`, "esm");
  assertEquals(bad.ok, false);
  if (!bad.ok) {
    assertEquals(bad.name, "ReferenceError");
    assertEquals(bad.undefinedName, "Buffer");
  }
  const ok = await evaluateBundle(
    `export const t = [typeof process, typeof Deno, typeof Buffer, typeof global];
     if (t.some((x) => x !== "undefined")) throw new Error("leaked: " + t);
     if (document.readyState !== "loading") throw new Error("no stub DOM");
     document.addEventListener("DOMContentLoaded", () => {});`,
    "esm",
  );
  assertEquals(ok.ok, true);
  const iife = await evaluateBundle(
    `(() => { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => {}); else throw new Error("mounted"); })();`,
    "iife",
  );
  assertEquals(iife.ok, true, "the Android entry's boot() waits, never mounts");
  const hang = await evaluateBundle(`await new Promise(() => {});`, "esm", 200);
  assertEquals(hang.ok, false);
  if (!hang.ok) assertEquals(hang.name, "timeout");
});

// THE beginner mistake, and the error it used to get.
//
// `export function App()` instead of `export default function App()` is the
// first thing anyone gets wrong. esbuild answers it against ITS OWN generated
// entry — a file the user never wrote — and the generic fix line explained the
// mechanism ("the prod bundle is built from the same files dev serves")
// instead of the edit. Found by scaffolding an app and making the mistake, not
// by reading the code.
Deno.test({
  name: "graph: a UI entry with no default export names the FILE and the EDIT",
  sanitizeOps: false, // aio-ok: esbuild's service is a shared child stopped once per test
  fn: async () => {
    const dir = await makeApp({
      "App.tsx": `export function App() { return <div>hi</div>; }\n`,
    });
    try {
      const { valid, refused } = await validatorVerdict(dir);
      assertEquals(valid, false, "a bundle that cannot build must refuse");
      assertEquals(refused.length, 1);
      const e = refused[0]!;
      // The user's file, not the synthetic one.
      assertStringIncludes(e.message, "App.tsx has no DEFAULT export");
      // …and the reason the OTHER filename appears at all, said out loud, so
      // nobody goes looking for `_build_entry.tsx` in their own tree.
      assertStringIncludes(e.message, BUNDLE_ENTRY_KEY);
      assertStringIncludes(e.message, "a file you did not write");
      // The FIX is an edit that can be typed, in both shapes people write.
      assertStringIncludes(e.fix, "export default function App()");
      assertStringIncludes(e.fix, "export default App;");
      // It must NOT fall through to the generic mechanism sentence.
      assert(
        !e.fix.includes("built from the same files dev serves"),
        `the generic fix explains the mechanism, not the edit: ${e.fix}`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "graph: an UNRELATED bundle failure keeps the generic explanation",
  sanitizeOps: false, // aio-ok: esbuild's service is a shared child stopped once per test
  fn: async () => {
    // The translation must be narrow. A different esbuild failure still gets
    // the sentence that is true of all of them — a special case that swallowed
    // the general one would be worse than no special case.
    // A NAMED export that does not exist — same esbuild error family ("No
    // matching export"), different import, so it must NOT be translated into
    // the default-export advice. A special case that swallowed its neighbours
    // would be worse than no special case.
    const dir = await makeApp({
      "helper.ts": `export const there = 1;\n`,
      "App.tsx": `import { notThere } from "./helper.ts";\n` +
        `export default function App() { return <div>{notThere}</div>; }\n`,
    });
    try {
      const { refused } = await validatorVerdict(dir);
      assertEquals(refused.length, 1, JSON.stringify(refused));
      assertStringIncludes(refused[0]!.fix, "esbuild cannot resolve");
      assert(
        !refused[0]!.message.includes("no DEFAULT export"),
        refused[0]!.message,
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
