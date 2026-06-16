// HTTP + WebSocket server with live TSX transpilation (dev) or static serving (prod)
// Thin orchestrator — delegates to server-*.ts modules
import { join, resolve } from "@std/path";
import { DEFAULT_SYNC_INTERVAL_MS } from "./aio.ts";
import {
  diagEmit,
  diagSubscribe,
  initDiagnosticBus,
} from "./diagnostic-bus.ts";
import { setDiagEmit } from "./error.ts";
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
export type { ServerConfig, ServerHandle } from "./server-types.ts";
export { _timingSafeEqual } from "./server-auth.ts";

// ── Internal imports ──
import type { ServerConfig, ServerHandle } from "./server-types.ts";
import { buildBrowserImportMap } from "./server-html.ts";
import {
  _buildUserResolver,
  _extractToken,
  _timingSafeEqual,
} from "./server-auth.ts";
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

/** Starts HTTP + WS server, returns broadcast handle for state pushes and shutdown */
export function createServer(config: ServerConfig): ServerHandle {
  const { port, title, getUIState, dispatch, debug, prod = false, distDir } =
    config;

  // Diagnostic bus — dev-only event system for surfacing silent failures
  initDiagnosticBus(!prod);
  if (!prod) {
    setDiagEmit(diagEmit);
    initClientLog("./log");
  }

  // Unified user resolver — one code path for both static map and dynamic hook (AIO-171)
  const _userResolver = _buildUserResolver(config);

  const absBaseDir = resolve(config.baseDir);

  // Read deno.json imports for browser import map
  let denoImports: Record<string, string> = {};
  try {
    const djText = Deno.readTextFileSync(join(absBaseDir, "..", "deno.json"));
    denoImports = JSON.parse(djText).imports ?? {};
  } catch { /* no deno.json or parse error — use defaults */ }
  const importMapObj = buildBrowserImportMap(denoImports);
  const IMPORT_MAP = JSON.stringify({ imports: importMapObj });

  const absDistDir = distDir ? resolve(distDir) : null;
  const hasCSS = fileExists(join(absBaseDir, "style.css")) ||
    (absDistDir ? fileExists(join(absDistDir, "style.css")) : false);
  if (hasCSS) debug("style.css detected — injecting <link>");

  const noCache = prod
    ? {}
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
    vitalsSystem: config.vitalsSystem,
    getTTBroadcast: config.getTTBroadcast,
  });

  // Forward diagnostic bus events to all connected dev clients via WS
  if (!prod) {
    diagSubscribe((ev) => {
      broadcaster.broadcastRaw("__diag:" + JSON.stringify(ev));
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
    };
  }

  // ── HTTP request handler (with auth gates) ──
  const handleRequest = async (
    req: Request,
    info?: Deno.ServeHandlerInfo,
  ): Promise<Response> => {
    const url = new URL(req.url);
    const { pathname } = url;
    // F-4: derive a stable client key for cross-connection abuse tracking.
    // TCP: remote hostname (IP). UDS: no key — in-process trust, skip denylist.
    const addr = info?.remoteAddr;
    const clientKey =
      addr && "hostname" in addr && typeof addr.hostname === "string"
        ? addr.hostname
        : undefined;

    // Auth path 1: per-user auth — resolveUser hook or static users map (AIO-171)
    if (_userResolver) {
      const token = _extractToken(url, req);
      if (!token) return new Response("Unauthorized", { status: 401 });
      const user = await _userResolver(token);
      if (!user) return new Response("Unauthorized", { status: 401 });
      if (pathname === "/ws") return wsMgr.handleWs(req, user, clientKey);
      debug(`http: ${req.method} ${pathname} user=${user.id}`);
      const resp = await staticHandler.serveStatic(pathname, req);
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
      if (validQ && !validH) _warnTokenInUrl();
    }

    if (pathname === "/ws") return wsMgr.handleWs(req, undefined, clientKey);
    debug(`http: ${req.method} ${pathname}`);
    const resp = await staticHandler.serveStatic(pathname, req);
    resp.headers.set("X-Content-Type-Options", "nosniff");
    return resp;
  };

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
        throw new Error(
          `port ${port} already in use — pick another with --port=N`,
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
      (req) => {
        // Authenticate trojan requests on localhost — same token as main server
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

  return {
    broadcast: (patches) => broadcaster.broadcast(patches),
    broadcastRaw: (msg, exclude) => broadcaster.broadcastRaw(msg, exclude),
    broadcastTT: () => broadcaster.broadcastTT(),
    clientCount: () => wsMgr.connections.size,
    trojanPort,
    socketPath: udsPath,
    watcherActive: watcher?.active,
    shutdown: async () => {
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
