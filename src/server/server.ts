// HTTP + WebSocket server with live TSX transpilation (dev) or static serving (prod)
// Thin orchestrator — delegates to server-*.ts modules
import { APP_STYLE, appHasStylesheet, UI_ENTRY } from "./app-files.ts";
import { isPipePath, listenLocal } from "./local-listen.ts";
import { serveHttpOverLocal } from "./http-over-conn.ts";
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
import { appDenoJson } from "./aio-run-helpers.ts";
import { PIN_TTL_MS, verifyPin } from "./pairing.ts";
export type { ServerConfig, ServerHandle } from "./server-types.ts";
export { _timingSafeEqual } from "./server-auth.ts";

// ── Internal imports ──
import type { ServerConfig, ServerHandle } from "./server-types.ts";
import { isReservedRoutePath, matchRoute, parseCookies } from "./route.ts";
import type { RawRouteHandler, RouteMatch } from "./route.ts";
import {
  makeServerRequest,
  runWithRequest,
  runWithUser,
} from "./auth-context.ts";
import type { AioUser } from "./aio-types.ts";
import { buildBrowserImportMap } from "./server-html.ts";
import { readAppDenoImports } from "./server-html-importmap.ts";
import {
  _buildUserResolver,
  _extractTokenWithSource,
  _isPresented,
  _timingSafeEqual,
  armLocalControl,
  authFailBudgetExceeded,
  clearSessionCookie,
  hostRefusal,
  localControlAuthorized,
  recordAuthFail,
  trojanDenialForUserMode,
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

// B-11: tokens in the URL query string leak via browser history, proxy logs,
// and Referer headers. The timing-safe `?token=` path stays as an opt-in
// fallback (e.g. WS upgrades that can't set headers), but warn once per process
// the first time it's actually relied on so it isn't a silent hijacking surface.
let _tokenInUrlWarned = false;
function _warnTokenInUrl(): void {
  if (_tokenInUrlWarned) return;
  _tokenInUrlWarned = true;
  log.warn(
    "[aio] security: authenticated via ?token= in the URL — tokens leak via " +
      "browser history, proxy logs, and Referer. Prefer the Authorization: " +
      "Bearer header. Query-param auth is a fallback for header-less contexts.",
    { detail: String() },
  );
}

/** Headers a reverse proxy adds to say "the real client is someone else". */
const _FORWARD_HEADERS = [
  "x-forwarded-for",
  "forwarded",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
] as const;

// A proxy in front + `trustProxyHeader` unset = EVERY client shares one abuse
// bucket, because the only address this process sees is the proxy's. The
// per-IP fail budget, the pairing-PIN budget and the WS denylist all key off
// it, so one attacker's failures land on everyone. That was silent: the docs'
// own nginx/Caddy snippet sets no forwarded header and never mentions the
// setting. Warn ONCE, from evidence (a request actually carrying a forwarding
// header), naming the header we saw and what to set.
let _proxyCollapseWarned = false;
function _warnProxyBucketCollapse(req: Request): void {
  if (_proxyCollapseWarned) return;
  const seen = _FORWARD_HEADERS.find((h) => req.headers.get(h) !== null);
  if (!seen) return;
  _proxyCollapseWarned = true;
  log.warn(
    `[aio] security: request carried "${seen}" but trustProxyHeader is not ` +
      `set — this app is behind a proxy, so every client collapses into ONE ` +
      `abuse bucket (per-IP auth budget, pairing PIN, WS denylist). One ` +
      `attacker's failures then throttle every user. Set ` +
      `trustProxyHeader: "${seen}" in aio.run(), and make sure the proxy ` +
      `OVERWRITES that header (nginx: proxy_set_header X-Forwarded-For ` +
      `$remote_addr;) — an app that trusts a client-settable header lets an ` +
      `attacker forge a fresh bucket per request instead.`,
  );
}

/** Test isolation — re-arm the one-shot security warnings. @internal */
export function _resetSecurityWarnings(): void {
  _proxyCollapseWarned = false;
  _tokenInUrlWarned = false;
}

/** The framework's own diagnostic routes. Public on a public app (that is what
 *  a dev panel and a `curl /__aio/health` are for), but NEVER anonymous on an
 *  app that has accounts: they describe the app rather than serve it. Listed
 *  once so the anonymous fall-through and any future gate read the same set. */
const _ANON_DENIED_DIAGNOSTICS = [
  "/__aio/health",
  "/__aio/metrics",
  "/__aio/vitals",
  "/__aio/error",
] as const;

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

/** The peer a control request over the Unix socket presents. Named once so the
 *  claim "a `ctl` frame is a same-machine request" is a value the gate reads,
 *  not a boolean some caller passed in. */
const UDS_PEER: Deno.Addr = { transport: "unix", path: "" };

/** Starts HTTP + WS server, returns broadcast handle for state pushes and shutdown */
/** The shared-key cookie's name, scoped to the app.
 *
 *  Cookies ignore the PORT, so two aio apps on one host share a cookie jar: a
 *  single `aio_key` would have them overwriting each other's credential all day
 *  (and each 401-ing on the other's). The appId keeps them apart. */
export function keyCookieNameFor(appId: string | undefined): string {
  const slug = (appId ?? "app").toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "app";
  return `aio_key_${slug}`;
}

/** The `Set-Cookie` value handing a browser the shared key for its follow-up
 *  requests.
 *
 *  HttpOnly: script cannot read it — strictly better than the `?token=` URL it
 *  replaces, which leaks into history, referrers and proxy logs (the server
 *  already warns about that). SameSite=Strict: never sent cross-site, so the
 *  ambient authority a cookie creates cannot be driven from another origin.
 *  Secure whenever the page itself is https, taken from the request rather than
 *  from config so it is right per request. Session-scoped (no Max-Age): the
 *  credential lasts as long as the window, and a shared key is not something to
 *  persist on disk for a user who closed the app. */
export function keyCookieHeader(url: URL, token: string): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${keyCookieNameFor(_cookieAppId)}=${
    encodeURIComponent(token)
  }; Path=/; HttpOnly; SameSite=Strict${secure}`;
}

/** The appId the cookie name is derived from, set once per server. */
let _cookieAppId: string | undefined;

export function createServer(config: ServerConfig): ServerHandle {
  const { port, title, getUIState, dispatch, debug, prod = false, distDir } =
    config;
  _cookieAppId = config.appId;
  const keyCookieName = keyCookieNameFor(config.appId);

  // Diagnostic bus — dev-only event system for surfacing silent failures
  initDiagnosticBus(!prod);
  // The log DIRECTORY is not a dev feature — the UDS transport writes client
  // log frames whether or not this is prod (uds.ts), and with this call gated
  // behind `!prod` the module kept its default `".aio/log"`: a CWD-RELATIVE
  // path, in prod, that nothing wipes and that `am log --client` does not read
  // (it reads `~/.<appId>/logs/client.log`). An Electron app's renderer logs
  // went to a fourth place depending on where it was launched from. Setting a
  // path costs nothing; only the dev-only diagnostic BUS stays gated.
  initClientLog(getLogDir());
  if (!prod) setDiagEmit(diagEmit);

  // Unified user resolver — one code path for both static map and dynamic hook (AIO-171)
  // AUTH-1: session tokens resolve FIRST (cheap indexed lookup, revocable),
  // then fall through to users/resolveUser. Sessions alone activate per-user
  // auth mode — an app with only `sessions: true` is a per-user app.
  const _baseResolver = _buildUserResolver(config);
  // The local control plane: mint an owner-only, per-boot credential so `am`
  // and amui can reach /__aio/trojan/* on an auth-enabled app. Without it the
  // trojan's (correct) admin gate locks the developer out of inspecting their
  // own running app, which is the pressure that makes people turn auth off in
  // dev. No-op in prod and for an app with no appId.
  armLocalControl(config);
  const _sessionResolver = config.sessionResolver;
  // A LOGIN SESSION does not authenticate an HTTP request from the URL.
  //
  // `?token=` is a deliberate fallback for header-less contexts, and those
  // mostly carry the app KEY — a value meant to be pasted into a share link.
  // A session token is not: it is long-lived, per-user, and the login flow
  // delivers it as an HttpOnly cookie or a Bearer header (`handleAuthFlow`'s
  // own reader ignores the query string entirely). In a URL it lands in
  // browser history, proxy logs and the `Referer` of every outbound link,
  // with nothing preventing it.
  //
  // The ONE place it stays allowed is the `/ws` handshake: a browser
  // `new WebSocket(...)` cannot set headers, so for any client without the
  // cookie the query string is the only channel there. `/ws` URLs are not
  // navigations, so they carry no Referer. Static `users` / `resolveUser`
  // tokens are unaffected everywhere, and the loud ?token= warning still
  // fires (see `_warnTokenInUrl`).
  const _userResolver = _sessionResolver
    ? async (tok: string, urlBlocked = false) =>
      (urlBlocked ? null : _sessionResolver(tok)) ??
        (_baseResolver ? await _baseResolver(tok) : null)
    : _baseResolver;

  /** This server authenticates INDIVIDUALS (sessions, users:, resolveUser,
   *  login flows) — the mode where a collapsed abuse bucket hurts users. */
  const _perUserAuth = !!_userResolver || !!config.authFlows;

  // Boot-time half of the bucket-collapse warning (the runtime half fires on
  // the first request that actually carries a forwarding header). An exposed
  // per-user app is the deployment the docs prescribe a reverse proxy for, so
  // "exposed + per-user auth + no trustProxyHeader" is worth saying out loud
  // even before the first client arrives.
  if (_perUserAuth && config.expose && !config.trustProxyHeader) {
    log.warn(
      "[aio] security: --expose with per-user auth and no trustProxyHeader. " +
        "Direct-to-internet is fine (the TCP peer IS the client), but behind " +
        "a reverse proxy every client shares ONE abuse bucket and one " +
        "attacker throttles everybody. Behind a proxy set trustProxyHeader: " +
        '"x-forwarded-for" (and have the proxy OVERWRITE that header).',
      { detail: String() },
    );
  }

  // `auth: { totp: false }` turns ENROLLMENT off. It no longer turns
  // VERIFICATION off (that was a silent factor drop — see the login route),
  // so an app restarted with the flag on an auth.db that already has enrolled
  // accounts still challenges them. That is the safe behavior AND the
  // surprising one, so it is stated at boot rather than discovered.
  if (config.authFlows?.totp === false) {
    const enrolled = config.authFlows.users.list().filter((u) => u.totpEnabled);
    if (enrolled.length > 0) {
      log.warn(
        `[aio] auth: totp: false disables ENROLLMENT only — ${enrolled.length} ` +
          `account(s) already enrolled (${
            enrolled.slice(0, 5).map((u) => u.id).join(", ")
          }) still require their second factor to log in. Clear one with ` +
          `\`am auth totp <id> off\` if a user has lost their device.`,
      );
    }
  }

  // A shared app KEY and the login FLOWS cannot both gate this server, and a
  // gate that silently gates nothing is the worst of the three outcomes.
  //
  // What the code did: `key: true` + `auth: true` + `--expose` resolved a key,
  // printed `share: https://…?token=<key>` and handed it out from
  // `/__aio/pair` — while the per-user path below always returns, so the
  // shared-key gate was unreachable. An anonymous LAN client got the shell and
  // every file under `baseDir` (in dev: the app's TypeScript sources).
  //
  // And the two cannot be reconciled by simply checking both: the login flows
  // REQUIRE a public shell (a browser must load the UI to render SignIn before
  // it has a session), while a key that is only presentable as `?token=` never
  // reaches a subresource — a browser does not copy the query string onto
  // `/App.tsx` or `/bundle.js`. Whichever gate wins, one of the two promises
  // is broken. So refuse at boot, where it is cheap and legible, instead of
  // shipping an app whose advertised key protects nothing.
  if (config.token && config.authFlows) {
    throw new Error(
      `[aio] config conflict: a shared app key (key:) and the login flows ` +
        `(auth:) cannot both guard this server. The login flows need a PUBLIC ` +
        `shell so a browser can render SignIn, and a key presented as ` +
        `?token= never reaches a subresource — so the key would gate nothing ` +
        `while the boot banner and /__aio/pair still advertised it. Pick one: ` +
        `drop \`key\` and let per-user login be the gate (recommended for ` +
        `--expose), or drop \`auth\` and share the key.`,
    );
  }

  // Custom routes: reserve the framework namespaces loudly at boot.
  for (const key of Object.keys(config.routes ?? {})) {
    if (!key.startsWith("/") || isReservedRoutePath(key)) {
      throw new Error(
        `[aio] invalid custom route "${key}" — routes must start with "/" and ` +
          `cannot use the reserved /__aio or /ws namespaces`,
      );
    }
    // A `*` that is not the LAST segment is refused, because `matchRoute`
    // returns the moment it reaches one: `/files/*/x` matches `/files/foo` and
    // `/files/a/b/c` alike, and the `/x` it demands is never checked. The
    // docstring only ever advertised a trailing wildcard, but nothing enforced
    // it, so a pattern that silently over-matches was accepted and then
    // answered requests it was never meant to. Loud at boot beats wrong at
    // runtime.
    const star = key.split("/").indexOf("*");
    if (star !== -1 && star !== key.split("/").length - 1) {
      throw new Error(
        `[aio] invalid custom route "${key}" — "*" must be the LAST segment. ` +
          `A wildcard captures everything after it, so anything written after ` +
          `the "*" can never be matched: this pattern would answer requests it ` +
          `does not describe. Use "${
            key.split("/").slice(0, star + 1).join("/")
          }" and branch inside the handler.`,
      );
    }
    // A trailing wildcard/param pattern can't be refused (an SPA catch-all is
    // exactly what `"/*"` is for) — but it does NOT get the reserved namespace, and
    // silently not-serving a route the app declared is the failure mode this
    // whole check exists to prevent. Say so once, at boot, naming the pattern.
    if (
      (key.includes(":") || key.includes("*")) &&
      (matchRoute(key, "/__aio/health") !== null ||
        matchRoute(key, "/ws") !== null)
    ) {
      log.warn(
        "http",
        `custom route "${key}" matches the framework's reserved paths ` +
          `(/__aio/*, /ws) — those keep being served by aio (health, metrics, ` +
          `vitals, snapshot, and the dev module routes the page imports). ` +
          `Your handler sees every OTHER path it matches.`,
      );
    }
  }

  const absBaseDir = resolve(config.baseDir);

  // The app's deno.json imports feed the browser import map (see
  // readAppDenoImports — the startup linter reads the same thing, through the
  // same function, so the two can never disagree about what resolves).
  const denoImports = readAppDenoImports(absBaseDir);
  const importMapObj = buildBrowserImportMap(denoImports, {
    // prod serves bundles and the vendor route is dev-only — never point a
    // prod import map at it.
    vendorImmer: !prod && hasVendorImmer(),
  });
  const IMPORT_MAP = JSON.stringify({ imports: importMapObj });

  const absDistDir = distDir ? resolve(distDir) : null;
  const hasCSS = appHasStylesheet(absBaseDir, absDistDir);
  if (hasCSS) debug("style.css detected — injecting <link>");
  else {
    // A stylesheet that exists and is never served is the quietest failure in
    // this whole area: `style.css` is resolved from the APP DIR (the entry's
    // directory), so one written next to a `ui.entry` in a subdirectory is
    // simply not there as far as dev and the build are concerned — and with
    // `ui.theme: "auto"` the framework then styles an app that visibly styles
    // itself. The stray `src/style.css` case has been loud at build time for
    // releases; this is the same mistake one directory further in.
    const entry = config.uiEntry ?? UI_ENTRY;
    const uiDir = entry.includes("/")
      ? join(absBaseDir, entry.slice(0, entry.lastIndexOf("/")))
      : null;
    if (uiDir && appHasStylesheet(uiDir)) {
      log.warn(
        `style: ${join(uiDir, APP_STYLE)} exists but is NOT served — ` +
          `${APP_STYLE} is read from the app dir (${absBaseDir}), the same ` +
          `place the build copies it from. Move it there, or point ` +
          `baseDir at ${uiDir}.`,
      );
    }
  }

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
  const uiEntry = config.uiEntry ?? UI_ENTRY;
  if (!prod) {
    debug(
      `ui: serving ${uiEntry}${
        config.uiEntry ? "" : " (default convention — set ui.entry to override)"
      }`,
    );
    // `ui.entry` (runtime) and `build.ui` (deno.json) name the same component
    // to two different readers — the dev server and the bundler. Only the dev
    // server can see both, so it says so HERE, at boot, instead of letting the
    // compiled app render a different component than dev did. (The prod server
    // refuses that bundle outright; this is the same fact, caught days
    // earlier. Observe-only, so dev and prod still behave identically.)
    const declaredUi = (appDenoJson()?.build as { ui?: string } | undefined)
      ?.ui ?? UI_ENTRY;
    if (declaredUi !== uiEntry) {
      log.warn(
        `ui.entry is ${uiEntry} but deno.json build.ui is ${declaredUi} — dev ` +
          `serves ${uiEntry} and a build would bundle ${declaredUi}. Set ` +
          `"build": { "ui": "${uiEntry}" } in deno.json so the compiled app ` +
          `renders what you see here (the prod server refuses the mismatch).`,
      );
    }
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
    // The scheme half of the Origin check — see `secure` in WsDeps.
    secure: !!config.cert,
    // Revocation must reach sockets that are ALREADY open — the store is the
    // only thing that knows a session died (see `_revalidate` in server-ws).
    revalidateSession: _sessionResolver
      ? (tok: string) => {
        const info = _sessionResolver(tok);
        return info ? { id: info.id, role: info.role } : null;
      }
      : undefined,
    clientCounter: config.clientCounter ?? { value: 0 },
    bootId,
    vitalsSystem: config.vitalsSystem,
    costMeter: config.costMeter,
    onConnect: config.onConnect,
    onDisconnect: config.onDisconnect,
    onTTCommand: config.onTTCommand,
    // A `tt-cmd` frame rewinds/freezes state for every client — the same power
    // /__aio/snapshot has, so in per-user mode it takes the same admin bar.
    perUserAuth: _perUserAuth,
    getTTBroadcast: config.getTTBroadcast,
    syncHandler: config.syncHandler,
    // The same values the page shell embeds — the shell covers first paint,
    // this frame covers shells the build templated before compose time.
    clientConfig: {
      ...(config.renderBudget ? { renderBudget: config.renderBudget } : {}),
      ...(config.syncCells && config.syncCells.length
        ? { syncCells: config.syncCells }
        : {}),
      ...(config.callTimeouts ? { callTimeouts: config.callTimeouts } : {}),
      ...(config.bootedCells && config.bootedCells.length
        ? { bootedCells: config.bootedCells }
        : {}),
    },
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
    costMeter: config.costMeter,
    getTTBroadcast: config.getTTBroadcast,
    udsBroadcastRef: config.udsBroadcastRef,
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
    // DEV ONLY: prod serves the bundle, which already followed these imports
    // at build time. Gating it here means a production server cannot be made
    // to read outside its own root by a config key at all.
    serveDirs: prod ? undefined : config.serveDirs,
    absDistDir,
    hasCSS,
    importMap: IMPORT_MAP,
    noCache,
    showStatus: config.showStatus,
    uiEntry: config.uiEntry,
    viewport: config.viewport,
    headExtra: config.headExtra,
    chrome: config.chrome,
    theme: config.theme,
    lang: config.lang,
    themeName: config.themeName,
    width: config.width,
    height: config.height,
    renderBudget: config.renderBudget,
    syncCells: config.syncCells,
    callTimeouts: config.callTimeouts,
    getGraphResult: () => graphValidation?.getResult() ?? null,
    getSnapshot: config.getSnapshot,
    loadSnapshot: config.loadSnapshot,
    blobs: config.blobs,
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
      dispatchAsServer: config.dispatchAsServer,
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
      costMeter: config.costMeter,
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
      // Headless `am surface`: render the UI entry in-process
      // against live cell state — works with zero connected clients. Lazy:
      // happy-dom + the renderer load only when the route is hit.
      renderServerSurface: !prod
        ? async (full?: boolean) => {
          const { renderHeadlessSurface } = await import(
            "./server-surface.ts"
          );
          return renderHeadlessSurface(join(absBaseDir, uiEntry), full);
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
    // ── THE Host gate — DNS-rebinding defense, one decider ──
    // FIRST, ahead of every other rule, because it answers a question the
    // rules below all assume: "is this request even addressed to this app?".
    // A tab on evil.com whose DNS flips to 127.0.0.1 is same-origin with a
    // loopback app — its cookies ride along, the WS `isOwnHost` check passes
    // (Origin and Host both say evil.com), and in public mode there is no
    // credential to miss. From there `/__aio/trojan/state` is a raw,
    // unfiltered state read and `/dispatch`, `/sql`, `/snapshot`, `/shutdown`
    // are one POST each. HTTP, static, the trojan and the `/ws` upgrade all
    // funnel through this function, so the rule is written exactly once.
    const hostDenied = hostRefusal(req, info?.remoteAddr, {
      bindHost: config.host ?? (config.expose ? "0.0.0.0" : "127.0.0.1"),
      allowedOrigins: config.allowedOrigins,
    });
    if (hostDenied) return hostDenied;
    // F-4: derive a stable client key for cross-connection abuse tracking
    // (denylist, per-IP auth-fail budget, lockout bucketing).
    // TCP: remote hostname (IP). UDS: no key — in-process trust, skip denylist.
    // Behind a trusted reverse proxy the TCP peer is the proxy — every client
    // would collapse into ONE bucket (shared auth budget = trivial global
    // login DoS). When `trustProxyHeader` is set, take the client ip from the
    // RIGHTMOST hop of that header instead. Opt-in: honoring a client-settable
    // header without a proxy in front would let an attacker forge a fresh key
    // per request and evade the budget entirely.
    //
    // RIGHTMOST, never leftmost. `X-Forwarded-For` is APPENDED to by every hop
    // (that is the nginx/Caddy idiom the docs prescribe: `proxy_set_header
    // X-Forwarded-For $proxy_add_x_forwarded_for`), so element 0 is whatever
    // the CLIENT sent — pure attacker input. Reading it handed an attacker a
    // fresh abuse bucket per request: 30 bad tokens with a rotating first hop
    // never reached the 429 that ten from a fixed address do, which defeated
    // the per-IP auth budget, the 6-digit pairing-PIN budget (brute-forceable
    // inside its 3-minute TTL) and the WS denylist in one move. The LAST
    // element is the address the nearest trusted proxy actually observed, and
    // nothing downstream of that proxy can write it.
    const addr = info?.remoteAddr;
    const peerKey = addr && "hostname" in addr &&
        typeof addr.hostname === "string"
      ? addr.hostname
      : undefined;
    let clientKey = peerKey;
    if (config.trustProxyHeader && peerKey) {
      const fwd = req.headers.get(config.trustProxyHeader);
      const hops = fwd?.split(",") ?? [];
      const last = hops[hops.length - 1]?.trim();
      if (last) clientKey = last;
    } else if (_perUserAuth && !config.trustProxyHeader) {
      // Bucket collapse used to be SILENT. Warn from EVIDENCE — a forwarding
      // header on a real request — not from a guess about the deployment.
      _warnProxyBucketCollapse(req);
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

    // The machine owner reaches the control plane directly. This lives HERE —
    // one branch on one path prefix, after the same-machine 404 has already
    // removed every remote caller — rather than at the three
    // `trojanDenialForUserMode` call sites: in `users:` mode a credential-less
    // request dies at the "no token, no bytes" gate long before any trojan
    // check runs, so spreading this rule across cooperating conditionals is
    // one refactor away from a hole. The credential authorizes this prefix and
    // nothing else.
    if (
      pathname.startsWith("/__aio/trojan/") && localControlAuthorized(req)
    ) {
      const resp = await staticHandler.serveStatic(pathname, req);
      resp.headers.set("X-Content-Type-Options", "nosniff");
      return resp;
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
      // Same class as the auth routes' body cap: this is reachable BEFORE any
      // credential (that is the point of it), and a `{ pin }` payload is a few
      // dozen bytes. An unbounded `req.json()` here was an anonymous memory
      // pump on every exposed app.
      const declared = Number(req.headers.get("content-length") ?? NaN);
      if (!Number.isFinite(declared) || declared > 4096) {
        req.body?.cancel().catch(() => {});
        return new Response(
          JSON.stringify({
            error: "pairing body must be a small { pin } JSON",
          }),
          { status: 413, headers: { "Content-Type": "application/json" } },
        );
      }
      try {
        const body = await req.json() as { pin?: unknown };
        if (!verifyPin(body?.pin, clientKey)) {
          return new Response(
            JSON.stringify({
              error: "invalid or expired pairing code",
              // A PIN is consumed on first use, so "wait and retry" is wrong
              // advice. It used to say "restart the app" because boot was the
              // only thing that could mint one — downtime for every connected
              // client to recover a missed 3-minute window. `am pair` mints one
              // on a running app, so that is the honest answer now.
              //
              // The window comes from PIN_TTL_MS rather than a number typed
              // here: this hint and the PIN's real lifetime are one fact, and
              // the copy was already free to drift out of sync with it.
              hint:
                `pairing codes expire after ${
                  Math.round(PIN_TTL_MS / 60_000)
                } minutes and are single-use — run \`am pair\` to mint a new one ` +
                `without restarting the app`,
            }),
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
      // THE BUDGET GATES FAILED AUTHENTICATION, NEVER SERVICE.
      //
      // This used to be `if (authFailBudgetExceeded(clientKey)) return 429`
      // right here, ahead of token resolution — so a key over budget was
      // refused EVERY request, not just its bad ones. Cost to weaponize:
      // 10 × `POST /auth/login {id:"anyone", password:"wrong"}` (unknown ids
      // record a failure too), ~2 requests/minute to sustain. Effect: the
      // victim's shell request WITH A VALID SESSION got 429, their
      // authenticated HTTP calls got 429, and their WS handshake was refused.
      // Behind the reverse proxy the docs prescribe, every client shares one
      // bucket (see `_warnProxyBucketCollapse`), so that is the whole app,
      // off the air, from one unauthenticated attacker.
      //
      // The rule now: resolve the credential FIRST; a caller presenting a
      // valid one is served no matter what the budget says, and only a
      // request whose credential is absent or wrong can be throttled.
      // Resolution is not free (a `resolveUser` hook may hit a DB/JWKS) —
      // but it is exactly one credential check, the same one a legitimate
      // request performs, and refusing to make it was refusing service.
      const { token, fromUrl, source } = _extractTokenWithSource(url, req);
      // AUTH-2: with the login flows enabled, the app SHELL is public — a
      // browser must load the UI (code, not state) to show SignIn before it
      // has a session. Everything stateful stays gated: /ws requires a valid
      // session, /__aio/snapshot and /__aio/trojan/* require admin. Without
      // authFlows the classic behavior is untouched: no token, no bytes.
      const shellIsPublic = config.authFlows !== undefined;
      if (!token && !shellIsPublic) {
        return new Response("Unauthorized", { status: 401 });
      }
      // A URL-borne session token is refused everywhere except the WS
      // handshake, which has no header channel (see the resolver above).
      //
      // COOKIE CLAMP: a cookie may authenticate a SESSION and nothing else.
      // The login flow is the only thing that ever sets `aio_session`, and it
      // only ever puts a session token in it — so falling through to the
      // static `users:` map / `resolveUser` for a cookie value bought nothing
      // and cost the one thing that makes the budget exemption below safe:
      // a short static token would otherwise be guessable through an
      // unmetered channel.
      const user = token
        ? (source === "cookie"
          ? (_sessionResolver?.(token) ?? null)
          : await _userResolver(token, fromUrl && pathname !== "/ws"))
        : null;
      if (!user) {
        // Only a DELIBERATELY presented credential is an attack signal. An
        // ambient cookie is attached by the browser to every subresource, so
        // charging it to the budget meant one reload after a session expired
        // locked the legitimate user out of /login for 5 minutes.
        const presented = !!token && _isPresented(source);
        if (presented) {
          recordAuthFail(clientKey, "invalid token (per-user mode)");
        }
        // Fail LOUD rather than silently forever: tell the browser to drop the
        // dead cookie so the next request is a clean anonymous one.
        const extra = source === "cookie"
          ? { "Set-Cookie": clearSessionCookie(!!config.cert) }
          : undefined;
        // Over budget AND presenting a bad credential → "back off", not
        // "wrong token". A request that presented NOTHING is not an attack
        // signal and is answered exactly as it would be with an empty budget
        // (401, or the public shell) — throttling anonymous shell loads is
        // how the refusal became a whole-app outage in the first place.
        if (presented && authFailBudgetExceeded(clientKey)) {
          return new Response("Too Many Requests", {
            status: 429,
            headers: extra,
          });
        }
        if (!shellIsPublic || pathname === "/ws") {
          return new Response("Unauthorized", { status: 401, headers: extra });
        }
        // public shell: fall through to static serving as anonymous
        if (pathname === "/__aio/snapshot") {
          return new Response("Unauthorized", { status: 401, headers: extra });
        }
        // Blob BYTES are app data, not app shell. The login flows make the
        // shell (code) public so SignIn can render — but an anonymous client
        // must not read stored binaries through the same door.
        if (pathname.startsWith("/__aio/blobs/")) {
          return new Response("Unauthorized", { status: 401, headers: extra });
        }
        // Nor the DIAGNOSTIC surface. `authFlows` makes the shell public so
        // SignIn can render; it says nothing about telemetry. Anonymously,
        // these answered: how many cells there are and how big each one is,
        // the ids and user ids of every connected client, connection and
        // dispatch counts, and the app's most recent error STRINGS — which is
        // a live map of an app whose whole point is that you must log in to
        // see anything. They are operator surfaces, so they answer to an
        // account, exactly like /__aio/snapshot two lines up.
        if (_ANON_DENIED_DIAGNOSTICS.some((p) => pathname === p)) {
          return new Response(
            `Unauthorized — ${pathname} reports on this app's internals ` +
              `(cell sizes, connected clients, recent errors) and requires a ` +
              `signed-in user. The app SHELL is public so the sign-in page can ` +
              `render; nothing behind it is.\n\n` +
              // The one thing an operator needs and would otherwise have to
              // discover the hard way: a liveness probe does not need a
              // credential, because it does not need this endpoint. Without
              // this line the fix people reach for is giving their monitoring
              // an account — which is a credential in a config file, sitting
              // there forever, to answer "is it up".
              `For a liveness/readiness probe, use GET / — it answers 200 ` +
              `anonymously on this app (that is what makes the sign-in page ` +
              `reachable) and needs no credential.`,
            { status: 401, headers: extra },
          );
        }

        // …but NEVER to the control plane. serveStatic mounts the trojan, and
        // the trojan has no auth of its own: without this the login flows made
        // raw-state read, arbitrary dispatch, SQL and full-state overwrite
        // ANONYMOUS on every `auth: true` app.
        const denied = trojanDenialForUserMode(pathname, undefined);
        if (denied) return denied;
        const anonResp = await staticHandler.serveStatic(pathname, req);
        anonResp.headers.set("X-Content-Type-Options", "nosniff");
        if (extra) anonResp.headers.set("Set-Cookie", extra["Set-Cookie"]);
        return anonResp;
      }
      if (url.searchParams.get("token")) _warnTokenInUrl();
      if (pathname === "/ws") {
        // Sockets outlive the credential that opened them, so the socket keeps
        // the session token and re-validates it (see `revalidateSession`).
        const sessionToken = _sessionResolver?.(token!) ? token! : undefined;
        return wsMgr.handleWs(req, user, clientKey, sessionToken);
      }
      // Snapshot dumps/overwrites RAW state — it bypasses ui include/exclude
      // and forUser filtering, so only admins may touch it in per-user mode.
      if (pathname === "/__aio/snapshot" && user.role !== "admin") {
        return new Response(
          'Forbidden — /__aio/snapshot exposes unfiltered state and requires role "admin"',
          { status: 403 },
        );
      }
      // The control plane is snapshot's power and more — same admin bar.
      const denied = trojanDenialForUserMode(pathname, user);
      if (denied) return denied;
      debug(`http: ${req.method} ${pathname} user=${user.id}`);
      // Custom routes run authenticated in per-user mode too — the handler's
      // ctx.user is this resolved user.
      const routed = await tryRoutes(req, pathname, user, addr);
      if (routed) return routed;
      const resp = await staticHandler.serveStatic(pathname, req);
      resp.headers.set("X-Content-Type-Options", "nosniff");
      return resp;
    }

    // Set on the ONE request that proved it holds the key; attached to whatever
    // response the paths below produce. Request-SCOPED deliberately: a
    // module-level carrier would hand one request's cookie to another's
    // response the first time two arrived together.
    let setKeyCookie: string | null = null;
    /** Attach the shared-key cookie when this request earned one. `append`,
     *  never `set`: an app route may have set cookies of its own. */
    const withKeyCookie = (r: Response): Response => {
      if (setKeyCookie) r.headers.append("Set-Cookie", setKeyCookie);
      return r;
    };

    // Auth path 2: single shared token (--expose without users)
    if (config.token) {
      // Same rule as the per-user path above: compare the key FIRST (two
      // timing-safe string compares — nothing an attacker can drive), so the
      // holder of the correct key is served even while someone else on the
      // same bucket is being throttled. Only a wrong key meets the budget.
      const qToken = url.searchParams.get("token");
      const auth = req.headers.get("authorization");
      const hToken = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      // …and the cookie this mode sets on the shell load. Without it, shared-key
      // mode could not serve a BROWSER at all: the page loads with `?token=`,
      // then requests `/App.tsx` and `/bundle.js` with no query and no header —
      // nothing carries the credential — so every asset 401'd and the shell
      // rendered nothing. Key mode was native-clients-only by accident.
      const cToken = parseCookies(req.headers.get("cookie"))[keyCookieName];
      const validQ = qToken !== null && _timingSafeEqual(qToken, config.token);
      const validH = hToken !== null && _timingSafeEqual(hToken, config.token);
      const validC = cToken !== undefined &&
        _timingSafeEqual(cToken, config.token);
      if (!validQ && !validH && !validC) {
        // Only PRESENTED-and-wrong tokens burn budget — a tokenless probe
        // (health check, crawler) is a plain 401, not an attack signal.
        if (qToken !== null || hToken !== null || cToken !== undefined) {
          recordAuthFail(clientKey, "invalid token (shared-key mode)");
          if (authFailBudgetExceeded(clientKey)) {
            return new Response("Too Many Requests", { status: 429 });
          }
        }
        return new Response("Unauthorized", { status: 401 });
      }
      if (validQ && !validH) _warnTokenInUrl();
      // Hand the browser the credential for its follow-up requests, once, on
      // the request that proved it has the key. HttpOnly so script cannot read
      // it (strictly better than the `?token=` URL it replaces, which leaks to
      // history, referrers and proxy logs); SameSite=Strict so it is never sent
      // cross-site, which is what keeps ambient cookie authority from becoming
      // CSRF; Secure whenever the page itself is https. The control plane
      // additionally requires the `X-AIO` header, which a cross-origin form
      // post cannot set — so the cookie widens READS to the browser, not the
      // ability to drive the app from another site.
      if (validQ && !validC) setKeyCookie = keyCookieHeader(url, config.token);
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

    // A 101 upgrade carries no useful Set-Cookie, and a socket authenticated
    // by its own query token needs none.
    if (pathname === "/ws") return wsMgr.handleWs(req, undefined, clientKey);
    debug(`http: ${req.method} ${pathname}`);
    // ── Custom user routes (uploads, webhooks, API endpoints) ──
    const routed = await tryRoutes(req, pathname, undefined, addr);
    if (routed) return withKeyCookie(routed);

    const resp = await staticHandler.serveStatic(pathname, req);
    resp.headers.set("X-Content-Type-Options", "nosniff");
    return withKeyCookie(resp);
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
    // The framework's own namespace is never routable — the SAME rule the boot
    // check applies to a literal pattern, applied to the path a wildcard would
    // otherwise have swallowed (see isReservedRoutePath).
    if (isReservedRoutePath(pathname)) return null;
    const ip = addr && "hostname" in addr ? addr.hostname : undefined;
    // Ambient request + identity: a handler (and every cell method / serverFn
    // it calls, across awaits) can ask serverRequest() for the client IP,
    // headers and cookies without the route threading them down by hand.
    const rc = makeServerRequest(req, ip, "http");
    const run = <T>(fn: () => T): T =>
      runWithRequest(rc, () => runWithUser(user, fn));
    /** Invoke ONE matched handler. An app route is app code, and app code has
     *  bugs — but a bug in it must not be a process event:
     *
     *  • a THROW reached Deno.serve, which answered a bare 500 naming neither
     *    the route, the method nor the path — "Error: boom" in the terminal and
     *    nothing to bisect from;
     *  • returning a NON-Response (the raw `(req) => Response` form is public
     *    API — forget a `return`, or return the object you meant to `json()`)
     *    escaped as an UNHANDLED REJECTION at the serve boundary
     *    ("Return value from serve handler must be a response…"), which the
     *    crash handler reports as a process-level fault. One mistyped handler
     *    could take the app down instead of failing one request.
     *
     *  Both now: 500 to the client, one attributed error line in the terminal,
     *  server still up. Identical in dev and prod — no fork. */
    async function invoke(
      pattern: string,
      handler: RawRouteHandler,
      match: RouteMatch,
    ): Promise<Response> {
      let res: unknown;
      try {
        res = await run(() => handler(req, match));
      } catch (e) {
        log.error(
          "http",
          `route "${pattern}" (${req.method} ${pathname}) threw — ${
            e instanceof Error ? (e.stack ?? e.message) : String(e)
          }`,
        );
        return new Response("Internal Server Error", { status: 500 });
      }
      if (!(res instanceof Response)) {
        log.error(
          "http",
          `route "${pattern}" (${req.method} ${pathname}) returned ` +
            `${res === undefined ? "undefined" : typeof res} instead of a ` +
            `Response — a routes handler must return one (use ctx.json/ctx.text/` +
            `ctx.redirect from route(), or \`new Response(...)\`). Answered 500.`,
        );
        return new Response("Internal Server Error", { status: 500 });
      }
      return res;
    }
    // Exact literal match first (fast + unambiguous).
    const exact = config.routes[pathname];
    if (exact) return await invoke(pathname, exact, { params: {}, user, ip });
    for (const [pattern, handler] of Object.entries(config.routes)) {
      if (!pattern.includes(":") && !pattern.includes("*")) continue;
      const params = matchRoute(pattern, pathname);
      if (params) return await invoke(pattern, handler, { params, user, ip });
    }
    return null;
  }

  // ── Start HTTP server ──
  let httpServer: Pick<Deno.HttpServer, "finished" | "shutdown">;
  const udsPath = config.socketPath;
  if (udsPath && isPipePath(udsPath)) {
    // Windows: `Deno.serve({ path })` has no pipe equivalent, so the handler
    // is served by the minimal HTTP/1.1 server over the pipe listener — the
    // same handler, the same peer claim (`UDS_PEER`), one request per
    // connection, bodies streamed both ways.
    const over = serveHttpOverLocal(listenLocal(udsPath), handleRequest);
    httpServer = { finished: over.finished, shutdown: () => over.close() };
  } else if (udsPath) {
    try {
      Deno.removeSync(udsPath);
    } catch { /* doesn't exist */ }
    httpServer = Deno.serve(
      { path: udsPath, onListen: () => {} },
      handleRequest,
    );
  } else {
    const hostname = config.host ?? (config.expose ? "0.0.0.0" : "127.0.0.1");
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
        // Loud + fatal: a bind failure usually means another
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
      async (req, info) => {
        // The Host gate is a security rule, so it holds on BOTH listeners —
        // this one is plain HTTP on loopback, which is exactly what a rebound
        // domain reaches. Same decider, no second copy of the rule.
        const denied = hostRefusal(req, info?.remoteAddr, {
          bindHost: "127.0.0.1",
          allowedOrigins: config.allowedOrigins,
        });
        if (denied) return denied;
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
          const { token, fromUrl, source } = _extractTokenWithSource(url, req);
          // Same cookie clamp as the main listener: a cookie carries a
          // session, never a static `users:`/`resolveUser` token.
          const user = token
            ? (source === "cookie"
              ? (_sessionResolver?.(token) ?? null)
              : await _userResolver(token, fromUrl && url.pathname !== "/ws"))
            : null;
          if (!user) return new Response("Unauthorized", { status: 401 });
          if (url.pathname === "/__aio/snapshot" && user.role !== "admin") {
            return new Response(
              'Forbidden — /__aio/snapshot exposes unfiltered state and requires role "admin"',
              { status: 403 },
            );
          }
          const denied = trojanDenialForUserMode(url.pathname, user);
          if (denied) return denied;
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

  // A revoked session must disarm sockets that are ALREADY open. The periodic
  // sweep in the WS manager is the universal backstop (it also catches TTL
  // expiry and out-of-band deletes); this subscription removes the latency for
  // the deliberate revocations — logout, kick, password change, reset.
  const _unsubRevoke = config.authFlows?.sessions.onRevoked(
    () => wsMgr.sweepSessions(),
  );

  // ── Zombie-server guard (watcher-loop field report #4) ──
  // Event-loop starvation once killed the HTTP listener while the process kept
  // spinning (alive-but-dead). Crash loudly instead so a supervisor restarts us.
  let _shuttingDown = false;
  httpServer.finished.then(() => {
    if (_shuttingDown) return;
    log.error(
      "[aio] FATAL: HTTP listener died unexpectedly — exiting so a supervisor can restart (zombie-server guard)",
      { detail: String() },
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
    // The control plane over a non-TCP wire. Not a second implementation —
    // the SAME handler, told the truth about its peer: a unix socket, which
    // `_isLocalRequest` already treats as same-machine by construction, and
    // which carries no abuse-bucket key by design (see `clientKey`).
    control: (req) => handleRequest(req, { remoteAddr: UDS_PEER } as never),
    shutdown: async () => {
      _shuttingDown = true;
      clearInterval(_stallTimer);
      watcher?.shutdown();
      broadcaster.shutdown();
      resetTrojanRateLimit();
      _unsubRevoke?.();
      wsMgr.shutdown();
      if (graphValidation) await graphValidation.done.catch(() => {});
      await Promise.all([
        httpServer.shutdown(),
        trojanServer?.shutdown(),
      ]);
      await stopEsbuild();
      if (udsPath && !isPipePath(udsPath)) {
        try {
          Deno.removeSync(udsPath);
        } catch { /* already removed */ }
      }
      disposeClientLog();
    },
  };
}
