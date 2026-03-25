// Core runtime — boots KV, server, electron, wires everything together
import { skv, type SkvInstance } from "./skv.ts";
import { loadOrCreateCert, type TlsCert } from "./tls.ts";
import { _computeDelta, createServer, type ServerHandle } from "./server.ts";
import {
  type AioMeta,
  launchElectron,
  launchElectronClient,
} from "./electron.ts";
import { dirname, join, resolve } from "@std/path";
import { deepMerge } from "./deep-merge.ts";
import { createDispatch, type PerfBudget } from "./dispatch.ts";
import {
  type AioError,
  createAioError,
  reportError as reportAioError,
  type ReportErrorOpts,
} from "./error.ts";
import {
  createTT,
  markError,
  pause,
  type PerfMetric,
  record,
  redo,
  type ReduceBreakdown,
  resume,
  stateAt,
  toBroadcast,
  travelTo,
  type TTState,
  undo,
} from "./time-travel.ts";
import { createMemoryMonitor, type MemoryConfig } from "./memory-monitor.ts";
import {
  createScheduleManager,
  isScheduleEffect,
  type ScheduleDef,
  type ScheduleEffect,
} from "./schedule.ts";
import {
  createDB,
  type DB,
  initSchema,
  loadTables,
  syncTables,
} from "./db/mod.ts";
import type { TableDef } from "./sql.ts";
import { AppLock, lockDir, resolveAppId } from "./single-instance-lock.ts";
import {
  bindFeature,
  type CircuitBreakerConfig,
  type ComposedFeatures,
  composeFeatures,
  type FeatureDef,
  type FeatureEntry,
  type FeatureStatus,
} from "./feature.ts";
import {
  AioLogger,
  getLogger,
  log,
  type LogConfig,
  setLogger,
} from "./logger.ts";
import {
  type CheckpointData,
  type DiagnosticsConfig,
  initDiagnostics,
} from "./diagnostics/mod.ts";
import { resolveOptions as resolveDiagOptions } from "./diagnostics/types.ts";
import { diagEmit } from "./diagnostic-bus.ts";
import type { RenderBudget } from "./vitals/types.ts";
import { createVitalsSystem, type VitalsSystem } from "./vitals/mod.ts";

/** Framework version — defined in aio-cli.ts, re-exported here */
export { VERSION } from "./aio-cli.ts";
import { VERSION } from "./aio-cli.ts";

/** Validates that framework version matches deno.json version at build time */
function validateVersion(): void {
  try {
    // This check runs at build time for compile targets
    // At runtime in dev mode, deno.json may not be accessible
    const denoJson = new URL("../../deno.json", import.meta.url);
    const content = Deno.readTextFileSync(denoJson);
    const parsed = JSON.parse(content) as { version?: string };
    if (parsed.version && parsed.version !== VERSION) {
      log.warn(
        "aio",
        `version mismatch: aio.ts=${VERSION}, deno.json=${parsed.version}`,
      );
    }
  } catch { /* deno.json not accessible at runtime — skip */ }
}

// Run validation on first import
validateVersion();

/** User identity — resolved from static token map */
export type AioUser = { id: string; role: string };
export type { AioError } from "./error.ts";
export type { PerfBudget, PerfCheck } from "./dispatch.ts";

/** Window + UI sync options — applies to both Electron and browser clients */
export type UiConfig = {
  title?: string; // default: 'AIO App'
  width?: number; // default: 800
  height?: number; // default: 600
  showStatus?: boolean; // default: true
};

/** Default broadcast throttle: 50ms = max 20 state pushes/sec */
export const DEFAULT_SYNC_INTERVAL_MS = 50;

/** Everything aio.run() needs to wire your app */
export type AioConfig<S, A, E> = {
  /** Unique app identity — used for lock file, UDS socket, KV/SQLite paths, TLS cert dir. Mandatory. */
  appId: string;
  reduce: (
    state: S,
    action: A,
  ) => { state: S; effects: (E | ScheduleEffect)[] };
  execute: (app: AioApp<S, A>, effect: E) => void;
  persist?: boolean; // default: true — auto-opens Deno.Kv
  stateForDB?: (state: S) => Partial<S>; // filter what gets persisted (default: full state)
  stateForUI?: (state: S, user?: AioUser) => unknown; // filter what gets sent to UI (default: full state)
  fullStateThreshold?: number; // 0-1: ratio of changed keys that triggers full state broadcast (default: 0.5)
  syncIntervalMs?: number; // default: 50 — max 1 state push per N ms (0 = microtask coalescing only)
  maxConnections?: number; // max concurrent WebSocket clients (default: 100)
  beforeReduce?: (action: A, state: S, user?: AioUser) => A | null; // intercept actions before reduce — return null to drop
  persistKey?: string; // KV key prefix (default: "state")
  persistDebounceMs?: number; // ms between KV writes (default: 100)
  persistMode?: "single" | "multi"; // 'single' (default): one blob ≤65KB. 'multi': one KV key per top-level state key — no 65KB limit
  users?: Record<string, AioUser>; // static token map — token is key, user is value
  ui?: UiConfig;
  port?: number; // default: 8000
  baseDir?: string; // default: ./src
  client?: "electron" | "browser" | "cli" | "server-only"; // default: 'electron'
  keepServer?: boolean; // default: false — keep server running after client closes (moved from ui.keepAlive)
  transport?: "uds" | "ws" | "auto"; // default: 'auto' — UDS on linux/mac+electron, WS otherwise (moved from ui.transport)
  killExisting?: boolean; // default: false
  serverUrl?: string;
  appVersion: string; // app version string — logged on startup, available at __aio.appVersion
  schedules?: ScheduleDef[]; // static scheduled effects — started on boot
  db?: Record<string, TableDef>; // SQLite table definitions — arrays auto-sync
  perfCheck?: "on" | "off"; // default: 'on' — enable/disable performance violation reporting
  perfBudget?: PerfBudget; // override default budgets (reduce: 100, effect: 5)
  renderBudget?: RenderBudget; // override render staleness/patch thresholds (sent to browser)
  effectTimeoutMs?: number; // ms before logging a warning for slow async effects — warning only, does not cancel (default: 30000 = 30s)
  freezeState?: boolean; // default: false in prod, true in dev — deep freeze state after reduce to catch mutations
  memory?: MemoryConfig; // memory pressure monitoring config
  circuitBreaker?: CircuitBreakerConfig; // auto-disable features after N errors
  onRestore?: (state: S) => S; // transform state after restore, before server starts
  singleton?: boolean; // true (default)=refuse if running, false=allow multi
  // Lifecycle hooks — observe-only, all optional, error-guarded
  onAction?: (action: A, state: S, user?: AioUser) => void;
  onEffect?: (effect: E, user?: AioUser) => void;
  onConnect?: (user?: AioUser) => void;
  onDisconnect?: (user?: AioUser) => void;
  onStart?: (app: AioApp<S, A>) => void;
  onStop?: () => void;
  onError?: (error: AioError) => void;
  /** Internal: schedule cancel callback set by _run, used by features disable */
  _onScheduleReady?: (cancelByPrefix: (prefix: string) => void) => void;
  /** Internal: diagnostics config passed from FeaturesConfig */
  _diagnostics?: DiagnosticsConfig;
  /** Internal: checkpoint restore callback passed from FeaturesConfig */
  _onCheckpointRestore?: (
    checkpoint: CheckpointData,
  ) => Record<string, unknown> | null;
  /** Internal: composed feature names — passed from FeaturesConfig for diagnostics */
  _featureNames?: string[];
  /** Internal: health getter factory — passed from FeaturesConfig for diagnostics */
  _healthGetter?: (
    state: unknown,
  ) => Record<string, { errors: number; enabled: boolean }>;
  /** Internal: reduce breakdown getter — passed from FeaturesConfig via composeFeatures */
  _reduceBreakdown?: () => ReduceBreakdown | undefined;
};

/** Handle returned by aio.run() — dispatch actions, read state, or shut down */
export type AioApp<S = unknown, A = unknown> = {
  dispatch: (action: A) => Promise<void>;
  getState: () => S;
  snapshot?: () => string; // server-only (undefined in standalone)
  loadSnapshot?: (json: string) => void; // server-only (undefined in standalone)
  db?: DB; // async SQLite — query/execute/transaction (undefined in standalone)
  close: () => Promise<void>;
  mode?: string; // 'standalone' in Android WebView builds — branch effects accordingly
  port?: number; // server port — available after aio.run(), useful for connectCli()
  /** v0.5 feature control API — only available when using features-based config */
  features?: {
    enable: (name: string) => void;
    disable: (name: string) => void;
    status: (name: string) => string | undefined;
    health: () => FeatureStatus[];
    list: () => string[];
  };
};

/** Composes multiple beforeReduce functions into one. */
export function composeMiddleware<S, A>(
  ...fns: NonNullable<AioConfig<S, A, unknown>["beforeReduce"]>[]
): (action: A, state: S, user?: AioUser) => A | null {
  return (action: A, state: S, user?: AioUser): A | null => {
    let result: A | null = action;
    for (const fn of fns) {
      if (result === null) return null;
      result = fn(result, state, user);
    }
    return result;
  };
}

// ── Middleware factories ─────────────────────────────────────────────

/** Middleware function — intercepts actions before reduce */
export type MiddlewareFn = (
  action: unknown,
  state: unknown,
  user?: AioUser,
) => unknown | null;

/** Built-in middleware factories for aio.run({ middleware: [...] }) */
const middleware = {
  /** Log all dispatched actions (or filter by feature name) */
  logger: (opts?: { features?: string[] }): MiddlewareFn => {
    const filter = opts?.features
      ? new Set(opts.features.map((f) => f.toLowerCase()))
      : null;
    return (action, _state) => {
      const type = (action as { type: string }).type;
      if (filter) {
        const prefix = type.split(":")[0]?.toLowerCase() ?? "";
        if (!filter.has(prefix)) return action;
      }
      const source = (action as { _source?: string })._source;
      const tag = source ? ` [${source}]` : "";
      log.debug("action", `${tag.slice(1, -1) || "-"} ${type}`);
      return action;
    };
  },

  /** Redux DevTools integration — connects state to browser devtools extension */
  devtools: (): MiddlewareFn => {
    return (action, _state) => action; // actual connection handled by connectDevTools() in browser
  },

  /** Performance budget — warn/error if reduce takes too long */
  perfBudget: (opts: { reduce?: number; effect?: number }): MiddlewareFn => {
    return (action, _state) => {
      // Perf budgets are already handled by createDispatch — this middleware
      // allows overriding via the middleware array as well
      const type = (action as { type: string }).type;
      const start = performance.now(); // Store start time for post-reduce check (side-channel via global)
      (globalThis as Record<string, unknown>).__aioMiddlewarePerfStart = start;
      (globalThis as Record<string, unknown>).__aioMiddlewarePerfBudget = opts;
      void type; // used for logging in perf violations
      return action;
    };
  },

  /** Validate action shapes — ensure type is string, payload is plain object */
  validate: (): MiddlewareFn => {
    return (action, _state) => {
      const a = action as Record<string, unknown>;
      if (typeof a.type !== "string") {
        log.error(
          "middleware",
          `action.type must be a string, got ${typeof a.type}`,
        );
        return null;
      }
      if (
        a.payload !== undefined &&
        (typeof a.payload !== "object" || a.payload === null ||
          Array.isArray(a.payload))
      ) {
        log.warn(
          "middleware",
          `action.payload should be a plain object: ${a.type}`,
        );
      }
      return action;
    };
  },

  /** Track action counts, timing, error rates per feature */
  metrics: (): MiddlewareFn => {
    const counters = new Map<string, { count: number; errors: number }>();
    (globalThis as Record<string, unknown>).__aioMetrics = counters;
    return (action, _state) => {
      const type = (action as { type: string }).type;
      const prefix = type.split(":")[0] ?? "unknown";
      const entry = counters.get(prefix) ?? { count: 0, errors: 0 };
      entry.count += 1;
      counters.set(prefix, entry);
      return action;
    };
  },

  /** Deep freeze state after reduce (catches accidental mutations in dev) */
  freeze: (): MiddlewareFn => {
    // Actual freezing handled by dispatch.ts freezeState option
    return (action, _state) => action;
  },

  /** Create custom middleware — return modified action, or null to drop.
   *  `pass` is identity — call it to signal the action should continue unmodified.
   *  The return value determines what happens: return action to continue, null to drop. */
  create: (
    fn: (
      action: unknown,
      state: unknown,
      pass: (action: unknown) => unknown,
      user?: AioUser,
    ) => unknown,
  ): MiddlewareFn => {
    return (action, state, user) => fn(action, state, (a) => a, user);
  },
};

// ── Startup linter — validates config and src/ before running ───────

/** Startup lint result — ok/warn/hint/fail arrays */
export type Lint = {
  ok: string[];
  warn: string[];
  hint: string[];
  fail: string[];
};

/** Checks state, config, App.tsx existence, and common mistakes */
export async function lint(
  state: unknown,
  config: { reduce?: unknown; execute?: unknown },
  baseDir: string,
  prod = false,
  headless = false,
  useElectron = true,
): Promise<Lint> {
  const r: Lint = { ok: [], warn: [], hint: [], fail: [] };

  if (state == null) r.fail.push("initial state is null/undefined");
  else if (typeof state !== "object") {
    r.fail.push(`initial state must be an object, got ${typeof state}`);
  } else {
    const keys = Object.keys(state as Record<string, unknown>);
    r.ok.push(`state (${keys.length} keys)`);
    const reserved = keys.filter((k) => k === "$p" || k === "$d");
    if (reserved.length) {
      r.warn.push(
        `state has reserved key(s): ${
          reserved.join(", ")
        } — rename them (e.g. $p → _patch, $d → _delete). These are used internally for delta patches and will cause data corruption.`,
      );
    }
    // Check JSON-serializability — Date, Map, Set, functions etc. break persistence/broadcast
    try {
      const json = JSON.stringify(state);
      const after = JSON.stringify(JSON.parse(json));
      if (json !== after) {
        r.warn.push(
          "state loses data on JSON round-trip — use primitives + plain objects/arrays only (no Date, Map, Set, functions, BigInt)",
        );
      }
    } catch (e) {
      r.warn.push(`state is not JSON-serializable: ${e}`);
    }
  }

  if (typeof config.reduce !== "function") {
    r.fail.push(
      "config.reduce must be a function: (state, action) => { state, effects }",
    );
  } else r.ok.push("reduce");

  if (typeof config.execute !== "function") {
    r.fail.push("config.execute must be a function: (app, effect) => void");
  } else r.ok.push("execute");

  // Prod mode or headless: App.tsx not needed
  if (headless) {
    r.ok.push("headless (no App.tsx)");
  } else if (prod) {
    r.ok.push("prod");
  } else {
    const appFile = join(baseDir, "App.tsx");
    try {
      const src = await Deno.readTextFile(appFile);
      if (!src.includes("export default")) {
        r.warn.push(
          "App.tsx has no `export default` — add it so the framework can mount your component",
        );
      } else {
        r.ok.push("App.tsx");
      }
      if (src.includes("createRoot")) {
        r.hint.push(
          "App.tsx has createRoot — remove it, the framework handles mounting",
        );
      }
      if (/import\s+React[\s,{]/.test(src)) {
        r.hint.push(
          "App.tsx has `import React` — not needed, JSX transforms are automatic",
        );
      }
    } catch {
      r.fail.push(`App.tsx not found at ${appFile}`);
      r.hint.push(
        "  create it: export default function App() { return <div>Hello</div> }",
      );
    }
  }

  // Specifiers available in the browser import map — everything else silently fails
  // Keep in sync with IMPORT_MAP in server.ts
  const BROWSER_IMPORTS = new Set([
    "react",
    "react-dom/client",
    "react/jsx-runtime",
    "aio",
  ]);

  try {
    for await (const entry of Deno.readDir(baseDir)) {
      if (!entry.isFile) continue;
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      const content = await Deno.readTextFile(join(baseDir, entry.name));
      if (
        content.includes("from '../dep/aio/") ||
        content.includes('from "../dep/aio/')
      ) {
        r.hint.push(
          `${entry.name}: import from 'aio' instead of '../dep/aio/...'`,
        );
      }
      // Check execute.ts for swapped params — first param named 'effect' suggests old (effect, app) order
      if (entry.name === "execute.ts") {
        const match = content.match(/function\s+execute\s*\(\s*(\w+)/);
        if (match && /^effect$/i.test(match[1] ?? "")) {
          r.hint.push(
            `execute.ts: first param is "${
              match[1]
            }" — signature is execute(app, effect), matching reduce(state, action)`,
          );
        }
        // Check for sync I/O anti-patterns
        if (
          content.includes("Deno.readTextFileSync") ||
          content.includes("Deno.readDirSync") ||
          content.includes("Deno.statSync")
        ) {
          r.warn.push(
            "execute.ts: sync I/O (readTextFileSync, readDirSync, statSync) blocks the dispatch loop — use async versions (readTextFile, readDir, stat) instead",
          );
        }
        if (content.includes("Deno.writeTextFileSync")) {
          r.warn.push(
            "execute.ts: sync file write (writeTextFileSync) blocks — use async writeTextFile instead",
          );
        }
      }
      // Check reduce.ts for heavy patterns
      if (entry.name === "reduce.ts") {
        if (/for\s*\([^)]+\)\s*\{[^}]{500}/.test(content)) {
          r.hint.push(
            "reduce.ts: large loop detected — consider moving heavy computation to an effect",
          );
        }
      }
      // Check .tsx files for imports that won't resolve in the browser
      // Dev mode transpiles but doesn't bundle — only import-mapped specifiers work
      if (!prod && entry.name.endsWith(".tsx")) {
        // Bare side-effect imports: import 'foo'
        for (
          const m of content.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)
        ) {
          const spec = m[1];
          if (
            !spec || spec.startsWith(".") || spec.startsWith("/") ||
            BROWSER_IMPORTS.has(spec)
          ) continue;
          r.warn.push(
            `${entry.name}: import "${spec}" won't work in browser — dev mode transpiles but doesn't bundle. Move this import to a server-side .ts file, or use the npm package via an effect.`,
          );
        }
        // Named/default imports and re-exports: import { x } from 'foo', export { x } from 'foo'
        for (
          const m of content.matchAll(
            /(?:import|export)\s+.*?\s+from\s+['"]([^'"]+)['"]/g,
          )
        ) {
          const spec = m[1];
          if (
            !spec || spec.startsWith(".") || spec.startsWith("/") ||
            BROWSER_IMPORTS.has(spec)
          ) continue;
          // import type is erased by TS — never reaches the browser
          if (
            m[0].startsWith("import type ") || m[0].startsWith("import type{")
          ) continue;
          r.warn.push(
            `${entry.name}: import "${spec}" won't work in browser — dev mode transpiles but doesn't bundle. Move this import to a server-side .ts file, or use the npm package via an effect.`,
          );
        }
      }
    }
  } catch { /* baseDir doesn't exist — already caught above */ }

  // Check esbuild — needed for dev mode TSX transpilation
  if (!prod) {
    const esbuildDir = join(Deno.cwd(), "node_modules", "esbuild");
    const esbuildBin = join(Deno.cwd(), "node_modules", ".bin", "esbuild");
    let esbuildFound = false;
    try {
      await Deno.stat(esbuildDir);
      esbuildFound = true;
    } catch { /* try bin */ }
    if (!esbuildFound) {
      try {
        await Deno.stat(esbuildBin);
        esbuildFound = true;
      } catch { /* not found */ }
    }
    if (!esbuildFound) {
      r.warn.push(
        "esbuild not installed — dev mode needs it for TSX transpilation",
      );
    }
  }

  // Check electron install scripts — only relevant when actually running in Electron mode
  if (!prod && useElectron) {
    try {
      const electronDir = join(Deno.cwd(), "node_modules", "electron", "dist");
      await Deno.stat(electronDir);
    } catch {
      try {
        // electron package exists but dist/ missing → scripts not approved
        await Deno.stat(join(Deno.cwd(), "node_modules", "electron"));
        r.hint.push(
          "electron installed but dist/ missing — run `deno task install:electron`",
        );
      } catch { /* electron not installed at all — handled by electron.ts */ }
    }
  }

  return r;
}

/** Formats lint results — compact when clean, detailed when issues found */
function printLint(r: Lint): void {
  const hasIssues = r.warn.length + r.hint.length + r.fail.length > 0;
  if (!hasIssues) {
    log.info(`✓ ${r.ok.join(" · ")}`);
    return;
  }
  log.info("── checks ──");
  if (r.ok.length) log.info(`  ✓ ${r.ok.join(" · ")}`);
  for (const w of r.warn) log.warn(w);
  for (const h of r.hint) log.info(`  · ${h}`);
  for (const e of r.fail) log.error(e);
  if (r.fail.length) {
    throw new Error(`${r.fail.length} error(s) — fix and restart`);
  }
}

// ── CLI (extracted to aio-cli.ts) ────────────────────────────────────
export { parseCli, printHelp } from "./aio-cli.ts";
export type { CliFlags } from "./aio-cli.ts";
import { parseCli, printHelp } from "./aio-cli.ts";

// ── KV path resolution ──────────────────────────────────────────────

// When inside an AppImage (or any compiled binary without a writable origin),
// Deno.openKv() default path lives in the read-only squashfs mount → fails.
// Use an explicit path in XDG_DATA_HOME / ~/.local/share/<app>/data.kv instead.
/** True when running inside a compiled binary (AppImage, deno compile) */
function isCompiled(): boolean {
  return !!Deno.env.get("APPIMAGE") || !import.meta.url.startsWith("file:///");
}

/** Resolves persistent data dir — ~/.local/share/<appId>/ */
function resolveDataDir(appId: string): string {
  const dataHome = Deno.env.get("XDG_DATA_HOME") ??
    join(homedir(), ".local", "share");
  const dir = join(dataHome, appId);
  Deno.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Resolves KV path — compiled: ~/.local/share/<appId>/data.kv, dev: Deno default */
function resolveKvPath(appId: string): string | undefined {
  if (!isCompiled()) return undefined; // dev mode — let Deno pick
  return join(resolveDataDir(appId), "data.kv");
}

/** Resolves SQLite path — compiled: ~/.local/share/<appId>/data.db, dev: ./data.db */
function resolveDbPath(appId: string): string {
  if (!isCompiled()) return join(Deno.cwd(), "data.db");
  return join(resolveDataDir(appId), "data.db");
}

/** Returns user home directory — $HOME or $USERPROFILE, throws if neither set */
function homedir(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home) {
    throw new Error(
      "Cannot determine home directory — set $HOME environment variable",
    );
  }
  return home;
}

// ── UDS (Unix Domain Socket) ────────────────────────────────────────

/** Resolves transport: UDS on linux/mac with electron, WS otherwise */
function resolveTransport(
  transport: "uds" | "ws" | "auto" | undefined,
  useElectron: boolean,
  expose: boolean,
): "uds" | "ws" {
  if (transport === "ws") return "ws";
  if (transport === "uds") return "uds";
  // auto: UDS for electron on linux/mac (not Windows, not --expose)
  if (
    useElectron && !expose &&
    (Deno.build.os === "linux" || Deno.build.os === "darwin")
  ) return "uds";
  return "ws";
}

/** Resolves UDS socket path — /tmp/aio/{appId}.sock (same dir as lock files) */
function resolveSocketPath(appId: string): string {
  const dir = lockDir();
  const sockPath = join(dir, `${appId}.sock`);
  // Linux UDS path limit is 108 chars
  if (sockPath.length > 100) {
    log.warn(
      `UDS path is ${sockPath.length} chars (limit ~108) — using /tmp/aio fallback`,
    );
    return join("/tmp/aio", `${appId}.sock`);
  }
  return sockPath;
}

/** Find a free port in the private/ephemeral range 49152–65535 by attempting to bind */
function findFreePort(): number {
  for (let i = 0; i < 50; i++) {
    const port = 49152 + Math.floor(Math.random() * 16384); // 49152–65535
    try {
      const l = Deno.listen({ port, hostname: "127.0.0.1" });
      l.close();
      return port;
    } catch { /* taken — try another */ }
  }
  throw new Error("no free port found in 49152–65535 after 50 attempts");
}

type UDSClient = { conn: Deno.Conn; index: number; id: string };
type UDSHandle = {
  broadcast: (msg: string) => void;
  shutdown: () => void;
  socketPath: string;
  /** List connected UDS clients */
  clients: () => UDSClient[];
  /** Send a message to a specific UDS client by index, wait for __clientState: response */
  requestClientState: (index: number, msg?: string) => Promise<unknown>;
};

/** Creates a raw NDJSON listener on a Unix domain socket for Electron IPC bridge.
 *  Same messages as WS (state JSON, __reload, __css, __tt:, __boot:), just newline-delimited. */
export function createUDSListener(
  socketPath: string,
  getUIState: () => unknown,
  onAction: (action: { type: string; payload?: unknown }) => void,
  debug: (msg: string) => void,
  clientCounter?: { value: number },
): UDSHandle {
  // Clean up stale socket
  try {
    Deno.removeSync(socketPath);
  } catch { /* doesn't exist */ }

  const listener = Deno.listen({ transport: "unix", path: socketPath });
  const connSet = new Set<Deno.Conn>();
  const clientMap = new Map<Deno.Conn, UDSClient>();
  const counter = clientCounter ?? { value: 0 };
  let closed = false;

  // Pending client state requests
  const pendingState = new Map<
    string,
    { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >(); // Accept connections
  (async () => {
    for await (const conn of listener) {
      connSet.add(conn);
      const client: UDSClient = {
        conn,
        index: counter.value++,
        id: crypto.randomUUID(),
      };
      clientMap.set(conn, client);
      debug(`uds: client connected #${client.index} (${connSet.size} total)`);

      // Send initial state
      const initial = JSON.stringify(getUIState()) + "\n";
      const writer = conn.writable.getWriter();
      writer.write(new TextEncoder().encode(initial)).catch((e: unknown) => {
        diagEmit({
          type: "transport-error",
          severity: "warning",
          source: "server",
          message: "UDS write failed — message not delivered to renderer",
          detail: { error: String(e) },
          hint:
            "Electron IPC pipe may be broken. Check if renderer process is running.",
        });
      });
      writer.releaseLock();

      // Read incoming messages (actions + __clientState: responses)
      handleUDSConn(conn, connSet, clientMap, pendingState, onAction, debug);
    }
  })().catch((e) => {
    if (!closed) debug(`uds: accept loop error — ${e}`);
  });

  function sendTo(conn: Deno.Conn, msg: string): void {
    try {
      const writer = conn.writable.getWriter();
      writer.write(new TextEncoder().encode(msg + "\n")).catch(() =>
        connSet.delete(conn)
      );
      writer.releaseLock();
    } catch {
      connSet.delete(conn);
    }
  }

  return {
    socketPath,
    broadcast: (msg: string) => {
      const data = new TextEncoder().encode(msg + "\n");
      for (const conn of connSet) {
        try {
          const writer = conn.writable.getWriter();
          writer.write(data).catch(() => connSet.delete(conn));
          writer.releaseLock();
        } catch {
          connSet.delete(conn);
        }
      }
    },
    clients: () => [...clientMap.values()],
    requestClientState: (
      index: number,
      msg = "__getState",
    ): Promise<unknown> => {
      const client = [...clientMap.values()].find((c) => c.index === index);
      if (!client) {
        return Promise.resolve({ error: `client ${index} not connected` });
      }
      return new Promise<unknown>((resolve) => {
        const timer = setTimeout(() => {
          pendingState.delete(client.id);
          resolve({ error: "client did not respond within 5s" });
        }, 5000);
        pendingState.set(client.id, { resolve, timer });
        sendTo(client.conn, msg);
      });
    },
    shutdown: () => {
      closed = true;
      listener.close();
      for (const conn of connSet) {
        try {
          conn.close();
        } catch { /* already closed */ }
      }
      // Clear pending state request timers
      for (const entry of pendingState.values()) clearTimeout(entry.timer);
      pendingState.clear();
      connSet.clear();
      clientMap.clear();
      try {
        Deno.removeSync(socketPath);
      } catch { /* already removed */ }
    },
  };
}

/** Handle incoming NDJSON from a UDS client (Electron → Deno) */
function handleUDSConn(
  conn: Deno.Conn,
  connections: Set<Deno.Conn>,
  clientMap: Map<Deno.Conn, UDSClient>,
  pendingState: Map<
    string,
    { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >,
  onAction: (action: { type: string; payload?: unknown }) => void,
  debug: (msg: string) => void,
): void {
  const decoder = new TextDecoder();
  let buf = "";
  (async () => {
    const reader = conn.readable.getReader();
    const IDLE_TIMEOUT = 300_000; // 5 min idle timeout — stalled clients get dropped
    try {
      while (true) {
        // Race read against idle timeout to prevent stalled clients from blocking forever
        const readResult = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: true }>((resolve) =>
            setTimeout(
              () => resolve({ value: undefined, done: true }),
              IDLE_TIMEOUT,
            )
          ),
        ]);
        const { value, done } = readResult;
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop()!;
        for (const line of lines) {
          if (!line) continue;
          // Client state response
          if (line.startsWith("__clientState:")) {
            const client = clientMap.get(conn);
            if (client) {
              const pending = pendingState.get(client.id);
              if (pending) {
                pendingState.delete(client.id);
                clearTimeout(pending.timer);
                try {
                  pending.resolve(JSON.parse(line.slice(14)));
                } catch {
                  pending.resolve(null);
                }
              }
            }
            continue;
          }
          try {
            const action = JSON.parse(line);
            if (action && typeof action.type === "string") {
              onAction(action);
            }
          } catch {
            debug("uds: malformed message");
          }
        }
      }
    } catch { /* connection closed */ }
    connections.delete(conn);
    clientMap.delete(conn);
    debug(`uds: client disconnected (${connections.size} total)`);
  })();
}

// ── Runtime ─────────────────────────────────────────────────────────

let _running = false;
// _dispatchUser removed — user context now extracted per-action from action._user (set by server dispatch)
let _electronProc: Deno.ChildProcess | null = null;

/** v0.5 features-based config — pass to aio.run() instead of (initialState, config) */
export type FeaturesConfig = {
  /** Unique app identity — used for lock file, UDS socket, KV/SQLite paths, TLS cert dir. Mandatory. */
  appId: string;
  features: FeatureEntry[];
  port?: number;
  persist?: boolean;
  persistKey?: string;
  persistDebounceMs?: number;
  persistMode?: "single" | "multi";
  ui?: UiConfig;
  baseDir?: string;
  client?: "electron" | "browser" | "cli" | "server-only";
  keepServer?: boolean;
  transport?: "uds" | "ws" | "auto";
  killExisting?: boolean;
  serverUrl?: string;
  users?: Record<string, AioUser>;
  db?: Record<string, TableDef>;
  perfCheck?: "on" | "off";
  perfBudget?: PerfBudget;
  effectTimeoutMs?: number;
  freezeState?: boolean;
  memory?: MemoryConfig; // memory pressure monitoring config
  circuitBreaker?: CircuitBreakerConfig; // auto-disable features after N errors
  singleton?: boolean;
  syncIntervalMs?: number;
  fullStateThreshold?: number;
  maxConnections?: number;
  schedules?: ScheduleDef[];
  /** v0.5 middleware array — applied in order as beforeReduce chain */
  middleware?: MiddlewareFn[];
  /** Application version string — logged on startup, available at __aio.appVersion */
  appVersion: string;
  /** Isolate features — only these features are active (dev mode convenience) */
  isolate?: string[];
  beforeReduce?: (
    action: unknown,
    state: unknown,
    user?: AioUser,
  ) => unknown | null;
  onAction?: (action: unknown, state: unknown, user?: AioUser) => void;
  onEffect?: (effect: unknown, user?: AioUser) => void;
  onConnect?: (user?: AioUser) => void;
  onDisconnect?: (user?: AioUser) => void;
  onStart?: (app: AioApp) => void;
  onStop?: () => void;
  onError?: (error: AioError) => void;
  onRestore?: (state: unknown) => unknown;
  stateForUI?: (state: unknown, user?: AioUser) => unknown;
  stateForDB?: (state: unknown) => unknown;
  /** Structured logging — app.log (narrative), debug.log (all), error.log (errors), warning.log (warnings), perf.log (violations).
   *  Enabled by default. Set `false` to disable. Pass LogConfig to customize. */
  logging?: boolean | LogConfig;
  /** Diagnostics module — state diffs, action log, checkpoint, crash handler.
   *  Default: dev=full visibility, prod=lean. Set `false` to disable entirely. */
  diagnostics?: DiagnosticsConfig;
  /** Callback when a diagnostics checkpoint is found on startup.
   *  Receives full CheckpointData. Return state to restore, or null to start fresh. */
  onCheckpointRestore?: (
    checkpoint: CheckpointData,
  ) => Record<string, unknown> | null;
};

/** Single entry point — boots KV, server, electron, wires everything. CLI args override config. */
async function run<S, A, E>(
  initialState: S,
  config: AioConfig<S, A, E>,
): Promise<AioApp<S, A>>;
// deno-lint-ignore no-explicit-any
async function run(fc: FeaturesConfig): Promise<AioApp<any, any>>;
// deno-lint-ignore no-explicit-any
async function run(a: any, b?: any): Promise<AioApp<any, any>> {
  // Legacy API: aio.run(initialState, config) — kept for backward compat
  if (b !== undefined) {
    if (_running) {
      throw new Error("aio.run() already called — one instance per process");
    }
    _running = true;
    try {
      return await _run(a, b);
    } catch (e) {
      _running = false;
      throw e;
    }
  }
  const fc = a as FeaturesConfig;
  validateConfig(
    fc as unknown as Record<string, unknown>,
    VALID_FEATURES_CONFIG_KEYS,
    "FeaturesConfig",
  );
  if (fc.ui) {
    validateConfig(fc.ui as Record<string, unknown>, VALID_UI_KEYS, "ui");
  }
  if (_running) {
    throw new Error("aio.run() already called — one instance per process");
  }
  _running = true;

  {
    // --isolate: filter features to only the specified ones
    let featureEntries = fc.features;
    const cliIsolate = parseCli().isolate;
    const isolate = fc.isolate ?? cliIsolate;
    if (isolate && isolate.length) {
      const isolateSet = new Set(isolate);
      featureEntries = featureEntries.filter((entry) => {
        const f = "__aio" in entry
          ? entry as FeatureDef
          : (entry as { feature: FeatureDef }).feature;
        return isolateSet.has(f.__aio.id);
      });
      if (featureEntries.length === 0) {
        log.warn(
          `isolate: no features matched [${
            [...isolateSet].join(", ")
          }] — check spelling`,
        );
      } else {
        log.info(
          `isolate: ${
            featureEntries.map((e) =>
              ("__aio" in e
                ? e as FeatureDef
                : (e as { feature: FeatureDef }).feature).__aio.id
            ).join(", ")
          }`,
        );
      }
    }

    // Mutable reportOpts ref — populated by _run, used by composeFeatures callbacks at runtime
    const _featureReportOpts: ReportErrorOpts = { onError: fc.onError };

    const perfEnabled = fc.perfCheck !== "off";
    const composed = composeFeatures(featureEntries, {
      onFeatureError: (err) => reportAioError(err, _featureReportOpts),
      circuitBreaker: fc.circuitBreaker,
      perfCheck: perfEnabled,
    });

    // Build auto-stateForDB from per-feature persist excludes (if user didn't supply one)
    let autoGetDBState = fc.stateForDB;
    if (!fc.stateForDB) {
      const featureExcludes = new Map<string, string[]>();
      for (const f of composed.features) {
        if (f.__aio.persistExclude?.length) {
          featureExcludes.set(f.__aio.id, f.__aio.persistExclude);
        }
      }
      if (featureExcludes.size > 0) {
        autoGetDBState = (s: unknown) => {
          const result = { ...(s as Record<string, unknown>) };
          for (const [featureName, excludeKeys] of featureExcludes) {
            if (
              result[featureName] && typeof result[featureName] === "object"
            ) {
              const filtered = {
                ...(result[featureName] as Record<string, unknown>),
              };
              for (const key of excludeKeys) delete filtered[key];
              result[featureName] = filtered;
            }
          }
          return result;
        };
      }
    }

    // Log feature composition
    log.info(`features: ${composed.featureNames.join(", ")}`);
    // Log foreign action listeners
    for (const f of composed.features) {
      if (f.__aio.foreignActions.length) {
        for (const fa of f.__aio.foreignActions) {
          log.info(`${f.__aio.id}: listens to ${fa}`);
        }
      }
    }

    // Create structured logger if configured
    const appId = resolveAppId(fc.appId);
    const cliBackup = parseCli().backupLogs;
    const logCfg = fc.logging === false
      ? null
      : (fc.logging === true || fc.logging === undefined ? {} : fc.logging);
    const logger = logCfg
      ? new AioLogger({
        ...logCfg,
        ...(cliBackup ? { backupLogs: true } : {}),
        appName: appId,
      })
      : null;
    if (logger) await logger.init();
    setLogger(logger); // Store composed for useFeature (used by getUIState to expose feature names)
    (globalThis as Record<string, unknown>).__aioFeatures = composed;

    // Build beforeReduce from middleware array + explicit beforeReduce
    let beforeReduce = fc.beforeReduce as
      | ((action: unknown, state: unknown, user?: AioUser) => unknown | null)
      | undefined;
    if (fc.middleware?.length) {
      const mws = fc.middleware;
      const chainedMw = (
        action: unknown,
        state: unknown,
        user?: AioUser,
      ): unknown | null => {
        let result: unknown | null = action;
        for (const mw of mws) {
          if (result === null) return null;
          result = mw(result, state, user);
        }
        return result;
      };
      if (beforeReduce) {
        const prev = beforeReduce;
        beforeReduce = (action, state, user?: AioUser) => {
          const r = chainedMw(action, state, user);
          if (r === null) return null;
          return prev(r, state, user);
        };
      } else {
        beforeReduce = chainedMw;
      }
    }

    const onRestore = fc.onRestore as ((state: unknown) => unknown) | undefined;

    // Mutable ref — set after _run() so closures in config can access the app
    let appRef: AioApp<Record<string, unknown>, unknown> | null = null;

    // Convert to legacy config
    const config: AioConfig<Record<string, unknown>, unknown, unknown> = {
      appId: fc.appId,
      reduce: composed.reduce as AioConfig<
        Record<string, unknown>,
        unknown,
        unknown
      >["reduce"],
      execute:
        ((app: AioApp<Record<string, unknown>, unknown>, effect: unknown) => {
          composed.execute(
            {
              dispatch: (a) => app.dispatch(a),
              getState: () => app.getState(),
            },
            effect as { type: string; payload: unknown },
          );
        }) as AioConfig<Record<string, unknown>, unknown, unknown>["execute"],
      persist: fc.persist,
      persistKey: fc.persistKey,
      persistDebounceMs: fc.persistDebounceMs,
      persistMode: fc.persistMode,
      port: fc.port,
      baseDir: fc.baseDir,
      client: fc.client,
      users: fc.users,
      db: fc.db,
      perfCheck: fc.perfCheck,
      perfBudget: fc.perfBudget,
      effectTimeoutMs: fc.effectTimeoutMs,
      freezeState: fc.freezeState,
      singleton: fc.singleton,
      killExisting: fc.killExisting,
      keepServer: fc.keepServer,
      syncIntervalMs: fc.syncIntervalMs,
      fullStateThreshold: fc.fullStateThreshold,
      maxConnections: fc.maxConnections,
      schedules: fc.schedules,
      appVersion: fc.appVersion,
      transport: fc.transport,
      serverUrl: fc.serverUrl,
      ui: fc.ui,
      beforeReduce: beforeReduce as AioConfig<
        Record<string, unknown>,
        unknown,
        unknown
      >["beforeReduce"],
      onAction: logger
        ? ((action, state, user) => {
          logger.observe(
            action as { type: string; payload?: unknown },
            state as Record<string, unknown>,
          );
          if (fc.onAction) fc.onAction(action, state, user);
        }) as AioConfig<Record<string, unknown>, unknown, unknown>["onAction"]
        : fc.onAction as AioConfig<
          Record<string, unknown>,
          unknown,
          unknown
        >["onAction"],
      onEffect: fc.onEffect as AioConfig<
        Record<string, unknown>,
        unknown,
        unknown
      >["onEffect"],
      onConnect: fc.onConnect,
      onDisconnect: fc.onDisconnect,
      onStart: ((app: AioApp<Record<string, unknown>, unknown>) => {
        // Run lifecycle init for all features
        composed.initAll({
          dispatch: (a) => app.dispatch(a),
          getState: () => app.getState(),
        });
        logger?.onStart(composed.featureNames, app.port);
        if (fc.onStart) fc.onStart(app);
      }) as AioConfig<Record<string, unknown>, unknown, unknown>["onStart"],
      onStop: () => {
        logger?.onStop();
        setLogger(null);
        if (appRef) {
          composed.destroyAll({
            dispatch: (a) => appRef!.dispatch(a),
            getState: () => appRef!.getState(),
          });
        }
        if (fc.onStop) fc.onStop();
      },
      onError: fc.onError,
      onRestore: onRestore as AioConfig<
        Record<string, unknown>,
        unknown,
        unknown
      >["onRestore"],
      stateForUI: fc.stateForUI as AioConfig<
        Record<string, unknown>,
        unknown,
        unknown
      >["stateForUI"],
      stateForDB: autoGetDBState as AioConfig<
        Record<string, unknown>,
        unknown,
        unknown
      >["stateForDB"],
      _onScheduleReady: (cancelByPrefix) =>
        composed.registry.setOnDisable(cancelByPrefix),
      _diagnostics: fc.diagnostics,
      _onCheckpointRestore: fc.onCheckpointRestore,
      _featureNames: composed.featureNames,
      _reduceBreakdown: composed.lastBreakdown,
      _healthGetter: (state: unknown) => {
        const health = composed.registry.health(
          state as Record<string, unknown>,
        );
        const result: Record<string, { errors: number; enabled: boolean }> = {};
        for (const h of health) {
          result[h.name] = { errors: h.errors, enabled: h.enabled };
        }
        return result;
      },
    };

    try {
      const app = await _run(composed.initialState, config);
      appRef = app;

      // Initialize memory pressure monitor
      // Resolve V8 heap_size_limit once at startup — this is the real max, not the lazily-growing heapTotal
      let _heapLimit = 0;
      try {
        const v8 = await import("node:v8");
        _heapLimit = (v8.getHeapStatistics() as { heap_size_limit: number })
          .heap_size_limit;
      } catch { /* node:v8 unavailable — fall back to heapTotal in monitor */ }

      const memoryMonitor = createMemoryMonitor({
        enabled: fc.memory?.enabled ?? true,
        interval: fc.memory?.interval ?? 10_000,
        warnThreshold: fc.memory?.warnThreshold ?? 0.75,
        criticalThreshold: fc.memory?.criticalThreshold ?? 0.90,
        gcStressRatio: fc.memory?.gcStressRatio ?? 0.05,
        onReport: (report) => {
          const code = report.level === "critical"
            ? "MEMORY_CRITICAL"
            : "MEMORY_PRESSURE";
          const topFeature = report.featureStates[0];
          const err = createAioError(
            code as import("./error.ts").AioErrorCode,
            `heap at ${(report.heapPct * 100).toFixed(0)}% (${
              (report.heapUsed / 1e6).toFixed(0)
            } MB / ${(report.heapLimit / 1e6).toFixed(0)} MB)`,
            { featureName: topFeature?.name },
          );
          reportAioError(err, _featureReportOpts);
          fc.memory?.onMemoryPressure?.(report);
        },
        getMemoryUsage: () => Deno.memoryUsage(),
        getHeapLimit: () => _heapLimit,
        getFeatureStates: () => {
          const fullState = app.getState() as Record<string, unknown>;
          return composed.features.map((f) => ({
            name: f.__aio.id,
            state: fullState[f.__aio.id],
          }));
        },
      });

      // Wrap close to also stop memory monitor
      const origClose = app.close;
      (app as Record<string, unknown>).close = async () => {
        memoryMonitor.stop();
        await origClose();
      };

      // Attach features API to app
      const featuresApi = {
        enable: (name: string) =>
          composed.registry.enable(name, {
            dispatch: (a) => app.dispatch(a),
            getState: () => app.getState(),
          }),
        disable: (name: string) =>
          composed.registry.disable(name, (a) => app.dispatch(a)),
        status: (name: string) =>
          composed.registry.status(
            name,
            app.getState() as Record<string, unknown>,
          ),
        health: () =>
          composed.registry.health(app.getState() as Record<string, unknown>),
        list: () => composed.featureNames,
      };
      (app as Record<string, unknown>).features = featuresApi;

      // Bind features — enables todo.add('milk') syntax (dispatch + selector binding)
      for (const f of composed.features) {
        bindFeature(
          f,
          (a) => app.dispatch(a),
          () => app.getState() as Record<string, unknown>,
        );
      }

      return app;
    } catch (e) {
      _running = false;
      throw e;
    }
  }
}

// ── Runtime config validation ────────────────────────────────────────
// Types are erased at runtime. These sets are the runtime source of truth.
// If you add a key to AioConfig, FeaturesConfig, or UiConfig — add it here too.

export const VALID_UI_KEYS = new Set<string>([
  "title",
  "width",
  "height",
  "showStatus",
]);

export const VALID_AIO_CONFIG_KEYS = new Set<string>([
  "appId",
  "reduce",
  "execute",
  "persist",
  "stateForDB",
  "stateForUI",
  "fullStateThreshold",
  "syncIntervalMs",
  "maxConnections",
  "beforeReduce",
  "persistKey",
  "persistDebounceMs",
  "persistMode",
  "users",
  "ui",
  "port",
  "baseDir",
  "client",
  "keepServer",
  "transport",
  "killExisting",
  "serverUrl",
  "appVersion",
  "schedules",
  "db",
  "perfCheck",
  "perfBudget",
  "renderBudget",
  "effectTimeoutMs",
  "freezeState",
  "memory",
  "circuitBreaker",
  "onRestore",
  "singleton",
  "onAction",
  "onEffect",
  "onConnect",
  "onDisconnect",
  "onStart",
  "onStop",
  "onError",
  // internal keys (prefixed with _)
  "_onScheduleReady",
  "_diagnostics",
  "_onCheckpointRestore",
  "_featureNames",
  "_healthGetter",
  "_reduceBreakdown",
]);

export const VALID_FEATURES_CONFIG_KEYS = new Set<string>([
  "appId",
  "features",
  "port",
  "persist",
  "persistKey",
  "persistDebounceMs",
  "persistMode",
  "ui",
  "baseDir",
  "client",
  "keepServer",
  "transport",
  "killExisting",
  "serverUrl",
  "users",
  "db",
  "perfCheck",
  "perfBudget",
  "renderBudget",
  "effectTimeoutMs",
  "freezeState",
  "memory",
  "circuitBreaker",
  "singleton",
  "syncIntervalMs",
  "fullStateThreshold",
  "maxConnections",
  "schedules",
  "middleware",
  "appVersion",
  "isolate",
  "beforeReduce",
  "onAction",
  "onEffect",
  "onConnect",
  "onDisconnect",
  "onStart",
  "onStop",
  "onError",
  "onRestore",
  "stateForUI",
  "stateForDB",
  "logging",
  "diagnostics",
  "onCheckpointRestore",
]);

// Key descriptions: [default, explanation] — required keys have no default
const CONFIG_DOCS: Record<string, [string, string]> = {
  // Required
  appId: ["", "unique app identity — lock file, UDS socket, KV/SQLite paths"],
  appVersion: ["", "app version string — logged on startup"],
  features: ["", "feature definitions array"],
  // Core
  reduce: ["", "state reducer (legacy API)"],
  execute: ["", "effect executor (legacy API)"],
  // Persistence
  persist: ["true", "auto-open Deno.Kv for state persistence"],
  persistKey: ['"state"', "KV key prefix"],
  persistDebounceMs: ["100", "ms between KV writes"],
  persistMode: [
    '"single"',
    '"single" (one blob ≤64KB) or "multi" (one key per top-level state key)',
  ],
  // Server
  port: ["8000", "HTTP/WS server port"],
  baseDir: ['"./src"', "source directory for transpilation"],
  client: ['"electron"', '"electron" | "browser" | "cli" | "server-only"'],
  keepServer: ["false", "keep server running after client closes"],
  transport: ['"auto"', '"uds" | "ws" | "auto" — IPC transport'],
  killExisting: ["false", "kill existing instance before starting"],
  serverUrl: ["", "connect to remote server instead of starting one"],
  singleton: ["true", "refuse to start if already running"],
  // Sync
  syncIntervalMs: [
    "50",
    "max 1 state push per N ms (0 = microtask coalescing only)",
  ],
  fullStateThreshold: [
    "0.5",
    "ratio of changed keys that triggers full state broadcast",
  ],
  maxConnections: ["100", "max concurrent WebSocket clients"],
  // State filters
  stateForUI: ["full state", "filter state before sending to UI"],
  stateForDB: ["full state", "filter state before persisting"],
  beforeReduce: ["", "intercept actions before reduce — return null to drop"],
  // Auth
  users: ["", "static token→user map for auth"],
  // Database
  db: ["", "SQLite table definitions — arrays auto-sync"],
  // Performance
  perfCheck: ['"on"', "enable/disable performance violation reporting"],
  perfBudget: ["", "override default budgets (reduce: 100ms, effect: 5ms)"],
  "renderBudget.staleness": [
    "300",
    "ms — primary staleness threshold (sent to browser)",
  ],
  "renderBudget.pendingPatches": [
    "10",
    "max pending patches before warning (sent to browser)",
  ],
  effectTimeoutMs: ["30000", "warn for slow async effects (ms)"],
  freezeState: [
    "dev:true",
    "deep freeze state after reduce to catch mutations",
  ],
  // Monitoring
  memory: ["", "memory pressure monitoring config"],
  circuitBreaker: ["", "auto-disable features after N errors"],
  diagnostics: ["auto", "state diffs, action log, checkpoint, crash handler"],
  logging: ["true", "structured logging — false to disable"],
  // Scheduling
  schedules: ["", "static scheduled effects — started on boot"],
  // Features API
  middleware: ["", "middleware array — applied in order as beforeReduce chain"],
  isolate: ["", "run only these features (dev convenience)"],
  // Lifecycle hooks
  onAction: ["", "called after every action"],
  onEffect: ["", "called after every effect"],
  onConnect: ["", "called when client connects"],
  onDisconnect: ["", "called when client disconnects"],
  onStart: ["", "called after server starts"],
  onStop: ["", "called on shutdown"],
  onError: ["", "called on framework error"],
  onRestore: ["", "transform state after restore, before server starts"],
  onCheckpointRestore: ["", "handle diagnostics checkpoint on startup"],
};

const UI_DOCS: Record<string, [string, string]> = {
  title: ['"AIO App"', "window title"],
  width: ["800", "window width (px)"],
  height: ["600", "window height (px)"],
  showStatus: ["true", "show connection status indicator"],
};

// Grouped optional keys — order matters for display
const CONFIG_GROUPS: [string, string[]][] = [
  ["Server & transport", [
    "port",
    "baseDir",
    "client",
    "keepServer",
    "transport",
    "killExisting",
    "serverUrl",
    "singleton",
    "users",
    "syncIntervalMs",
    "fullStateThreshold",
    "maxConnections",
  ]],
  ["App logic", [
    "stateForUI",
    "stateForDB",
    "beforeReduce",
    "middleware",
    "isolate",
    "persist",
    "persistKey",
    "persistDebounceMs",
    "persistMode",
    "onRestore",
    "db",
    "schedules",
    "onAction",
    "onEffect",
    "onConnect",
    "onDisconnect",
    "onStart",
    "onStop",
    "onError",
    "onCheckpointRestore",
  ]],
  ["Performance & monitoring", [
    "perfCheck",
    "perfBudget",
    "renderBudget.staleness",
    "renderBudget.pendingPatches",
    "effectTimeoutMs",
    "freezeState",
    "memory",
    "circuitBreaker",
    "diagnostics",
    "logging",
  ]],
];

function formatValidConfig(): string {
  const uiKeys = [...VALID_UI_KEYS].sort();

  const pad = (s: string, len: number) =>
    s + " ".repeat(Math.max(0, len - s.length));

  function table(
    title: string,
    keys: string[],
    docs: Record<string, [string, string]>,
  ): string[] {
    // Compute column widths
    let nameW = 4, defW = 7; // "Name", "Default"
    for (const k of keys) {
      const d = docs[k];
      nameW = Math.max(nameW, k.length);
      if (d?.[0]) defW = Math.max(defW, d[0].length);
    }
    const lines: string[] = [];
    lines.push(`  ${title}`);
    lines.push(`  ${pad("Name", nameW)}  ${pad("Default", defW)}  Description`);
    lines.push(
      `  ${"─".repeat(nameW)}  ${"─".repeat(defW)}  ${"─".repeat(30)}`,
    );
    for (const k of keys) {
      const d = docs[k];
      const def = d?.[0] || "—";
      const desc = d?.[1] || "";
      lines.push(`  ${pad(k, nameW)}  ${pad(def, defW)}  ${desc}`);
    }
    return lines;
  }

  const lines: string[] = [];
  lines.push("aio.run({");
  lines.push("");
  lines.push(
    ...table("REQUIRED", ["appId", "appVersion", "features"], CONFIG_DOCS),
  );

  for (const [group, keys] of CONFIG_GROUPS) {
    lines.push("");
    lines.push(
      ...table(`${group.toUpperCase()} (optional)`, keys, CONFIG_DOCS),
    );
  }

  lines.push("");
  lines.push(...table("UI (optional) — ui: { ... }", uiKeys, UI_DOCS));

  lines.push("");
  lines.push("})");
  return lines.join("\n");
}

export function validateConfig(
  obj: Record<string, unknown>,
  validKeys: Set<string>,
  label: string,
  exit: (code: number) => never = Deno.exit as (code: number) => never,
): void {
  const unknown = Object.keys(obj).filter((k) => !validKeys.has(k));
  if (unknown.length > 0) {
    console.error(
      `\n[aio] CONFIG ERROR: unknown ${label} key(s): ${unknown.join(", ")}`,
    );
    console.error(`\n[aio] Valid configuration:\n`);
    console.error(formatValidConfig());
    exit(1);
  }
}

async function _run<S, A, E>(
  initialState: S,
  config: AioConfig<S, A, E>,
): Promise<AioApp<S, A>> {
  const cli = parseCli();
  if (cli.help) {
    printHelp();
    Deno.exit(0);
  }
  if (cli.version) {
    console.log(`aio ${VERSION}`);
    Deno.exit(0);
  }

  // App identity — resolved once, used for lock, UDS socket, KV/SQLite paths
  const appId = resolveAppId(config.appId);
  log.debug(`app-id: ${appId}`);

  // Port — explicit wins, otherwise pick a random free port in 49152–65535
  const port = cli.port ?? config.port ?? await findFreePort();

  // Single-instance enforcement — identity-based lock in /tmp/aio/{appId}.lock
  const singletonMode = config.singleton ?? true;
  const killExisting = (config.killExisting ?? false) ||
    (cli.killExisting ?? false);
  let appLock: AppLock | null = null;
  if (singletonMode !== false) {
    appLock = new AppLock(appId);
    const result = await appLock.acquire(port, killExisting);
    if (!result.ok) {
      const ex = result.existing;
      const exUrl = `http://localhost:${ex.port}`;
      console.error(
        `[AIO] ${
          killExisting ? "Failed to take over" : "Already running"
        }: ${ex.appId} at ${exUrl} (pid ${ex.pid})`,
      );
      Deno.exit(1);
    }
    log.debug(`lock: acquired ${lockDir()}/${appId}.lock (PID ${Deno.pid})`);
  }

  // --server-url: thin client mode — launches connect-page electron that fetches meta from remote
  const serverUrl = cli.serverUrl ?? config.serverUrl;
  if (serverUrl !== undefined) {
    if (serverUrl) log.info(`connecting to ${serverUrl}`);
    else log.info("launching connect page");
    const proc = await launchElectronClient(log, serverUrl || undefined);
    if (proc) {
      const status = await proc.status;
      log.info(`electron closed (code ${status.code ?? 0})`);
    }
    _running = false;
    Deno.exit(0);
  }

  const baseDir = resolve(config.baseDir ?? join(Deno.cwd(), "src"));

  // --verbose flag (used below for conditional debug output)
  const VERBOSE = cli.verbose;

  // Prod mode: explicit --prod flag or auto-detect in compiled binaries only
  // Running from source with dist/ lying around should NOT trigger prod
  const moduleRoot = import.meta.dirname
    ? resolve(import.meta.dirname, "..", "..", "..")
    : null;
  const execDir = isCompiled() ? resolve(dirname(Deno.execPath())) : null;
  let distDir = resolve(join(Deno.cwd(), "dist"));
  let prod = cli.prod ?? false;
  if (!prod && isCompiled()) {
    const candidates = [
      distDir,
      ...(execDir ? [resolve(join(execDir, "dist"))] : []),
      ...(moduleRoot ? [resolve(join(moduleRoot, "dist"))] : []),
    ];
    for (const dir of candidates) {
      try {
        await Deno.stat(join(dir, "app.js"));
        distDir = dir;
        prod = true;
        log.info("auto-detected dist/app.js → prod mode");
        break;
      } catch { /* not found */ }
    }
  }

  // Diagnostics — state diffs, action log, checkpoint, crash handler
  const diagConfig = config._diagnostics ?? {};
  const diagLogDir = "./log";
  const diagHooks = config._diagnostics === false
    ? null
    : initDiagnostics(diagConfig, prod, diagLogDir);
  if (diagHooks && config._featureNames) {
    diagHooks.onStart(config._featureNames);
  }

  // Vital Signs — loop/transport/render health probes
  const diagResolvedOpts = config._diagnostics === false
    ? false
    : resolveDiagOptions(config._diagnostics ?? {}, prod);
  let vitalsSystem: VitalsSystem | undefined;
  if (diagResolvedOpts && diagResolvedOpts.vitals !== false) {
    const vitalsConfig = typeof diagResolvedOpts.vitals === "object"
      ? diagResolvedOpts.vitals
      : {};
    vitalsSystem = createVitalsSystem(vitalsConfig);
  }

  const client = cli.client ?? config.client ?? "electron";
  const useElectron = client === "electron";
  const isHeadless = client === "server-only" || client === "cli";
  const { reduce, execute, onAction, onEffect, onStart, onStop, onError } =
    config;
  const shouldPersist = (cli.persist ?? config.persist) !== false;
  const _rawStateForUI = config.stateForUI ?? ((s: S, _user?: AioUser) => s);
  // Memoize stateForUI output — skip re-call when input state reference unchanged (AIO-9)
  let _memoState: S | null = null;
  const _memoResults = new Map<string, unknown>(); // key: user.id ?? ""
  const getUIState = (s: S, user?: AioUser): unknown => {
    if (s !== _memoState) {
      _memoState = s;
      _memoResults.clear();
    }
    const uid = user?.id ?? "";
    const cached = _memoResults.get(uid);
    if (cached !== undefined) return cached;
    const result = _rawStateForUI(s, user);
    _memoResults.set(uid, result);
    return result;
  };
  const getDBState = config.stateForDB ?? ((s: S) => s);
  const persistKey = config.persistKey ?? "state";
  const persistMode = config.persistMode ?? "single";
  const ui = config.ui ?? {};

  // Validate config shape at runtime — types are erased, this is the safety net
  validateConfig(
    config as unknown as Record<string, unknown>,
    VALID_AIO_CONFIG_KEYS,
    "AioConfig",
  );
  if (config.ui) {
    validateConfig(config.ui as Record<string, unknown>, VALID_UI_KEYS, "ui");
  }

  const result = await lint(
    initialState,
    config,
    baseDir,
    prod,
    isHeadless,
    useElectron,
  );
  printLint(result);

  // Title: CLI > config > deno.json "title" > fallback
  let denoJsonTitle: string | undefined;
  try {
    denoJsonTitle =
      JSON.parse(await Deno.readTextFile(join(Deno.cwd(), "deno.json"))).title;
  } catch { /* no deno.json or no title field */ }
  const title = cli.title ?? ui.title ?? denoJsonTitle ?? "AIO App";

  log.debug(
    `config: port=${port} persist=${shouldPersist} client=${client} title="${title}" baseDir=${baseDir}`,
  );

  let kvDb: SkvInstance | null = null;
  let state = initialState;

  // SQLite setup — spawns worker, creates tables (data loaded after KV merge below)
  const dbSchema = config.db;
  const dbKeys = dbSchema ? Object.keys(dbSchema) : [];
  let asyncDb: DB | null = null;
  if (dbSchema && Object.keys(dbSchema).length) {
    try {
      const dbPath = resolveDbPath(appId);
      asyncDb = createDB(dbPath);
      await initSchema(asyncDb, dbSchema);
      log.info(`sqlite: ${dbKeys.length} table(s) at ${dbPath}`);
    } catch (e) {
      log.warn(`sqlite: unavailable — ${e}`);
      if (asyncDb) {
        await asyncDb.close().catch(() => {});
        asyncDb = null;
      }
    }
  }

  // KV: strip db-managed keys so arrays aren't double-stored
  const origGetDBState = getDBState;
  const kvGetDBState = dbKeys.length
    ? (s: S) => {
      const full = origGetDBState(s);
      if (!full || typeof full !== "object" || Array.isArray(full)) return full;
      const filtered: Record<string, unknown> = {};
      for (const k of Object.keys(full as Record<string, unknown>)) {
        if (!dbKeys.includes(k)) {filtered[k] =
            (full as Record<string, unknown>)[k];}
      }
      return filtered;
    }
    : origGetDBState;

  if (shouldPersist) {
    try {
      const kvPath = resolveKvPath(appId);
      kvDb = skv(await Deno.openKv(kvPath));
      if (kvPath) log.debug(`persist: KV at ${kvPath} mode=${persistMode}`);
      const persisted = persistMode === "multi"
        ? await kvDb.getMulti<Partial<S>>(persistKey)
        : await kvDb.get<Partial<S>>(persistKey);
      if (persisted) {
        state = deepMerge(
          initialState as Record<string, unknown>,
          persisted as Record<string, unknown>,
        ) as S;
        log.debug(
          `persist: loaded from KV key="${persistKey}" (${persistMode})`,
        );
      } else {
        log.debug(`persist: no saved state, using initialState`);
      }
    } catch (e) {
      throw new Error(
        `KV unavailable: ${e}\nFix permissions or set persist: false to disable persistence.`,
      );
    }
  }

  // onRestore — let user transform/validate restored state before server starts
  if (config.onRestore) {
    try {
      state = config.onRestore(state);
    } catch (e) {
      log.error(`hook onRestore: ${e}`);
    }
  }

  // Diagnostics checkpoint restore — after KV restore, before dispatch starts
  if (diagHooks?.getRecoveredState() && config._onCheckpointRestore) {
    const recovered = diagHooks.getRecoveredState()!;
    const restored = config._onCheckpointRestore(recovered);
    if (restored) {
      Object.assign(state as Record<string, unknown>, restored);
      log.info("checkpoint: state restored from checkpoint");
    }
  }

  // Wire diagnostics health getter (state is now in scope)
  if (diagHooks && config._healthGetter) {
    diagHooks.setHealthGetter(() => config._healthGetter!(state));
  }

  // Load SQLite data into state (once, after KV merge — SQLite wins for db-managed keys)
  if (asyncDb && dbSchema) {
    const loaded = await loadTables(asyncDb, dbSchema);
    state = { ...(state as Record<string, unknown>), ...loaded } as S;
  }

  log.debug(
    `state: ${Object.keys(state as Record<string, unknown>).length} keys`,
  );

  // Track previous state for SQLite ref-equality diff
  let prevDbState: Record<string, unknown> = {
    ...(state as Record<string, unknown>),
  };

  /** Debounced persistence — KV for UI state, SQLite for db arrays */
  const persistMs = config.persistDebounceMs ?? 100;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let shuttingDown = false;
  let prevPersistedKeys: string[] = []; // track multi-key keys for deletion when state keys removed
  // Debounced persistence — fire-and-forget during normal operation for throughput.
  // Data loss possible on crash between debounce intervals. Graceful shutdown awaits flushPersist().
  function schedulePersist(): void {
    if ((!kvDb && !asyncDb) || persistTimer || shuttingDown) return;
    persistTimer = setTimeout(async () => {
      persistTimer = null;
      // SQLite sync — reference equality check per table
      if (asyncDb && dbSchema) {
        try {
          await syncTables(
            asyncDb,
            dbSchema,
            state as Record<string, unknown>,
            prevDbState,
          );
          log.debug("persist: sqlite synced");
        } catch (e) {
          log.error(`persist: sqlite sync failed — ${e}`);
          const persistErr = createAioError("PERSIST_ERROR", e, {});
          reportAioError(persistErr, _reportOpts);
        }
        prevDbState = { ...(state as Record<string, unknown>) };
      }
      // KV sync — UI state (db keys stripped)
      if (kvDb) {
        try {
          const dbState = kvGetDBState(state);
          if (persistMode === "multi") {
            const obj = dbState as Record<string, unknown>;
            const keys = Object.keys(obj);
            try {
              await kvDb.setMulti(persistKey, obj, prevPersistedKeys);
              prevPersistedKeys = keys;
              log.debug(`persist: saved multi (${keys.length} keys)`);
            } catch (e) {
              log.error(`persist: failed to save — ${e}`);
              const persistErr = createAioError("PERSIST_ERROR", e, {});
              reportAioError(persistErr, _reportOpts);
            }
          } else {
            const serialized = JSON.stringify(dbState);
            const bytes = new TextEncoder().encode(serialized).byteLength;
            if (bytes > 63_000) {
              log.error(
                `persist: state is ${
                  (bytes / 1024).toFixed(1)
                }KB — exceeds Deno KV 65KB limit. Use persistMode:'multi', stateForDB filter, or db:{} (SQLite)`,
              );
              return;
            }
            if (bytes > 50_000) {
              log.warn(
                `persist: state is ${
                  (bytes / 1024).toFixed(1)
                }KB — approaching 65KB KV limit. Consider persistMode:'multi', stateForDB, or SQLite`,
              );
            }
            try {
              await kvDb.set(persistKey, dbState);
              log.debug(`persist: saved (${(bytes / 1024).toFixed(1)}KB)`);
            } catch (e) {
              log.error(`persist: failed to save — ${e}`);
              const persistErr = createAioError("PERSIST_ERROR", e, {});
              reportAioError(persistErr, _reportOpts);
            }
          }
        } catch (e) {
          log.error(`persist: stateForDB threw — ${e}`);
          const persistErr = createAioError("PERSIST_ERROR", e, {});
          reportAioError(persistErr, _reportOpts);
        }
      }
    }, persistMs);
  }

  /** Immediate flush — cancel debounce and write now (used on shutdown) */
  async function flushPersist(): Promise<void> {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    // Flush SQLite
    if (asyncDb && dbSchema) {
      try {
        await syncTables(
          asyncDb,
          dbSchema,
          state as Record<string, unknown>,
          prevDbState,
        );
        prevDbState = { ...(state as Record<string, unknown>) };
      } catch (e) {
        log.error(`persist: sqlite flush failed — ${e}`);
      }
    }
    // Flush KV
    if (kvDb) {
      try {
        const dbState = kvGetDBState(state);
        if (persistMode === "multi") {
          const obj = dbState as Record<string, unknown>;
          const keys = Object.keys(obj);
          await kvDb.setMulti(persistKey, obj, prevPersistedKeys);
          prevPersistedKeys = keys;
        } else {
          await kvDb.set(persistKey, dbState);
        }
        log.debug("persist: flushed");
      } catch (e) {
        const msg = String(e);
        if (
          msg.includes("too large") || msg.includes("65536") ||
          msg.includes("value too")
        ) {
          log.warn(
            `persist: state exceeds Deno KV 65KB limit — set persistMode:'multi' or use stateForDB / db:{} (SQLite)`,
          );
        }
        log.error(`persist: flush failed — ${e}`);
        const persistErr = createAioError("PERSIST_ERROR", e, {});
        reportAioError(persistErr, _reportOpts);
      }
    }
  }

  // Hook-wrapped reduce/execute — observe-only, error-guarded
  const { beforeReduce } = config;

  // Tracks whether any action in the current drain cycle actually ran reduce() — drops skip persist+broadcast
  let _anyProcessed = false;
  const hookedReduce: typeof reduce = (s, a) => {
    // Extract per-action user tag (set by server dispatch) instead of shared mutable
    const user = (a as Record<string, unknown>)?._user as AioUser | undefined;
    if (beforeReduce) {
      try {
        const filtered = beforeReduce(a, s, user);
        if (filtered === null) {
          diagEmit({
            type: "action-filtered",
            severity: "info",
            source: "middleware",
            message: `Action '${
              (a as { type?: string }).type
            }' filtered by beforeReduce`,
            detail: { actionType: (a as { type?: string }).type },
            hint:
              "A middleware or beforeReduce hook returned null, dropping this action.",
          });
          return { state: s, effects: [] as E[] }; // dropped — _anyProcessed stays false
        }
        a = filtered as A;
      } catch (e) {
        const actionType = (a as Record<string, unknown>)?.type as
          | string
          | undefined;
        const err = createAioError("HOOK_ERROR", e, {
          hookName: "beforeReduce",
          actionType,
        });
        reportAioError(err, _reportOpts);
        return { state: s, effects: [] as E[] }; // drop action
      }
    }
    _anyProcessed = true;
    _currentActionUser = user;
    if (onAction) {
      try {
        onAction(a, s, user);
      } catch (e) {
        const actionType = (a as Record<string, unknown>)?.type as
          | string
          | undefined;
        const err = createAioError("HOOK_ERROR", e, {
          hookName: "onAction",
          actionType,
        });
        reportAioError(err, _reportOpts);
      }
    }
    return reduce(s, a);
  };
  // Track per-action user for onEffect hook (set in hookedReduce, consumed in hookedExecute)
  let _currentActionUser: AioUser | undefined;
  const hookedExecute: typeof execute = onEffect
    ? (app, e) => {
      try {
        onEffect(e, _currentActionUser);
      } catch (err) {
        const effectType = (e as Record<string, unknown>)?.type as
          | string
          | undefined;
        const aioErr = createAioError("HOOK_ERROR", err, {
          hookName: "onEffect",
          effectType,
        });
        reportAioError(aioErr, _reportOpts);
      }
      execute(app, e);
    }
    : execute;

  // Time-travel — active in dev mode, zero cost in prod
  let tt: TTState<S, { type: string }> | null = null;
  if (!prod) {
    tt = createTT<S, { type: string }>();
    tt = record(tt, { type: "__init" }, state);
    log.debug("time-travel: initialized");
  }

  // Build reportOpts after tt init — closures capture `tt` by reference (let binding)
  const _reportOpts: ReportErrorOpts = {
    onError,
    logger: getLogger()
      ? {
        error: (msg: string, data?: Record<string, unknown>) =>
          getLogger()!.pub("error", "aio", msg, data),
      }
      : undefined,
    tt: tt
      ? {
        markError: (
          err: {
            code: string;
            message: string;
            featureName?: string;
            flowStep?: number;
          },
        ) => markError(tt!, err),
      }
      : undefined,
    prod,
  };

  // Schedule manager — handles __schedule effects from reducer + config-level schedules
  const scheduleManager = createScheduleManager(
    (action) => dispatch(action as A),
    log,
  );
  if (config._onScheduleReady) {
    config._onScheduleReady((prefix) => scheduleManager.cancelByPrefix(prefix));
  }

  // UDS handle — created after dispatch for electron+UDS transport
  let udsHandle: UDSHandle | null = null;
  const udsSyncIntervalMs = config.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  let udsQueued = false;
  let udsDirty = false;
  let udsThrottle: ReturnType<typeof setTimeout> | null = null;
  // Delta compression state for UDS broadcasts (mirrors WS delta in server.ts)
  let udsLastState: unknown = null;
  let udsLastKeyJsons: Record<string, string> = {};
  const udsFullStateThreshold = config.fullStateThreshold ?? 0.5;

  /** Broadcast UI state to UDS clients with delta compression. Reset tracking with `force` for state jumps. */
  function udsBroadcastState(force = false) {
    if (!udsHandle) return;
    if (force) {
      udsLastState = null;
      udsLastKeyJsons = {};
    }
    const uiState = getUIState(state);
    const delta = _computeDelta(
      uiState,
      udsLastState,
      udsLastKeyJsons,
      udsFullStateThreshold,
    );
    udsLastState = uiState;
    udsLastKeyJsons = delta.newKeyJsons;
    if (delta.kind === "skip") return;
    udsHandle.broadcast(delta.msg);
  }

  // Track per-action performance for dev-mode time-travel panel + vitals
  let lastPerf: PerfMetric | undefined;
  const onPerf = (tt || vitalsSystem)
    ? (
      timing: {
        actionType: string;
        reduce: number;
        effects: number;
        budget: { reduce: number; effect: number };
        breakdown?: ReduceBreakdown;
      },
    ) => {
      if (tt) {
        lastPerf = {
          reduce: timing.reduce,
          effects: timing.effects,
          budget: timing.budget,
          breakdown: timing.breakdown,
        };
      }
      if (vitalsSystem) {
        vitalsSystem.loopProbe.onPerf(timing);
      }
    }
    : undefined;

  // Internal action types to hide from time-travel history (framework noise)
  const TT_SKIP_SUFFIXES = [":__exec", ":__FlowState", ":__flow"];
  const TT_SKIP_CONTAINS = [":__set", ":__error"];
  function isInternalAction(type: string): boolean {
    if (TT_SKIP_SUFFIXES.some((s) => type.endsWith(s))) return true;
    if (TT_SKIP_CONTAINS.some((s) => type.includes(s))) return true;
    return false;
  }

  // Shared dispatch loop — re-entrant-safe, overflow-guarded
  const dispatch = createDispatch<S, A, E>({
    reduce: tt
      ? (s, a) => {
        if (tt!.paused) {
          log.debug(
            `time-travel: paused, dropping action ${
              (a as { type?: string }).type ?? "?"
            }`,
          );
          return { state: s, effects: [] as E[] };
        }
        const result = hookedReduce(s, a);
        const actionType = (a as { type?: string }).type ?? "";
        if (!isInternalAction(actionType)) {
          tt = record(
            tt!,
            a as unknown as { type: string },
            result.state,
            lastPerf,
          );
          lastPerf = undefined;
          server.broadcastTT();
        }
        return result;
      }
      : hookedReduce,
    execute: (effect) => {
      if (isScheduleEffect(effect)) {
        scheduleManager.handle(effect as ScheduleEffect);
        return;
      }
      hookedExecute(app, effect);
    },
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {
      const processed = _anyProcessed;
      _anyProcessed = false;
      if (!processed) return; // all actions dropped by beforeReduce — skip persist + broadcast
      if (!tt?.paused) schedulePersist();
      server.broadcast();
      // Also broadcast to UDS clients (Electron IPC bridge) — throttled same as WS
      if (udsHandle) {
        udsDirty = true;
        if (!udsQueued && !(udsSyncIntervalMs > 0 && udsThrottle)) {
          udsQueued = true;
          queueMicrotask(() => {
            udsQueued = false;
            udsDirty = false;
            udsBroadcastState();
            if (udsSyncIntervalMs > 0) {
              udsThrottle = setTimeout(() => {
                udsThrottle = null;
                if (udsDirty) {
                  udsDirty = false;
                  udsBroadcastState();
                }
              }, udsSyncIntervalMs);
            }
          });
        }
      }
    },
    log,
    debug: VERBOSE,
    reportOpts: _reportOpts,
    perfCheck: config.perfCheck,
    perfBudget: config.perfBudget,
    perfLog: (source, type, duration, budget, breakdown) =>
      getLogger()?.perf(source, type, duration, budget, breakdown),
    freezeState: config.freezeState ?? !prod, // default: true in dev, false in prod
    effectTimeout: config.effectTimeoutMs,
    onPerf,
    reduceBreakdown: config._reduceBreakdown,
    afterAction: diagHooks?.afterAction as
      | ((prev: S, next: S, action: A) => void)
      | undefined,
  });
  const freezeEnabled = config.freezeState ?? !prod;
  log.info(
    `freezeState: ${freezeEnabled}${
      config.freezeState === undefined
        ? (prod ? " (prod default)" : " (dev default)")
        : ""
    }`,
  );

  // Vital Signs — periodic queue/circuit-breaker check
  let _vitalsCheckTimer: ReturnType<typeof setInterval> | undefined;
  if (vitalsSystem) {
    const interval = (typeof diagResolvedOpts === "object" &&
      typeof diagResolvedOpts.vitals === "object" &&
      diagResolvedOpts.vitals.heartbeatInterval) || 1000;
    _vitalsCheckTimer = setInterval(() => {
      vitalsSystem!.loopProbe.updateQueueDepth(dispatch.getQueueDepth());
      vitalsSystem!.loopProbe.updateEffectBacklog(dispatch.getEffectBacklog());
      const composed = (globalThis as Record<string, unknown>).__aioFeatures as
        | ComposedFeatures
        | undefined;
      if (composed) {
        const health = composed.registry.health(
          state as Record<string, unknown>,
        );
        const tripped = health.filter((f: { enabled: boolean }) => !f.enabled)
          .map((f: { name: string }) => f.name);
        vitalsSystem!.loopProbe.updateCircuitBreakers(tripped);
      }
      vitalsSystem!.checkAndAlert();
    }, interval);
  }

  const app: AioApp<S, A> = {
    dispatch,
    getState: () => state,
    port,
    db: asyncDb ?? undefined,
    snapshot: () => JSON.stringify(state),
    loadSnapshot: (json: string) => {
      const parsed = JSON.parse(json);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("snapshot must be a JSON object");
      }
      // Validate keys — reject unknown keys not in initial state
      const initKeys = new Set(
        Object.keys(initialState as Record<string, unknown>),
      );
      const snapKeys = Object.keys(parsed as Record<string, unknown>);
      const unknown = snapKeys.filter((k) => !initKeys.has(k));
      if (unknown.length) {
        log.warn(`snapshot: unknown keys present: ${unknown.join(", ")}`);
      }
      state = parsed as S;
      prevDbState = { ...(state as Record<string, unknown>) };
      if (tt) {
        tt = record(tt, { type: "__snapshot" }, state);
        server.broadcastTT();
      }
      schedulePersist();
      server.broadcast();
      udsBroadcastState(true); // force full — state jump
      log.info("snapshot: loaded");
    },
    close: async () => {
      await shutdown();
    },
  };

  // Shared shutdown — idempotent, used by both close() and signal handler
  let shutdownPromise: Promise<void> | null = null;
  function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = _doShutdown();
    return shutdownPromise;
  }
  async function _doShutdown(): Promise<void> {
    // Flush persistence BEFORE onStop/destroyAll — destroyAll resets feature state,
    // so persisting after destroy would save empty state (#002)
    try {
      await flushPersist();
    } catch (e) {
      log.error(`shutdown: persist — ${e}`);
    }

    // Diagnostics shutdown — flush action log, write final checkpoint
    if (diagHooks) {
      try {
        await diagHooks.onStop();
      } catch (e) {
        log.error(`shutdown: diagnostics — ${e}`);
      }
    }
    if (diagHooks?.uninstallCrashHandler) diagHooks.uninstallCrashHandler();

    // Vital Signs cleanup
    if (_vitalsCheckTimer) clearInterval(_vitalsCheckTimer);
    if (vitalsSystem) vitalsSystem.destroy();

    if (onStop) {
      try {
        onStop();
      } catch (e) {
        log.error(`hook onStop: ${e}`);
      }
    }

    // Release single-instance lock
    if (appLock) {
      appLock.release();
      log.debug(`lock: released (PID ${Deno.pid})`);
    }

    scheduleManager.cancelAll();
    dispatch.close();
    if (_electronProc) {
      try {
        _electronProc.kill();
        _electronProc = null;
      } catch (e) {
        log.error(`shutdown: electron — ${e}`);
      }
    }
    if (udsThrottle) {
      clearTimeout(udsThrottle);
      udsThrottle = null;
    }
    if (udsHandle) {
      try {
        udsHandle.shutdown();
      } catch (e) {
        log.error(`shutdown: uds — ${e}`);
      }
    }
    try {
      await server.shutdown();
    } catch (e) {
      log.error(`shutdown: server — ${e}`);
    }
    try {
      await asyncDb?.close();
    } catch (e) {
      log.error(`shutdown: sqlite — ${e}`);
    }
    try {
      kvDb?.close();
    } catch (e) {
      log.error(`shutdown: kv — ${e}`);
    }
    _running = false;
  }

  // --expose: bind 0.0.0.0, generate access token, auto-TLS
  const expose = cli.expose ?? false;
  const users = config.users;
  // --expose without users: auto-gen single token (backwards compatible)
  const token = (expose && !users) ? crypto.randomUUID() : undefined;

  // TLS: auto-generate self-signed cert when --expose (or use user-provided --cert/--key)
  let tlsCert: TlsCert | null = null;
  if (expose) {
    const certDir = isCompiled()
      ? resolveDataDir(appId)
      : join(Deno.cwd(), ".aio-tls");
    try {
      tlsCert = await loadOrCreateCert(certDir, cli.cert, cli.key);
      if (tlsCert.selfSigned) {
        log.info(`tls: self-signed cert at ${tlsCert.certPath}`);
        log.warn(
          `tls: self-signed — remote browsers will show a security warning. Trust the cert, or use --cert=/path.pem --key=/path.pem for a CA-signed cert`,
        );
      } else {
        log.info(`tls: using cert ${tlsCert.certPath}`);
      }
    } catch (e) {
      throw new Error(
        `TLS cert generation failed: ${e}\nProvide --cert=PATH --key=PATH or fix the issue. Cannot expose without HTTPS.`,
      );
    }
  }

  // TT command handler — undo/redo/goto restore state, pause/resume toggle
  function handleTTCommand(cmd: string, arg?: number): void {
    if (!tt) return;
    const prev = tt;
    switch (cmd) {
      case "undo":
        tt = undo(tt);
        break;
      case "redo":
        tt = redo(tt);
        break;
      case "goto":
        if (arg !== undefined) tt = travelTo(tt, arg);
        break;
      case "pause":
        tt = pause(tt);
        break;
      case "resume":
        tt = resume(tt);
        break;
      default:
        log.debug(`time-travel: unknown command '${cmd}'`);
        return;
    }
    if (tt === prev) return; // no-op (e.g. undo at start)
    // Restore state at current index
    const restored = stateAt(tt);
    if (restored !== null) state = restored;
    log.debug(
      `time-travel: ${cmd}${
        arg !== undefined ? ":" + arg : ""
      } → index ${tt.index}/${tt.entries.length - 1} paused=${tt.paused}`,
    );
    server.broadcastTT();
    server.broadcast();
    udsBroadcastState(true); // force full — time-travel state jump
  }

  // Resolve transport (client already resolved above)
  const transport = resolveTransport(
    cli.transport ?? config.transport,
    useElectron,
    expose,
  );

  // Shared client index counter — WS and UDS clients get globally unique indices
  const clientCounter = { value: 0 };

  // Prod + UDS + electron: skip HTTP server entirely (zero TCP ports — all via UDS+IPC)
  const skipHttp = prod && transport === "uds" && useElectron && !expose;
  const server: ServerHandle = skipHttp
    ? {
      broadcast: () => {},
      broadcastTT: () => {},
      shutdown: async () => {},
      clientCount: () => 0,
    }
    : createServer({
      port,
      clientCounter,
      title,
      vitalsSystem,
      width: ui.width,
      height: ui.height,
      getUIState: (user?: AioUser) => getUIState(state, user),
      dispatch: (action, user?) => {
        // Tag user onto action so queued re-entrant dispatches carry the correct user
        const tagged = user
          ? { ...(action as Record<string, unknown>), _user: user }
          : action;
        dispatch(tagged as A);
      },
      getSnapshot: () => app.snapshot!(),
      loadSnapshot: (json: string) => app.loadSnapshot!(json),
      baseDir,
      debug: (msg: string) => log.debug(msg),
      prod,
      distDir: prod ? distDir : undefined,
      expose,
      token,
      users,
      cert: tlsCert?.cert,
      key: tlsCert?.key,
      showStatus: ui.showStatus,
      renderBudget: config.renderBudget,
      fullStateThreshold: config.fullStateThreshold,
      maxConnections: config.maxConnections,
      syncIntervalMs: config.syncIntervalMs,
      onConnect: config.onConnect,
      onDisconnect: config.onDisconnect,
      onReload: (signal) => {
        if (udsHandle) udsHandle.broadcast(signal);
      },
      // Health endpoint — feature status when available, basic info otherwise
      getHealth: () => {
        const composed = (globalThis as Record<string, unknown>)
          .__aioFeatures as ComposedFeatures | undefined;
        const uptime = Math.round(
          (Date.now() -
            ((globalThis as Record<string, unknown>).__aioStartedAt as number ??
              Date.now())) / 1000,
        );
        if (composed) {
          const features: Record<string, unknown> = {};
          for (
            const fs of composed.registry.health(
              state as Record<string, unknown>,
            )
          ) {
            features[fs.name] = {
              status: fs.status ?? "active",
              enabled: fs.enabled,
              errors: fs.errors,
              lastAction: fs.lastAction,
            };
          }
          return { status: "healthy", uptime, features };
        }
        return { status: "healthy", uptime };
      },
      ...(tt
        ? {
          onTTCommand: handleTTCommand,
          getTTBroadcast: () => toBroadcast(tt!),
        }
        : {}),
      trojan: {
        getState: () => state,
        getSchedules: () => scheduleManager.active(),
        ...(tt ? { getTTHistory: () => toBroadcast(tt!) } : {}),
        ...(shouldPersist ? { forcePersist: () => schedulePersist() } : {}),
        ...(asyncDb
          ? {
            sqlQuery: async (sql: string) => (await asyncDb!.query(sql)).rows,
          }
          : {}),
        shutdown: () => shutdown().then(() => Deno.exit(0)),
        startedAt: Date.now(),
        udsClients: () =>
          udsHandle
            ? udsHandle.clients().map((c) => ({ index: c.index, id: c.id }))
            : [],
        requestUdsClientState: (index: number, msg?: string) =>
          udsHandle
            ? udsHandle.requestClientState(index, msg)
            : Promise.resolve({ error: "UDS not active" }),
      },
    });

  if (skipHttp) log.info("prod+UDS: HTTP server skipped (zero TCP ports)");

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    try {
      Deno.addSignalListener(sig, () => {
        shutdown().then(() => Deno.exit(0)).catch(() => Deno.exit(1));
      });
    } catch { /* signal not supported on this platform */ }
  }

  const appVersion = config.appVersion;
  (globalThis as Record<string, unknown>).__aioStartedAt = Date.now();
  const __aio =
    ((globalThis as Record<string, unknown>).__aio ??= {}) as Record<
      string,
      unknown
    >;
  __aio.appVersion = appVersion;
  __aio.aioVersion = VERSION;
  if (onStart) {
    try {
      onStart(app);
    } catch (e) {
      log.error(`hook onStart: ${e}`);
      diagEmit({
        type: "hook-start-failed",
        severity: "error",
        source: "lifecycle",
        message: "onStart hook threw — app may be in broken state",
        detail: { error: String(e) },
        hint:
          "Check your onStart callback. The app continues running but may not be fully initialized.",
      });
    }
  }

  if (config.schedules?.length) {
    scheduleManager.start(config.schedules);
    log.info(`schedules: ${config.schedules.length} started`);
  }

  // UDS listener (transport already resolved above, before createServer)
  if (transport === "uds") {
    const socketPath = resolveSocketPath(appId);
    udsHandle = createUDSListener(
      socketPath,
      () => getUIState(state),
      (action) => {
        // Tag action and dispatch into the shared loop
        dispatch(action as A);
      },
      (msg: string) => log.debug(msg),
      clientCounter,
    );
    log.info(`transport: UDS at ${socketPath}`);
  }

  const useHttps = expose && !!tlsCert;
  // shareUrl: shown in logs / share links (0.0.0.0 when exposing — users replace with their LAN IP)
  const shareUrl = useHttps
    ? `https://0.0.0.0:${port}`
    : expose
    ? `http://0.0.0.0:${port}`
    : `http://localhost:${port}`;
  // localUrl: used to open local browser/electron window
  const localUrl = useHttps
    ? `https://localhost:${port}`
    : `http://localhost:${port}`;
  const url = shareUrl; // kept for compatibility with log messages below

  // Update lock file with runtime info (trojanPort, socketPath, started status)
  if (appLock) {
    appLock.update({
      status: "started",
      ...(server.trojanPort ? { trojanPort: server.trojanPort } : {}),
      ...(udsHandle ? { socketPath: udsHandle.socketPath } : {}),
    });
  }

  const cliFlags = Deno.args.filter((a) => a.startsWith("--") && a.length > 2);
  if (cliFlags.length) log.info(`cli: ${cliFlags.join(" ")}`);
  else log.debug("run with --help to see available flags");
  const mode = prod ? "prod" : "dev";
  const shell = client;
  const transportLabel = transport === "uds" ? ", uds" : "";

  // Startup info — open resources + all app settings (always shown, even defaults)
  const p = (key: string) => `  ${key.padEnd(10)}`;
  if (skipHttp) {
    log.info(`running (${mode}, ${shell}, uds — no TCP port)`);
  } else {
    log.info(`running (${mode}, ${shell}${transportLabel})`);
    const wsProto = useHttps ? "wss" : "ws";
    const wsHost = expose ? `0.0.0.0:${port}` : `localhost:${port}`;
    log.info(`${p("web")}${url}`);
    log.info(`${p("ws")}${wsProto}://${wsHost}/ws`);
  }
  if (udsHandle) log.info(`${p("uds")}${udsHandle.socketPath}`);
  if (server.trojanPort) {
    log.info(`${p("trojan")}http://localhost:${server.trojanPort}`);
  }
  log.info(`${p("id")}${appId}`);
  log.info(`${p("version")}${appVersion}`);
  log.info(`${p("aio")}${VERSION}`);
  log.info(`${p("title")}${title}`);
  log.info(`${p("singleton")}${String(singletonMode)}`);
  log.info(`${p("persist")}${shouldPersist ? persistMode : "false"}`);
  if (asyncDb) {
    log.info(
      `${p("sqlite")}${dbKeys.length} table${dbKeys.length !== 1 ? "s" : ""}`,
    );
  }
  log.info(`${p("expose")}${expose}`);
  const authLabel = users
    ? `${Object.keys(users).length} user(s)`
    : token
    ? "token"
    : "none";
  log.info(`${p("auth")}${authLabel}`);
  if (config.schedules?.length) {
    log.info(`${p("schedules")}${config.schedules.length}`);
  }
  if (config.maxConnections !== undefined) {
    log.info(`${p("maxconn")}${config.maxConnections}`);
  }

  // Share URLs — shown separately so they're easy to copy
  if (expose && users) {
    log.warn(
      `--expose: bound to 0.0.0.0 — per-user token auth, origin checks disabled`,
    );
    for (const [t, u] of Object.entries(users)) {
      log.info(`share (${u.id}/${u.role}): ${url}?token=${t}`);
    }
  } else if (expose && token) {
    log.warn(
      `--expose: bound to 0.0.0.0 — token auth only, origin checks disabled, token changes on restart`,
    );
    log.info(`share: ${url}?token=${token}`);
  }

  const keepServer = cli.keepServer ?? config.keepServer ?? false;
  if (keepServer && client !== "electron") {
    throw new Error("keepServer only applies when client is electron");
  }

  if (isHeadless) {
    // Headless — server-only, no UI launch (CLI apps use connectCli() to connect)
  } else if (useElectron) {
    const meta: AioMeta = {
      title,
      width: cli.width ?? ui.width,
      height: cli.height ?? ui.height,
    };
    const electronUrl = token ? `${localUrl}?token=${token}` : localUrl;
    const udsBaseDir = prod ? distDir : undefined; // prod: serve from dist/, dev: use HTTP
    let udsHasCSS = false;
    if (udsBaseDir) {
      try {
        Deno.statSync(join(udsBaseDir, "style.css"));
        udsHasCSS = true;
      } catch { /* no CSS */ }
    }
    const udsConfig = udsHandle
      ? {
        socketPath: udsHandle.socketPath,
        baseDir: udsBaseDir,
        title,
        hasCSS: udsHasCSS,
      }
      : undefined;
    launchElectron(electronUrl, log, meta, udsConfig)
      .then((proc) => {
        if (!proc) {
          log.error(
            "Electron not installed — install with: deno task install:electron",
          );
          log.error("Or use --client=browser to open in system browser");
          Deno.exit(1);
        }
        _electronProc = proc;
        proc.status
          .then((s) => {
            _electronProc = null;
            if (keepServer) {
              log.info(
                `electron closed (code ${
                  s.code ?? 0
                }) — server still running at ${url}`,
              );
            } else {
              shutdown().then(() => Deno.exit(0));
            }
          })
          .catch((e) => log.error(`electron status: ${e}`));
      })
      .catch((e) => log.error(`electron: ${e}`));
  } else {
    // Wait briefly for existing browser tabs to reconnect via WS
    setTimeout(() => {
      if (server.clientCount() > 0) {
        log.debug("browser: existing client connected — skipping open");
        return;
      }
      const cmd = Deno.build.os === "darwin"
        ? "open"
        : Deno.build.os === "windows"
        ? "start"
        : "xdg-open";
      try {
        new Deno.Command(cmd, {
          args: [localUrl],
          stdout: "null",
          stderr: "null",
        }).spawn();
      } catch {
        log.info(`open ${localUrl} in your browser`);
      }
    }, 1500);
  }

  return app;
}

/** Main aio namespace — `aio.run(config)` starts the server, `aio.middleware` has built-in middleware factories */
export const aio = { run, middleware };
export type { ComposedFeatures, FeatureDef, FeatureEntry } from "./feature.ts";
