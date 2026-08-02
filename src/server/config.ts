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
]);

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
  "baseDir",
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
  "_cellVersions",
]);

export const VALID_FEATURES_CONFIG_KEYS = new Set<string>([
  "appId",
  "cells",
  "cellDefaults",
  "localFirst",
  "port",
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

const CONFIG_DOCS: Record<string, [string, string]> = {
  appId: ["", "unique app identity — lock file, UDS socket, KV/SQLite paths"],
  appVersion: ["", "app version string — logged on startup"],
  cells: ["", "cell definitions array"],
  localFirst: [
    "false",
    "run every server cell's methods locally + sync as CRDT ops (per-cell opt-out with sync:false)",
  ],
  reduce: ["", "state reducer (legacy API)"],
  execute: ["", "effect executor (legacy API)"],
  persist: ["true", "persist state to SQLite (data.db)"],
  persistKey: ['"state"', "KV key prefix"],
  dbPath: ["./data.db", 'override the SQLite file (":memory:" for tests)'],
  persistDebounceMs: ["100", "ms between KV writes"],
  persistMode: [
    '"single"',
    '"single" (one JSON blob) or "multi" (one SQLite row per top-level cell — rewrites only changed cells)',
  ],
  port: ["8000", "HTTP/WS server port"],
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
  beforeReduce: ["", "intercept actions before reduce — return null to drop"],
  users: ["", "static token→user map for auth"],
  key: [
    "auto",
    "--expose auth key: string=fixed, false=open, omitted=persisted",
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

const UI_DOCS: Record<string, [string, string]> = {
  title: ['"AIO App"', "window title"],
  width: ["800", "window width (px)"],
  height: ["600", "window height (px)"],
  showStatus: ["true", "show connection status indicator"],
};

const CONFIG_GROUPS: [string, string[]][] = [
  ["Server & transport", [
    "port",
    "baseDir",
    "client",
    "keepServer",
    "transport",
    "killExisting",
    "serverUrl",
    "singleton",
    "users",
    "key",
    "key",
    "syncIntervalMs",
    "fullStateThreshold",
    "routes",
    "maxConnections",
  ]],
  ["App logic", [
    "beforeReduce",
    "isolate",
    "persist",
    "persistKey",
    "dbPath",
    "appDir",
    "dbPragmas",
    "checkIntegrityOnBoot",
    "persistDebounceMs",
    "persistMode",
    "onRestore",
    "db",
    "schedules",
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
    "renderBudget.staleness",
    "renderBudget.pendingPatches",
    "effectTimeoutMs",
    "freezeState",
    "memory",
    "circuitBreaker",
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
      ["appId", "appVersion", "cells"],
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
    console.error(
      `\n[aio] CONFIG ERROR: unknown ${label} key(s): ${unknown.join(", ")}`,
    );
    console.error(`\n[aio] Valid configuration:\n`);
    console.error(formatValidConfig());
    exit(1);
  }
}
