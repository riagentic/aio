import { log } from "../diagnostics/logger-api.ts";
import { inertAllowlistEntries } from "./server-auth.ts";
import { MAX_SESSION_TTL_MS } from "./sessions.ts";
import { teachMessage } from "../diagnostics/error.ts";
import {
  hasBothFilterModes,
  namesNoFilterMode,
  nearestOf,
  unusableFilterConsequence,
  unusableFilterList,
} from "../state/cell-helpers.ts";
import { classifySource } from "./updates-core.ts";
import { declaredMaxHeapOf } from "./heap-policy.ts";
import { type Removal, removalsInDenoJson } from "../state/removals.ts";

// Runtime config validation & documentation — extracted from aio.ts (AIO-52)
// Types are erased at runtime. These sets are the runtime source of truth.
// If you add a key to AioConfig, CellsConfig, or UiConfig — add it here too.

export const VALID_UI_KEYS = new Set<string>([
  "title",
  "width",
  "height",
  "showStatus",
  "renderer",
  "entry", // AIO-8.1: UI entry file override — typed on UiConfig, served by the dev server
  "viewport", // AIO-423: override the <meta viewport> (string) or opt out (false)
  "head", // AIO-423: verbatim extra <head> content (meta/OG/favicon/fonts)
  "lang", // <html lang> — WCAG 3.1.1; default "en"
  "dir", // <html dir> — "ltr" | "rtl" | "auto"; mirrors the whole default UI
  "chrome", // desktop window frame: "standard" | "themed" | "none"
  "theme", // the default look: "tokens" (default) | "auto" | "full" | "none"
  "layout", // false → style ELEMENTS, emit no page layout (see UiConfig.layout)
  "tray", // Electron system tray: true | { tooltip, menu, closeToTray } (see UiConfig.tray)
]);

/** Top-level `deno.json` keys aio actually READS (its own + Deno's).
 *
 *  Everything else at that level is inert as far as aio is concerned — which
 *  is fine for another tool's config and a silent trap for a key that looks
 *  exactly like aio's own. A field report put `ui: { width, height }` there,
 *  got no error and no effect, and lost time to it: "silently ignoring input
 *  is the worst available behaviour". See {@link misplacedDenoJsonKeys}. */
export const DENO_JSON_READ_KEYS = new Set<string>([
  "share", // a declared workspace share (see app-dirs.ts resolveShare)
  // aio's
  "appId",
  "title",
  "client", // (its pre-alpha52 spelling `target` is a removals.ts row —
  //           read only to refuse/log it, see `retiredDenoJsonKeys`)
  "entry",
  "build",
  "version",
  // A BUILD fact: it tells `compile` which directories to embed in the
  // binary, and `build-compile.ts` reads it from here. The SERVER takes its
  // mounts from `aio.run({ assets })` instead — so this key is not misplaced,
  // and scolding it sent the `--template=assets` scaffold chasing a warning
  // about the one line that was right.
  "assets",
  // Deno's own
  "name",
  "exports",
  "imports",
  "scopes",
  "tasks",
  "compilerOptions",
  "lint",
  "fmt",
  "test",
  "bench",
  "publish",
  "license",
  "nodeModulesDir",
  "unstable",
  "workspace",
  "exclude",
  "include",
  "patch",
  "vendor",
  "lock",
  "$schema",
]);

/** Top-level deno.json keys the framework REMOVED and this file still
 *  carries (`target`, alpha70). Pure — the caller applies the registry's
 *  dev/prod split (`refuseRetired`): dev throws, prod logs and honours. */
export function retiredDenoJsonKeys(
  denoJson: Record<string, unknown> | undefined,
): readonly Removal[] {
  return removalsInDenoJson(denoJson);
}

/** aio-shaped keys sitting at the TOP LEVEL of deno.json, where they do
 *  nothing. Pure — the caller warns.
 *
 *  Deliberately narrow: only a key aio would recognise inside `aio.run()`
 *  counts, so another tool's section in the same file is never scolded. */
export function misplacedDenoJsonKeys(
  denoJson: Record<string, unknown> | undefined,
): string[] {
  if (!denoJson) return [];
  // `memory: { maxHeap }` is the one exception, and it is not a special case:
  // it is a LAUNCH fact, like `build` and `assets`. `build-compile.ts` reads it
  // from exactly here to bake a compiled binary's V8 ceiling, and `am start`
  // reads it from here to size a `deno run`. Calling it inert was false — and
  // worse than false: the advice it gave ("move it into aio.run({ memory })")
  // leads to `validateMemoryConfig` THROWING on `maxHeap`, because that block
  // is the pressure monitor. A field report met both halves at once. The rest
  // of `memory: {}` is still the monitor's and is still reported here.
  const readsMaxHeap = declaredMaxHeapOf(denoJson) !== undefined;
  return Object.keys(denoJson).filter((k) =>
    !(k === "memory" && readsMaxHeap) &&
    !DENO_JSON_READ_KEYS.has(k) &&
    // …including a `ui` key written FLAT at the top level (`"theme": "auto"`,
    // `"chrome": "themed"`, `"width": 900`). The reported case was the whole
    // `ui: {…}` object; the flattened spelling is the same mistake one step
    // further, and was just as inert and just as silent.
    (VALID_AIO_CONFIG_KEYS.has(k) || VALID_FEATURES_CONFIG_KEYS.has(k) ||
      VALID_UI_KEYS.has(k) || k === "ui")
  );
}

/** Keys aio reads inside the `build: {}` block of an app's deno.json.
 *
 *  The ONLY aio config object with no typo gate. `aio.run({...})` exits on an
 *  unknown key, `cell({...})` refuses one with a did-you-mean, `ui: {}` is
 *  allowlisted — and `build: { target: [...] }` (singular) built the default
 *  target set and said nothing, which reads as `--targets` being broken rather
 *  than the key being misspelled.
 *
 *  Readers: `normalizeTargets` (targets/platforms) and `build-config.ts`
 *  (out/server/ui). A key added there belongs here. */
export const VALID_BUILD_KEYS = new Set<string>([
  "targets", // string[] | Record<label, { kind, entry, ui, name, platforms }>
  "platforms", // OS/arch list, e.g. ["linux-x64", "darwin-arm64"]
  "out", // output directory (default: dist/)
  "server", // LAN/remote address a shipped CLIENT defaults to
  "ui", // UI component path override, relative to the app dir
  // Read by `v8FlagsArg` (build-compile.ts documents this as THE place to
  // declare V8 flags, and for a COMPILED binary it is the only channel for a
  // heap ceiling — the flag cannot be raised at run time).
  "v8Flags",
  // The app's own CSS toolchain (Tailwind, PostCSS, Sass) — a command that
  // writes `style.css`, run before the stylesheet is read in a build and
  // before every dev reload. Read by `cssBuildStep` (build/build-css.ts).
  // aio already made this cheap: the generated theme steps fully aside the
  // moment `style.css` exists, and Tailwind's output IS a `style.css`, so the
  // architecture accommodated it long before the ergonomics did.
  "css",
  // Read by `shipApp` and `am publish`: the release channel this build is
  // stamped with. The stamp outranks the config literal at run time, which is
  // what stops a test build updating itself into the public release.
  "channel",
]);

/** Keys a target override may carry in the object form of `build.targets`. */
export const VALID_BUILD_TARGET_KEYS = new Set<string>([
  "kind",
  "entry",
  "ui",
  "name",
  "platforms",
]);

/** Unknown keys in a deno.json `build: {}` block (and in each object-form
 *  target override), already phrased with a did-you-mean. Pure — the caller
 *  reports. Returns `[]` for a missing or non-object block, which is the
 *  normal case: `build` is optional. */
export function unknownBuildKeys(build: unknown): string[] {
  if (!build || typeof build !== "object" || Array.isArray(build)) return [];
  const say = (path: string, key: string, valid: Set<string>) => {
    const near = nearestOf(key, valid);
    return `${path}${key}${near ? ` (did you mean "${near}"?)` : ""}`;
  };
  const out: string[] = [];
  for (const k of Object.keys(build as Record<string, unknown>)) {
    if (!VALID_BUILD_KEYS.has(k)) out.push(say("build.", k, VALID_BUILD_KEYS));
  }
  // …and inside the object form of `targets`, where a misspelled `entry` is
  // the same class of silence one level deeper: the target builds, from the
  // wrong module.
  const targets = (build as { targets?: unknown }).targets;
  if (targets && typeof targets === "object" && !Array.isArray(targets)) {
    for (
      const [label, o] of Object.entries(targets as Record<string, unknown>)
    ) {
      if (!o || typeof o !== "object" || Array.isArray(o)) continue;
      for (const k of Object.keys(o as Record<string, unknown>)) {
        if (!VALID_BUILD_TARGET_KEYS.has(k)) {
          out.push(say(`build.targets.${label}.`, k, VALID_BUILD_TARGET_KEYS));
        }
      }
    }
  }
  return out;
}

export const VALID_AIO_CONFIG_KEYS = new Set<string>([
  "appId",
  "reduce",
  "execute",
  "persist",
  "fullStateThreshold",
  "routes",
  "syncIntervalMs",
  "maxConnections",
  "appFlags",
  "allowedOrigins",
  "security",
  "plugins",
  "strictOrigin",
  "trustProxyHeader",
  "wsLimits",
  "fatalOnStart",
  "dispatchStorm",
  "beforeReduce",
  "persistKey",
  "dbPath",
  "appDir",
  "dbPragmas",
  "checkIntegrityOnBoot",
  "persistDebounceMs",
  "persistMode",
  "users",
  "key",
  "resolveUser",
  "sessions",
  "auth",
  "ui",
  "port",
  "expose",
  "tls",
  "host",
  "updates",
  "feedback",
  "baseDir",
  "serveDirs",
  "assets", // read-only dirs served in dev AND prod (see CellsConfig.assets)
  "client",
  "keepServer",
  "transport",
  "takeover",
  "serverUrl",
  "schedules",
  "db",
  "perfCheck",
  "perfBudget",
  "budgets",
  "watch",
  "renderBudget",
  "effectTimeoutMs",
  "freezeState",
  "memory",
  "circuitBreaker",
  "onRestore",
  "singleton",
  "strictCells",
  "guardDispatches",
  "journal",
  "refusalsReject",
  "redactActions",
  "childWindows",
  "electron",
  "onAction",
  "onEffect",
  "onConnect",
  "onDisconnect",
  "onStart",
  "onStopping",
  "onStop",
  "onError",
  "libraryMode",
  // internal keys (prefixed with _)
  "_onScheduleReady",
  "_diagnostics",
  "_onCheckpointRestore",
  "_cellNames",
  "_pluginNames",
  "_refusalsReject",
  "_workerCells",
  "_workerEntry",
  "_healthGetter",
  "_reduceBreakdown",
  "_onReportOptsReady",
  "_syncCellIds",
  "_syncRetentionMs",
  "_persistingCellIds",
  "_getDBState",
  "_getUIState",
  "_cellPatchStrategies",
  "_cellFilterFields",
  "_cellAccess",
  "_cellMethods",
  "_cellAsyncMethods",
  "_cellMethodArity",
  "_cellFields",
  "_cellVisible",
  "_cellPersist",
  "_cellPersistShaped",
  "_cellMigrations",
  "_cellRestores",
  "_cellVersions",
]);

export const VALID_FEATURES_CONFIG_KEYS = new Set<string>([
  "appId",
  "cells",
  "cellDefaults",
  "localFirst",
  "port",
  "expose",
  "tls",
  "host",
  "updates",
  "feedback",
  "persist",
  "persistKey",
  "dbPath",
  "appDir",
  "dbPragmas",
  "checkIntegrityOnBoot",
  "persistDebounceMs",
  "persistMode",
  "ui",
  "baseDir",
  "serveDirs",
  "assets", // read-only dirs served in dev AND prod (see CellsConfig.assets)
  "client",
  "keepServer",
  "transport",
  "takeover",
  "serverUrl",
  "users",
  "key",
  "resolveUser",
  "sessions",
  "auth",
  "db",
  "perfCheck",
  "perfBudget",
  "budgets",
  "watch",
  "renderBudget",
  "effectTimeoutMs",
  "freezeState",
  "memory",
  "circuitBreaker",
  "singleton",
  "strictCells",
  "guardDispatches",
  "journal",
  "refusalsReject",
  "redactActions",
  "childWindows",
  "electron",
  "libraryMode",
  "_workerEntry", // internal: testServer({ workers: "real" })
  "syncIntervalMs",
  "fullStateThreshold",
  "routes",
  "maxConnections",
  "appFlags",
  "schedules",
  "wsLimits",
  "allowedOrigins",
  "security",
  "plugins",
  "_pluginNames",
  "strictOrigin",
  "trustProxyHeader",
  "fatalOnStart",
  "dispatchStorm",
  "isolate",
  "beforeReduce",
  "onAction",
  "onEffect",
  "onConnect",
  "onDisconnect",
  "onStart",
  "onStopping",
  "onStop",
  "onError",
  "onRestore",
  "logging",
  "diagnostics",
  "onCheckpointRestore",
]);

/** [default, description] per config key. Exported for the docs-completeness
 *  gate (tests/config-docs.test.ts): every public allowlisted key must have a
 *  row here AND be printed by formatValidConfig(), so a new option cannot ship
 *  undocumented in the "Valid configuration" help table. */
export const CONFIG_DOCS: Record<string, [string, string]> = {
  feedback: [
    "off",
    "capture problem reports into <data>/reports/ — true, or { auto, url, sink, keep }",
  ],
  updates: [
    "off",
    'release source URL ("https://…" / "file://…" / a git repo) — or { source, kind, auto, check, channel, key, keys, canApply, allowUnsigned, prerelease }',
  ],
  appId: ["", "unique app identity — lock file, UDS socket, KV/SQLite paths"],
  cells: ["", "cell definitions array"],
  serveDirs: [
    "",
    'extra READ-ONLY dev-server roots by URL prefix ({"/shared":"../core/lib"}) — dev only; prod bundles follow relative imports',
  ],
  assets: [
    "",
    'READ-ONLY directories this app SERVES, by URL prefix ({"/media":"./media"}) — dev AND prod, every baseDir guard, and declared in deno.json the build embeds them in the binary',
  ],
  localFirst: [
    "false",
    "run every server cell's methods locally + sync as CRDT ops (per-cell opt-out with sync:false)",
  ],
  reduce: ["", "state reducer (legacy API)"],
  execute: ["", "effect executor (legacy API)"],
  persist: ["true", "persist state to SQLite (state.db)"],
  persistKey: ['"state"', "KV key prefix"],
  dbPath: [
    "<appDir>/data/state.db",
    'override the SQLite file (":memory:" for tests)',
  ],
  appDir: [
    "~/.<appId>",
    "where this app keeps everything it owns (data/, logs/, dist/) — the author's choice; AIO_APPS_DIR moves all apps",
  ],
  dbPragmas: ["", "extra SQLite PRAGMAs applied on open"],
  checkIntegrityOnBoot: [
    "false",
    "PRAGMA quick_check on boot; auto-restore the newest db.snapshot() on corruption",
  ],
  persistDebounceMs: ["100", "ms between KV writes"],
  persistMode: [
    '"single"',
    '"single" (one JSON blob) or "multi" (one SQLite row per top-level cell — rewrites only changed cells)',
  ],
  port: [
    "a free one",
    "HTTP/WS server port — unset means the runtime picks a free port (nothing binds 8000 by default); $AIO_PORT and --port win over this",
  ],
  tls: [
    '"auto"',
    '"auto" | false | { cert, key } — how an EXPOSED server serves (same as --no-tls / --tls-cert/--tls-key; the flags win)',
  ],
  expose: [
    "false",
    "serve on 0.0.0.0 + TLS for LAN access (same as --expose; the flag wins)",
  ],
  host: [
    "undefined",
    "bind ONE address instead of the expose default (same as --host=; the flag wins)",
  ],
  baseDir: [
    "main module's dir",
    "source directory the dev server serves (a compiled binary falls back to <cwd>/src)",
  ],
  client: ['"electron"', '"electron" | "browser" | "cli" | "server-only"'],
  keepServer: ["false", "keep server running after client closes"],
  transport: ['"auto"', '"uds" | "ws" | "auto" — IPC transport'],
  takeover: ["false", "kill the running instance and take its lock"],
  serverUrl: ["", "connect to remote server instead of starting one"],
  singleton: ["true", "refuse to start if already running"],
  syncIntervalMs: [
    "50",
    "max 1 state push per N ms (0 = microtask coalescing only)",
  ],
  fullStateThreshold: [
    "0.5",
    "patch JSON bytes / full-state JSON bytes above which the full state is sent",
  ],
  routes: [
    "",
    'custom HTTP routes — "/path" or "/prefix/*" → handler (uploads, webhooks)',
  ],
  maxConnections: ["100", "max concurrent WebSocket clients"],
  appFlags: [
    "",
    "flags THIS app answers itself — declared so aio passes them through " +
    'instead of refusing them as unknown (e.g. ["--sync", "--user="])',
  ],
  allowedOrigins: [
    "",
    "extra hosts/origins this app may be reached as — the WS Origin check AND the Host (DNS-rebinding) gate read this one list",
  ],
  plugins: [
    "[]",
    "reusable pieces of app — each contributes cells, routes, schedules and observe-only hooks through the same keys this config has; the app's own values win, and two plugins claiming one route throw at boot naming both",
  ],
  security: [
    "{}",
    "response hardening + transfer encoding — { headers, csp, frameOptions, referrerPolicy, hsts, permissionsPolicy, compress }; every default is chosen so an app that omits this behaves exactly as before",
  ],
  strictOrigin: ["false", "require Origin header on WS upgrade in expose mode"],
  trustProxyHeader: [
    "",
    'behind a trusted reverse proxy: read the real client IP from this header\'s RIGHTMOST hop (e.g. "x-forwarded-for") for lockout/abuse bucketing',
  ],
  wsLimits: [
    "hardened",
    "per-client WS rate/size limits (advanced — defaults are hardened)",
  ],
  beforeReduce: ["", "intercept actions before reduce — return null to drop"],
  cellDefaults: [
    "",
    "default visible/persist config for all cells (visible takes full CellVisibility incl. forUser) — individual cells override; `ui` is the deprecated alias of visible",
  ],
  fatalOnStart: [
    "false",
    "exit the process when the onStart hook throws (default: log and continue)",
  ],
  dispatchStorm: [
    "true",
    "dispatch feedback-loop detector — object to tune, breaker to auto-drop, false to disable",
  ],
  strictCells: [
    "false",
    "fail boot if a defined cell was not passed to aio.run({ cells }) — its dispatches would be silent no-ops",
  ],
  guardDispatches: [
    "true",
    "supervised runtime — an unhandled rejection is logged loudly and the process survives (false = fail-fast for supervisor-managed deployments)",
  ],
  journal: [
    "false",
    "durable action journal — replay the persist-debounce tail after SIGKILL/power cut",
  ],
  refusalsReject: [
    "false",
    "a write the reduce REFUSED rejects `await cell.method()` in process, the way the wire already answers it (ACTION_REFUSED)",
  ],
  redactActions: [
    "",
    'action types whose payload is "[redacted]" in journal/diagnostics/timeline (trailing * = prefix match)',
  ],
  childWindows: [
    "false",
    "allow Electron child windows via __aioIPC.openWindow (off — real attack surface)",
  ],
  electron: [
    "{}",
    "the Electron process's own security decisions — { requireSandbox } refuses to launch rather than fall back to --no-sandbox, { unsandboxedChildWindows } lets openWindow ask for sandbox:false; both default to what aio has always done",
  ],
  libraryMode: [
    "false",
    "no exit/signals/instance lock; app.close() leaves the process alive (embedding, tests)",
  ],
  renderBudget: [
    "",
    "client render staleness/patch thresholds (sent to browser) — see sub-keys",
  ],
  ui: ["", "window + page-shell config — see the UI table below"],
  users: ["", "static token→user map for auth"],
  key: [
    "omitted",
    "--expose auth key: string=fixed, true=generated+persisted; omitted defaults to a generated key when exposed without per-user auth (alpha52); false=OPEN (explicit opt-out)",
  ],
  resolveUser: [
    "",
    "dynamic (token,state)→user hook for runtime auth (AIO-171)",
  ],
  sessions: [
    "",
    "SQLite session store — app.sessions.issue/revoke bearer tokens with TTL",
  ],
  auth: [
    "",
    "built-in password auth — /__aio/auth/* signup/login/logout, PBKDF2 users, session cookie",
  ],
  db: ["", "SQLite table definitions — arrays auto-sync"],
  perfCheck: ['"on"', "enable/disable performance violation reporting"],
  perfBudget: ["", "override default budgets (reduce: 100ms, effect: 5ms)"],
  budgets: [
    "",
    'declared limits — { cellState: "1MB", broadcastRate: "20/s" }',
  ],
  watch: [
    "",
    'live reload: false turns it off, ["src/ui"] narrows what is watched',
  ],
  "renderBudget.staleness": [
    "300",
    "ms — primary staleness threshold (sent to browser)",
  ],
  "renderBudget.pendingPatches": [
    "10",
    "max pending patches before warning (sent to browser)",
  ],
  effectTimeoutMs: [
    "30000",
    "how long an async method may run before the framework stops waiting (ms; 0 = forever). Bounds the effect AND `await cell.method()`; never cancels the method",
  ],
  freezeState: [
    "dev:true",
    "deep freeze state after reduce to catch mutations",
  ],
  memory: ["", "memory pressure monitoring config"],
  circuitBreaker: ["", "auto-disable cells after N errors"],
  diagnostics: ["auto", "state diffs, action log, checkpoint, crash handler"],
  logging: ["true", "structured logging — false to disable"],
  schedules: ["", "static scheduled effects — started on boot"],
  isolate: ["", "run only these cells (dev convenience)"],
  onAction: ["", "called after every action"],
  onEffect: ["", "called after every effect — (effect, state, user)"],
  onConnect: ["", "called when client connects"],
  onDisconnect: ["", "called when client disconnects"],
  onStart: ["", "called after server starts"],
  onStopping: ["", "called BEFORE dispatch closes — quiesce your producers"],
  onStop: ["", "called on shutdown"],
  onError: ["", "called on framework error"],
  onRestore: ["", "transform state after restore, before server starts"],
  onCheckpointRestore: ["", "handle diagnostics checkpoint on startup"],
};

/** [default, description] per `ui: {}` key — same completeness gate as
 *  CONFIG_DOCS (every VALID_UI_KEYS entry must have a row). */
export const UI_DOCS: Record<string, [string, string]> = {
  lang: ['"en"', "<html lang> — the document language (WCAG 3.1.1)"],
  dir: [
    "",
    '<html dir> — "ltr" | "rtl" | "auto". Every stylesheet aio ships is written in logical properties, so this one attribute mirrors the whole default UI. Not derived from lang: guessing "ar => rtl" mirrors an app that ships Arabic content in an LTR chrome',
  ],
  title: ['"AIO App"', "window title"],
  width: ["800", "window width (px)"],
  height: ["600", "window height (px)"],
  showStatus: ["true", "show connection status indicator"],
  renderer: ['"aio"', "accepted for compat — AIR is the only renderer"],
  entry: ['"App.tsx"', "UI entry file, relative to baseDir"],
  viewport: [
    "responsive",
    "<meta viewport> content override (false = omit it)",
  ],
  head: ["", "verbatim extra <head> content (meta/OG/favicon/fonts)"],
  chrome: [
    '"standard"',
    'desktop window frame: "standard" | "themed" | "none"',
  ],
  theme: [
    '"tokens"',
    'default stylesheet — "tokens" (variables only, nothing paints) | "auto" (steps aside for your style.css) | "full" (keep it alongside yours) | "none"',
  ],
  layout: [
    "true",
    'false → style ELEMENTS only (canvas, type, forms, tables, focus rings) and emit NO layout: no <main> page container, none of .card/.row/.stack/.grid/.muted/.badge. Composes with theme "auto"/"full"; warns on "tokens"/"none", which paint nothing',
  ],
  tray: [
    "false",
    'Electron system tray: true (icon + Show/Hide/Quit) | { tooltip, menu: [{ label, method: "cell:m", args, route } | "-"], closeToTray }. Browser/Android: no tray, no error',
  ],
};

/** Keys printed in the IDENTITY table (see formatValidConfig). */
export const IDENTITY_KEYS = ["appId", "cells"] as const;

/** The printed help-table groups. Exported for the docs-completeness gate:
 *  IDENTITY_KEYS + these groups + the UI table are exactly what
 *  formatValidConfig() prints, so the gate can prove every allowlisted key
 *  appears once and only once. */
export const CONFIG_GROUPS: [string, string[]][] = [
  ["Server & transport", [
    "port",
    "expose",
    "tls",
    "host",
    "updates",
    "feedback",
    "baseDir",
    "serveDirs",
    "assets",
    "client",
    "keepServer",
    "transport",
    "takeover",
    "serverUrl",
    "singleton",
    "libraryMode",
    "syncIntervalMs",
    "fullStateThreshold",
    "routes",
    "maxConnections",
    "appFlags",
    "wsLimits",
    "allowedOrigins",
    "security",
    "plugins",
    "strictOrigin",
    "trustProxyHeader",
    "childWindows",
    "electron",
    "ui",
  ]],
  ["Auth", [
    "users",
    "key",
    "resolveUser",
    "sessions",
    "auth",
  ]],
  ["App logic", [
    "beforeReduce",
    "isolate",
    "localFirst",
    "cellDefaults",
    "strictCells",
    "guardDispatches",
    "persist",
    "persistKey",
    "dbPath",
    "appDir",
    "dbPragmas",
    "checkIntegrityOnBoot",
    "persistDebounceMs",
    "persistMode",
    "journal",
    "refusalsReject",
    "redactActions",
    "onRestore",
    "db",
    "schedules",
    "fatalOnStart",
    "onAction",
    "onEffect",
    "onConnect",
    "onDisconnect",
    "onStart",
    "onStopping",
    "onStop",
    "onError",
    "onCheckpointRestore",
  ]],
  ["Performance & monitoring", [
    "perfCheck",
    "perfBudget",
    "budgets",
    "watch",
    "renderBudget",
    "renderBudget.staleness",
    "renderBudget.pendingPatches",
    "effectTimeoutMs",
    "freezeState",
    "memory",
    "circuitBreaker",
    "dispatchStorm",
    "diagnostics",
    "logging",
  ]],
];

export function formatValidConfig(): string {
  const uiKeys = [...VALID_UI_KEYS].sort();
  const pad = (s: string, len: number) =>
    s + " ".repeat(Math.max(0, len - s.length));

  function table(
    title: string,
    keys: string[],
    docs: Record<string, [string, string]>,
  ): string[] {
    let nameW = 4, defW = 7;
    for (const k of keys) {
      const d = docs[k];
      nameW = Math.max(nameW, k.length);
      if (d?.[0]) defW = Math.max(defW, d[0].length);
    }
    const lines: string[] = [];
    lines.push(`  ${title}`);
    lines.push(`  ${pad("Name", nameW)}  ${pad("Default", defW)}  Description`);
    lines.push(
      `  ${"─".repeat(nameW)}  ${"─".repeat(defW)}  ${"─".repeat(30)}`,
    );
    for (const k of keys) {
      const d = docs[k];
      const def = d?.[0] || "—";
      const desc = d?.[1] || "";
      lines.push(`  ${pad(k, nameW)}  ${pad(def, defW)}  ${desc}`);
    }
    return lines;
  }

  const lines: string[] = [];
  lines.push("aio.run({");
  lines.push("");
  lines.push(
    ...table(
      "IDENTITY (all inferred when omitted — deno.json / cell registry)",
      [...IDENTITY_KEYS],
      CONFIG_DOCS,
    ),
  );
  for (const [group, keys] of CONFIG_GROUPS) {
    lines.push("");
    lines.push(
      ...table(`${group.toUpperCase()} (optional)`, keys, CONFIG_DOCS),
    );
  }
  lines.push("");
  lines.push(...table("UI (optional) — ui: { ... }", uiKeys, UI_DOCS));
  lines.push("");
  lines.push("})");
  return lines.join("\n");
}

/** Config keys whose value must be a FUNCTION.
 *
 *  A hook that never runs is invisible. `onStart: mod.bootUP` — one letter off,
 *  so `undefined` — booted an app that reported `"status": "healthy"` while the
 *  startup work it names never happened, and NOTHING was logged, at boot or
 *  after. The route fix (server.ts) is the same shape one surface over; this is
 *  the shape for every function-valued key.
 *
 *  Two outcomes, because the two cases are not equally knowable:
 *
 *  - **not a function, and not absent** — there is no reading of
 *    `onStart: "boot"` that works. Throw.
 *  - **explicitly `undefined`/`null`** — almost always a typo'd import, but
 *    `onStart: opts.onStart` and `onStart: isDev ? devBoot : undefined` are
 *    both legitimate, so this cannot be a refusal without breaking working
 *    apps. Warn, name the key, and say how to make the absence deliberate.
 *
 *  Absent keys say nothing at all — `in` is the whole distinction: the app
 *  wrote the key, so the app meant to hook something. */
/** Exported ONLY so tests/callable-config-completeness.test.ts can prove this
 *  list still covers every function-valued key the config type declares — a
 *  hand-written list is a list that drifts. @internal */
export const _CALLABLE_CONFIG_KEYS = [
  "onAction",
  "onEffect",
  "onConnect",
  "onDisconnect",
  "onStart",
  "onStopping",
  "onStop",
  "onError",
  "onRestore",
  "beforeReduce",
  "resolveUser",
  // Found by tests/callable-config-completeness.test.ts on its first run: the
  // hook that restores state after a crash was function-valued and unchecked,
  // so a typo'd import meant crash recovery silently never happened — the
  // same "a diagnostic feature is itself quietly off" shape as the checkpoint
  // writer that could not create its own directory.
  "onCheckpointRestore",
] as const;

export function validateCallableConfig(
  config: Record<string, unknown>,
  /** Whether "the key is present" still means "the app wrote it".
   *
   *  False after the cells bridge, which spreads keys mechanically
   *  (`onStopping: fc.onStopping`) and so MATERIALISES every hook the app
   *  omitted as an explicit `undefined`. Warning there fired on every boot of
   *  every app — a warning about a hook the app never mentioned, which is the
   *  cry-wolf failure this check exists to avoid. A non-function value is
   *  still refused on both paths: no spread produces one of those. */
  appAuthored = true,
): void {
  for (const key of _CALLABLE_CONFIG_KEYS) {
    if (!(key in config)) continue;
    const value = config[key];
    if (typeof value === "function") continue;
    if (value === undefined || value === null) {
      if (!appAuthored) continue;
      log.warn(
        "aio",
        `${key} is declared but its value is ${
          value === null ? "null" : "undefined"
        } — ` +
          `the hook will never run, and nothing else would have said so. The ` +
          `usual cause is a typo'd or missing import; if the absence is ` +
          `deliberate, omit the key.`,
      );
      continue;
    }
    throw new Error(
      `[aio] ${key} must be a function, got ${typeof value} ` +
        `${JSON.stringify(value)}. Hooks are called, not read — pass the ` +
        `function itself (no parentheses).`,
    );
  }
}

export function validateConfig(
  obj: Record<string, unknown>,
  validKeys: Set<string>,
  label: string,
  exit: (code: number) => never = Deno.exit as (code: number) => never,
): void {
  const unknown = Object.keys(obj).filter((k) => !validKeys.has(k));
  if (unknown.length > 0) {
    // …with the near miss named. `cell()` has refused an unknown key with
    // "did you mean" since alpha52 and `aio.run()` printed a 90-row table and
    // left the reader to find the typo in it; the two are the same class of
    // mistake and now get the same sentence. `nearestOf` is THE spelling of
    // that suggestion (state/cell-helpers.ts) — never a second copy.
    const named = unknown.map((k) => {
      const near = nearestOf(k, validKeys);
      return near ? `${k} (did you mean "${near}"?)` : k;
    });
    log.error(
      teachMessage(
        `unknown ${label}(s): ${named.join(", ")}`,
        `remove them, or fix the spelling — the full list of valid keys is below`,
      ),
    );
    log.error(`\nValid configuration:\n`);
    log.error(formatValidConfig());
    exit(1);
  }
  // Enumerated VALUES, not just keys. A key allowlist catches `ui: { chrom: … }`
  // and waves `ui: { chrome: "Themed" }` straight through to the default — a
  // window that keeps its OS frame for no stated reason, which reads as the
  // feature being broken rather than the value being wrong.
  for (const [key, allowed] of Object.entries(ENUM_VALUES)) {
    const v = obj[key];
    if (v === undefined) continue;
    // A key the TYPE also accepts as a boolean is not a misspelled word.
    // Without this, widening `perfCheck` to `boolean | "on" | "off"` would
    // have produced the worst shape this repo has: a value the compiler
    // accepts and the boot refuses — a type that lies.
    if (typeof v === "boolean" && BOOLEAN_ALSO.has(key)) continue;
    if (!allowed.includes(v as string)) {
      const near = typeof v === "string" ? nearestOf(v, allowed) : null;
      const words = allowed.map((a) => JSON.stringify(a))
        .concat(BOOLEAN_ALSO.has(key) ? ["true", "false"] : [])
        .join(", ");
      log.error(
        teachMessage(
          `${label}.${key} is ${
            JSON.stringify(v)
          }, which is not one of ${words}`,
          near
            ? `did you mean ${JSON.stringify(near)}?`
            : `use one of ${words}`,
        ),
      );
      exit(1);
    }
  }
  // Numeric VALUES, by type and range — the third question after "is this a
  // key" and "is this one of the words". Every one of these booted silently:
  // `maxConnections: 0` closed every client the moment it connected,
  // `fullStateThreshold: "half"` compared a string against a ratio forever,
  // `effectTimeoutMs: "abc"` made every timeout NaN, `persistDebounceMs: -5`
  // was handed to a timer. A number the code cannot act on is refused at boot
  // like a word it does not know.
  for (const [key, spec] of Object.entries(NUMERIC_VALUES)) {
    const v = obj[key];
    if (v === undefined) continue;
    const bad = numericRefusal(v, spec);
    if (bad) {
      log.error(
        teachMessage(
          `${label}.${key} is ${JSON.stringify(v)}, which is ${bad}`,
          `use ${spec.what}`,
        ),
      );
      exit(1);
    }
  }
  // The SHAPE — see `refuseWrongShapes`, which `aio.run()` also calls before
  // the plugin merge, because by here the merge has already read these keys.
  refuseWrongShapes(obj, label, exit);
  // ── Couplings between keys that are each individually valid ──────────
  //
  // ── Nested objects, validated as configs in their own right ─────────
  //
  // From the top-level pass only — a nested pass has no nested objects of its
  // own, and re-entering would loop.
  if (!(label in NESTED_CONFIGS)) {
    for (const [key, keysOf] of Object.entries(NESTED_CONFIGS)) {
      const nested = obj[key];
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        validateConfig(
          nested as Record<string, unknown>,
          keysOf(),
          key,
          exit,
        );
      }
    }
  }
  // Only from the TOP-LEVEL pass: the `ui` pass sees `{ width, height }` with
  // no `client` beside it, and half a config cannot answer a question about
  // two keys.
  if (label in NESTED_CONFIGS) return;
  for (const c of configConflicts(obj)) {
    // The LINE is deduped by text: `aio.run()` validates the CellsConfig on
    // the way in and the composed AioConfig on the way through, so every
    // conflict is seen twice in one boot and a diagnostic printed twice reads
    // as a loop. The VERDICT is not: the dedupe used to skip the `exit(1)`
    // too, so only the first boot in a process was refused and every later
    // boot with the same misconfig came up.
    const first = !_reportedConflicts.has(c.what);
    _reportedConflicts.add(c.what);
    const msg = teachMessage(c.what, c.fix, c.doc);
    if (c.level === "error") {
      if (first) log.error(msg);
      exit(1);
    } else if (first) {
      log.warn(msg);
    }
  }
}

const _reportedConflicts = new Set<string>();

/** Test seam: forget which conflicts have already been reported. @internal */
export function _resetConfigConflicts(): void {
  _reportedConflicts.clear();
}

/** Config keys whose value is one of a fixed set. Checked by
 *  {@linkcode validateConfig} alongside the key allowlist.
 *
 *  EVERY enum-valued option belongs here. The list held two entries while six
 *  options had a fixed value set, so `client: "Electron"` — capital E, the
 *  spelling every doc uses in prose — fell through the key allowlist, failed
 *  the `=== "electron"` test in the launcher and started a BROWSER app with no
 *  message of any kind. A key allowlist catches a misspelled key; this is the
 *  only thing that catches a misspelled VALUE.
 *
 *  `tests/config-enum-values.test.ts` compares each list against the union in
 *  `aio-types.ts`, so a value added to a type without being added here is a red
 *  test rather than a documented option refused at boot. */
export const ENUM_VALUES: Record<string, readonly string[]> = {
  chrome: ["standard", "themed", "none"],
  // Every member of `UiTheme` (aio-types.ts) — a missing one is not a lenient
  // check, it is a documented value that exits(1) at boot. `"full"` was
  // missing here from the day it was documented; `tests/config-enum-values.
  // test.ts` now compares this list against the type's own union.
  theme: ["tokens", "auto", "full", "none"],
  client: ["electron", "browser", "cli", "server-only"],
  transport: ["uds", "ws", "auto"],
  persistMode: ["single", "multi"],
  perfCheck: ["on", "off"],
};

/** Enum keys that ALSO take a plain boolean — `perfCheck: false` is the house
 *  spelling (`logging`, `dispatchStorm` and ~14 other switches are booleans),
 *  and `"on"`/`"off"` is what shipped first. Both are accepted; the reader is
 *  `perfCheckOn` in state/dispatch.ts.
 *
 *  This set exists so the widening lands in ONE place. `ENUM_VALUES` is a
 *  `readonly string[]` map on purpose — the validator's message enumerates the
 *  words — so "and also a boolean" is a fact about the key, recorded beside
 *  the words rather than smuggled into them as the strings "true"/"false". */
export const BOOLEAN_ALSO: ReadonlySet<string> = new Set(["perfCheck"]);

/** One numeric config key: its type and the range the code can act on. */
export type NumericSpec = {
  /** Lowest accepted value (inclusive). */
  min: number;
  /** Highest accepted value (inclusive); unbounded when absent. */
  max?: number;
  /** Whole numbers only. */
  integer?: boolean;
  /** What to write instead — the fix half of the refusal. */
  what: string;
};

/** Config keys whose value is a number with a meaning, checked by
 *  {@linkcode validateConfig} beside {@linkcode ENUM_VALUES}: the type, and
 *  the range the reader of the key can actually act on. Top-level keys and
 *  `ui` keys share the table — `validateConfig` runs on both objects. */
export const NUMERIC_VALUES: Record<string, NumericSpec> = {
  port: {
    min: 0,
    max: 65535,
    integer: true,
    what: "a port 1-65535, or 0 to let the runtime pick a free one",
  },
  // 0 would refuse every client on connect — `server-ws.ts` closes the
  // socket the moment the count reaches the ceiling.
  maxConnections: {
    min: 1,
    integer: true,
    what: "a whole number of clients, at least 1",
  },
  fullStateThreshold: {
    min: 0,
    max: 1,
    what: "a ratio between 0 and 1 (0.5 = half the keys changed)",
  },
  syncIntervalMs: {
    min: 0,
    what: "a number of milliseconds (0 = microtask coalescing only)",
  },
  persistDebounceMs: { min: 0, what: "a number of milliseconds, 0 or more" },
  effectTimeoutMs: {
    min: 0,
    what: "a number of milliseconds (0 = wait forever)",
  },
  width: { min: 1, integer: true, what: "a whole number of pixels" },
  height: { min: 1, integer: true, what: "a whole number of pixels" },
  // ── wsLimits.* — the WS DoS guard stack ──────────────────────────────
  //
  // These live in the SAME table as the top-level keys and are reached by the
  // nested pass below. They were unreachable before, and each one is a guard
  // that a bad value turns OFF rather than tightens: `maxMessageBytes: NaN`
  // makes `e.data.length > NaN` false, so the frame cap, the message-rate cap
  // and the byte-rate cap (whose global fuse derives from the rate) are all
  // simply gone, with not one log line. And a `NaN` is fully type-legal —
  // `Number(Deno.env.get(…))` with the variable unset produces one.
  // The other direction is just as quiet: `messagesPerSec: 0` boots fine and
  // refuses every frame from every client — an app dead on arrival, found at
  // fire.
  maxMessageBytes: {
    min: 1,
    integer: true,
    what: "a whole number of bytes, at least 1",
  },
  messagesPerSec: {
    min: 1,
    integer: true,
    what: "a whole number of messages per second, at least 1",
  },
  bytesPerSec: {
    min: 1,
    integer: true,
    what: "a whole number of bytes per second, at least 1",
  },
};

/** Config keys whose value is an object validated in its own right, and the
 *  key allowlist for each.
 *
 *  `validateConfig` walks these itself. `ui` used to be recursed into by each
 *  CALLER (`aio.ts`, twice) — so `wsLimits`, a nested object with three
 *  numeric guards in it, was never validated at all, by anyone. A nested
 *  config is validated because it IS one, not because a call site remembered.
 *  `tests/config-numeric-values.test.ts` pins this map and the ranges its
 *  nested keys are checked against. */
export const NESTED_CONFIGS: Record<string, () => Set<string>> = {
  ui: () => VALID_UI_KEYS,
  wsLimits: () => VALID_WS_LIMITS_KEYS,
  // The SECURITY blocks. A misspelled key here was accepted in silence and
  // the control the author asked for was simply absent: `sessions: { ttlMS }`
  // kept the built-in thirty days for a five-minute session, `auth:
  // { requireVerifed: true }` left email verification off, `tls: { certt }`
  // broke the cert/key pair so a real certificate stopped being served, and
  // the `updates` manifest-trust options went to the floor. Each of these is
  // a union type (`auth: true`, `tls: "auto"`, `updates: "https://…"`), and
  // the walk below enters only the object spelling — which is exactly when
  // the keys exist to be misspelled.
  // The Electron block: two SECURITY switches, and a misspelling of either is
  // an app that thinks it is protected and is not.
  electron: () => VALID_ELECTRON_KEYS,
  auth: () => VALID_AUTH_KEYS,
  sessions: () => VALID_SESSIONS_KEYS,
  tls: () => VALID_TLS_KEYS,
  updates: () => VALID_UPDATES_KEYS,
};

/** Every key of `ElectronConfig` (aio-types.ts). */
export const VALID_ELECTRON_KEYS: Set<string> = new Set([
  "requireSandbox",
  "unsandboxedChildWindows",
]);

/** Every key of `WsLimits` (aio-types.ts). */
export const VALID_WS_LIMITS_KEYS: Set<string> = new Set([
  "maxMessageBytes",
  "messagesPerSec",
  "bytesPerSec",
]);

/** Every key of `AuthOptions` (aio-types.ts) — both halves of the
 *  `requireVerified`/`sendMail` intersection. */
export const VALID_AUTH_KEYS: Set<string> = new Set([
  "signup",
  "ttlMs",
  "cookie",
  "totp",
  "oidc",
  "requireVerified",
  "sendMail",
]);

/** Every key of the object spelling of `sessions` (aio-types.ts). */
export const VALID_SESSIONS_KEYS: Set<string> = new Set(["ttlMs"]);

/** Every key of the object spelling of `tls` (aio-types.ts). */
export const VALID_TLS_KEYS: Set<string> = new Set(["cert", "key"]);

/** Every key of `UpdatesConfig` (updates-core.ts). */
export const VALID_UPDATES_KEYS: Set<string> = new Set([
  "source",
  "kind",
  "auto",
  "check",
  "channel",
  "key",
  "keys",
  "canApply",
  "allowUnsigned",
  "prerelease",
]);

/** The runtime SHAPE a config value must have. */
export type ConfigShape = "boolean" | "object" | "array";

/** Config keys whose value must have a given SHAPE — the third question about
 *  an option, after "is this a real key" and "is this one of the words".
 *
 *  It had no answer at all, and the silence ran the wrong way every time:
 *
 *   • `expose: "false"` — the natural spelling of "I turned it off", and one a
 *     deno.json can hold without a compiler ever seeing it — booted the app ON
 *     THE NETWORK, because every reader of `expose` asks it for truthiness and
 *     a non-empty string is truthy.
 *   • `allowedOrigins: "https://app.example.com"` (one origin, not a list) was
 *     spread and iterated as a STRING: `frameAncestors` walked it character by
 *     character and the Origin gate became a substring test.
 *   • `wsLimits: 5`, `ui: 42` were dropped WHOLE — the nested pass below skips
 *     anything that is not a plain object, so every option inside them
 *     vanished without a line. The WS DoS guard stack and the window/theme
 *     block are exactly the two whose absence is invisible until it matters.
 *   • `cells: {}` booted an app with no cells.
 *
 *  `tests/config-shape-values.test.ts` reads the declarations out of
 *  `aio-types.ts` and refuses a public `?: boolean` or `?: T[]` option that is
 *  missing here, so the table cannot fall behind the type. */
export const SHAPE_VALUES: Record<string, ConfigShape> = {
  // ── plain booleans ────────────────────────────────────────────────────
  expose: "boolean",
  persist: "boolean",
  checkIntegrityOnBoot: "boolean",
  strictOrigin: "boolean",
  keepServer: "boolean",
  takeover: "boolean",
  freezeState: "boolean",
  singleton: "boolean",
  libraryMode: "boolean",
  fatalOnStart: "boolean",
  guardDispatches: "boolean",
  journal: "boolean",
  childWindows: "boolean",
  strictCells: "boolean",
  refusalsReject: "boolean",
  localFirst: "boolean",
  showStatus: "boolean",
  layout: "boolean",
  // ── lists ─────────────────────────────────────────────────────────────
  cells: "array",
  allowedOrigins: "array",
  appFlags: "array",
  dbPragmas: "array",
  redactActions: "array",
  isolate: "array",
  plugins: "array",
  // `schedules` is deliberately NOT here: `validateSchedules` already owns
  // its container AND its entries, and it THROWS (catchable, with the entry
  // named) where this table exits. Two gates on one key is the shape this
  // repo keeps removing — see the exemption list in
  // tests/config-shape-values.test.ts, which is what keeps this an omission
  // on purpose rather than a gap.
  // ── blocks ────────────────────────────────────────────────────────────
  ui: "object",
  wsLimits: "object",
  routes: "object",
  serveDirs: "object",
  assets: "object",
  db: "object",
  perfBudget: "object",
  budgets: "object",
  renderBudget: "object",
  memory: "object",
  circuitBreaker: "object",
  security: "object",
  electron: "object",
  cellDefaults: "object",
};

/** Refuse every {@linkcode SHAPE_VALUES} key whose value is not the shape the
 *  key needs — the shape pass of {@linkcode validateConfig}, split out so it
 *  can run BEFORE the first reader rather than beside the other two questions.
 *
 *  It has to. `aio.run()` merges plugins FIRST, deliberately ("before any
 *  other config key is read, so no code path can be written that forgets
 *  plugins exist"), and that merge READS the very keys this table guards:
 *
 *      allowedOrigins: [...new Set([...(fc.allowedOrigins ?? []), ...plugin])]
 *
 *  Spreading a bare string yields its CHARACTERS. So with any plugin loaded,
 *  `allowedOrigins: "https://app.example.com"` reached `validateConfig` as a
 *  perfectly good array of 23 one-character origins, passed, and turned the
 *  Origin gate into the substring test this table was written to stop —
 *  measured: exit 1 without a plugin, booted clean with one. `routes` is the
 *  same shape of hole (a spread string is an object), and `plugins` itself is
 *  read one line earlier still.
 *
 *  One decider, called at two moments: `validateConfig` still runs it, so a
 *  caller that never reaches the early call is not left ungated, and the
 *  second run is a no-op because a valid shape cannot be merged into an
 *  invalid one.
 *
 *  `null` and `undefined` stay "not said" — `pick`'s documented meaning in
 *  config-sources.ts, the ONE decider, and a gate that read them differently
 *  would be a second one. */
export function refuseWrongShapes(
  obj: Record<string, unknown>,
  label: string,
  exit: (code: number) => never = Deno.exit as (code: number) => never,
): void {
  for (const [key, shape] of Object.entries(SHAPE_VALUES)) {
    const v = obj[key];
    if (v === undefined || v === null) continue;
    const bad = shapeRefusal(v, shape);
    if (!bad) continue;
    log.error(
      teachMessage(
        `${label}.${key} is ${describeValue(v)}, which is ${bad}`,
        shapeFix(key, shape),
      ),
    );
    exit(1);
  }
}

/** A config value as the refusal should print it.
 *
 *  `JSON.stringify` is not safe on a value that arrived at this gate BECAUSE
 *  it is the wrong kind of thing: it returns `undefined` for a function or a
 *  symbol, and THROWS on a BigInt and on anything circular — so the one gate
 *  whose whole job is to refuse a value would itself die on the value, with a
 *  TypeError out of the validator instead of the sentence that names the key.
 *  Pure. */
function describeValue(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    // aio-ok: the fallback IS the answer — a value JSON cannot hold is
    // described by its type, and the key and the fix carry the rest.
    return typeof v === "object"
      ? "an object that cannot be printed"
      : `a ${typeof v}`;
  }
}

/** Why `v` is not the `shape` the key needs — or `null` when it is. Pure. */
export function shapeRefusal(v: unknown, shape: ConfigShape): string | null {
  if (shape === "boolean") {
    return typeof v === "boolean" ? null : `not true or false`;
  }
  if (shape === "array") {
    if (Array.isArray(v)) return null;
    return typeof v === "string"
      ? "a bare string, not a list — it would be read one character at a time"
      : "not a list";
  }
  if (Array.isArray(v)) return "a list, not a block of options";
  return v !== null && typeof v === "object" ? null : "not a block of options";
}

/** The one-line fix half of a shape refusal. Pure. */
export function shapeFix(key: string, shape: ConfigShape): string {
  if (shape === "boolean") {
    return `write ${key}: true or ${key}: false — anything else is read for ` +
      `TRUTHINESS, so "false" and 0 do the opposite of what they read like`;
  }
  if (shape === "array") return `write ${key}: [ … ], one entry per item`;
  return `write ${key}: { … } — any other value is dropped whole, and every ` +
    `option inside it with it`;
}

/** Why `v` is not a value `spec` accepts — or `null` when it is. Pure. */
export function numericRefusal(v: unknown, spec: NumericSpec): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return "not a number";
  if (spec.integer && !Number.isInteger(v)) return "not a whole number";
  if (v < spec.min) return `below the minimum ${spec.min}`;
  if (spec.max !== undefined && v > spec.max) {
    return `above the maximum ${spec.max}`;
  }
  return null;
}

// ─── Couplings: keys that are each valid and wrong TOGETHER ──────────────────
//
// A key allowlist answers "is this a real option" and an enum list answers "is
// this a real value". Neither can answer "do these two options contradict each
// other", and that is the class an audit found fourteen live instances of —
// every one of them silent. Two cost data outright:
//
//   • `auth: { requireVerified: true }` with no `sendMail` answers signup with
//     `verificationSent: true` — a LIE, nothing was sent — and then refuses
//     every login with 403 forever. The account cannot be recovered from
//     inside the app.
//   • `journal: true` under `persist: false` or `dbPath: ":memory:"` resolves
//     to `null`. The app boots, reports nothing, and the SIGKILL/power-cut
//     recovery the author asked for is simply absent when it is needed.
//
// The rest invert intent or leave an option inert. Each is stated as CAUSE and
// FIX, in the one teachable format, and refused (or warned) at boot rather
// than discovered in production.
//
// PURE — no logging, no exit, no `Deno` — so every conflict is a table-driven
// unit test rather than a boot the test has to survive.

/** One config contradiction: what is wrong, and the one-line fix. */
export type ConfigConflict = {
  /** `"error"` — the app would lose data or do the OPPOSITE of what was asked;
   *  boot is refused. `"warn"` — an option is inert, nothing is destroyed. */
  level: "error" | "warn";
  /** The config keys involved, most-specific first. For tests and tooling. */
  keys: string[];
  /** Cause — what the combination actually does. */
  what: string;
  /** Fix — one line the author can act on without reading a doc. */
  fix: string;
  /** Optional doc path. */
  doc?: string;
};

/** `{ include: [...], exclude: [...] }` on the same filter — `include` wins and
 *  `exclude` is dropped on the floor.
 *
 *  The predicate itself lives with the filters, in `state/cell-helpers.ts`:
 *  `cell()`'s own `visible`/`persist` are refused there too (a throw — the
 *  normalizer destroys the evidence before boot), and one fact decided in two
 *  layers is how the two spellings would drift apart. */
const bothFilterModes = hasBothFilterModes;

/** Every contradiction between two otherwise-valid keys of one config object.
 *  Pure. Order is stable (declaration order) so a test can pin it. */
export function configConflicts(
  cfg: Record<string, unknown>,
): ConfigConflict[] {
  const out: ConfigConflict[] = [];
  const obj = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === "object" ? v as Record<string, unknown> : null;

  // ── 1. auth.requireVerified without sendMail — a lockout, and a lie ──
  const auth = obj(cfg.auth);
  if (auth?.requireVerified === true && typeof auth.sendMail !== "function") {
    out.push({
      level: "error",
      keys: ["auth.requireVerified", "auth.sendMail"],
      what:
        `auth.requireVerified is on but auth.sendMail is not set, so no account can ever ` +
        `be verified: signup answers { verificationSent: true } without sending anything, ` +
        `and every later login is refused 403 email_unverified — permanently`,
      fix:
        `give auth.sendMail a transport (SMTP/SES/console — yours), or drop ` +
        `auth.requireVerified until you have one`,
      doc: "docs/auth/auth.md",
    });
  }

  // ── 1b. an allowedOrigins entry no request can ever match ────────────
  const origins = cfg.allowedOrigins;
  if (Array.isArray(origins)) {
    const inert = inertAllowlistEntries(
      origins.filter((o): o is string => typeof o === "string"),
    );
    if (inert.length > 0) {
      out.push({
        level: "warn",
        keys: ["allowedOrigins"],
        what: `allowedOrigins ${
          inert.map((e) => JSON.stringify(e)).join(", ")
        } ${
          inert.length === 1
            ? "matches"
            : "match"
        } nothing — the entry is read by both the WebSocket Origin check and ` +
          `the Host (DNS-rebinding) gate, and neither can ever compare equal ` +
          `to it, so access was NOT widened`,
        fix:
          `write one of the four spellings the allowlist reads: "*", a bare ` +
          `hostname (app.example.com), a host:port (app.example.com:8443), or ` +
          `a full origin (https://app.example.com)`,
        doc: "docs/basics/positioning.md",
      });
    }
  }

  // ── 2. journal without a file to journal INTO ────────────────────────
  if (cfg.journal === true) {
    const memoryDb = cfg.dbPath === ":memory:";
    if (cfg.persist === false || memoryDb) {
      const cause = cfg.persist === false
        ? "persist is false"
        : 'dbPath is ":memory:"';
      out.push({
        level: "error",
        keys: ["journal", cfg.persist === false ? "persist" : "dbPath"],
        what:
          `journal: true asks for durable SIGKILL/power-cut recovery, but ${cause}, ` +
          `so there is no file to replay from — the journal resolves to null and the ` +
          `app boots with no recovery at all`,
        fix: cfg.persist === false
          ? `remove journal: true, or turn persistence on (persist defaults to true)`
          : `remove journal: true for in-memory runs, or point dbPath at a real file`,
        doc: "docs/persistence/auto-persist.md",
      });
    }
  }

  // ── 3. include AND exclude on one filter — exclude is dropped ────────
  const defaults = obj(cfg.cellDefaults);
  for (const kind of ["visible", "ui", "persist"] as const) {
    if (bothFilterModes(defaults?.[kind])) {
      out.push({
        level: "error",
        keys: [`cellDefaults.${kind}.include`, `cellDefaults.${kind}.exclude`],
        what:
          `cellDefaults.${kind} sets BOTH include and exclude — include wins and exclude is ` +
          `discarded without a word, so every field you listed in exclude is ${
            kind === "persist"
              ? "written to the database"
              : "sent to every client"
          } if it also appears (directly or by omission) under include`,
        fix: `keep ONE of them: include is an allowlist (nothing else is ${
          kind === "persist" ? "persisted" : "exposed"
        }), exclude is a denylist (everything else is)`,
        doc: "docs/state/cells.md",
      });
    }
  }

  // ── 3a. include/exclude that is not a list — see `unusableFilterList` ──
  for (const kind of ["visible", "ui", "persist"] as const) {
    const unusable = unusableFilterList(defaults?.[kind]);
    if (!unusable) continue;
    out.push({
      level: "error",
      keys: [`cellDefaults.${kind}.${unusable.mode}`],
      what:
        `cellDefaults.${kind}.${unusable.mode} is ${unusable.got}, not a list of ` +
        `field names, so ${unusableFilterConsequence(kind)} — for every cell ` +
        `this default applies to`,
      fix:
        `${kind}: { ${unusable.mode}: ${unusable.suggest} } — an array, one string per field`,
      doc: "docs/state/cells.md",
    });
  }

  // ── 3b. a persist filter that names neither list — see `namesNoFilterMode` ──
  if (namesNoFilterMode(defaults?.persist)) {
    out.push({
      level: "error",
      keys: ["cellDefaults.persist"],
      what:
        `cellDefaults.persist names neither include nor exclude, so it is not a filter: ` +
        `the boot report says persist=all and the store writes an empty document for ` +
        `every cell it applies to — nothing survives a restart, silently`,
      fix:
        `use persist: "all" (store the whole slice) or persist: "none" (store nothing), ` +
        `or name the fields with include/exclude`,
      doc: "docs/state/cells.md",
    });
  }

  // ── 4. updates: nothing polls, but a manual check auto-installs ──────
  const updates = obj(cfg.updates);
  if (updates?.check === false && updates.auto === true) {
    out.push({
      level: "warn",
      keys: ["updates.check", "updates.auto"],
      what:
        `updates.auto is on while updates.check is false — nothing ever polls, so the ` +
        `unattended install can only happen on a manual updates.check() call. As written ` +
        `this app will not update itself`,
      fix:
        `set check: true (or an interval in ms) to actually poll, or drop auto: true if ` +
        `manual-only was the intent`,
      doc: "docs/deploy/updates.md",
    });
  }

  // ── 5. `long` methods overridden by an explicit per-method timeout ───
  //
  // `long` means "no ceiling" (cell-impl resolves it to 0); a
  // `perfBudget.methods["cell:method"].timeout` is consulted FIRST and wins.
  // Two ways to say the same thing, and the quieter one loses.
  const perfBudget = obj(cfg.perfBudget);
  const methodBudgets = obj(perfBudget?.methods);
  if (methodBudgets) {
    const longKeys = new Set<string>();
    for (const cell of Array.isArray(cfg.cells) ? cfg.cells : []) {
      const aio = obj(obj(cell)?.__aio);
      const id = typeof aio?.id === "string" ? aio.id : null;
      const longs = aio?.longMethods;
      if (!id || !Array.isArray(longs)) continue;
      for (const m of longs) longKeys.add(`${id}:${m}`);
    }
    for (const [key, budget] of Object.entries(methodBudgets)) {
      if (!longKeys.has(key)) continue;
      if (obj(budget)?.timeout === undefined) continue;
      out.push({
        level: "error",
        keys: [`perfBudget.methods["${key}"].timeout`, "long"],
        what: `"${key}" is declared long (no call ceiling) AND given ` +
          `perfBudget.methods["${key}"].timeout — the explicit timeout wins, so the ` +
          `method is abandoned at that deadline and \`long\` does nothing`,
        fix:
          `keep one: drop "${key}" from the cell's \`long\` list if the deadline is real, ` +
          `or remove the per-method timeout if it should run unbounded`,
        doc: "docs/debugging/performance.md",
      });
    }
  }

  // ── 6. takeover with no lock to take over ────────────────────────────
  const singletonOff = cfg.singleton === false || cfg.libraryMode === true;
  if (cfg.takeover === true && singletonOff) {
    const why = cfg.singleton === false
      ? "singleton: false"
      : "libraryMode: true";
    out.push({
      level: "error",
      keys: [
        "takeover",
        cfg.singleton === false ? "singleton" : "libraryMode",
      ],
      what:
        `takeover asks to take over the running instance, but ${why} means no instance ` +
        `lock is acquired at all — nothing is killed, nothing is taken over, and a second ` +
        `copy simply starts alongside the first`,
      fix:
        `remove takeover, or remove ${why} so there is a single instance to take over`,
      doc: "docs/state/lifecycle.md",
    });
  }

  // ── 7. singleton asked for and silently overridden ───────────────────
  if (cfg.singleton === true && cfg.libraryMode === true) {
    out.push({
      level: "error",
      keys: ["singleton", "libraryMode"],
      what:
        `singleton: true and libraryMode: true contradict each other — libraryMode wins and ` +
        `the instance lock is never taken, so the "refuse to start if already running" ` +
        `guarantee you asked for is not in force`,
      fix:
        `drop singleton: true (libraryMode implies no lock), or drop libraryMode if this is ` +
        `a real app rather than a test/embedding host`,
      doc: "docs/state/lifecycle.md",
    });
  }

  // ── 8. transport: "uds" with a client that cannot open a socket ──────
  //
  // An explicit "uds" is honoured unconditionally (paths.ts resolveTransport):
  // it is NOT downgraded for a browser client, so the app comes up listening on
  // a Unix socket that no browser can reach and prints a URL nobody can open.
  if (cfg.transport === "uds") {
    const client = typeof cfg.client === "string" ? cfg.client : undefined;
    if (client && client !== "electron") {
      out.push({
        level: "error",
        keys: ["transport", "client"],
        what:
          `transport: "uds" with client: "${client}" — the local socket is honoured as ` +
          `written, but only the Electron client speaks it. The server will come up on a ` +
          `socket a ${
            client === "browser" ? "browser" : client
          } client cannot connect to`,
        fix:
          `use transport: "ws" (or drop transport and let "auto" decide — it picks uds only ` +
          `for a local electron app)`,
        doc: "docs/clients/electron.md",
      });
    }
    if (cfg.expose === true) {
      out.push({
        level: "error",
        keys: ["transport", "expose"],
        what:
          `transport: "uds" with expose: true — a Unix socket is local by definition, and an ` +
          `explicit "uds" is not downgraded, so the app serves nothing on the network it was ` +
          `just told to serve`,
        fix:
          `drop transport: "uds" (expose needs "ws"), or drop expose if this app is local`,
        doc: "docs/clients/electron.md",
      });
    }
  }

  // ── 9. serverUrl launches Electron whatever `client` says ────────────
  //
  // `""` is meaningful (the --connect page), so this asks `=== undefined`.
  if (cfg.serverUrl !== undefined) {
    const client = typeof cfg.client === "string" ? cfg.client : undefined;
    if (client && client !== "electron") {
      out.push({
        level: "error",
        keys: ["serverUrl", "client"],
        what:
          `serverUrl is set with client: "${client}" — the thin-client path runs BEFORE ` +
          `client is resolved, so it launches Electron regardless and then exits. ` +
          `client: "${client}" has no effect`,
        fix:
          `remove client: "${client}" if a thin Electron client is what you want, or remove ` +
          `serverUrl and point the ${client} client at the server itself`,
        doc: "docs/clients/electron.md",
      });
    }
  }

  // ── 10. ui.width/height where no window is ever opened ───────────────
  //
  // NOT "outside Electron": the browser shell emits them as metas and the
  // WS-transport Electron launcher reads them back. They are inert only where
  // there is no window at all.
  const ui = obj(cfg.ui);
  if (ui && (ui.width !== undefined || ui.height !== undefined)) {
    const client = typeof cfg.client === "string" ? cfg.client : undefined;
    if (client === "cli" || client === "server-only") {
      out.push({
        level: "warn",
        keys: ["ui.width", "ui.height", "client"],
        what:
          `ui.width/ui.height are set with client: "${client}", which opens no window — ` +
          `the values are read and then never used by anything`,
        fix:
          `remove them, or use client: "electron"/"browser" if this app is meant to have a ` +
          `window`,
      });
    }
  }

  // ── 11. a TTL that cannot be a timestamp ─────────────────────────────
  //
  // `now + ttlMs` is written straight into an INTEGER column and read back as
  // a JavaScript number. A TTL past the safe range makes the WRITE succeed and
  // every READ throw — so the app booted with no complaint, `/signup` answered
  // `201` with a real-looking token, and then every single use of that token
  // was a `500` (HTTP) or a silent refusal (WebSocket):
  //
  //   RangeError: Value is too large to be represented as a JavaScript
  //   number: 9008988486003180
  //
  // `Infinity` was worse in the other direction: it issued an IMMORTAL session
  // that no sweep can ever expire, and put `Max-Age=Infinity` in the cookie.
  // A negative TTL answered `201` with a token that was already dead. Every
  // one of these is "a config validated only when it FIRES".
  for (
    const [where, raw] of [
      ["sessions.ttlMs", obj(cfg.sessions)?.ttlMs],
      ["auth.ttlMs", obj(cfg.auth)?.ttlMs],
    ] as const
  ) {
    if (raw === undefined) continue;
    const ttl = typeof raw === "number" ? raw : NaN;
    // The STORE's bound, not a second copy of it: a gate that blesses a value
    // `openSessionStore` then throws on is one fact validated twice, in two
    // places, with two answers. `ttl < 1` for the same reason the store has
    // it — under a millisecond, `now + ttlMs` IS `now`, so the session is born
    // expired.
    if (!Number.isFinite(ttl) || ttl < 1 || ttl > MAX_SESSION_TTL_MS) {
      out.push({
        level: "error",
        keys: [where],
        what:
          `${where} is ${
            typeof raw === "number" ? String(raw) : JSON.stringify(raw)
          }, which cannot become an expiry: a session's ` +
          `expiry is stored as \`now + ttlMs\`, and this app would boot, ` +
          `issue tokens, and then fail every request that presents one`,
        fix: `use a whole number of milliseconds, at least 1 and under a ` +
          `century — e.g. ${7 * 24 * 60 * 60_000} for a week`,
        doc: "docs/auth/auth.md",
      });
    }
  }

  // ── 12. two session TTLs, and each is read by a different half ───────
  const sessions = obj(cfg.sessions);
  if (sessions?.ttlMs !== undefined && auth?.ttlMs !== undefined) {
    out.push({
      level: "error",
      keys: ["sessions.ttlMs", "auth.ttlMs"],
      what:
        `sessions.ttlMs (${sessions.ttlMs}) and auth.ttlMs (${auth.ttlMs}) are both set and ` +
        `neither wins outright: the session STORE takes its default from sessions.ttlMs, ` +
        `while every /__aio/auth login issues its token AND sets its cookie Max-Age from ` +
        `auth.ttlMs`,
      fix:
        `set the TTL in ONE place — auth.ttlMs if you use the built-in login flows, ` +
        `sessions.ttlMs if you issue tokens yourself`,
      doc: "docs/auth/auth.md",
    });
  }
  if (
    sessions?.ttlMs !== undefined && auth?.ttlMs === undefined &&
    cfg.auth !== undefined && cfg.auth !== false
  ) {
    out.push({
      level: "warn",
      keys: ["sessions.ttlMs", "auth.ttlMs"],
      what:
        `sessions.ttlMs is set and auth.ttlMs is not — issued tokens honour it, but the ` +
        `login cookie's Max-Age falls back to the built-in 30 days, so the browser keeps a ` +
        `cookie for a session the store has already expired`,
      fix: `set auth: { ttlMs: ${sessions.ttlMs} } to the same value`,
      doc: "docs/auth/auth.md",
    });
  }

  // ── 12. a git source ignores every manifest-trust option ─────────────
  if (updates && typeof updates.source === "string") {
    let kind: string | null = null;
    try {
      kind = classifySource(
        updates.source,
        updates.kind as "manifest" | "git" | undefined,
      );
    } catch {
      // aio-ok: classifySource REFUSES an ambiguous source rather than guessing,
      // and the real caller raises exactly that error a moment later with the
      // same message. A validator that cannot tell which kind this is has no
      // opinion about which options that kind reads — it must not pre-empt (or
      // duplicate) the refusal.
      kind = null;
    }
    if (kind === "git") {
      const ignored = ["key", "keys", "allowUnsigned", "prerelease"]
        .filter((k) => updates[k] !== undefined);
      if (ignored.length > 0) {
        out.push({
          level: "warn",
          keys: ignored.map((k) => `updates.${k}`),
          what:
            `updates.source is a git repository, and the git path never reads ${
              ignored.map((k) => `updates.${k}`).join(", ")
            } — a repository has no manifest and nothing to sign, so an update is trusted ` +
            `because you trust the repo, not because anything was verified`,
          fix:
            `remove ${
              ignored.join(", ")
            }, or publish signed artifacts with \`deno task ship\` and ` +
            `point updates.source at them (kind: "manifest")`,
          doc: "docs/deploy/updates.md",
        });
      }
    }
  }

  return out;
}
