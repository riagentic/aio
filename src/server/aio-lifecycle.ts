// Lifecycle & client launch — globals, onStart, schedules, startup logging, electron/browser
// Extracted from aio.ts _run() to keep the orchestrator lean.

import { join } from "@std/path";
import { type AioMeta, launchElectron } from "../electron/electron.ts";
import type { ServerHandle } from "./server-types.ts";
import type { UDSHandle } from "./uds.ts";
import type { TlsCert } from "./tls.ts";
import type { AioUser } from "./aio.ts";
import { VERSION } from "./aio-cli.ts";
import { diagEmit } from "../diagnostics/diagnostic-bus.ts";
import { discoverySupported, startDiscoveryResponder } from "./discovery.ts";
import { instances } from "./single-instance-lock.ts";
import { generatePin } from "./pairing.ts";
import type { Log } from "../diagnostics/logger.ts";
import type { DB } from "../db/mod.ts";
import type { ScheduleDef } from "../state/schedule.ts";

/** Inputs for lifecycle startup */
export interface LifecycleDeps<S, A> {
  // Identity
  appId: string;
  appVersion: string;
  title: string;
  // Mode flags
  prod: boolean;
  /** dist/ Electron can open from its own process (never the compile VFS). */
  electronDistDir: string | undefined;
  /** The app's resolved baseDir — THE app-dir decider (WYSIDIWYSIP): the dev
   *  Electron window reads icon.png from here, the same place the prod build
   *  packages it from (cfg.appDir = the entry's directory). */
  baseDir: string;
  expose: boolean;
  singletonMode: boolean;
  /** Gate for electron child windows (openWindow) — see AioRunOptions. */
  childWindows: boolean;
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
  /** AUTH-2/3: pre-built auth-mode label ("password+totp+oidc") for the boot
   *  report — undefined falls back to users/token detection. */
  authMode?: string;
  tlsCert: TlsCert | null;
  shareUrl: string;
  localUrl: string;
  // Server & UDS
  server: ServerHandle;
  udsHandle: UDSHandle | null;
  // App
  app: {
    dispatch: (action: A) => Promise<unknown>;
    getState: () => S;
    port?: number;
  };
  // Hooks
  // must accept typed AioApp<S, A> via contravariance
  // deno-lint-ignore no-explicit-any
  onStart: ((app: any) => void) | undefined;
  fatalOnStart: boolean | undefined;
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
  // Not just the window box: the head-shaped keys travel to the templated
  // aio:// Electron shell, which has no other way to learn them.
  ui: {
    width?: number;
    height?: number;
    showStatus?: boolean;
    viewport?: string | false;
    head?: string;
  };
  keepServer: boolean | undefined;
  // Shutdown & electron
  shutdown: () => Promise<void>;
  setElectronProc: (proc: Deno.ChildProcess | null) => void;
  /** Register the LAN-discovery responder stopper (called on shutdown). */
  setDiscoveryStop: (stop: (() => void) | null) => void;
  /** App lock — used to stamp discovery metadata for LAN discovery. */
  appLock:
    | { update?: (partial: Record<string, unknown>) => void }
    | null;
  log: Log;
}

/** Run lifecycle startup — set globals, fire hooks, log info, launch client */
export function startLifecycle<S, A>(deps: LifecycleDeps<S, A>): void {
  const {
    appId,
    appVersion,
    title,
    prod,
    electronDistDir,
    expose,
    singletonMode,
    childWindows,
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
    fatalOnStart,
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
      if (fatalOnStart) {
        log.error("fatalOnStart is true — exiting due to onStart failure");
        Deno.exit(1);
      }
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
  if (expose && token) {
    log.warn(
      "⚠ token auth via URL query parameter is insecure in expose mode — use Authorization header instead",
    );
  }
  if (expose && !users && !token) {
    log.warn(
      "⚠ no authentication configured with --expose — any website can connect via WebSocket",
    );
  }
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
  const authLabel = deps.authMode ??
    (users ? `${Object.keys(users).length} user(s)` : token ? "token" : "none");
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
      `--expose: bound to 0.0.0.0 — key auth, origin checks disabled`,
    );
    log.info(`share: ${url}?token=${token}`);
    // Friendly pairing: the aio client enters this code once to pull the
    // profile (cert + key) and connect forever — no file to hand over.
    const pin = generatePin();
    log.info(`pair code: ${pin}  (enter it in the aio client → Add app)`);
  }

  // LAN discovery — exposed apps answer UDP broadcast probes so the aio
  // client (and `am discover`) can find them without knowing the IP/port.
  // UDP via node:dgram (stable — no flags); best-effort, degrades silently
  // if the port can't bind or the network blocks broadcast.
  if (expose && !skipHttp) {
    // Stamp this app's discovery metadata into its lock file so ANY responder
    // on the host can report it (the multi-app-per-host solution).
    deps.appLock?.update?.({
      discovery: { title, tls: useHttps, needsAuth: !!users || !!token },
    });
    // The responder reports EVERY exposed app on the host, read fresh from the
    // lock registry each probe — see discovery.ts.
    const responder = startDiscoveryResponder(
      () =>
        instances()
          .filter((i) => i.alive && i.discovery && i.port)
          .map((i) => ({
            name: i.appId,
            port: i.port,
            title: i.discovery!.title,
            needsAuth: i.discovery!.needsAuth,
            tls: i.discovery!.tls,
          })),
      // These notes only fire on a real problem (couldn't bind/create the UDP
      // socket) — under --expose that means the app is exposed but NOT
      // discoverable, which used to be invisible. Make it loud.
      (msg) => log.warn(msg),
    );
    deps.setDiscoveryStop(responder.stop);
    if (discoverySupported()) {
      log.debug(`discovery: advertising ${appId} on LAN (:${port})`);
    }
  } else {
    deps.setDiscoveryStop(null);
  }

  // Validate keepServer
  const keepServer = cli.keepServer ?? configKeepServer ?? false;
  if (keepServer && client !== "electron") {
    throw new Error(
      `keepServer only applies when client is electron (current client: "${client}"). Remove keepServer from aio.run(), or set client: "electron".`,
    );
  }

  // Launch client
  if (isHeadless) {
    // Headless — server-only, no UI launch (CLI apps use connectCli() to connect)
  } else if (useElectron) {
    const meta: AioMeta = {
      title,
      width: cli.width ?? ui.width,
      height: cli.height ?? ui.height,
      childWindows,
    };
    const electronUrl = token ? `${localUrl}?token=${token}` : localUrl;
    // NOT distDir — that can be the binary's embedded VFS copy, which this
    // (foreign) Electron process cannot open. Undefined ⇒ it loads over HTTP,
    // which aio-server kept alive for exactly this case.
    const udsBaseDir = prod ? electronDistDir : undefined;
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
        // Dev window icon comes from the SAME dir the prod build packages it
        // from (the app dir) — never a hardcoded cwd/src.
        iconDir: deps.baseDir,
        // The aio:// shell is templated at launch, so every `<head>` input has
        // to travel with it. Omitting them is how a packaged app ends up with
        // a different `<head>` than `deno task dev` serves.
        shell: {
          showStatus: ui.showStatus,
          width: meta.width,
          height: meta.height,
          viewport: ui.viewport,
          head: ui.head,
        },
      }
      : undefined;
    launchElectron(electronUrl, log, meta, udsConfig)
      .then((proc) => {
        if (!proc) {
          // Electron unavailable (auto-install failed / offline) — fall back
          // to the system browser LOUDLY instead of dying: the
          // app is identical over WS; the developer keeps working.
          log.error(
            "Electron not installed and auto-install failed — falling back to the system browser",
          );
          log.error(
            `install manually with: deno install --allow-scripts=npm:electron npm:electron (then re-run) — serving at ${electronUrl}`,
          );
          const cmd = Deno.build.os === "darwin"
            ? "open"
            : Deno.build.os === "windows"
            ? "start"
            : "xdg-open";
          try {
            new Deno.Command(cmd, {
              args: [electronUrl],
              stdout: "null",
              stderr: "null",
            }).spawn();
          } catch {
            log.info(`open ${electronUrl} in your browser`);
          }
          return;
        }
        setElectronProc(proc);
        proc.status
          .then((s) => {
            setElectronProc(null);
            // Say HOW it ended, always. The window going away is the only
            // thing that shuts a desktop app down, so "closed by the user"
            // and "killed by a signal" are the two answers a crash report
            // turns on — and the no-keepServer path used to log neither,
            // leaving a graceful shutdown as the only trace of a crash.
            const how = s.signal ? `signal ${s.signal}` : `code ${s.code ?? 0}`;
            if (keepServer) {
              log.info(
                `electron closed (${how}) — server still running at ${url}`,
              );
            } else {
              log.info(`electron closed (${how}) — shutting down`);
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
