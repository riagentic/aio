// src/graph-validator.ts
import { resolve } from "@std/path";

/** Error categories for module validation failures */
export type ErrorCategory =
  | "file-not-found"
  | "transpile-error"
  | "missing-import-map"
  | "server-only-import"
  | "server-only-api"
  | "cdn-unreachable"
  | "circular-dependency"
  | "import-map-mismatch"
  | "permission-denied"
  | "electron-env"
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
  /** True when the error is in a module reached ONLY via dynamic import (the
   *  documented server-only escape hatch) — the browser never loads that chunk,
   *  so it can't blank-screen. Reported quietly (debug), never in the loud
   *  "reachable from the browser bundle" block. */
  deferred?: boolean;
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
  /** Modules reachable from the entry through STATIC imports only — the set
   *  the browser eagerly links at boot. A module in `modules` but not here is
   *  a dynamic-import chunk the client may never load (the server-only escape
   *  hatch). A static `*.server.ts` import inside this set is a BLOCKING
   *  `server-only-import` (the dev server 404s the file to the browser);
   *  `smoke()` in `aio/testing` fetches every member from a real boot. */
  eager: Set<string>;
  durationMs: number;
};

export type Resolution =
  | { kind: "local"; path: string }
  | { kind: "external"; url: string }
  | { kind: "error"; error: GraphError };

/** aio entries that exist only on the server side — see resolveSpecifier. */
const SERVER_ONLY_SPECS = new Set(["aio/server"]);

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
    const base = resolve(dir, spec);

    if (_exists(base)) return { kind: "local", path: base };
    for (const ext of EXTENSIONS) {
      if (_exists(base + ext)) return { kind: "local", path: base + ext };
    }
    for (const idx of INDEX_FILES) {
      const indexPath = base + "/" + idx;
      if (_exists(indexPath)) return { kind: "local", path: indexPath };
    }

    return {
      kind: "error",
      error: {
        file: importerPath,
        category: "file-not-found",
        message: `File "${spec}" not found`,
        fix: `File "${spec}" does not exist relative to ${importerPath}.`,
      },
    };
  }

  // JSX runtime specifiers are injected by the compiler (jsxImportSource),
  // not explicit imports — treat as external even without an import map entry.
  if (spec.endsWith("/jsx-runtime") || spec.endsWith("/jsx-dev-runtime")) {
    return { kind: "external", url: spec };
  }

  // The framework's own SERVER entry is deliberately absent from the browser
  // import map (loading SQLite/Worker code in a browser is the bug this map
  // prevents). An app reaches it the documented way — a dynamic
  // `await import("aio/server")` inside a cell method — so flagging it as a
  // missing mapping was pure noise, and the suggested "fix" (npm:aio/server)
  // does not exist. Treat it as external: never walked, never an error.
  //
  if (SERVER_ONLY_SPECS.has(spec)) {
    return { kind: "external", url: spec };
  }

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

  if (mapped.startsWith("http://") || mapped.startsWith("https://")) {
    return { kind: "external", url: mapped };
  }
  // jsr:, npm:, node: — Deno resolves these at runtime; not walkable as local files
  if (
    mapped.startsWith("jsr:") || mapped.startsWith("npm:") ||
    mapped.startsWith("node:")
  ) {
    return { kind: "external", url: mapped };
  }
  // Absolute URL paths (e.g. "/__aio/ui.js") are server-resolved routes, not filesystem paths
  if (mapped.startsWith("/")) {
    return { kind: "external", url: mapped };
  }
  // Local path alias (e.g. "../lib/foo.ts") — resolve and walk it
  if (mapped.startsWith("./") || mapped.startsWith("../")) {
    const dir = importerPath.replace(/\/[^/]+$/, "");
    const resolved = resolve(dir, mapped);
    if (_exists(resolved)) return { kind: "local", path: resolved };
    for (const ext of EXTENSIONS) {
      if (_exists(resolved + ext)) {
        return { kind: "local", path: resolved + ext };
      }
    }
    return {
      kind: "error",
      error: {
        file: importerPath,
        category: "file-not-found",
        message: `Import map alias "${spec}" → "${mapped}" not found`,
        fix:
          `The import map maps "${spec}" to "${mapped}" but that file doesn't exist.`,
      },
    };
  }
  // Unknown scheme — treat as external (user knows what they're doing)
  return { kind: "external", url: mapped };
}

// Server-only SYMBOLS exported from the isomorphic "aio"/"aio/db" entries —
// THE list lives in src/entries.ts (alpha52 one-decider; aiol imports the
// same set, so the dev-server diagnostic and the linter can never disagree).
import { SERVER_ONLY_AIO_SYMBOLS } from "../entries.ts";
import { codeText } from "../diagnostics/code-mask.ts";

/** Detect server-only APIs in browser-bound code.
 *  AIO-427: severity is split by CERTAINTY of breakage —
 *  a *static import* of something the browser build can't provide (`node:*`
 *  builtins, omitted `aio` server symbols) is a GUARANTEED link failure →
 *  `server-only-import` (BLOCKING, shows the diagnostic page). `@std/*` (often
 *  browser-safe) and `Deno.*` *usage* (only breaks if that path runs client-
 *  side) are CONDITIONAL → `server-only-api` (warning). */
/** `// aio-ok: server-only` — the acknowledgement path the warning had none of.
 *
 *  A field report ran for weeks with `⚠ src/cell/job.ts:292 — Deno.remove is
 *  server-only` on every launch, pointing at a `finally` block inside a method
 *  that only ever runs on the server, cleaning up a file it had itself created.
 *  The rule is right in general and wrong there, and with no way to say so the
 *  line became permanent noise printed next to the ✖ errors that genuinely
 *  break the client — which trains people to skim the one output they most need
 *  to read carefully. `aiol` already had this idiom (`// aiol-ok`).
 *
 *  Accepted on the flagged line, or on a comment line immediately above it
 *  (where the reason belongs, and where `deno fmt` cannot move it).
 *
 *  Deliberately NOT accepted for blocking categories: "this path never runs in
 *  the browser" is a claim a developer can make, "this import exists in the
 *  browser build" is not — that one is a guaranteed blank screen, and a
 *  silenceable one would be worse than the noise. */
export function isServerOnlySuppressed(
  lines: readonly string[],
  lineNum: number,
): boolean {
  const marker = /\/\/.*\baio-ok\b\s*[:\-—]?\s*server-only/;
  const own = lines[lineNum - 1] ?? "";
  if (marker.test(own)) return true;
  const above = (lines[lineNum - 2] ?? "").trim();
  return above.startsWith("//") && marker.test(above);
}

export function checkPlatformSafety(code: string, file: string): GraphError[] {
  const errors: GraphError[] = [];
  let m;
  // (1) Server-only MODULE imports. `node:` builtins cannot resolve in the
  //     browser (guaranteed break → blocking); `@std/*` is frequently
  //     browser-safe (path/encoding/assert/…) so it stays a warning.
  // `[^;\n]` — never `[\s\S]`, which crossed statement boundaries: the
  // `(?!type[\s{])` lookahead was then evaluated against the FIRST import in
  // the file, so `import { x } from "./x.ts"` followed anywhere below by a
  // correct `import type { Buffer } from "node:buffer"` was reported as a
  // BLOCKING server-only import — and a blocking error makes the dev server
  // serve the diagnostic page instead of the app and suppress hot reload. The
  // fix text even told the author to do what they had already done. The
  // `aio`-symbol twin below was already bounded this way.
  const MODULE_IMPORT_RE =
    /(?:import|export)\s+(?!type[\s{])[^;\n]*?\s+from\s+['"]((?:@std\/|node:)[^'"]+)['"]/g;
  while ((m = MODULE_IMPORT_RE.exec(code)) !== null) {
    const spec = m[1]!;
    const lineNum = code.slice(0, m.index).split("\n").length;
    if (spec.startsWith("node:")) {
      errors.push({
        file,
        line: lineNum,
        category: "server-only-import",
        message: `"${spec}" is a Node builtin — unavailable in the browser`,
        fix:
          `${spec} is absent from the browser build; this static import blank-screens the client at boot. Move it behind a dynamic import in a server-only path (or a *.server.ts module), or use \`import type\`.`,
      });
    } else {
      errors.push({
        file,
        line: lineNum,
        category: "server-only-api",
        message: `"${spec}" may be server-only`,
        fix:
          `${spec} is not guaranteed to run in the browser. If this module is client-reachable and the import is server-only, move it behind a dynamic import or use \`import type\`.`,
      });
    }
  }
  // (2) Server-only SYMBOLS from the isomorphic "aio"/"aio/db" entry (createDB,
  //     connectCli, …). Omitted from the browser build → guaranteed link
  //     failure → blocking. `[^;]*?` keeps the match inside one statement.
  const AIO_IMPORT_RE =
    /(?:import|export)\s+(?!type[\s{])([^;]*?)\s+from\s+['"](aio|aio\/db)['"]/g;
  while ((m = AIO_IMPORT_RE.exec(code)) !== null) {
    const braces = m[1]!.match(/\{([^}]*)\}/);
    if (!braces) continue;
    const spec = m[2]!;
    const lineNum = code.slice(0, m.index).split("\n").length;
    for (const raw of braces[1]!.split(",")) {
      const sym = raw.trim().split(/\s+as\s+/)[0]!.trim();
      if (!SERVER_ONLY_AIO_SYMBOLS.has(sym)) continue;
      errors.push({
        file,
        line: lineNum,
        category: "server-only-import",
        message:
          `'${sym}' from "${spec}" is server-only (SQLite/Worker); the browser build omits it`,
        fix:
          `Load it lazily in a server-only path — \`const { ${sym} } = await import("${spec}")\` behind a server guard — or move it into a *.server.ts module. (Pure schema helpers like table/pk/text are browser-safe.)`,
      });
    }
  }
  // Deno.* usage — comments AND string literals blanked, so a `Deno.` written
  // in a doc example or inside a string is not a call.
  //
  // `codeText` and NOT a hand-rolled strip, because the line number below is
  // computed from this text: deleting a block comment takes its NEWLINES with
  // it, so every finding after the first JSDoc block was reported too high in
  // the file. A field report measured it — 39 newlines destroyed in one
  // 681-line file, the warning reported 4 lines above its call — and the
  // consequence was not a cosmetic one: `isServerOnlySuppressed` looks at the
  // reported line and the line above it for `// aio-ok: server-only`, so the
  // acknowledgement was unreachable for any file with JSDoc in it, which is
  // most files. `codeText` blanks to spaces and keeps every offset.
  const stripped = codeText(code);
  const DENO_RE = /\bDeno\.(\w+)/g;
  while ((m = DENO_RE.exec(stripped)) !== null) {
    // Line number from stripped (line count preserved — replacements are same-line)
    const lineNum = stripped.slice(0, m.index).split("\n").length;
    // Skip Deno.* usage guarded by `typeof Deno` on the same line (runtime-safe pattern)
    const originalLine = code.split("\n")[lineNum - 1] ?? "";
    if (/typeof\s+Deno\b/.test(originalLine)) continue;
    // Skip type-only references (e.g. `e: Deno.FsEvent`, `as Deno.Conn`,
    // `Array<Deno.FsEvent>`) — types are erased by esbuild and never reach the
    // browser. Type position = preceded by a type token (`:` `<` `|` `&` or
    // as/extends/implements/keyof) and not a call (not immediately followed by
    // `(`). A bare value-ref after `:` is the only residual miss (rare).
    const beforeOnLine = stripped.slice(0, m.index);
    const lineStart = beforeOnLine.slice(beforeOnLine.lastIndexOf("\n") + 1);
    const afterChar = stripped[m.index + m[0].length] ?? "";
    const inTypePosition = /[:<|&]\s*$/.test(lineStart) ||
      /\b(?:as|extends|implements|keyof)\s+$/.test(lineStart);
    if (inTypePosition && afterChar !== "(") continue;
    errors.push({
      file,
      line: lineNum,
      category: "server-only-api",
      message: `Deno.${m[1]} is server-only`,
      fix: `Deno.${
        m[1]
      }() is not available in the browser. Move it into a *.server.ts module and dynamic-import it from the cell method, or use a cell effect (docs/build/imports.md). If this path only ever runs on the server, say so: \`// aio-ok: server-only — <reason>\` on the line or the line above.`,
    });
  }
  // The acknowledgement pass. Warnings only — a blocking category is a
  // guaranteed blank screen and stays unsilenceable.
  const lines = code.split("\n");
  return errors.filter((e) =>
    BLOCKING_CATEGORIES.has(e.category) ||
    !isServerOnlySuppressed(lines, e.line ?? 0)
  );
}

export type TranspileFn = (source: string, filepath: string) => Promise<string>;

const MAX_FILES = 500;
const MAX_FILE_SIZE = 1_000_000; // 1MB — skip likely vendor bundles

/** Validate the full import graph starting from entrypoint.
 *  Returns errors with actionable fix instructions for every broken module. */
/** Categories that BLOCK the app (a guaranteed blank screen), as opposed to
 *  standing warnings. The diagnostic page reads this too, so "N module errors —
 *  fix to continue" can never count warnings the developer is expected to live
 *  with. */
export const BLOCKING_CATEGORIES: ReadonlySet<ErrorCategory> = new Set([
  "file-not-found",
  "transpile-error",
  "missing-import-map",
  "server-only-import",
]);

/** aio's server-only file convention — never served to a browser. */
const SERVER_FILE_RE = /\.server\.tsx?$/;

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
  const stack = new Set<string>(); // recursion stack for cycle detection
  // Static (eager) import edges only — used to decide whether a server-only
  // import is eagerly linked (block) or reached only via dynamic import (defer).
  const staticEdges = new Map<string, string[]>();
  // Static imports of `*.server.ts(x)` — aio's serving convention: the dev
  // server 404s those files to the browser (server-static.ts isProtectedPath)
  // and the prod bundler refuses them. Collected during the walk, judged after
  // the eager set exists: static + eager ⇒ BLOCKING (the app blank-screens);
  // reached only via dynamic import ⇒ the documented escape hatch, fine.
  const serverFileImports: { file: string; spec: string; line: number }[] = [];

  async function walk(filePath: string, importerPath?: string): Promise<void> {
    if (visited.has(filePath)) {
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
      stack.delete(filePath);
      return;
    }

    if (source.length > MAX_FILE_SIZE) {
      stack.delete(filePath);
      return;
    }

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
      stack.delete(filePath);
      return;
    }

    // Run on source (not transpiled) — esbuild may rewrite @std/node: imports
    const platformErrors = checkPlatformSafety(source, filePath);
    errors.push(...platformErrors);

    const byKind = extractImportsByKind(transpiled);
    const specifiers = [...byKind.static, ...byKind.dynamic];
    const staticSpecs = new Set(byKind.static);
    const staticDeps: string[] = [];
    const deps: string[] = [];

    const hashBuffer = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(source),
    );
    const hash = [...new Uint8Array(hashBuffer)].map((b) =>
      b.toString(16).padStart(2, "0")
    ).join("").slice(0, 16);

    for (const spec of specifiers) {
      if (staticSpecs.has(spec) && SERVER_FILE_RE.test(spec)) {
        const at = source.indexOf(spec);
        serverFileImports.push({
          file: filePath,
          spec,
          line: at < 0 ? 1 : source.slice(0, at).split("\n").length,
        });
      }
      const resolution = resolveSpecifier(
        spec,
        filePath,
        importMap,
        fileExists,
      );
      if (resolution.kind === "local") {
        deps.push(resolution.path);
        if (staticSpecs.has(spec)) staticDeps.push(resolution.path);
        await walk(resolution.path, filePath);
      } else if (resolution.kind === "error") {
        errors.push(resolution.error);
      }
    }
    staticEdges.set(filePath, staticDeps);

    modules.set(filePath, {
      path: filePath,
      hash,
      deps,
      valid: true,
      errors: [],
    });

    stack.delete(filePath);
  }

  await walk(entrypoint);

  // Eager set: modules reachable from the entry through STATIC imports only.
  // Everything else is reached solely via dynamic `import()` — a code-split
  // boundary that is loaded on demand, so its server-only content is NOT
  // eagerly linked into the client bundle.
  const eager = new Set<string>();
  const eagerStack = [entrypoint];
  while (eagerStack.length) {
    const p = eagerStack.pop()!;
    if (eager.has(p)) continue;
    eager.add(p);
    for (const dep of staticEdges.get(p) ?? []) eagerStack.push(dep);
  }
  for (const imp of serverFileImports) {
    if (!eager.has(imp.file)) continue;
    errors.push({
      file: imp.file,
      line: imp.line,
      category: "server-only-import",
      message:
        `"${imp.spec}" is a *.server.ts module, statically imported from a client-loaded file — the dev server never serves it to the browser (404), so the app blank-screens at boot`,
      fix:
        `Load it lazily from a server-only path — \`const m = await import("${imp.spec}")\` inside a cell method — or use \`import type\`. A static import of a *.server.ts module is never client-safe (docs/build/imports.md).`,
    });
  }
  // A module reached ONLY via dynamic import (`await import("aio")` /
  // `import("./x.server.ts")`) is the documented server-only escape hatch: the
  // browser never loads that chunk, so NOTHING in it can blank-screen — not a
  // server-only import, and not `Deno.*`/`@std` usage either. Mark every such
  // finding `deferred` so it's reported quietly, consistently. A STATIC
  // server-only import (eager) stays blocking.
  for (const e of errors) {
    const isDeferred = !eager.has(e.file);
    if (e.category === "server-only-import") {
      if (isDeferred) {
        e.category = "server-only-api";
        e.deferred = true;
        e.message +=
          " (reached only via dynamic import — deferred, not blocking)";
      }
    } else if (e.category === "missing-import-map") {
      // `@std/*` / `node:*` / `aio/server` are absent from the BROWSER import
      // map by design — they resolve server-side. That's a warning
      // (server-only), not a hard "missing dep" block; a genuinely-missing
      // package stays blocking.
      //
      // `aio/server` joined this list in alpha37: buildBrowserImportMap
      // deliberately omits it (server-only symbols must never enter a browser
      // bundle), so the very import path the alpha37 migration TELLS apps to
      // adopt — and that docs/build/imports.md demonstrates with
      // `const { createDB } = await import("aio/server")` — was reported as a
      // blocking missing-dep. Following the guide correctly produced an
      // unfixable boot error with no app-side remedy. Same by-design absence as
      // @std//node:, so same downgrade.
      const spec = e.message.match(/"([^"]+)"/)?.[1] ?? "";
      if (
        spec.startsWith("@std/") || spec.startsWith("node:") ||
        spec === "aio/server"
      ) {
        e.category = "server-only-api";
        if (isDeferred) e.deferred = true;
      }
    } else if (e.category === "server-only-api" && isDeferred) {
      // `Deno.*`/`@std` USAGE inside a dynamic-only module — same escape hatch,
      // same safety. Was inconsistently left loud while deferred imports were
      // quieted; defer it too.
      e.deferred = true;
    }
  }

  // Post-walk: compute per-module valid/errors now that the full error list is finalized
  for (const [path, node] of modules) {
    const moduleErrors = errors.filter((e) => e.file === path);
    node.errors = moduleErrors;
    node.valid = moduleErrors.length === 0;
  }

  const durationMs = performance.now() - start;

  // Only blocking categories prevent the app from loading (→ diagnostic page).
  // `server-only-import` (a static `node:` builtin or omitted `aio` server
  // symbol reachable from the UI entry) is a GUARANTEED client break: aio's
  // Electron renderer is a sandboxed browser (`nodeIntegration:false`), same as
  // a web browser, so the module can't resolve → blank screen every boot. We
  // BLOCK it — loud + attributed (`file:line` + fix) — rather than serve a
  // silent white void. `deno task compile` fails the same imports, so dev==prod.
  // `server-only-api` (conditional `Deno.*` usage, browser-maybe-safe `@std/*`)
  // and circular imports stay warnings.
  const BLOCKING = BLOCKING_CATEGORIES;
  // @std/* and node:* missing-map + deferred server-only imports were already
  // downgraded to warnings above, so this is the single source of truth.
  const blockingErrors = errors.filter((e) => BLOCKING.has(e.category));

  return {
    valid: blockingErrors.length === 0,
    errors,
    modules,
    eager,
    durationMs,
  };
}

/** Extract import specifiers from transpiled JS, split by kind. STATIC imports
 *  form the EAGER graph (linked at load — a server-only static import is a
 *  guaranteed browser break). DYNAMIC `import()` is a code-split boundary —
 *  deferred/conditional, the legitimate server-only escape hatch. */
export function extractImportsByKind(
  code: string,
): { static: string[]; dynamic: string[] } {
  // Strip comments to avoid false positives (esbuild output is clean ESM)
  const cleaned = code
    .replace(/\/\/.*$/gm, "") // single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, ""); // multi-line comments

  // AIO-425: a BARE `from "..."` must NOT be matched — JSX text like
  // `"More from "` transpiles to a string literal containing `from "`, and the
  // old regex captured garbage from it, returning a "Module Errors" page for a
  // perfectly valid app (any string with "from" before a quote — "Recover from
  // backup", a blog title "Recovering from Disaster"…). Real ESM specifiers only
  // appear (a) after an `import`/`export` keyword at a statement boundary, or
  // (b) inside `import(...)`. Require that context.
  const STATIC_RE =
    /(?:^|[;\n}])\s*(?:import|export)\b[^;\n]*?\bfrom\s*["']([^"']+)["']/g;
  // Bare side-effect imports (`import "./x.ts";`) have no `from`, so the
  // regex above cannot see them — yet they are eagerly linked exactly like a
  // named import, and an invisible one let a server-only file into a client
  // graph with a green gate. Statement-boundary anchored
  // for the same AIO-425 reason.
  const BARE_STATIC_RE = /(?:^|[;\n}])\s*import\s*["']([^"']+)["']/g;
  const DYNAMIC_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

  // A module specifier never contains whitespace or JS punctuation — a final
  // guard against any residual garbage capture (belt-and-suspenders).
  const isSpecifier = (s: string) =>
    s.length > 0 && !/[\s,;(){}\[\]<>`]/.test(s);

  const staticSpecs: string[] = [];
  const dynamicSpecs: string[] = [];
  let m;
  while ((m = STATIC_RE.exec(cleaned)) !== null) {
    if (m[1] && isSpecifier(m[1])) staticSpecs.push(m[1]);
  }
  while ((m = BARE_STATIC_RE.exec(cleaned)) !== null) {
    if (m[1] && isSpecifier(m[1])) staticSpecs.push(m[1]);
  }
  while ((m = DYNAMIC_RE.exec(cleaned)) !== null) {
    if (m[1] && isSpecifier(m[1])) dynamicSpecs.push(m[1]);
  }
  return { static: staticSpecs, dynamic: dynamicSpecs };
}

/** All import specifiers (static + dynamic) from transpiled JS output. */
export function extractImports(code: string): string[] {
  const { static: s, dynamic: d } = extractImportsByKind(code);
  return [...s, ...d];
}
