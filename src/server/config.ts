import { log } from "../diagnostics/logger-api.ts";
import { teachMessage } from "../diagnostics/error.ts";
import { hasBothFilterModes, nearestOf } from "../state/cell-helpers.ts";
import { classifySource } from "./updates-core.ts";
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
  "share", // a declared workspace share (see app-dirs.ts resolveShare)
  // aio's
  "appId",
  "title",
  "client", // (its pre-alpha52 spelling `target` is a removals.ts row —
  //           read only to refuse/log it, see `retiredDenoJsonKeys`)
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
  "_workerEntry",
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
  "_cellAsyncMethods",
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
  "_workerEntry", // internal: testServer({ workers: "real" })
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
    'release source URL ("https://…" / "file://…" / a git repo) — or { source, kind, auto, check, channel, key, keys, canApply, allowUnsigned, prerelease }',
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
  allowedOrigins: [
    "",
    "extra hosts/origins this app may be reached as — the WS Origin check AND the Host (DNS-rebinding) gate read this one list",
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
    '"tokens"',
    'default stylesheet — "tokens" (variables only, nothing paints) | "auto" (steps aside for your style.css) | "full" (keep it alongside yours) | "none"',
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
        `unknown ${label} key(s): ${named.join(", ")}`,
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
    if (v !== undefined && !allowed.includes(v as string)) {
      const near = typeof v === "string" ? nearestOf(v, allowed) : null;
      log.error(
        teachMessage(
          `${label}.${key} is ${JSON.stringify(v)}, which is not one of ${
            allowed.map((a) => JSON.stringify(a)).join(", ")
          }`,
          near
            ? `did you mean ${JSON.stringify(near)}?`
            : `use one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}`,
        ),
      );
      exit(1);
    }
  }
  // ── Couplings between keys that are each individually valid ──────────
  //
  // Only from the TOP-LEVEL pass: the `ui` pass sees `{ width, height }` with
  // no `client` beside it, and half a config cannot answer a question about
  // two keys.
  if (label === "ui") return;
  for (const c of configConflicts(obj)) {
    // Deduped by text: `aio.run()` validates the CellsConfig on the way in and
    // the composed AioConfig on the way through, so every conflict is seen
    // twice in one boot and a diagnostic printed twice reads as a loop.
    if (_reportedConflicts.has(c.what)) continue;
    _reportedConflicts.add(c.what);
    const msg = teachMessage(c.what, c.fix, c.doc);
    if (c.level === "error") {
      log.error(msg);
      exit(1);
    } else {
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

  // ── 6. killExisting with no lock to take over ────────────────────────
  const singletonOff = cfg.singleton === false || cfg.libraryMode === true;
  if (cfg.killExisting === true && singletonOff) {
    const why = cfg.singleton === false
      ? "singleton: false"
      : "libraryMode: true";
    out.push({
      level: "error",
      keys: [
        "killExisting",
        cfg.singleton === false ? "singleton" : "libraryMode",
      ],
      what:
        `killExisting asks to take over the running instance, but ${why} means no instance ` +
        `lock is acquired at all — nothing is killed, nothing is taken over, and a second ` +
        `copy simply starts alongside the first`,
      fix:
        `remove killExisting, or remove ${why} so there is a single instance to take over`,
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

  // ── 11. two session TTLs, and each is read by a different half ───────
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
