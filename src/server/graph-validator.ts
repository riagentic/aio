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

export type Resolution =
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

/** Server-only SYMBOLS exported from the isomorphic "aio"/"aio/db" entry. The
 *  browser build OMITS them, so a static import into a client-reachable module
 *  is an eager ES link failure — a blank screen every boot (AIO-424, risoto).
 *  Pure schema helpers (table/pk/text/…) are browser-safe and stay out.
 *  Keep in sync with aiol/checks.ts `SERVER_ONLY_AIO_SYMBOLS`. */
const SERVER_ONLY_AIO_SYMBOLS = new Set([
  "createDB",
  "DEFAULT_PRAGMAS",
  "connectCli",
  "connectCliUDS",
]);

/** Detect server-only APIs in browser-bound code.
 *  AIO-427 (risoto 2026-07-20f): severity is split by CERTAINTY of breakage —
 *  a *static import* of something the browser build can't provide (`node:*`
 *  builtins, omitted `aio` server symbols) is a GUARANTEED link failure →
 *  `server-only-import` (BLOCKING, shows the diagnostic page). `@std/*` (often
 *  browser-safe) and `Deno.*` *usage* (only breaks if that path runs client-
 *  side) are CONDITIONAL → `server-only-api` (warning). */
export function checkPlatformSafety(code: string, file: string): GraphError[] {
  const errors: GraphError[] = [];
  let m;
  // (1) Server-only MODULE imports. `node:` builtins cannot resolve in the
  //     browser (guaranteed break → blocking); `@std/*` is frequently
  //     browser-safe (path/encoding/assert/…) so it stays a warning.
  const MODULE_IMPORT_RE =
    /(?:import|export)\s+(?!type[\s{])[\s\S]*?\s+from\s+['"]((?:@std\/|node:)[^'"]+)['"]/gm;
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
  // Deno.* usage — strip comments AND string literals to avoid false positives
  const stripped = code
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(["'`])(?:(?!\1|\\).|\\.)*\1/g, '""');
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
      }() is not available in the browser. Move it into a *.server.ts module and dynamic-import it from the cell method, or use a cell effect (docs/build/imports.md).`,
    });
  }
  return errors;
}

export type TranspileFn = (source: string, filepath: string) => Promise<string>;

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
  const stack = new Set<string>(); // recursion stack for cycle detection
  // Static (eager) import edges only — used to decide whether a server-only
  // import is eagerly linked (block) or reached only via dynamic import (defer).
  const staticEdges = new Map<string, string[]>();

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
  // Downgrade a server-only IMPORT found only in a deferred (dynamic-only)
  // module: `await import("aio")` / `import("./x.server.ts")` is the documented
  // escape hatch, so it must not block. It becomes a conditional warning
  // (same class as `Deno.*` usage) — the code runs server-side, the browser
  // never loads that chunk. A STATIC server-only import stays blocking.
  for (const e of errors) {
    if (e.category === "server-only-import" && !eager.has(e.file)) {
      e.category = "server-only-api";
      e.message +=
        " (reached only via dynamic import — deferred, not blocking)";
    } else if (e.category === "missing-import-map") {
      // `@std/*` / `node:*` are absent from the BROWSER import map by design —
      // they resolve server-side. That's a warning (server-only), not a hard
      // "missing dep" block; a genuinely-missing package stays blocking.
      const spec = e.message.match(/"([^"]+)"/)?.[1] ?? "";
      if (spec.startsWith("@std/") || spec.startsWith("node:")) {
        e.category = "server-only-api";
      }
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
  // silent white void (risoto's ask; confirmed on quant, whose UI pages import
  // server-only cells). `deno task compile` fails the same imports, so dev==prod.
  // `server-only-api` (conditional `Deno.*` usage, browser-maybe-safe `@std/*`)
  // and circular imports stay warnings.
  const BLOCKING: Set<ErrorCategory> = new Set([
    "file-not-found",
    "transpile-error",
    "missing-import-map",
    "server-only-import",
  ]);
  // @std/* and node:* missing-map + deferred server-only imports were already
  // downgraded to warnings above, so this is the single source of truth.
  const blockingErrors = errors.filter((e) => BLOCKING.has(e.category));

  return {
    valid: blockingErrors.length === 0,
    errors,
    modules,
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

  // AIO-425 (inews): a BARE `from "..."` must NOT be matched — JSX text like
  // `"More from "` transpiles to a string literal containing `from "`, and the
  // old regex captured garbage from it, returning a "Module Errors" page for a
  // perfectly valid app (any string with "from" before a quote — "Recover from
  // backup", a blog title "Recovering from Disaster"…). Real ESM specifiers only
  // appear (a) after an `import`/`export` keyword at a statement boundary, or
  // (b) inside `import(...)`. Require that context.
  const STATIC_RE =
    /(?:^|[;\n}])\s*(?:import|export)\b[^;\n]*?\bfrom\s*["']([^"']+)["']/g;
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
