// Lifecycle & client launch — globals, onStart, schedules, startup logging, electron/browser
// Extracted from aio.ts _run() to keep the orchestrator lean.

import { join } from "@std/path";
import { hasDesktopSession, openExternalBestEffort } from "./open-external.ts";
import { type AioMeta, launchElectron } from "../electron/electron.ts";
import type { ServerHandle } from "./server-types.ts";
import type { UDSHandle } from "./uds.ts";
import type { TlsCert } from "./tls.ts";
import type { AioUser } from "./aio.ts";
import type { UiTheme } from "./aio-types.ts";
import { VERSION } from "./aio-cli.ts";
import { type BootExtras, bootLines, buildFacts } from "./boot-facts.ts";
import { diagEmit } from "../diagnostics/diagnostic-bus.ts";
import { discoverySupported, startDiscoveryResponder } from "./discovery.ts";
import { instances, isProcessAlive } from "./single-instance-lock.ts";
import { shutdownAllRuntimes } from "./shutdown.ts";
import { generatePin } from "./pairing.ts";
import type { Log } from "../diagnostics/logger-api.ts";
import type { DB } from "../db/mod.ts";
import type { ScheduleDef } from "../state/schedule.ts";
import { appIconPngBase64 } from "../build/app-icon.ts";

/** One SIGHUP guard per process — see the headless branch in startLifecycle. */
let _sighupGuarded = false;
/** One parent watch per process — see `AIO_PARENT_PID` in startLifecycle. */
let _parentWatched = false;

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
  /** Set when this app binds NO TCP port and its HTTP handler listens on a
   *  socket instead (dev + electron + UDS). The Electron window fetches its
   *  page and modules through it. */
  httpSocketPath?: string;
  // Network
  port: number;
  token: string | undefined;
  users: Record<string, AioUser> | undefined;
  /** True when ANY per-user auth is configured (`users`, `resolveUser`, or
   *  `auth: true`) — the deciders that make an exposed app secured WITHOUT a
   *  `token`. Gates the "no authentication with --expose" warning: `auth: true`
   *  and `resolveUser` apps set neither `users` nor `token`, and the strongest
   *  security warning crying wolf on the two correctly-secured configs teaches
   *  people to ignore it. */
  perUserAuth: boolean;
  /** AUTH-2/3: pre-built auth-mode label ("password+totp+oidc") for the boot
   *  report — undefined falls back to users/token detection. */
  authMode?: string;
  /** Facts the boot report cannot derive from the process itself (data dir,
   *  cell ids, resolved update config). Everything else it reads directly. */
  bootExtras?: BootExtras;
  tlsCert: TlsCert | null;
  shareUrl: string;
  localUrl: string;
  /** How the bound address is NAMED (`setupTransport`'s one decider) — the
   *  boot report prints THIS, never a second derivation. */
  advertiseHost: string;
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
  cli: {
    width?: number;
    height?: number;
    keepServer?: boolean;
    /** `--open` — hand the URL to the desktop browser. Off by default. */
    open?: boolean;
  };
  // Not just the window box: the head-shaped keys travel to the templated
  // aio:// Electron shell, which has no other way to learn them.
  ui: {
    width?: number;
    height?: number;
    showStatus?: boolean;
    viewport?: string | false;
    head?: string;
    chrome?: "standard" | "themed" | "none";
    theme?: UiTheme;
    lang?: string;
  };
  keepServer: boolean | undefined;
  /** Library/test mode — no process-wide signal handlers (the same contract
   *  aio-server honours for SIGINT/SIGTERM): an embedding host or test runner
   *  owns the process, and handlers that outlive `app.close()` accumulate. */
  libraryMode?: boolean;
  // Electron
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
    libraryMode,
    transport,
    skipHttp,
    port,
    token,
    users,
    perUserAuth,
    tlsCert,
    shareUrl,
    localUrl,
    advertiseHost,
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

  // onStart hook — error-guarded, for a sync throw AND an async rejection.
  // An `async onStart` used to bypass this whole block: its rejection went to
  // the crash handler as an unhandled rejection and `fatalOnStart` never saw
  // it. The hook is not awaited (boot must not block on app code), but its
  // outcome is routed to the same place either way.
  if (onStart) {
    const failed = (e: unknown) => {
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
    };
    try {
      const r = onStart(app) as unknown;
      if (r && typeof (r as Promise<unknown>).then === "function") {
        (r as Promise<unknown>).catch(failed);
      }
    } catch (e) {
      failed(e);
    }
  }

  // AIO_PARENT_PID — die with the process that started you.
  //
  // A spawned app is a plain child: when its launcher is SIGKILLed, times out
  // or crashes, the app is reparented to init and keeps running — holding its
  // port, its lock and (exposed) a LAN-visible listener. That is how a test
  // runner killed by `timeout` left an `--expose`d app serving for 5 h. There
  // is no portable "kill me when my parent dies" for a child, so the child
  // watches: a launcher that wants this sets the env var, and the app stops
  // itself — gracefully, every phase — when that pid is gone. Opt-in, same in
  // dev and prod, observe-only until the parent actually disappears.
  if (!libraryMode && !_parentWatched) {
    const parentPid = Number(Deno.env.get("AIO_PARENT_PID") ?? "");
    if (Number.isInteger(parentPid) && parentPid > 0) {
      _parentWatched = true;
      const timer = setInterval(() => {
        if (isProcessAlive(parentPid)) return;
        clearInterval(timer);
        log.warn(
          `parent process ${parentPid} is gone (AIO_PARENT_PID) — shutting down`,
        );
        shutdownAllRuntimes().then(() => Deno.exit(0)).catch(() =>
          Deno.exit(1)
        );
      }, 2000);
      // A watch must never be the thing that keeps an otherwise-finished
      // process alive.
      try {
        Deno.unrefTimer(timer);
      } catch { /* not supported */ }
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
  // `!perUserAuth` covers users/resolveUser/auth:true; `!token` covers the
  // shared app key. Only an app with NONE of them is actually open.
  if (expose && !perUserAuth && !token) {
    log.warn(
      "⚠ no authentication configured with --expose — any website can connect via WebSocket",
    );
  }
  // "No TCP port" has two shapes and the report must not print a number for
  // either: prod serves its page off disk with no handler at all, dev keeps
  // the handler on a socket. Printing `web http://localhost:49208` for an app
  // that bound nothing is the exact class of confidently-wrong line this
  // codebase keeps deleting.
  const noPort = skipHttp || !!deps.httpSocketPath;
  if (noPort) {
    log.info(`running (${mode}, ${shell}, uds — no TCP port)`);
    if (deps.httpSocketPath) log.info(`${p("http")}${deps.httpSocketPath}`);
  } else {
    log.info(`running (${mode}, ${shell}${transportLabel})`);
    const wsProto = useHttps ? "wss" : "ws";
    // `bindHost` is the transport's OWN resolved answer — re-deriving it here
    // (from the flag only) made the report contradict the bind for an app
    // that set `host` in config.
    log.info(`${p("web")}${url}`);
    log.info(`${p("ws")}${wsProto}://${advertiseHost}:${port}/ws`);
  }
  if (udsHandle) log.info(`${p("uds")}${udsHandle.socketPath}`);
  if (server.trojanPort) {
    log.info(`${p("trojan")}http://localhost:${server.trojanPort}`);
  }
  log.info(`${p("id")}${appId}`);
  log.info(`${p("version")}${appVersion}`);
  log.info(`${p("aio")}${VERSION}`);
  // What this process actually IS — read from the process, never from config,
  // so the report cannot describe a different app than the one running.
  // Two facts the lifecycle owns and the boot report could not derive: the
  // interface actually bound (0.0.0.0 and 127.0.0.1 are a different security
  // posture, and `expose: true` only implied it), and whether TLS is real.
  const _bootExtras = {
    ...deps.bootExtras,
    // What this process is actually reachable ON. A socket-only app is not
    // "loopback" — it is not on the network stack at all, and its door is the
    // filesystem permission on a 0700 directory.
    bind: noPort
      ? "unix socket only — no network interface"
      : expose
      ? "0.0.0.0 — every interface"
      : "127.0.0.1 — loopback only",
    tls: noPort
      ? undefined
      : useHttps
      ? (deps.tlsCert?.selfSigned ? "self-signed" : "provided cert")
      : "off (plain http)",
  };
  for (const [label, value] of bootLines(buildFacts(), _bootExtras)) {
    log.info(`${p(label)}${value}`);
  }
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
  if (expose && !noPort) {
    // Stamp this app's discovery metadata into its lock file so ANY responder
    // on the host can report it (the multi-app-per-host solution).
    deps.appLock?.update?.({
      // `perUserAuth`, for the same reason the exposure warning 87 lines up
      // uses it: `users`/`token` MISS `auth: true` and `resolveUser`, and with
      // per-user auth no shared key is generated at all (app-key.ts declines),
      // so both were falsy and a full-login app advertised itself on the LAN
      // as needing none — no ⚷ marker in `am discover`, no auth badge in the
      // client, which then tried a direct connect.
      discovery: {
        title,
        tls: useHttps,
        needsAuth: perUserAuth || !!users || !!token,
      },
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
    // Headless — server-only, no UI launch (CLI apps use connectCli() to
    // connect).
    //
    // …and it must SURVIVE its parent going away. SIGHUP's default action is
    // terminate, so a headless app started from a shell that then exits —
    // `nohup deno run … &`, a closed terminal, a CI step that backgrounds it —
    // dies on the spot, with `uptime=0m` in the log and nothing saying why. A
    // field report lost three attempts to it before discovering `setsid` made
    // it stay up. The one role whose entire purpose is running unattended is
    // the one that must not need a wrapper to do it.
    //
    // Registering ANY listener replaces the default terminate action; the app
    // still stops on SIGINT/SIGTERM, which are the signals that MEAN stop.
    // Scoped to headless deliberately: a dev server attached to a terminal
    // SHOULD go when the terminal does.
    // Skipped in libraryMode for the same reason aio-server skips
    // SIGINT/SIGTERM there: a test runner / embedding host owns the process,
    // and a handler per aio.run() would accumulate for its lifetime. Guarded
    // once per process otherwise — several apps in one process (the supported
    // disjoint-multi-app pattern) need one listener, not one each.
    if (!libraryMode && !_sighupGuarded) {
      _sighupGuarded = true;
      try {
        Deno.addSignalListener("SIGHUP", () => {
          log.debug(
            "SIGHUP ignored — headless apps outlive their parent shell",
          );
        });
      } catch { /* not supported on this platform (Windows) */ }
    }
  } else if (useElectron && !hasDesktopSession()) {
    // A desktop app on a machine with no desktop. Launching Electron here
    // fails, and because "the window went away" is what shuts a desktop app
    // down, the failure took the whole app with it — so an electron app on a
    // headless server (ssh, a container, CI) exited instead of serving.
    //
    // `isHeadless` could not catch this: it answers "does this CLIENT have a
    // UI", which is a property of the app, while this is a property of the
    // MACHINE. Two different questions that happened to share an answer on a
    // developer's laptop.
    log.warn(
      "electron client, but this machine has no desktop session " +
        "(no DISPLAY/WAYLAND_DISPLAY) — not launching a window. The server " +
        `is up at ${localUrl}; use --client=browser to open it from another ` +
        `machine, or --client=server-only to say so explicitly.`,
    );
  } else if (useElectron) {
    const meta: AioMeta = {
      title,
      width: cli.width ?? ui.width,
      height: cli.height ?? ui.height,
      childWindows,
      chrome: ui.chrome,
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
        // Dev's zero-port route: no dist/ to read and no port to fetch from,
        // so the window's `aio://` handler goes through the HTTP socket for
        // the page, its modules and every asset. Undefined whenever a TCP
        // port exists — the window then loads over http:// exactly as before.
        httpSocketPath: deps.httpSocketPath,
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
          chrome: ui.chrome,
          theme: ui.theme,
          lang: ui.lang,
          themeName: appId,
        },
      }
      : undefined;
    // …and when the app ships none, the generated monogram travels with the
    // launch, so the dev window is identified exactly like the packaged one
    // (which reads dist/icon.png, written by the same generator). A failure to
    // draw it must never stop the app from starting — it is an icon.
    appIconPngBase64(title, 256)
      .catch(() => "")
      .then((defaultIcon) =>
        launchElectron(
          electronUrl,
          log,
          meta,
          udsConfig && { ...udsConfig, defaultIcon },
        )
      )
      .then((proc) => {
        if (!proc) {
          // Electron unavailable (auto-install failed / offline). The app
          // keeps serving — it is identical over WS — but it does NOT quietly
          // become a browser app.
          //
          // Opening a tab here changed the client the developer asked for, in
          // the one situation where they were least likely to be watching, and
          // it did it into a browser aio cannot close afterwards. A suite where
          // Electron is not installed therefore produced a stack of identical
          // tabs, each having stolen focus on the way in, and the fix for a
          // desktop app was to install Electron — not to be handed a browser.
          //
          // So: say what happened, say where the app is, and let the person
          // decide. `openExternalBestEffort` would refuse in a test anyway; the
          // point of not calling it is that a desktop app staying a desktop app
          // is a rule, not a side effect of the environment.
          log.error(
            "Electron not installed and auto-install failed — this app is a " +
              "desktop app and will NOT be opened in a browser instead",
          );
          log.error(
            `install it with: deno task install:electron (then re-run). The ` +
              `server is up meanwhile at ${electronUrl} — open it yourself, ` +
              `or run with --client=browser if that is what you want.`,
          );
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
              // This exits the PROCESS, so every app in it stops here —
              // including one still writing its final snapshot.
              shutdownAllRuntimes().then(() => Deno.exit(0));
            }
          })
          .catch((e) => log.error(`electron status: ${e}`));
      })
      .catch((e) => log.error(`electron: ${e}`));
  } else {
    // A browser client is a URL, printed. It is NOT a tab opened for you.
    //
    // Auto-opening was a convenience that quietly cost more than it gave: a tab
    // handed to an already-running browser belongs to that browser, so aio
    // cannot close it when the app exits. Boot an app twenty times — a test
    // suite, a watch loop, a restart-on-crash — and there are twenty tabs of
    // the same app, each one having taken focus as it mapped, none of them
    // yours to close. An Electron window is different in kind: it is a child
    // process aio owns and shuts down with the app, which is why THAT still
    // opens by default.
    //
    // `--open` remains for the people who liked it, and even then the
    // environment can still refuse (headless, CI, a test display).
    if (!cli.open) {
      log.info(`open ${localUrl} in your browser (or pass --open)`);
    } else {
      // Wait briefly for existing browser tabs to reconnect via WS
      setTimeout(() => {
        if (server.clientCount() > 0) {
          log.debug("browser: existing client connected — skipping open");
          return;
        }
        openExternalBestEffort(localUrl);
      }, 1500);
    }
  }
}
