// Runtime config validation & documentation — extracted from aio.ts (AIO-52)
// Types are erased at runtime. These sets are the runtime source of truth.
// If you add a key to AioConfig, CellsConfig, or UiConfig — add it here too.

export const VALID_UI_KEYS = new Set<string>([
  "title",
  "width",
  "height",
  "showStatus",
  "renderer",
]);

export const VALID_AIO_CONFIG_KEYS = new Set<string>([
  "appId",
  "reduce",
  "execute",
  "persist",
  "fullStateThreshold",
  "syncIntervalMs",
  "maxConnections",
  "beforeReduce",
  "persistKey",
  "persistDebounceMs",
  "persistMode",
  "users",
  "resolveUser",
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
  "onAction",
  "onEffect",
  "onConnect",
  "onDisconnect",
  "onStart",
  "onStop",
  "onError",
  // internal keys (prefixed with _)
  "_onScheduleReady",
  "_diagnostics",
  "_onCheckpointRestore",
  "_cellNames",
  "_healthGetter",
  "_reduceBreakdown",
  "_onReportOptsReady",
  "_syncCellIds",
  "_getDBState",
  "_getUIState",
  "_cellPatchStrategies",
  "_cellFilterFields",
  "_cellMigrations",
  "_cellVersions",
]);

export const VALID_FEATURES_CONFIG_KEYS = new Set<string>([
  "appId",
  "cells",
  "cellDefaults",
  "port",
  "persist",
  "persistKey",
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
  "resolveUser",
  "db",
  "perfCheck",
  "perfBudget",
  "renderBudget",
  "effectTimeoutMs",
  "freezeState",
  "memory",
  "circuitBreaker",
  "singleton",
  "syncIntervalMs",
  "fullStateThreshold",
  "maxConnections",
  "schedules",
  "middleware",
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
  reduce: ["", "state reducer (legacy API)"],
  execute: ["", "effect executor (legacy API)"],
  persist: ["true", "auto-open Deno.Kv for state persistence"],
  persistKey: ['"state"', "KV key prefix"],
  persistDebounceMs: ["100", "ms between KV writes"],
  persistMode: [
    '"single"',
    '"single" (one blob ≤64KB) or "multi" (one key per top-level state key)',
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
  maxConnections: ["100", "max concurrent WebSocket clients"],
  beforeReduce: ["", "intercept actions before reduce — return null to drop"],
  users: ["", "static token→user map for auth"],
  resolveUser: [
    "",
    "dynamic (token,state)→user hook for runtime auth (AIO-171)",
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
  effectTimeoutMs: ["30000", "warn for slow async effects (ms)"],
  freezeState: [
    "dev:true",
    "deep freeze state after reduce to catch mutations",
  ],
  memory: ["", "memory pressure monitoring config"],
  circuitBreaker: ["", "auto-disable cells after N errors"],
  diagnostics: ["auto", "state diffs, action log, checkpoint, crash handler"],
  logging: ["true", "structured logging — false to disable"],
  schedules: ["", "static scheduled effects — started on boot"],
  middleware: ["", "middleware array — applied in order as beforeReduce chain"],
  isolate: ["", "run only these cells (dev convenience)"],
  onAction: ["", "called after every action"],
  onEffect: ["", "called after every effect"],
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
    "syncIntervalMs",
    "fullStateThreshold",
    "maxConnections",
  ]],
  ["App logic", [
    "beforeReduce",
    "middleware",
    "isolate",
    "persist",
    "persistKey",
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
    ...table("REQUIRED", ["appId", "appVersion", "cells"], CONFIG_DOCS),
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
