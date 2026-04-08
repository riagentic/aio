// Lifecycle & client launch — globals, onStart, schedules, startup logging, electron/browser
// Extracted from aio.ts _run() to keep the orchestrator lean.

import { join } from "@std/path";
import { type AioMeta, launchElectron } from "./electron.ts";
import type { ServerHandle } from "./server-types.ts";
import type { UDSHandle } from "./uds.ts";
import type { TlsCert } from "./tls.ts";
import type { AioUser } from "./aio.ts";
import { VERSION } from "./aio-cli.ts";
import { diagEmit } from "./diagnostic-bus.ts";
import type { Log } from "./logger.ts";
import type { DB } from "./db/mod.ts";
import type { ScheduleDef } from "./schedule.ts";

/** Inputs for lifecycle startup */
export interface LifecycleDeps<S, A> {
  // Identity
  appId: string;
  appVersion: string;
  title: string;
  // Mode flags
  prod: boolean;
  distDir: string;
  expose: boolean;
  singletonMode: boolean;
  // Client / transport
  client: string;
  useElectron: boolean;
  isHeadless: boolean;
  transport: "uds" | "ws";
  skipHttp: boolean;
  // Network
  port: number;
  token: string | undefined;
  users: Record<string, AioUser> | undefined;
  tlsCert: TlsCert | null;
  shareUrl: string;
  localUrl: string;
  // Server & UDS
  server: ServerHandle;
  udsHandle: UDSHandle | null;
  // App
  app: {
    dispatch: (action: A) => Promise<void>;
    getState: () => S;
    port?: number;
  };
  // Hooks
  // must accept typed AioApp<S, A> via contravariance
  // deno-lint-ignore no-explicit-any
  onStart: ((app: any) => void) | undefined;
  // Schedules
  scheduleManager: { start: (defs: ScheduleDef[]) => void };
  schedules: ScheduleDef[] | undefined;
  // Persistence
  shouldPersist: boolean;
  persistMode: string;
  // DB
  asyncDb: DB | null;
  db: Record<string, unknown> | undefined;
  // Config
  maxConnections: number | undefined;
  // CLI overrides
  cli: { width?: number; height?: number; keepServer?: boolean };
  ui: { width?: number; height?: number };
  keepServer: boolean | undefined;
  // Shutdown & electron
  shutdown: () => Promise<void>;
  setElectronProc: (proc: Deno.ChildProcess | null) => void;
  log: Log;
}

/** Run lifecycle startup — set globals, fire hooks, log info, launch client */
export function startLifecycle<S, A>(deps: LifecycleDeps<S, A>): void {
  const {
    appId,
    appVersion,
    title,
    prod,
    distDir,
    expose,
    singletonMode,
    client,
    useElectron,
    isHeadless,
    transport,
    skipHttp,
    port,
    token,
    users,
    tlsCert,
    shareUrl,
    localUrl,
    server,
    udsHandle,
    app,
    onStart,
    scheduleManager,
    schedules,
    shouldPersist,
    persistMode,
    asyncDb,
    db,
    maxConnections,
    cli,
    ui,
    keepServer: configKeepServer,
    shutdown,
    setElectronProc,
    log,
  } = deps;

  // Set __aio global variables
  (globalThis as Record<string, unknown>).__aioStartedAt = Date.now();
  const __aio =
    ((globalThis as Record<string, unknown>).__aio ??= {}) as Record<
      string,
      unknown
    >;
  __aio.appVersion = appVersion;
  __aio.aioVersion = VERSION;

  // onStart hook — error-guarded
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

  // Start schedules
  if (schedules?.length) {
    scheduleManager.start(schedules);
    log.info(`schedules: ${schedules.length} started`);
  }

  // Startup logging
  const url = shareUrl;
  const useHttps = expose && !!tlsCert;
  const cliFlags = Deno.args.filter((a) => a.startsWith("--") && a.length > 2);
  if (cliFlags.length) log.info(`cli: ${cliFlags.join(" ")}`);
  else log.debug("run with --help to see available flags");
  const mode = prod ? "prod" : "dev";
  const shell = client;
  const transportLabel = transport === "uds" ? ", uds" : "";

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
    const dbKeyCount = Object.keys(db ?? {}).length;
    log.info(
      `${p("sqlite")}${dbKeyCount} table${dbKeyCount !== 1 ? "s" : ""}`,
    );
  }
  log.info(`${p("expose")}${expose}`);
  const authLabel = users
    ? `${Object.keys(users).length} user(s)`
    : token
    ? "token"
    : "none";
  log.info(`${p("auth")}${authLabel}`);
  if (schedules?.length) {
    log.info(`${p("schedules")}${schedules.length}`);
  }
  if (maxConnections !== undefined) {
    log.info(`${p("maxconn")}${maxConnections}`);
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

  // Validate keepServer
  const keepServer = cli.keepServer ?? configKeepServer ?? false;
  if (keepServer && client !== "electron") {
    throw new Error("keepServer only applies when client is electron");
  }

  // Launch client
  if (isHeadless) {
    // Headless — server-only, no UI launch (CLI apps use connectCli() to connect)
  } else if (useElectron) {
    const meta: AioMeta = {
      title,
      width: cli.width ?? ui.width,
      height: cli.height ?? ui.height,
    };
    const electronUrl = token ? `${localUrl}?token=${token}` : localUrl;
    const udsBaseDir = prod ? distDir : undefined;
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
        setElectronProc(proc);
        proc.status
          .then((s) => {
            setElectronProc(null);
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
}
