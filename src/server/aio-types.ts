// Pure type definitions for aio.run() — no runtime code
import type { AioError, ReportErrorOpts } from "../diagnostics/error.ts";
import type { PerfBudget } from "../state/dispatch.ts";
import type {
  CellPatchStrategy,
  PatchFilterFields,
} from "../state/state-filter.ts";
import type { ScheduleDef, ScheduleEffect } from "../state/schedule.ts";
import type { OwnEffect } from "../state/own.ts";
import type { DB } from "../db/mod.ts";
import type { TableDef } from "./sql.ts";
import type { CellStatus, CircuitBreakerConfig } from "../state/cell.ts";
import type { MemoryConfig } from "../diagnostics/memory-monitor.ts";
import type { LogConfig } from "../diagnostics/logger.ts";
import type { StormConfig } from "../diagnostics/dispatch-storm.ts";
import type { CheckpointData, DiagnosticsConfig } from "../diagnostics/mod.ts";
import type { RenderBudget } from "../vitals/types.ts";
import type { ReduceBreakdown } from "../diagnostics/time-travel.ts";

/** User identity — resolved from static token map or dynamic resolveUser hook.
 *  The wire shape (`{ id, role }`) is defined in protocol/ (it crosses the
 *  wire; the browser's auth UI needs it too); the PUBLIC type is opened
 *  (alpha52) with `& Record<string, unknown>` so the extra fields a
 *  `resolveUser`/`users` entry attaches are readable without casting — the
 *  one opened definition lives in state/cell-types.ts (`AccessUser`). */
import type { AccessUser } from "../state/cell-types.ts";
/** The signed-in caller an aio app sees — `id` plus whatever your
 *  `resolveUser`/`users` config attaches (roles, profile fields). */
export type AioUser = AccessUser;

/** AUTH-2/3 options for `auth: {...}` (auth: true = all defaults). */
export type AuthOptions = {
  /** Open self-signup (default true; false = admin-seeded users only). */
  signup?: boolean;
  /** Session TTL in ms (default 30 days). */
  ttlMs?: number;
  /** Set the HttpOnly session cookie on login (default true). */
  cookie?: boolean;
  /** Email transport for verify/reset flows (SMTP/SES/console — yours). */
  sendMail?: (msg: {
    to: string;
    subject: string;
    text: string;
  }) => Promise<void> | void;
  /** Block login until the account's email is verified (needs sendMail). */
  requireVerified?: boolean;
  /** Allow TOTP 2FA enrollment (default true). */
  totp?: boolean;
  /** OIDC provider (authorization code + PKCE) — social/enterprise login. */
  oidc?: import("./auth-oidc.ts").OidcConfig;
};

/** Dynamic user resolution hook — called with extracted token + current state.
 *  Return AioUser to authenticate, null to reject. Supports async (e.g. JWT verification). */
export type ResolveUserFn<S = unknown> = (
  token: string,
  state: S,
) => AioUser | null | Promise<AioUser | null>;

/** `ui.theme` — how much of aio's default look the shell emits. ONE spelling:
 *  every shell (server, electron, android) and the config bridge import this
 *  type rather than re-typing the union. See {@linkcode UiConfig.theme}. */
export type UiTheme = "tokens" | "auto" | "full" | "none";

/** Window + UI sync options — applies to both Electron and browser clients */
export type UiConfig = {
  title?: string; // default: 'AIO App'
  width?: number; // default: 800
  height?: number; // default: 600
  showStatus?: boolean; // default: true
  /** UI entry file, relative to baseDir. Default: "App.tsx" (the filename
   *  convention). Set to serve/watch a different component file.
   *
   *  The BUILD half is `build.ui` in deno.json (or `--ui=`, which the fleet
   *  build passes per target): a bundle records the component it was built
   *  from, and the server refuses to serve one whose stamp disagrees with this
   *  value. Setting only this used to render one component under `deno task
   *  dev` and a different one once compiled — the dev≠prod divergence the
   *  framework otherwise polices. */
  entry?: string;
  /** AIO-423: override the `<meta viewport>` content string. Default is
   *  responsive (`width=device-width, initial-scale=1, viewport-fit=cover`).
   *  Set `false` to omit it entirely (rare fixed-width desktop layouts). */
  viewport?: string | false;
  /** AIO-423: verbatim extra `<head>` content — meta description, Open Graph
   *  tags, `<link rel="icon">`, fonts, etc. Inserted trusted (not escaped),
   *  like the stylesheet link. */
  head?: string;
  /** How much of the window the OS draws, on desktop (Electron) targets.
   *
   *  - `"standard"` (default) — the platform's own title bar and border.
   *    Nothing changes; this is what every app has always had.
   *  - `"themed"` — no OS frame; aio draws a title bar the app's own CSS
   *    styles. It is a normal, restylable part of the page
   *    (`.aio-titlebar`, `.aio-titlebar-title`, `.aio-titlebar-button`, and
   *    the `--aio-titlebar-*` custom properties), and it keeps the three
   *    things a frameless window otherwise loses: a drag region, the
   *    minimise/maximise/close controls, and double-click-to-maximise.
   *  - `"none"` — no frame and no title bar: the page IS the window. Draw
   *    your own drag region with `-webkit-app-region: drag` wherever you want
   *    one, or the window cannot be moved.
   *
   *  Ignored by the browser target, where there is no window to own — the
   *  title bar hides itself when the window-control bridge is absent, so one
   *  codebase serves both without a branch. */
  chrome?: "standard" | "themed" | "none";
  /** The default look — and who owns the visual stage.
   *
   *  **Nothing paints unless you ask.** An app that never mentions `theme`
   *  renders exactly as it would without aio: the browser's own defaults plus
   *  aio's two-rule baseline (`box-sizing`, `body{margin:0}`), and the inert
   *  `--aio-*` custom properties, which paint nothing until something
   *  references them (`ui.chrome: "themed"`'s title bar does).
   *
   *  Opting in is one word, because a framework look that arrives on its own
   *  is a rule you never wrote and that is not the browser default either —
   *  the worst kind to debug. A cascade layer does not save you: `@layer aio`
   *  wins only where your CSS *disagrees*, so where it says nothing —
   *  `max-width` on `<main>`, `display`/`gap` on a class you happen to call
   *  `.row` — the default applied unopposed and re-laid-out pages nobody
   *  asked it to touch.
   *
   *  - `"tokens"` (default) — the `--aio-*` variables only. Nothing paints.
   *  - `"auto"` — the complete look (typography, colour in light AND dark,
   *    forms, tables, code, cards, a page shell, accented from the app's own
   *    name — the same hue as its icon) UNTIL the app ships a `style.css`, at
   *    which point every visual default steps aside and `"tokens"` remains.
   *    What `am create` writes into a new app.
   *  - `"full"` — the complete look ALONGSIDE your own CSS (for an app that
   *    styles ON TOP of the default).
   *  - `"none"` — nothing at all, not even the variables.
   *
   *  Rebranding does not need this switch: set `--aio-accent` (or
   *  `--aio-hue`, `--aio-font`, `--aio-r-2`, …) in your own CSS and every
   *  derived tone follows. */
  theme?: UiTheme;
};

/** Per-client WebSocket safety limits for `--expose` deployments. All optional —
 *  omitted fields keep the hardened defaults. Tune only when a reverse proxy or
 *  trusted-LAN posture needs different ceilings (W6.6). */
export type WsLimits = {
  /** Max bytes per WS message before it's dropped. Default: 1_000_000 (1MB). */
  maxMessageBytes?: number;
  /** Max messages per second per client. Default: 100. */
  messagesPerSec?: number;
  /** Max bytes per second per client (bandwidth DoS guard). Default: 5_000_000. */
  bytesPerSec?: number;
};

/** @internal Engine-level reduce/execute config. The public authoring surface is
 *  `CellsConfig` (`cells: [...]`); `aio-cells-bridge.ts` compiles cells down to this
 *  shape for `_run()`. Not exported from `aio` — internal to the runtime. */
export type AioConfig<S, A, E> = {
  /** Unique app identity — used for lock file, UDS socket, KV/SQLite paths, TLS cert dir. Mandatory. */
  /** App identity — inferred (deno.json / main-module dir) when omitted. */
  appId?: string;
  reduce: (
    state: S,
    action: A,
  ) => { state: S; effects: (E | ScheduleEffect | OwnEffect)[] };
  execute: (app: AioApp<S, A>, effect: E) => void;
  persist?: boolean; // default: true — persists to SQLite (state.db, aio_kv table)
  /** Where this app keeps everything it owns. Default `~/.<appId>` — `data/`
   *  inside it is the whole backup; `logs/` and `launch.json` are disposable.
   *  This is the AUTHOR's choice; whoever runs the app can move every app at
   *  once with `AIO_APPS_DIR=<root>` (→ `<root>/<appId>`).
   *  See docs/persistence/where-files-live.md. */
  appDir?: string;
  /** Override the SQLite file (":memory:" for hermetic tests, or an absolute
   *  path). Default: `<appDir>/data/state.db`. */
  dbPath?: string;
  /** PRAGMAs for the app db (default: WAL + synchronous=NORMAL). Set
   *  `["PRAGMA journal_mode = WAL", "PRAGMA synchronous = FULL", …]` when the
   *  data is expensive to lose. */
  dbPragmas?: string[];
  /** Check the app database's integrity at boot (`PRAGMA quick_check`).
   *
   *  On a damaged file: the file is QUARANTINED beside itself with a timestamp
   *  (never deleted), and if a `<db>.snapshot` sits next to it the app boots on
   *  that instead — each branch reported loudly, including what was lost. Off
   *  by default: it costs a scan on every boot and only apps holding data a
   *  user would miss need it. Take the snapshots it restores from with
   *  `db.snapshot(path)`. */
  checkIntegrityOnBoot?: boolean;
  /** Keep this app up to date from a release source.
   *
   *  A bare URL is the whole configuration; the object form adds the switches
   *  a default cannot decide for you:
   *
   *  ```ts
   *  updates: "https://releases.example.com/wallet"      // published artifacts
   *  updates: "https://github.com/you/app"               // the repo itself
   *  updates: { source, auto: true }                     // unattended service
   *  ```
   *
   *  Omitted ⇒ nothing polls, nothing is registered, nothing ships. An update
   *  is only ever OFFERED when the release can migrate the data already on
   *  disk — see docs/deploy/updates.md. */
  updates?: import("./updates-core.ts").UpdatesInput;
  /** Capture problem reports — what is running, what state it was in, what had
   *  just happened, and the recent log — into `<data>/reports/`.
   *
   *  `true` is the whole configuration: user reports via the `feedback` cell,
   *  plus automatic capture when the app breaks. `{ url }` also POSTs them;
   *  `{ sink }` hands them anywhere else. Reports honour the SAME `redactActions`
   *  rule as the journal and the timeline. See docs/debugging/feedback.md. */
  feedback?: import("./feedback-boot.ts").FeedbackInput;
  fullStateThreshold?: number; // 0-1: ratio of changed keys that triggers full state broadcast (default: 0.5)
  /** Custom HTTP routes — exact path or "/prefix/*" wildcard → handler. The
   *  escape hatch for uploads, webhooks, and API endpoints that don't belong
   *  in the state channel. Reserved: /__aio and /ws. */
  routes?: Record<string, import("./route.ts").RawRouteHandler>;
  syncIntervalMs?: number; // default: 50 — max 1 state push per N ms (0 = microtask coalescing only)
  maxConnections?: number; // max concurrent WebSocket clients (default: 100)
  wsLimits?: WsLimits; // per-client WS rate/size limits (advanced; defaults hardened)
  allowedOrigins?: string[]; // extra allowed WS origins beyond localhost + own host (reverse proxy, custom domains)
  strictOrigin?: boolean; // --expose hardening: require an Origin header on WS upgrade
  /** Behind a trusted reverse proxy, read the real client IP from this header's first hop for abuse/auth-fail/lockout bucketing (e.g. "x-forwarded-for"). Opt-in — only set it when a proxy actually fronts the app. */
  trustProxyHeader?: string;
  beforeReduce?: (action: A, state: S, user?: AioUser) => A | null; // intercept actions before reduce — return null to drop
  persistKey?: string; // KV key prefix (default: "state")
  persistDebounceMs?: number; // ms between KV writes (default: 100)
  persistMode?: "single" | "multi"; // 'single' (default): one JSON blob. 'multi': one SQLite row per top-level cell — rewrites only changed cells. No size cap either way (SQLite backend).
  users?: Record<string, AioUser>; // static token map — token is key, user is value
  /** --expose auth. Default (omitted/`false`) = **no framework auth** (the
   *  app does its own, or is open on a trusted LAN). `"secret"` = fixed key.
   *  `true` = a stable key generated once and persisted in the data dir. */
  key?: string | boolean;
  resolveUser?: ResolveUserFn<S>; // dynamic user resolution — overrides users if both set (AIO-171)
  /** AUTH-1: enable the SQLite session store — `app.sessions.issue(user)`
   *  returns a bearer token that authenticates like any users/resolveUser
   *  token, with TTL + revocation. `true` = 30-day default TTL. */
  sessions?: boolean | { ttlMs?: number };
  /** AUTH-2/3: built-in password auth — signup/login/logout + email verify,
   *  password reset, TOTP 2FA, OIDC (/__aio/auth/*), PBKDF2 user store,
   *  HttpOnly session cookie. Implies `sessions`. */
  auth?: boolean | AuthOptions;
  ui?: UiConfig;
  port?: number; // default: 8000
  /** Bind 0.0.0.0 + TLS for LAN access — the config twin of `--expose`, so a
   *  COMPILED binary (which has no shell flags in a service unit) can expose
   *  from code. `--expose` still wins when both are set. Resolved exactly once
   *  in aio.ts (`_exposeOf`); nothing else may re-decide it. */
  expose?: boolean;
  /** Transport security when exposed — the config twin of `--no-tls` /
   *  `--tls-cert`/`--tls-key`, so a COMPILED binary (a service unit has no
   *  shell flags) can declare how it serves.
   *
   *  - `"auto"` (default) — self-signed cert generated and reused per app.
   *  - `false` — plain HTTP/WS. Sound only behind a TLS-terminating proxy or
   *    when the payload is already end-to-end encrypted; it warns loudly.
   *  - `{ cert, key }` — your own PEM files (a real CA cert: the one shape
   *    every non-browser client accepts without extra trust configuration).
   *
   *  The CLI flags still win when both are given. Loopback is plain HTTP
   *  regardless — this only decides how an EXPOSED server serves. */
  tls?: "auto" | false | { cert: string; key: string };
  /** Bind ONE address instead of the expose-derived default (0.0.0.0 when
   *  exposed, 127.0.0.1 when not) — a multi-homed machine (VPN + LAN) often
   *  wants the relay on the LAN interface only. Config twin of `--host=`;
   *  the flag wins when both are set. */
  host?: string;
  baseDir?: string; // default: ./src
  /** Extra READ-ONLY roots the DEV server may serve, mapped to a URL prefix:
   *  `{ "/shared": "../core/lib" }`. Browser-reachable imports may not leave
   *  `baseDir` (it is an HTTP root, so anything outside 404s), which makes two
   *  apps in one repository unable to share a pure module without copying it —
   *  a field report ended up with a generated mirror and a test policing the
   *  drift. Prod is unaffected: the bundler already follows relative imports.
   *  Each root gets baseDir's containment guards unchanged (no traversal, no
   *  symlink escape, no dotfiles or server-only paths). A relative root is
   *  resolved against the process cwd, exactly like `baseDir`; a root that is
   *  not a directory is warned about at boot instead of 404ing in silence. */
  serveDirs?: Record<string, string>;
  client?: "electron" | "browser" | "cli" | "server-only"; // default: 'electron'
  keepServer?: boolean; // default: false — keep server running after client closes (moved from ui.keepAlive)
  transport?: "uds" | "ws" | "auto"; // default: 'auto' — UDS on linux/mac+electron, WS otherwise (moved from ui.transport)
  killExisting?: boolean; // default: false
  serverUrl?: string;
  /** App version — default: deno.json `version`. */
  appVersion?: string; // app version string — logged on startup, available at __aio.appVersion
  schedules?: ScheduleDef[]; // static scheduled effects — started on boot
  db?: Record<string, TableDef>; // SQLite table definitions — arrays auto-sync
  perfCheck?: "on" | "off"; // default: 'on' — enable/disable performance violation reporting
  perfBudget?: PerfBudget; // override default budgets (reduce: 100, effect: 5)
  renderBudget?: RenderBudget; // override render staleness/patch thresholds (sent to browser)
  /** How long an async method may run before the framework stops waiting for
   *  it (default 30000). It bounds BOTH sides of the same call: the effect
   *  tracker abandons the effect, and `await cell.method()` rejects. Neither
   *  CANCELS the method — it keeps running, and if it finishes its writes still
   *  commit; only the return value is lost. `0` waits indefinitely. Per method:
   *  `perfBudget.methods["cell:method"].timeout`. */
  effectTimeoutMs?: number;
  freezeState?: boolean; // default: false in prod, true in dev — deep freeze state after reduce to catch mutations
  memory?: MemoryConfig; // memory pressure monitoring config
  circuitBreaker?: CircuitBreakerConfig; // auto-disable cells after N errors
  onRestore?: (state: S) => S; // transform state after restore, before server starts
  singleton?: boolean; // true (default)=refuse if running, false=allow multi
  /** Library/test mode: no `Deno.exit`, no SIGINT/SIGTERM handlers, no singleton
   *  lock. `app.close()` tears down and resolves, leaving the process alive so a
   *  test runner (or an embedding host) survives. Use it to boot a real server
   *  inside `Deno.test` — see `aio/testing` `testServer`. Default: false. */
  libraryMode?: boolean;
  // Lifecycle hooks — observe-only, all optional, error-guarded
  onAction?: (action: A, state: S, user?: AioUser) => void;
  onEffect?: (effect: E, state: S, user?: AioUser) => void;
  onConnect?: (user?: AioUser) => void;
  onDisconnect?: (user?: AioUser) => void;
  onStart?: (app: AioApp<S, A>) => void;
  /** If true, an onStart error terminates the process. Default: false (log and continue). */
  fatalOnStart?: boolean;
  onStop?: () => void;
  onError?: (error: AioError) => void;
  /** Internal: schedule cancel callback set by _run, used by cells disable */
  _onScheduleReady?: (cancelByPrefix: (prefix: string) => void) => void;
  /** Internal: AIO-222 — propagate reportOpts to cell error reporting */
  _onReportOptsReady?: (opts: ReportErrorOpts) => void;
  /** Internal: diagnostics config passed from CellsConfig */
  _diagnostics?: DiagnosticsConfig;
  /** Supervised runtime — survive unhandled promise rejections (see CellsConfig). */
  guardDispatches?: boolean;
  /** Durable action journal — replay the debounce-window tail after a
   *  SIGKILL/power-cut (see CellsConfig). */
  journal?: boolean;
  /** Action types whose recorded VALUES must never be retained anywhere: the
   *  durable journal, the in-memory timeline (`am timeline`) and the optional
   *  action log all honour this one list. An action's payload is its arguments,
   *  so for a method like `vault:unlockWith(passphrase)` the payload IS the
   *  secret protecting everything beside it.
   *
   *  A listed action still occupies its slot — type, sequence, timestamp and
   *  the state paths it changed are kept, so ordering and replay structure are
   *  unaffected — but its payload and the before/after of what it wrote are
   *  replaced with `"[redacted]"`. A trailing `*` matches by prefix
   *  (`vault:*`), because a list of individual method names is the list that
   *  goes stale the day someone adds another one. */
  redactActions?: readonly string[];
  /** Allow the electron client to open CHILD windows to arbitrary http(s) URLs
   *  via `__aioIPC.openWindow(url, { preload, sandbox })`. OFF by default —
   *  child-window-to-arbitrary-URL is real attack surface no app should carry
   *  unless it asked for it (maintainer decision, a field report openWindow thread). */
  childWindows?: boolean;
  /** Internal: checkpoint restore callback passed from CellsConfig */
  _onCheckpointRestore?: (
    checkpoint: CheckpointData,
  ) => Record<string, unknown> | null;
  /** Internal: composed cell names — passed from CellsConfig for diagnostics */
  _cellNames?: string[];
  /** Internal: cell defs flagged `worker: true` (see src/server/cell-worker.ts). */
  _workerCells?: import("../state/cell-types.ts").CellDef[];
  /** Internal: health getter factory — passed from CellsConfig for diagnostics */
  _healthGetter?: (
    state: unknown,
  ) => Record<string, { errors: number; enabled: boolean }>;
  /** Internal: reduce breakdown getter — passed from CellsConfig via composeCells */
  _reduceBreakdown?: () => ReduceBreakdown | undefined;
  /** Internal: cell IDs that sync — `sync:` on the cell, or adopted by
   *  `localFirst` at compose time. Drives CRDT table init, KV exclusion, and
   *  the list the page shell hands the browser (which cannot derive a
   *  compose-time decision from the cell definitions). */
  _syncCellIds?: string[];
  /** Internal: per-cell version + migration hooks — for state migration on KV restore */
  _cellMigrations?: Map<
    string,
    {
      version: number;
      initialState: Record<string, unknown>;
      onMigrate?: (
        state: Record<string, unknown>,
        fromVersion: number,
      ) => Record<string, unknown>;
    }
  >;
  /** Internal: per-cell boot repair hooks (`onRestore` on a cell) — applied
   *  after restore + migration, before the app-level `onRestore`. */
  _cellRestores?: Map<
    string,
    (state: Record<string, unknown>) => Record<string, unknown> | void
  >;
  /** Internal: per-cell versions — flat map for persistence */
  _cellVersions?: Record<string, number>;
  /** Internal: built from per-cell persist filters (replaces removed stateForDB) */
  _getDBState?: (state: S) => unknown;
  /** Internal: built from per-cell ui filters (replaces removed stateForUI) */
  _getUIState?: (state: S, user?: AioUser) => unknown;
  /** Internal: per-cell patch strategy — determines patch vs full-state per cell */
  _cellPatchStrategies?: Map<string, CellPatchStrategy>;
  /** Internal: field sets for "filter" strategy cells */
  _cellFilterFields?: Map<string, PatchFilterFields>;
  /** Internal: per-cell declarative network-access rules (AUTH-1) */
  _cellAccess?: Map<string, import("../state/cell-types.ts").CellAccess>;
  _cellMethods?: Record<string, string[]>;
  /** Internal: per-cell, per-field { persisted, ui } flags — trojan `fields`. */
  _cellFields?: CellFieldFlags;
};

/** Cell id → state key → whether the field is persisted / exposed to the UI. */
export type CellFieldFlags = Record<
  string,
  Record<string, { persisted: boolean; ui: boolean }>
>;

/** Handle returned by aio.run() — dispatch actions, read state, or shut down */
export type AioApp<S = unknown, A = unknown> = {
  dispatch: (action: A) => Promise<unknown>;
  getState: () => S;
  snapshot?: () => string; // server-only (undefined in standalone)
  loadSnapshot?: (json: string) => void; // server-only (undefined in standalone)
  db?: DB; // async SQLite — query/execute/transaction (undefined in standalone)
  /** Content-addressed binary store (tier ③ — docs/persistence/big-data.md).
   *  put/stream/info/url/delete/list under `appDirs(appId).files/blobs/`;
   *  bytes are served over HTTP at `blobs.url(id)` (Range-capable, immutable
   *  caching) and NEVER ride the WS/UDS state channel. Undefined in
   *  standalone (no filesystem). Headless: `openBlobStore(appId)` from
   *  `aio/server` opens the same store. */
  blobs?: import("./blobs.ts").BlobStore;
  /** AUTH-1 session API — present when `sessions:` is enabled in aio.run().
   *  issue/get/refresh/revoke/revokeUser bearer-token sessions (SQLite). */
  sessions?: import("./sessions.ts").SessionStore;
  /** AUTH-2 user API — present when `auth:` is enabled. create/verify/
   *  setPassword/setRole password users (PBKDF2, SQLite). Use for seeding
   *  admins: `app.auth.create("root", pw, "admin")`. */
  auth?: import("./auth-users.ts").UserStore;
  close: () => Promise<void>;
  mode?: string; // 'standalone' in Android WebView builds — branch effects accordingly
  port?: number; // server port — available after aio.run(), useful for connectCli()
  /** v0.5 cell control API — only available when using cells-based config */
  cells?: {
    enable: (name: string) => void;
    disable: (name: string) => void;
    status: (name: string) => string | undefined;
    health: () => CellStatus[];
    list: () => string[];
  };
};

/** v0.5 cells-based config — pass to aio.run() instead of (initialState, config) */
export type CellsConfig = {
  /** Unique app identity — used for lock file, UDS socket, KV/SQLite paths,
   *  TLS cert dir. Default: deno.json `appId` > slug(`title`) > slug(`name`)
   *  > the main module's directory name. */
  appId?: string;
  /** Cells to run. Default: every `cell()` the entry (transitively) imported
   *  — they self-register, exactly like the standalone/android runtime. */
  cells?: import("../state/cell.ts").CellEntry[];
  /** Local-first execution (perfect-aio D3): every server cell runs its methods
   *  where the CALLER is — instantly, optimistically — and propagates the change
   *  as a CRDT op. The server stays the authority: it re-runs the same method
   *  against its own state and is the arbiter of truth, so guards and `validate`
   *  hooks are unchanged, and a refused op comes back explained (D11).
   *
   *  Mechanically it makes `sync: true` the default for every server cell; a
   *  cell opts out with `sync: false`, which is the right call for anything
   *  whose optimistic preview would be a lie (auth, payments, a ledger).
   *
   *  Opt-in while it earns field mileage — it changes WHERE your methods run.
   *  See docs/specs/2026-07-22-local-first.md. */
  localFirst?: boolean;
  /** Default persist and visibility config for all cells — individual cells
   *  override these. `visible` takes the FULL CellVisibility vocabulary
   *  (alpha52): include/exclude/"all"/"none" plus `forUser`/`publicFields`,
   *  so a per-user default view is expressible app-wide. */
  cellDefaults?: {
    visible?: import("../state/cell-types.ts").CellVisibility;
    /** @deprecated alpha52 — renamed `visible` (one-time hint; alias through
     *  beta; `aiol --safe-fix` renames it). */
    ui?: import("../state/cell-types.ts").CellVisibility;
    persist?: import("../state/cell-types.ts").CellFieldFilter;
  };
  port?: number;
  /** Bind address. Defaults to `127.0.0.1`, or `0.0.0.0` under `expose`.
   *
   *  It was allowlisted, forwarded by the config bridge and read by the
   *  server, appears in `aio doctor`'s printout, and is the example
   *  `docs/auth/auth.md` gives — but it was missing from THIS type, the one
   *  surface an app must compile against, so following the docs failed
   *  `deno task check`. Present in 2 of 3 surfaces is the trap this project
   *  keeps a gate for. */
  host?: string;
  /** Serve on 0.0.0.0 with TLS instead of loopback-only — the config twin of
   *  `--expose`. A compiled binary run by a service manager has no flags to
   *  pass, so "this app is a LAN server" has to be expressible in code.
   *  `--expose` on the command line still wins. Everything that keys off
   *  exposure (auth key, the `ui:"all"` privacy warning, TLS, the share URL)
   *  reads the SAME resolved value — see `_exposeOf` in aio.ts. */
  expose?: boolean;
  /** Transport security when exposed — the config twin of `--no-tls` /
   *  `--tls-cert`/`--tls-key`, so a COMPILED binary (a service unit has no
   *  shell flags) can declare how it serves.
   *
   *  - `"auto"` (default) — self-signed cert generated and reused per app.
   *  - `false` — plain HTTP/WS. Sound only behind a TLS-terminating proxy or
   *    when the payload is already end-to-end encrypted; it warns loudly.
   *  - `{ cert, key }` — your own PEM files (a real CA cert: the one shape
   *    every non-browser client accepts without extra trust configuration).
   *
   *  The CLI flags still win when both are given. Loopback is plain HTTP
   *  regardless — this only decides how an EXPOSED server serves. */
  tls?: "auto" | false | { cert: string; key: string };
  /** Where this app keeps everything it owns. Default `~/.<appId>` — `data/`
   *  inside it is the whole backup; `logs/` and `launch.json` are disposable.
   *  This is the AUTHOR's choice; whoever runs the app can move every app at
   *  once with `AIO_APPS_DIR=<root>` (→ `<root>/<appId>`).
   *  See docs/persistence/where-files-live.md. */
  appDir?: string;
  /** Override the SQLite file (":memory:" for hermetic tests). */
  dbPath?: string;
  /** PRAGMAs for the app db (default: WAL + synchronous=NORMAL). A wallet or
   *  ledger wants `PRAGMA synchronous = FULL`; a cache does not. */
  dbPragmas?: string[];
  /** Check the app database's integrity at boot (`PRAGMA quick_check`).
   *
   *  On a damaged file: the file is QUARANTINED beside itself with a timestamp
   *  (never deleted), and if a `<db>.snapshot` sits next to it the app boots on
   *  that instead — each branch reported loudly, including what was lost. Off
   *  by default: it costs a scan on every boot and only apps holding data a
   *  user would miss need it. Take the snapshots it restores from with
   *  `db.snapshot(path)`. */
  checkIntegrityOnBoot?: boolean;
  /** Keep this app up to date from a release source.
   *
   *  A bare URL is the whole configuration; the object form adds the switches
   *  a default cannot decide for you:
   *
   *  ```ts
   *  updates: "https://releases.example.com/wallet"      // published artifacts
   *  updates: "https://github.com/you/app"               // the repo itself
   *  updates: { source, auto: true }                     // unattended service
   *  ```
   *
   *  Omitted ⇒ nothing polls, nothing is registered, nothing ships. An update
   *  is only ever OFFERED when the release can migrate the data already on
   *  disk — see docs/deploy/updates.md. */
  updates?: import("./updates-core.ts").UpdatesInput;
  /** Capture problem reports — what is running, what state it was in, what had
   *  just happened, and the recent log — into `<data>/reports/`.
   *
   *  `true` is the whole configuration: user reports via the `feedback` cell,
   *  plus automatic capture when the app breaks. `{ url }` also POSTs them;
   *  `{ sink }` hands them anywhere else. Reports honour the SAME `redactActions`
   *  rule as the journal and the timeline. See docs/debugging/feedback.md. */
  feedback?: import("./feedback-boot.ts").FeedbackInput;
  persist?: boolean;
  persistKey?: string;
  persistDebounceMs?: number;
  persistMode?: "single" | "multi";
  ui?: UiConfig;
  baseDir?: string;
  /** Extra read-only dev-server roots — see CellsConfig.serveDirs. */
  serveDirs?: Record<string, string>;
  client?: "electron" | "browser" | "cli" | "server-only";
  keepServer?: boolean;
  transport?: "uds" | "ws" | "auto";
  killExisting?: boolean;
  serverUrl?: string;
  users?: Record<string, AioUser>;
  /** --expose auth (see CellsConfig.key). */
  key?: string | boolean;
  resolveUser?: ResolveUserFn;
  /** AUTH-1: enable the SQLite session store (see AioConfig.sessions). */
  sessions?: boolean | { ttlMs?: number };
  /** AUTH-2/3: built-in password auth (see AioConfig.auth). */
  auth?: boolean | AuthOptions;
  db?: Record<string, TableDef>;
  perfCheck?: "on" | "off";
  perfBudget?: PerfBudget;
  /** Client render-staleness / pending-patch thresholds — sent to the browser
   *  (page shell + `cfg` frame). Was accepted by the option validator but
   *  missing from this type AND dropped by the bridge; all three now agree. */
  renderBudget?: import("../vitals/types.ts").RenderBudget;
  effectTimeoutMs?: number;
  freezeState?: boolean;
  memory?: MemoryConfig; // memory pressure monitoring config
  circuitBreaker?: CircuitBreakerConfig; // auto-disable cells after N errors
  singleton?: boolean;
  /** Fail boot loudly if a cell was defined (imported → cell() ran) but not
   *  passed to `aio.run({ cells })` — its dispatches would be silent no-ops
   *  (green tests, dead feature). Opt-in because the global cell registry
   *  accumulates across a process, so a default-on check would false-fire on the
   *  supported disjoint-multi-app pattern. a field report Bad #2. */
  strictCells?: boolean;
  /** Supervised runtime: an unhandled promise rejection (a fire-and-forget cell
   *  dispatch that rejects, a floating `void poll()` on a schedule path) is
   *  logged loudly, checkpointed and the process SURVIVES — no hand-written
   *  `.catch(() => {})` per dispatch.
   *
   *  **Default `true` since alpha61.** It shipped opt-in (a field report asked
   *  for it), and the next field report — a wallet — was still wrapping every
   *  schedule callsite in try/catch AND `.catch(()=>{})` because a stray
   *  rejection took the process down mid-signing. For a long-running server
   *  that owns persisted state, death from one floating promise is the worst
   *  outcome available; a loud log + emergency checkpoint is the loud one.
   *  Scoped to rejections — a synchronous uncaught throw is a hard fault and
   *  stays fatal. Set `false` for fail-fast under a supervisor that restarts
   *  you on purpose. */
  guardDispatches?: boolean;
  /** Durable action journal: every committed action is appended to
   *  a durable log; on the next boot the actions after the last snapshot are
   *  replayed on top of it, so a SIGKILL / power cut in the persist debounce
   *  window loses NOTHING. Opt-in. */
  journal?: boolean;
  /** Action types whose recorded VALUES must never be retained anywhere: the
   *  durable journal, the in-memory timeline (`am timeline`) and the optional
   *  action log all honour this one list. An action's payload is its arguments,
   *  so for a method like `vault:unlockWith(passphrase)` the payload IS the
   *  secret protecting everything beside it.
   *
   *  A listed action still occupies its slot — type, sequence, timestamp and
   *  the state paths it changed are kept, so ordering and replay structure are
   *  unaffected — but its payload and the before/after of what it wrote are
   *  replaced with `"[redacted]"`. A trailing `*` matches by prefix
   *  (`vault:*`), because a list of individual method names is the list that
   *  goes stale the day someone adds another one. */
  redactActions?: readonly string[];
  /** Allow the electron client to open CHILD windows to arbitrary http(s) URLs
   *  via `__aioIPC.openWindow(url, { preload, sandbox })`. OFF by default —
   *  child-window-to-arbitrary-URL is real attack surface no app should carry
   *  unless it asked for it (maintainer decision, a field report openWindow thread). */
  childWindows?: boolean;
  libraryMode?: boolean; // no exit/signals/lock; app.close() leaves process alive
  syncIntervalMs?: number;
  fullStateThreshold?: number;
  /** Custom HTTP routes — exact path or "/prefix/*" wildcard → handler. The
   *  escape hatch for uploads, webhooks, and API endpoints that don't belong
   *  in the state channel. Reserved: /__aio and /ws. */
  routes?: Record<string, import("./route.ts").RawRouteHandler>;
  maxConnections?: number;
  /** Per-client WebSocket safety limits (advanced; defaults are hardened). */
  wsLimits?: WsLimits;
  /** Extra allowed WS origins beyond localhost + own host (reverse proxy, custom domains). */
  allowedOrigins?: string[];
  /** --expose hardening: require an Origin header on WS upgrade. */
  strictOrigin?: boolean;
  trustProxyHeader?: string;
  schedules?: ScheduleDef[];
  /** Application version string — logged on startup, available at __aio.appVersion */
  /** App version — default: deno.json `version`. */
  appVersion?: string;
  /** Isolate cells — only these cells are active (dev mode convenience) */
  isolate?: string[];
  beforeReduce?: (
    action: unknown,
    state: unknown,
    user?: AioUser,
  ) => unknown | null;
  onAction?: (action: unknown, state: unknown, user?: AioUser) => void;
  onEffect?: (effect: unknown, state: unknown, user?: AioUser) => void;
  onConnect?: (user?: AioUser) => void;
  onDisconnect?: (user?: AioUser) => void;
  onStart?: (app: AioApp) => void;
  fatalOnStart?: boolean;
  onStop?: () => void;
  onError?: (error: AioError) => void;
  onRestore?: (state: unknown) => unknown;
  /** Structured logging — app.log (narrative), debug.log (all), error.log (errors), warning.log (warnings), perf.log (violations).
   *  Enabled by default. Set `false` to disable. Pass LogConfig to customize. */
  logging?: boolean | LogConfig;
  /** Diagnostics module — state diffs, action log, checkpoint, crash handler.
   *  Default: dev=full visibility, prod=lean. Set `false` to disable entirely. */
  diagnostics?: DiagnosticsConfig;
  /** Dispatch-storm guard — warns when one action type sustains a runaway
   *  dispatch rate (default: >200/s for 5s), naming the feedback loop instead
   *  of leaving downstream symptoms (log churn, perf noise, starved server).
   *  `{ breaker: true }` also drops the offending action while the storm
   *  lasts. Set `false` to disable. */
  dispatchStorm?: boolean | StormConfig;
  /** Callback when a diagnostics checkpoint is found on startup.
   *  Receives full CheckpointData. Return state to restore, or null to start fresh. */
  onCheckpointRestore?: (
    checkpoint: CheckpointData,
  ) => Record<string, unknown> | null;
};
