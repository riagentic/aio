// Lifecycle & client launch — globals, onStart, schedules, startup logging, electron/browser
// Extracted from aio.ts _run() to keep the orchestrator lean.

import { join } from "@std/path";
import { isPipePath } from "./local-listen.ts";
import { hasDesktopSession, openExternalBestEffort } from "./open-external.ts";
import { type AioMeta, launchElectron } from "../electron/electron.ts";
import type { ServerHandle } from "./server-types.ts";
import type { UDSHandle } from "./uds.ts";
import type { TlsCert } from "./tls.ts";
import type { AioUser } from "./aio.ts";
import type { UiTheme } from "./aio-types.ts";
import { cdpPort, VERSION } from "./aio-cli.ts";
import { type BootExtras, bootLines, buildFacts } from "./boot-facts.ts";
import { diagEmit } from "../diagnostics/diagnostic-bus.ts";
import { discoverySupported, startDiscoveryResponder } from "./discovery.ts";
import { instances, isProcessAlive } from "./single-instance-lock.ts";
import { shutdownAllRuntimes, stopProcess } from "./shutdown.ts";
import { generatePin } from "./pairing.ts";
import { appKeyPath } from "./app-key.ts";
import { type Log, log as globalLog } from "../diagnostics/logger-api.ts";
import type { DB } from "../db/mod.ts";
import type { ScheduleDef } from "../state/schedule.ts";
import { appIconPngBase64 } from "../build/app-icon.ts";
import { artifactPath, relaunch } from "./updates-apply.ts";
import { isCompiled } from "./paths.ts";
import {
  isSupervisedChild,
  relaunchArgs,
  RESTART_EXIT_CODE,
  restartBlockedReason,
} from "./dev-restart.ts";

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
  /** dist/ as THIS process reads it — the compile VFS in a binary. The
   *  launcher reads the baked Electron version (`electron.json`) from here. */
  distDir: string;
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
   *  socket instead (electron + UDS). The Electron window fetches its page
   *  and modules (dev) or its custom routes (prod) through it. */
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
    distDir,
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
  noteLifecycle({ libraryMode: !!libraryMode });

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
        stopProcess(0);
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
  // The local socket's spelling: a Unix socket, or a named pipe on windows.
  const localKind =
    isPipePath(udsHandle?.socketPath ?? deps.httpSocketPath ?? "")
      ? "pipe"
      : "uds";
  const transportLabel = transport === "uds" ? `, ${localKind}` : "";

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
    log.info(`running (${mode}, ${shell}, ${localKind} — no TCP port)`);
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
  if (udsHandle) log.info(`${p(localKind)}${udsHandle.socketPath}`);
  if (server.trojanPort) {
    log.info(`${p("trojan")}http://localhost:${server.trojanPort}`);
  }
  // Printed ONLY when asked for: a debugging port is a port, and the
  // "no TCP port" line above must stay literally true by default.
  const cdp = cdpPort();
  if (cdp) log.info(`${p("cdp")}127.0.0.1:${cdp} (opt-in, loopback)`);
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
      ? `${
        localKind === "pipe" ? "named pipe" : "unix socket"
      } only — no network interface`
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

  // Share URLs — shown separately so they're easy to copy.
  //
  // The link CARRIES THE KEY, deliberately: it is how the operator hands the
  // app to someone, and `am`, the onboarding lab and the aio client all read
  // it. Redacting it here does not protect the key, it deletes the feature —
  // the key is equally readable in `app.key`.
  //
  // What was actually broken is where this line LANDS. The banner goes to the
  // terminal AND to `<logs>/app.log`, and that file was created at the umask
  // (0664 on a stock distro, in a 0775 directory) — so a live, forever
  // credential sat in a world-readable file. The fix belongs at the sink, and
  // it is there: the log dir is 0700 (app-dirs.ts) and every log file is 0600
  // (logger-core.ts), which is exactly the protection `app.key` itself has.
  // The share link is no more exposed than the key file it names.
  //
  // The warning below also used to claim `--expose … origin checks disabled`.
  // That was never true: the WebSocket Origin check runs on EVERY upgrade,
  // exposed or not (server-ws.ts), and the Host gate now runs on every request
  // (server-auth.ts). Saying a defense is off when it is on is how an operator
  // opens a hole to fix a problem they do not have.
  if (expose && users) {
    log.warn(
      `--expose: bound to 0.0.0.0 — reachable by anyone on this network; ` +
        `per-user token auth is the only thing in front of it`,
    );
    for (const [t, u] of Object.entries(users)) {
      log.info(`share (${u.id}/${u.role}): ${url}?token=${t}`);
    }
  } else if (expose && token) {
    log.warn(
      `--expose: bound to 0.0.0.0 — reachable by anyone on this network; ` +
        `the app key is the only thing in front of it`,
    );
    log.info(`share: ${url}?token=${token}`);
    log.info(`key file: ${appKeyPath(appId)} (owner-only)`);
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
        // Zero-port route: the window's `aio://` handler goes through the
        // HTTP socket — in dev for the page, its modules and every asset; in
        // prod (page from dist/) for the app's custom `routes` and /__aio/*.
        // Undefined whenever a TCP port exists — the window then loads over
        // http:// exactly as before.
        httpSocketPath: deps.httpSocketPath,
        // Test what you ship: the packaged app is the only thing that loads
        // over aio:// — with this the dev window does too, against the dev
        // server (docs/clients/electron.md). Observe-only for the app; the
        // window's loader is the one thing that changes.
        forceProtocol: Deno.env.get("AIO_ELECTRON_PROTOCOL") === "1",
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
          distDir,
          cdpPort(),
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
              stopProcess(0);
            }
          })
          .catch((e) => log.error(`electron status: ${e}`));
      })
      .catch((e) =>
        log.error(
          `electron: the desktop window could not be started — ${e}. The ` +
            `server is still running at ${url}; open it in a browser, or run ` +
            `with --client=browser. \`am fix\` installs a missing Electron.`,
        )
      );
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

// ── aio.stop() / aio.restart() ─────────────────────────────────────────────
//
// A handle-free spelling of "end this process cleanly" and "come back", safe to
// call from inside a dispatch: both defer by one macrotask so the method that
// asked can return before the shutdown contract drains the cells (a shutdown
// awaited from inside a method waits on its own caller — see `deferHandOver`
// in updates-runtime.ts, which learned this the hard way).
//
// "Restart yourself" is a promise per LAUNCHER, not a function:
//
//   deno task dev (supervised child) → exit 75, the supervisor relaunches
//   a service (systemd, AIO_SUPERVISED) → exit 0, `Restart=always` relaunches
//   a compiled binary / AppImage / local Electron → re-exec the artifact with
//                                       the same args (the window follows the
//                                       process: AIO_PARENT_PID)
//   `deno run -A app.ts`, unsupervised → re-exec `deno run …` with the real
//                                       argv when it can be read back
//   running from source without -A, or libraryMode → REFUSED, with the reason
//                                       and the manual step. Never a no-op.
//
// The plan is a pure function of facts (`restartPlan`), so every row of that
// matrix is a unit test, and the two heavy rows (a compiled binary, the dev
// supervisor) are proven end to end in tests/build-e2e.test.ts and
// tests/lifecycle-restart.test.ts.

/** The exit code `aio.stop()` uses under a SERVICE manager. Distinct from 0 on
 *  purpose: the generated unit carries `Restart=always` so an update's clean
 *  exit brings the new build up — which would bring a STOPPED app up too. The
 *  unit lists this code in `RestartPreventExitStatus=` (build-compile.ts), and
 *  a unit that does not is told so in the log before the exit. 143 is the
 *  conventional "asked to terminate" status (128 + SIGTERM). */
export const STOP_EXIT_CODE = 143;

type LifecycleFacts = { libraryMode: boolean };
let _lifecycle: LifecycleFacts | null = null;

/** Recorded by every `startLifecycle`: the process is "ours" (may exit) as soon
 *  as ONE non-library app has started in it. */
function noteLifecycle(f: LifecycleFacts): void {
  _lifecycle = _lifecycle
    ? { libraryMode: _lifecycle.libraryMode && f.libraryMode }
    : f;
}

/** Test seam: forget that any app started. */
// aio-ok: test seam — tests/lifecycle-restart.test.ts resets the process facts between cases
export function _resetLifecycleFacts(): void {
  _lifecycle = null;
}

/** True under a service manager — THE decider, shared with the update
 *  handover (which exits rather than spawning a successor for the same
 *  reason). `INVOCATION_ID` is set by systemd, `SUPERVISOR_PROCESS_NAME` by
 *  supervisord; `AIO_SUPERVISED=1` is the explicit spelling the generated unit
 *  carries for any other supervisor. */
export function isServiceSupervised(
  env: (name: string) => string | undefined = envGet,
): boolean {
  return !!env("INVOCATION_ID") || !!env("SUPERVISOR_PROCESS_NAME") ||
    env("AIO_SUPERVISED") === "1";
}

function envGet(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

/** Everything the restart decision depends on, gathered once. */
export type ProcessFacts = {
  /** An app has started its lifecycle in this process. */
  running: boolean;
  /** EVERY app in the process is libraryMode — a test or host owns it. */
  libraryMode: boolean;
  /** `deno task dev`: the child of the dev supervisor (AIO_DEV_SUPERVISED). */
  devSupervised: boolean;
  /** systemd / supervisord / AIO_SUPERVISED=1. */
  serviceSupervised: boolean;
  /** A compiled binary, AppImage or Electron install — and where it is. */
  compiled: boolean;
  artifact: string;
  /** Running from source: why `deno run` cannot be replayed (null = it can),
   *  and the argv that replays it. */
  sourceBlocked: string | null;
  sourceArgs: string[];
  args: string[];
};

export async function processFacts(): Promise<ProcessFacts> {
  const compiled = isCompiled();
  return {
    running: _lifecycle !== null,
    libraryMode: _lifecycle?.libraryMode ?? false,
    devSupervised: isSupervisedChild(),
    serviceSupervised: isServiceSupervised(),
    compiled,
    artifact: compiled ? artifactPath() : Deno.execPath(),
    sourceBlocked: compiled ? null : await restartBlockedReason(),
    sourceArgs: compiled ? [] : await relaunchArgs(),
    args: Deno.args,
  };
}

export type RestartPlan =
  | { kind: "exit"; code: number; why: string }
  | { kind: "reexec"; artifact: string; args: string[]; why: string }
  | { kind: "refused"; reason: string; manual: string };

/** THE restart matrix, as a pure function. Every row is a unit test. */
export function restartPlan(f: ProcessFacts): RestartPlan {
  if (!f.running) {
    return {
      kind: "refused",
      reason: "no app is running in this process (aio.run() has not started)",
      manual: "start the app first",
    };
  }
  if (f.libraryMode) { // the host owns the process — never exit it
    return {
      kind: "refused",
      reason: "libraryMode — a test or host process owns this lifecycle",
      manual: "await app.close() and call aio.run() again",
    };
  }
  if (f.devSupervised) {
    return {
      kind: "exit",
      code: RESTART_EXIT_CODE,
      why: "under the dev supervisor (deno task dev) — it relaunches the app",
    };
  }
  if (f.serviceSupervised) {
    return {
      kind: "exit",
      code: 0,
      why: "under a service manager — the unit's Restart=always brings it back",
    };
  }
  if (f.compiled) {
    return {
      kind: "reexec",
      artifact: f.artifact,
      args: f.args,
      why: `compiled — re-executing ${f.artifact} with the same arguments`,
    };
  }
  if (f.sourceBlocked !== null) {
    return {
      kind: "refused",
      reason:
        `running from source and cannot re-exec itself (${f.sourceBlocked})`,
      manual: "stop it and run `deno task dev` again (a dev session " +
        "supervises itself), build a binary (which re-execs), or run it as a " +
        "service with Restart=always",
    };
  }
  return {
    kind: "reexec",
    artifact: f.artifact,
    args: f.sourceArgs,
    why: `running from source — re-executing \`deno ${
      f.sourceArgs.join(" ")
    }\``,
  };
}

/** The code `aio.stop()` exits with. Under the dev supervisor a clean 0 ends
 *  the session (any other code within its 15 s window reads as a failed
 *  relaunch); under a service manager it must NOT be a code the unit
 *  restarts. */
export function stopExitCode(
  f: Pick<ProcessFacts, "serviceSupervised" | "devSupervised">,
): number {
  return f.serviceSupervised && !f.devSupervised ? STOP_EXIT_CODE : 0;
}

/** Injected by tests so a plan can be asserted without ending the runner. */
export type LifecycleHooks = {
  exit?: (code: number) => void;
  relaunch?: typeof relaunch;
  facts?: () => Promise<ProcessFacts>;
  log?: Pick<Log, "info" | "warn" | "error">;
};

let _ending: Promise<void> | null = null;

/** Deferred by a macrotask, run once: the shutdown contract for EVERY app in
 *  the process, then `act`, then exit. A second call while one is in flight
 *  joins it — two restarts are one restart. */
function endProcess(
  act: () => void,
  code: number,
  hooks: LifecycleHooks,
): Promise<void> {
  if (_ending) return _ending;
  const exit = hooks.exit ?? Deno.exit;
  const log = hooks.log ?? globalLog;
  _ending = new Promise<void>((resolve) => {
    setTimeout(() => {
      void (async () => {
        try {
          await shutdownAllRuntimes();
          act();
        } catch (e) {
          log.error(
            `aio.restart(): handover FAILED after shutdown (${e}) — the app ` +
              `is stopped; start it by hand`,
          );
        } finally {
          _ending = null;
          exit(code);
          resolve();
        }
      })();
    }, 0);
  });
  return _ending;
}

/** Stop the app cleanly: every app in this process runs its full shutdown
 *  contract (finish writing, final snapshot), then the process exits.
 *
 *  Resolves once the exit has been SCHEDULED — from a cell method this is the
 *  right thing to await, the method returns and the shutdown sees a quiet
 *  cell. In libraryMode nothing exits: the apps are closed and the host keeps
 *  its process (a test runner calling `aio.stop()` must not end `deno test`). */
export async function requestStop(hooks: LifecycleHooks = {}): Promise<void> {
  const f = await (hooks.facts ?? processFacts)();
  const log = hooks.log ?? globalLog;
  if (!f.running) {
    throw new Error(
      "aio.stop(): no app is running in this process (aio.run() has not started)",
    );
  }
  if (f.libraryMode) {
    log.info(
      "lifecycle",
      "aio.stop(): libraryMode — closing apps, keeping the process",
    );
    await shutdownAllRuntimes();
    return;
  }
  const code = stopExitCode(f);
  if (code === STOP_EXIT_CODE) {
    log.warn(
      "lifecycle",
      `aio.stop(): under a service manager — exiting with ${code}. The unit ` +
        `must list it in RestartPreventExitStatus=${code} (the generated ` +
        `unit does), or Restart=always starts the app again.`,
    );
  } else {
    log.info("lifecycle", "aio.stop(): shutting down");
  }
  void endProcess(() => {}, code, hooks);
}

/** Restart the app: the plan for THIS launcher (see the matrix above), or a
 *  refusal that names the reason and the manual step. Resolves with the plan
 *  once the restart has been scheduled; throws when it is refused. */
export async function requestRestart(
  hooks: LifecycleHooks = {},
): Promise<RestartPlan> {
  const f = await (hooks.facts ?? processFacts)();
  const plan = restartPlan(f);
  const log = hooks.log ?? globalLog;
  if (plan.kind === "refused") {
    throw new Error(
      `aio.restart() refused: ${plan.reason}. To restart: ${plan.manual}.`,
    );
  }
  log.info("lifecycle", `aio.restart(): ${plan.why}`);
  if (plan.kind === "exit") {
    void endProcess(() => {}, plan.code, hooks);
  } else {
    const { artifact, args } = plan;
    void endProcess(
      () => (hooks.relaunch ?? relaunch)({ artifact, args }),
      0,
      hooks,
    );
  }
  return plan;
}
