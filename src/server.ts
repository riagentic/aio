// HTTP + WebSocket server with live TSX transpilation (dev) or static serving (prod)
import { extname, join, resolve, SEPARATOR } from "@std/path";
import { type AioUser, DEFAULT_SYNC_INTERVAL_MS } from "./aio.ts";
import type { RenderBudget } from "./vitals/types.ts";
import type { VitalsSystem } from "./vitals/mod.ts";
import {
  diagEmit,
  diagSubscribe,
  initDiagnosticBus,
} from "./diagnostic-bus.ts";
import { setDiagEmit } from "./error.ts";
export {
  buildBrowserImportMap,
  classifyBrowserError,
  generateDiagnosticHTML,
  generateHTML,
  MIME,
  TEXT_EXTENSIONS,
} from "./server-html.ts";
import {
  buildBrowserImportMap,
  classifyBrowserError,
  generateDiagnosticHTML,
  generateHTML,
  MIME,
  TEXT_EXTENSIONS,
} from "./server-html.ts";
import { type GraphResult, validateGraph } from "./graph-validator.ts";

type DispatchFn = (event: unknown, user?: AioUser) => void;
type GetUIStateFn = (user?: AioUser) => unknown;

/** Internal config — passed by aio.run(), not user-facing */
export interface ServerConfig {
  port: number;
  socketPath?: string; // Unix domain socket path — when set, serves over UDS instead of TCP
  title: string;
  width?: number; // window width hint (embedded in HTML meta)
  height?: number; // window height hint (embedded in HTML meta)
  getUIState: GetUIStateFn; // optional user for per-user filtering
  dispatch: DispatchFn;
  getSnapshot?: () => string;
  loadSnapshot?: (json: string) => void;
  baseDir: string;
  debug: (msg: string) => void;
  prod?: boolean; // serve pre-built dist/ instead of live-transpiling
  distDir?: string; // absolute path to dist/ (required when prod=true)
  expose?: boolean; // bind 0.0.0.0 instead of 127.0.0.1
  token?: string; // access token required when expose=true (no users)
  cert?: string; // PEM cert string — enables HTTPS when set (auto-generated when --expose)
  key?: string; // PEM key string — required when cert is set
  users?: Record<string, AioUser>; // per-user token map (overrides token)
  showStatus?: boolean; // show reconnection indicator (default: true)
  renderBudget?: RenderBudget; // sent to browser for RenderMeter thresholds
  fullStateThreshold?: number; // 0-1: ratio of changed keys for delta vs full broadcast (default: 0.5)
  maxConnections?: number; // max concurrent WebSocket clients (default: 100)
  syncIntervalMs?: number; // throttle state broadcasts: max 1 push per N ms (default: 50)
  allowedOrigins?: string[]; // extra allowed origins beyond localhost (e.g. Docker, reverse proxy)
  clientCounter?: { value: number }; // shared index counter — WS and UDS get unique indices
  onConnect?: (user?: AioUser) => void;
  onDisconnect?: (user?: AioUser) => void;
  onReload?: (signal: "__reload" | "__css") => void; // called on live-reload — lets aio.ts forward to UDS
  // Vitals — latency monitoring & backpressure
  vitalsSystem?: VitalsSystem;
  // Time-travel (dev mode)
  onTTCommand?: (cmd: string, arg?: number) => void;
  getTTBroadcast?: () => unknown;
  // Health endpoint — GET /__aio/health
  getHealth?: () => unknown;
  // Trojan — control API at /__aio/trojan/* (localhost-only, CSRF-protected, rate-limited)
  trojan?: {
    getState: () => unknown; // raw unfiltered state
    getSchedules: () => string[]; // active schedule IDs
    getTTHistory?: () => unknown; // time-travel entries (wire format)
    forcePersist?: () => void; // trigger immediate persist
    sqlQuery?: (sql: string) => Promise<unknown[]>; // read-only SQL query (async)
    shutdown?: () => Promise<void>; // graceful shutdown
    startedAt: number; // Date.now() at boot
    /** UDS clients (Electron IPC) — for am client command */
    udsClients?: () => { index: number; id: string }[];
    /** Send a message to a UDS client and wait for __clientState: response */
    requestUdsClientState?: (index: number, msg?: string) => Promise<unknown>;
  };
}

// Constant-time string comparison — prevents timing attacks on token auth
// Compares full length even on mismatch to avoid leaking token length
export function _timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  const len = Math.max(ab.length, bb.length);
  let result = ab.length ^ bb.length; // length difference contributes to result
  for (let i = 0; i < len; i++) result |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return result === 0;
}

/** Resolves user from token map — checks query param and Authorization header */
function resolveUser(
  users: Record<string, AioUser>,
  url: URL,
  req: Request,
): AioUser | null {
  const qToken = url.searchParams.get("token");
  const auth = req.headers.get("authorization");
  const hToken = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  for (const candidate of [qToken, hToken]) {
    if (!candidate) continue;
    for (const [t, user] of Object.entries(users)) {
      if (_timingSafeEqual(candidate, t)) return user;
    }
  }
  return null;
}

/** Returned to aio.run() so it can push state updates and shut down cleanly */
export interface ServerHandle {
  broadcast: () => void;
  broadcastTT: () => void;
  shutdown: () => Promise<void>;
  clientCount: () => number;
  trojanPort?: number; // set when TLS is active — HTTP-only trojan endpoint on 127.0.0.1
  socketPath?: string; // set when UDS is active
  watcherActive?: boolean; // true if file watcher is running (dev mode only)
}

function fileExists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

// browser.ts URL — works for both local (file://) and JSR/HTTP installs (import.meta.dirname is null for remote modules)
const BROWSER_TS_URL = new URL("browser.ts", import.meta.url);
const LISTENERS_TS_URL = new URL("listeners.ts", import.meta.url);
// Base URL for resolving sub-module imports (e.g. vitals/*.ts) served under /__aio/
const AIO_SRC_BASE_URL = new URL(".", import.meta.url);

type EsbuildMessage = {
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
async function stopEsbuild() {
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
const transpileCache = new Map<string, { source: string; code: string }>();

/** Normalize path — resolve symlinks when possible, fall back to resolve() */
function normPath(p: string): string {
  try {
    return Deno.realPathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Formats esbuild message with location info: "text (file:line:col)\n  > lineText" */
function fmtEsbuildMsg(m: EsbuildMessage, file?: string): string {
  const loc = m.location;
  const where = loc
    ? ` (${loc.file ?? file ?? "?"}:${loc.line}:${loc.column})`
    : "";
  const line = loc?.lineText ? `\n  > ${loc.lineText}` : "";
  return `${m.text}${where}${line}`;
}

/** Extracts readable errors from esbuild exceptions */
function fmtEsbuildError(err: unknown, file: string): string {
  const e = err as { errors?: EsbuildMessage[] };
  if (e.errors?.length) {
    return e.errors.map((m) => fmtEsbuildMsg(m, file)).join("\n");
  }
  return String(err);
}

// Converts .ts/.tsx to browser-ready JS via esbuild (cached, invalidated on file change)
async function transpile(
  source: string,
  filepath: string,
  log?: (msg: string) => void,
): Promise<string> {
  const npath = normPath(filepath);
  const cached = transpileCache.get(npath);
  if (cached && cached.source === source) return cached.code;
  const transform = await getTransform();
  const loader = filepath.endsWith(".tsx") ? "tsx" as const : "ts" as const;
  const result = await transform(source, {
    loader,
    format: "esm",
    target: "esnext",
    jsx: "automatic",
    jsxImportSource: "react",
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

/** Safety limits — prevent resource exhaustion */
const WS_MAX_MESSAGE = 1_000_000; // 1MB — reject oversized WS messages
const WS_MAX_CONNECTIONS = 100; // max concurrent WebSocket clients
const SNAPSHOT_MAX_SIZE = 10_000_000; // 10MB — reject oversized snapshot uploads
const BP_STALENESS_HIGH = 300; // ms — client render staleness triggering 4x throttle
const BP_STALENESS_MODERATE = 100; // ms — client render staleness triggering 2x throttle
const BP_RECOVERY_PINGS = 3; // consecutive low-staleness pings before stepping down multiplier

/** Delta computation result */
export type DeltaResult = {
  msg: string;
  newKeyJsons: Record<string, string>;
  kind: "skip" | "delta" | "full";
};

/** Flatten one level: for object-valued top-level keys, use dot-notation (e.g. "mdview.scrollY").
 *  Primitive/array top-level values stay as-is. This gives v0.5 namespaced state fine-grained delta. */
function flattenKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const sk of Object.keys(v as Record<string, unknown>)) {
        flat[`${k}.${sk}`] = (v as Record<string, unknown>)[sk];
      }
    } else {
      flat[k] = v;
    }
  }
  return flat;
}

/** Unflatten dot-notation keys back into nested structure for the patch */
function unflattenPatch(
  changed: Record<string, unknown>,
  removed: string[],
): { $p: Record<string, unknown>; $d?: string[] } {
  const patch: Record<string, unknown> = {};
  const topDeletions: string[] = [];
  for (const [k, v] of Object.entries(changed)) {
    const dot = k.indexOf(".");
    if (dot === -1) {
      patch[k] = v;
      continue;
    }
    const parent = k.slice(0, dot);
    const child = k.slice(dot + 1);
    if (!patch[parent] || typeof patch[parent] !== "object") patch[parent] = {};
    (patch[parent] as Record<string, unknown>)[child] = v;
  }
  for (const k of removed) {
    const dot = k.indexOf(".");
    if (dot === -1) {
      topDeletions.push(k);
      continue;
    }
    // Nested removal: "mdview.oldKey" → { mdview: { $d: ['oldKey'] } }
    const parent = k.slice(0, dot);
    const child = k.slice(dot + 1);
    if (!patch[parent] || typeof patch[parent] !== "object") patch[parent] = {};
    const p = patch[parent] as Record<string, unknown>;
    if (!p.$d) p.$d = [];
    (p.$d as string[]).push(child);
  }
  const result: { $p: Record<string, unknown>; $d?: string[] } = { $p: patch };
  if (topDeletions.length) result.$d = topDeletions;
  return result;
}

/** Computes delta patch between old and new UI state — pure function, testable in isolation.
 *  Uses dot-notation for object-valued top-level keys (v0.5 namespaced state) to enable
 *  fine-grained delta within feature slices. */
export function _computeDelta(
  uiState: unknown,
  lastState: unknown,
  lastKeyJsons: Record<string, string>,
  threshold = 0.5,
): DeltaResult {
  // First broadcast or non-object state — full send
  if (
    lastState === null || !uiState || typeof uiState !== "object" ||
    Array.isArray(uiState)
  ) {
    const newKeyJsons: Record<string, string> = {};
    if (uiState && typeof uiState === "object" && !Array.isArray(uiState)) {
      const flat = flattenKeys(uiState as Record<string, unknown>);
      for (const k of Object.keys(flat)) {
        newKeyJsons[k] = JSON.stringify(flat[k]);
      }
    }
    return { msg: JSON.stringify(uiState), newKeyJsons, kind: "full" };
  }

  const flat = flattenKeys(uiState as Record<string, unknown>);
  const lastFlat = flattenKeys(lastState as Record<string, unknown>);
  const keys = Object.keys(flat);
  const changed: Record<string, unknown> = {};
  const newKeyJsons: Record<string, string> = {};
  let changedCount = 0;

  for (const k of keys) {
    // Skip stringify for unchanged references (check via flattened last)
    if (flat[k] === lastFlat[k] && lastKeyJsons[k]) {
      newKeyJsons[k] = lastKeyJsons[k];
      continue;
    }
    const json = JSON.stringify(flat[k]);
    newKeyJsons[k] = json;
    if (json !== lastKeyJsons[k]) {
      changed[k] = flat[k];
      changedCount++;
    }
  }
  const removed: string[] = [];
  for (const k of Object.keys(lastKeyJsons)) {
    if (!(k in newKeyJsons)) {
      removed.push(k);
      changedCount++;
    }
  }

  if (changedCount === 0) return { msg: "", newKeyJsons, kind: "skip" };

  // Patch when changed ratio is below threshold (default 50% — small patches are cheaper than full state).
  // Use max(new, old) key count so removals don't shrink the denominator and bias toward full state.
  const totalKeys = Math.max(keys.length, Object.keys(lastKeyJsons).length);
  if (changedCount < totalKeys * threshold) {
    const patch = unflattenPatch(changed, removed);
    return { msg: JSON.stringify(patch), newKeyJsons, kind: "delta" };
  }

  return { msg: JSON.stringify(uiState), newKeyJsons, kind: "full" };
}

/** Starts HTTP + WS server, returns broadcast handle for state pushes and shutdown */
export function createServer(config: ServerConfig): ServerHandle {
  const { port, title, getUIState, dispatch, debug, prod = false, distDir } =
    config;
  // Diagnostic bus — dev-only event system for surfacing silent failures
  initDiagnosticBus(!prod);
  if (!prod) {
    setDiagEmit(diagEmit);
  }

  const absBaseDir = resolve(config.baseDir); // normalize to absolute — fixes cache key matching

  let denoImports: Record<string, string> = {};
  try {
    const djText = Deno.readTextFileSync(join(absBaseDir, "..", "deno.json"));
    denoImports = JSON.parse(djText).imports ?? {};
  } catch { /* no deno.json or parse error — use defaults */ }
  const importMapObj = buildBrowserImportMap(denoImports);
  const IMPORT_MAP = JSON.stringify({ imports: importMapObj });

  // Import graph validator state (dev mode only)
  let graphResult: GraphResult | null = null;
  let graphWasRed = false;

  // Dev startup validation — quick scan for obvious browser import issues
  if (!prod) {
    const SERVER_ONLY_RE =
      /(?:import|export)\s+(?!type\s).*?\s+from\s+['"]((?:@std\/|node:)[^'"]+)['"]/g;
    const scanFiles: string[] = [];
    // Scan src/ for feature files and App.tsx
    try {
      for (const entry of Deno.readDirSync(absBaseDir)) {
        if (
          entry.isFile &&
          (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
          !entry.name.endsWith(".test.ts")
        ) {
          scanFiles.push(entry.name);
        }
      }
      // Check features/ subdirectory if it exists
      try {
        for (const entry of Deno.readDirSync(join(absBaseDir, "features"))) {
          if (
            entry.isFile && entry.name.endsWith(".ts") &&
            !entry.name.endsWith(".test.ts")
          ) {
            scanFiles.push("features/" + entry.name);
          }
        }
      } catch { /* no features dir */ }
    } catch { /* can't read dir */ }

    for (const name of scanFiles) {
      try {
        const content = Deno.readTextFileSync(join(absBaseDir, name));
        // Only check files with feature() definitions or .tsx
        if (!content.includes("feature(") && !name.endsWith(".tsx")) continue;
        for (const m of content.matchAll(SERVER_ONLY_RE)) {
          const lineIdx = content.slice(0, m.index).split("\n").length;
          debug(
            `⚠ ${name}:${lineIdx} — "${
              m[1]
            }" is server-only, will fail in browser`,
          );
          debug(`  fix: move to server-only file or use dynamic import`);
        }
      } catch { /* file not found */ }
    }
  }

  // Graph validation at startup (dev mode only) — tracked so shutdown can await it
  let graphValidationDone: Promise<void> | null = null;
  if (!prod) {
    const entrypoint = join(absBaseDir, "App.tsx");
    if (fileExists(entrypoint)) {
      graphValidationDone = validateGraph(entrypoint, importMapObj, transpile)
        .then((result) => {
          graphResult = result;
          const warnings = result.errors.filter((e) =>
            e.category === "server-only-api" ||
            e.category === "circular-dependency"
          );
          const blocking = result.errors.filter((e) =>
            e.category !== "server-only-api" &&
            e.category !== "circular-dependency"
          );
          if (result.valid) {
            debug(
              `graph: ✓ ${result.modules.size} modules validated (${
                result.durationMs.toFixed(0)
              }ms)${warnings.length ? ` (${warnings.length} warnings)` : ""}`,
            );
          } else {
            for (const err of blocking) {
              debug(
                `graph: ✖ ${err.file}${
                  err.line ? `:${err.line}` : ""
                } — ${err.message}`,
              );
              debug(`  FIX: ${err.fix}`);
            }
            graphWasRed = true;
          }
          if (result.durationMs > 1000) {
            debug(
              `graph: ⚠ validation took ${
                result.durationMs.toFixed(0)
              }ms (budget: 1000ms)`,
            );
          }
        }).catch((err) => debug(`graph: startup validation failed — ${err}`));
    }
  }

  const absDistDir = distDir ? resolve(distDir) : null;
  // Detect style.css — dev: src/style.css, prod: dist/style.css
  const hasCSS = fileExists(join(absBaseDir, "style.css")) ||
    (absDistDir ? fileExists(join(absDistDir, "style.css")) : false);
  if (hasCSS) debug("style.css detected — injecting <link>");
  const WS_RATE_LIMIT = 100; // max messages per second per client
  const WS_BYTES_PER_SEC = 5_000_000; // 5MB/s per client — prevents bandwidth DoS
  type ClientType =
    | "electron"
    | "browser"
    | "electron-reload"
    | "browser-reload"
    | "unknown";
  type ClientMeta = {
    id: string;
    index: number;
    clientType: ClientType;
    isElectron: boolean;
    user?: AioUser;
    lastState: unknown;
    lastKeyJsons: Record<string, string>;
    msgCount: number;
    bytesThisSec: number;
    msgResetTimer?: ReturnType<typeof setTimeout>;
    typeDetectTimer?: ReturnType<typeof setTimeout>;
    bpMultiplier: number; // backpressure: sync interval multiplier (1, 2, or 4)
    bpConsecutiveLow: number; // backpressure: consecutive low-staleness pings
    bpLastSentAt: number; // backpressure: timestamp of last broadcast to this client
  };
  const connections = new Map<WebSocket, ClientMeta>();
  const _payloadStats = new Map<
    string,
    { lastPayloadBytes: number; totalBytes: number; count: number }
  >();

  // Forward diagnostic bus events to all connected dev clients via WS
  if (!prod) {
    diagSubscribe((ev) => {
      const msg = "__diag:" + JSON.stringify(ev);
      for (const [ws] of connections) {
        try {
          ws.send(msg);
        } catch { /* client gone */ }
      }
    });
  }

  // Shared counter — if config provides one, WS and UDS indices are globally unique
  const clientCounter = config.clientCounter ?? { value: 0 };
  const nextIndex = () => clientCounter.value++;
  // Pending client state requests (dev mode) — resolve when client responds, capped to prevent unbounded growth
  const pendingClientState = new Map<
    string,
    { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const PENDING_STATE_MAX = 50;
  const syncIntervalMs = config.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  let broadcastQueued = false;
  let broadcastDirty = false;
  let broadcastThrottle: ReturnType<typeof setTimeout> | null = null;
  let lastError = ""; // last transpile error — served at /__aio/error
  const errorMap = new Map<
    string,
    {
      errors: Array<
        {
          text: string;
          file?: string;
          line?: number;
          col?: number;
          lineText?: string;
        }
      >;
      ts: number;
    }
  >();
  const bootId = crypto.randomUUID().slice(0, 8); // unique per server start — triggers browser reload on reconnect
  const noCache = prod
    ? {}
    : { "Cache-Control": "no-store" } as Record<string, string>; // prevent Electron/browser caching in dev
  // Trojan rate limiting — 100 req/s across all trojan endpoints
  const TROJAN_RATE_LIMIT = 100;
  let _trojanReqCount = 0;
  let _trojanResetTimer: ReturnType<typeof setTimeout> | null = null;

  // Coalesced + throttled broadcast — batches synchronous bursts via microtask; optionally throttles async streams
  // Leading edge fires immediately (after microtask coalesce); trailing flush ensures last state always arrives
  // Per-client delta: each client tracks its own lastState/lastKeyJsons (supports getUIState per client)
  function broadcast(): void {
    broadcastDirty = true;

    if (broadcastQueued) return; // microtask already pending this tick
    if (syncIntervalMs > 0 && broadcastThrottle) return; // inside throttle window — trailing flush will catch it

    broadcastQueued = true;
    queueMicrotask(() => {
      broadcastQueued = false;
      broadcastDirty = false;
      try {
        for (const [ws, meta] of connections) {
          if (ws.readyState !== WebSocket.OPEN) continue;
          if (config.vitalsSystem?.serverTransport.isFrozen(meta.id)) {
            continue;
          }
          // Backpressure: skip client if not enough time elapsed since last send
          if (meta.bpMultiplier > 1) {
            const elapsed = Date.now() - meta.bpLastSentAt;
            if (elapsed < syncIntervalMs * meta.bpMultiplier) continue;
          }
          let uiState: unknown;
          try {
            uiState = getUIState(meta.user);
          } catch (e) {
            debug(`broadcast: getUIState error — ${e}`);
            continue;
          }
          if (uiState === meta.lastState) continue; // skip if ref unchanged
          const delta = _computeDelta(
            uiState,
            meta.lastState,
            meta.lastKeyJsons,
            config.fullStateThreshold,
          );
          meta.lastState = uiState;
          meta.lastKeyJsons = delta.newKeyJsons;
          if (delta.kind === "skip") continue;
          debug(`broadcast ${delta.kind} → client ${meta.id.slice(0, 8)}`);
          try {
            ws.send(delta.msg);
            meta.bpLastSentAt = Date.now();
            config.vitalsSystem?.serverTransport.onClientStateSent(
              meta.id,
              Date.now(),
            );
            const _bytes = new TextEncoder().encode(delta.msg).byteLength;
            const _ps = _payloadStats.get(meta.id);
            if (_ps) {
              _ps.lastPayloadBytes = _bytes;
              _ps.totalBytes += _bytes;
              _ps.count++;
            } else {_payloadStats.set(meta.id, {
                lastPayloadBytes: _bytes,
                totalBytes: _bytes,
                count: 1,
              });}
            config.vitalsSystem?.pressureMonitor?.onBroadcast(meta.id, _bytes);
          } catch { /* client disconnecting */ }
        }
      } catch (e) {
        debug(`broadcast error: ${e}`);
      }

      if (syncIntervalMs > 0) {
        broadcastThrottle = setTimeout(() => {
          broadcastThrottle = null;
          if (broadcastDirty) broadcast(); // trailing flush — last state always reaches UI
        }, syncIntervalMs);
      }
    });
  }

  // Upgrades HTTP to WebSocket — sends initial state, forwards actions to dispatch
  function handleWs(req: Request, user?: AioUser): Response {
    // Validate origin — localhost always allowed; when exposed, allowedOrigins restricts further
    // When not exposed: only localhost + allowedOrigins. When exposed: token handles auth,
    // but if allowedOrigins is set, also enforce origin restriction (additive with token).
    if (!config.expose || config.allowedOrigins?.length) {
      const origin = req.headers.get("origin");
      if (origin) {
        try {
          const u = new URL(origin);
          const h = u.hostname;
          const isLocal = h === "localhost" || h === "127.0.0.1" ||
            h === "::1" || h === "[::1]";
          const isAllowed = config.allowedOrigins?.includes(h) ?? false;
          if (!isLocal && !isAllowed) {
            debug(`ws: rejected origin ${origin}`);
            return new Response("Forbidden", { status: 403 });
          }
        } catch {
          return new Response("Bad Request", { status: 400 });
        }
      }
    }

    const maxConn = config.maxConnections ?? WS_MAX_CONNECTIONS;
    if (connections.size >= maxConn) {
      debug(`ws: rejected — max connections (${maxConn})`);
      return new Response("Too Many Connections", { status: 503 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    const clientId = crypto.randomUUID();
    const clientIndex = nextIndex();
    const isElectron = /electron/i.test(req?.headers.get("user-agent") ?? "");
    const meta: ClientMeta = {
      id: clientId,
      index: clientIndex,
      clientType: "unknown",
      isElectron,
      user,
      lastState: null,
      lastKeyJsons: {},
      msgCount: 0,
      bytesThisSec: 0,
      bpMultiplier: 1,
      bpConsecutiveLow: 0,
      bpLastSentAt: 0,
    };
    socket.onerror = (e) => {
      debug(
        `ws: error ${clientId.slice(0, 8)} — ${
          e instanceof ErrorEvent ? e.message : e
        }`,
      );
      connections.delete(socket);
      if (meta.msgResetTimer) {
        clearTimeout(meta.msgResetTimer);
        meta.msgResetTimer = undefined;
      }
      if (meta.typeDetectTimer) {
        clearTimeout(meta.typeDetectTimer);
        meta.typeDetectTimer = undefined;
      }
      if (config.onDisconnect) {
        try {
          config.onDisconnect(meta.user);
        } catch (err) {
          debug(`hook onDisconnect: ${err}`);
        }
      }
    };
    socket.onopen = () => {
      connections.set(socket, meta);
      // Auto-tag as reload watcher if client doesn't identify within 2s
      meta.typeDetectTimer = setTimeout(() => {
        meta.typeDetectTimer = undefined;
        if (meta.clientType === "unknown") {
          meta.clientType = meta.isElectron
            ? "electron-reload"
            : "browser-reload";
        }
      }, 2000);
      debug(
        `ws: connect ${clientId.slice(0, 8)} user=${
          user?.id ?? "anon"
        } (${connections.size} total)`,
      );
      if (config.onConnect) {
        try {
          config.onConnect(meta.user);
        } catch (e) {
          debug(`hook onConnect: ${e}`);
        }
      }
      try {
        const uiState = getUIState(meta.user);
        const msg = JSON.stringify(uiState);
        // Init delta cache so first broadcast computes a proper delta (dot-notation for nested)
        if (uiState && typeof uiState === "object" && !Array.isArray(uiState)) {
          const flat = flattenKeys(uiState as Record<string, unknown>);
          for (const k of Object.keys(flat)) {
            meta.lastKeyJsons[k] = JSON.stringify(flat[k]);
          }
        }
        meta.lastState = uiState;
        socket.send(msg);
      } catch (e) {
        debug(`ws: getUIState error on connect — ${e}`);
      }
      // Send TT metadata on connect (dev mode)
      if (config.getTTBroadcast) {
        try {
          const ttData = config.getTTBroadcast();
          socket.send("__tt:" + JSON.stringify(ttData));
        } catch (e) {
          debug(`ws: getTTBroadcast error on connect — ${e}`);
        }
      }
      // Boot ID — browser reloads page if server restarted (stale JS in memory)
      socket.send("__boot:" + bootId);
    };
    // WS message prefix registry:
    //   __reload     — trigger page reload
    //   __css        — CSS-only hot reload
    //   __boot:<id>  — boot ID for session tracking
    //   __tt:<json>  — time-travel state
    //   __vitals:<json> — vital signs data
    //   __diag:<json>   — diagnostic bus events (dev only)
    socket.onmessage = (e) => {
      try {
        // Rate limiting — reset counters every second
        meta.msgCount++;
        if (!meta.msgResetTimer) {
          meta.msgResetTimer = setTimeout(() => {
            meta.msgCount = 0;
            meta.bytesThisSec = 0;
            meta.msgResetTimer = undefined;
          }, 1000);
        }
        if (meta.msgCount > WS_RATE_LIMIT) {
          debug(
            `ws: rate limit exceeded for ${
              meta.id.slice(0, 8)
            } (${meta.msgCount}/s)`,
          );
          return;
        }
        if (typeof e.data !== "string") {
          debug(`ws: binary message dropped — only JSON strings accepted`);
          return;
        }
        if (e.data.length > WS_MAX_MESSAGE) {
          debug(`ws: message too large (${e.data.length} bytes), dropped`);
          return;
        }
        meta.bytesThisSec += e.data.length;
        if (meta.bytesThisSec > WS_BYTES_PER_SEC) {
          debug(
            `ws: byte rate exceeded for ${meta.id.slice(0, 8)} (${
              (meta.bytesThisSec / 1_000_000).toFixed(1)
            }MB/s)`,
          );
          return;
        }
        // Client state response (dev mode) — resolves pending am request
        if (e.data.startsWith("__clientState:")) {
          const pending = pendingClientState.get(meta.id);
          if (pending) {
            pendingClientState.delete(meta.id);
            clearTimeout(pending.timer);
            try {
              pending.resolve(JSON.parse(e.data.slice(14)));
            } catch {
              pending.resolve(null);
            }
          }
          return;
        }
        // Client type identification — browser.ts sends __type:electron or __type:browser on connect
        if (e.data.startsWith("__type:")) {
          const t = e.data.slice(7);
          if (t === "electron" || t === "browser") meta.clientType = t;
          return;
        }
        // Time-travel commands: __tt:undo, __tt:redo, __tt:goto:5, etc.
        if (e.data.startsWith("__tt:") && config.onTTCommand) {
          debug(`ws: tt command ${e.data}`);
          const body = e.data.slice(5);
          if (body.startsWith("goto:")) {
            const n = Number(body.slice(5));
            if (Number.isInteger(n) && n >= 0 && n < 1_000_000) {
              config.onTTCommand("goto", n);
            }
          } else {
            config.onTTCommand(body);
          }
          return;
        }
        // Vitals ping — latency measurement
        if (typeof e.data === "string" && e.data.startsWith("__vitals:ping:")) {
          try {
            const ping = JSON.parse(e.data.slice(14));
            const vmeta = connections.get(socket);
            if (vmeta && config.vitalsSystem) {
              config.vitalsSystem.serverTransport.onClientPing(
                vmeta.id,
                ping.t1,
              );
              // Backpressure: adapt per-client sync rate based on render staleness
              const staleness = typeof ping.ms === "number" ? ping.ms : 0;
              const prevMul = vmeta.bpMultiplier;
              if (staleness > BP_STALENESS_HIGH) {
                vmeta.bpMultiplier = 4;
                vmeta.bpConsecutiveLow = 0;
              } else if (staleness > BP_STALENESS_MODERATE) {
                vmeta.bpMultiplier = 2;
                vmeta.bpConsecutiveLow = 0;
              } else {
                vmeta.bpConsecutiveLow++;
                if (
                  vmeta.bpConsecutiveLow >= BP_RECOVERY_PINGS &&
                  vmeta.bpMultiplier > 1
                ) {
                  vmeta.bpMultiplier = Math.max(1, vmeta.bpMultiplier / 2);
                  vmeta.bpConsecutiveLow = 0;
                }
              }
              if (vmeta.bpMultiplier !== prevMul) {
                const cid = vmeta.id.slice(0, 8);
                if (vmeta.bpMultiplier > prevMul) {
                  console.warn(
                    `[aio:vitals] client ${cid} — staleness ${
                      Math.round(staleness)
                    }ms, backpressure ${prevMul}x→${vmeta.bpMultiplier}x`,
                  );
                } else {
                  console.warn(
                    `[aio:vitals] client ${cid} — recovered, backpressure ${prevMul}x→${vmeta.bpMultiplier}x`,
                  );
                }
              }
              const pong = {
                t1: ping.t1,
                t2: Date.now(),
                loop: config.vitalsSystem.getLoopVitalsForPong(),
              };
              socket.send("__vitals:pong:" + JSON.stringify(pong));
            }
          } catch (err) {
            debug(`[vitals] bad ping: ${err}`);
          }
          return;
        }
        const parsed = JSON.parse(e.data);

        if (!parsed || typeof parsed.type !== "string") {
          debug(`ws: invalid action — missing type field`);
          return;
        }
        if (
          parsed.payload !== undefined &&
          (typeof parsed.payload !== "object" || parsed.payload === null ||
            Array.isArray(parsed.payload))
        ) {
          debug(`ws: invalid action — payload must be a plain object`);
          return;
        }
        debug(
          `ws: recv ${JSON.stringify(parsed)} user=${meta.user?.id ?? "anon"}`,
        );
        dispatch(parsed, meta.user);
      } catch (err) {
        debug(`ws: malformed message — ${err}`);
      }
    };
    socket.onclose = () => {
      connections.delete(socket);
      if (meta.msgResetTimer) {
        clearTimeout(meta.msgResetTimer);
        meta.msgResetTimer = undefined;
      }
      if (meta.typeDetectTimer) {
        clearTimeout(meta.typeDetectTimer);
        meta.typeDetectTimer = undefined;
      }
      debug(
        `ws: disconnect ${clientId.slice(0, 8)} user=${
          meta.user?.id ?? "anon"
        } (${connections.size} total)`,
      );
      if (config.vitalsSystem) {
        config.vitalsSystem.serverTransport.removeClient(meta.id);
        config.vitalsSystem.pressureMonitor?.onClientDisconnect(meta.id);
        _payloadStats.delete(meta.id);
      }
      if (config.onDisconnect) {
        try {
          config.onDisconnect(meta.user);
        } catch (e) {
          debug(`hook onDisconnect: ${e}`);
        }
      }
    };
    return response;
  }

  // Serves HTML, virtual routes, and static/dist files
  async function serveStatic(
    pathname: string,
    req?: Request,
  ): Promise<Response> {
    if (pathname === "/") {
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
          config.renderBudget,
        ),
        { headers: { "Content-Type": "text/html", ...noCache } },
      );
    }

    if (pathname === "/__aio/ui.js") {
      try {
        const source = await fetch(BROWSER_TS_URL).then((r) => r.text());
        const code = await transpile(source, BROWSER_TS_URL.href, debug);
        return new Response(code, {
          headers: { "Content-Type": "application/javascript", ...noCache },
        });
      } catch (err) {
        debug(
          `transpile browser.ts error: ${fmtEsbuildError(err, "browser.ts")}`,
        );
        return new Response(`throw new Error("browser.ts transpile failed")`, {
          headers: { "Content-Type": "application/javascript", ...noCache },
        });
      }
    }

    if (pathname === "/__aio/listeners.ts") {
      try {
        const source = await fetch(LISTENERS_TS_URL).then((r) => r.text());
        const code = await transpile(source, LISTENERS_TS_URL.href, debug);
        return new Response(code, {
          headers: { "Content-Type": "application/javascript", ...noCache },
        });
      } catch (err) {
        debug(
          `transpile listeners.ts error: ${
            fmtEsbuildError(err, "listeners.ts")
          }`,
        );
        return new Response(
          `throw new Error("listeners.ts transpile failed")`,
          {
            headers: { "Content-Type": "application/javascript", ...noCache },
          },
        );
      }
    }

    // Generic handler for aio sub-module .ts files (e.g. vitals/*.ts)
    // Resolves relative to aio src/ — prevents path traversal via ".." check
    if (
      pathname.startsWith("/__aio/") &&
      (pathname.endsWith(".ts") || pathname.endsWith(".tsx")) &&
      !pathname.includes("..")
    ) {
      const relPath = pathname.slice("/__aio/".length);
      const fileUrl = new URL(relPath, AIO_SRC_BASE_URL);
      try {
        const source = await fetch(fileUrl).then((r) => r.text());
        const code = await transpile(source, fileUrl.href, debug);
        return new Response(code, {
          headers: { "Content-Type": "application/javascript", ...noCache },
        });
      } catch (err) {
        debug(`transpile ${relPath} error: ${fmtEsbuildError(err, relPath)}`);
        return new Response(
          `throw new Error(${JSON.stringify(relPath + " transpile failed")})`,
          {
            headers: { "Content-Type": "application/javascript", ...noCache },
          },
        );
      }
    }

    if (!prod && pathname === "/__aio/error") {
      const cutoff = Date.now() - 30_000;
      const allErrors = [...errorMap.values()].filter((e) => e.ts > cutoff)
        .flatMap((e) => e.errors);
      return new Response(JSON.stringify({ errors: allErrors }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!prod && pathname === "/__aio/client-error" && req?.method === "POST") {
      try {
        const body = await req.json() as { message?: string; stack?: string };
        debug(`client error: ${body.stack ?? body.message ?? "(no details)"}`);
        const classified = classifyBrowserError(body.message ?? "");
        return new Response(JSON.stringify(classified), {
          headers: { "Content-Type": "application/json" },
        });
      } catch {
        return new Response(null, { status: 204 });
      }
    }

    if (
      pathname === "/__aio/snapshot" && config.getSnapshot &&
      config.loadSnapshot
    ) {
      if (!req || req.method === "GET") {
        return new Response(config.getSnapshot(), {
          headers: {
            "Content-Type": "application/json",
            "Content-Disposition": 'attachment; filename="snapshot.json"',
          },
        });
      }
      // CSRF protection — require custom header (browsers won't add this cross-origin without preflight)
      if (req.method === "POST" && !req.headers.get("x-aio")) {
        return new Response("Missing X-AIO header", { status: 403 });
      }
      if (req.method === "POST") {
        // Fast reject when content-length header is present and already too large
        const clHeader = req.headers.get("content-length");
        if (clHeader !== null && Number(clHeader) > SNAPSHOT_MAX_SIZE) {
          return new Response(
            `Snapshot too large (max ${SNAPSHOT_MAX_SIZE} bytes)`,
            { status: 413 },
          );
        }
        try {
          const json = await req.text();
          if (json.length > SNAPSHOT_MAX_SIZE) {
            return new Response(
              `Snapshot too large (max ${SNAPSHOT_MAX_SIZE} bytes)`,
              { status: 413 },
            );
          }
          JSON.parse(json); // validate
          config.loadSnapshot(json);
          return new Response("OK", { status: 200 });
        } catch {
          return new Response("Invalid JSON", { status: 400 });
        }
      }
      return new Response("Method Not Allowed", { status: 405 });
    }

    // ── Health endpoint ──
    if (pathname === "/__aio/health" && config.getHealth) {
      try {
        const health = config.getHealth();
        return new Response(JSON.stringify(health, null, 2), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(
          JSON.stringify({ status: "error", error: String(e) }),
          {
            status: 503,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    // ── Vitals endpoint ──
    if (pathname === "/__aio/vitals" && config.vitalsSystem) {
      try {
        const data = config.vitalsSystem.getEndpointData();
        const pm = config.vitalsSystem.pressureMonitor;
        const payloadStats: Record<string, Record<string, unknown>> = {};
        for (const [id, stats] of _payloadStats) {
          payloadStats[id] = {
            ...stats,
            bytesPerSec: pm?.getBytesPerSec(id) ?? 0,
          };
        }
        const featureSizes = config.trojan
          ? config.vitalsSystem.computeFeatureSizes(
            config.trojan.getState() as Record<string, unknown>,
          )
          : {};
        // Server-side gauges
        const _gaugeOf = (name: string, current: number, capacity: number) => ({
          name,
          current,
          capacity,
          percent: capacity > 0
            ? Math.min(100, Math.round((current / capacity) * 100))
            : 0,
        });
        const loopVitals = config.vitalsSystem.loopProbe.getVitals();
        const serverGauges = {
          "server.queueDepth": _gaugeOf(
            "server.queueDepth",
            loopVitals.queueDepth,
            1000,
          ),
          "server.reduceTime": _gaugeOf(
            "server.reduceTime",
            loopVitals.p95ReduceTime,
            100,
          ),
        };
        // Per-client backpressure multipliers
        const clientBP: Record<string, number> = {};
        for (const [, meta] of connections) {
          clientBP[meta.id] = meta.bpMultiplier;
        }
        const responseData = {
          ...data,
          payloadStats,
          featureSizes,
          gauges: serverGauges,
          clientBackpressure: clientBP,
        };
        return new Response(JSON.stringify(responseData, null, 2), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(
          JSON.stringify({ status: "error", error: String(e) }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // ── Trojan: control REST API (localhost-only) ──
    // Moved under /__aio/trojan/ — internal framework endpoints, not user routes.
    // Rate-limited, CSRF-protected, dev-only endpoints gated in prod.
    if (config.trojan && pathname.startsWith("/__aio/trojan/")) {
      const route = pathname.slice("/__aio/trojan/".length);
      const trojan = config.trojan;
      const json = (data: unknown) =>
        new Response(JSON.stringify(data, null, 2), {
          headers: { "Content-Type": "application/json" },
        });
      const err = (msg: string, status = 400) =>
        new Response(JSON.stringify({ error: msg }), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      const method = req?.method ?? "GET";

      // Rate limiting — 100 requests/sec across all trojan endpoints
      _trojanReqCount++;
      if (!_trojanResetTimer) {
        _trojanResetTimer = setTimeout(() => {
          _trojanReqCount = 0;
          _trojanResetTimer = null;
        }, 1000);
      }
      if (_trojanReqCount > TROJAN_RATE_LIMIT) {
        return err("rate limit exceeded", 429);
      }

      // GET endpoints — inspect
      if (method === "GET") {
        if (route === "state") return json(trojan.getState());
        if (route === "ui") {
          const user = new URL(req!.url).searchParams.get("user") ?? undefined;
          const users = config.users;
          const aioUser = user && users
            ? Object.values(users).find((u) => u.id === user)
            : undefined;
          return json(getUIState(aioUser));
        }
        if (route === "clients") {
          const wsClients = [...connections.entries()].map(([ws, m]) => ({
            index: m.index,
            id: m.id,
            type: m.clientType,
            transport: "ws" as const,
            user: m.user?.id,
            readyState: ws.readyState,
          }));
          const udsClients = (trojan.udsClients?.() ?? []).map((c) => ({
            index: c.index,
            id: c.id,
            type: "electron" as const,
            transport: "uds" as const,
          }));
          return json([...wsClients, ...udsClients]);
        }
        // Send a message to a specific client and wait for __clientState: response
        const sendToClient = async (
          idx: number,
          msg: string,
        ): Promise<Response> => {
          // Try WebSocket clients first
          const wsEntry = [...connections.entries()].find(([, m]) =>
            m.index === idx
          );
          if (wsEntry) {
            const [ws, m] = wsEntry;
            if (ws.readyState !== 1) return err(`client ${idx} not ready`, 503);
            const statePromise = new Promise<unknown>((resolve) => {
              const timer = setTimeout(() => {
                pendingClientState.delete(m.id);
                resolve({ error: "client did not respond within 5s" });
              }, 5000);
              // Evict oldest if at capacity
              if (pendingClientState.size >= PENDING_STATE_MAX) {
                const oldest = pendingClientState.keys().next().value!;
                const entry = pendingClientState.get(oldest)!;
                clearTimeout(entry.timer);
                entry.resolve({ error: "evicted — too many pending requests" });
                pendingClientState.delete(oldest);
              }
              pendingClientState.set(m.id, { resolve, timer });
            });
            ws.send(msg);
            return json(await statePromise);
          }
          // Try UDS clients
          if (trojan.requestUdsClientState) {
            return json(await trojan.requestUdsClientState(idx, msg));
          }
          return err(`client ${idx} not connected`, 404);
        };

        // Dev-only: component tree introspection and click simulation
        if (route.startsWith("client/") && !prod) {
          const idx = Number(route.slice(7));
          if (!Number.isInteger(idx) || idx < 0) {
            return err("invalid client index", 400);
          }
          return sendToClient(idx, "__getState");
        }
        if (route.startsWith("click/") && !prod) {
          const rest = route.slice(6);
          const slashIdx = rest.indexOf("/");
          if (slashIdx === -1) {
            return err(
              "usage: click/<clientIndex>/<Component>:<index|prop:value>",
              400,
            );
          }
          const idx = Number(rest.slice(0, slashIdx));
          const target = decodeURIComponent(rest.slice(slashIdx + 1));
          if (!Number.isInteger(idx) || idx < 0) {
            return err("invalid client index", 400);
          }
          return sendToClient(idx, "__click:" + target);
        }
        // Dev-only: time-travel history and transpile errors
        if (route === "history") {
          if (prod) return err("dev-only endpoint", 403);
          return json(
            trojan.getTTHistory?.() ?? { entries: [], index: 0, paused: false },
          );
        }
        if (route === "errors") {
          if (prod) return err("dev-only endpoint", 403);
          const cutoff = Date.now() - 30_000;
          const allErrors = [...errorMap.values()].filter((e) => e.ts > cutoff)
            .flatMap((e) => e.errors);
          return json({ errors: allErrors });
        }
        if (route === "schedules") return json(trojan.getSchedules());
        if (route === "metrics") {
          return json({
            uptime: Math.round((Date.now() - trojan.startedAt) / 1000),
            connections: connections.size,
            schedules: trojan.getSchedules().length,
          });
        }
        if (route === "config") {
          return json({
            port,
            title,
            expose: config.expose ?? false,
            authMode: config.users
              ? "users"
              : config.token
              ? "token"
              : "public",
            prod: prod,
          });
        }
      }

      // POST endpoints — control (CSRF protected: require X-AIO header)
      if (method === "POST" && req) {
        if (!req.headers.get("x-aio")) {
          return err("Missing X-AIO header", 403);
        }
        // Audit log all trojan POST mutations
        debug(`[trojan] POST ${route}`);

        if (route === "dispatch") {
          try {
            const body = await req.text();
            const action = JSON.parse(body);
            if (!action || typeof action.type !== "string") {
              return err("missing type field");
            }
            // Strip user field — trojan dispatch should not allow user impersonation
            delete action.user;
            dispatch(action, undefined);
            return json({ ok: true });
          } catch {
            return err("invalid JSON");
          }
        }
        if (route === "snapshot") {
          if (!config.loadSnapshot) return err("snapshots not available", 501);
          try {
            const clHeader = req.headers.get("content-length");
            if (clHeader !== null && Number(clHeader) > SNAPSHOT_MAX_SIZE) {
              return err(
                `snapshot too large (max ${SNAPSHOT_MAX_SIZE} bytes)`,
                413,
              );
            }
            const body = await req.text();
            if (body.length > SNAPSHOT_MAX_SIZE) {
              return err(
                `snapshot too large (max ${SNAPSHOT_MAX_SIZE} bytes)`,
                413,
              );
            }
            JSON.parse(body); // validate
            config.loadSnapshot(body);
            return json({ ok: true });
          } catch {
            return err("invalid JSON");
          }
        }
        if (route === "tt") {
          if (prod) return err("dev-only endpoint", 403);
          if (!config.onTTCommand) return err("time-travel not active", 501);
          try {
            const body = await req.text();
            const { cmd, arg } = JSON.parse(body);
            if (!cmd || typeof cmd !== "string") {
              return err("missing cmd field");
            }
            if (cmd === "goto" && typeof arg === "number") {
              config.onTTCommand("goto", arg);
            } else config.onTTCommand(cmd);
            return json({ ok: true });
          } catch {
            return err("invalid JSON");
          }
        }
        if (route === "sql") {
          if (!trojan.sqlQuery) return err("SQLite not configured", 501);
          try {
            const body = await req.text();
            const { query } = JSON.parse(body);
            if (!query || typeof query !== "string") {
              return err("missing query field");
            }
            // Safety: block multi-statement, allow only SELECT (query goes through read-only worker)
            if (query.includes(";")) {
              return err("multi-statement queries not allowed", 403);
            }
            const normalized = query.trimStart().toUpperCase();
            if (
              !normalized.startsWith("SELECT ") &&
              !normalized.startsWith("SELECT\n") &&
              !normalized.startsWith("SELECT\t") && normalized !== "SELECT"
            ) {
              return err("trojan SQL is read-only — only SELECT allowed", 403);
            }
            // Block known dangerous patterns in subqueries/CTEs
            const upper = query.toUpperCase();
            if (
              /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|LOAD_EXTENSION|REINDEX|VACUUM)\b/
                .test(upper)
            ) {
              return err(
                "trojan SQL is read-only — write/DDL keywords forbidden",
                403,
              );
            }
            return json(await trojan.sqlQuery(query));
          } catch (e) {
            return err(String(e instanceof Error ? e.message : e));
          }
        }
        if (route === "persist") {
          if (!trojan.forcePersist) {
            return err("persistence not available", 501);
          }
          trojan.forcePersist();
          return json({ ok: true });
        }
        if (route === "shutdown") {
          if (!trojan.shutdown) return err("shutdown not available", 501);
          debug(`[trojan] shutdown requested`);
          // Respond first, then shut down (can't respond after process dies)
          const resp = json({ ok: true, msg: "shutting down" });
          queueMicrotask(() => trojan.shutdown!());
          return resp;
        }
      }

      return err("not found", 404);
    }

    // Prod: serve bundled assets from distDir
    if (
      prod && absDistDir &&
      (pathname === "/app.js" || pathname === "/style.css")
    ) {
      const file = pathname.slice(1); // strip leading /
      try {
        const body = await Deno.readTextFile(join(absDistDir, file));
        const ct = file.endsWith(".css")
          ? "text/css"
          : "application/javascript";
        return new Response(body, {
          headers: { "Content-Type": ct, ...noCache },
        });
      } catch {
        return new Response("Not Found", { status: 404 });
      }
    }

    const filename = pathname.replace(/^\//, "");
    const filepath = resolve(absBaseDir, filename);
    // Path traversal protection — resolved path must be inside baseDir
    // Normalize: avoid double separator when absBaseDir already ends with one (e.g. root drive C:\)
    const basePfx = absBaseDir.endsWith(SEPARATOR)
      ? absBaseDir
      : absBaseDir + SEPARATOR;
    if (!filepath.startsWith(basePfx)) {
      return new Response("Forbidden", { status: 403 });
    }
    const ext = extname(filepath);

    // SPA fallback: extensionless paths (not internal /__* APIs) that don't exist are client-side routes
    if (!ext && !pathname.startsWith("/__")) {
      let exists = false;
      try {
        await Deno.stat(filepath);
        exists = true;
      } catch { /* not found */ }
      if (!exists) {
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
            config.renderBudget,
          ),
          { headers: { "Content-Type": "text/html", ...noCache } },
        );
      }
    }

    const isText = TEXT_EXTENSIONS.has(ext);

    // Binary files — read as bytes, serve directly
    if (!isText) {
      try {
        const bytes = await Deno.readFile(filepath);
        return new Response(bytes, {
          headers: {
            "Content-Type": MIME[ext] ?? "application/octet-stream",
            ...noCache,
          },
        });
      } catch {
        return new Response("Not Found", { status: 404 });
      }
    }

    let body: string;
    try {
      body = await Deno.readTextFile(filepath);
    } catch {
      return new Response("Not Found", { status: 404 });
    }

    let contentType = MIME[ext] ?? "text/plain";

    // Dev only: live-transpile .ts/.tsx via esbuild
    if (!prod && (ext === ".tsx" || ext === ".ts")) {
      try {
        body = await transpile(body, filepath, debug);
        contentType = "application/javascript";
        lastError = "";
        errorMap.delete(filename);
      } catch (err) {
        const formatted = fmtEsbuildError(err, filename);
        debug(`transpile error: ${formatted}`);
        lastError = formatted;
        const rawMsgs = (err as { errors?: EsbuildMessage[] }).errors ?? [];
        errorMap.set(filename, {
          errors: rawMsgs.length
            ? rawMsgs.map((m) => ({
              text: m.text,
              file: m.location?.file ?? filename,
              line: m.location?.line,
              col: m.location?.column,
              lineText: m.location?.lineText,
            }))
            : [{ text: formatted }],
          ts: Date.now(),
        });
        for (const [f, e] of errorMap) {
          if (Date.now() - e.ts > 60_000) errorMap.delete(f);
        }
        return new Response(
          `throw new Error(${JSON.stringify(lastError)})`,
          {
            status: 200,
            headers: { "Content-Type": "application/javascript", ...noCache },
          },
        );
      }
    }

    return new Response(body, {
      headers: { "Content-Type": contentType, ...noCache },
    });
  }

  // File watcher — debounced live reload on src/ changes
  // CSS-only changes send __css (inject without page reload), mixed changes send __reload
  const RELOAD_EXT = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".css",
    ".html",
    ".json",
    ".svg",
  ]);
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  let reloadIsFull = false;
  function scheduleReload(path: string): void {
    // Skip editor temp files, swap files, lockfiles, etc.
    const dot = path.lastIndexOf(".");
    const ext = dot >= 0 ? path.slice(dot) : "";
    if (!RELOAD_EXT.has(ext)) return;
    debug(`watch: changed ${path}`);
    // Normalize to match cache keys — resolve symlinks (e.g. /var → /private/var on macOS)
    path = normPath(path);
    transpileCache.delete(path);
    if (!path.endsWith(".css")) reloadIsFull = true;
    if (reloadTimer) clearTimeout(reloadTimer);
    // 100ms debounce — batch rapid file changes into single reload
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      const wasFullReload = reloadIsFull;
      reloadIsFull = false;

      (async () => {
        // Re-validate import graph on file change (dev mode only)
        if (!prod && fileExists(join(absBaseDir, "App.tsx"))) {
          const timeout = new Promise<null>((r) =>
            setTimeout(() => r(null), 2000)
          );
          const validation = validateGraph(
            join(absBaseDir, "App.tsx"),
            importMapObj,
            transpile,
          );
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

        if (!prod && graphResult && !graphResult.valid) {
          // Graph is red — send error info to clients, suppress normal reload
          const errJson = JSON.stringify(graphResult.errors);
          for (const ws of connections.keys()) {
            try {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send("__graph_error:" + errJson);
              }
            } catch { /* disconnecting */ }
          }
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
          // Was red, now green — tell clients to reload
          graphWasRed = false;
          debug("graph: ✓ all errors fixed — reloading");
          for (const ws of connections.keys()) {
            try {
              if (ws.readyState === WebSocket.OPEN) ws.send("__graph_clear");
            } catch { /* disconnecting */ }
          }
          config.onReload?.("__reload");
        } else {
          // Normal reload (no graph issues)
          const signal = wasFullReload ? "__reload" : "__css";
          debug(`${signal} → ${connections.size} client(s)`);
          for (const ws of connections.keys()) {
            try {
              if (ws.readyState === WebSocket.OPEN) ws.send(signal);
            } catch { /* disconnecting */ }
          }
          config.onReload?.(signal as "__reload" | "__css");
        }
      })().catch((err) => debug(`graph: unexpected error — ${err}`));
    }, 100);
  }

  // Dev only: watch src/ for changes and live-reload
  let fsWatcher: Deno.FsWatcher | null = null;
  let watcherActive = false;
  let healthTimer: ReturnType<typeof setInterval> | null = null;
  const SENTINEL = `/tmp/aio-watch-${config.port}.tmp`;
  let lastWatcherEvent = Date.now();
  let watcherRestarts = 0;
  const MAX_WATCHER_RESTARTS = 3;

  function startWatcher(): boolean {
    try {
      fsWatcher = Deno.watchFs([absBaseDir, SENTINEL], { recursive: true });
      watcherActive = true;
      (async () => {
        try {
          for await (const event of fsWatcher!) {
            if (event.kind === "access") continue;
            // Sentinel touch — update liveness timestamp, don't trigger reload
            if (event.paths.some((p) => p.includes("aio-watch-"))) {
              lastWatcherEvent = Date.now();
              continue;
            }
            lastWatcherEvent = Date.now();
            for (const path of event.paths) scheduleReload(path);
          }
        } catch (e) {
          watcherActive = false;
          console.warn(`[aio] live reload stopped: ${e}`);
        }
      })();
      return true;
    } catch (e) {
      console.warn(`[aio] live reload failed — hot reload disabled: ${e}`);
      return false;
    }
  }

  if (!prod) {
    // Ensure sentinel exists before watchFs — some systems throw if watched path is missing
    try {
      Deno.writeTextFileSync(SENTINEL, "");
    } catch { /* /tmp not writable — skip sentinel */ }
    if (startWatcher()) {
      console.log(`[aio] live reload watching ${config.baseDir}`);
    }
    // Health check — touch sentinel every 30s, restart watcher if no events for 60s
    healthTimer = setInterval(() => {
      try {
        Deno.writeTextFileSync(SENTINEL, String(Date.now()));
      } catch { /* /tmp not writable — skip */ }
      if (watcherActive && Date.now() - lastWatcherEvent > 60_000) {
        watcherRestarts++;
        if (watcherRestarts > MAX_WATCHER_RESTARTS) {
          console.warn(
            `[aio] live reload — watcher unresponsive after ${MAX_WATCHER_RESTARTS} restarts, giving up`,
          );
          if (healthTimer) {
            clearInterval(healthTimer);
            healthTimer = null;
          }
          return;
        }
        console.warn(
          `[aio] live reload — watcher unresponsive, restarting (${watcherRestarts}/${MAX_WATCHER_RESTARTS})`,
        );
        try {
          fsWatcher?.close();
        } catch { /* already closed */ }
        startWatcher();
      }
    }, 30_000);
  }

  const hostname = config.expose ? "0.0.0.0" : "127.0.0.1";
  const tlsOpts = config.cert && config.key
    ? { cert: config.cert, key: config.key }
    : {};

  // Auth-free handler for trojan server (127.0.0.1-only) — routes control endpoints without token checks
  const handleTrojan = async (
    req: Request,
    pathname: string,
  ): Promise<Response> => {
    return await serveStatic(pathname, req);
  };

  // Extracted handler — reused by main server (with auth gates)
  const handleRequest = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const { pathname } = url;

    // Auth path 1: per-user token map — resolve user or reject
    if (config.users) {
      const user = resolveUser(config.users, url, req);
      if (!user) return new Response("Unauthorized", { status: 401 });
      if (pathname === "/ws") return handleWs(req, user);
      debug(`http: ${req.method} ${pathname} user=${user.id}`);
      const resp = await serveStatic(pathname, req);
      resp.headers.set("X-Content-Type-Options", "nosniff");
      return resp;
    }

    // Auth path 2: single shared token (--expose without users)
    if (config.token) {
      const qToken = url.searchParams.get("token");
      const auth = req.headers.get("authorization");
      const hToken = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      const validQ = qToken !== null && _timingSafeEqual(qToken, config.token);
      const validH = hToken !== null && _timingSafeEqual(hToken, config.token);
      if (!validQ && !validH) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    if (pathname === "/ws") return handleWs(req);
    debug(`http: ${req.method} ${pathname}`);
    const resp = await serveStatic(pathname, req);
    resp.headers.set("X-Content-Type-Options", "nosniff");
    return resp;
  };

  let httpServer: Deno.HttpServer;
  const udsPath = config.socketPath;
  if (udsPath) {
    // UDS mode — clean up stale socket file before binding
    try {
      Deno.removeSync(udsPath);
    } catch { /* doesn't exist — fine */ }
    httpServer = Deno.serve(
      { path: udsPath, onListen: () => {} },
      handleRequest,
    );
  } else {
    try {
      httpServer = Deno.serve({
        port,
        hostname,
        onListen: () => {},
        ...tlsOpts,
      }, handleRequest);
    } catch (e) {
      if (e instanceof Deno.errors.AddrInUse) {
        throw new Error(
          `port ${port} already in use — pick another with --port=N`,
        );
      }
      throw e;
    }
  }

  // When TLS is active: spin up a plain-HTTP server on 127.0.0.1 (OS-assigned port) for am tooling.
  // am always communicates over HTTP — avoids needing cert trust in CLI tools.
  let trojanServer: Deno.HttpServer | null = null;
  let trojanPort: number | undefined;
  if (config.cert) {
    trojanServer = Deno.serve(
      {
        port: 0,
        hostname: "127.0.0.1",
        onListen: (addr) => {
          trojanPort = addr.port;
        },
      },
      (req) => {
        const { pathname } = new URL(req.url);
        // Trojan server is 127.0.0.1-only — bypass auth, route control endpoints directly
        if (
          pathname.startsWith("/__aio/") ||
          pathname.startsWith("/__aio/snapshot") ||
          pathname.startsWith("/__aio/health")
        ) {
          return handleTrojan(req, pathname);
        }
        // Health probe for `am status`
        if (pathname === "/") return new Response("ok", { status: 200 });
        return new Response("Not Found", { status: 404 });
      },
    );
  }

  // Sends TT metadata to all connected clients
  function broadcastTT(): void {
    if (!config.getTTBroadcast) return;
    try {
      const ttData = "__tt:" + JSON.stringify(config.getTTBroadcast());
      for (const [ws] of connections) {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(ttData);
          } catch { /* client disconnecting */ }
        }
      }
    } catch (e) {
      debug(`broadcastTT error: ${e}`);
    }
  }

  return {
    broadcast,
    broadcastTT,
    clientCount: () => connections.size,
    trojanPort,
    socketPath: udsPath,
    watcherActive,
    shutdown: async () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      if (broadcastThrottle) {
        clearTimeout(broadcastThrottle);
        broadcastThrottle = null;
      }
      if (_trojanResetTimer) {
        clearTimeout(_trojanResetTimer);
        _trojanResetTimer = null;
      }
      fsWatcher?.close();
      if (healthTimer) {
        clearInterval(healthTimer);
        healthTimer = null;
      }
      try {
        Deno.removeSync(SENTINEL);
      } catch { /* already gone */ }
      // Clear all per-client timers before closing sockets
      for (const [ws, meta] of connections) {
        if (meta.msgResetTimer) {
          clearTimeout(meta.msgResetTimer);
          meta.msgResetTimer = undefined;
        }
        if (meta.typeDetectTimer) {
          clearTimeout(meta.typeDetectTimer);
          meta.typeDetectTimer = undefined;
        }
        try {
          ws.close(1001, "server shutting down");
        } catch { /* already closing */ }
      }
      connections.clear();
      // Clear pending client state request timers
      for (const [, pending] of pendingClientState) clearTimeout(pending.timer);
      pendingClientState.clear();
      if (graphValidationDone) await graphValidationDone.catch(() => {});
      await Promise.all([
        httpServer.shutdown(),
        trojanServer?.shutdown(),
      ]);
      await stopEsbuild();
      // Clean up UDS socket file
      if (udsPath) {
        try {
          Deno.removeSync(udsPath);
        } catch { /* already removed */ }
      }
    },
  };
}
