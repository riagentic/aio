# Bulletproof Module Loading — Design Spec

**Date:** 2026-03-24 **Status:** Draft **Goal:** Module loading either works out
of the box, or tells the developer exactly what's broken and how to fix it. No
vague errors. No guessing.

## Problem

The current dev-mode module loading pipeline is reactive: the browser attempts
`import()`, fails with generic errors like
`"Failed to fetch dynamically imported module"`, and AIO plays catch-up with
regex-based probing. This approach has fundamental gaps:

1. **Shallow probing** — `probeImports` only checks one level of relative
   imports. Deep transitive failures are invisible.
2. **Bare specifiers ignored** — missing import map entries aren't probed.
3. **Server is blind** — the server happily serves a broken app and lets the
   browser discover errors at runtime.
4. **Error messages are generic** — "check DevTools Network tab" is not an
   actionable fix.
5. **Electron amplifies the pain** — DevTools may not be open, error overlay may
   be hidden behind app chrome, no Electron-specific diagnostics.

## Success Criteria

Binary outcome for every module load attempt:

- **Green:** App loads and renders. Zero errors.
- **Red:** Diagnostic page replaces the app, showing for every broken module:
  file path, line number, error category, and exact fix instruction.

No middle ground. No "check DevTools."

## Architecture: Defense in Depth (Approach C)

Two layers, same error format:

```
Layer 1: Server-Side Graph Validator (catches dev mistakes before client loads)
    ↓ all green?
Layer 2: Client-Side Enhanced Fallback (catches runtime-only failures)
```

---

## Layer 1: Server-Side Import Graph Validator

### Overview

Before serving the app HTML, the server walks the full import tree starting from
`App.tsx`. If any module fails validation, the server serves a diagnostic page
instead of the app.

### Graph Walk Algorithm

```
validateGraph(entrypoint: string): GraphResult

1. Read entrypoint source from disk
2. Transpile via esbuild (reuse existing transpile() in server.ts)
3. Extract all import specifiers from transpiled output:
   - Relative: ./foo, ../bar  → resolve to absolute file path
   - Bare: "lodash", "react" → resolve against import map
   - Deep bare: "lodash/fp"  → resolve against import map
4. For each specifier:
   a. EXISTS? — file on disk (relative) or valid import map entry (bare)
   b. TRANSPILES? — esbuild produces valid JS
   c. PLATFORM-SAFE? — no Deno.*, no node:*, no @std/* in browser-bound code
   d. RECURSE — walk this module's imports (cycle-safe via visited set)
5. Return { valid: boolean, modules: Map<path, ModuleInfo>, errors: GraphError[] }
```

### Import Extraction

Parse transpiled JS output (not TS source — esbuild already resolved JSX/TS):

```typescript
// Static imports
from "specifier"
from 'specifier'

// Dynamic imports
import("specifier")
import('specifier')

// Re-exports
export { x } from "specifier"
export * from "specifier"
```

Use a regex-based scanner on transpiled output (not an AST parser — keep it fast
and dependency-free). The transpiled output is clean ESM, so regex is reliable
here.

```typescript
const IMPORT_RE = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g;
```

### Import Map Access

`buildBrowserImportMap()` in `server-html.ts:60-77` currently returns a JSON
string. The graph validator needs the structured `Record<string, string>` before
serialization. Refactor: `buildBrowserImportMap()` returns the structured
object, caller serializes with `JSON.stringify({ imports })` when needed for
HTML injection. The graph validator receives the same structured object.

```typescript
// Before (server-html.ts):
export function buildBrowserImportMap(denoImports): string { ... return JSON.stringify({ imports }) }

// After:
export function buildBrowserImportMap(denoImports): Record<string, string> { ... return imports }
// Caller: const importMapJson = JSON.stringify({ imports: buildBrowserImportMap(denoImports) })
```

### Specifier Resolution

```typescript
resolveSpecifier(spec: string, importerPath: string, importMap: Record<string, string>): Resolution

- Relative (starts with ./ or ../):
    → resolve against importer's directory
    → try extensions: .ts, .tsx, .js, .jsx (in order)
    → try index: spec/index.ts, spec/index.tsx
    → if not found: error "File not found. Did you mean X?" (fuzzy match)

- Bare (everything else):
    → look up in importMap (the structured Record, not JSON string)
    → if not found: error 'Add "X": "npm:X" to deno.json imports'
    → if found but points to CDN (esm.sh/*): mark as external (don't recurse into CDN)
    → if found but points to local (/__aio/*): validate locally
```

### Platform Safety Check

Detect server-only APIs used in browser-bound code. Reuse the existing pattern
from `server.ts:386` which already excludes `import type` statements:

```typescript
// For import-based detection (node:*, @std/*) — reuse existing server.ts pattern:
const SERVER_IMPORT_RE =
  /(?:import|export)\s+(?!type\s).*?\s+from\s+['"]((?:@std\/|node:)[^'"]+)['"]/g;

// For Deno.* API usage — scan transpiled output but skip comments and strings:
// Strip single-line comments and string literals before scanning to avoid false positives.
function stripCommentsAndStrings(code: string): string {
  return code
    .replace(/\/\/.*$/gm, "") // single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, "") // multi-line comments
    .replace(/(["'`])(?:(?!\1|\\).|\\.)*\1/g, '""'); // string literals → empty
}
const DENO_API_RE = /\bDeno\.\w+/;

const SERVER_ONLY = [
  {
    pattern: DENO_API_RE,
    fix: "Deno.* APIs are server-only. Move to an async effect.",
    preprocess: true,
  },
  {
    pattern: SERVER_IMPORT_RE,
    fix:
      "node:*/\@std/* modules are server-only. Move to an async effect or use import type.",
  },
];
```

### Graph Cache

```typescript
type ModuleNode = {
  path: string; // absolute file path
  hash: string; // content hash (for invalidation)
  deps: string[]; // resolved dependency paths
  valid: boolean; // transpiles + all checks pass
  errors: GraphError[]; // any validation errors
  transpiled: string; // cached transpiled JS
};

// In-memory graph: Map<absolutePath, ModuleNode>
// On file change (from existing fsWatcher):
//   1. Invalidate changed file's node
//   2. Invalidate all reverse dependents (walk upward)
//   3. Re-validate dirty nodes only
```

Reverse dependency index built during graph walk:
`Map<path, Set<dependentPath>>` — enables O(1) lookup of "what depends on this
file."

**File deletion handling:** When the file watcher reports a `remove` event:

1. Remove the deleted file's node from the graph
2. Remove it from all reverse dependency sets
3. Mark all its dependents as having a `file-not-found` error for that import
4. Trigger re-validation of affected dependents

### Timing Budget

- Full graph walk (cold): <500ms for typical app (10-50 modules). esbuild
  transpiles ~1ms/file.
- Incremental re-validation (file change): <50ms — only dirty subtree.
- If graph walk exceeds 500ms: emit diagnostic warning with timing breakdown.
- Cache warming bonus: all transpiled JS is cached, so subsequent browser
  fetches are instant.

### Integration Point: `scheduleReload()` (server.ts:1398)

Current flow:

```
file change → invalidate transpile cache → debounce 100ms → send __reload
```

New flow:

```
file change → invalidate transpile cache + graph node → debounce 100ms
  → re-validate graph (incremental)
  → if green: send __reload (as today)
  → if red: send __graph_error:{json} (new signal — client updates overlay without reload flicker)
```

### Integration Point: HTML serving

Current flow:

```
GET / → always serve app HTML → browser discovers errors at runtime
```

New flow:

```
GET / → check cached graph result (no re-walk — graph is maintained incrementally via file watcher)
  → if green: serve app HTML (as today)
  → if red: serve diagnostic HTML (server-rendered error page)
```

The graph is validated once at startup and incrementally maintained. `GET /`
never triggers a graph walk — it reads the cached validity flag.

The diagnostic page is server-rendered HTML (not JS) — no import map, no
modules, no chance of the diagnostic page itself failing to load.

---

## Layer 2: Client-Side Enhanced Fallback

Handles failures the server can't predict: CDN outages, network timing, CSP,
Electron-specific issues.

### Enhanced `probeImports` (replaces current implementation)

Changes from current (`server-html.ts:177-196`):

1. **Recursive** — follows imports N levels deep (max depth: 10, cycle-safe)
2. **Bare specifiers** — probes import map entries via fetch (catches CDN
   failures)
3. **Parallel fetches** — use `Promise.allSettled` instead of sequential loop
4. **Error accumulation** — collects all broken modules, not just first

```typescript
async function probeImports(
  parentSrc,
  parentUrl,
  depth = 0,
  visited = new Set(),
) {
  if (depth > 10 || visited.has(parentUrl)) return [];
  visited.add(parentUrl);

  const IMPORT_RE = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g;
  const specifiers = [...parentSrc.matchAll(IMPORT_RE)].map((m) => m[1]);
  const broken = [];

  const results = await Promise.allSettled(
    specifiers.map(async (spec) => {
      // Resolve: relative → URL, bare → import map lookup
      const resolved = spec.startsWith(".")
        ? new URL(spec, parentUrl).href
        : resolveFromImportMap(spec); // new: look up in import map
      if (!resolved) {
        return {
          spec,
          reason: `"${spec}" not in import map. Add to deno.json imports.`,
        };
      }

      const r = await fetch(resolved);
      if (!r.ok) return { spec, status: r.status, reason: `HTTP ${r.status}` };

      const body = await r.text();
      if (body.trimStart().startsWith("throw new Error(")) {
        const msg = extractErrorMessage(body);
        return { spec, reason: msg };
      }

      // Recurse into this module's imports
      const subBroken = await probeImports(body, resolved, depth + 1, visited);
      return subBroken.length ? subBroken : null;
    }),
  );

  // Flatten and collect failures
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      broken.push(...(Array.isArray(r.value) ? r.value : [r.value]));
    } else if (r.status === "rejected") {
      broken.push({ spec: "?", reason: r.reason?.message || "fetch failed" });
    }
  }
  return broken;
}
```

### Electron-Specific Diagnostics

When `navigator.userAgent` contains "Electron" or
`window.process?.versions?.electron` exists:

```typescript
const ELECTRON_CHECKS = [
  {
    test: () => !window.__aioIpcBridge,
    label: "IPC Bridge Missing",
    fix:
      "The Electron preload script didn't expose the IPC bridge. Check that preload.ts calls contextBridge.exposeInMainWorld('__aioIpcBridge', ...).",
  },
  {
    test: () => {
      const csp = document.querySelector(
        'meta[http-equiv="Content-Security-Policy"]',
      );
      return csp && !csp.content.includes("connect-src");
    },
    label: "CSP Blocking Connections",
    fix:
      "Content-Security-Policy is blocking WebSocket/fetch. Add 'connect-src ws://localhost:* http://localhost:*' to CSP.",
  },
];
```

### `__graph_error` Signal Handler

New WS message type for live error updates without page reload:

```typescript
// In _devWs() onmessage handler:
if (typeof ev.data === "string" && ev.data.startsWith("__graph_error:")) {
  const errors = JSON.parse(ev.data.slice("__graph_error:".length));
  renderDiagnosticOverlay(errors); // replace app content with error page
  return;
}
if (ev.data === "__graph_clear") {
  // Graph is green again — reload to get the working app
  location.reload();
  return;
}
```

---

## Unified Error Format

Both layers produce the same error shape:

```typescript
type GraphError = {
  file: string; // relative path from project root (e.g., "./components/Chart.tsx")
  line?: number; // line number (if available from esbuild)
  col?: number; // column number
  lineText?: string; // source line for display
  category: ErrorCategory;
  message: string; // human-readable description
  fix: string; // exact actionable instruction
};

type ErrorCategory =
  | "file-not-found" // import points to nonexistent file
  | "transpile-error" // esbuild failed (syntax, JSX, etc.)
  | "missing-import-map" // bare specifier not in deno.json
  | "server-only-api" // Deno.*, node:*, @std/* in browser code
  | "cdn-unreachable" // esm.sh fetch failed (client-side only)
  | "circular-dependency" // cycle detected (warning, not blocking)
  | "import-map-mismatch" // import map entry exists but CDN returns unexpected result
  | "permission-denied" // Deno permission system blocked file read
  | "electron-env" // Electron-specific issue (CSP, IPC, preload)
  | "unknown"; // fallback — include raw error
```

### Fix Messages (Examples)

| Category             | Fix                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `file-not-found`     | `File "./utils" not found. Did you mean "./utils.ts"? Available files: utils.ts, utils.tsx`                  |
| `transpile-error`    | `Syntax error in ./Chart.tsx at line 12: Unexpected token. The JSX tag on line 12 is not closed.`            |
| `missing-import-map` | `"lodash" is not in your import map. Add to deno.json: "lodash": "npm:lodash@4"`                             |
| `server-only-api`    | `Deno.readTextFile() on line 8 of ./DB.tsx is server-only. Move to a feature effect or use \`import type\`.` |
| `cdn-unreachable`    | `esm.sh is unreachable (HTTP 503). Check your internet connection. Retry in a few seconds.`                  |
| `electron-env`       | `IPC bridge not found. Check that preload.ts exposes __aioIpcBridge via contextBridge.`                      |

### Diagnostic Page Rendering (Server-Side)

When graph is red, the server returns static HTML (no JS imports, no import map
— cannot fail):

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <title>AIO — Module Errors</title>
  </head>
  <body
    style="margin: 0; padding: 1.75rem 2rem; min-height: 100vh; background: #141414; font: 13px/1.7 monospace"
  >
    <div style="max-width: 920px">
      <div
        style="color: #ff6b6b; font-size: 1.1rem; font-weight: 700; margin-bottom: 1.25rem; padding-bottom: 0.75rem; border-bottom: 1px solid #2a2a2a"
      >
        ✖ {errorCount} module error(s) — fix to continue
      </div>
      <!-- For each error: file, line, source snippet, fix box -->
      {renderedErrors}
      <div style="margin-top: 1.5rem; color: #555; font-size: 11px">
        Save any file to re-validate · Auto-reloads when fixed
      </div>
    </div>
    <!-- Minimal WS listener for live re-validation (no imports needed) -->
    <script>
      const ws = new WebSocket(wsUrl);
      ws.onmessage = (ev) => {
        if (ev.data === "__reload" || ev.data === "__graph_clear") {
          location.reload();
        }
        if (ev.data.startsWith("__graph_error:")) {
          // Re-render with updated errors (inline, no module import)
          document.body.innerHTML = formatErrors(
            JSON.parse(ev.data.slice(14)),
          );
        }
      };
      ws.onclose = () => setTimeout(() => location.reload(), 2000);
    </script>
  </body>
</html>
```

Key property: **this page has zero JS imports.** It cannot fail to load. It only
uses inline JS for the reload WebSocket listener.

---

## Live Reload Integration

### Current Flow (server.ts:1398-1421)

```
file change → delete transpileCache entry → debounce 100ms → send __reload to all WS clients
```

### New Flow

```
file change
  → delete transpileCache entry
  → invalidate graph node + reverse dependents
  → debounce 100ms
  → re-validate graph (incremental — only dirty nodes)
  → if green AND was previously red:
      send __graph_clear ONLY (client reloads into working app)
      suppress normal __reload — __graph_clear already triggers reload
  → if green AND was previously green:
      send __reload (as today — normal live reload)
  → if red:
      send __graph_error:{errors_json} (client shows/updates diagnostic overlay)
      suppress __reload — prevents flicker of broken app before error overlay
      also: log errors to terminal with color + fix suggestions
```

A `graphWasRed` flag in `scheduleReload` tracks graph state transitions to
prevent double-reload.

### Terminal Output

When graph has errors, log to terminal (in addition to client diagnostic):

```
[aio] ✖ 2 module errors:

  ./components/Chart.tsx:12 — Syntax error: Unexpected token
  FIX: Close the JSX tag on line 12

  "lodash" — not in import map
  FIX: Add to deno.json: "lodash": "npm:lodash@4"
```

This ensures developers see errors even if Electron/browser overlay is not
visible.

---

## New Files

| File                     | Purpose                                                                   |
| ------------------------ | ------------------------------------------------------------------------- |
| `src/graph-validator.ts` | Import graph walker, validation logic, caching, incremental re-validation |

All other changes are modifications to existing files:

- `src/server.ts` — integrate graph validator into HTML serving + reload flow
- `src/server-html.ts` — enhanced `probeImports`, `__graph_error` handler,
  diagnostic page generator, Electron checks

## Dependencies

- No new dependencies. Uses existing `transpile()` function and esbuild.
- Regex-based import extraction (no AST parser needed for transpiled ESM
  output).

## What This Does NOT Change

- Production mode — `prod: true` still serves bundled `app.js` (esbuild catches
  all errors at bundle time)
- Feature loading — server-side feature `index.ts` loading is unaffected
- WebSocket state sync — unchanged
- Existing error classification in `classifyBrowserError()` — kept as fallback,
  enhanced with graph errors

## Risk Mitigation

| Risk                                                    | Mitigation                                                                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Graph walk has a bug and blocks serving                 | Timeout: if graph walk exceeds 2s, serve app anyway and log warning. Fail-open, not fail-closed.                             |
| Regex misses an import pattern                          | Regex covers standard ESM patterns from esbuild output (deterministic). Fallback: client probing catches what server misses. |
| CDN imports slow down graph walk                        | CDN/external URLs are marked as external — not fetched or validated server-side. Client-side probing handles CDN failures.   |
| Circular dependencies cause infinite loop               | Visited set in graph walk. Cycles detected and reported as warnings (not errors — JS allows circular imports).               |
| Graph cache grows unbounded                             | Bounded by file count in project. Files removed from disk are pruned on next invalidation cycle.                             |
| File changes between graph validation and browser fetch | Inherently racy in any dev server. Layer 2 (client probing) catches these. Accepted limitation.                              |
| Symlink loops in filesystem                             | `normPath` resolves symlinks. Graph visited set prevents re-processing, but add a max-files-visited cap (500) as safety net. |
| Large generated/vendor files slow regex scan            | Skip files >1MB — likely vendor bundles. Log a diagnostic note.                                                              |

## Known Limitations

1. **Computed dynamic imports** —
   `import(\`./pages/${name}.tsx\`)`or`import(variable)` cannot be statically
   analyzed. These bypass both graph validation and client probing. This is
   inherent to any static analysis approach and is an accepted limitation.
   Document in AIO dev guide: "Use string-literal import specifiers for reliable
   error reporting."

2. **CDN version mismatches** — The import map maps bare specifiers to esm.sh
   CDN URLs. If the CDN returns an unexpected version or redirect loop, the
   server-side validator won't catch it (CDN URLs are marked external). Layer 2
   catches these at runtime.

3. **`probeImports` lives in a template string** — The enhanced client-side
   probing logic modifies inline JavaScript inside `generateHTML()`'s template
   literal. Consider extracting the probing logic to a separate function that
   gets serialized into the template, rather than editing the monolithic
   template string directly.

## Deferred (Follow-Up Iterations)

- **Electron-specific diagnostics** (CSP check, IPC bridge check, preload
  verification) — valuable but not required for core graph validation. Can be
  added incrementally.
- **Module dependency tree in health overlay** — the graph data enables
  visualization of the import tree. Nice DevX win, low priority.
