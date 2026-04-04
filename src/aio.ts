// Core runtime — boots KV, server, electron, wires everything together
import { createPersistenceManager } from "./persistence.ts";
import { createShutdownOrchestrator } from "./shutdown.ts";
import { skv, type SkvInstance } from "./skv.ts";
import { loadOrCreateCert, type TlsCert } from "./tls.ts";
import { createServer, type ServerHandle } from "./server.ts";
import { createUDSListener, type UDSHandle } from "./uds.ts";
export { createUDSListener, type UDSHandle } from "./uds.ts";
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
import { createDB, type DB, initSchema, loadTables } from "./db/mod.ts";
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

/** User identity — resolved from static token map or dynamic resolveUser hook */
export type AioUser = { id: string; role: string };

/** Dynamic user resolution hook — called with extracted token + current state.
 *  Return AioUser to authenticate, null to reject. Supports async (e.g. JWT verification). */
export type ResolveUserFn<S = unknown> = (
  token: string,
  state: S,
) => AioUser | null | Promise<AioUser | null>;
export type { AioError } from "./error.ts";
export type { PerfBudget, PerfCheck } from "./dispatch.ts";

/** Window + UI sync options — applies to both Electron and browser clients */
export type UiConfig = {
  title?: string; // default: 'AIO App'
  width?: number; // default: 800
  height?: number; // default: 600
  showStatus?: boolean; // default: true
  renderer?: "react" | "aio"; // default: 'aio' — native AIR VDOM engine (no React dependency)
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
  resolveUser?: ResolveUserFn<S>; // dynamic user resolution — overrides users if both set (AIO-171)
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
  /** Internal: AIO-222 — propagate reportOpts to feature error reporting */
  _onReportOptsReady?: (opts: ReportErrorOpts) => void;
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
  /** Internal: feature IDs with sync: true — for CRDT table init & KV exclusion */
  _syncFeatureIds?: string[];
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

// ── Middleware (extracted to middleware.ts) ──────────────────────────
import { middleware, type MiddlewareFn } from "./middleware.ts";
export { composeMiddleware, type MiddlewareFn } from "./middleware.ts";

// ── Startup linter (extracted to lint.ts) ────────────────────────────
import { lint, printLint } from "./lint.ts";
export { type Lint, lint } from "./lint.ts";

// ── CLI (extracted to aio-cli.ts) ────────────────────────────────────
export { parseCli, printHelp } from "./aio-cli.ts";
export type { CliFlags } from "./aio-cli.ts";
import { parseCli, printHelp } from "./aio-cli.ts";

// ── Path resolution (extracted to paths.ts) ─────────────────────────
import {
  findFreePort,
  isCompiled,
  resolveDataDir,
  resolveDbPath,
  resolveKvPath,
  resolveSocketPath,
  resolveTransport,
} from "./paths.ts";

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
  resolveUser?: ResolveUserFn;
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

  try { // AIO-150: wrap entire init so _running resets on failure
    { // block scope for isolate/compose variables
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

      const onRestore = fc.onRestore as
        | ((state: unknown) => unknown)
        | undefined;

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
        resolveUser: fc.resolveUser,
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
        _onReportOptsReady: (opts) => { // AIO-222
          _featureReportOpts.logger = opts.logger;
          _featureReportOpts.tt = opts.tt;
          _featureReportOpts.prod = opts.prod;
        },
        _diagnostics: fc.diagnostics,
        _onCheckpointRestore: fc.onCheckpointRestore,
        _featureNames: composed.featureNames,
        _reduceBreakdown: composed.lastBreakdown,
        _healthGetter: (state: unknown) => {
          const health = composed.registry.health(
            state as Record<string, unknown>,
          );
          const result: Record<string, { errors: number; enabled: boolean }> =
            {};
          for (const h of health) {
            result[h.name] = { errors: h.errors, enabled: h.enabled };
          }
          return result;
        },
        _syncFeatureIds: composed.features
          .filter((f) => f.__aio.syncConfig)
          .map((f) => f.__aio.id),
      };

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
          composed.registry.disable(name, {
            dispatch: (a) => app.dispatch(a),
            getState: () => app.getState(),
          }),
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
    }
  } catch (e) {
    _running = false;
    throw e;
  }
}

// ── Runtime config validation (extracted to config.ts) ───────────────
import {
  VALID_AIO_CONFIG_KEYS as _VALID_AIO_CONFIG_KEYS,
  VALID_FEATURES_CONFIG_KEYS as _VALID_FEATURES_CONFIG_KEYS,
  VALID_UI_KEYS as _VALID_UI_KEYS,
  validateConfig as _validateConfig,
} from "./config.ts";
export const VALID_UI_KEYS = _VALID_UI_KEYS;
export const VALID_AIO_CONFIG_KEYS = _VALID_AIO_CONFIG_KEYS;
export const VALID_FEATURES_CONFIG_KEYS = _VALID_FEATURES_CONFIG_KEYS;
export const validateConfig = _validateConfig;

// (config validation bodies removed — see config.ts)
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
    if (_memoResults.has(uid)) return _memoResults.get(uid); // AIO-245: handle undefined results
    const result = _rawStateForUI(s, user);
    _memoResults.set(uid, result);
    return result;
  };
  const getDBState = config.stateForDB ?? ((s: S) => s);
  const persistKey = config.persistKey ?? "state";
  const persistMode = config.persistMode ?? "single";
  const ui = config.ui ?? {};
  if (!ui.renderer) ui.renderer = "aio";

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

  // Initialize sync tables and handler if any feature has sync: true
  const syncFeatureIds = config._syncFeatureIds ?? [];
  // Mutable ref for broadcast — set after server creation
  const _syncBroadcastRef: {
    fn: (msg: string, exclude?: WebSocket) => void;
  } = { fn: () => {} };
  let syncHandler:
    | {
      handleOp: (
        op: unknown,
        meta: { id: string; user?: unknown },
        socket: WebSocket,
      ) => void;
      handleSync: (
        sync: unknown,
        meta: { id: string; user?: unknown },
        socket: WebSocket,
      ) => void;
    }
    | undefined;

  if (syncFeatureIds.length > 0) {
    if (asyncDb) {
      const { SYNC_SCHEMA } = await import("./sync/compact.ts");
      for (const sql of SYNC_SCHEMA) {
        await asyncDb.execute(sql);
      }
      const { createServerSyncHandler } = await import(
        "./sync/server-handler.ts"
      );
      syncHandler = createServerSyncHandler({
        db: asyncDb,
        syncFeatureIds,
        getFeatureState: (feature: string) =>
          (state as Record<string, Record<string, unknown>>)[feature] ?? {},
        broadcastRaw: _syncBroadcastRef,
        log,
      });
      log.info(`sync: ${syncFeatureIds.length} feature(s) with CRDT tables`);
    } else {
      log.warn(
        `sync: ${syncFeatureIds.length} feature(s) have sync: true but no SQLite DB — CRDT disabled`,
      );
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

  // Persistence manager — debounced KV + SQLite writes
  const persistence = createPersistenceManager({
    kvDb,
    asyncDb,
    dbSchema,
    persistKey,
    persistMode,
    persistMs: config.persistDebounceMs ?? 100,
    getState: () => state as Record<string, unknown>,
    getDBState: kvGetDBState as (s: Record<string, unknown>) => unknown,
    log,
    getReportOpts: () => _reportOpts,
    syncFeatures: syncFeatureIds.length > 0
      ? new Set(syncFeatureIds)
      : undefined,
  });
  const { schedulePersist } = persistence;

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

  // AIO-222: propagate logger/tt/prod to feature error reporting
  if (config._onReportOptsReady) config._onReportOptsReady(_reportOpts);

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

  /** Broadcast UI state to UDS clients with per-client subscription filtering + delta/patches.
   *  Pass `true` for force-full (snapshot/time-travel), or patches array for incremental. */
  function udsBroadcastState(
    forceOrPatches?:
      | boolean
      | Array<{ feature: string; ops: import("immer").Patch[] }>,
  ) {
    if (!udsHandle) return;
    udsHandle.broadcastState(forceOrPatches);
  }

  // Track per-action performance for dev-mode time-travel panel + vitals
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
      // AIO-250: retroactively attach perf to the CURRENT TT entry (not the next one)
      if (tt && tt.entries.length > 0) {
        tt.entries[tt.index]!.perf = {
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

  // Immer patch accumulator — collects patches across all reduce calls in a dispatch batch
  type PatchEntry = { feature: string; ops: import("immer").Patch[] };
  let _pendingPatches: PatchEntry[] = [];

  /** Extract and accumulate patches from reduce result (patches field exists at runtime) */
  function _collectPatches(
    result: { state: S; effects: (E | ScheduleEffect)[] },
  ): void {
    const patches =
      (result as unknown as { patches?: PatchEntry | PatchEntry[] }).patches;
    if (!patches) return;
    if (Array.isArray(patches)) _pendingPatches.push(...patches);
    else _pendingPatches.push(patches);
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
        _collectPatches(result);
        const actionType = (a as { type?: string }).type ?? "";
        if (!isInternalAction(actionType)) {
          // AIO-250: don't pass lastPerf here — it contains PREVIOUS action's metrics.
          // onPerf callback will retroactively update the TT entry after effects complete.
          tt = record(
            tt!,
            a as unknown as { type: string },
            result.state,
            undefined,
          );
          server.broadcastTT();
        }
        return result;
      }
      : (s, a) => {
        const result = hookedReduce(s, a);
        _collectPatches(result);
        return result;
      },
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
      const patches = _pendingPatches;
      _pendingPatches = [];
      if (!processed) return; // all actions dropped by beforeReduce — skip persist + broadcast
      if (!tt?.paused) schedulePersist();
      // When stateForUI is configured, patches are invalid (computed against unfiltered state)
      // — always use full filtered state broadcast instead
      const validPatches = config.stateForUI
        ? undefined
        : (patches.length > 0 ? patches : undefined);
      server.broadcast(validPatches);
      // Also broadcast to UDS clients (Electron IPC bridge) — throttled same as WS
      if (udsHandle) {
        udsDirty = true;
        if (!udsQueued && !(udsSyncIntervalMs > 0 && udsThrottle)) {
          udsQueued = true;
          queueMicrotask(() => {
            udsQueued = false;
            udsDirty = false;
            udsBroadcastState(validPatches);
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
      persistence.resetPrevState();
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

  // Shutdown orchestrator — idempotent, multi-phase cleanup
  // Uses getters for late-bound refs (server, udsHandle, electronProc assigned after this point)
  const { shutdown } = createShutdownOrchestrator({
    flushPersist: persistence.flushPersist,
    setShuttingDown: persistence.setShuttingDown,
    diagHooks,
    getVitalsCheckTimer: () => _vitalsCheckTimer,
    getVitalsSystem: () => vitalsSystem,
    onStop,
    appLock,
    scheduleManager,
    dispatch,
    getElectronProc: () => _electronProc,
    clearElectronProc: () => {
      _electronProc = null;
    },
    getUdsThrottle: () => udsThrottle,
    clearUdsThrottle: () => {
      udsThrottle = null;
    },
    getUdsHandle: () => udsHandle,
    getServer: () => server,
    asyncDb,
    kvDb,
    setRunning: (v: boolean) => {
      _running = v;
    },
    log,
  });

  // --expose: bind 0.0.0.0, generate access token, auto-TLS
  const expose = cli.expose ?? false;
  const users = config.users;
  // Bind resolveUser hook to current state — server.ts unifies with static users map (AIO-171)
  const _resolveUser = config.resolveUser
    ? (tok: string) => config.resolveUser!(tok, state)
    : undefined;
  // --expose without users/resolveUser: auto-gen single token (backwards compatible)
  const token = (expose && !users && !_resolveUser)
    ? crypto.randomUUID()
    : undefined;

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
      broadcastRaw: () => {},
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
      resolveUser: _resolveUser,
      cert: tlsCert?.cert,
      key: tlsCert?.key,
      showStatus: ui.showStatus,
      renderer: ui.renderer,
      renderBudget: config.renderBudget,
      fullStateThreshold: config.fullStateThreshold,
      maxConnections: config.maxConnections,
      syncIntervalMs: config.syncIntervalMs,
      hasStateFilter: config.stateForUI != null,
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
      ...(syncHandler ? { syncHandler } : {}),
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

  // Wire sync broadcast now that server handle is available
  if (syncHandler) _syncBroadcastRef.fn = server.broadcastRaw;

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
      config.fullStateThreshold ?? 0.5,
      config.stateForUI != null,
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
