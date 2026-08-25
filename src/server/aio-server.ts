// Server & transport setup — TLS, HTTP server, UDS listener, signal handlers
// Extracted from aio.ts _run() to keep the orchestrator lean.

import { enc } from "../protocol/envelope.ts";
import { shutdownAllRuntimes } from "./shutdown.ts";
import { restartForCellChange } from "./dev-restart.ts";
import { loadOrCreateCert, type TlsCert } from "./tls.ts";
import { createServer } from "./server.ts";
import { parseCli, VERSION } from "./aio-cli.ts";
import type { ServerHandle } from "./server-types.ts";
import type { UiTheme } from "./aio-types.ts";
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
  /** Whether `port` was NAMED (`--port`, `AIO_PORT`, `aio.run({ port })`)
   *  rather than picked free by the runtime — the zero-port opt-out. */
  portRequested: boolean;
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
  /** WHERE the opt-out came from, so the warning can name what was actually
   *  written. `--no-tls` and `tls: false` resolve to ONE decider (`cliNoTls`),
   *  which loses the provenance — and an author who wrote `tls: false` in
   *  deno.json was then told to "Drop --no-tls", a flag not in their
   *  invocation. A message naming a mechanism the reader did not use costs
   *  them a search. */
  noTlsSource?: "flag" | "config";
  cliTransport?: "uds" | "ws" | "auto";
  // UI
  ui: {
    width?: number;
    height?: number;
    showStatus?: boolean;
    entry?: string; // AIO-8.1
    viewport?: string | false; // AIO-423
    head?: string; // AIO-423
    chrome?: "standard" | "themed" | "none"; // desktop window frame
    theme?: UiTheme; // how much of the default look the shell emits
    lang?: string; // <html lang> — WCAG 3.1.1, default "en"
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
  /** The socket the HTTP handler listens on when this app binds no TCP port
   *  (dev + electron + UDS). Undefined whenever a port is in play. */
  httpSocketPath?: string;
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
/**
 * What to say when TLS is off, named for HOW it was turned off.
 *
 * Pure, so both wordings are a unit test rather than a claim about a branch
 * that runs only on a real exposed boot. `--no-tls` and `tls: false` reach the
 * server as one decider; only the MESSAGE needs to know which was written,
 * because an instruction naming a mechanism the reader did not use sends them
 * hunting for a flag that is not in their invocation (R-7 follow-up).
 */
export function _noTlsWarning(
  expose: boolean,
  source: "flag" | "config",
): string {
  const said = source === "flag" ? "--no-tls" : "`tls: false`";
  const undo = source === "flag" ? "Drop --no-tls" : 'Set `tls: "auto"`';
  if (!expose) {
    // Something that does nothing must say so. Loopback is plain HTTP either
    // way, so there is no wrong OUTCOME here — but someone who set it believes
    // they changed something, and the next step in that belief is assuming
    // --expose would also be plaintext-by-default. Cheap to say, expensive to
    // discover.
    return `tls: ${said} has no effect without --expose — a loopback server ` +
      `is plain HTTP already. It only matters when exposing to a network.`;
  }
  return `tls: ${said} — serving on 0.0.0.0 over PLAIN HTTP/WS. State, auth ` +
    `tokens and every action are readable and forgeable by anything on this ` +
    `network. Sound ONLY if the payload is already end-to-end encrypted or a ` +
    `TLS-terminating proxy fronts this port. ${undo} for HTTPS.`;
}

/** Zero TCP ports — THE decision, as one pure function (tested as a table).
 *
 *  A local desktop app that serves nothing to a browser or another service
 *  has no reason to open a port. A port is a COST, not a feature: it is
 *  reachable by every process and every browser tab on the machine, it is
 *  one more thing `am` and the boot report have to name, and a wallet-class
 *  app in a field report had it open for no reader at all. So a local
 *  Electron app on a Unix socket (`localElectronUds`) binds NO TCP port by
 *  default, in dev and prod alike. Two shapes of zero, differing only in
 *  where the PAGE comes from:
 *    • prod with a readable dist/ — the page comes off disk; the HTTP handler
 *      is skipped entirely (`skipHttp`) UNLESS the app declares custom
 *      `routes`, which then run on a socket the window proxies to (an
 *      `<img src="/nft-image/x">` resolves to `aio://app/nft-image/x`).
 *    • dev — the page and its modules are transpiled on demand, so the
 *      handler always runs, on the socket.
 *  Everything that needs a URL keeps a port: a browser client, `--expose`,
 *  the thin client, prod without a readable dist/, Windows (no Unix-socket
 *  listener in Deno — `resolveTransport` picks WS there, so
 *  `localElectronUds` is false), and — the explicit opt-out — an app whose
 *  port was NAMED (`--port=N`, `AIO_PORT`, `aio.run({ port })`): a route that
 *  another process must reach over TCP (a webhook receiver, a `curl` probe, a
 *  browser tab beside the window) is exactly the case where naming the port
 *  is the honest spelling. */
export function resolveZeroPort(i: {
  prod: boolean;
  localElectronUds: boolean;
  canServeFromDisk: boolean;
  /** A port was named — flag, env or config. The opt-out. */
  portRequested: boolean;
  routeCount: number;
}): { zeroPort: boolean; skipHttp: boolean; useHttpSocket: boolean } {
  const zeroPort = i.localElectronUds && !i.portRequested &&
    (i.prod ? i.canServeFromDisk : true);
  const skipHttp = zeroPort && i.prod && i.routeCount === 0;
  return { zeroPort, skipHttp, useHttpSocket: zeroPort && !skipHttp };
}

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
    noTlsSource,
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
  if (cliNoTls) {
    log.warn(_noTlsWarning(expose, noTlsSource ?? "flag"));
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
        log.info(
          `tls: self-signed cert at ${tlsCert.certPath}` +
            (tlsCert.caPath
              // The anchor is what a client pins, and it is deliberately NOT
              // the leaf: the leaf is re-issued whenever this machine's
              // addresses change, and a pin on it would break every time.
              ? ` (trust anchor: ${tlsCert.caPath} — pin THIS)`
              : ""),
        );
        log.warn(
          `tls: self-signed — browsers show a security warning, and ` +
            `non-browser clients (curl, deno/node fetch, the aio CLI client) ` +
            `REFUSE the connection outright unless they trust this exact ` +
            `cert. Hand it out with \`am profile --app=${appId}\`, point a client ` +
            `at it with DENO_CERT=${tlsCert.caPath ?? tlsCert.certPath} ` +
            `(curl: --cacert), ` +
            `serve a real cert with \`tls: { cert, key }\`, or drop TLS with ` +
            `\`tls: false\` / --no-tls if a proxy or your own encryption ` +
            `covers the wire (--tls-cert=/path.pem --tls-key=/path.pem is the ` +
            `flag spelling of the cert pair)`,
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

  // ── Zero TCP ports, where zero is possible ──────────────────────────────
  //
  // A local Electron app talks to its own server over a Unix socket. Nothing
  // about that needs a port, so it should not open one: a loopback port is
  // reachable by every process on the machine and by any browser tab, while a
  // socket sits in a 0700 directory. The port was never the feature — it was
  // the only wire the page could arrive on.
  //
  // There are two ways to reach zero, and they differ only in where the PAGE
  // comes from:
  //   • prod, with a readable dist/ — Electron loads the bundle straight off
  //     disk (aio://), so no request handler is needed at all.
  //   • dev — the page and its modules must be transpiled on demand, so the
  //     handler still runs; it just listens on a SOCKET instead of a port
  //     (`Deno.serve({ path })`), and Electron fetches through it.
  // Everything that needs a URL — a browser client, --expose, a NAMED port —
  // keeps one. See `resolveZeroPort` for the principle.
  const canServeFromDisk = !!electronDistDir;
  const localElectronUds = transport === "uds" && useElectron && !expose;
  const routeCount = config.routes ? Object.keys(config.routes).length : 0;
  if (parseCli().zeroPort) {
    // Accepted, never an error: scripts pass it. It was the dev opt-in before
    // zero became the default; the opt-OUT is a named port.
    log.info(
      "--zero-port: already the default for a local electron app (the flag is a no-op; --port=N keeps a TCP listener)",
    );
  }
  const zp = resolveZeroPort({
    prod,
    localElectronUds,
    canServeFromDisk,
    portRequested: deps.portRequested,
    routeCount,
  });
  const { zeroPort, skipHttp } = zp;
  if (zeroPort && routeCount > 0) {
    log.info(
      `${routeCount} custom route(s) served over the socket ` +
        `(aio://app/<path>) — no TCP port. A route another process must ` +
        `reach over TCP (a webhook receiver) needs a named port: --port=N`,
    );
  }
  if (localElectronUds && deps.portRequested && !prod) {
    log.info(
      `port ${port} named explicitly — keeping a TCP listener for this local ` +
        `electron app (drop --port / AIO_PORT / config.port for zero ports)`,
    );
  }
  /** The handler on a SOCKET instead of a port. Its own socket — the NDJSON
   *  transport owns `<appId>.sock` and one listener per path is the rule. */
  const httpSocketPath = zp.useHttpSocket
    ? resolveSocketPath(appId, "http")
    : undefined;
  if (prod && localElectronUds && !zeroPort) {
    log.warn(
      "prod+electron: no dist/ readable outside the binary (embedded VFS " +
        "only) — keeping the HTTP server so the window can load. Ship dist/ " +
        "next to the binary (the AppImage/AppDir layout) for zero TCP ports.",
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
            new Error(
              `cell "${cellName}.${method}" — access denied` +
                // Named HERE, at the moment it is needed. The operator hitting
                // this from `am` is usually not being refused by mistake:
                // "public read, server-only write" is a shape aio encourages,
                // and its consequence is that the CLI cannot call the method
                // either. Without the pointer the fallback was `am snapshot
                // save/load` — validation bypassed entirely, the wrong tool.
                (prod
                  ? ""
                  : `. From the CLI in dev: \`am dispatch ${cellName}:${method} ` +
                    `--as-server\` (loopback-only, logged, refused in prod)`),
            ),
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
      // The zero-port route: the handler listens on a SOCKET instead of a
      // TCP port (`Deno.serve({ path })`). `port` above is then unused — the
      // boot report says so rather than printing a number nothing bound.
      ...(httpSocketPath ? { socketPath: httpSocketPath } : {}),
      appId,
      clientCounter,
      title,
      vitalsSystem,
      costMeter,
      width: ui.width,
      height: ui.height,
      getUIState: (user?: AioUser) => getUIState(getState(), user),
      dispatch: dispatchNetwork,
      // The SERVER-origin path, for `am dispatch --as-server` — the operator
      // escape hatch for a cell whose `access` rule (correctly) refuses every
      // network caller. See the trojan route; it is dev-only, loopback-only
      // and audit-logged, exactly like the rest of the trojan.
      dispatchAsServer: (action: unknown) => dispatch(action as A),
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
      chrome: ui.chrome,
      theme: ui.theme,
      lang: ui.lang,
      // The accent follows the app's IDENTITY, not its window title: a title
      // that changes with the route must not recolour the app mid-session.
      themeName: appId || title,
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
            // WHICH process answered. Without it, an orphan holding the port —
            // a run whose lock is gone but whose process kept serving — is
            // indistinguishable from the app you meant, and a field report
            // read five-hour-old numbers out of one for a whole session. The
            // pid is how `am kill --stale` can end it.
            pid: Deno.pid,
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
          pid: Deno.pid,
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
      // The control plane, over the socket. `server.control` IS the HTTP
      // handler, so `am` reaches the same routes behind the same gates on
      // either wire — the transport stops deciding what the operator can do.
      // Absent on the skipHttp stub, which is correct: that path is prod, and
      // the trojan does not exist in prod at all.
      server.control,
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
      // An app with no TCP listener must not leave a port number in the lock
      // that reads like one: 0 is the honest answer, and `am` follows the
      // socket instead (a port-0 lock is valid — see readLock).
      ...(zeroPort ? { port: 0 } : {}),
    });
  }

  return {
    server,
    udsHandle: uds,
    tlsCert,
    transport,
    skipHttp,
    ...(httpSocketPath ? { httpSocketPath } : {}),
    shareUrl,
    localUrl,
    bindHost,
    advertiseHost: _advertiseHost,
  };
}
