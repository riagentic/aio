import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkPlatformSafety,
  extractImports,
  extractSourceImports,
  resolveSpecifier,
  validateGraph,
} from "../src/server/graph-validator.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("extractImports finds static imports", () => {
  const code = `import { foo } from "./foo.ts";\nimport bar from "../bar.tsx";`;
  assertEquals(extractImports(code), ["./foo.ts", "../bar.tsx"]);
});

Deno.test("extractImports finds bare specifiers", () => {
  const code = `import { useState } from "react";\nimport _ from "lodash";`;
  assertEquals(extractImports(code), ["react", "lodash"]);
});

Deno.test("extractImports finds dynamic imports", () => {
  const code = `const m = await import("./lazy.ts");`;
  assertEquals(extractImports(code), ["./lazy.ts"]);
});

Deno.test("extractImports finds re-exports", () => {
  const code = `export { x } from "./x.ts";\nexport * from "./y.ts";`;
  assertEquals(extractImports(code), ["./x.ts", "./y.ts"]);
});

Deno.test("extractImports ignores comments", () => {
  const code =
    `// import { x } from "ignored"\n/* import { y } from "also-ignored" */\nimport { z } from "real";`;
  assertEquals(extractImports(code), ["real"]);
});

Deno.test("resolveSpecifier resolves relative with extension try", () => {
  // Use a mock fileExists that says ./foo.ts exists
  const exists = (p: string) => p.endsWith("/foo.ts");
  const result = resolveSpecifier("./foo", "/project/src/App.tsx", {}, exists);
  assertEquals(result, { kind: "local", path: "/project/src/foo.ts" });
});

Deno.test("resolveSpecifier resolves bare via import map", () => {
  const importMap = { "react": "https://esm.sh/react@18.3.1" };
  const result = resolveSpecifier("react", "/project/src/App.tsx", importMap);
  assertEquals(result, {
    kind: "external",
    url: "https://esm.sh/react@18.3.1",
  });
});

Deno.test("resolveSpecifier treats absolute URL path as external", () => {
  const importMap = { "aio": "/__aio/ui.js" };
  const result = resolveSpecifier("aio", "/project/src/App.tsx", importMap);
  assertEquals(result, { kind: "external", url: "/__aio/ui.js" });
});

Deno.test("resolveSpecifier resolves jsr: import map entry as external", () => {
  const importMap = { "@std/path": "jsr:@std/path@^1" };
  const result = resolveSpecifier(
    "@std/path",
    "/project/src/App.tsx",
    importMap,
  );
  assertEquals(result, { kind: "external", url: "jsr:@std/path@^1" });
});

Deno.test("resolveSpecifier resolves local import map alias", () => {
  // "./lib/utils.ts" resolved relative to importer's dir (/project/src/) = /project/src/lib/utils.ts
  const exists = (p: string) => p === "/project/src/lib/utils.ts";
  const importMap = { "my-utils": "./lib/utils.ts" };
  const result = resolveSpecifier(
    "my-utils",
    "/project/src/App.tsx",
    importMap,
    exists,
  );
  assertEquals(result, { kind: "local", path: "/project/src/lib/utils.ts" });
});

Deno.test("resolveSpecifier errors on missing bare specifier", () => {
  const result = resolveSpecifier("lodash", "/project/src/App.tsx", {});
  assertEquals(result.kind, "error");
  if (result.kind === "error") {
    assertStringIncludes(result.error.fix, "deno.json");
  }
});

Deno.test("resolveSpecifier resolves exact relative path", () => {
  const exists = (p: string) => p === "/project/src/utils.ts";
  const result = resolveSpecifier(
    "./utils.ts",
    "/project/src/App.tsx",
    {},
    exists,
  );
  assertEquals(result, { kind: "local", path: "/project/src/utils.ts" });
});

Deno.test("resolveSpecifier resolves index file", () => {
  const exists = (p: string) => p === "/project/src/components/index.ts";
  const result = resolveSpecifier(
    "./components",
    "/project/src/App.tsx",
    {},
    exists,
  );
  assertEquals(result, {
    kind: "local",
    path: "/project/src/components/index.ts",
  });
});

Deno.test("resolveSpecifier errors on missing relative", () => {
  const exists = (_p: string) => false;
  const result = resolveSpecifier(
    "./missing",
    "/project/src/App.tsx",
    {},
    exists,
  );
  assertEquals(result.kind, "error");
  if (result.kind === "error") {
    assertEquals(result.error.category, "file-not-found");
  }
});

Deno.test("checkPlatformSafety detects Deno API usage", () => {
  const code = `const data = await Deno.readTextFile("x");`;
  const errors = checkPlatformSafety(code, "./db.ts");
  assertEquals(errors.length, 1);
  assertEquals(errors[0]!.category, "server-only-api");
});

Deno.test("checkPlatformSafety ignores import type", () => {
  const code = `import type { Something } from "node:fs";`;
  const errors = checkPlatformSafety(code, "./types.ts");
  assertEquals(errors.length, 0);
});

Deno.test("checkPlatformSafety detects node: imports", () => {
  const code = `import { readFile } from "node:fs";`;
  const errors = checkPlatformSafety(code, "./io.ts");
  assertEquals(errors.length, 1);
  assertStringIncludes(errors[0]!.fix, "server-only");
});

Deno.test("checkPlatformSafety ignores Deno in strings", () => {
  const code = `const s = "Deno.readTextFile is a thing";`;
  const errors = checkPlatformSafety(code, "./safe.ts");
  assertEquals(errors.length, 0);
});

Deno.test("checkPlatformSafety ignores type-only Deno.* references", () => {
  // Types are erased by esbuild and never reach the browser — must not flag.
  assertEquals(
    checkPlatformSafety(`function f(e: Deno.FsEvent) { return e }`, "./a.ts")
      .length,
    0,
  );
  assertEquals(
    checkPlatformSafety(`let w: Array<Deno.FsWatcher>;`, "./b.ts").length,
    0,
  );
  assertEquals(
    checkPlatformSafety(`const c = x as Deno.Conn;`, "./c.ts").length,
    0,
  );
  // Value usage is still flagged, including inside an object literal.
  assertEquals(
    checkPlatformSafety(`const o = { h: Deno.serve(() => {}) };`, "./d.ts")
      .length,
    1,
  );
});

Deno.test("checkPlatformSafety detects export * from node:", () => {
  const code = `export * from "node:path";`;
  const errors = checkPlatformSafety(code, "./utils.ts");
  assertEquals(errors.length, 1);
  // node: builtins are a GUARANTEED browser break → blocking category.
  assertEquals(errors[0]!.category, "server-only-import");
});

Deno.test("checkPlatformSafety: node: import is a BLOCKING server-only-import", () => {
  const errors = checkPlatformSafety(
    `import { readFile } from "node:fs";`,
    "./io.ts",
  );
  assertEquals(errors[0]!.category, "server-only-import");
});

Deno.test("checkPlatformSafety: @std/* import is a WARNING (often browser-safe)", () => {
  const errors = checkPlatformSafety(
    `import { join } from "@std/path";`,
    "./p.ts",
  );
  assertEquals(errors.length, 1);
  assertEquals(errors[0]!.category, "server-only-api");
});

Deno.test('checkPlatformSafety: createDB from "aio" is a BLOCKING server-only-import', () => {
  const errors = checkPlatformSafety(
    `import { cell, createDB } from "aio";`,
    "./nft-cache.ts",
  );
  assertEquals(errors.length, 1);
  assertEquals(errors[0]!.category, "server-only-import");
  assertStringIncludes(errors[0]!.message, "createDB");
});

Deno.test("checkPlatformSafety: browser-safe aio schema helpers are NOT flagged", () => {
  const errors = checkPlatformSafety(
    `import { cell, table, pk, text, integer } from "aio";`,
    "./schema.ts",
  );
  assertEquals(errors.length, 0);
});

Deno.test("checkPlatformSafety: import type of a server-only aio symbol is NOT flagged", () => {
  const errors = checkPlatformSafety(
    `import type { createDB } from "aio";`,
    "./types.ts",
  );
  assertEquals(errors.length, 0);
});

Deno.test("checkPlatformSafety skips Deno.* behind typeof guard", () => {
  const code = `const args = typeof Deno !== 'undefined' ? Deno.args: [];`;
  const errors = checkPlatformSafety(code, "./cell.ts");
  const denoErrors = errors.filter((e) => e.message.includes("Deno."));
  assertEquals(denoErrors.length, 0);
});

Deno.test("checkPlatformSafety still flags unguarded Deno.* after guarded usage", () => {
  const code =
    `const args = typeof Deno !== 'undefined' ? Deno.args: [];\nconst x = Deno.readTextFile("f");`;
  const errors = checkPlatformSafety(code, "./cell.ts");
  const denoErrors = errors.filter((e) => e.message.includes("Deno."));
  assertEquals(denoErrors.length, 1);
  assertStringIncludes(denoErrors[0]!.message, "readTextFile");
});

Deno.test("checkPlatformSafety detects export * from @std/", () => {
  const code = `export * from "@std/path";`;
  const errors = checkPlatformSafety(code, "./re-export.ts");
  assertEquals(errors.length, 1);
  assertEquals(errors[0]!.category, "server-only-api");
});

// Simple mock transpile: just return the code as-is (TS imports look like JS imports)
const mockTranspile = (source: string, _filepath: string) =>
  Promise.resolve(source);

Deno.test("validateGraph walks import tree — happy path", async () => {
  const dir = await tempDir("aio-graph-validator-");
  try {
    await Deno.writeTextFile(
      dir + "/App.tsx",
      `import { foo } from "./foo.ts";\nexport default function App() { return null; }`,
    );
    await Deno.writeTextFile(dir + "/foo.ts", `export const foo = 42;`);
    const result = await validateGraph(dir + "/App.tsx", {}, mockTranspile);
    assertEquals(result.valid, true);
    assertEquals(result.errors.length, 0);
    assert(result.modules.size >= 2); // App.tsx and foo.ts
    assert(result.durationMs >= 0);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("validateGraph: Deno.* in a dynamic-only module is deferred (quiet)", async () => {
  const dir = await tempDir("aio-graph-validator-");
  try {
    // App → cell (static); cell → server (dynamic import — the escape hatch).
    await Deno.writeTextFile(
      dir + "/App.tsx",
      `import { cell } from "./cell.ts";\nexport default function App() { return null; }`,
    );
    await Deno.writeTextFile(
      dir + "/cell.ts",
      `export const cell = { run: async () => (await import("./server.ts")).read() };`,
    );
    await Deno.writeTextFile(
      dir + "/server.ts",
      `export async function read() { return await Deno.readTextFile("x"); }`,
    );
    const result = await validateGraph(dir + "/App.tsx", {}, mockTranspile);
    assertEquals(result.valid, true); // never blocks
    const e = result.errors.find((e) =>
      e.file.endsWith("/server.ts") && e.category === "server-only-api"
    );
    assert(e, "server.ts Deno usage detected");
    assertEquals(e!.deferred, true, "dynamic-only Deno usage is deferred");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("validateGraph: Deno.* in a statically-reachable module stays loud", async () => {
  const dir = await tempDir("aio-graph-validator-");
  try {
    await Deno.writeTextFile(
      dir + "/App.tsx",
      `import { read } from "./server.ts";\nexport default function App() { return null; }`,
    );
    await Deno.writeTextFile(
      dir + "/server.ts",
      `export async function read() { return await Deno.readTextFile("x"); }`,
    );
    const result = await validateGraph(dir + "/App.tsx", {}, mockTranspile);
    const e = result.errors.find((e) =>
      e.file.endsWith("/server.ts") && e.category === "server-only-api"
    );
    assert(e, "server.ts Deno usage detected");
    assert(!e!.deferred, "eager Deno usage is NOT deferred (stays loud)");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("validateGraph detects missing import", async () => {
  const dir = await tempDir("aio-graph-validator-");
  try {
    await Deno.writeTextFile(
      dir + "/App.tsx",
      `import { bar } from "./bar.ts";\nexport default function App() { return null; }`,
    );
    const result = await validateGraph(dir + "/App.tsx", {}, mockTranspile);
    assertEquals(result.valid, false);
    assert(result.errors.some((e) => e.category === "file-not-found"));
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("validateGraph detects transpile error", async () => {
  const dir = await tempDir("aio-graph-validator-");
  try {
    await Deno.writeTextFile(
      dir + "/App.tsx",
      `export default function App() { return null; }`,
    );
    const badTranspile = (_s: string, _f: string): Promise<string> =>
      Promise.reject(new Error("syntax error"));
    const result = await validateGraph(dir + "/App.tsx", {}, badTranspile);
    assertEquals(result.valid, false);
    assert(result.errors.some((e) => e.category === "transpile-error"));
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("validateGraph detects missing bare specifier", async () => {
  const dir = await tempDir("aio-graph-validator-");
  try {
    await Deno.writeTextFile(
      dir + "/App.tsx",
      `import _ from "lodash";\nexport default function App() { return null; }`,
    );
    const result = await validateGraph(dir + "/App.tsx", {}, mockTranspile);
    assertEquals(result.valid, false);
    assert(result.errors.some((e) => e.category === "missing-import-map"));
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("validateGraph skips external CDN imports", async () => {
  const dir = await tempDir("aio-graph-validator-");
  try {
    await Deno.writeTextFile(
      dir + "/App.tsx",
      `import { useState } from "react";\nexport default function App() { return null; }`,
    );
    const importMap = { "react": "https://esm.sh/react@18.3.1" };
    const result = await validateGraph(
      dir + "/App.tsx",
      importMap,
      mockTranspile,
    );
    assertEquals(result.valid, true);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("validateGraph detects circular imports", async () => {
  const dir = await tempDir("aio-graph-validator-");
  try {
    await Deno.writeTextFile(
      dir + "/a.ts",
      `import { b } from "./b.ts";\nexport const a = 1;`,
    );
    await Deno.writeTextFile(
      dir + "/b.ts",
      `import { a } from "./a.ts";\nexport const b = 2;`,
    );
    const result = await validateGraph(dir + "/a.ts", {}, mockTranspile);
    // Circular imports are warnings — graph is still valid but cycle must be detected
    assert(result.valid, "circular imports should not block validation");
    assert(
      result.errors.some((e) => e.category === "circular-dependency"),
      "cycle must be detected",
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("validateGraph detects server-only API as warning (non-blocking)", async () => {
  const dir = await tempDir("aio-graph-validator-");
  try {
    await Deno.writeTextFile(
      dir + "/App.tsx",
      `const x = Deno.readTextFile("y");\nexport default function App() { return null; }`,
    );
    const result = await validateGraph(dir + "/App.tsx", {}, mockTranspile);
    // Server-only APIs are warnings, not blocking errors — app still loads
    assertEquals(result.valid, true);
    assert(result.errors.some((e) => e.category === "server-only-api"));
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("validateGraph: a node: import in the client graph BLOCKS (sandboxed renderer can't load it)", async () => {
  const dir = await tempDir("aio-graph-validator-");
  try {
    await Deno.writeTextFile(
      dir + "/App.tsx",
      `import { readFile } from "node:fs";\nexport default function App() { return null; }`,
    );
    const result = await validateGraph(dir + "/App.tsx", {}, mockTranspile);
    // Guaranteed break → not valid → server renders the diagnostic page, not a
    // silent blank screen.
    assertEquals(result.valid, false);
    const err = result.errors.find((e) => e.category === "server-only-import");
    assert(err, "node: import must be a blocking server-only-import");
    assertStringIncludes(err!.fix, "dynamic import");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("validateGraph: a static createDB-from-aio import BLOCKS (the original incident)", async () => {
  const dir = await tempDir("aio-graph-validator-");
  try {
    await Deno.writeTextFile(
      dir + "/App.tsx",
      `import { cell, createDB } from "aio";\nexport default function App() { return null; }`,
    );
    const result = await validateGraph(
      dir + "/App.tsx",
      { aio: "jsr:@example/aio" },
      mockTranspile,
    );
    assertEquals(result.valid, false);
    const err = result.errors.find((e) => e.category === "server-only-import");
    assert(err, "createDB import must be a blocking server-only-import");
    assertStringIncludes(err!.fix, "await import");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("validateGraph: a server-only module reached ONLY via dynamic import does NOT block (the escape hatch works)", async () => {
  const dir = await tempDir("aio-graph-validator-");
  try {
    // App statically imports a cell; the cell lazily imports the server-only
    // module (the documented fix). That must NOT block — it's deferred.
    await Deno.writeTextFile(
      dir + "/App.tsx",
      `import { cell } from "./cell.ts";\nexport default function App() { return null; }`,
    );
    await Deno.writeTextFile(
      dir + "/cell.ts",
      `export const cell = {};\nexport async function load() { const { DatabaseSync } = await import("./db.ts"); return DatabaseSync; }`,
    );
    await Deno.writeTextFile(
      dir + "/db.ts",
      `import { DatabaseSync } from "node:sqlite";\nexport { DatabaseSync };`,
    );
    const result = await validateGraph(dir + "/App.tsx", {}, mockTranspile);
    // db.ts is reached only via dynamic import → deferred → boot is NOT blocked.
    assertEquals(
      result.valid,
      true,
      "dynamic-imported server-only module must not block",
    );
    const dbErr = result.errors.find((e) => e.file.endsWith("db.ts"));
    assert(dbErr, "still reported (as a deferred warning)");
    assertEquals(dbErr!.category, "server-only-api");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("validateGraph: a STATIC server-only import still BLOCKS (eagerly linked)", async () => {
  const dir = await tempDir("aio-graph-validator-");
  try {
    await Deno.writeTextFile(
      dir + "/App.tsx",
      `import { cell } from "./cell.ts";\nexport default function App() { return null; }`,
    );
    // cell STATICALLY imports the server-only module → eager → blocks.
    await Deno.writeTextFile(
      dir + "/cell.ts",
      `import { DatabaseSync } from "node:sqlite";\nexport const cell = DatabaseSync;`,
    );
    const result = await validateGraph(dir + "/App.tsx", {}, mockTranspile);
    assertEquals(result.valid, false);
    assert(result.errors.some((e) => e.category === "server-only-import"));
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("validateGraph per-module valid computed after full walk", async () => {
  const dir = await tempDir("aio-graph-validator-");
  try {
    // App imports foo which imports missing bar — App is the importer for bar's error
    await Deno.writeTextFile(
      dir + "/App.tsx",
      `import { foo } from "./foo.ts";\nexport default function App() { return null; }`,
    );
    await Deno.writeTextFile(
      dir + "/foo.ts",
      `import { bar } from "./bar.ts";\nexport const foo = 1;`,
    );
    const result = await validateGraph(dir + "/App.tsx", {}, mockTranspile);
    assertEquals(result.valid, false);
    // foo.ts should have valid=false because it imports missing bar.ts
    const fooNode = result.modules.get(dir + "/foo.ts");
    assert(fooNode, "foo.ts should be in modules");
    assertEquals(
      fooNode!.valid,
      false,
      "foo.ts should be invalid — it imports missing bar.ts",
    );
  } finally {
    await dropTempDir(dir);
  }
});

// AIO-425: a bare `from "` inside a STRING LITERAL (JSX text) must NOT be
// mistaken for an import — it returned a "Module Errors" page for a valid app.
Deno.test('extractImports ignores `from "` inside string literals (JSX text)', () => {
  // esbuild output shape for <h2>More from {x}</h2> plus real imports.
  const code = [
    `import { jsx, jsxs } from "aio/jsx-runtime";`,
    `import { cell } from "aio";`,
    `function C(){ return jsxs("h2", { children: ["More from ", cat?.name] }); }`,
    `const s = "Recover from backup"; const t = "Import from './guide.md'";`,
  ].join("\n");
  const specs = extractImports(code);
  assertEquals(
    specs,
    ["aio/jsx-runtime", "aio"],
    "only real imports; no garbage",
  );
  // Explicitly: none of the string-literal traps leaked through.
  assert(
    !specs.some((s) => s.includes(",") || s.includes(" ") || s.includes("]")),
  );
  assert(
    !specs.includes("./guide.md"),
    "a specifier-shaped string inside a literal must not match",
  );
});

Deno.test("extractImports still finds real static + dynamic + export-from", () => {
  const code = [
    `import a from "./a.ts";`,
    `export { b } from "./b.ts";`,
    `export * from "./c.ts";`,
    `const m = await import("./d.ts");`,
  ].join("\n");
  assertEquals(extractImports(code).sort(), [
    "./a.ts",
    "./b.ts",
    "./c.ts",
    "./d.ts",
  ]);
});

// a field report: `await import("aio/server")` inside a cell method — the
// documented way to reach SQLite/createDB — was reported as a missing
// import-map entry on every dev boot, with a "fix" (npm:aio/server) that does
// not exist. The browser import map must NOT carry that entry; the validator
// simply has to know the specifier is server-only.
Deno.test("resolveSpecifier: aio/server is external, never a missing-map error", () => {
  const r = resolveSpecifier("aio/server", "/app/src/cache.ts", {
    "aio": "/__aio/ui.js",
  }, () => false);
  assertEquals(r.kind, "external");
});

Deno.test("resolveSpecifier: an unknown bare specifier is still an error", () => {
  const r = resolveSpecifier(
    "totally-unknown-pkg",
    "/app/src/x.ts",
    {},
    () => false,
  );
  assertEquals(r.kind, "error");
});

// The `type` lookahead has to be judged against the import it belongs to.
// `[\s\S]*?` let one match span statement boundaries: the regex started at the
// FIRST import in the file and ran to a later `from "node:…"`, so the
// `(?!type[\s{])` check read the wrong statement and a correctly written
// `import type { Buffer } from "node:buffer"` was reported as a BLOCKING
// server-only import. A blocking graph error makes the dev server serve the
// diagnostic page instead of the app and suppresses hot reload — and the fix
// text told the author to do the thing they had already done.
Deno.test("checkPlatformSafety: a type-only node: import stays clean below other imports", () => {
  const code = `import { render } from "./render.ts";
import { helper } from "./helper.ts";
import type { Buffer } from "node:buffer";

export const x = 1;`;
  assertEquals(
    checkPlatformSafety(code, "./ui.tsx"),
    [],
    "position in the file cannot decide whether an import is type-only",
  );
});

Deno.test("checkPlatformSafety: a REAL node: import below others is still caught", () => {
  const code = `import { render } from "./render.ts";
import type { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";`;
  const errors = checkPlatformSafety(code, "./ui.tsx");
  assertEquals(errors.length, 1, "one finding — the value import");
  assertEquals(errors[0]!.category, "server-only-import");
  assertStringIncludes(errors[0]!.message, "node:fs/promises");
});

Deno.test("checkPlatformSafety: the reported line is the offending import's own", () => {
  const code = `import { a } from "./a.ts";
import { b } from "./b.ts";
import { join } from "@std/path";`;
  const errors = checkPlatformSafety(code, "./p.ts");
  assertEquals(errors.length, 1);
  assertEquals(errors[0]!.line, 3, "a finding that points elsewhere is noise");
});

// ── the scanner reads CODE, not the contents of strings and comments ────────
//
// The visual app manager (`amui`) was served the diagnostic page for two
// releases: its `*.server.ts` re-exports reach the framework's own
// `server-html-gen.ts`, whose HTML template contains `await import('/app.js')`
// — inside a template literal. The scanner stripped comments and nothing else,
// so it read a real dynamic import of `/app.js`, which is in no import map,
// and the walk blocked the app. No gate opened amui in a browser, so every
// gate was green. `scanImports` now consults `codeMask`: the keyword, the
// `from`, and the specifier's quote must all be code.

Deno.test("scanImports: an import written inside a template literal or string is not an import", () => {
  const src = [
    'const html = `<script type="module">',
    "  const { mount } = await import('/app.js')",
    '  import x from "./x.ts"',
    "</script>`;",
    "const s = \"import y from './y.ts'\";",
    "const t = 'export { z } from \"./z.ts\"';",
    'export const real = await import("./real.ts");',
  ].join("\n");
  assertEquals(
    extractSourceImports(src).map((i) => [i.spec, i.kind, i.line]),
    [["./real.ts", "dynamic", 7]],
  );
  assertEquals(extractImports(src), ["./real.ts"]);
});

Deno.test('scanImports: `from "…"` inside a string after a real export keyword is not a re-export', () => {
  // `export const s = "…from 'x'…"` — the old "anything but `;` between the
  // keyword and `from`" clause reached into the string.
  const src = [
    `export const s = "Recover from 'backup'";`,
    `export const t = "More from \"us\"";`,
    `export function f() { return "from './q.ts'"; }`,
    `export { a } from "./a.ts";`,
  ].join("\n");
  assertEquals(
    extractSourceImports(src).map((i) => [i.spec, i.line]),
    [["./a.ts", 4]],
  );
});

Deno.test("scanImports: a multi-line import clause is one import, on the line of its specifier", () => {
  // esbuild elides this when nothing is read from it; the single-line scanner
  // could not see it at all, so a typo'd path in a multi-line import reached
  // nobody.
  const src = [
    `import {`,
    `  a, // from "./not-this.ts"`,
    `  b, /* import c from "./nor-this.ts" */`,
    `} from "./does-not-exist.ts";`,
    `import type {`,
    `  T,`,
    `} from "./types.ts";`,
    `export {`,
    `  x as y,`,
    `} from "./re.ts";`,
  ].join("\n");
  assertEquals(
    extractSourceImports(src).map((i) => [i.spec, i.kind, i.line]),
    [["./does-not-exist.ts", "static", 4], ["./re.ts", "static", 10]],
  );
});

Deno.test("scanImports: a URL import is seen (the `//` in it is not a comment)", () => {
  const src = [
    `import x from "https://esm.sh/x@1";`,
    `import "https://esm.sh/side-effect";`,
    `const m = await import("https://esm.sh/lazy");`,
  ].join("\n");
  assertEquals(
    extractSourceImports(src).map((i) => [i.spec, i.kind]),
    [
      ["https://esm.sh/x@1", "static"],
      ["https://esm.sh/side-effect", "static"],
      ["https://esm.sh/lazy", "dynamic"],
    ],
  );
});

Deno.test("scanImports: minified spacing and every clause shape", () => {
  const src = [
    `import{a}from"./a.ts";import*as ns from'./ns.ts';export*from"./all.ts";`,
    `import d,{e}from"./de.ts";import"./bare.ts";const l=import("./l.ts");`,
    `import types from "./types-is-a-name.ts";`,
  ].join("\n");
  assertEquals(extractImports(src).sort(), [
    "./a.ts",
    "./all.ts",
    "./bare.ts",
    "./de.ts",
    "./l.ts",
    "./ns.ts",
    "./types-is-a-name.ts",
  ]);
});

Deno.test("resolveSpecifier: a specifier with its own scheme is external, never a missing mapping", () => {
  for (
    const spec of [
      "https://esm.sh/x",
      "http://localhost:1/x.js",
      "npm:esbuild@0.24.2",
      "jsr:@std/path@1",
      "data:text/javascript,export default 1",
    ]
  ) {
    const r = resolveSpecifier(spec, "/app/src/x.ts", {}, () => false);
    assertEquals(r.kind, "external", spec);
  }
  // `node:` keeps its own path — the browser's guaranteed break.
  const n = resolveSpecifier("node:fs", "/app/src/x.ts", {}, () => false);
  assertEquals(n.kind, "error");
});

Deno.test("validateGraph: a missing mapping in a module reached ONLY via dynamic import is deferred, not blocking", async () => {
  // A `*.server.ts` chunk re-exporting framework code that imports a bare
  // specifier the BROWSER map does not carry. The server resolves that chunk
  // through deno.json; holding it to the browser map blocked amui.
  const dir = await tempDir("aio-graph-validator-");
  try {
    await Deno.writeTextFile(
      dir + "/App.tsx",
      `import { m } from "./cell.ts";\nexport default function App() { return m; }`,
    );
    await Deno.writeTextFile(
      dir + "/cell.ts",
      `export const m = 1;\nexport async function load() { const { x } = await import("./x.server.ts"); return x; }`,
    );
    await Deno.writeTextFile(
      dir + "/x.server.ts",
      `import { y } from "some-server-package";\nexport const x = y;`,
    );
    const result = await validateGraph(dir + "/App.tsx", {}, mockTranspile);
    assertEquals(result.valid, true, JSON.stringify(result.errors));
    const e = result.errors.find((e) => e.file.endsWith("x.server.ts"));
    assert(e, "still reported, quietly");
    assertEquals(e!.category, "server-only-api");
    assertEquals(e!.deferred, true);
    assertStringIncludes(e!.message, "some-server-package");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("validateGraph: a missing mapping in an EAGER module still blocks", async () => {
  const dir = await tempDir("aio-graph-validator-");
  try {
    await Deno.writeTextFile(
      dir + "/App.tsx",
      `import { y } from "some-missing-package";\nexport default function App() { return y; }`,
    );
    const result = await validateGraph(dir + "/App.tsx", {}, mockTranspile);
    assertEquals(result.valid, false);
    const e = result.errors.find((e) => e.category === "missing-import-map");
    assert(e);
    assert(!e!.deferred);
  } finally {
    await dropTempDir(dir);
  }
});
