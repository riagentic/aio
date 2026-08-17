// Server & transport setup — TLS, HTTP server, UDS listener, signal handlers
// Extracted from aio.ts _run() to keep the orchestrator lean.

import { enc } from "../protocol/envelope.ts";
import { shutdownAllRuntimes } from "./shutdown.ts";
import { restartForCellChange } from "./dev-restart.ts";
import { loadOrCreateCert, type TlsCert } from "./tls.ts";
import { createServer } from "./server.ts";
import { parseCli, VERSION } from "./aio-cli.ts";
import type { ServerHandle } from "./server-types.ts";
import { _getCallTimeouts, registerCall } from "../state/cell-impl.ts";
import { createUDSListener, type UDSHandle } from "./uds.ts";
import { flushAllUrgent } from "./broadcast-coalescer.ts";
import { appDirs } from "./app-dirs.ts";
import type {
  CellPatchStrategy,
  PatchFilterFields,
} from "../state/state-filter.ts";
import type { AioUser } from "./aio.ts";
import type { ServerSyncHandler } from "../sync/server-handler.ts";
import type { ComposedCells } from "../state/cell.ts";
import type { VitalsSystem } from "../vitals/mod.ts";
import type { AppLock } from "./single-instance-lock.ts";
import { resolveSocketPath, resolveTransport } from "./paths.ts";
import type { Log } from "../diagnostics/logger-api.ts";
import {
  clientDegradedReport,
  degradedReport,
} from "../diagnostics/degraded.ts";
import { cellAccessAllowed } from "./server-auth.ts";
import type { Access } from "../state/cell-types.ts";

/** The slice of `AioConfig` the transport layer reads — HOP 2 of the config
 *  bridge (`aio.run({…})` → `setupTransport`).
 *
 *  ONE DECIDER: this declaration is the only list. `aio.ts` hands over the
 *  WHOLE config object (a bare `config,` — never a hand-copied literal) and
 *  this type picks what may be read, so a key added here is wired by the fact
 *  of being declared. The hand-copied spread that used to sit at the call site
 *  dropped a key SIX times, always silently — `strictOrigin`, `redactActions`,
 *  `appDir`, `renderBudget`, then `serveDirs` (the whole feature was dead on
 *  arrival in alpha45: typed, allowlisted, documented, 404) and `_cellNames`
 *  (which made the browser's cell-set-drift warning unreachable code).
 *
 *  `tests/config-bridge-hop2.test.ts` gates both halves: every key declared
 *  here must be a real developer-settable config key (so a rename on either
 *  side is a red test, not silent `undefined`), and the call site must stay a
 *  mechanical passthrough. */
export interface TransportConfig {
  transport?: "uds" | "ws" | "auto";
  /** Bind ONE address instead of the expose-derived default — see
   *  `AioConfig.host`. */
  host?: string;
  renderBudget?: import("../vitals/types.ts").RenderBudget;
  fullStateThreshold?: number;
  routes?: Record<string, import("./route.ts").RawRouteHandler>;
  maxConnections?: number;
  wsLimits?: import("./aio-types.ts").WsLimits;
  allowedOrigins?: string[];
  strictOrigin?: boolean;
  trustProxyHeader?: string;
  syncIntervalMs?: number;
  /** Extra read-only DEV roots by URL prefix — see `AioConfig.serveDirs`. */
  serveDirs?: Record<string, string>;
  /** Cell ids that sync (own `sync:` config, or adopted by localFirst) —
   *  handed to the browser in the page shell. */
  _syncCellIds?: string[];
  /** Every cell this server booted — rides the `cfg` frame so the browser can
   *  name a cell that exists in the bundle but not in the running server. */
  _cellNames?: string[];
  _cellPatchStrategies?: Map<string, CellPatchStrategy>;
  _cellFilterFields?: Map<string, PatchFilterFields>;
  _cellAccess?: Map<string, Access>;
  onConnect?: (user?: AioUser) => void;
  onDisconnect?: (user?: AioUser) => void;
  libraryMode?: boolean;
}

/** Inputs needed for server & transport setup */
export interface ServerSetupDeps<S, A> {
  /** Cost meter (`am cost`) — recorded in the broadcast path, read by the
   *  trojan `cost` route. */
  costMeter?: import("../vitals/cost-meter.ts").CostMeter;
  // Identity & network
  appId: string;
  port: number;
  prod: boolean;
  distDir: string;
  /** Real-filesystem `dist/` Electron can read from its own process, if any —
   *  the precondition for running with zero TCP ports. See skipHttp below. */
  electronDistDir: string | undefined;
  baseDir: string;
  expose: boolean;
  token: string | undefined;
  users: Record<string, AioUser> | undefined;
  resolveUser:
    | ((tok: string) => AioUser | null | Promise<AioUser | null>)
    | undefined;
  /** AUTH-1: session-token resolver — consulted before users/resolveUser. */
  sessionResolver?: (tok: string) => AioUser | null;
  /** AUTH-2: login-flow deps (users/sessions stores + policy) — the TLS-aware
   *  `secure` cookie flag is added here, where the cert is resolved. */
  authFlows?: Omit<import("./auth-flows.ts").AuthFlows, "secure">;
  cliCert?: string;
  cliKey?: string;
  /** `--no-tls`: serve `--expose` over plain HTTP/WS. Everything downstream is
   *  already parameterized on `tlsCert` being nullable (ws:// vs wss://, the
   *  cookie `secure` flag, the discovery record's `tls:`), so this is one
   *  gate — plus a loud warning, because the wire becomes readable. */
  cliNoTls?: boolean;
  cliTransport?: "uds" | "ws" | "auto";
  // UI
  ui: {
    width?: number;
    height?: number;
    showStatus?: boolean;
    entry?: string; // AIO-8.1
    viewport?: string | false; // AIO-423
    head?: string; // AIO-423
  };
  title: string;
  config: TransportConfig;
  // Runtime refs — getState is a getter so closures always see the current value
  getState: () => S;
  getUIState: (s: S, user?: AioUser) => unknown;
  dispatch: (action: A) => Promise<unknown> | void;
  app: { snapshot: () => string; loadSnapshot: (json: string) => void };
  /** Content-addressed blob store (`app.blobs`) — served at /__aio/blobs/. */
  blobs?: import("./blobs.ts").BlobStore;
  // Server features
  vitalsSystem?: VitalsSystem;
  useElectron: boolean;
  // Time-travel
  tt: {
    handleTTCommand: (cmd: string, arg?: number) => void;
    getTTBroadcast: () => unknown;
  } | null;
  // Sync
  syncHandler: ServerSyncHandler | null | undefined;
  syncBroadcastRef: { fn: ((msg: string, exclude?: WebSocket) => void) | null };
  // Shutdown
  shutdown: () => Promise<void>;
  // UDS handle ref — assigned inside setupTransport
  udsHandle: { current: UDSHandle | null };
  // Persistence
  schedulePersist: () => void;
  shouldPersist: boolean;
  // Schedule + DB
  scheduleManager: { active: () => string[] };
  /** Cell id → method names — for the trojan `cells` route (amui method buttons). */
  cellMethods?: Record<string, string[]>;
  /** Cell id → per-field persist/ui flags — for the trojan `fields` route. */
  cellFields?: import("./aio-types.ts").CellFieldFlags;
  asyncDb: { query: (sql: string) => Promise<{ rows: unknown[] }> } | null;
  /** In-memory dispatch timeline — the trojan `timeline` route. */
  getTimeline?: (
    after?: number,
    limit?: number,
  ) => import("./timeline.ts").TimelineEntry[];
  /** Boot migration + shape-drift picture — trojan `migrations`. */
  migrations?: import("./aio-boot.ts").MigrationSummary;
  // Lock
  appLock: AppLock | null;
  // Client counter
  clientCounter: { value: number };
  log: Log;
}

/** Result from server & transport setup */
export interface ServerSetupResult {
  server: ServerHandle;
  udsHandle: UDSHandle | null;
  tlsCert: TlsCert | null;
  transport: "uds" | "ws";
  skipHttp: boolean;
  shareUrl: string;
  localUrl: string;
  /** The address the listener is ACTUALLY bound to — `host` when set, else the
   *  expose-derived default. THE one decider: every consumer (boot report,
   *  share link, the launched client window) reads this, never `parseCli()`
   *  again. Three places used to derive it independently and only the bind
   *  knew about `host`, so a `--host=192.168.1.20` app advertised (and opened
   *  a window at) `localhost`, where nothing was listening. */
  bindHost: string;
  /** How the bind address is NAMED in output (`localhost` for a loopback
   *  bind, `0.0.0.0` for the wildcard, the address itself otherwise). */
  advertiseHost: string;
}

/** Resolve TLS, create HTTP server, wire sync broadcast, set up UDS & signal handlers */
export async function setupTransport<S, A>(
  deps: ServerSetupDeps<S, A>,
): Promise<ServerSetupResult> {
  const {
    appId,
    port,
    prod,
    distDir,
    electronDistDir,
    baseDir,
    expose,
    token,
    users,
    resolveUser,
    sessionResolver,
    authFlows,
    cliCert,
    cliKey,
    cliNoTls,
    cliTransport,
    ui,
    title,
    config,
    getState,
    getUIState,
    dispatch,
    app,
    vitalsSystem,
    costMeter,
    useElectron,
    tt,
    syncHandler,
    syncBroadcastRef,
    shutdown,
    udsHandle: udsRef,
    schedulePersist,
    shouldPersist,
    scheduleManager,
    asyncDb,
    appLock,
    clientCounter,
    log,
  } = deps;

  // THE bind-address decider, resolved once: the operator's flag wins over the
  // author's config, and the expose-derived default fills in. Everything that
  // NAMES the address downstream (boot report, share link, the client window
  // aio opens) reads `bindHost` from the result — deriving it a second time is
  // how an app came to advertise `localhost` while listening only on a LAN
  // address, so `deno task dev --host=…` opened a window at a dead URL.
  const _host = parseCli().host ?? config.host;
  const bindHost = _host ?? (expose ? "0.0.0.0" : "127.0.0.1");
  // `localhost` resolves to 127.0.0.1 (or ::1) SPECIFICALLY — an app bound to
  // 127.0.0.2 or a LAN address does not answer there. So the friendly name is
  // used only when the bind really is reachable by it; any other address is
  // printed as itself.
  const _isLocalhostAddr = bindHost === "127.0.0.1" || bindHost === "::1" ||
    bindHost === "[::1]";
  const _isWildcard = bindHost === "0.0.0.0" || bindHost === "::";
  /** What a URL must say to reach this app from HERE (this machine). */
  const _selfHost = _isLocalhostAddr || _isWildcard ? "localhost" : bindHost;
  /** What to advertise: the wildcard stays `0.0.0.0` (it means "every
   *  interface — substitute your LAN IP"), a loopback bind reads friendlier as
   *  `localhost`, and a chosen address is quoted verbatim. */
  const _advertiseHost = _isLocalhostAddr ? "localhost" : bindHost;

  // TLS: auto-generate self-signed cert when exposed (or use user-provided
  // --tls-cert/--tls-key). `--no-tls` is the one way out, and it costs a loud
  // warning: every downstream consumer (ws:// vs wss://, the cookie `secure`
  // flag, the discovery record's `tls:`) already reads `tlsCert` as nullable.
  let tlsCert: TlsCert | null = null;
  if (expose && cliNoTls) {
    log.warn(
      `tls: --no-tls — serving on 0.0.0.0 over PLAIN HTTP/WS. State, auth ` +
        `tokens and every action are readable and forgeable by anything on ` +
        `this network. Sound ONLY if the payload is already end-to-end ` +
        `encrypted or a TLS-terminating proxy fronts this port. Drop ` +
        `--no-tls for HTTPS.`,
    );
  } else if (!expose && cliNoTls) {
    // A flag that does nothing must say so. Loopback is plain HTTP either way,
    // so there is no wrong OUTCOME here — but someone passing --no-tls believes
    // they changed something, and the next step in that belief is assuming
    // --expose would also be plaintext-by-default. Cheap to say, expensive to
    // discover.
    log.warn(
      `tls: --no-tls has no effect without --expose — a loopback server is ` +
        `plain HTTP already. The flag only matters when exposing to a network.`,
    );
  } else if (expose) {
    // Tier ① — a private key belongs in the backup unit, and in ONE place
    // whether or not this is a compiled binary (it used to be ./.aio-tls in dev
    // and the XDG data dir when compiled).
    const certDir = appDirs(appId, (config as { appDir?: string }).appDir).tls;
    try {
      // appId → the cert's CN: every aio app used to issue `CN = aio-local`,
      // so two apps (or one stale cert in a trust store) produced colliding
      // issuer DNs and a client picked the WRONG trust anchor — a BadSignature
      // handshake failure with no hint of its cause.
      tlsCert = await loadOrCreateCert(certDir, cliCert, cliKey, appId);
      if (tlsCert.selfSigned) {
        log.info(`tls: self-signed cert at ${tlsCert.certPath}`);
        log.warn(
          `tls: self-signed — browsers show a security warning, and ` +
            `non-browser clients (curl, deno/node fetch, the aio CLI client) ` +
            `REFUSE the connection outright unless they trust this exact ` +
            `cert. Hand it out with \`am profile --app=${appId}\`, point a client ` +
            `at it with DENO_CERT=${tlsCert.certPath} (curl: --cacert), or ` +
            `pass --tls-cert=/path.pem --tls-key=/path.pem for a CA-signed one`,
        );
      } else {
        log.info(`tls: using cert ${tlsCert.certPath}`);
      }
    } catch (e) {
      throw new Error(
        `TLS cert generation failed: ${e}\nProvide --tls-cert=PATH --tls-key=PATH, or run with --no-tls if this network path is already encrypted. Cannot expose over HTTPS without a cert.`,
      );
    }
  }

  // Resolve transport (client already resolved above)
  const transport = resolveTransport(
    cliTransport ?? config.transport,
    useElectron,
    expose,
  );

  // Prod + UDS + electron: skip HTTP server entirely (zero TCP ports — all via
  // UDS+IPC). Conditional on `electronDistDir`: without a dist/ Electron can
  // open itself it loads the page over HTTP, and skipping the server would
  // hand it a refused connection — a blank window (the AppImage bug).
  const canServeFromDisk = !!electronDistDir;
  const skipHttp = prod && transport === "uds" && useElectron && !expose &&
    canServeFromDisk;
  if (prod && transport === "uds" && useElectron && !expose && !skipHttp) {
    log.warn(
      "prod+electron: no dist/ readable outside the binary (embedded VFS " +
        "only) — keeping the HTTP server so the window can load. Ship dist/ " +
        "next to the binary (the AppImage/AppDir layout) for zero TCP ports.",
    );
  }
  // Doctrine: no silent dev/prod divergence. Custom `routes` are served by the
  // HTTP server; skipping it in prod would let a webhook/callback endpoint work
  // all through development and then silently connection-refuse in production.
  // Refuse loudly at boot with the fix instead of dropping them unseen.
  if (skipHttp && config.routes && Object.keys(config.routes).length > 0) {
    throw new Error(
      `[aio] ${Object.keys(config.routes).length} custom HTTP route(s) are ` +
        `configured, but in prod + electron + UDS the app runs with NO TCP ` +
        `HTTP server (zero ports) — they cannot be served and would silently ` +
        `404 in production while working in dev. Serve them another way: set ` +
        `client:"ws" (or "server-only"), pass --expose, or move the endpoint ` +
        `into a serverFn.`,
    );
  }
  // Network-borne dispatch: auth-gate → dispatch → resolve with the method's
  // RETURN value. Shared by the WS server and the UDS listener so both give an
  // awaiting caller (browser ack, trojan, CLI) the real value, and both enforce
  // the same declarative cell-access gate.
  const dispatchNetwork = (
    action: unknown,
    user?: AioUser,
  ): Promise<unknown> | void => {
    // AUTH-1: declarative cell access — every network-borne action is
    // checked against its cell's rule BEFORE dispatch. Server-origin
    // dispatches never pass through here, so server code always bypasses.
    const a = action as Record<string, unknown>;
    const type = typeof a?.type === "string" ? a.type as string : "";
    const cellAccess = config._cellAccess;
    if (cellAccess && cellAccess.size > 0 && type.includes(":")) {
      const cellName = type.slice(0, type.indexOf(":"));
      const rule = cellAccess.get(cellName);
      if (rule !== undefined) {
        // Method = the originating method name (async batches carry it in
        // payload._origin); fall back to the action-type suffix.
        const origin = (a.payload as Record<string, unknown> | undefined)
          ?._origin;
        const method = typeof origin === "string"
          ? origin
          : type.slice(cellName.length + 1);
        // Forward the method's call args so a predicate can do row-level authz
        //. Method dispatches carry `payload.args: [...]`.
        const argv = (a.payload as { args?: unknown } | undefined)?.args;
        const args = Array.isArray(argv) ? argv : [];
        if (!cellAccessAllowed(rule, user, method, args)) {
          log.warn(
            `[aio] auth: cell "${cellName}" action "${type}" denied for ${
              user ? `user=${user.id} role=${user.role}` : "anonymous client"
            }`,
          );
          // The caller is TOLD (serverFns already answer denials; a denial
          // that resolves like a success is a silent drop the client cannot
          // distinguish from a working call). The ack path turns this into
          // an error frame; pre-caught so a fire-and-forget action without a
          // cid cannot become an unhandled rejection.
          const denial = Promise.reject(
            new Error(`cell "${cellName}.${method}" — access denied`),
          );
          denial.catch(() => {});
          return denial;
        }
      }
    }
    const tagged = user
      ? { ...(action as Record<string, unknown>), _user: user }
      : action;
    // Return-value transport: an ASYNC method carries `_callId`; the executor
    // resolves that id with the method's RETURN value when it completes.
    // Register the call and return THAT promise, so an awaiting caller
    // (browser ack / trojan / CLI) resolves with the value — not the early
    // reduce result. SYNC/void methods have no `_callId`; `dispatch()` already
    // resolves with their value (or undefined), so return it directly.
    const callId = (tagged as { payload?: { _callId?: string } }).payload
      ?._callId;
    // Interactive priority: a client action's patches flush IMMEDIATELY
    // (after the sync commit, and again when an async method settles) —
    // the coalescer throttle paces background churn, and made every user
    // keystroke pay up to syncIntervalMs of latency (a field report:
    // navigation measured a constant ~66ms; ~50ms of it was this window).
    if (typeof callId === "string" && callId.length > 0) {
      // The action type IS "cell:method" — so a network-dispatched call picks
      // up the same per-method ceiling a direct call does.
      const done = registerCall(callId, (tagged as { type?: string }).type);
      void Promise.resolve(dispatch(tagged as A)).catch(() => {});
      queueMicrotask(flushAllUrgent);
      void done.then(
        () => flushAllUrgent(),
        () => flushAllUrgent(),
      );
      return done;
    }
    const result = dispatch(tagged as A);
    queueMicrotask(flushAllUrgent);
    void Promise.resolve(result).then(
      () => flushAllUrgent(),
      () => flushAllUrgent(),
    );
    return result;
  };

  // tt-state over UDS: the broadcaster gets a late-bound raw-broadcast hook,
  // set once the UDS listener exists (syncBroadcastRef pattern). Without it
  // the Electron window's time-travel panel never received a frame.
  const udsBroadcastRef: { fn: ((raw: string) => void) | null } = { fn: null };

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
      appId,
      clientCounter,
      title,
      vitalsSystem,
      costMeter,
      width: ui.width,
      height: ui.height,
      getUIState: (user?: AioUser) => getUIState(getState(), user),
      dispatch: dispatchNetwork,
      getSnapshot: () => app.snapshot(),
      loadSnapshot: (json: string) => app.loadSnapshot(json),
      blobs: deps.blobs,
      baseDir,
      serveDirs: config.serveDirs,
      debug: (msg: string) => log.debug(msg),
      prod,
      distDir: prod ? distDir : undefined,
      expose,
      // Same one-source rule as expose: the flag wins over config, decided
      // here and nowhere downstream (`bindHost`, returned below).
      host: _host,
      token,
      users,
      resolveUser,
      sessionResolver,
      authFlows: authFlows
        ? { ...authFlows, secure: !!tlsCert?.cert }
        : undefined,
      cert: tlsCert?.cert,
      key: tlsCert?.key,
      showStatus: ui.showStatus,
      uiEntry: ui.entry,
      viewport: ui.viewport,
      headExtra: ui.head,
      renderBudget: config.renderBudget,
      syncCells: config._syncCellIds,
      bootedCells: config._cellNames,
      callTimeouts: _getCallTimeouts(),
      udsBroadcastRef,
      fullStateThreshold: config.fullStateThreshold,
      routes: config.routes,
      maxConnections: config.maxConnections,
      wsLimits: config.wsLimits,
      allowedOrigins: config.allowedOrigins,
      strictOrigin: config.strictOrigin,
      trustProxyHeader: config.trustProxyHeader,
      syncIntervalMs: config.syncIntervalMs,
      cellPatchStrategies: config._cellPatchStrategies,
      cellFilterFields: config._cellFilterFields,
      onConnect: config.onConnect,
      onDisconnect: config.onDisconnect,
      onReload: (signal) => {
        if (udsRef.current) udsRef.current.broadcast(enc(signal));
      },
      // Cells run in THIS process, so an edited cell can't hot-reload — dev
      // restarts the app instead of asking the developer to.
      // Never in prod (no watcher) and never in libraryMode, where the host
      // process is not ours to replace.
      ...(prod || config.libraryMode ? {} : {
        onCellChange: (path: string) => {
          void restartForCellChange(path, shutdown);
        },
      }),
      getHealth: () => {
        const composed = (globalThis as Record<string, unknown>)
          .__aioCells as ComposedCells | undefined;
        const uptime = Math.round(
          (Date.now() -
            ((globalThis as Record<string, unknown>).__aioStartedAt as number ??
              Date.now())) / 1000,
        );
        if (composed) {
          const cellsHealth: Record<string, unknown> = {};
          for (
            const fs of composed.registry.health(
              getState() as Record<string, unknown>,
            )
          ) {
            cellsHealth[fs.name] = {
              status: fs.status ?? "active",
              enabled: fs.enabled,
              errors: fs.errors,
              lastAction: fs.lastAction,
            };
          }
          // W4.1: include the framework version so operators can confirm which
          // build is live (deploy verification, rolling-restart checks).
          // "healthy" is a claim, so anything that has been failing on repeat
          // has to appear here — an app reporting healthy while a subsystem is
          // permanently dead is precisely the failure this endpoint invites.
          const dead = degradedReport();
          const clientDead = clientDegradedReport();
          return {
            status: dead.length > 0 || clientDead.length > 0
              ? "degraded"
              : "healthy",
            version: VERSION,
            appId,
            uptime,
            cells: cellsHealth,
            ...(dead.length > 0 ? { degraded: dead } : {}),
            ...(clientDead.length > 0 ? { clientDegraded: clientDead } : {}),
          };
        }
        const dead = degradedReport();
        const clientDead = clientDegradedReport();
        return {
          status: dead.length > 0 || clientDead.length > 0
            ? "degraded"
            : "healthy",
          version: VERSION,
          appId,
          uptime,
          ...(dead.length > 0 ? { degraded: dead } : {}),
          ...(clientDead.length > 0 ? { clientDegraded: clientDead } : {}),
        };
      },
      ...(tt
        ? {
          onTTCommand: tt.handleTTCommand,
          getTTBroadcast: tt.getTTBroadcast,
        }
        : {}),
      ...(syncHandler ? { syncHandler } : {}),
      trojan: {
        getState: () => getState(),
        getSchedules: () => scheduleManager.active(),
        cellMethods: () => deps.cellMethods ?? {},
        cellFields: () => deps.cellFields ?? {},
        ...(deps.getTimeline ? { getTimeline: deps.getTimeline } : {}),
        ...(deps.migrations ? { getMigrations: () => deps.migrations } : {}),
        ...(tt ? { getTTHistory: tt.getTTBroadcast } : {}),
        ...(shouldPersist ? { forcePersist: () => schedulePersist() } : {}),
        ...(asyncDb
          ? {
            sqlQuery: async (sql: string) => (await asyncDb!.query(sql)).rows,
          }
          : {}),
        // libraryMode means aio is embedded (a test, a host process): tearing
        // down is ours to do, exiting the process is not — the same rule the
        // signal handlers below already follow.
        //
        // NOT libraryMode: this call ends the PROCESS, so every app in it goes
        // down — including one that is still writing. Stop them all first
        // (shutdownAllRuntimes), or `am stop app-a` silently truncates app-b's
        // final snapshot.
        shutdown: () =>
          config.libraryMode
            ? shutdown()
            : shutdownAllRuntimes().then(() => Deno.exit(0)),
        startedAt: Date.now(),
        udsClients: () =>
          udsRef.current
            ? udsRef.current.clients().map((c) => ({
              index: c.index,
              id: c.id,
            }))
            : [],
        requestUdsClientState: (index: number, msg?: string) =>
          udsRef.current
            ? udsRef.current.requestClientState(index, msg)
            : Promise.resolve({ error: "UDS not active" }),
      },
    });

  // Wire sync broadcast now that server handle is available. v2 parity:
  // UDS peers receive op broadcasts too (no per-conn exclude there — the
  // client engine's self-origin guard absorbs own-op echoes).
  if (syncHandler) {
    syncBroadcastRef.fn = (msg, exclude) => {
      server.broadcastRaw(msg, exclude);
      udsRef.current?.broadcast(msg);
    };
  }

  if (skipHttp) log.info("prod+UDS: HTTP server skipped (zero TCP ports)");

  // libraryMode: don't register process-wide signal handlers. They call
  // Deno.exit (killing an embedding host / test runner) and, unremoved, leak
  // resources that fail Deno's test sanitizer — the reason a server couldn't be
  // booted inside Deno.test before. app.close() drives shutdown instead.
  if (!config.libraryMode) {
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      try {
        Deno.addSignalListener(sig, () => {
          // EVERY app in the process, not just this one — see
          // `shutdownAllRuntimes`. One handler per app all calling it is fine:
          // each app's shutdown is memoised.
          shutdownAllRuntimes().then(() => Deno.exit(0)).catch(() =>
            Deno.exit(1)
          );
        });
      } catch { /* signal not supported on this platform */ }
    }
  }

  // UDS listener
  let uds: UDSHandle | null = null;
  if (transport === "uds") {
    const socketPath = resolveSocketPath(appId);
    uds = createUDSListener(
      socketPath,
      () => getUIState(getState()),
      (action) => dispatchNetwork(action),
      (msg: string) => log.debug(msg),
      clientCounter,
      syncHandler,
      {
        ...(config.renderBudget ? { renderBudget: config.renderBudget } : {}),
        ...(config._syncCellIds && config._syncCellIds.length
          ? { syncCells: config._syncCellIds }
          : {}),
        callTimeouts: _getCallTimeouts(),
      },
      tt
        ? { onCommand: tt.handleTTCommand, getBroadcast: tt.getTTBroadcast }
        : undefined,
      // The UDS twin of wsLimits.maxMessageBytes — an app that raised its WS
      // frame ceiling for large payloads gets the same ceiling on this path.
      config.wsLimits?.maxMessageBytes,
    );
    udsRef.current = uds;
    const u = uds;
    udsBroadcastRef.fn = (raw) => u.broadcast(raw);
    log.info(`transport: UDS at ${socketPath}`);
  }

  const useHttps = expose && !!tlsCert;
  // Both URLs name the address the listener is ACTUALLY on. `shareUrl` is what
  // you hand to another machine (the bound address as-is); `localUrl` is what
  // THIS machine opens — `localhost` only when the bind really answers there.
  const _scheme = useHttps ? "https" : "http";
  const shareUrl = `${_scheme}://${_advertiseHost}:${port}`;
  const localUrl = `${_scheme}://${_selfHost}:${port}`;

  // Update lock file with runtime info
  if (appLock) {
    appLock.update({
      status: "started",
      ...(server.trojanPort ? { trojanPort: server.trojanPort } : {}),
      ...(uds ? { socketPath: uds.socketPath } : {}),
    });
  }

  return {
    server,
    udsHandle: uds,
    tlsCert,
    transport,
    skipHttp,
    shareUrl,
    localUrl,
    bindHost,
    advertiseHost: _advertiseHost,
  };
}
