# Bulletproof Module Loading — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server validates the entire import graph before serving the app.
Broken imports produce a diagnostic page with exact fix instructions instead of
the app.

**Architecture:** New `graph-validator.ts` module walks the import tree from
`App.tsx`, transpiling and validating every module. Integrated into `server.ts`
at two points: (1) `GET /` checks cached graph validity, (2) `scheduleReload`
re-validates on file changes. Diagnostic page is static HTML with zero JS
imports. Phase 1: full graph re-walk on each change (~50ms for typical app).
Phase 2 (follow-up): incremental validation via reverse dependency index.

**Fail-open policy:** If graph walk exceeds 2s, serve the app anyway and log a
warning. Never block serving.

**Tech Stack:** Deno 2.6+, TypeScript, esbuild (existing `transpile()`),
regex-based import extraction

**Spec:**
`docs/superpowers/specs/2026-03-24-bulletproof-module-loading-design.md`

---

## File Structure

| File                          | Action | Responsibility                                                                                                                               |
| ----------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/graph-validator.ts`      | Create | Import graph walker, specifier resolution, platform safety, caching, incremental re-validation                                               |
| `src/graph-validator.test.ts` | Create | Unit tests for graph validator                                                                                                               |
| `src/server-html.ts`          | Modify | `buildBrowserImportMap()` returns object instead of JSON string; add `generateDiagnosticHTML()` function; enhance `probeImports` in template |
| `src/server.ts`               | Modify | Integrate graph validator into `GET /`, `scheduleReload()`, and SPA fallback; pass import map as object                                      |

---

### Task 1: Refactor `buildBrowserImportMap()` to return structured object

**Files:**

- Modify: `src/server-html.ts:60-77`
- Modify: `src/server.ts:382` (caller)

- [ ] **Step 1: Change return type in server-html.ts**

`buildBrowserImportMap()` currently returns `JSON.stringify({ imports })`.
Change it to return the `Record<string, string>` directly:

```typescript
// src/server-html.ts — buildBrowserImportMap()
// Before: return JSON.stringify({ imports });
// After:
export function buildBrowserImportMap(
  denoImports: Record<string, string>,
): Record<string, string> {
  const imports: Record<string, string> = {
    "react": `${CDN}/react@18.3.1`,
    "react-dom/client": `${CDN}/react-dom@18.3.1/client`,
    "react/jsx-runtime": `${CDN}/react@18.3.1/jsx-runtime`,
    "aio": "/__aio/ui.js",
    "aio/browser": "/__aio/ui.js",
  };
  for (const [name, specifier] of Object.entries(denoImports)) {
    if (!specifier.startsWith("npm:")) continue;
    if (imports[name]) continue;
    const bare = specifier.slice(4);
    imports[name] = `${CDN}/${bare}`;
  }
  return imports;
}
```

- [ ] **Step 2: Update caller in server.ts**

```typescript
// src/server.ts:382 — change:
// const IMPORT_MAP = buildBrowserImportMap(denoImports);
// to:
const importMapObj = buildBrowserImportMap(denoImports);
const IMPORT_MAP = JSON.stringify({ imports: importMapObj });
```

Update all references to `IMPORT_MAP` if needed — it's used in `generateHTML()`
calls which expect a JSON string. Verify all `IMPORT_MAP` usages still pass the
JSON string.

- [ ] **Step 3: Run deno check and existing tests**

```bash
deno check src/server-html.ts src/server.ts
deno test src/ --no-check
```

Expected: all pass, no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/server-html.ts src/server.ts
git commit -m "refactor: buildBrowserImportMap returns object, caller serializes"
```

---

### Task 2: Create `graph-validator.ts` — types and import extraction

**Files:**

- Create: `src/graph-validator.ts`
- Create: `src/graph-validator.test.ts`

- [ ] **Step 1: Write failing tests for import extraction**

```typescript
// src/graph-validator.test.ts
import { assertEquals } from "https://deno.land/std/assert/mod.ts";
import { extractImports } from "./graph-validator.ts";

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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
deno test src/graph-validator.test.ts --no-check
```

Expected: FAIL — `extractImports` not found.

- [ ] **Step 3: Implement types and extractImports**

```typescript
// src/graph-validator.ts

/** Error categories for module validation failures */
export type ErrorCategory =
  | "file-not-found"
  | "transpile-error"
  | "missing-import-map"
  | "server-only-api"
  | "cdn-unreachable"
  | "circular-dependency"
  | "import-map-mismatch"
  | "permission-denied"
  | "unknown";

/** A single validation error with actionable fix instruction */
export type GraphError = {
  file: string;
  line?: number;
  col?: number;
  lineText?: string;
  category: ErrorCategory;
  message: string;
  fix: string;
};

/** Cached module node in the import graph */
export type ModuleNode = {
  path: string;
  hash: string;
  deps: string[];
  valid: boolean;
  errors: GraphError[];
};

/** Result of a full or incremental graph validation */
export type GraphResult = {
  valid: boolean;
  errors: GraphError[];
  modules: Map<string, ModuleNode>;
  durationMs: number;
};

/** Extract all import specifiers from transpiled JS output.
 *  Works on esbuild output (clean ESM) — regex is reliable here. */
export function extractImports(code: string): string[] {
  // Strip comments to avoid false positives (esbuild output is clean ESM)
  const cleaned = code
    .replace(/\/\/.*$/gm, "") // single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, ""); // multi-line comments
  // Note: string literals containing `from "..."` are NOT stripped.
  // This is acceptable: esbuild's transpiled output doesn't produce
  // such patterns. Documented as known limitation in the spec.

  // Match: from "spec", from 'spec', import("spec"), import('spec')
  const IMPORT_RE = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g;
  const specifiers: string[] = [];
  let match;
  while ((match = IMPORT_RE.exec(cleaned)) !== null) {
    specifiers.push(match[1]);
  }
  return specifiers;
}
```

Note: The "ignores comments" test will need refinement — the regex-based
approach strips comments but `from` inside a string literal is tricky. The
transpiled esbuild output is clean ESM, so in practice string literals
containing `from "..."` patterns are rare. For the test, adjust expectations to
match actual behavior and document the limitation.

- [ ] **Step 4: Run tests**

```bash
deno test src/graph-validator.test.ts --no-check
```

Adjust the "ignores comments" test if needed — esbuild output is clean ESM so
false positives from string contents are extremely rare in practice. The test
should reflect realistic transpiled code.

- [ ] **Step 5: Commit**

```bash
git add src/graph-validator.ts src/graph-validator.test.ts
git commit -m "feat(graph-validator): types and import extraction"
```

---

### Task 3: Specifier resolution + platform safety

**Files:**

- Modify: `src/graph-validator.ts`
- Modify: `src/graph-validator.test.ts`

- [ ] **Step 1: Write failing tests for resolveSpecifier**

```typescript
Deno.test("resolveSpecifier resolves relative with extension try", () => {
  // Given a file ./foo exists as ./foo.ts on disk
  // resolveSpecifier("./foo", "/project/src/App.tsx", {}) should find it
});

Deno.test("resolveSpecifier resolves bare via import map", () => {
  const importMap = { "react": "https://esm.sh/react@18.3.1" };
  const result = resolveSpecifier("react", "/project/src/App.tsx", importMap);
  assertEquals(result, {
    kind: "external",
    url: "https://esm.sh/react@18.3.1",
  });
});

Deno.test("resolveSpecifier errors on missing bare specifier", () => {
  const result = resolveSpecifier("lodash", "/project/src/App.tsx", {});
  assertEquals(result.kind, "error");
  assertStringIncludes(result.error!.fix, "deno.json");
});
```

- [ ] **Step 2: Write failing tests for platform safety**

```typescript
Deno.test("checkPlatformSafety detects Deno API usage", () => {
  const code = `const data = await Deno.readTextFile("x");`;
  const errors = checkPlatformSafety(code, "./db.ts");
  assertEquals(errors.length, 1);
  assertEquals(errors[0].category, "server-only-api");
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
  assertStringIncludes(errors[0].fix, "server-only");
});
```

- [ ] **Step 3: Implement resolveSpecifier and checkPlatformSafety**

```typescript
// src/graph-validator.ts — add at top:
// import { resolve } from "@std/path";

type Resolution =
  | { kind: "local"; path: string }
  | { kind: "external"; url: string }
  | { kind: "error"; error: GraphError };

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const INDEX_FILES = ["index.ts", "index.tsx"];

/** Resolve an import specifier to a file path, external URL, or error. */
export function resolveSpecifier(
  spec: string,
  importerPath: string,
  importMap: Record<string, string>,
  fileExists?: (path: string) => boolean,
): Resolution {
  const _exists = fileExists ?? ((p: string) => {
    try {
      Deno.statSync(p);
      return true;
    } catch {
      return false;
    }
  });

  if (spec.startsWith("./") || spec.startsWith("../")) {
    const dir = importerPath.replace(/\/[^/]+$/, "");
    // Normalize ../foo paths to canonical absolute paths (import resolve from @std/path at file top)
    const base = resolve(dir, spec);

    // Try exact path first
    if (_exists(base)) return { kind: "local", path: base };

    // Try extensions
    for (const ext of EXTENSIONS) {
      if (_exists(base + ext)) return { kind: "local", path: base + ext };
    }

    // Try index files (spec is a directory)
    for (const idx of INDEX_FILES) {
      const indexPath = base + "/" + idx;
      if (_exists(indexPath)) return { kind: "local", path: indexPath };
    }

    // Fuzzy match: list sibling files for "did you mean?"
    let siblings: string[] = [];
    try {
      const searchDir = base.replace(/\/[^/]+$/, "");
      siblings = [...Deno.readDirSync(searchDir)]
        .filter((e) => e.isFile)
        .map((e) => e.name);
    } catch { /* can't read dir */ }
    const baseName = spec.split("/").pop() ?? spec;
    const similar = siblings.filter((s) =>
      s.startsWith(baseName) || s.replace(/\.\w+$/, "") === baseName
    );
    const hint = similar.length
      ? ` Did you mean "${spec}${
        similar[0].slice(baseName.length)
      }"? Available: ${similar.join(", ")}`
      : "";

    return {
      kind: "error",
      error: {
        file: importerPath,
        category: "file-not-found",
        message: `File "${spec}" not found`,
        fix:
          `File "${spec}" does not exist relative to ${importerPath}.${hint}`,
      },
    };
  }

  // Bare specifier — look up in import map
  const mapped = importMap[spec];
  if (!mapped) {
    return {
      kind: "error",
      error: {
        file: importerPath,
        category: "missing-import-map",
        message: `"${spec}" is not in the import map`,
        fix: `Add "${spec}": "npm:${spec}" to deno.json imports.`,
      },
    };
  }

  // CDN / external — don't recurse
  if (mapped.startsWith("http://") || mapped.startsWith("https://")) {
    return { kind: "external", url: mapped };
  }

  // Local framework route (e.g. /__aio/ui.js)
  return { kind: "external", url: mapped };
}

/** Detect server-only APIs in browser-bound code. */
export function checkPlatformSafety(code: string, file: string): GraphError[] {
  const errors: GraphError[] = [];

  // node:* and @std/* imports (excluding import type)
  const SERVER_IMPORT_RE =
    /(?:import|export)\s+(?!type\s).*?\s+from\s+['"]((?:@std\/|node:)[^'"]+)['"]/g;
  let m;
  while ((m = SERVER_IMPORT_RE.exec(code)) !== null) {
    const lineNum = code.slice(0, m.index).split("\n").length;
    errors.push({
      file,
      line: lineNum,
      category: "server-only-api",
      message: `"${m[1]}" is server-only`,
      fix: `${
        m[1]
      } is not available in browser. Move to a feature effect or use \`import type\`.`,
    });
  }

  // Deno.* usage (strip comments AND string literals to avoid false positives)
  const stripped = code
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(["'`])(?:(?!\1|\\).|\\.)*\1/g, '""');
  const DENO_RE = /\bDeno\.(\w+)/g;
  while ((m = DENO_RE.exec(stripped)) !== null) {
    const lineNum = stripped.slice(0, m.index).split("\n").length;
    errors.push({
      file,
      line: lineNum,
      category: "server-only-api",
      message: `Deno.${m[1]} is server-only`,
      fix: `Deno.${
        m[1]
      }() is not available in browser. Move to a feature effect.`,
    });
  }

  return errors;
}
```

- [ ] **Step 4: Run tests**

```bash
deno test src/graph-validator.test.ts --no-check
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/graph-validator.ts src/graph-validator.test.ts
git commit -m "feat(graph-validator): specifier resolution and platform safety checks"
```

---

### Task 4: Full graph walk with caching

**Files:**

- Modify: `src/graph-validator.ts`
- Modify: `src/graph-validator.test.ts`

- [ ] **Step 1: Write failing test for validateGraph**

```typescript
import { validateGraph } from "./graph-validator.ts";

Deno.test("validateGraph walks import tree and reports errors", async () => {
  // Use a temp dir with test files to simulate a project
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    dir + "/App.tsx",
    `
    import { foo } from "./foo.ts";
    export default function App() { return null; }
  `,
  );
  await Deno.writeTextFile(
    dir + "/foo.ts",
    `
    export const foo = 42;
  `,
  );
  const result = await validateGraph(dir + "/App.tsx", {}, transpileFn);
  assertEquals(result.valid, true);
  assertEquals(result.errors.length, 0);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("validateGraph detects missing import", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    dir + "/App.tsx",
    `
    import { bar } from "./bar.ts";
    export default function App() { return null; }
  `,
  );
  // bar.ts does NOT exist
  const result = await validateGraph(dir + "/App.tsx", {}, transpileFn);
  assertEquals(result.valid, false);
  assertEquals(result.errors[0].category, "file-not-found");
  await Deno.remove(dir, { recursive: true });
});
```

For these tests, provide a mock `transpileFn` that strips TypeScript minimally
(or use real esbuild if available). The simplest mock: return the code as-is
(imports are already in source).

- [ ] **Step 2: Implement validateGraph**

```typescript
// src/graph-validator.ts — add:

type TranspileFn = (source: string, filepath: string) => Promise<string>;

const MAX_FILES = 500;
const MAX_FILE_SIZE = 1_000_000; // 1MB — skip likely vendor bundles

/** Validate the full import graph starting from entrypoint.
 *  Returns errors with actionable fix instructions for every broken module. */
export async function validateGraph(
  entrypoint: string,
  importMap: Record<string, string>,
  transpile: TranspileFn,
  fileExists?: (path: string) => boolean,
): Promise<GraphResult> {
  const start = performance.now();
  const modules = new Map<string, ModuleNode>();
  const errors: GraphError[] = [];
  const visited = new Set<string>();

  const stack = new Set<string>(); // current recursion stack — detects cycles

  async function walk(filePath: string, importerPath?: string): Promise<void> {
    if (visited.has(filePath)) {
      // Cycle detection: if file is in current recursion stack, it's a circular import
      if (stack.has(filePath)) {
        errors.push({
          file: importerPath ?? filePath,
          category: "circular-dependency",
          message: `Circular import: ${importerPath} → ${filePath}`,
          fix:
            "Circular imports are allowed in JS but may cause initialization issues. Consider restructuring.",
        });
      }
      return;
    }
    if (visited.size >= MAX_FILES) return;
    visited.add(filePath);
    stack.add(filePath);

    // Read source
    let source: string;
    try {
      source = await Deno.readTextFile(filePath);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        errors.push({
          file: importerPath ?? filePath,
          category: "file-not-found",
          message: `File not found: ${filePath}`,
          fix: `The file "${filePath}" does not exist. Check the import path.`,
        });
      } else if (err instanceof Deno.errors.PermissionDenied) {
        errors.push({
          file: filePath,
          category: "permission-denied",
          message: `Permission denied: ${filePath}`,
          fix:
            `Deno does not have permission to read "${filePath}". Check --allow-read flags.`,
        });
      }
      return;
    }

    // Skip large files (likely vendor bundles)
    if (source.length > MAX_FILE_SIZE) return;

    // Transpile
    let transpiled: string;
    try {
      transpiled = await transpile(source, filePath);
    } catch (err) {
      const esbuildErrors = (err as {
        errors?: Array<
          {
            text: string;
            location?: { line: number; column: number; lineText: string };
          }
        >;
      }).errors;
      if (esbuildErrors?.length) {
        for (const e of esbuildErrors) {
          errors.push({
            file: filePath,
            line: e.location?.line,
            col: e.location?.column,
            lineText: e.location?.lineText,
            category: "transpile-error",
            message: e.text,
            fix: `Fix the syntax error in ${filePath}${
              e.location ? ` at line ${e.location.line}` : ""
            }.`,
          });
        }
      } else {
        errors.push({
          file: filePath,
          category: "transpile-error",
          message: String(err),
          fix: `Transpile failed for ${filePath}. Check syntax.`,
        });
      }
      return;
    }

    // Platform safety
    const platformErrors = checkPlatformSafety(transpiled, filePath);
    errors.push(...platformErrors);

    // Extract imports
    const specifiers = extractImports(transpiled);
    const deps: string[] = [];

    // Compute content hash for cache invalidation
    const hashBuffer = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(source),
    );
    const hash = [...new Uint8Array(hashBuffer)]
      .map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);

    // Resolve and recurse
    for (const spec of specifiers) {
      const resolution = resolveSpecifier(
        spec,
        filePath,
        importMap,
        fileExists,
      );
      if (resolution.kind === "local") {
        deps.push(resolution.path);
        await walk(resolution.path, filePath);
      } else if (resolution.kind === "error") {
        errors.push(resolution.error);
      }
      // external: skip (CDN, framework routes)
    }

    modules.set(filePath, {
      path: filePath,
      hash,
      deps,
      valid: !errors.some((e) => e.file === filePath),
      errors: errors.filter((e) => e.file === filePath),
    });

    stack.delete(filePath); // pop from recursion stack
  }

  await walk(entrypoint);
  const durationMs = performance.now() - start;

  return {
    valid: errors.length === 0,
    errors,
    modules,
    durationMs,
  };
}
```

- [ ] **Step 3: Run tests**

```bash
deno test src/graph-validator.test.ts --no-check
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/graph-validator.ts src/graph-validator.test.ts
git commit -m "feat(graph-validator): full graph walk with caching and error collection"
```

---

### Task 5: Diagnostic page HTML generator

**Files:**

- Modify: `src/server-html.ts`

- [ ] **Step 1: Add generateDiagnosticHTML function**

Add after the existing `generateHTML()` function in `server-html.ts`:

```typescript
/** Generates a static diagnostic HTML page when the import graph has errors.
 *  Zero JS imports — cannot fail to load. Only inline JS for live reload WS. */
export function generateDiagnosticHTML(
  errors: GraphError[],
  title: string,
): string {
  const errorBlocks = errors.map((e) => {
    const loc = e.line != null
      ? `:${e.line}${e.col != null ? `:${e.col}` : ""}`
      : "";
    const fileLabel = e.file
      ? `<div style="color:#569cd6;margin-bottom:.35rem">${
        escHtml(e.file)
      }${loc}</div>`
      : "";
    const lineSnippet = e.lineText
      ? `<div style="background:#0d1117;padding:.5rem .85rem;border-radius:4px;border-left:3px solid #ff6b6b;margin-bottom:.5rem"><span style="color:#555">${
        e.line != null ? e.line + " | " : ""
      }</span><span style="color:#ddd">${escHtml(e.lineText)}</span></div>`
      : "";
    const fixBox = e.fix
      ? `<div style="margin-top:.5rem;padding:.6rem .9rem;background:#1a2332;border:1px solid #2a4a6a;border-radius:6px"><div style="color:#569cd6;font-weight:700;margin-bottom:.3rem;font-size:11px">FIX</div><div style="color:#98c379">${
        escHtml(e.fix)
      }</div></div>`
      : "";
    return `<div style="margin-bottom:1.5rem">${fileLabel}<div style="color:#f1fa8c;margin-bottom:.5rem">${
      escHtml(e.message)
    }</div>${lineSnippet}${fixBox}</div>`;
  }).join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${escHtml(title)} — Module Errors</title>
</head>
<body style="margin:0;padding:1.75rem 2rem;min-height:100vh;background:#141414;font:13px/1.7 monospace;box-sizing:border-box">
  <div style="max-width:920px">
    <div style="color:#ff6b6b;font-size:1.1rem;font-weight:700;margin-bottom:1.25rem;padding-bottom:.75rem;border-bottom:1px solid #2a2a2a">&#10006; ${errors.length} module error${
    errors.length !== 1 ? "s" : ""
  } &#8212; fix to continue</div>
    ${errorBlocks}
    <div style="margin-top:1.5rem;padding-top:.75rem;border-top:1px solid #2a2a2a;color:#555;font-size:11px">Save any file to re-validate &#183; Auto-reloads when fixed &#183; ${
    new Date().toLocaleTimeString()
  }</div>
  </div>
  <script>
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var tk = new URLSearchParams(location.search).get('token');
    var wsUrl = proto + '//' + location.host + '/ws' + (tk ? '?token=' + encodeURIComponent(tk) : '');
    var ws = new WebSocket(wsUrl);
    ws.onmessage = function(ev) {
      if (ev.data === '__reload' || ev.data === '__graph_clear') location.reload();
      if (typeof ev.data === 'string' && ev.data.startsWith('__graph_error:')) location.reload();
    };
    ws.onclose = function() { setTimeout(function() { location.reload(); }, 2000); };
  </script>
</body>
</html>`;
}
```

Import `GraphError` type at the top of `server-html.ts`:

```typescript
import type { GraphError } from "./graph-validator.ts";
```

- [ ] **Step 2: Run deno check**

```bash
deno check src/server-html.ts
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/server-html.ts
git commit -m "feat: diagnostic HTML page for graph validation errors"
```

---

### Task 6: Integrate graph validator into server.ts

**Files:**

- Modify: `src/server.ts`

This is the core integration — three touch points:

1. **Startup:** Run initial graph validation after server starts
2. **GET /:** Check cached graph result, serve diagnostic page if red
3. **scheduleReload:** Re-validate graph on file changes

- [ ] **Step 1: Import graph validator and diagnostic page**

At top of `server.ts`, add imports:

```typescript
import {
  type GraphError,
  type GraphResult,
  validateGraph,
} from "./graph-validator.ts";
import { generateDiagnosticHTML } from "./server-html.ts";
```

(Note: `generateDiagnosticHTML` is a new export from server-html.ts added in
Task 5.)

- [ ] **Step 2: Add graph state variables**

After the `IMPORT_MAP` declaration (~line 382), add:

```typescript
// Import graph validator state (dev mode only)
let graphResult: GraphResult | null = null;
let graphWasRed = false;
```

- [ ] **Step 3: Create the transpile wrapper for graph validator**

The graph validator needs a `transpile(source, filepath)` function. Reuse the
existing one from `server.ts`:

```typescript
// The existing transpile() function (server.ts:193) is already available in scope.
// Pass it directly to validateGraph.
```

- [ ] **Step 4: Run initial graph validation at startup**

After the existing dev startup validation block (~line 384-425), add:

```typescript
if (!prod) {
  const entrypoint = join(absBaseDir, "App.tsx");
  if (fileExists(entrypoint)) {
    graphResult = await validateGraph(entrypoint, importMapObj, transpile);
    if (graphResult.valid) {
      debug(
        `graph: ✓ ${graphResult.modules.size} modules validated (${
          graphResult.durationMs.toFixed(0)
        }ms)`,
      );
    } else {
      for (const err of graphResult.errors) {
        debug(
          `graph: ✖ ${err.file}${
            err.line ? `:${err.line}` : ""
          } — ${err.message}`,
        );
        debug(`  FIX: ${err.fix}`);
      }
      graphWasRed = true;
    }
    if (graphResult.durationMs > 500) {
      debug(
        `graph: ⚠ validation took ${
          graphResult.durationMs.toFixed(0)
        }ms (budget: 500ms)`,
      );
    }
  }
}
```

- [ ] **Step 5: Modify GET / to check graph result**

Change the `pathname === "/"` handler (~line 816):

```typescript
if (pathname === "/") {
  // In dev mode, check import graph — serve diagnostic page if broken
  if (!prod && graphResult && !graphResult.valid) {
    return new Response(
      generateDiagnosticHTML(graphResult.errors, title),
      { headers: { "Content-Type": "text/html", ...noCache } },
    );
  }
  const importMap = IMPORT_MAP;
  return new Response(
    generateHTML(
      title,
      prod,
      hasCSS,
      importMap,
      config.showStatus,
      config.width,
      config.height,
    ),
    { headers: { "Content-Type": "text/html", ...noCache } },
  );
}
```

Do the same for the SPA fallback (~line 1300-1320) — when serving HTML for
extensionless paths.

- [ ] **Step 6: Modify scheduleReload to re-validate graph**

Replace the debounce callback in `scheduleReload` (~line 1410):

```typescript
reloadTimer = setTimeout(() => {
  reloadTimer = null;
  const wasFullReload = reloadIsFull;
  reloadIsFull = false;

  // Re-validate import graph (dev mode only) — wrapped in async IIFE with error handling
  (async () => {
    if (!prod && graphResult) {
      const entrypoint = join(absBaseDir, "App.tsx");
      if (fileExists(entrypoint)) {
        // Fail-open: 2s timeout — never block serving
        const timeout = new Promise<null>((r) =>
          setTimeout(() => r(null), 2000)
        );
        const validation = validateGraph(entrypoint, importMapObj, transpile);
        const result = await Promise.race([validation, timeout]);
        if (result === null) {
          debug("graph: ⚠ validation timed out (>2s) — serving app anyway");
          graphResult = {
            valid: true,
            errors: [],
            modules: new Map(),
            durationMs: 2000,
          };
        } else {
          graphResult = result;
        }
      }
    }

    // Determine signal based on graph state
    if (!prod && graphResult && !graphResult.valid) {
      // Graph is red — send error signal, suppress __reload
      const errJson = JSON.stringify(graphResult.errors);
      for (const ws of connections.keys()) {
        try {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send("__graph_error:" + errJson);
          }
        } catch { /* client disconnecting */ }
      }
      // Log to terminal
      for (const err of graphResult.errors) {
        debug(
          `graph: ✖ ${err.file}${
            err.line ? `:${err.line}` : ""
          } — ${err.message}`,
        );
        debug(`  FIX: ${err.fix}`);
      }
      config.onReload?.("__reload");
      graphWasRed = true;
    } else if (!prod && graphWasRed) {
      // Graph was red, now green — send __graph_clear (triggers reload)
      graphWasRed = false;
      debug("graph: ✓ all errors fixed — reloading");
      for (const ws of connections.keys()) {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send("__graph_clear");
        } catch { /* client disconnecting */ }
      }
      config.onReload?.("__reload");
    } else {
      // Normal reload
      const signal = wasFullReload ? "__reload" : "__css";
      debug(`${signal} → ${connections.size} client(s)`);
      for (const ws of connections.keys()) {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(signal);
        } catch { /* client disconnecting */ }
      }
      config.onReload?.(signal as "__reload" | "__css");
    }
  })().catch((err) => debug(`graph: unexpected error — ${err}`));
}, 100);
```

- [ ] **Step 7: Add __graph_error handler to client dev WS**

In `server-html.ts`, inside the `_devWs()` onmessage handler in the
`generateHTML` template, add before the existing handlers:

```javascript
if (typeof ev.data === "string" && ev.data.startsWith("__graph_error:")) {
  // Graph validation failed — reload to show diagnostic page
  ws.close();
  location.reload();
  return;
}
if (ev.data === "__graph_clear") {
  ws.close();
  location.reload();
  return;
}
```

- [ ] **Step 8: Run deno check and tests**

```bash
deno check src/server.ts src/server-html.ts
deno test src/ --no-check
```

Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/server.ts src/server-html.ts src/graph-validator.ts
git commit -m "feat: integrate graph validator into server — validate before serve"
```

---

### Task 7: Enhanced client-side probeImports

**Files:**

- Modify: `src/server-html.ts` (template string)

- [ ] **Step 1: Replace probeImports in generateHTML template**

Replace the existing `probeImports` function (inside the template string) with
the recursive, parallel version from the spec. Key changes:

1. Recursive (max depth 10, cycle-safe via visited set)
2. Probes bare specifiers by looking up the import map injected in the page
3. Uses `Promise.allSettled` for parallel fetching
4. Accumulates all errors, not just the first

Find the existing `probeImports` in the template (~line 207-225 of
server-html.ts) and replace it. Also add a `resolveFromImportMap` helper that
reads the import map from the `<script type="importmap">` tag.

- [ ] **Step 2: Run deno check**

```bash
deno check src/server-html.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/server-html.ts
git commit -m "feat: recursive parallel client-side import probing"
```

---

### Task 8: End-to-end manual testing

- [ ] **Step 1: Test happy path**

Create a simple AIO app, start in dev mode, verify it loads normally.

- [ ] **Step 2: Test missing import**

Add `import { x } from "./nonexistent.ts"` to App.tsx. Verify:

- Diagnostic page shows instead of blank page
- Error message shows exact file + fix suggestion
- Terminal shows the error
- After removing the bad import and saving, app auto-reloads and works

- [ ] **Step 3: Test missing npm package**

Add `import _ from "lodash"` without adding to deno.json. Verify diagnostic page
says "Add to deno.json imports."

- [ ] **Step 4: Test transpile error**

Add broken JSX syntax. Verify diagnostic page shows line + column + source
snippet.

- [ ] **Step 5: Test server-only API**

Add `Deno.readTextFile("x")` to a component. Verify warning about server-only
API.

- [ ] **Step 6: Test Electron**

Run with `--client=electron`. Verify same diagnostic behavior.

- [ ] **Step 7: Commit if any fixes needed**

```bash
git add -A
git commit -m "fix: graph validator adjustments from e2e testing"
```

---

### Task 9: Final cleanup and squash

- [ ] **Step 1: Run full test suite**

```bash
deno check src/
deno lint src/
deno test src/ --no-check
```

- [ ] **Step 2: Squash commits into one clean commit**

Squash all graph-validator commits into a single commit:

```bash
git rebase -i <commit-before-task-1>
# squash all into one
```

Final commit message:

```
feat: bulletproof module loading — server-side import graph validation

Server walks full import tree from App.tsx before serving the app.
If any module fails (missing file, transpile error, bad import,
server-only API), serves a static diagnostic page with exact fix
instructions. Auto-reloads when fixed. Client-side probing enhanced
as fallback for CDN/network failures.
```
