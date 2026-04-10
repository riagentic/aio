// esbuild transpilation — lazy-loaded transform with LRU cache for dev-mode .ts/.tsx serving
import { resolve } from "@std/path";

export type EsbuildMessage = {
  text: string;
  location?: {
    file?: string;
    line?: number;
    column?: number;
    lineText?: string;
  } | null;
};
type TransformResult = { code: string; warnings: EsbuildMessage[] };

// Lazy esbuild — dynamic import with computed specifier so deno compile won't embed the native binary
let transformFn:
  | ((input: string, opts: Record<string, unknown>) => Promise<TransformResult>)
  | null = null;
let esbuildStop: (() => Promise<void>) | null = null;
async function getTransform() {
  if (!transformFn) {
    // deno-lint-ignore no-import-prefix
    const mod = await import("npm:esbuild@^0.24");
    transformFn = mod.transform as (
      input: string,
      opts: Record<string, unknown>,
    ) => Promise<TransformResult>;
    esbuildStop = mod.stop as () => Promise<void>;
  }
  return transformFn!;
}
/** Stop esbuild subprocess — call on server shutdown to avoid resource leaks */
export async function stopEsbuild() {
  if (esbuildStop) {
    await esbuildStop();
    // Allow child process to fully terminate before returning
    await new Promise((r) => setTimeout(r, 10));
    esbuildStop = null;
    transformFn = null;
  }
}

// Transpile cache — keyed by filepath, invalidated when source changes, capped at 200 entries
const TRANSPILE_CACHE_MAX = 200;
export const transpileCache = new Map<
  string,
  { source: string; code: string }
>();

/** Normalize path — resolve symlinks when possible, fall back to resolve() */
export function normPath(p: string): string {
  try {
    return Deno.realPathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Formats esbuild message with location info: "text (file:line:col)\n  > lineText" */
export function fmtEsbuildMsg(m: EsbuildMessage, file?: string): string {
  const loc = m.location;
  const where = loc
    ? ` (${loc.file ?? file ?? "?"}:${loc.line}:${loc.column})`
    : "";
  const line = loc?.lineText ? `\n  > ${loc.lineText}` : "";
  return `${m.text}${where}${line}`;
}

/** Extracts readable errors from esbuild exceptions */
export function fmtEsbuildError(err: unknown, file: string): string {
  const e = err as { errors?: EsbuildMessage[] };
  if (e.errors?.length) {
    return e.errors.map((m) => fmtEsbuildMsg(m, file)).join("\n");
  }
  return String(err);
}

// Converts .ts/.tsx to browser-ready JS via esbuild (cached, invalidated on file change)
export async function transpile(
  source: string,
  filepath: string,
  log?: (msg: string) => void,
): Promise<string> {
  const npath = normPath(filepath);
  const cached = transpileCache.get(npath);
  if (cached && cached.source === source) {
    // LRU: move to end (most recently used)
    transpileCache.delete(npath);
    transpileCache.set(npath, cached);
    return cached.code;
  }
  const transform = await getTransform();
  const loader = filepath.endsWith(".tsx") ? "tsx" as const : "ts" as const;
  const jsxOpts = { jsx: "automatic", jsxImportSource: "aio" };
  const result = await transform(source, {
    loader,
    format: "esm",
    target: "esnext",
    ...jsxOpts,
  });
  if (result.warnings?.length && log) {
    for (const w of result.warnings) {
      log(`esbuild warning: ${fmtEsbuildMsg(w, filepath)}`);
    }
  }
  // esbuild (running in Deno) rewrites bare imports to Deno specifiers, e.g. "react" → "npm:react@^18"
  // Browsers can't fetch npm: URLs — strip prefix+version so the HTML import map takes over
  const code = result.code
    .replace(/from "npm:(@?[^"@/]+(?:\/[^"@]+)?)@[^"]+"/g, 'from "$1"')
    // Strip CSS imports — browsers reject CSS loaded as JS modules (MIME mismatch).
    // AIO already injects <link> tags for style.css, so CSS imports in TSX are redundant.
    .replace(
      /^import\s+["'][^"']+\.css["'];?\s*$/gm,
      "/* css import stripped — served via <link> */",
    );
  if (transpileCache.size >= TRANSPILE_CACHE_MAX) {
    // Evict oldest entry (first inserted key)
    const oldest = transpileCache.keys().next().value;
    if (oldest) transpileCache.delete(oldest);
  }
  transpileCache.set(npath, { source, code });
  return code;
}
