// esbuild transpilation — lazy-loaded transform with LRU cache for dev-mode .ts/.tsx serving
import { resolve } from "@std/path";
import {
  ESBUILD_JSX,
  ESBUILD_SPEC,
  stopEsbuildService,
} from "../build/esbuild-shared.ts";
import { importOutsideApp } from "./outside-app.ts";
import { log } from "../diagnostics/logger-api.ts";
import { TEARDOWN_TIMEOUT_MS } from "./shutdown-budget.ts";

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

/** What ONE stop may cost, the wait for work in flight and the reap of the
 *  child TOGETHER. Derived from the teardown budget, because that is whose
 *  time it spends: the stop runs inside the server's close, a phase that may
 *  be given all of `TEARDOWN_TIMEOUT_MS` and shares it with whatever else
 *  that close does. Two fifths (2 s — what the reap alone cost before the
 *  wait existed). A bound of its own here (10 s, for a while) was a bound the
 *  teardown cut first: the wait's warning was said five seconds after close
 *  had returned. */
const STOP_BUDGET_MS = TEARDOWN_TIMEOUT_MS * 2 / 5;

/** Mutable only as a test seam: an esbuild that cannot load, and a stop that
 *  gives up, cannot be built portably otherwise. @internal */
export const _ESBUILD = {
  /** What {@link loadEsbuild} imports. */
  spec: ESBUILD_SPEC,
  /** {@link STOP_BUDGET_MS}. */
  budgetMs: STOP_BUDGET_MS,
};

let transformFn:
  | ((input: string, opts: Record<string, unknown>) => Promise<TransformResult>)
  | null = null;
let esbuildStop: (() => Promise<void>) | null = null;

/** THE way a server process gets esbuild — the dev transpiler and the
 *  prod-bundle judge both come through here, so the service has ONE owner and
 *  {@link stopEsbuild} always holds its stop.
 *
 *  The judge used to import esbuild by itself. A boot whose whole graph the
 *  transpile cache answered (a second `aio.run()` in one process) never went
 *  through the transpiler's load, so the judge's build started a service that
 *  `stopEsbuild()` had never heard of, and close left it running.
 *
 *  Use what it returns inside {@link esbuildWork}, so a stop waits for it.
 *
 *  B-6: the EXACT version deno.json pins (esbuild@0.24.2) — a `^0.24` range
 *  could resolve a different esbuild than the project tested. The specifier
 *  is COMPUTED (`.join`), not a literal, on purpose: deno's static graph
 *  analysis (`deno install`/`cache`/`compile`) can't resolve it, so the heavy
 *  esbuild NATIVE BINARY is fetched only when the dev server actually
 *  transpiles — never when installing `am` (which never transpiles) or
 *  compiling an app. Prevents `deno install am` from pulling ~10MB of esbuild
 *  it doesn't use (and the ETXTBSY it hits under concurrent esbuild). */
export async function loadEsbuild<T = Record<string, unknown>>(): Promise<T> {
  const mod = await importOutsideApp<T>(_ESBUILD.spec);
  esbuildStop = (mod as { stop: () => Promise<void> }).stop;
  return mod;
}

async function getTransform() {
  if (!transformFn) {
    const mod = await loadEsbuild();
    transformFn = mod.transform as (
      input: string,
      opts: Record<string, unknown>,
    ) => Promise<TransformResult>;
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

// ── work in flight ─────────────────────────────────────────────────────
//
// A stop has to come AFTER the esbuild work that was already under way, for
// two measured reasons:
//   - `getTransform()` knows the service only once esbuild has loaded. A stop
//     that arrived inside that load found nothing to stop and returned; the
//     load landed, the transform spawned the native child, and nobody was
//     left to stop it.
//   - a transform still pending when esbuild's `stop()` destroys the pipes
//     never settles — its caller waits for good.
// So every transpile is in this set until it settles, and so is whatever a
// caller declares with `esbuildWork` (a graph walk is many transpiles with
// file reads between them: no single one is in flight at the gap).
const _inFlight = new Set<Promise<void>>();

/** Declare `work` as esbuild work in flight: {@link stopEsbuild} waits for it
 *  to settle before it stops the service. Returns `work` itself. */
export function esbuildWork<T>(work: Promise<T>): Promise<T> {
  const settle = () => void _inFlight.delete(settled);
  const settled: Promise<void> = work.then(settle, settle);
  _inFlight.add(settled);
  return work;
}

/** Wait for the work in flight, at most `ms`. False when it gave up. */
async function inFlightSettled(ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((r) => {
    timer = setTimeout(() => r(false), ms);
  });
  try {
    // Re-checked after every wait: work that started meanwhile is waited for
    // too, so the stop follows an EMPTY set in the same turn.
    while (_inFlight.size > 0) {
      const settled = Promise.all([..._inFlight]).then(() => true as const);
      if (!await Promise.race([settled, expired])) return false;
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
}

async function stopNow(): Promise<void> {
  // The wait ends on a real event wherever one exists: a transform settles
  // when esbuild answers, and REJECTS when the service dies under it (its
  // pipe ends). Work with no such event — a wedged service, a declared walk
  // stuck on a read — is given up on by name, never waited for in silence.
  const deadline = Date.now() + _ESBUILD.budgetMs;
  // Three quarters of the budget for the wait; the reap gets what is left of
  // it — all of it when nothing was in flight.
  const waitMs = _ESBUILD.budgetMs * 3 / 4;
  if (!await inFlightSettled(waitMs)) {
    log.warn(
      "esbuild",
      `stopping esbuild with ${_inFlight.size} piece(s) of work still in ` +
        `flight after ${waitMs} ms — not waiting any longer. A ` +
        `transform pending when the service stops never settles, so ` +
        `whatever awaits that work is abandoned.`,
    );
    _inFlight.clear();
  }
  if (!esbuildStop) return;
  const stop = esbuildStop;
  esbuildStop = null;
  transformFn = null;
  await stopEsbuildService(stop, Math.max(0, deadline - Date.now()));
}

let _stops: Promise<void> = Promise.resolve();

/** Stop the esbuild subprocess and return only once it has EXITED — see
 *  `stopEsbuildService`, the one place that knows how to wait for esbuild's
 *  native child, because every esbuild caller needs the same wait.
 *
 *  Waits for the work in flight first (above); wait and reap together are
 *  bounded by {@link STOP_BUDGET_MS}.
 *  Stops run ONE AT A TIME, in the order asked: a second caller used to find
 *  the handle already taken and return while the first was still waiting for
 *  the child to exit. Work that STARTS after this resolves starts the service
 *  again, and stopping that is its caller's. */
export function stopEsbuild(): Promise<void> {
  return _stops = _stops.then(stopNow, stopNow);
}

// Transpile cache — keyed by filepath, invalidated when source changes, capped at 200 entries
const TRANSPILE_CACHE_MAX = 200;
export const transpileCache = new Map<
  string,
  { source: string; code: string }
>();

// Resolved-realpath cache — realPathSync is a syscall; memoizing it keeps the
// per-request transpile path off the event loop after the first hit. Cleared
// alongside transpileCache on file change/delete (report 7) and on eviction.
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

// Converts .ts/.tsx/.jsx to browser-ready JS via esbuild (cached, invalidated on file change)
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
  // By extension, as the bundler picks it: `.jsx` is JSX without types.
  const lower = filepath.toLowerCase();
  const loader = lower.endsWith(".tsx")
    ? "tsx" as const
    : lower.endsWith(".jsx")
    ? "jsx" as const
    : "ts" as const;
  const jsxOpts = ESBUILD_JSX; // shared dev==prod JSX config
  let result: TransformResult;
  try {
    result = await esbuildWork((async () => {
      const transform = await getTransform();
      return await transform(source, {
        loader,
        format: "esm",
        target: "esnext",
        ...jsxOpts,
      });
    })());
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
