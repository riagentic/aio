// Server type definitions — extracted from server.ts for clarity
import type { AioUser } from "./aio.ts";
import type { CallTimeouts } from "../protocol/protocol-types.ts";
import type { UiTheme } from "./aio-types.ts";
import type { RenderBudget } from "../vitals/types.ts";
import type { VitalsSystem } from "../vitals/mod.ts";

export type DispatchFn = (event: unknown, user?: AioUser) => void;
export type GetUIStateFn = (user?: AioUser) => unknown;

/** Internal config — passed by aio.run(), not user-facing */
export interface ServerConfig {
  /** THE app version — announced to every client in the proto hello. */
  appVersion?: string;
  /** The shell the client will really run in — the dev graph evaluation
   *  presents its user agent, so a renderer-only throw is caught in dev. */
  shell?: "browser" | "electron";
  port: number;
  /** Server-origin dispatch for the trojan's `?as=server` — bypasses the cell
   *  `access` gate, because server code always has. Dev-only + loopback-only,
   *  like the whole trojan. */
  dispatchAsServer?: (action: unknown) => Promise<unknown> | void;
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
  /** App dirs tried AFTER `baseDir` when resolving an app asset, in order.
   *  A compiled binary's embedded (VFS) app dir is `baseDir` and `<cwd>/src`
   *  sits here behind it — see `baseDirCandidates`, which owns the order.
   *  Empty whenever the app named `baseDir` itself: that is its decision. */
  baseDirFallbacks?: string[];
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
  lang?: string; // ui.lang — <html lang>, default "en"
  /** ui.dir — `<html dir>`; mirrors the whole default UI. See `UiConfig.dir`. */
  dir?: import("./aio-types.ts").UiConfig["dir"];
  chrome?: "standard" | "themed" | "none"; // ui.chrome — desktop window frame
  theme?: UiTheme; // ui.theme — how much of the default look is emitted
  themeName?: string; // identity the theme accent is derived from (appId)
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
  callTimeouts?: CallTimeouts;
  /** Late-bound UDS raw broadcast — carries tt-state to electron clients. */
  udsBroadcastRef?: { fn: ((raw: string) => void) | null };
  /** How many clients are on the UDS socket — the cost meter counts both
   *  transports, and a desktop app has all of its clients here. */
  udsClientCount?: () => number;
  fullStateThreshold?: number; // 0-1: ratio of changed keys for delta vs full broadcast (default: 0.5)
  maxConnections?: number; // max concurrent WebSocket clients (default: 100)
  wsLimits?: import("./aio-types.ts").WsLimits; // per-client WS rate/size limits (W6.6)
  syncIntervalMs?: number; // throttle state broadcasts: max 1 push per N ms (default: 50)
  allowedOrigins?: string[]; // extra allowed origins beyond localhost (e.g. Docker, reverse proxy)
  /** Response hardening + transfer encoding (`security-config.ts`). Every
   *  field is optional; the defaults cannot break an app that works today. */
  security?: import("./security-config.ts").SecurityConfig;
  /** True when `cert` came from the operator (`--tls-cert`) rather than aio's
   *  own local CA. Only an operator certificate earns an HSTS header. */
  operatorCert?: boolean;
  strictOrigin?: boolean; // require Origin header on WS upgrade when expose=true (defense-in-depth vs CSWSH from origin-stripping intermediaries)
  trustProxyHeader?: string; // take client IP from this header's RIGHTMOST hop (behind a trusted reverse proxy) for abuse/auth-fail bucketing — the leftmost is client-settable
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
    /** Persist NOW and resolve once the write has landed; rejects when the
     *  cycle reported a failure. Never a "schedule" — the reply is a promise
     *  that the data is on disk. */
    forcePersist?: () => Promise<void>;
    sqlQuery?: (sql: string) => Promise<unknown[]>; // read-only SQL query (async)
    shutdown?: () => Promise<void>; // graceful shutdown
    startedAt: number; // Date.now() at boot
    /** Cell id → method (action) names — powers "run a method" buttons. */
    cellMethods?: () => Record<string, string[]>;
    /** Cell id → async method names — the calls a `_callId` can correlate. */
    cellAsyncMethods?: () => Record<string, string[]>;
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
    patches?: Array<
      { cell: string; ops: import("../protocol/patch-ops.ts").WirePatch[] }
    >,
  ) => void;
  /** Send raw string message to all connected WS clients, optionally excluding one */
  broadcastRaw: (msg: string, exclude?: WebSocket) => void;
  broadcastTT: () => void;
  shutdown: () => Promise<void>;
  clientCount: () => number;
  trojanPort?: number; // set when TLS is active — HTTP-only trojan endpoint on 127.0.0.1
  /** The port the TCP listener actually bound, once it is listening. Equal to
   *  the configured port whenever one was named; it differs only for
   *  `port: 0` ("pick a free port"). Undefined when this app binds no TCP
   *  port — the boot report must print no number at all for that case. */
  boundPort?: number;
  socketPath?: string; // set when UDS is active
  watcherActive?: boolean; // true if file watcher is running (dev mode only)
  /** Serve ONE control-plane request that arrived over a non-TCP wire (the
   *  UDS `ctl` frame — `am`, amui).
   *
   *  It is the same `handleRequest` the TCP listener calls, given a peer
   *  address of `{ transport: "unix" }`. That is the whole point: every gate
   *  the trojan has — the same-machine 404, the local control credential, the
   *  app's own key/user auth, the dev-only mount, the rate limit — is decided
   *  once, in one place, and a request over the socket meets exactly the same
   *  ones. A parallel socket-side control API would be a second decider for
   *  rules whose whole value is that there is only one.
   *
   *  `_isLocalRequest` already answers `true` for a unix peer ("same-machine
   *  by construction"), and the abuse-bucket key is already documented as
   *  absent for UDS — both were written for this before it existed. */
  control?: (
    req: Request,
  ) => Promise<Response>;
}
