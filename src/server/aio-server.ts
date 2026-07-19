// Server & transport setup — TLS, HTTP server, UDS listener, signal handlers
// Extracted from aio.ts _run() to keep the orchestrator lean.

import { join } from "@std/path";
import { loadOrCreateCert, type TlsCert } from "./tls.ts";
import { createServer } from "./server.ts";
import { VERSION } from "./aio-cli.ts";
import type { ServerHandle } from "./server-types.ts";
import { createUDSListener, type UDSHandle } from "./uds.ts";
import type {
  CellPatchStrategy,
  PatchFilterFields,
} from "../state/state-filter.ts";
import type { AioUser } from "./aio.ts";
import type { ServerSyncHandler } from "../sync/server-handler.ts";
import type { ComposedCells } from "../state/cell.ts";
import type { VitalsSystem } from "../vitals/mod.ts";
import type { AppLock } from "./single-instance-lock.ts";
import {
  isCompiled,
  resolveDataDir,
  resolveSocketPath,
  resolveTransport,
} from "./paths.ts";
import type { Log } from "../diagnostics/logger.ts";

/** Inputs needed for server & transport setup */
export interface ServerSetupDeps<S, A> {
  // Identity & network
  appId: string;
  port: number;
  prod: boolean;
  distDir: string;
  baseDir: string;
  expose: boolean;
  token: string | undefined;
  users: Record<string, AioUser> | undefined;
  resolveUser:
    | ((tok: string) => AioUser | null | Promise<AioUser | null>)
    | undefined;
  cliCert?: string;
  cliKey?: string;
  cliTransport?: "uds" | "ws" | "auto";
  // UI
  ui: {
    width?: number;
    height?: number;
    showStatus?: boolean;
    entry?: string; // AIO-8.1
  };
  title: string;
  // Config knobs
  config: {
    transport?: "uds" | "ws" | "auto";
    renderBudget?: import("../vitals/types.ts").RenderBudget;
    fullStateThreshold?: number;
    routes?: Record<string, (req: Request) => Response | Promise<Response>>;
    maxConnections?: number;
    wsLimits?: import("./aio-types.ts").WsLimits;
    allowedOrigins?: string[];
    strictOrigin?: boolean;
    syncIntervalMs?: number;
    _cellPatchStrategies?: Map<string, CellPatchStrategy>;
    _cellFilterFields?: Map<string, PatchFilterFields>;
    onConnect?: (user?: AioUser) => void;
    onDisconnect?: (user?: AioUser) => void;
    libraryMode?: boolean;
  };
  // Runtime refs — getState is a getter so closures always see the current value
  getState: () => S;
  getUIState: (s: S, user?: AioUser) => unknown;
  dispatch: (action: A) => void;
  app: { snapshot: () => string; loadSnapshot: (json: string) => void };
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
  asyncDb: { query: (sql: string) => Promise<{ rows: unknown[] }> } | null;
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
    baseDir,
    expose,
    token,
    users,
    resolveUser,
    cliCert,
    cliKey,
    cliTransport,
    ui,
    title,
    config,
    getState,
    getUIState,
    dispatch,
    app,
    vitalsSystem,
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

  // TLS: auto-generate self-signed cert when --expose (or use user-provided --cert/--key)
  let tlsCert: TlsCert | null = null;
  if (expose) {
    const certDir = isCompiled()
      ? resolveDataDir(appId)
      : join(Deno.cwd(), ".aio-tls");
    try {
      tlsCert = await loadOrCreateCert(certDir, cliCert, cliKey);
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

  // Resolve transport (client already resolved above)
  const transport = resolveTransport(
    cliTransport ?? config.transport,
    useElectron,
    expose,
  );

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
      appId,
      clientCounter,
      title,
      vitalsSystem,
      width: ui.width,
      height: ui.height,
      getUIState: (user?: AioUser) => getUIState(getState(), user),
      dispatch: (action, user?) => {
        const tagged = user
          ? { ...(action as Record<string, unknown>), _user: user }
          : action;
        dispatch(tagged as A);
      },
      getSnapshot: () => app.snapshot(),
      loadSnapshot: (json: string) => app.loadSnapshot(json),
      baseDir,
      debug: (msg: string) => log.debug(msg),
      prod,
      distDir: prod ? distDir : undefined,
      expose,
      token,
      users,
      resolveUser,
      cert: tlsCert?.cert,
      key: tlsCert?.key,
      showStatus: ui.showStatus,
      uiEntry: ui.entry,
      renderBudget: config.renderBudget,
      fullStateThreshold: config.fullStateThreshold,
      routes: config.routes,
      maxConnections: config.maxConnections,
      wsLimits: config.wsLimits,
      allowedOrigins: config.allowedOrigins,
      strictOrigin: config.strictOrigin,
      syncIntervalMs: config.syncIntervalMs,
      cellPatchStrategies: config._cellPatchStrategies,
      cellFilterFields: config._cellFilterFields,
      onConnect: config.onConnect,
      onDisconnect: config.onDisconnect,
      onReload: (signal) => {
        if (udsRef.current) udsRef.current.broadcast(signal);
      },
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
          return {
            status: "healthy",
            version: VERSION,
            uptime,
            cells: cellsHealth,
          };
        }
        return { status: "healthy", version: VERSION, uptime };
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
        ...(tt ? { getTTHistory: tt.getTTBroadcast } : {}),
        ...(shouldPersist ? { forcePersist: () => schedulePersist() } : {}),
        ...(asyncDb
          ? {
            sqlQuery: async (sql: string) => (await asyncDb!.query(sql)).rows,
          }
          : {}),
        shutdown: () => shutdown().then(() => Deno.exit(0)),
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

  // Wire sync broadcast now that server handle is available
  if (syncHandler) syncBroadcastRef.fn = server.broadcastRaw;

  if (skipHttp) log.info("prod+UDS: HTTP server skipped (zero TCP ports)");

  // libraryMode: don't register process-wide signal handlers. They call
  // Deno.exit (killing an embedding host / test runner) and, unremoved, leak
  // resources that fail Deno's test sanitizer — the reason a server couldn't be
  // booted inside Deno.test before (TBD B5). app.close() drives shutdown instead.
  if (!config.libraryMode) {
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      try {
        Deno.addSignalListener(sig, () => {
          shutdown().then(() => Deno.exit(0)).catch(() => Deno.exit(1));
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
      (action) => {
        dispatch(action as A);
      },
      (msg: string) => log.debug(msg),
      clientCounter,
      config.fullStateThreshold ?? 0.5,
      config._cellPatchStrategies,
      config._cellFilterFields,
    );
    udsRef.current = uds;
    log.info(`transport: UDS at ${socketPath}`);
  }

  const useHttps = expose && !!tlsCert;
  const shareUrl = useHttps
    ? `https://0.0.0.0:${port}`
    : expose
    ? `http://0.0.0.0:${port}`
    : `http://localhost:${port}`;
  const localUrl = useHttps
    ? `https://localhost:${port}`
    : `http://localhost:${port}`;

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
  };
}
