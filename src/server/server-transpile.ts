// esbuild transpilation — lazy-loaded transform with LRU cache for dev-mode .ts/.tsx serving
import { resolve } from "@std/path";
import { ESBUILD_JSX, ESBUILD_SPEC } from "../build/esbuild-shared.ts";

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
    // B-6: pin the EXACT version deno.json pins (esbuild@0.24.2) — a `^0.24`
    // range could resolve a different esbuild than the project tested.
    // The specifier is COMPUTED (`.join`), not a literal, on purpose: deno's
    // static graph analysis (`deno install`/`cache`/`compile`) can't resolve it,
    // so the heavy esbuild NATIVE BINARY is fetched only when the dev server
    // actually transpiles — never when installing `am` (which never transpiles)
    // or compiling an app. Prevents `deno install am` from pulling ~10MB of
    // esbuild it doesn't use (and the ETXTBSY it hits under concurrent esbuild).
    const esbuildPkg = ESBUILD_SPEC; // shared pin (build/esbuild-shared.ts)
    const mod = await import(esbuildPkg);
    transformFn = mod.transform as (
      input: string,
      opts: Record<string, unknown>,
    ) => Promise<TransformResult>;
    esbuildStop = mod.stop as () => Promise<void>;
  }
  return transformFn!;
}
/** Is `--allow-run` actually granted? `undefined` when nothing can tell (a
 *  worker without the permissions API). */
function _runGranted(): boolean | undefined {
  try {
    return Deno.permissions.querySync({ name: "run" }).state === "granted";
  } catch {
    return undefined;
  }
}

/** Re-label an esbuild failure that is really a MISSING PERMISSION.
 *
 *  esbuild transpiles by spawning its native binary. Without `--allow-run` the
 *  spawn fails inside esbuild's own Deno shim and surfaces as
 *  `TypeError: Cannot read properties of undefined (reading 'unref')` — which
 *  the dev server then reported as `FIX: Transpile failed … Check syntax`, on
 *  a freshly scaffolded app the user had not touched. The advice that produced
 *  those flags (`doctor`'s least-privilege list) describes the COMPILED
 *  binary, which never transpiles. Blaming the user's syntax for the
 *  framework's unmet requirement is the exact failure this file must not have.
 *  Consulted only on FAILURE, so a scoped `--allow-run=…` that works is never
 *  second-guessed. Exported for the test that pins it. */
export function _explainTranspileFailure(e: unknown): unknown {
  if (_runGranted() !== false) return e;
  return new Error(
    `dev transpile needs --allow-run (esbuild runs its native binary as a ` +
      `subprocess) — this is NOT a syntax error in your file. Add ` +
      `--allow-run, or run with -A. \`doctor\`'s least-privilege flags ` +
      `describe the COMPILED binary in dist/, which carries a pre-built ` +
      `bundle and never transpiles. Underlying error: ${
        e instanceof Error ? e.message : String(e)
      }`,
    { cause: e },
  );
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

// Resolved-realpath cache — realPathSync is a syscall; memoizing it keeps the
// per-request transpile path off the event loop after the first hit. Cleared
// alongside transpileCache on file change/delete (watcher) and on eviction.
const _realPathCache = new Map<string, string>();

/** Normalize path — resolve symlinks when possible, fall back to resolve().
 *  Results are memoized per input path so the dev-mode request path doesn't
 *  issue a sync syscall on every transpile. */
export function normPath(p: string): string {
  const cached = _realPathCache.get(p);
  if (cached) return cached;
  let result: string;
  try {
    result = Deno.realPathSync(p);
  } catch {
    result = resolve(p);
  }
  // Cap the realpath cache to the same budget as the transpile cache so it
  // can't grow unbounded; evict the oldest entry when saturated.
  if (_realPathCache.size >= TRANSPILE_CACHE_MAX) {
    const oldest = _realPathCache.keys().next().value;
    if (oldest) _realPathCache.delete(oldest);
  }
  _realPathCache.set(p, result);
  return result;
}

/** Clear the transpile + realpath caches (called by the watcher on delete). */
export function clearTranspileCaches(filepath?: string): void {
  if (filepath !== undefined) {
    transpileCache.delete(filepath);
    _realPathCache.delete(filepath);
  } else {
    transpileCache.clear();
    _realPathCache.clear();
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
  const loader = filepath.endsWith(".tsx") ? "tsx" as const : "ts" as const;
  const jsxOpts = ESBUILD_JSX; // shared dev==prod JSX config
  let result: TransformResult;
  try {
    const transform = await getTransform();
    result = await transform(source, {
      loader,
      format: "esm",
      target: "esnext",
      ...jsxOpts,
    });
  } catch (e) {
    throw _explainTranspileFailure(e);
  }
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
