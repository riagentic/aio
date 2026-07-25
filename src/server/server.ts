// HTTP + WebSocket server with live TSX transpilation (dev) or static serving (prod)
// Thin orchestrator — delegates to server-*.ts modules
import { enc } from "../protocol/envelope.ts";
import { join, resolve } from "@std/path";
import { DEFAULT_SYNC_INTERVAL_MS } from "./aio.ts";
import {
  diagEmit,
  diagSubscribe,
  initDiagnosticBus,
} from "../diagnostics/diagnostic-bus.ts";
import { setDiagEmit } from "../diagnostics/error.ts";
import { getLogDir, log } from "../diagnostics/logger-api.ts";
import {
  disposeClientLog,
  initClientLog,
  writeClientLog,
} from "./client-log.ts";

// ── Re-exports (public API) ──
export {
  buildBrowserImportMap,
  classifyBrowserError,
  generateDiagnosticHTML,
  generateHTML,
  MIME,
  TEXT_EXTENSIONS,
} from "./server-html.ts";
import { hasVendorImmer } from "./server-vendor.ts";
import { verifyPin } from "./pairing.ts";
export type { ServerConfig, ServerHandle } from "./server-types.ts";
export { _timingSafeEqual } from "./server-auth.ts";

// ── Internal imports ──
import type { ServerConfig, ServerHandle } from "./server-types.ts";
import { matchRoute } from "./route.ts";
import {
  makeServerRequest,
  runWithRequest,
  runWithUser,
} from "./auth-context.ts";
import type { AioUser } from "./aio-types.ts";
import { buildBrowserImportMap } from "./server-html.ts";
import {
  _buildUserResolver,
  _extractToken,
  _timingSafeEqual,
  authFailBudgetExceeded,
  recordAuthFail,
} from "./server-auth.ts";
import { handleAuthFlow } from "./auth-flows.ts";
import { stopEsbuild } from "./server-transpile.ts";
import { createWsManager } from "./server-ws.ts";
import { createBroadcaster } from "./server-broadcast.ts";
import { createStaticHandler } from "./server-static.ts";
import { createFileWatcher } from "./server-watcher.ts";
import {
  scanServerOnlyImports,
  startGraphValidation,
} from "./server-dev-checks.ts";
import type { TrojanDeps } from "./server-trojan.ts";
import { resetTrojanRateLimit } from "./server-trojan.ts";

function fileExists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

// B-11: tokens in the URL query string leak via browser history, proxy logs,
// and Referer headers. The timing-safe `?token=` path stays as an opt-in
// fallback (e.g. WS upgrades that can't set headers), but warn once per process
// the first time it's actually relied on so it isn't a silent hijacking surface.
let _tokenInUrlWarned = false;
function _warnTokenInUrl(): void {
  if (_tokenInUrlWarned) return;
  _tokenInUrlWarned = true;
  console.warn(
    "[aio] security: authenticated via ?token= in the URL — tokens leak via " +
      "browser history, proxy logs, and Referer. Prefer the Authorization: " +
      "Bearer header. Query-param auth is a fallback for header-less contexts.",
  );
}

/** True when a request originates from the SAME MACHINE — loopback TCP or a
 *  Unix socket. The trojan control plane uses this to stay off the network
 *  entirely: it is never reachable remotely, even under `--expose`. Unknown or
 *  absent origin fails CLOSED (treated as non-local). */
export function _isLocalRequest(addr: Deno.Addr | undefined): boolean {
  if (!addr) return false;
  if (addr.transport === "unix") return true; // same-machine by construction
  if ("hostname" in addr) {
    const h = addr.hostname;
    return h === "127.0.0.1" || h === "::1" || h === "localhost" ||
      h === "[::1]";
  }
  return false;
}

/** Starts HTTP + WS server, returns broadcast handle for state pushes and shutdown */
export function createServer(config: ServerConfig): ServerHandle {
  const { port, title, getUIState, dispatch, debug, prod = false, distDir } =
    config;

  // Diagnostic bus — dev-only event system for surfacing silent failures
  initDiagnosticBus(!prod);
  if (!prod) {
    setDiagEmit(diagEmit);
    initClientLog(getLogDir());
  }

  // Unified user resolver — one code path for both static map and dynamic hook (AIO-171)
  // AUTH-1: session tokens resolve FIRST (cheap indexed lookup, revocable),
  // then fall through to users/resolveUser. Sessions alone activate per-user
  // auth mode — an app with only `sessions: true` is a per-user app.
  const _baseResolver = _buildUserResolver(config);
  const _sessionResolver = config.sessionResolver;
  const _userResolver = _sessionResolver
    ? async (tok: string) =>
      _sessionResolver(tok) ?? (_baseResolver ? await _baseResolver(tok) : null)
    : _baseResolver;

  // Custom routes: reserve the framework namespaces loudly at boot.
  for (const key of Object.keys(config.routes ?? {})) {
    if (!key.startsWith("/") || key.startsWith("/__aio") || key === "/ws") {
      throw new Error(
        `[aio] invalid custom route "${key}" — routes must start with "/" and ` +
          `cannot use the reserved /__aio or /ws namespaces`,
      );
    }
  }

  const absBaseDir = resolve(config.baseDir);

  // Read deno.json imports for browser import map. Scaffolded apps keep it at
  // the project root (baseDir/..); flat apps (entry next to deno.json) and
  // repo examples run from cwd — first readable config wins.
  let denoImports: Record<string, string> = {};
  for (
    const candidate of [
      join(absBaseDir, "..", "deno.json"),
      join(absBaseDir, "deno.json"),
      join(Deno.cwd(), "deno.json"),
    ]
  ) {
    try {
      const djText = Deno.readTextFileSync(candidate);
      denoImports = JSON.parse(djText).imports ?? {};
      break;
    } catch {
      /* try next — missing/invalid config falls through to defaults */
    }
  }
  const importMapObj = buildBrowserImportMap(denoImports, {
    // prod serves bundles and the vendor route is dev-only — never point a
    // prod import map at it.
    vendorImmer: !prod && hasVendorImmer(),
  });
  const IMPORT_MAP = JSON.stringify({ imports: importMapObj });

  const absDistDir = distDir ? resolve(distDir) : null;
  const hasCSS = fileExists(join(absBaseDir, "style.css")) ||
    (absDistDir ? fileExists(join(absDistDir, "style.css")) : false);
  if (hasCSS) debug("style.css detected — injecting <link>");

  // Explicit in BOTH modes so prod caching isn't left to proxy heuristics — an
  // empty header lets an intermediary serve a stale asset after redeploy, a bug
  // that reproduces only in prod. Dev never caches (instant edits); prod may
  // cache but MUST revalidate, so a redeploy is always picked up.
  const noCache = prod
    ? { "Cache-Control": "no-cache" } as Record<string, string>
    : { "Cache-Control": "no-store" } as Record<string, string>;
  const bootId = crypto.randomUUID().slice(0, 8);
  const syncIntervalMs = config.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;

  // ── Dev startup checks ──
  const uiEntry = config.uiEntry ?? "App.tsx";
  if (!prod) {
    debug(
      `ui: serving ${uiEntry}${
        config.uiEntry ? "" : " (default convention — set ui.entry to override)"
      }`,
    );
  }
  const graphValidation = !prod
    ? startGraphValidation(absBaseDir, importMapObj, debug, uiEntry)
    : null;
  if (!prod) scanServerOnlyImports(absBaseDir, debug);

  // ── WS Manager — handles upgrades, per-client state, message routing ──
  const wsMgr = createWsManager({
    dispatch,
    getUIState,
    debug,
    prod,
    maxConnections: config.maxConnections,
    wsLimits: config.wsLimits,
    expose: config.expose,
    allowedOrigins: config.allowedOrigins,
    strictOrigin: config.strictOrigin,
    clientCounter: config.clientCounter ?? { value: 0 },
    bootId,
    vitalsSystem: config.vitalsSystem,
    onConnect: config.onConnect,
    onDisconnect: config.onDisconnect,
    onTTCommand: config.onTTCommand,
    getTTBroadcast: config.getTTBroadcast,
    syncHandler: config.syncHandler,
  });

  // ── Broadcaster — throttled state pushes to all WS clients ──
  const broadcaster = createBroadcaster({
    connections: wsMgr.connections,
    payloadStats: wsMgr.payloadStats,
    getUIState,
    debug,
    syncIntervalMs,
    fullStateThreshold: config.fullStateThreshold,
    vitalsSystem: config.vitalsSystem,
    getTTBroadcast: config.getTTBroadcast,
  });

  // Forward diagnostic bus events to all connected dev clients via WS
  if (!prod) {
    diagSubscribe((ev) => {
      broadcaster.broadcastRaw(enc("diag", ev));
      if (ev.severity === "error" || ev.severity === "warning") {
        for (const meta of wsMgr.connections.values()) {
          writeClientLog(meta.index, {
            level: ev.severity === "error" ? "error" : "warn",
            msg: ev.message,
            ts: Date.now(),
            source: "diag",
          });
        }
      }
    });
  }

  // ── Static handler — HTTP routes, transpilation, trojan API ──
  const staticHandler = createStaticHandler({
    prod,
    debug,
    title,
    absBaseDir,
    absDistDir,
    hasCSS,
    importMap: IMPORT_MAP,
    noCache,
    showStatus: config.showStatus,
    uiEntry: config.uiEntry,
    viewport: config.viewport,
    headExtra: config.headExtra,
    width: config.width,
    height: config.height,
    renderBudget: config.renderBudget,
    getGraphResult: () => graphValidation?.getResult() ?? null,
    getSnapshot: config.getSnapshot,
    loadSnapshot: config.loadSnapshot,
    getHealth: config.getHealth,
    vitalsSystem: config.vitalsSystem,
    getVitalsExtra: () => {
      const clientBP: Record<string, number> = {};
      for (const [, meta] of wsMgr.connections) {
        clientBP[meta.id] = meta.bpMultiplier;
      }
      return {
        payloadStats: wsMgr.payloadStats,
        clientBackpressure: clientBP,
        rawState: config.trojan
          ? config.trojan.getState() as Record<string, unknown>
          : undefined,
      };
    },
    trojan: config.trojan ? { getState: config.trojan.getState } : undefined,
    getTrojanDeps: () => _buildTrojanDeps(),
  });

  // ── File watcher — debounced live reload (dev only) ──
  let watcher: ReturnType<typeof createFileWatcher> | null = null;
  if (!prod) {
    watcher = createFileWatcher({
      absBaseDir,
      uiEntry,
      port,
      importMapObj,
      debug,
      broadcastWs: (msg) => broadcaster.broadcastRaw(msg),
      onReload: config.onReload,
      onCellChange: config.onCellChange,
      onGraphResult: (result) => graphValidation?.setResult(result),
    });
    watcher.start();
  }

  // ── Build TrojanDeps lazily (uses wsMgr) ──
  function _buildTrojanDeps(): TrojanDeps {
    return {
      dispatch,
      getUIState,
      debug,
      prod,
      port,
      title,
      appId: config.appId,
      token: config.token,
      certPem: config.cert,
      expose: config.expose,
      trojan: config.trojan!,
      authInfo: {
        mode: _userResolver
          ? (config.resolveUser ? "resolveUser" : "users")
          : config.token
          ? "token"
          : "public",
        expose: config.expose ?? false,
      },
      loadSnapshot: config.loadSnapshot,
      onTTCommand: config.onTTCommand,
      getWsClients: () =>
        [...wsMgr.connections.entries()].map(([ws, m]) => ({
          ws,
          meta: {
            index: m.index,
            id: m.id,
            clientType: m.clientType,
            user: m.user?.id,
            readyState: ws.readyState,
          },
        })),
      sendToWsClient: (idx, msg) => wsMgr.sendToWsClient(idx, msg),
      getRecentErrors: () => staticHandler.getRecentErrors(),
      findUserById: config.users
        ? (id) => Object.values(config.users!).find((u) => u.id === id)
        : undefined,
      // Headless `am surface` (machine M2): render the UI entry in-process
      // against live cell state — works with zero connected clients. Lazy:
      // happy-dom + the renderer load only when the route is hit.
      renderServerSurface: !prod
        ? async () => {
          const { renderHeadlessSurface } = await import(
            "./server-surface.ts"
          );
          return renderHeadlessSurface(join(absBaseDir, uiEntry));
        }
        : undefined,
    };
  }

  // ── HTTP request handler (with auth gates) ──
  const handleRequest = async (
    req: Request,
    info?: Deno.ServeHandlerInfo,
  ): Promise<Response> => {
    const url = new URL(req.url);
    const { pathname } = url;
    // F-4: derive a stable client key for cross-connection abuse tracking
    // (denylist, per-IP auth-fail budget, lockout bucketing).
    // TCP: remote hostname (IP). UDS: no key — in-process trust, skip denylist.
    // Behind a trusted reverse proxy the TCP peer is the proxy — every client
    // would collapse into ONE bucket (shared auth budget = trivial global
    // login DoS). When `trustProxyHeader` is set, take the CLIENT ip from the
    // FIRST hop of that header instead. Opt-in: honoring a client-settable
    // header without a proxy in front would let an attacker forge a fresh key
    // per request and evade the budget entirely.
    const addr = info?.remoteAddr;
    const peerKey = addr && "hostname" in addr &&
        typeof addr.hostname === "string"
      ? addr.hostname
      : undefined;
    let clientKey = peerKey;
    if (config.trustProxyHeader && peerKey) {
      const fwd = req.headers.get(config.trustProxyHeader);
      const first = fwd?.split(",")[0]?.trim();
      if (first) clientKey = first;
    }

    // The trojan control plane is same-machine-ONLY — never reachable over the
    // network, even under --expose (its localhost binding is not load-bearing).
    // A remote caller gets a plain 404 so the endpoint's existence isn't even
    // revealed to a network scanner. This composes with the dev-only mount gate
    // in server-static: the trojan answers only when the request is BOTH local
    // AND the build is dev.
    if (
      pathname.startsWith("/__aio/trojan/") && !_isLocalRequest(addr)
    ) {
      return new Response("Not Found", { status: 404 });
    }

    // AUTH-2 login flows — mounted BEFORE the auth gates for the same reason
    // as pairing: the caller is asking FOR credentials, so it can't present
    // them. Each route does its own gating (origin check, fail budget).
    if (config.authFlows) {
      const authResp = await handleAuthFlow(
        req,
        url,
        config.authFlows,
        clientKey,
      );
      if (authResp) return authResp;
    }

    // Pairing endpoint — the ONE route that bypasses the key gate (the client
    // is asking FOR the key, so it can't present it). PIN-gated instead:
    // POST { pin } → the app profile (cert + key) when the PIN is valid.
    if (pathname === "/__aio/pair" && req.method === "POST" && config.token) {
      try {
        const body = await req.json() as { pin?: unknown };
        if (!verifyPin(body?.pin, clientKey)) {
          return new Response(
            JSON.stringify({ error: "invalid or expired pairing code" }),
            { status: 401, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            aio: 1,
            name: config.appId ?? title,
            title,
            port,
            tls: !!config.cert,
            cert: config.cert ?? null,
            key: config.token,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      } catch {
        return new Response(JSON.stringify({ error: "invalid request" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Auth path 1: per-user auth — resolveUser hook or static users map (AIO-171)
    if (_userResolver) {
      // Brute-force budget: a key with too many recent failures is refused
      // BEFORE the resolver runs (resolveUser may hit a JWKS/DB — don't let
      // an attacker drive that). 429, not 401: "back off", not "wrong token".
      if (authFailBudgetExceeded(clientKey)) {
        return new Response("Too Many Requests", { status: 429 });
      }
      const token = _extractToken(url, req);
      // AUTH-2: with the login flows enabled, the app SHELL is public — a
      // browser must load the UI (code, not state) to show SignIn before it
      // has a session. Everything stateful stays gated: /ws requires a valid
      // session, /__aio/snapshot requires admin. Without authFlows the
      // classic behavior is untouched: no token, no bytes.
      const shellIsPublic = config.authFlows !== undefined;
      if (!token && !shellIsPublic) {
        return new Response("Unauthorized", { status: 401 });
      }
      const user = token ? await _userResolver(token) : null;
      if (!user) {
        if (token) recordAuthFail(clientKey, "invalid token (per-user mode)");
        if (!shellIsPublic || pathname === "/ws") {
          return new Response("Unauthorized", { status: 401 });
        }
        // public shell: fall through to static serving as anonymous
        if (pathname === "/__aio/snapshot") {
          return new Response("Unauthorized", { status: 401 });
        }
        const anonResp = await staticHandler.serveStatic(pathname, req);
        anonResp.headers.set("X-Content-Type-Options", "nosniff");
        return anonResp;
      }
      if (url.searchParams.get("token")) _warnTokenInUrl();
      if (pathname === "/ws") return wsMgr.handleWs(req, user, clientKey);
      // Snapshot dumps/overwrites RAW state — it bypasses ui include/exclude
      // and forUser filtering, so only admins may touch it in per-user mode.
      if (pathname === "/__aio/snapshot" && user.role !== "admin") {
        return new Response(
          'Forbidden — /__aio/snapshot exposes unfiltered state and requires role "admin"',
          { status: 403 },
        );
      }
      debug(`http: ${req.method} ${pathname} user=${user.id}`);
      // Custom routes run authenticated in per-user mode too — the handler's
      // ctx.user is this resolved user.
      const routed = await tryRoutes(req, pathname, user, addr);
      if (routed) return routed;
      const resp = await staticHandler.serveStatic(pathname, req);
      resp.headers.set("X-Content-Type-Options", "nosniff");
      return resp;
    }

    // Auth path 2: single shared token (--expose without users)
    if (config.token) {
      if (authFailBudgetExceeded(clientKey)) {
        return new Response("Too Many Requests", { status: 429 });
      }
      const qToken = url.searchParams.get("token");
      const auth = req.headers.get("authorization");
      const hToken = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      const validQ = qToken !== null && _timingSafeEqual(qToken, config.token);
      const validH = hToken !== null && _timingSafeEqual(hToken, config.token);
      if (!validQ && !validH) {
        // Only PRESENTED-and-wrong tokens burn budget — a tokenless probe
        // (health check, crawler) is a plain 401, not an attack signal.
        if (qToken !== null || hToken !== null) {
          recordAuthFail(clientKey, "invalid token (shared-key mode)");
        }
        return new Response("Unauthorized", { status: 401 });
      }
      if (validQ && !validH) _warnTokenInUrl();
    }

    // Snapshot dumps/overwrites RAW unfiltered state (bypasses ui.exclude /
    // ui.include / forUser). Per-user mode admin-gates it above (auth path 1,
    // where an admin may act remotely); in shared-token and public modes there
    // is no role boundary, so it is same-machine-only — a shared token must not
    // grant a network client a raw-state read or a full-state overwrite.
    if (pathname === "/__aio/snapshot" && !_isLocalRequest(addr)) {
      return new Response(
        "Forbidden — /__aio/snapshot exposes unfiltered state; localhost or an authenticated admin only",
        { status: 403 },
      );
    }

    if (pathname === "/ws") return wsMgr.handleWs(req, undefined, clientKey);
    debug(`http: ${req.method} ${pathname}`);
    // ── Custom user routes (uploads, webhooks, API endpoints) ──
    const routed = await tryRoutes(req, pathname, undefined, addr);
    if (routed) return routed;

    const resp = await staticHandler.serveStatic(pathname, req);
    resp.headers.set("X-Content-Type-Options", "nosniff");
    return resp;
  };

  /** Match config.routes and invoke the handler with a route match (params +
   *  the resolved user + client ip). `:param`/`*` patterns supported; a literal
   *  exact match is tried first. Returns null when no route matches. Shared by
   *  every auth path so custom routes work authenticated too. */
  async function tryRoutes(
    req: Request,
    pathname: string,
    user: AioUser | undefined,
    addr: Deno.Addr | undefined,
  ): Promise<Response | null> {
    if (!config.routes) return null;
    const ip = addr && "hostname" in addr ? addr.hostname : undefined;
    // Ambient request + identity: a handler (and every cell method / serverFn
    // it calls, across awaits) can ask serverRequest() for the client IP,
    // headers and cookies without the route threading them down by hand.
    const rc = makeServerRequest(req, ip, "http");
    const run = <T>(fn: () => T): T =>
      runWithRequest(rc, () => runWithUser(user, fn));
    // Exact literal match first (fast + unambiguous).
    const exact = config.routes[pathname];
    if (exact) return await run(() => exact(req, { params: {}, user, ip }));
    for (const [pattern, handler] of Object.entries(config.routes)) {
      if (!pattern.includes(":") && !pattern.includes("*")) continue;
      const params = matchRoute(pattern, pathname);
      if (params) return await run(() => handler(req, { params, user, ip }));
    }
    return null;
  }

  // ── Start HTTP server ──
  let httpServer: Deno.HttpServer;
  const udsPath = config.socketPath;
  if (udsPath) {
    try {
      Deno.removeSync(udsPath);
    } catch { /* doesn't exist */ }
    httpServer = Deno.serve(
      { path: udsPath, onListen: () => {} },
      handleRequest,
    );
  } else {
    const hostname = config.expose ? "0.0.0.0" : "127.0.0.1";
    const tlsOpts = config.cert && config.key
      ? { cert: config.cert, key: config.key }
      : {};
    try {
      httpServer = Deno.serve({
        port,
        hostname,
        onListen: () => {},
        ...tlsOpts,
      }, handleRequest);
    } catch (e) {
      if (e instanceof Deno.errors.AddrInUse) {
        // Loud + fatal (quant Bad #4): a bind failure usually means another
        // instance of this app is already running. Refuse to start rather than
        // run a second cell runtime that could write to the same DB/journal.
        throw new Error(
          `port ${port} already in use — another instance is likely already ` +
            `running. Refusing to start a second cell runtime (it could corrupt ` +
            `shared persistence). Stop the other instance, or use --port=N for a ` +
            `separate one.`,
        );
      }
      throw e;
    }
  }

  // When TLS is active: spin up a plain-HTTP trojan server on 127.0.0.1
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
      async (req) => {
        // Authenticate trojan requests on localhost — same rules as main server
        if (config.token) {
          const url = new URL(req.url);
          const qToken = url.searchParams.get("token");
          const auth = req.headers.get("authorization");
          const hToken = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
          const validQ = qToken !== null &&
            _timingSafeEqual(qToken, config.token);
          const validH = hToken !== null &&
            _timingSafeEqual(hToken, config.token);
          if (!validQ && !validH) {
            return new Response("Unauthorized", { status: 401 });
          }
        } else if (_userResolver) {
          // users/resolveUser mode: config.token is unset — still require a
          // valid user token, and gate snapshot to admins like the main server
          const url = new URL(req.url);
          const token = _extractToken(url, req);
          const user = token ? await _userResolver(token) : null;
          if (!user) return new Response("Unauthorized", { status: 401 });
          if (url.pathname === "/__aio/snapshot" && user.role !== "admin") {
            return new Response(
              'Forbidden — /__aio/snapshot exposes unfiltered state and requires role "admin"',
              { status: 403 },
            );
          }
        }
        const { pathname } = new URL(req.url);
        if (pathname.startsWith("/__aio/")) {
          return staticHandler.serveStatic(pathname, req);
        }
        if (pathname === "/") return new Response("ok", { status: 200 });
        return new Response("Not Found", { status: 404 });
      },
    );
  }

  // ── Zombie-server guard (watcher-loop field report #4) ──
  // Event-loop starvation once killed the HTTP listener while the process kept
  // spinning (alive-but-dead). Crash loudly instead so a supervisor restarts us.
  let _shuttingDown = false;
  httpServer.finished.then(() => {
    if (_shuttingDown) return;
    console.error(
      "[aio] FATAL: HTTP listener died unexpectedly — exiting so a supervisor can restart (zombie-server guard)",
    );
    Deno.exit(1);
  });
  // Event-loop stall detector: a 1s timer that arrives seconds late means the
  // loop was blocked (sync-write storms, runaway reducers). Named diagnostic
  // beats downstream symptoms.
  let _lastTick = Date.now();
  const _stallTimer = setInterval(() => {
    const nowMs = Date.now();
    const drift = nowMs - _lastTick - 1000;
    _lastTick = nowMs;
    if (drift > 3000) {
      log.warn(
        "loop",
        `event-loop stalled ~${Math.round(drift / 1000)}s — a sync-blocking ` +
          `storm or runaway reducer is starving the server`,
      );
      diagEmit({
        type: "loop:stall",
        severity: "warning",
        source: "server",
        message: `event loop blocked ~${Math.round(drift / 1000)}s`,
        hint:
          "look for a high-frequency dispatch loop or sync work in reducers/effects",
      });
    }
  }, 1000);
  Deno.unrefTimer?.(_stallTimer as unknown as number);

  return {
    broadcast: (patches) => broadcaster.broadcast(patches),
    broadcastRaw: (msg, exclude) => broadcaster.broadcastRaw(msg, exclude),
    broadcastTT: () => broadcaster.broadcastTT(),
    clientCount: () => wsMgr.connections.size,
    trojanPort,
    socketPath: udsPath,
    watcherActive: watcher?.active,
    shutdown: async () => {
      _shuttingDown = true;
      clearInterval(_stallTimer);
      watcher?.shutdown();
      broadcaster.shutdown();
      resetTrojanRateLimit();
      wsMgr.shutdown();
      if (graphValidation) await graphValidation.done.catch(() => {});
      await Promise.all([
        httpServer.shutdown(),
        trojanServer?.shutdown(),
      ]);
      await stopEsbuild();
      if (udsPath) {
        try {
          Deno.removeSync(udsPath);
        } catch { /* already removed */ }
      }
      disposeClientLog();
    },
  };
}
