// Pure type definitions for aio.run() — no runtime code
import type { AioError, ReportErrorOpts } from "../diagnostics/error.ts";
import type { PerfBudget } from "../state/dispatch.ts";
import type {
  CellPatchStrategy,
  PatchFilterFields,
} from "../state/state-filter.ts";
import type { ScheduleDef, ScheduleEffect } from "../state/schedule.ts";
import type { OwnEffect } from "../state/own.ts";
import type { DB } from "../db/mod.ts";
import type { TableDef } from "./sql.ts";
import type { CellStatus, CircuitBreakerConfig } from "../state/cell.ts";
import type { MemoryConfig } from "../diagnostics/memory-monitor.ts";
import type { LogConfig } from "../diagnostics/logger.ts";
import type { StormConfig } from "../diagnostics/dispatch-storm.ts";
import type { CheckpointData, DiagnosticsConfig } from "../diagnostics/mod.ts";
import type { RenderBudget } from "../vitals/types.ts";
import type { ReduceBreakdown } from "../diagnostics/time-travel.ts";

/** User identity — resolved from static token map or dynamic resolveUser hook */
export type AioUser = { id: string; role: string };

/** Dynamic user resolution hook — called with extracted token + current state.
 *  Return AioUser to authenticate, null to reject. Supports async (e.g. JWT verification). */
export type ResolveUserFn<S = unknown> = (
  token: string,
  state: S,
) => AioUser | null | Promise<AioUser | null>;

/** Window + UI sync options — applies to both Electron and browser clients */
export type UiConfig = {
  title?: string; // default: 'AIO App'
  width?: number; // default: 800
  height?: number; // default: 600
  showStatus?: boolean; // default: true
  /** AIO-8.1: UI entry file, relative to baseDir. Default: "App.tsx" (the
   *  filename convention). Set to serve/watch a different component file. */
  entry?: string;
  /** AIO-423: override the `<meta viewport>` content string. Default is
   *  responsive (`width=device-width, initial-scale=1, viewport-fit=cover`).
   *  Set `false` to omit it entirely (rare fixed-width desktop layouts). */
  viewport?: string | false;
  /** AIO-423: verbatim extra `<head>` content — meta description, Open Graph
   *  tags, `<link rel="icon">`, fonts, etc. Inserted trusted (not escaped),
   *  like the stylesheet link. */
  head?: string;
};

/** Per-client WebSocket safety limits for `--expose` deployments. All optional —
 *  omitted fields keep the hardened defaults. Tune only when a reverse proxy or
 *  trusted-LAN posture needs different ceilings (W6.6). */
export type WsLimits = {
  /** Max bytes per WS message before it's dropped. Default: 1_000_000 (1MB). */
  maxMessageBytes?: number;
  /** Max messages per second per client. Default: 100. */
  messagesPerSec?: number;
  /** Max bytes per second per client (bandwidth DoS guard). Default: 5_000_000. */
  bytesPerSec?: number;
};

/** @internal Engine-level reduce/execute config. The public authoring surface is
 *  `CellsConfig` (`cells: [...]`); `aio-cells-bridge.ts` compiles cells down to this
 *  shape for `_run()`. Not exported from `aio` — internal to the runtime. */
export type AioConfig<S, A, E> = {
  /** Unique app identity — used for lock file, UDS socket, KV/SQLite paths, TLS cert dir. Mandatory. */
  /** App identity — inferred (deno.json / main-module dir) when omitted. */
  appId?: string;
  reduce: (
    state: S,
    action: A,
  ) => { state: S; effects: (E | ScheduleEffect | OwnEffect)[] };
  execute: (app: AioApp<S, A>, effect: E) => void;
  persist?: boolean; // default: true — auto-opens Deno.Kv
  fullStateThreshold?: number; // 0-1: ratio of changed keys that triggers full state broadcast (default: 0.5)
  /** Custom HTTP routes — exact path or "/prefix/*" wildcard → handler. The
   *  escape hatch for uploads, webhooks, and API endpoints that don't belong
   *  in the state channel. Reserved: /__aio and /ws. */
  routes?: Record<string, (req: Request) => Response | Promise<Response>>;
  syncIntervalMs?: number; // default: 50 — max 1 state push per N ms (0 = microtask coalescing only)
  maxConnections?: number; // max concurrent WebSocket clients (default: 100)
  wsLimits?: WsLimits; // per-client WS rate/size limits (advanced; defaults hardened)
  allowedOrigins?: string[]; // extra allowed WS origins beyond localhost + own host (reverse proxy, custom domains)
  strictOrigin?: boolean; // --expose hardening: require an Origin header on WS upgrade
  beforeReduce?: (action: A, state: S, user?: AioUser) => A | null; // intercept actions before reduce — return null to drop
  persistKey?: string; // KV key prefix (default: "state")
  persistDebounceMs?: number; // ms between KV writes (default: 100)
  persistMode?: "single" | "multi"; // 'single' (default): one blob ≤65KB. 'multi': one KV key per top-level state key — no 65KB limit
  users?: Record<string, AioUser>; // static token map — token is key, user is value
  /** --expose auth. Default (omitted/`false`) = **no framework auth** (the
   *  app does its own, or is open on a trusted LAN). `"secret"` = fixed key.
   *  `true` = a stable key generated once and persisted in the data dir. */
  key?: string | boolean;
  resolveUser?: ResolveUserFn<S>; // dynamic user resolution — overrides users if both set (AIO-171)
  ui?: UiConfig;
  port?: number; // default: 8000
  baseDir?: string; // default: ./src
  client?: "electron" | "browser" | "cli" | "server-only"; // default: 'electron'
  keepServer?: boolean; // default: false — keep server running after client closes (moved from ui.keepAlive)
  transport?: "uds" | "ws" | "auto"; // default: 'auto' — UDS on linux/mac+electron, WS otherwise (moved from ui.transport)
  killExisting?: boolean; // default: false
  serverUrl?: string;
  /** App version — default: deno.json `version`. */
  appVersion?: string; // app version string — logged on startup, available at __aio.appVersion
  schedules?: ScheduleDef[]; // static scheduled effects — started on boot
  db?: Record<string, TableDef>; // SQLite table definitions — arrays auto-sync
  perfCheck?: "on" | "off"; // default: 'on' — enable/disable performance violation reporting
  perfBudget?: PerfBudget; // override default budgets (reduce: 100, effect: 5)
  renderBudget?: RenderBudget; // override render staleness/patch thresholds (sent to browser)
  effectTimeoutMs?: number; // ms before logging a warning for slow async effects — warning only, does not cancel (default: 30000 = 30s)
  freezeState?: boolean; // default: false in prod, true in dev — deep freeze state after reduce to catch mutations
  memory?: MemoryConfig; // memory pressure monitoring config
  circuitBreaker?: CircuitBreakerConfig; // auto-disable cells after N errors
  onRestore?: (state: S) => S; // transform state after restore, before server starts
  singleton?: boolean; // true (default)=refuse if running, false=allow multi
  /** Library/test mode: no `Deno.exit`, no SIGINT/SIGTERM handlers, no singleton
   *  lock. `app.close()` tears down and resolves, leaving the process alive so a
   *  test runner (or an embedding host) survives. Use it to boot a real server
   *  inside `Deno.test` — see `aio/testing` `testServer`. Default: false. */
  libraryMode?: boolean;
  // Lifecycle hooks — observe-only, all optional, error-guarded
  onAction?: (action: A, state: S, user?: AioUser) => void;
  onEffect?: (effect: E, user?: AioUser) => void;
  onConnect?: (user?: AioUser) => void;
  onDisconnect?: (user?: AioUser) => void;
  onStart?: (app: AioApp<S, A>) => void;
  /** If true, an onStart error terminates the process. Default: false (log and continue). */
  fatalOnStart?: boolean;
  onStop?: () => void;
  onError?: (error: AioError) => void;
  /** Internal: schedule cancel callback set by _run, used by cells disable */
  _onScheduleReady?: (cancelByPrefix: (prefix: string) => void) => void;
  /** Internal: AIO-222 — propagate reportOpts to cell error reporting */
  _onReportOptsReady?: (opts: ReportErrorOpts) => void;
  /** Internal: diagnostics config passed from CellsConfig */
  _diagnostics?: DiagnosticsConfig;
  /** Internal: checkpoint restore callback passed from CellsConfig */
  _onCheckpointRestore?: (
    checkpoint: CheckpointData,
  ) => Record<string, unknown> | null;
  /** Internal: composed cell names — passed from CellsConfig for diagnostics */
  _cellNames?: string[];
  /** Internal: health getter factory — passed from CellsConfig for diagnostics */
  _healthGetter?: (
    state: unknown,
  ) => Record<string, { errors: number; enabled: boolean }>;
  /** Internal: reduce breakdown getter — passed from CellsConfig via composeCells */
  _reduceBreakdown?: () => ReduceBreakdown | undefined;
  /** Internal: cell IDs with sync: true — for CRDT table init & KV exclusion */
  _syncCellIds?: string[];
  /** Internal: per-cell version + migration hooks — for state migration on KV restore */
  _cellMigrations?: Map<
    string,
    {
      version: number;
      initialState: Record<string, unknown>;
      onMigrate?: (
        state: Record<string, unknown>,
        fromVersion: number,
      ) => Record<string, unknown>;
    }
  >;
  /** Internal: per-cell versions — flat map for persistence */
  _cellVersions?: Record<string, number>;
  /** Internal: built from per-cell persist filters (replaces removed stateForDB) */
  _getDBState?: (state: S) => unknown;
  /** Internal: built from per-cell ui filters (replaces removed stateForUI) */
  _getUIState?: (state: S, user?: AioUser) => unknown;
  /** Internal: per-cell patch strategy — determines patch vs full-state per cell */
  _cellPatchStrategies?: Map<string, CellPatchStrategy>;
  /** Internal: field sets for "filter" strategy cells */
  _cellFilterFields?: Map<string, PatchFilterFields>;
};

/** Handle returned by aio.run() — dispatch actions, read state, or shut down */
export type AioApp<S = unknown, A = unknown> = {
  dispatch: (action: A) => Promise<unknown>;
  getState: () => S;
  snapshot?: () => string; // server-only (undefined in standalone)
  loadSnapshot?: (json: string) => void; // server-only (undefined in standalone)
  db?: DB; // async SQLite — query/execute/transaction (undefined in standalone)
  close: () => Promise<void>;
  mode?: string; // 'standalone' in Android WebView builds — branch effects accordingly
  port?: number; // server port — available after aio.run(), useful for connectCli()
  /** v0.5 cell control API — only available when using cells-based config */
  cells?: {
    enable: (name: string) => void;
    disable: (name: string) => void;
    status: (name: string) => string | undefined;
    health: () => CellStatus[];
    list: () => string[];
  };
};

/** v0.5 cells-based config — pass to aio.run() instead of (initialState, config) */
export type CellsConfig = {
  /** Unique app identity — used for lock file, UDS socket, KV/SQLite paths,
   *  TLS cert dir. Default: deno.json `appId` > slug(`title`) > slug(`name`)
   *  > the main module's directory name. */
  appId?: string;
  /** Cells to run. Default: every `cell()` the entry (transitively) imported
   *  — they self-register, exactly like the standalone/android runtime. */
  cells?: import("../state/cell.ts").CellEntry[];
  /** Default persist and ui config for all cells — individual cells override these */
  cellDefaults?: {
    ui?: import("../state/cell-types.ts").CellFieldFilter;
    persist?: import("../state/cell-types.ts").CellFieldFilter;
  };
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
  /** --expose auth (see CellsConfig.key). */
  key?: string | boolean;
  resolveUser?: ResolveUserFn;
  db?: Record<string, TableDef>;
  perfCheck?: "on" | "off";
  perfBudget?: PerfBudget;
  effectTimeoutMs?: number;
  freezeState?: boolean;
  memory?: MemoryConfig; // memory pressure monitoring config
  circuitBreaker?: CircuitBreakerConfig; // auto-disable cells after N errors
  singleton?: boolean;
  libraryMode?: boolean; // no exit/signals/lock; app.close() leaves process alive
  syncIntervalMs?: number;
  fullStateThreshold?: number;
  /** Custom HTTP routes — exact path or "/prefix/*" wildcard → handler. The
   *  escape hatch for uploads, webhooks, and API endpoints that don't belong
   *  in the state channel. Reserved: /__aio and /ws. */
  routes?: Record<string, (req: Request) => Response | Promise<Response>>;
  maxConnections?: number;
  /** Per-client WebSocket safety limits (advanced; defaults are hardened). */
  wsLimits?: WsLimits;
  /** Extra allowed WS origins beyond localhost + own host (reverse proxy, custom domains). */
  allowedOrigins?: string[];
  /** --expose hardening: require an Origin header on WS upgrade. */
  strictOrigin?: boolean;
  schedules?: ScheduleDef[];
  /** Application version string — logged on startup, available at __aio.appVersion */
  /** App version — default: deno.json `version`. */
  appVersion?: string;
  /** Isolate cells — only these cells are active (dev mode convenience) */
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
  fatalOnStart?: boolean;
  onStop?: () => void;
  onError?: (error: AioError) => void;
  onRestore?: (state: unknown) => unknown;
  /** Structured logging — app.log (narrative), debug.log (all), error.log (errors), warning.log (warnings), perf.log (violations).
   *  Enabled by default. Set `false` to disable. Pass LogConfig to customize. */
  logging?: boolean | LogConfig;
  /** Diagnostics module — state diffs, action log, checkpoint, crash handler.
   *  Default: dev=full visibility, prod=lean. Set `false` to disable entirely. */
  diagnostics?: DiagnosticsConfig;
  /** Dispatch-storm guard — warns when one action type sustains a runaway
   *  dispatch rate (default: >200/s for 5s), naming the feedback loop instead
   *  of leaving downstream symptoms (log churn, perf noise, starved server).
   *  `{ breaker: true }` also drops the offending action while the storm
   *  lasts. Set `false` to disable. */
  dispatchStorm?: StormConfig | false;
  /** Callback when a diagnostics checkpoint is found on startup.
   *  Receives full CheckpointData. Return state to restore, or null to start fresh. */
  onCheckpointRestore?: (
    checkpoint: CheckpointData,
  ) => Record<string, unknown> | null;
};
