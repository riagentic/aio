// src/graph-validator.ts
import { resolve } from "@std/path";

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
  // Local path alias (e.g. "./lib/foo.ts") — resolve and walk it
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

/** Detect server-only APIs in browser-bound code. */
export function checkPlatformSafety(code: string, file: string): GraphError[] {
  const errors: GraphError[] = [];
  // Matches: import/export ... from "node:*"/"@std/*" including `export * from` and multiline
  const SERVER_IMPORT_RE =
    /(?:import|export)\s+(?!type[\s{])[\s\S]*?\s+from\s+['"]((?:@std\/|node:)[^'"]+)['"]/gm;
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
      } is server-only and not available in browser. Move to a cell effect or use \`import type\`.`,
    });
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
      fix: `Deno.${m[1]}() is not available in browser. Move to a cell effect.`,
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

    const specifiers = extractImports(transpiled);
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
        await walk(resolution.path, filePath);
      } else if (resolution.kind === "error") {
        errors.push(resolution.error);
      }
    }

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

  // Post-walk: compute per-module valid/errors now that the full error list is finalized
  for (const [path, node] of modules) {
    const moduleErrors = errors.filter((e) => e.file === path);
    node.errors = moduleErrors;
    node.valid = moduleErrors.length === 0;
  }

  const durationMs = performance.now() - start;

  // Only blocking categories prevent the app from loading.
  // Server-only APIs and circular imports are warnings — they exist in server-side
  // cell code that the browser imports but never executes those code paths.
  const BLOCKING: Set<ErrorCategory> = new Set([
    "file-not-found",
    "transpile-error",
    "missing-import-map",
  ]);
  const blockingErrors = errors.filter((e) => BLOCKING.has(e.category));

  // Don't block on missing-import-map for server-only modules (@std/*, node:*)
  // — these are in cell code that runs server-side only
  const realBlockingErrors = blockingErrors.filter((e) => {
    if (e.category !== "missing-import-map") return true;
    // If the specifier is a server-only module, it's a warning not a blocker
    const specMatch = e.message.match(/"([^"]+)"/);
    if (specMatch) {
      const spec = specMatch[1];
      if (spec?.startsWith("@std/") || spec?.startsWith("node:")) return false;
    }
    return true;
  });

  return {
    valid: realBlockingErrors.length === 0,
    errors,
    modules,
    durationMs,
  };
}

/** Extract all import specifiers from transpiled JS output.
 *  Works on esbuild output (clean ESM) — regex is reliable here. */
export function extractImports(code: string): string[] {
  // Strip comments to avoid false positives (esbuild output is clean ESM)
  const cleaned = code
    .replace(/\/\/.*$/gm, "") // single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, ""); // multi-line comments
  // Note: string literals containing `from "..."` are NOT stripped.
  // Acceptable: esbuild's transpiled output doesn't produce such patterns.

  // Match: from "spec", from 'spec', import("spec"), import('spec')
  const IMPORT_RE = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g;
  const specifiers: string[] = [];
  let match;
  while ((match = IMPORT_RE.exec(cleaned)) !== null) {
    if (match[1] !== undefined) specifiers.push(match[1]);
  }
  return specifiers;
}
