// Server type definitions — extracted from server.ts for clarity
import type { AioUser } from "./aio.ts";
import type { RenderBudget } from "../vitals/types.ts";
import type { VitalsSystem } from "../vitals/mod.ts";

export type DispatchFn = (event: unknown, user?: AioUser) => void;
export type GetUIStateFn = (user?: AioUser) => unknown;

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
  /** Content-addressed blob store — served at /__aio/blobs/<id> (GET/HEAD,
   *  Range). Gated by the app's auth exactly like app state: key mode gates
   *  every path already; per-user mode 401s anonymous blob reads even when
   *  the login flows make the SHELL public (see server.ts). */
  blobs?: import("./blobs.ts").BlobStore;
  baseDir: string;
  debug: (msg: string) => void;
  prod?: boolean; // serve pre-built dist/ instead of live-transpiling
  distDir?: string; // absolute path to dist/ (required when prod=true)
  appId?: string; // app identity — for the discovery profile endpoint
  expose?: boolean; // bind 0.0.0.0 instead of 127.0.0.1
  host?: string; // explicit bind address — overrides the expose-derived default
  token?: string; // access token required when expose=true (no users)
  cert?: string; // PEM cert string — enables HTTPS when set (auto-generated when --expose)
  key?: string; // PEM key string — required when cert is set
  users?: Record<string, AioUser>; // per-user token map (overrides token)
  resolveUser?: (token: string) => AioUser | null | Promise<AioUser | null>; // dynamic user resolution (AIO-171)
  sessionResolver?: (token: string) => AioUser | null; // AUTH-1 session tokens — consulted first
  authFlows?: import("./auth-flows.ts").AuthFlows; // AUTH-2 login endpoints (/__aio/auth/*)
  showStatus?: boolean; // show reconnection indicator (default: true)
  uiEntry?: string; // AIO-8.1: UI entry file relative to baseDir (default: App.tsx)
  viewport?: string | false; // AIO-423: <meta viewport> override (false = omit)
  headExtra?: string; // AIO-423: verbatim extra <head> content
  renderBudget?: RenderBudget; // sent to browser for RenderMeter thresholds
  /** Extra read-only DEV-server roots by URL prefix — see CellsConfig.serveDirs. */
  serveDirs?: Record<string, string>;
  /** Cells the client should route through the sync engine (localFirst). */
  syncCells?: string[];
  /** Every cell THIS process booted. Sent on the `cfg` frame so a client can
   *  notice that its bundle registers a cell the server does not have — that
   *  cell's methods dispatch into nothing, and the only previous symptom was
   *  a UI that rendered and did nothing (see _warnCellSetDrift). */
  bootedCells?: string[];
  /** Resolved `await cell.method()` ceilings (effectTimeoutMs + perfBudget),
   *  bridged to the browser so both sides wait from the same numbers. */
  callTimeouts?: { default?: number; methods?: Record<string, number> };
  /** Late-bound UDS raw broadcast — carries tt-state to electron clients. */
  udsBroadcastRef?: { fn: ((raw: string) => void) | null };
  fullStateThreshold?: number; // 0-1: ratio of changed keys for delta vs full broadcast (default: 0.5)
  maxConnections?: number; // max concurrent WebSocket clients (default: 100)
  wsLimits?: import("./aio-types.ts").WsLimits; // per-client WS rate/size limits (W6.6)
  syncIntervalMs?: number; // throttle state broadcasts: max 1 push per N ms (default: 50)
  allowedOrigins?: string[]; // extra allowed origins beyond localhost (e.g. Docker, reverse proxy)
  strictOrigin?: boolean; // require Origin header on WS upgrade when expose=true (defense-in-depth vs CSWSH from origin-stripping intermediaries)
  trustProxyHeader?: string; // take client IP from this header's first hop (behind a trusted reverse proxy) for abuse/auth-fail bucketing
  clientCounter?: { value: number }; // shared index counter — WS and UDS get unique indices
  cellPatchStrategies?: Map<string, "raw" | "skip" | "filter" | "full">; // per-cell patch strategy
  cellFilterFields?: Map<
    string,
    { mode: "include" | "exclude"; fields: Set<string> }
  >; // field sets for "filter" cells
  onConnect?: (user?: AioUser) => void;
  onDisconnect?: (user?: AioUser) => void;
  onReload?: (signal: "reload" | "css") => void; // called on live-reload — lets aio.ts forward to UDS
  /** Dev only: an edited file declares a cell — cells can't hot-reload, so
   *  aio.ts restarts the process. Absent ⇒ the watcher just warns. */
  onCellChange?: (path: string) => void;
  // Vitals — latency monitoring & backpressure
  vitalsSystem?: VitalsSystem;
  /** Cost meter (`am cost`) — see src/vitals/cost-meter.ts. */
  costMeter?: import("../vitals/cost-meter.ts").CostMeter;
  // Time-travel (dev mode)
  onTTCommand?: (cmd: string, arg?: number) => void;
  getTTBroadcast?: () => unknown;
  // Health endpoint — GET /__aio/health
  getHealth?: () => unknown;
  /** Custom HTTP routes — exact path or "/prefix/*" wildcard → handler.
   *  Matched after /ws and /__aio/* (which are reserved) and before static
   *  serving. The escape hatch for uploads, webhooks, and API endpoints that
   *  don't belong in the state channel. */
  routes?: Record<string, import("./route.ts").RawRouteHandler>;
  // Trojan — control API at /__aio/trojan/* (localhost-only, CSRF-protected, rate-limited)
  trojan?: {
    getState: () => unknown; // raw unfiltered state
    getSchedules: () => string[]; // active schedule IDs
    getTTHistory?: () => unknown; // time-travel entries (wire format)
    forcePersist?: () => void; // trigger immediate persist
    sqlQuery?: (sql: string) => Promise<unknown[]>; // read-only SQL query (async)
    shutdown?: () => Promise<void>; // graceful shutdown
    startedAt: number; // Date.now() at boot
    /** Cell id → method (action) names — powers "run a method" buttons. */
    cellMethods?: () => Record<string, string[]>;
    cellFields?: () => import("./aio-types.ts").CellFieldFlags;
    /** UDS clients (Electron IPC) — for am client command */
    udsClients?: () => { index: number; id: string }[];
    /** Send a request to a UDS client and wait for its "client-state" reply */
    requestUdsClientState?: (index: number, msg?: string) => Promise<unknown>;
  };
  // CRDT sync handlers — set when any cell has sync: true
  syncHandler?: {
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
  };
}

/** Returned to aio.run() so it can push state updates and shut down cleanly */
export interface ServerHandle {
  broadcast: (
    patches?: Array<{ cell: string; ops: import("immer").Patch[] }>,
  ) => void;
  /** Send raw string message to all connected WS clients, optionally excluding one */
  broadcastRaw: (msg: string, exclude?: WebSocket) => void;
  broadcastTT: () => void;
  shutdown: () => Promise<void>;
  clientCount: () => number;
  trojanPort?: number; // set when TLS is active — HTTP-only trojan endpoint on 127.0.0.1
  socketPath?: string; // set when UDS is active
  watcherActive?: boolean; // true if file watcher is running (dev mode only)
}
