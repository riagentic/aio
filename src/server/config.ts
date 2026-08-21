import { log } from "../diagnostics/logger-api.ts";

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
  "chrome", // desktop window frame: "standard" | "themed" | "none"
  "theme", // the default look: "tokens" (default) | "auto" | "full" | "none"
]);

/** Top-level `deno.json` keys aio actually READS (its own + Deno's).
 *
 *  Everything else at that level is inert as far as aio is concerned — which
 *  is fine for another tool's config and a silent trap for a key that looks
 *  exactly like aio's own. A field report put `ui: { width, height }` there,
 *  got no error and no effect, and lost time to it: "silently ignoring input
 *  is the worst available behaviour". See {@link misplacedDenoJsonKeys}. */
export const DENO_JSON_READ_KEYS = new Set<string>([
  // aio's
  "appId",
  "title",
  "client",
  "target", // deprecated alias — still read, still warned about
  "entry",
  "build",
  "version",
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

/** aio-shaped keys sitting at the TOP LEVEL of deno.json, where they do
 *  nothing. Pure — the caller warns.
 *
 *  Deliberately narrow: only a key aio would recognise inside `aio.run()`
 *  counts, so another tool's section in the same file is never scolded. */
export function misplacedDenoJsonKeys(
  denoJson: Record<string, unknown> | undefined,
): string[] {
  if (!denoJson) return [];
  return Object.keys(denoJson).filter((k) =>
    !DENO_JSON_READ_KEYS.has(k) &&
    // …including a `ui` key written FLAT at the top level (`"theme": "auto"`,
    // `"chrome": "themed"`, `"width": 900`). The reported case was the whole
    // `ui: {…}` object; the flattened spelling is the same mistake one step
    // further, and was just as inert and just as silent.
    (VALID_AIO_CONFIG_KEYS.has(k) || VALID_FEATURES_CONFIG_KEYS.has(k) ||
      VALID_UI_KEYS.has(k) || k === "ui")
  );
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
  "allowedOrigins",
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
  "client",
  "keepServer",
  "transport",
  "killExisting",
  "serverUrl",
  "appVersion",
  "schedules",
  "db",
  "perfCheck",
  "perfBudget",
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
  "redactActions",
  "childWindows",
  "onAction",
  "onEffect",
  "onConnect",
  "onDisconnect",
  "onStart",
  "onStop",
  "onError",
  "libraryMode",
  // internal keys (prefixed with _)
  "_onScheduleReady",
  "_diagnostics",
  "_onCheckpointRestore",
  "_cellNames",
  "_workerCells",
  "_healthGetter",
  "_reduceBreakdown",
  "_onReportOptsReady",
  "_syncCellIds",
  "_getDBState",
  "_getUIState",
  "_cellPatchStrategies",
  "_cellFilterFields",
  "_cellAccess",
  "_cellMethods",
  "_cellFields",
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
  "client",
  "keepServer",
  "transport",
  "killExisting",
  "serverUrl",
  "users",
  "key",
  "resolveUser",
  "sessions",
  "auth",
  "db",
  "perfCheck",
  "perfBudget",
  "renderBudget",
  "effectTimeoutMs",
  "freezeState",
  "memory",
  "circuitBreaker",
  "singleton",
  "strictCells",
  "guardDispatches",
  "journal",
  "redactActions",
  "childWindows",
  "libraryMode",
  "syncIntervalMs",
  "fullStateThreshold",
  "routes",
  "maxConnections",
  "schedules",
  "wsLimits",
  "allowedOrigins",
  "strictOrigin",
  "trustProxyHeader",
  "fatalOnStart",
  "dispatchStorm",
  "appVersion",
  "isolate",
  "beforeReduce",
  "onAction",
  "onEffect",
  "onConnect",
  "onDisconnect",
  "onStart",
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
    'release source URL ("https://…" / "file://…" / a git repo) — or { source, auto, check, channel, key }',
  ],
  appId: ["", "unique app identity — lock file, UDS socket, KV/SQLite paths"],
  appVersion: ["", "app version string — logged on startup"],
  cells: ["", "cell definitions array"],
  serveDirs: [
    "",
    'extra READ-ONLY dev-server roots by URL prefix ({"/shared":"../core/lib"}) — dev only; prod bundles follow relative imports',
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
  port: ["8000", "HTTP/WS server port"],
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
  baseDir: ['"./src"', "source directory for transpilation"],
  client: ['"electron"', '"electron" | "browser" | "cli" | "server-only"'],
  keepServer: ["false", "keep server running after client closes"],
  transport: ['"auto"', '"uds" | "ws" | "auto" — IPC transport'],
  killExisting: ["false", "kill existing instance before starting"],
  serverUrl: ["", "connect to remote server instead of starting one"],
  singleton: ["true", "refuse to start if already running"],
  syncIntervalMs: [
    "50",
    "max 1 state push per N ms (0 = microtask coalescing only)",
  ],
  fullStateThreshold: [
    "0.5",
    "ratio of changed keys that triggers full state broadcast",
  ],
  routes: [
    "",
    'custom HTTP routes — "/path" or "/prefix/*" → handler (uploads, webhooks)',
  ],
  maxConnections: ["100", "max concurrent WebSocket clients"],
  allowedOrigins: ["", "extra allowed WS origins beyond localhost + own host"],
  strictOrigin: ["false", "require Origin header on WS upgrade in expose mode"],
  trustProxyHeader: [
    "",
    'behind a trusted reverse proxy: read the real client IP from this header (e.g. "x-forwarded-for") for lockout/abuse bucketing',
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
  redactActions: [
    "",
    'action types whose payload is "[redacted]" in journal/diagnostics/timeline (trailing * = prefix match)',
  ],
  childWindows: [
    "false",
    "allow Electron child windows via __aioIPC.openWindow (off — real attack surface)",
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
  onStop: ["", "called on shutdown"],
  onError: ["", "called on framework error"],
  onRestore: ["", "transform state after restore, before server starts"],
  onCheckpointRestore: ["", "handle diagnostics checkpoint on startup"],
};

/** [default, description] per `ui: {}` key — same completeness gate as
 *  CONFIG_DOCS (every VALID_UI_KEYS entry must have a row). */
export const UI_DOCS: Record<string, [string, string]> = {
  lang: ['"en"', "<html lang> — the document language (WCAG 3.1.1)"],
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
    '"auto"',
    'default stylesheet — "auto" (steps aside for your style.css) | "full" (keep it alongside yours) | "none"',
  ],
};

/** Keys printed in the IDENTITY table (see formatValidConfig). */
export const IDENTITY_KEYS = ["appId", "appVersion", "cells"] as const;

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
    "client",
    "keepServer",
    "transport",
    "killExisting",
    "serverUrl",
    "singleton",
    "libraryMode",
    "syncIntervalMs",
    "fullStateThreshold",
    "routes",
    "maxConnections",
    "wsLimits",
    "allowedOrigins",
    "strictOrigin",
    "trustProxyHeader",
    "childWindows",
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
    "onStop",
    "onError",
    "onCheckpointRestore",
  ]],
  ["Performance & monitoring", [
    "perfCheck",
    "perfBudget",
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

export function validateConfig(
  obj: Record<string, unknown>,
  validKeys: Set<string>,
  label: string,
  exit: (code: number) => never = Deno.exit as (code: number) => never,
): void {
  const unknown = Object.keys(obj).filter((k) => !validKeys.has(k));
  if (unknown.length > 0) {
    log.error(
      `\n[aio] CONFIG ERROR: unknown ${label} key(s): ${unknown.join(", ")}`,
    );
    log.error(`\n[aio] Valid configuration:\n`);
    log.error(formatValidConfig());
    exit(1);
  }
  // Enumerated VALUES, not just keys. A key allowlist catches `ui: { chrom: … }`
  // and waves `ui: { chrome: "Themed" }` straight through to the default — a
  // window that keeps its OS frame for no stated reason, which reads as the
  // feature being broken rather than the value being wrong.
  for (const [key, allowed] of Object.entries(ENUM_VALUES)) {
    const v = obj[key];
    if (v !== undefined && !allowed.includes(v as string)) {
      log.error(
        `\n[aio] CONFIG ERROR: ${label}.${key} is ${
          JSON.stringify(v)
        } — must be one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}`,
      );
      exit(1);
    }
  }
}

/** Config keys whose value is one of a fixed set. Checked by
 *  {@linkcode validateConfig} alongside the key allowlist. */
export const ENUM_VALUES: Record<string, readonly string[]> = {
  chrome: ["standard", "themed", "none"],
  // Every member of `UiTheme` (aio-types.ts) — a missing one is not a lenient
  // check, it is a documented value that exits(1) at boot. `"full"` was
  // missing here from the day it was documented; `tests/config-enum-values.
  // test.ts` now compares this list against the type's own union.
  theme: ["tokens", "auto", "full", "none"],
};
