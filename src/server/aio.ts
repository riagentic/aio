import { validateMemoryConfig } from "../diagnostics/memory-monitor.ts";
import { refuseRetired } from "../state/removals.ts";
// Core runtime orchestrator — boots KV, server, electron, wires everything together.
// Phase logic lives in aio-boot, aio-dispatch, aio-server, aio-lifecycle, aio-run-helpers.
// Cell composition logic lives in aio-composition and aio-cells-bridge.

import {
  APP_STYLE,
  appHasStylesheet,
  BUNDLE_JS,
  UI_ENTRY,
} from "./app-files.ts";
import { readLocalPinSync } from "./deno-json.ts";
import { createShutdownOrchestrator, registerRuntime } from "./shutdown.ts";
import { _registerAuthStore } from "./auth-context.ts";
import type { ServerHandle } from "./server-types.ts";
import type { UDSHandle } from "./uds.ts";
import {
  createTT,
  pause,
  record,
  redo,
  resume,
  stateAt,
  toBroadcast,
  travelTo,
  type TTState,
  undo,
} from "../diagnostics/time-travel.ts";
import { createScheduleManager } from "../state/schedule.ts";
import { createOwnManager, isOwnEffect } from "../state/own.ts";
import { getLogger, log, setLogger } from "../diagnostics/logger-api.ts";
import type { LogSink } from "../diagnostics/logger-types.ts";
import { timeTravelEnabled } from "../diagnostics/types.ts";
import { teachableError } from "../diagnostics/error.ts";

// Phase modules — extracted _run() logic
import { bootStorage, isDevBoot, replaySyncOps } from "./aio-boot.ts";
import { replayJournal } from "./journal.ts";
import { createTimeline } from "./timeline.ts";
import { makeRedactor } from "../diagnostics/redact.ts";
import { actionOrigin, isWriteSetAction } from "../diagnostics/action-kind.ts";
import { setupDispatch } from "./aio-dispatch.ts";
import { hostedCellName, startCellWorkerHost } from "./cell-worker-host.ts";
import { createCellWorkerPool } from "./cell-worker-pool.ts";
import { isScheduleEffect } from "../state/schedule.ts";
import {
  currentHeapLimitBytes,
  describeHeapPolicy,
  physicalMemoryBytes,
  reportHeapCeiling,
} from "./heap-policy.ts";
import type { Provenance } from "./boot-facts.ts";
import {
  appDirs,
  checkUnpackLocation,
  ensureAppDirs,
  registerAppDirs,
  resolveAppDirs,
  sweepAppPayloadDir,
  writeAppMeta,
} from "./app-dirs.ts";
import { openBlobStore } from "./blobs.ts";
import { resolveDataDirLegacy } from "./paths.ts";
import { describeMigration, migrateLegacyLayout } from "./app-dirs-migrate.ts";
import { DEV_FRAME_BUDGET_MS } from "../state/dispatch.ts";
import { setupTransport } from "./aio-server.ts";
import {
  requestRestart,
  requestStop,
  type RestartPlan,
  startLifecycle,
} from "./aio-lifecycle.ts";
import {
  acquireSingletonLock,
  appDenoJson,
  buildAppObject,
  buildOnPerf,
  buildReportOpts,
  createMemoizedUIState,
  createUdsBroadcastController,
  handleThinClient,
  initDiagAndVitals,
  resolveTitle,
  startVitalsCheck,
} from "./aio-run-helpers.ts";
import { appDenoJsonLocated } from "./aio-run-helpers.ts";
import {
  outDirExclude,
  readBuildStamp,
  readTreeFacts,
  resolveRuntimeVersion,
} from "./app-version.ts";

// Cells-based API modules
import { composeCellsWiring } from "./aio-composition.ts";
import { _setCallTimeouts } from "../state/cell-impl.ts";
import {
  buildLegacyConfig,
  filterCellsByIsolate,
  initLogger,
  wrapAppWithCells,
} from "./aio-cells-bridge.ts";
import { getRegisteredCells } from "../state/cell-reactive.ts";
import { createUpdatesCell } from "../state/updates-cell.ts";
import { createFeedbackCell } from "../state/feedback-cell.ts";
import { createCostMeter } from "../vitals/cost-meter.ts";

// CLI + path resolution
import {
  cdpPort,
  declareAppFlags,
  parseCli,
  printHelp,
  VERSION,
  versionLine,
} from "./aio-cli.ts";
import { awaitPredecessor } from "./updates-apply.ts";
import { beginFeedback, startFeedback } from "./feedback-boot.ts";
import {
  beginUpdates,
  confirmPendingUpdate,
  judgePendingUpdate,
  startUpdates,
  ttyPrompt,
} from "./updates-boot.ts";
import { PERSIST_SCHEMA_VERSION } from "./persist-schema.ts";
import { deriveDataContract } from "./updates-core.ts";
import {
  distCandidates,
  envPort,
  findFreePort,
  isCompiled,
  realDistCandidates,
} from "./paths.ts";
import { openSessionStore, type SessionStore } from "./sessions.ts";
import { openUserStore } from "./auth-users.ts";
import { resolveAppId } from "./single-instance-lock.ts";
import { appKeyPath, defaultAppKeyConfig, resolveAppKey } from "./app-key.ts";
import { assertDenoVersion } from "./deno-version.ts";
import { removalMessage, removalOf } from "../state/removals.ts";
import { basename, dirname, fromFileUrl, join, resolve } from "@std/path";
import { lint, printLint } from "./lint.ts";
import { composeAsyncHooks, composeHooks, resolvePlugins } from "./plugin.ts";
import { setFallbackLogDir } from "../diagnostics/logger-api.ts";
import { installProcessSignals } from "./shutdown.ts";

// ── Re-exports: public API surface ────────────────────────────────────
export { VERSION } from "./aio-cli.ts";
export { parseCli, printHelp } from "./aio-cli.ts";
export type { CliFlags } from "./aio-cli.ts";
export { createUDSListener, type UDSHandle } from "./uds.ts";
export type { AioError } from "../diagnostics/error.ts";
export type { PerfBudget, PerfCheck } from "../state/dispatch.ts";
export { checkCells, type Lint, lint } from "./lint.ts";
export {
  type CellDef,
  type CellEntry,
  type ComposedCells,
} from "../state/cell.ts";

// Re-export types (defined in aio-types.ts, re-exported here for consumers)
export type {
  AioApp,
  AioConfig,
  AioUser,
  CellsConfig,
  ResolveUserFn,
  UiConfig,
} from "./aio-types.ts";
import type {
  AioApp,
  AioConfig,
  AioUser,
  CellsConfig,
  UiConfig,
} from "./aio-types.ts";

// Re-export config validation (defined in config.ts)
export {
  VALID_AIO_CONFIG_KEYS,
  VALID_FEATURES_CONFIG_KEYS,
  VALID_UI_KEYS,
  validateConfig,
} from "./config.ts";
import {
  misplacedDenoJsonKeys,
  retiredDenoJsonKeys,
  VALID_AIO_CONFIG_KEYS,
  VALID_FEATURES_CONFIG_KEYS,
  VALID_UI_KEYS,
  validateConfig,
} from "./config.ts";
import { count } from "../diagnostics/fmt.ts";

/** Default broadcast throttle: 50ms = max 20 state pushes/sec */
export const DEFAULT_SYNC_INTERVAL_MS = 50;

// ── Module-level state ────────────────────────────────────────────────
let _electronProc: Deno.ChildProcess | null = null;

/** Validates that framework version matches deno.json version at build time */
function validateVersion(): void {
  try {
    const denoJson = new URL("../../deno.json", import.meta.url);
    const content = Deno.readTextFileSync(denoJson);
    const parsed = JSON.parse(content) as { version?: string };
    if (parsed.version && parsed.version !== VERSION) {
      log.warn(
        "aio",
        `version mismatch: aio.ts=${VERSION}, deno.json=${parsed.version}`,
      );
    }
  } catch { /* deno.json not accessible at runtime — skip */ }
}
validateVersion();

// ── Entry point ───────────────────────────────────────────────────────

/** THE decider for "is this app reachable off loopback?" — nothing else in the
 *  framework may answer that question its own way.
 *
 *  It used to be answered twice: `parseCli().expose` for the `ui:"all"` privacy
 *  warning, and `cli.expose ?? false` for the transport. That was survivable
 *  only while `--expose` was the sole source; the moment `expose` became a
 *  config key (a compiled binary in a service unit has no shell flags), a
 *  config-exposed app would have bound 0.0.0.0 with the privacy warning
 *  silently switched off — a quiet failure exactly where it costs most.
 *
 *  CLI wins over config: the operator running the binary overrides the author.
 *  Structural param so it works for both CellsConfig (outer `run`) and
 *  AioConfig (inner `_run`) without importing either.
 *
 *  `host` IS an exposure decision, and it was a SECOND, unguarded one.
 *  `host: "0.0.0.0"` (or a LAN address, or `--host=…`) binds every interface
 *  while `expose` stayed false — so no shared key was generated, no auto-TLS
 *  ran, `strictOrigin` was ignored and not one of the "this app is OPEN"
 *  warnings fired. The app was reachable from the network with no credential
 *  at all, which is precisely the state `--expose` exists to make loud. This
 *  function's whole reason to exist is that exposure has ONE decider, so it
 *  reads both keys. A loopback `host` (the default, or an explicit
 *  `--host=127.0.0.1`) is not exposure and changes nothing. */
export function _exposeOf(
  cli: { expose?: boolean; host?: string },
  config: { expose?: boolean; host?: string },
): boolean {
  if (cli.expose ?? config.expose ?? false) return true;
  return _hostIsExposed(cli.host ?? config.host);
}

/** WHY this app counts as exposed, spelled the way its author wrote it.
 *
 *  Mirrors {@link _exposeOf} branch for branch, because a warning that names
 *  the wrong cause costs more time than no warning at all: once a non-loopback
 *  `host` became a second source of exposure, every "--expose with …" line was
 *  telling an author about a flag they had never typed. Three call sites spelled
 *  this fact for themselves and two of them were wrong the moment that landed —
 *  so it is decided here, once. */
export function exposeReason(
  cli: { expose?: boolean; host?: string },
  config: { expose?: boolean; host?: string },
): string {
  if (cli.expose) return "--expose";
  if (config.expose) return "expose: true";
  if (cli.host && _hostIsExposed(cli.host)) return `--host=${cli.host}`;
  const h = config.host;
  if (h && _hostIsExposed(h)) return `host: ${JSON.stringify(h)}`;
  return "--expose";
}

/** True when binding this host reaches something other than loopback.
 *  Unknown/unparsable names fail CLOSED (treated as exposed): an app bound to
 *  a name we cannot classify must get the loud treatment, not the quiet one. */
export function _hostIsExposed(host: string | undefined): boolean {
  if (host === undefined) return false;
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "") return false;
  return !(h === "127.0.0.1" || h === "::1" || h === "localhost" ||
    h.startsWith("127."));
}

/** Resolve `config.tls` into the three transport knobs the server reads.
 *  THE tls decider — the CLI flags override its result in ONE place (the
 *  aio-server call site), and an unusable shape is refused here, at boot,
 *  instead of surfacing as a handshake failure later.
 *
 *  Config exists for the same reason `expose` does: a compiled binary started
 *  by a service unit has no shell flags, so "how this app serves" has to be
 *  expressible in code (R-7). */
/** Warn when the aio actually running is not the aio the app pinned.
 *
 *  `dep/aio` is often a SYMLINK to a live checkout, so "the installed version"
 *  is whatever that tree is this minute. An app declared alpha55 and was
 *  running alpha61 plus uncommitted work — six releases of drift, discovered
 *  by a semantics change nobody could explain. The framework knows both
 *  numbers; the app should not have to run a linter to learn they differ.
 *
 *  A WARNING, not a refusal: developing against a moving checkout is a
 *  legitimate workflow (it is how aio itself is developed). What is not
 *  legitimate is doing it silently. Once per process. */
let _pinWarned = false;
export function _warnPinDrift(): void {
  if (_pinWarned) return;
  _pinWarned = true;
  // A local path override (`.aio/pin.local`) IS the pin on this machine; the
  // committed `aioVersion` is what other clones get. Nothing to compare here.
  if (readLocalPinSync(Deno.cwd())) return;
  const declared = appDenoJson()?.aioVersion;
  if (typeof declared !== "string" || declared === "") return;
  // A path pin (`path:/abs/checkout`) IS "whatever that tree is" by
  // construction — the developer said so. Nothing to compare.
  if (declared.startsWith("path:")) return;
  const want = declared.replace(/^v/, "");
  if (want === VERSION) return;
  log.warn(
    `version: this app pins aio ${declared} (deno.json aioVersion) but is ` +
      `RUNNING ${VERSION}. Everything below — defaults, semantics, the wire ` +
      `protocol — is ${VERSION}'s. Run \`am pin ${declared}\` to get what the ` +
      `app declares, or \`am pin --latest\` to record what it is running.`,
  );
}

/** What boot says about `ui.theme`, or null when there is nothing to say.
 *
 *  Pure so it can be tested: both lines are documented behaviour in shipped
 *  upgrade guides ("Boot says so, once"), and the `"full"` one was silently
 *  wrong in every compiled binary for two releases because the stylesheet
 *  probe behind it looked in one directory. A line the framework promises is a
 *  line a test owes. */

export function _themeBootNote(
  theme: UiConfig["theme"],
  styled: boolean,
): { level: "info" | "warn"; message: string } | null {
  if (theme !== "full" && theme !== "auto") return null;
  if (theme === "full" && styled) {
    return {
      level: "warn",
      message:
        `theme: ui.theme "full" — aio's complete stylesheet is emitted ALONGSIDE ` +
        `your ${APP_STYLE}, so its rules apply wherever your CSS is silent ` +
        `(a cascade layer settles conflicts, not silence). That is what this ` +
        `setting is for; "auto" steps aside instead, and ` +
        `\`am theme adopt\` hands you the CSS to own.`,
    };
  }
  if (styled) return null; // "auto" + a stylesheet: the app owns the stage
  return {
    level: "info",
    message:
      `theme: aio's default look is in effect (ui.theme "${theme}", no ` +
      `${APP_STYLE}) — it styles semantic HTML plus .card/.row/.stack/` +
      `.grid/.badge, and \`<main>\` becomes a centred page container. ` +
      `Write ${APP_STYLE} and every visual default steps aside.`,
  };
}

export function _tlsOf(
  config: { tls?: "auto" | false | { cert: string; key: string } },
): { cert?: string; key?: string; noTls: boolean } {
  const t = config.tls;
  if (t === undefined || t === "auto") return { noTls: false };
  if (t === false) return { noTls: true };
  if (
    typeof t === "object" && t !== null &&
    typeof (t as { cert?: unknown }).cert === "string" &&
    typeof (t as { key?: unknown }).key === "string" &&
    (t as { cert: string }).cert !== "" && (t as { key: string }).key !== ""
  ) {
    return { cert: t.cert, key: t.key, noTls: false };
  }
  throw new Error(
    `[aio] invalid \`tls\` config: ${JSON.stringify(t)} — use "auto" ` +
      `(self-signed, the default), false (plain HTTP; sound only behind a ` +
      `TLS-terminating proxy or with an already-encrypted payload), or ` +
      `{ cert: "./cert.pem", key: "./key.pem" }.`,
  );
}

/** The app's own `version` — from THE app-deno.json decider
 *  ({@link appDenoJson}), entry-relative and never the launch cwd. A compiled
 *  binary launched from an unrelated project's directory used to read THAT
 *  project's deno.json and report its version as its own: the exact
 *  identity-adoption bug `resolveAppId` guards against, one field down. */
/** One-time boot warning for aio-shaped keys at the top level of deno.json.
 *
 *  Once per process, like every other boot hint here: `parseCli`-adjacent code
 *  runs several times in one boot and a repeated diagnostic reads as a loop. */
let _hintedMisplacedDenoJson = false;
function _warnMisplacedDenoJson(): void {
  if (_hintedMisplacedDenoJson) return;
  const stray = misplacedDenoJsonKeys(appDenoJson());
  if (stray.length === 0) return;
  _hintedMisplacedDenoJson = true;
  log.warn(
    `deno.json has aio config at the TOP LEVEL — aio never reads it there, ` +
      `so ${stray.map((k) => `"${k}"`).join(", ")} ${
        stray.length === 1 ? "is" : "are"
      } silently doing nothing. Move ${
        stray.length === 1 ? "it" : "them"
      } into aio.run({ ${stray.join(", ")} }) in your app entry. ` +
      `(deno.json carries only identity and build: appId, title, client, ` +
      `entry, build, version.)`,
  );
}

let _appVersionCache: Promise<string> | undefined;
/** THE version this process reports — `major.minor.<commit count>`, the same
 *  string the build stamps into an artifact. Resolved ONCE per process
 *  (`resolveRuntimeVersion` is the pure rule; see app-version.ts): a compiled
 *  binary reads the stamp the build embedded, a source run derives it from
 *  the app's own repository — with
 *  `-dirty.<hash8>` when the tree is dirty, exactly as a build would name it.
 *
 *  It used to fall back to `"0.0.0"` — a CONFIDENT WRONG NUMBER, printed
 *  exactly when "which build is this?" matters most. An unknown version now
 *  SAYS unknown, and the update check refuses the string by name. */
export function _appVersion(): Promise<string> {
  _appVersionCache ??= (async () => {
    const located = appDenoJsonLocated();
    const compiled = isCompiled();
    const stamp = located ? readBuildStamp(located.dir) : null;
    let tree = null;
    if (!compiled && located && located.dir.protocol === "file:") {
      const root = fromFileUrl(located.dir);
      tree = await readTreeFacts(root, {
        excludes: [
          outDirExclude(
            root,
            (located.config.build as { out?: string } | undefined)?.out,
          ),
        ],
      });
    }
    return resolveRuntimeVersion({
      declared: located?.config.version,
      compiled,
      stamp,
      tree,
    });
  })();
  return _appVersionCache;
}

/** THE default client when no `--client` flag is given: the app's config,
 *  else deno.json's build target, else electron. Boot and `--help` both read
 *  this one function, so what help prints is what boot does. */
export function defaultClientFor(configClient?: string): string {
  return configClient ?? _denoJsonTargetClient() ?? "electron";
}

/** What `--help` says about THIS invocation: a compiled binary is run by its
 *  own name, a source app by `deno run`. */
function _helpFacts(
  configClient?: string,
): { usage: string; defaultClient: string } {
  return {
    usage: isCompiled()
      ? `${basename(Deno.execPath())} [flags]`
      : "deno run -A src/app.ts [flags]",
    defaultClient: defaultClientFor(configClient),
  };
}

/** The app's `client` from ITS OWN deno.json (written by `am create
 *  --target=…`) as a client-mode default. Makes the scaffolded `deno task dev`
 *  (no --client flag) run the CHOSEN target instead of the framework's electron
 *  fallback. `server` → `server-only` (aio's name for "no client UI");
 *  `android` → the browser client (the android dev flow's emulator connects to
 *  the same dev server).
 *
 *  The key was called `target` before alpha52 (renamed: deno.json also carries
 *  `build.targets`, a DIFFERENT axis — two meanings of "target" in one file).
 *  The old spelling was retired in alpha70 (src/state/removals.ts): dev
 *  refuses by name, prod logs — `am fix` renames it.
 *
 *  Entry-relative via {@link appDenoJson}, like `version` and `title`: read
 *  from the launch cwd, a compiled `"client": "browser"` app started anywhere
 *  else fell back to ELECTRON and began downloading a ~100MB runtime on a
 *  headless server — or picked up an unrelated project's target. */
export function _denoJsonTargetClient():
  | "browser"
  | "electron"
  | "cli"
  | "server-only"
  | undefined {
  const dj = appDenoJson();
  // Retired keys (`target`, …) are refused in dev and logged in prod by ONE
  // decider — never silently read as the new spelling.
  if (dj) {
    for (const r of retiredDenoJsonKeys(dj)) refuseRetired(r, "deno.json");
  }
  // In prod the retired key was logged above and is still HONOURED — an app
  // that only ever said `target` must not silently boot as another shell.
  const raw = dj?.client ?? (dj as { target?: unknown } | undefined)?.target;
  switch (raw) {
    case "browser":
    case "android":
      return "browser";
    case "electron":
      return "electron";
    case "cli":
      return "cli";
    case "server":
      return "server-only";
    default:
      return undefined;
  }
}

function _inferBaseDir(): string {
  try {
    const main = new URL(Deno.mainModule);
    if (main.protocol === "file:" && !isCompiled()) {
      const dir = main.pathname.split("/").slice(0, -1).join("/");
      if (dir) return dir;
    }
  } catch { /* unusual entry — fall through */ }
  return join(Deno.cwd(), "src");
}

/** A LogSink that writes EVERY line to stderr — installed only for
 *  `--aio-data-contract`, whose stdout is a machine-read JSON document.
 *
 *  Nothing is dropped: a boot that fails while answering the query must still
 *  say why, and `2>&1` puts it all back. Only the stream changes. */
function stderrOnlyLogSink(): LogSink {
  return {
    logDir: "",
    pub(lvl, cat, msg, data) {
      const d = data ? "  " + JSON.stringify(data) : "";
      // aio-ok: this IS the levelled sink, redirected. `--aio-data-contract`
      // must put ONLY its JSON on stdout (aio's own `ship` parses it), so
      // every framework line is re-emitted on stderr — nothing is dropped,
      // `2>&1` restores the normal view, and the level is carried in the text.
      console.error(`${lvl.toUpperCase()}  ${cat}  ${msg}${d}`);
    },
    perf() {},
    flush() {
      return Promise.resolve();
    },
  };
}

/** Single entry point — boots KV, server, electron, wires everything. CLI
 *  args override config. (perfect-aio D9: the legacy 2-arg
 *  `aio.run(initialState, config)` overload was removed — zero callers
 *  existed; `aio.run({ cells })` / zero-config `aio.run()` is the API.)
 *
 *  Optionally TYPED (alpha52, additive): `aio.run<MyAppState>({ cells })`
 *  types `app.state` / `app.getState()` instead of `any`. The default stays
 *  `any` for compatibility — existing untyped calls infer exactly as before. */
// deno-lint-ignore no-explicit-any
async function run(fc?: CellsConfig): Promise<AioApp<any, any>>;
// Typed overload — selected only by an explicit type argument, so untyped
// calls keep the exact pre-alpha52 `any` inference (no new circularity in
// configs whose closures reference the resulting app).
async function run<S extends Record<string, unknown>>(
  fc?: CellsConfig,
  // deno-lint-ignore no-explicit-any
): Promise<AioApp<S, any>>;
// deno-lint-ignore no-explicit-any
async function run(a?: any, b?: any): Promise<AioApp<any, any>> {
  // ── `--help` is a QUERY: it must not boot the app ──
  //
  // This check used to live in `_run`, three phases later — by which time the
  // composition report had printed ("cells: counter", "cells: counter
  // visible=all persist=all") and, worse, the logger had ROTATED the app's log
  // files: `app.log` → `app.log.1`, one generation lost off the end of `keep`
  // every time someone asked what the flags were. Asking a binary for its usage
  // is the safest thing anyone does with it; it must have no side effects at
  // all. Same reasoning as `--aio-data-contract` below, one step earlier.
  if (parseCli().help) {
    printHelp(_helpFacts(typeof a === "object" && a ? a.client : undefined));
    Deno.exit(0);
  }
  // Fail fast on an unsupported Deno — aio uses ≥2.9 behavior directly.
  assertDenoVersion();
  if (b !== undefined) {
    // Message comes from the removal registry — one decider for every
    // "that spelling is gone" the framework prints (src/state/removals.ts).
    throw new Error(removalMessage(removalOf("aio.run(initialState, config)")));
  }

  // Cells-based API: aio.run(cellsConfig) — zero-config: aio.run()
  let fc = (a ?? {}) as CellsConfig;
  // ── Plugins ──
  //
  // FIRST, before any other config key is read, so every reader below sees one
  // merged config and no code path can be written that forgets plugins exist.
  //
  // Everything a plugin contributes goes through the SAME keys `aio.run()`
  // already has — cells, routes, schedules, allowedOrigins, the observe-only
  // hooks — so a plugin can never do anything the app could not have written
  // itself, and reading the merged config still explains the whole app. The
  // app's own values are applied OVER the plugins': adding a plugin can never
  // take a behaviour away. A collision between two plugins throws at boot,
  // naming both, because whichever loaded second would otherwise silently
  // shadow the first.
  const _plugins = await resolvePlugins(fc.plugins, {
    appId: resolveAppId(fc.appId),
    dev: isDevBoot(),
  });
  if (_plugins.names.length) {
    const _pluginErr = (e: unknown) => log.error(`plugin hook error: ${e}`);
    fc = {
      ...fc,
      routes: Object.keys(_plugins.routes).length
        // App last: an app route with the same pattern wins, deliberately.
        ? { ..._plugins.routes, ...(fc.routes ?? {}) }
        : fc.routes,
      schedules: _plugins.schedules.length
        ? [..._plugins.schedules, ...(fc.schedules ?? [])]
        : fc.schedules,
      allowedOrigins: _plugins.allowedOrigins.length
        ? [
          ...new Set([
            ...(fc.allowedOrigins ?? []),
            ..._plugins.allowedOrigins,
          ]),
        ]
        : fc.allowedOrigins,
      onAction: composeHooks(_plugins.onAction, fc.onAction, _pluginErr),
      onEffect: composeHooks(_plugins.onEffect, fc.onEffect, _pluginErr),
      onConnect: composeHooks(_plugins.onConnect, fc.onConnect, _pluginErr),
      onDisconnect: composeHooks(
        _plugins.onDisconnect,
        fc.onDisconnect,
        _pluginErr,
      ),
      onStart: composeAsyncHooks(
        _plugins.onStart,
        fc.onStart,
        "start",
        _pluginErr,
      ),
      // Unwinding order: the app's own `onStop` runs FIRST, then plugins in
      // reverse, so a plugin that opened something in `onStart` closes it
      // after the app code that was using it has finished.
      onStop: composeAsyncHooks(_plugins.onStop, fc.onStop, "stop", _pluginErr),
      _pluginNames: _plugins.names,
    } as CellsConfig;
  }
  // ── `--aio-data-contract` is a QUERY, and its stdout is MACHINE-READ ──
  //
  // `aio ship` and `updates-rebuild` run `<binary> --aio-data-contract` and
  // JSON.parse its stdout. Booting normally wrote the composition report, the
  // log-rotation notice and the contract itself through the logger, so stdout
  // was four INFO lines plus a JSON body whose first line carried a timestamp
  // preamble — unparseable, and `ship` silently published every release with
  // "data NOT DECLARED", which is the guarantee the update feature leads with.
  // Silencing by level is not the fix either (it removed the contract too).
  // So: for this mode ONLY, every framework line goes to stderr for the whole
  // boot and stdout carries the JSON and nothing else (printed raw, below).
  // Observe-only, and identical in dev and prod.
  const _contractMode = parseCli().dataContract;
  if (_contractMode) setLogger(stderrOnlyLogSink());
  // `appVersion` is retired (alpha70): deno.json `version` is the ONE place
  // an app's version is decided (docs/build/versioning.md). Dev refuses;
  // prod logs the registry line and IGNORES the key — the derived version is
  // what every surface reports either way.
  if ("appVersion" in fc) {
    refuseRetired(removalOf("aio.run({ appVersion })"), "aio.run");
    delete (fc as Record<string, unknown>).appVersion;
  }
  validateConfig(
    fc as unknown as Record<string, unknown>,
    VALID_FEATURES_CONFIG_KEYS,
    "CellsConfig",
  );
  // BEFORE anything reads argv. The app's own verbs join aio's vocabulary
  // here, so a declared flag is passed through rather than refused — and a
  // typo in one gets the same did-you-mean as a typo in aio's own.
  declareAppFlags(fc.appFlags);
  if (fc.ui) {
    validateConfig(fc.ui as Record<string, unknown>, VALID_UI_KEYS, "ui");
    if (fc.memory) validateMemoryConfig(fc.memory as Record<string, unknown>);
  }
  // …and the OTHER file people put aio config in. `aio.run()` refuses an
  // unknown key loudly; deno.json accepted `ui: { width, height }` at the top
  // level, did nothing with it, and said nothing about it — the shape a field
  // report called "the worst available behaviour", and it became a bullet in
  // their project docs instead of a message from us. Warn (not throw): the
  // file belongs to Deno and other tools keep their own sections in it, so the
  // right answer is to name the key and where it belongs.
  _warnMisplacedDenoJson();
  // Multi-instance (perfect-aio D2): several aio.run() calls may coexist in
  // one process — each app's cells bind exclusively (bindCell throws on a
  // def already bound to another app), each appId takes its own singleton
  // lock, and zero-config auto-cells only work for the FIRST app (later apps
  // must pass explicit disjoint `cells:` lists — the bind error says so).

  try {
    // Configuring `updates` registers the built-in cell — BEFORE the registry
    // is read below, because a cell that registers afterwards is never composed
    // and never bound.
    //
    // A CALL, not a dynamic import. These were `await import(…)`, chosen
    // because `cell()` self-registers and a static import would have put the
    // cell in every app that never asked for one. But a dynamic import from
    // inside a function the app top-level-awaits can deadlock module
    // evaluation — the app hangs at boot with no banner and Deno reporting
    // "module evaluation is still pending … This is a bug in Deno", which
    // names neither aio nor the app. The factories register on call, so the
    // opt-in property survives and the hazard does not.
    //
    // KEEP THE HANDLE. Registering is only half the job: an app that also
    // passes an explicit `cells:` list makes the registry unreadable below,
    // so aio created its own cell, dropped it on the floor, printed
    // `updates  prod · manifest · every 6h · ask first` in the boot report,
    // and only THEN called `beginUpdates()` — which threw as an unhandled
    // rejection, after the success banner, leaving the app running with the
    // feature dead. A field report (dm) shipped a self-update that could
    // never run for the app's whole life, green in every test and every
    // `deno task dev`, because the config that reaches this branch only
    // exists in a released build.
    const _builtins = [
      fc.updates ? createUpdatesCell() : undefined,
      fc.feedback ? createFeedbackCell() : undefined,
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);

    // Isolate filter
    const cliIsolate = parseCli().isolate;
    const isolate = fc.isolate ?? cliIsolate;
    // Zero-config cells: every cell() self-registers on definition — boot
    // whatever the entry imported (same behavior as the standalone runtime).
    //
    // A plugin's cells are added to whichever list applies. A plugin cell
    // whose id the app ALSO declares is dropped, not deduplicated by ordering:
    // the app's definition is the one that survives, which is rule 1 (the app
    // always wins). Zero-config apps need this — every `cell()` self-registers
    // on import, so a plugin's cells are already in the registry list and
    // adding them again would be the same cell twice. `composeCells` still
    // refuses a genuine clash between two DIFFERENT cells sharing an id.
    const _declared = fc.cells && fc.cells.length > 0
      ? fc.cells
      : [...getRegisteredCells().values()];
    // aio's OWN cells are appended to whatever the app declared, deduped by
    // id — the app's definition still wins if it listed the same cell itself.
    // The config asked for the feature; dropping the cell that implements it
    // because the app also spelled out its own list serves no one, and the
    // plugin merge directly below has always worked exactly this way.
    const _ownCells = _builtins.length
      ? [
        ..._declared,
        ..._builtins.filter((b) => {
          const bid =
            (("__aio" in b ? b : b.cell) as { __aio: { id: string } }).__aio.id;
          return !_declared.some((o) =>
            (("__aio" in o ? o : o.cell) as { __aio: { id: string } }).__aio
              .id === bid
          );
        }) as unknown as typeof _declared,
      ]
      : _declared;
    const allCells = _plugins.cells.length
      ? [
        ...(_plugins.cells as typeof _ownCells).filter((p) =>
          !_ownCells.some((o) =>
            (("__aio" in o ? o : o.cell) as { __aio: { id: string } }).__aio
              .id ===
              (("__aio" in p ? p : p.cell) as { __aio: { id: string } }).__aio
                .id
          )
        ),
        ..._ownCells,
      ]
      : _ownCells;
    if (allCells.length === 0) {
      throw teachableError(
        "no cells to run",
        "define at least one cell() (importing its module is enough), or pass " +
          "cells: [...] to aio.run()",
        "docs/basics/quickstart.md",
      );
    }
    const cellEntries = filterCellsByIsolate(allCells, isolate);

    // ── Cell-worker host mode ──
    // A `worker: true` cell is hosted by a worker whose entry is THIS module,
    // so aio.run() runs again in that thread. Bind only the hosted cell and
    // serve calls — no server, no persistence, no client, no second app.
    const hostedCell = hostedCellName();
    if (hostedCell) {
      const defs = cellEntries.map((e) => "__aio" in e ? e : e.cell);
      const hosted = defs.find((f) => f.__aio.id === hostedCell);
      if (!hosted) {
        throw new Error(
          `[aio] cell worker for "${hostedCell}": the app entry booted without ` +
            `that cell (cells: ${
              defs.map((f) => f.__aio.id).join(", ") || "none"
            }). A worker cell must be in the same aio.run({ cells }) list as ` +
            `on the main isolate.`,
        );
      }
      // Never resolves — the worker lives as long as its owner.
      return await startCellWorkerHost(hosted) as never;
    }

    // A perf budget naming a method that does not exist never applies, and
    // nothing ever says so. One app declared 17 per-method budgets adopting the
    // feature and one of them — `builds:installRelease` — named no method at
    // all; the failure mode is a perf violation naming the METHOD, which sends
    // you to read the method instead of the config.
    //
    // Same class as `strictCells` one layer up: config that silently governs
    // nothing. The cells and their method names are all in hand here, so the
    // check is cheap. Throws under `strictCells` (the app asked for strict),
    // warns otherwise — a budget is an optimisation hint, not a correctness
    // requirement, so a stale key must not break someone's boot by default.
    const budgetMethods = fc.perfBudget?.methods;
    if (budgetMethods && cellEntries.length > 0) {
      const known = new Set<string>();
      for (const e of cellEntries) {
        const def = ("__aio" in e ? e : e.cell) as {
          __aio: { id: string; actionKeys?: string[] };
        };
        const id = def.__aio.id;
        for (const m of def.__aio.actionKeys ?? []) known.add(`${id}:${m}`);
      }
      const unknown = Object.keys(budgetMethods).filter((k) => !known.has(k));
      if (unknown.length > 0) {
        const q = unknown.map((k) => `"${k}"`).join(", ");
        const near = (k: string) => {
          const [cellId] = k.split(":");
          const sibs = [...known].filter((n) => n.startsWith(`${cellId}:`));
          return sibs.length > 0 ? ` (${cellId} has: ${sibs.join(", ")})` : "";
        };
        const msg = `perfBudget.methods names ${
          unknown.length === 1 ? "a method" : "methods"
        } that do not exist: ${q}${
          unknown.length === 1 ? near(unknown[0]!) : ""
        } — ${
          unknown.length === 1 ? "that budget" : "those budgets"
        } never applies to anything. Keys are exact "cell:method".`;
        if (fc.strictCells) throw new Error(`[aio] ${msg}`);
        log.warn(msg);
      }
    }

    // Imported-but-unregistered cells (opt-in `strictCells`): a cell() that ran
    // (its module was imported) but was left out of aio.run({ cells }) dispatches
    // into the void — no error, dead feature, green tests. Opt-in because the global registry accumulates across a process
    // (the supported disjoint-multi-app pattern, tests), so a default-on check
    // would false-fire. Compared within the same isolate on both sides.
    if (fc.strictCells && fc.cells && fc.cells.length > 0) {
      // CellEntry is `CellDef | { cell, dependsOn }` — normalize to the def id.
      const idOf = (e: typeof cellEntries[number]): string =>
        ("__aio" in e ? e : e.cell).__aio.id;
      const passed = new Set(cellEntries.map(idOf));
      const orphaned = filterCellsByIsolate(
        [...getRegisteredCells().values()],
        isolate,
      )
        .map(idOf)
        .filter((id) => !passed.has(id));
      if (orphaned.length > 0) {
        const one = orphaned.length === 1;
        const q = orphaned.map((n) => `"${n}"`).join(", ");
        throw new Error(
          `[aio] strictCells: ${one ? "cell" : "cells"} ${q} ${
            one ? "was" : "were"
          } defined (imported) but not passed to aio.run({ cells: [...] }) — ` +
            `${
              one ? "its" : "their"
            } dispatches would be SILENT NO-OPS (a dead ` +
            `feature with green tests). Add ${
              one ? "it" : "them"
            } to cells[], or remove the import.`,
        );
      }
    }

    // Compose cells + build state filters
    const {
      composed,
      autoGetDBState,
      autoGetUIState,
      cellPatchStrategies,
      cellFilterFields,
      beforeReduce,
      onRestore,
      cellReportOpts,
      visibilityReport,
    } = composeCellsWiring({
      appId: resolveAppId(fc.appId),
      cellEntries,
      cellDefaults: fc.cellDefaults,
      localFirst: fc.localFirst,
      circuitBreaker: fc.circuitBreaker,
      perfCheck: fc.perfCheck,
      onError: fc.onError,
      beforeReduce: fc.beforeReduce,
      onRestore: fc.onRestore,
    });

    // `_exposeOf` — the ONE decider (see its doc comment). Reading
    // `parseCli().expose` here instead would silence this warning for an app
    // exposed via `aio.run({ expose: true })`.
    const _exposed = _exposeOf(parseCli(), fc);
    // ── ONE line per cell whose ENTIRE state reaches every client ──
    //
    // Two independent signals land here. The audience one (this app is exposed
    // or multi-user, so `ui: "all"` means strangers) was already warned about.
    // The stronger one was not: a cell that declares `access` has had its WRITE
    // side restricted by the author and its READ side left undecided.
    //
    // `access` gates method CALLS; `ui` gates what the state broadcast carries.
    // Neither derives the other — "only admins may edit, everyone may read" is
    // a real design, so the framework must not choose. But an author who writes
    // `access: false` and never writes `ui` has answered half the question, and
    // the unanswered half defaults to broadcasting the whole cell to every
    // socket, authenticated or not. That is worth saying out loud: it is the
    // one case where the author's own declaration contradicts what ships.
    //
    // Note the asymmetry this closes. Composition REFUSES TO BOOT on a guess (a
    // field whose NAME matches a credential regex) while the strongest signal
    // available — the author explicitly marking the cell restricted — was read
    // by nothing. Guessing harder than we listen is backwards.
    //
    // Emitted from one loop so a cell tripping both signals is told once, and
    // the `access` message wins because it is the more specific and the more
    // actionable of the two.
    // Per-user auth in ANY form (users map, resolveUser hook, auth flows)
    // means strangers with different privileges share this app's broadcast.
    const _multiUser = !!fc.users || !!fc.resolveUser || !!fc.auth;
    const _openCells: string[] = [];
    for (const r of visibilityReport) {
      if (r.ui !== "all" || r.fields.length === 0) continue;
      // An explicit `visible` — including `visible: "all"` — is an answer, and
      // silences this forever. Acknowledging costs one word, so the warning can
      // never become the kind of noise people mute wholesale.
      if (r.access !== undefined && !r.uiDecided) {
        const a = r.access;
        const what = a === false
          ? "access: false denies all network method calls on this cell, but it"
          : a === true
          ? "access: true requires an authenticated caller for method calls, " +
            "but it"
          : typeof a === "function"
          ? "This cell's access predicate gates method calls, but it"
          : `access: ${JSON.stringify(a)} restricts method calls to that ` +
            `role, but it`;
        const one = r.fields.length === 1;
        const msg =
          `[${r.cell}] ${what} does NOT hide state. With no \`visible\` ` +
          `declaration, ${
            one ? "its field" : `all ${r.fields.length} fields`
          } [${r.fields.map((k) => `"${k}"`).join(", ")}] ${
            one ? "is" : "are"
          } broadcast in full to every connected client — including ` +
          `unauthenticated ones. ` +
          // A sync cell CANNOT narrow its read side: CRDT replication sends
          // ops to every peer by construction, and composition refuses to
          // start a sync cell that hides state. Offering it a `visible`
          // filter would be advice that hard-fails at the next boot.
          (r.syncs
            ? `This cell is sync: true, so its reads cannot be narrowed — ` +
              `CRDT replication carries it to every peer, and a sync cell ` +
              `that hides state is refused at boot. Either drop sync on it, ` +
              `or confirm the audience is right and say so — visible: "all".`
            : `Decide the read side too: visible: "none" (state stays ` +
              `server-side), visible: { exclude: [...] }, or visible.forUser ` +
              `for a per-user view. If everyone really may read it, say so — ` +
              `visible: "all".`);
        // alpha52: on an app whose audience is real (exposed to the network,
        // or multi-user) an author-declared `access` with an undecided read
        // side REFUSES to boot — the author's own declaration contradicts what
        // would ship, and a warning under a real audience is shippable. On a
        // loopback single-user app the same finding stays a warning (dev
        // stays stricter than nothing, but a local tool must not brick).
        if (_exposed || _multiUser) {
          throw new Error(
            `[aio] refusing to start (${
              _exposed
                ? "this app is exposed to the network"
                : "multi-user auth is on"
            }). ${msg} One-word acknowledgement: visible: "all".`,
          );
        }
        log.warn(
          `${msg} (This becomes a boot refusal under --expose or ` +
            `multi-user auth.)`,
        );
        continue;
      }
      if (_exposed || _multiUser) _openCells.push(r.cell);
    }
    if (_openCells.length) {
      const mode = _exposed
        ? exposeReason(parseCli(), fc as { expose?: boolean; host?: string })
        : "multi-user auth";
      log.warn(
        `${mode} with visible="all" on cells: ${
          _openCells.join(", ")
        } — every authenticated client sees this state. Narrow with visible:{include:[...]} if needed.`,
      );
    }

    // Data directories FIRST: initLogger() resolves `~/.<appId>/logs` through
    // the same registry, so registering after it would send a libraryMode app's
    // logs into the user's home (the inner _run() registers again, harmlessly).
    const _earlyAppId = resolveAppId(fc.appId);
    registerAppDirs(
      _earlyAppId,
      resolveAppDirs({
        appId: _earlyAppId,
        appDir: fc.appDir,
        libraryMode: fc.libraryMode,
        baseDir: fc.baseDir,
      }),
    );

    // Logger — skipped in `--aio-data-contract` mode: installing it would
    // replace the stderr-only sink (putting boot lines back on the parsed
    // stdout) and rotate the app's log files for what is only a query.
    const logger = _contractMode ? null : await initLogger(fc);
    (globalThis as Record<string, unknown>).__aioCells = composed;

    // Mutable app ref for closures
    const appRef = {
      current: null as AioApp<Record<string, unknown>, unknown> | null,
    };

    // Bridge to legacy _run() config
    const config = buildLegacyConfig({
      fc,
      composed,
      beforeReduce,
      onRestore,
      autoGetUIState,
      autoGetDBState,
      cellPatchStrategies,
      cellFilterFieldsMap: cellFilterFields,
      cellReportOpts,
      logger,
      appRef,
    });

    const app = await _run(composed.initialState, config);
    appRef.current = app;

    // Post-run: memory monitor, cells API, bindCell
    await wrapAppWithCells(app, composed, fc, cellReportOpts);

    // Cells are bound — the update check can now call cell methods. Armed in
    // _run, fired here, because dispatching before binding throws.
    beginUpdates();
    beginFeedback();

    // AIO-418: fire the user's onStart NOW — after the callable cell
    // method surface is bound — so seeding via a cell method (members.seed())
    // works instead of throwing "cell runtime not booted". Error-guarded: a
    // throwing onStart must not abort a successful boot.
    // Guarded for a sync throw AND an async rejection: an `async onStart` used
    // to bypass the catch entirely and surface as an unhandled rejection.
    if (fc.onStart) {
      const failed = (e: unknown) => log.error(`onStart hook error: ${e}`);
      try {
        const r = fc.onStart(app) as unknown;
        if (r && typeof (r as Promise<unknown>).then === "function") {
          (r as Promise<unknown>).catch(failed);
        }
      } catch (e) {
        failed(e);
      }
    }
    return app;
  } catch (e) {
    throw e;
  }
}

// ── _run: thin orchestrator calling phase modules ─────────────────────

async function _run<S, A, E>(
  initialState: S,
  config: AioConfig<S, A, E>,
): Promise<AioApp<S, A>> {
  // --- Phase 1: resolve CLI, env, config validation, lint ---
  const cli = parseCli();
  if (cli.help) {
    printHelp(_helpFacts(config.client));
    Deno.exit(0);
  }
  if (cli.version) {
    // An artifact has to be able to say what it IS and what it was built with —
    // a binary found on a server months later is otherwise unidentifiable, and
    // "which aio is this running?" is the first question when it misbehaves.
    // Same sources the app itself uses for its identity (resolveAppId handles
    // the compiled-binary case), so --version cannot describe a different app
    // than the one that would boot.
    log.info(
      versionLine(
        resolveAppId(config.appId),
        await _appVersion(),
      ),
      { detail: String() },
    );
    Deno.exit(0);
  }

  if (cli.dataContract) {
    // What this build promises about data already on disk. Derived from the
    // very same cell versions and onMigrate hooks the boot path uses, so a
    // published contract cannot drift from what the binary actually does.
    //
    // `console.log`, NOT `log.info`: this stdout is parsed (`aio ship`,
    // `updates-rebuild`). The logger stamps every line with a timestamp and a
    // category, which prefixed the JSON's first line and made every published
    // manifest data-less. run() has already routed the framework's own lines
    // to stderr for this mode, so this is the only thing on stdout.
    // aio-ok: the machine-readable answer itself. `log.info` would prefix it
    // with a timestamp and a category and make it unparseable — which is the
    // exact defect this mode was fixed for.
    console.log(JSON.stringify(
      deriveDataContract(
        config._cellMigrations ?? new Map(),
        PERSIST_SCHEMA_VERSION,
      ),
      null,
      2,
    ));
    // …and ONE fact about what the contract could not say, on stderr, where
    // this mode already routes every framework line.
    //
    // A contract with no cells has two opposite meanings — "this app persists
    // nothing" and "this app persists and promised nothing about it" — and on
    // the wire they are the same `cells: {}`. The second is the dangerous one:
    // the data gate the updater leads with has nothing to weigh, so a release
    // that cannot read a user's existing store installs without a word. A
    // field report published every one of its releases that way.
    //
    // Deliberately NOT in the contract: the contract is inside the signature,
    // and this is a build-time diagnostic, not a promise to a client. `ship`
    // runs this binary already, so the two numbers meet where the decision is.
    // aio-ok: a marker `aio ship` parses off stderr, beside the JSON on stdout.
    console.error(
      `[aio] persisting-cells: ${(config._persistingCellIds ?? []).length}`,
    );
    Deno.exit(0);
  }

  // An update hands over by starting the new artifact and exiting. aio refuses
  // to boot while another instance holds the app lock, so the successor is
  // launched with its predecessor's pid and waits here — BEFORE the lock is
  // taken, and before anything else can fail for a reason that is really just
  // this race.
  await awaitPredecessor(Deno.args);

  const appId = resolveAppId(config.appId);
  log.debug(`app-id: ${appId}`);

  // ── One data directory ──
  // Everything this app owns lives under `~/.<appId>` (overridable). Migrate a
  // legacy scattered layout FIRST — before anything opens a database — then
  // stamp meta.json so a backup of `data/` is self-describing. Skipped in
  // libraryMode (a test's cwd is not an app) and with --no-data-migrate.
  // libraryMode means a TEST or a host app owns the process — it must not write
  // into the user's home, so its data dir defaults under baseDir (which tests
  // already point at a temp dir). Everything else resolves to `~/.<appId>`.
  // Boot-report values assembled as the boot proceeds (printed by bootLines).
  let _heapLine: string | undefined;
  const _dirs = resolveAppDirs({
    appId,
    appDir: config.appDir,
    libraryMode: config.libraryMode,
    baseDir: config.baseDir,
  });
  // Register BEFORE anything else resolves a path, so every module in this
  // process (auth store, app key, profile export) agrees with this decision.
  registerAppDirs(appId, _dirs);
  // Always create them: auth.db / app.key / state.db all open files inside.
  ensureAppDirs(_dirs);
  // SIGINT/SIGTERM, as early as boot can install them. A signal arriving
  // before the handler exists is not merely early — it is LOST, and the app
  // then runs forever having been asked to stop. See `installProcessSignals`
  // for the measurement. libraryMode never installs them: an embedding host
  // owns the process, and `app.close()` is how it stops us.
  if (!config.libraryMode) installProcessSignals();
  // Where the diagnostics sinks write when there is NO logger. `logging: false`
  // used to send the action log and the crash checkpoint to `.aio/log`
  // relative to the current directory — one ERROR per dispatch, and the two
  // artifacts that exist to explain a crash silently not written. Turning off
  // the console logger must not turn off the black box.
  setFallbackLogDir(_dirs.logs);
  if (!config.libraryMode) {
    // A packaged app unpacks itself BEFORE any of our code runs, so this can
    // only observe where that happened — and say so when it happened somewhere
    // other users on the host can reach. Never fatal (the app works either
    // way), never silent (running world-readable is not a detail), identical in
    // dev and prod. The sweep clears the empty mount stubs a crash leaves in
    // our own payload dir — the one upkeep `/tmp` used to do for us.
    // The heap ceiling this process actually got, against the policy. V8 fixed
    // it at isolate creation, so this can only REPORT — but running on the
    // ~4 GB default when the machine allows 47 GB is exactly the setup that
    // ends in "out of memory" with most of the machine free, and it must not be
    // discovered then. `am start`, run.sh and the build all size it correctly;
    // a bare `deno run src/app.ts` is the case that lands here.
    await reportHeapCeiling(log, {
      // Once per machine, keyed on the numbers — see reportHeapCeiling. The
      // stamp lives beside the app's other disposables, so wiping the data dir
      // legitimately makes it say the thing again.
      // `<data>/` not `<data>/files/`: `files` is the APP's upload space
      // (created lazily, and not ours), and a write that quietly fails puts
      // the warning back on every boot.
      stampPath: join(_dirs.data, ".heap-notice"),
      always: cli.verbose,
    });
    // The same numbers the warning uses, stated unconditionally: an app that
    // died of "out of memory" with the machine half empty is a support thread
    // that starts with "what was the ceiling?".
    // A compiled binary's ceiling was decided by whoever ran the build, not by
    // this machine — the line says which, so a number the reader cannot change
    // from here is never presented as this machine's allowance.
    _heapLine = describeHeapPolicy(
      Math.floor(((await currentHeapLimitBytes()) ?? 0) / (1024 * 1024)) ||
        null,
      physicalMemoryBytes(),
      isCompiled(),
    );
    sweepAppPayloadDir(_dirs);
    const unsafeUnpack = checkUnpackLocation(_dirs);
    if (unsafeUnpack) log.warn("security", unsafeUnpack);
    if (!cli.noDataMigrate) {
      const _m = migrateLegacyLayout({
        appId,
        dirs: _dirs,
        cwd: Deno.cwd(),
        legacyXdgDir: resolveDataDirLegacy(appId),
      });
      for (const line of describeMigration(_m, _dirs)) {
        if (line.includes("FAILED") || _m.refused) log.warn("data", line);
        else log.info("data", line);
      }
    }
    writeAppMeta(_dirs, {
      appId,
      aio: VERSION,
      app: await _appVersion(),
    });
  }
  // THE port chain, in one place, with `am` reading the same three rungs
  // (`declaredPort`): `--port` (operator, this run) > `AIO_PORT` (operator, no
  // command line to hang a flag on — a service unit, a container, a compiled
  // binary) > `aio.run({ port })` (the author) > the runtime picks a free one.
  //
  // deno.json is deliberately NOT a rung: it carries identity and build only
  // (see `_warnMisplacedDenoJson`, which WARNS that a top-level `port` there is
  // inert). `am` used to read it anyway, so a key the runtime told you it was
  // ignoring silently decided where `am` aimed.
  const _envPort = envPort();
  const port = cli.port ?? _envPort ?? config.port ?? await findFreePort();
  const portFrom: Provenance = cli.port
    ? "flag"
    : _envPort !== undefined
    ? "env"
    : config.port
    ? "config"
    : "default"; // …i.e. picked by findFreePort — worth saying, since a port
  // that changes between runs is otherwise a mystery.

  // Singleton lock — libraryMode implies no lock (embeddable / testable).
  const singletonMode = config.libraryMode ? false : (config.singleton ?? true);
  const killExisting = (config.killExisting ?? false) ||
    (cli.killExisting ?? false);
  const appLock = await acquireSingletonLock(
    appId,
    appDirs(appId, config.appDir).home,
    port,
    singletonMode,
    killExisting,
    {
      aioVersion: VERSION,
      cdpPort: cdpPort(),
    },
  );

  // Did the last boot install something? Count this attempt, or — having spent
  // them — put the old artifact back and let the supervisor start it. Runs in
  // the NEW build, because it is the only thing present to judge itself.
  //
  // AFTER the lock, deliberately. It used to run before, so a boot REFUSED by
  // the singleton lock still burned an attempt: start an already-running app
  // twice and the third launch rolled back a perfectly healthy update. A boot
  // that never got as far as owning the app cannot be evidence about the build.
  if (!config.libraryMode && await judgePendingUpdate(_dirs.data, log)) {
    appLock?.release();
    Deno.exit(1);
  }

  // Thin client mode
  if (
    await handleThinClient(cli.serverUrl ?? config.serverUrl, (_v) => {
      /* multi-instance (D2): no process-wide running flag */
    })
  ) return null!;

  // Zero-config baseDir: the main module's directory — always right for
  // `deno run src/app.ts` regardless of cwd. Compiled binaries embed their
  // entry, so they keep the cwd/src fallback (build sets baseDir anyway).
  const baseDir = resolve(config.baseDir ?? _inferBaseDir());
  const VERBOSE = cli.verbose;

  // Prod detection
  let distDir = resolve(join(Deno.cwd(), "dist"));
  let prod = cli.prod ?? false;
  if (!prod && isCompiled()) {
    // Entry-relative (the binary's EMBEDDED dist/) first, real filesystem after
    // — so a compiled binary detects prod from ANY cwd. See distCandidates.
    const candidates = distCandidates({
      mainModule: Deno.mainModule,
      cwd: Deno.cwd(),
      execDir: dirname(Deno.execPath()),
      moduleDir: import.meta.dirname ?? null,
    });
    let sawDistDir: string | undefined;
    for (const dir of candidates) {
      try {
        await Deno.stat(join(dir, BUNDLE_JS));
        distDir = dir;
        prod = true;
        log.info("auto-detected dist/app.js → prod mode");
        break;
      } catch {
        // A dist/ that EXISTS but holds no app.js means this binary embedded a
        // bundle directory and still has nothing to serve — never a headless
        // build, always a packaging bug. Remember it so the fallback below can
        // say so instead of quietly serving the "no browser UI" page
        // (R-5).
        if (sawDistDir === undefined) {
          try {
            if ((await Deno.stat(dir)).isDirectory) sawDistDir = dir;
          } catch { /* no such dir either */ }
        }
      }
    }
    // A HEADLESS build (`--service`/`--cli`) never bundles, so there is no
    // dist/app.js to find — but a compiled binary is prod by definition (dev
    // mode means running from source). Without this the service binary fell
    // through to dev: it emitted the "esbuild not installed" warning and ran
    // the dev lint, which demands src/App.tsx at cwd → crash on any real
    // server. `deno task compile:service` shipped exactly that.
    if (!prod) {
      prod = true;
      if (sawDistDir) {
        log.warn(
          `compiled binary embeds ${sawDistDir} but it holds no app.js — ` +
            `this build packaged a bundle directory with nothing to serve, so ` +
            `the app will answer with the "no browser UI" page. Rebuild the ` +
            `browser bundle before compiling (deno task build), or build a ` +
            `headless target on purpose (--headless/--cli).`,
        );
      }
      log.info("compiled binary without a bundle → prod mode (headless)");
    }
  }

  // Electron loads the page off disk via the aio:// protocol — from ITS OWN
  // process. `distDir` may be the binary's embedded VFS copy, which Electron
  // cannot open, so resolve a real-filesystem dist/ separately. Undefined here
  // means "Electron must load over HTTP" — and skipHttp below honors that
  // rather than leaving it with a dead localhost URL (blank window).
  let electronDistDir: string | undefined;
  if (prod) {
    for (
      const dir of realDistCandidates({
        cwd: Deno.cwd(),
        execDir: dirname(Deno.execPath()),
        moduleDir: import.meta.dirname ?? null,
      })
    ) {
      try {
        await Deno.stat(join(dir, BUNDLE_JS));
        electronDistDir = dir;
        break;
      } catch { /* not found */ }
    }
  }

  // One redaction predicate for every place an action is recorded — the
  // journal (disk), the timeline (`am timeline`) and the action log. Built
  // here, before any of them exists, so none can be created without it.
  const redact = makeRedactor(config.redactActions);

  // Diagnostics + vitals
  const { diagHooks, vitalsSystem, diagResolvedOpts } = initDiagAndVitals(
    config._diagnostics,
    prod,
    config._cellNames,
    // Supervised BY DEFAULT (alpha61, from a wallet's field report): an
    // unhandled promise rejection — a floating `void poll()` on a schedule
    // path — is logged loudly, checkpointed, and the process SURVIVES. Dying
    // is not "failing louder": for a long-running server owning persisted
    // state, process death from one stray rejection is the worst outcome on
    // the table, and the report's app was a wallet mid-signing. Sync uncaught
    // throws stay fatal (a hard fault is a hard fault). `guardDispatches:
    // false` opts back into fail-fast for supervisor-managed deployments that
    // WANT death-and-restart.
    config.guardDispatches ?? true,
    redact,
  );

  // Client mode: CLI flag > aio.run config > app deno.json `target` >
  // electron. The deno.json step is what makes `am create --target=X` +
  // `deno task dev` (no --client flag) actually run target X.
  const client = cli.client ?? defaultClientFor(config.client);
  // …and WHO decided, kept beside the decision so the two cannot drift. The
  // boot report says `client electron (deno.json)` instead of leaving someone
  // to grep three files for the one that won.
  const clientFrom: Provenance = cli.client
    ? "flag"
    : config.client
    ? "config"
    : _denoJsonTargetClient()
    ? "deno.json"
    : "default";
  const useElectron = client === "electron";
  const isHeadless = client === "server-only" || client === "cli";
  const { reduce, execute, onAction, onEffect, onStart, onStop, onError } =
    config;
  const shouldPersist = (cli.persist ?? config.persist) !== false;
  // autoGetUIState is always defined by composeCellsWiring (ui defaults to "all"),
  // so the (s) => s fallback here is a safety net, not the primary path.
  const _rawGetUIState = config._getUIState ?? ((s: S, _user?: AioUser) => s);
  const getUIState = createMemoizedUIState(_rawGetUIState);
  const getDBState = config._getDBState ?? ((s: S) => s);
  const persistKey = config.persistKey ?? "state";
  const persistMode = config.persistMode ?? "single";
  const ui = config.ui ?? {} as UiConfig;

  validateConfig(
    config as unknown as Record<string, unknown>,
    VALID_AIO_CONFIG_KEYS,
    "AioConfig",
  );
  if (config.ui) {
    validateConfig(config.ui as Record<string, unknown>, VALID_UI_KEYS, "ui");
    if (config.memory) {
      validateMemoryConfig(config.memory as Record<string, unknown>);
    }
  }
  printLint(
    await lint(
      initialState,
      config,
      baseDir,
      prod,
      isHeadless,
      useElectron,
      ui.entry ?? UI_ENTRY,
      isHeadless ? client : undefined,
    ),
  );

  // ── stillness at the boundary (a local-LLM chat app) ────────────────────────
  //
  // Two facts an app can be WRONG about without any error: which aio it is
  // actually running, and whether a framework default has taken over its
  // layout. Both were diagnosed in the field by symptom — six releases of pin
  // drift found by "why did the semantics change", and a re-laid-out window
  // found by "why is my UI in half the screen". The framework knows both
  // answers at boot and said neither. Observe-only, once per boot.
  _warnPinDrift();
  // The look is opt-in (`ui.theme` defaults to "tokens", which paints
  // nothing), so there is nothing to announce for an app that never asked.
  // An app that DID ask hears which of the two ways it landed. THE decider,
  // not a second copy: a compiled binary's baseDir is `<cwd>/src` and its
  // stylesheet lives in the embedded dist/, so asking only one of them made
  // this line confidently wrong there.
  const themeNote = _themeBootNote(
    ui.theme,
    appHasStylesheet(baseDir, distDir),
  );
  if (themeNote) log[themeNote.level](themeNote.message);

  const title = await resolveTitle(cli.title, ui.title);
  log.debug(
    `config: port=${port} persist=${shouldPersist} client=${client} title="${title}" baseDir=${baseDir}`,
  );

  // --- Phase 2: boot storage ---
  const syncCellIds = config._syncCellIds ?? [];
  let state = initialState;
  // Declared BEFORE bootStorage on purpose: boot is the phase most likely to
  // fail (a migration that throws, a corrupt database, a `db:` binding that
  // resolves to nothing), and those failures must reach the app's `onError`
  // sink like any other. Both used to be declared ~100 lines further down, so
  // `getReportOpts()` during boot hit the temporal dead zone and threw a
  // ReferenceError INSIDE the error path — the app never heard about the
  // failure it most needed to hear about, and the ReferenceError masked the
  // real cause. `getTT` stays a closure, so the only ordering that matters is
  // that `tt` is initialized before an error is reported, which it now is.
  let tt: TTState<S, { type: string }> | null = null;
  const _reportOpts = buildReportOpts({ onError, getTT: () => tt, prod });

  const boot = await bootStorage({
    appId,
    dbPath: config.dbPath ?? cli.dbPath,
    dbPragmas: config.dbPragmas,
    checkIntegrityOnBoot: config.checkIntegrityOnBoot,
    initialState,
    shouldPersist,
    persistKey,
    persistMode,
    persistDebounceMs: config.persistDebounceMs ?? 100,
    dbSchema: config.db,
    syncCellIds,
    cellAccess: config._cellAccess,
    cellMigrations: config._cellMigrations,
    _cellVersions: config._cellVersions,
    cellRestores: config._cellRestores,
    onRestore: config.onRestore,
    onCheckpointRestore: config._onCheckpointRestore,
    diagHooks,
    healthGetter: config._healthGetter,
    getDBState: getDBState as (s: S) => unknown,
    getState: () => state as Record<string, unknown>,
    // What a CLIENT may see — the CRDT catch-up snapshot is a wire frame and
    // must go through the same projection every other wire uses (it used to
    // read raw state). No `user`: a sync cell may not carry a per-user filter
    // at all (aio-composition.ts refuses it), so this is exactly the
    // structural view.
    getUIState: (s: Record<string, unknown>) => getUIState(s as S),
    getReportOpts: () => _reportOpts,
    journal: config.journal,
    redactActions: config.redactActions,
    log,
  });
  state = boot.state as S;
  const { kvDb, asyncDb, persistence, journal, syncHandler, syncBroadcastRef } =
    boot;
  const migrationSummary = boot.migrations;
  const _syncDispatchRef = boot.syncDispatchRef;
  const { schedulePersist } = persistence;

  // B1/AIO-416: recover sync cells from their op-log at boot (after KV restore +
  // onRestore, before any dispatch/broadcast). Without this, sync cells came back
  // empty on a server restart until a client reconnected — silent data loss.
  if (asyncDb && syncCellIds.length > 0) {
    state = await replaySyncOps(
      asyncDb,
      syncCellIds,
      config.reduce as (
        s: S,
        a: { type: string; payload?: unknown },
      ) => S,
      state,
      log,
    );
  }

  // Journal recovery: replay the actions committed AFTER the last
  // snapshot (the debounce window a SIGKILL/power-cut would otherwise lose) on
  // top of the restored state — after sync-ops so cross-cell reads see recovered
  // sync state. State transitions only; effects are never re-run.
  if (journal) {
    const tail = journal.readSince(journal.watermark());
    if (tail.length > 0) {
      const replay = replayJournal(
        state,
        tail,
        config.reduce as (s: S, a: A) => { state: S },
      );
      state = replay.state;
      if (replay.replayed > 0) {
        log.info(
          `journal: recovered ${
            count(replay.replayed, "action")
          } past the last snapshot`,
        );
      }
      // A redacted entry cannot be replayed — its payload IS its arguments and
      // the redactor dropped them. Skipping is the only correct outcome, but a
      // SILENT skip would be the same lie in a quieter register: recovery would
      // report success while the recovered state is missing writes. Say
      // exactly which actions, and how many, so the operator can judge it.
      if (replay.skipped.length > 0) {
        const counts = new Map<string, number>();
        for (const s of replay.skipped) {
          counts.set(s.type, (counts.get(s.type) ?? 0) + 1);
        }
        const what = [...counts]
          .map(([type, n]) => (n > 1 ? `${type} x${n}` : type))
          .join(", ");
        const seqs = replay.skipped.map((s) => s.seq);
        const threw = replay.skipped.filter((s) => s.reason === "threw");
        const why = threw.length === 0
          ? `their payload was dropped by redactActions, so the arguments ` +
            `needed to re-run them are gone`
          : threw.length === replay.skipped.length
          ? `the reducer REJECTED them: ${
            [...new Set(threw.map((s) => s.error ?? "threw"))].join("; ")
          }`
          : `some had their payload dropped by redactActions and ${threw.length} ` +
            `were rejected by the reducer: ${
              [...new Set(threw.map((s) => s.error ?? "threw"))].join("; ")
            }`;
        log.warn(
          `journal: ${
            count(replay.skipped.length, "action")
          } COULD NOT be replayed — ` +
            `${why}: ${what} (seq ${Math.min(...seqs)}–${
              Math.max(...seqs)
            }). ` +
            `Whatever those actions wrote after the last snapshot is NOT in ` +
            `the recovered state. Skipping is deliberate: an entry that cannot ` +
            `be replayed is still in the file at the next boot, so failing on ` +
            `it would make recovery the reason this app can never start.`,
        );
      }
    }
  }

  // The persistence manager captured its `db:` table baseline while `state`
  // was still initialState — restored rows only land here. Left stale, the
  // first flush after a restart diffs restored-rows-vs-nothing, re-INSERTs
  // every existing row, hits a UNIQUE violation, and rolls back the whole
  // transaction: every write after the first restart was lost, permanently
  // (the baseline only advances on success, so it never recovered). Re-seed
  // it now that `state` is what the database actually holds.
  persistence.resetPrevState();

  // Time-travel — dev only, AND only when diagnostics leave it on.
  //
  // `diagnostics.dev.timeTravel` was a declared option with no reader: it was
  // resolved, defaulted and documented, and then TT was created purely on
  // `!prod`. An app that turned it off — a wallet, say, whose reason is that
  // time-travel holds a full state history in memory — kept every action's
  // state anyway, and paid a `tt-state` broadcast on every dispatch for it.
  // The option now decides, and its dev default is still `true`.
  const ttEnabled = timeTravelEnabled(prod, diagResolvedOpts);
  // High-frequency app actions (a 60 fps `game:tick`) flood the bounded TT
  // window until it holds seconds instead of a session — `skipActions` keeps
  // them out of history (a field report).
  const ttSkipActions =
    typeof diagResolvedOpts === "object" && diagResolvedOpts.skipActions?.length
      ? new Set(diagResolvedOpts.skipActions)
      : undefined;
  if (ttEnabled) {
    tt = createTT<S, { type: string }>();
    tt = record(tt, { type: "__init" }, state);
    log.debug("time-travel: initialized");
  } else if (!prod) {
    log.debug("time-travel: disabled by diagnostics config");
  }

  if (config._onReportOptsReady) config._onReportOptsReady(_reportOpts);

  // --- Phase 3: wire dispatch ---
  const udsSyncIntervalMs = config.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  // deno-lint-ignore prefer-const
  let server: ServerHandle;
  let udsHandle: UDSHandle | null = null;
  let _vitalsCheckTimer: ReturnType<typeof setInterval> | undefined;

  const scheduleManager = createScheduleManager(
    (action) => dispatch(action as A),
    log,
  );
  const ownManager = createOwnManager(log);
  if (config._onScheduleReady) {
    config._onScheduleReady((prefix) => {
      scheduleManager.cancelByPrefix(prefix);
      ownManager.disposeByPrefix(prefix);
    });
  }

  const udsCtrl = createUdsBroadcastController({
    getUdsHandle: () => udsHandle,
    syncIntervalMs: udsSyncIntervalMs,
  });
  // Cost meter (`am cost`): always on, bounded rings, zero configuration. The
  // question it answers — "what does aio move on my behalf, and where does it
  // come from" — is asked AFTER something feels slow, which is exactly when an
  // opt-in diagnostic is not enabled. See src/vitals/cost-meter.ts.
  const costMeter = createCostMeter();
  costMeter.setKnownCells(config._cellNames ?? []);
  // A GETTER, not the value: `record()` swaps in a new TTState per action.
  const onPerf = buildOnPerf(() => tt, vitalsSystem, costMeter);

  // Set once the worker pool exists (below); a jump before that has nothing
  // to re-seed.
  let _reseedWorkerCells: () => void = () => {};

  function handleTTCommand(cmd: string, arg?: number): void {
    if (!tt) return;
    const prev = tt;
    switch (cmd) {
      case "undo":
        tt = undo(tt);
        break;
      case "redo":
        tt = redo(tt);
        break;
      case "goto":
        if (arg !== undefined) tt = travelTo(tt, arg);
        break;
      case "pause":
        tt = pause(tt);
        break;
      case "resume":
        tt = resume(tt);
        break;
      default:
        log.debug(`time-travel: unknown command '${cmd}'`);
        return;
    }
    if (tt === prev) return;
    const restored = stateAt(tt);
    if (restored !== null) {
      state = restored;
      // A worker cell's copy would otherwise keep mutating the state we just
      // discarded — re-seed it from the restored slice.
      _reseedWorkerCells();
    }
    log.debug(
      `time-travel: ${cmd}${
        arg !== undefined ? ":" + arg : ""
      } → index ${tt.index}/${tt.entries.length - 1} paused=${tt.paused}`,
    );
    server.broadcastTT();
    server.broadcast();
    udsCtrl.broadcastFull();
  }

  // Every committed, state-changing, non-sync action feeds two sinks:
  //  • the durable journal — the crash-recovery tail (actions only),
  //    present only when `journal: true`; sync cells recover via their op-log.
  //  • the in-memory timeline — always on, bounded, carries the diff
  //    each action produced; the live view behind `am timeline`.
  // Both share the same seq (the journal's when journaling, else the timeline's
  // own counter) so a timeline entry and its journal line line up for replay.
  const _diagAfterAction = diagHooks?.afterAction as
    | ((prev: S, next: S, action: A) => void)
    | undefined;
  const _syncCellSet = new Set(syncCellIds);
  const timeline = createTimeline(500, redact);
  const afterActionHook = (prev: S, next: S, action: A): void => {
    _diagAfterAction?.(prev, next, action);
    if (prev === next) return; // no-op action — nothing to record
    const t = (action as { type?: string }).type ?? "";
    const ci = t.indexOf(":");
    const cell = ci >= 0 ? t.slice(0, ci) : "";
    const method = ci >= 0 ? t.slice(ci + 1) : t;
    if (_syncCellSet.has(cell)) {
      // A sync op is already durable in the op-log. Anything ELSE that
      // committed to a sync cell — an effect, cron, serverFn, a plain action,
      // an async method's `__set` batch — is durable NOWHERE (sync cells are
      // excluded from KV), so fold current state into the cell's sync
      // snapshot. Without this, a restart silently rewound every server-origin
      // write since the last compaction.
      if (method.startsWith("__") && !method.startsWith("__set")) return;
      if (!(action as { _syncOp?: boolean })._syncOp) {
        syncHandler?.noteServerWrite(cell);
      }
      return;
    }
    // Framework-internal actions are noise — EXCEPT the write-set commit.
    //
    // An async or transactional method publishes everything it wrote as one
    // atomic `cell:__setMethod` (cell-impl.ts's batcher). The outer
    // `cell:method` action IS recorded, but it commits at CALL time, before the
    // method has written anything — so filtering `__set` as "framework noise"
    // meant an async method's writes existed in NO sink at all. The costs were
    // not cosmetic: journal replay reconstructed the pre-write state while boot
    // still logged "recovered N action(s)"; `transaction: true` promised "a
    // single journal entry … boot replay reconstructs it" and delivered the
    // opposite; `am timeline` printed `"diff": []` for an action that changed
    // everything; and time-travel `undo` landed on a state the app never had,
    // which in one shape destroyed a committed write permanently.
    //
    // It is recorded as its OWN entry, attributed to the originating method via
    // `origin` — not folded into the `cell:method` entry, which was already
    // written and journalled at call time and cannot be amended (a method may
    // also commit several times via `s.$commit()`). `type` stays the action
    // that really ran, so replay re-reduces exactly what happened.
    //
    // The rest of the `__` family stays out on purpose: `__init`/`__destroy`
    // are lifecycle, and replaying `__init` would reset a cell to its initial
    // state ON TOP of the restored snapshot — recovery that destroys data.
    // `__exec`/`__error` carry machine transitions, not the app's writes.
    const isWriteSet = isWriteSetAction(t);
    if (method.startsWith("__") && !isWriteSet) return;
    const payload = (action as { payload?: unknown }).payload;
    // Who wrote it — from the ONE decider (diagnostics/action-kind.ts), which
    // the action log and the logger resolve the same fact with. It was computed
    // here by hand and again in the diagnostics sink, and the redactor depends
    // on it: an exact `redactActions` pattern matches the CALL, so a sink whose
    // copy of this drifts leaks the same secret under the write-set's type.
    const origin = isWriteSet ? actionOrigin(t, payload) : undefined;
    const ts = Date.now();
    const seq = journal
      ? journal.append(
        {
          type: t,
          payload,
          origin,
          user: (action as { _user?: AioUser })._user,
        },
        ts,
      )
      : timeline.lastSeq() + 1;
    timeline.record(seq, t, payload, prev, next, ts, origin);
  };

  const dispatch = setupDispatch<S, A, E>({
    reduce,
    execute,
    beforeReduce: config.beforeReduce,
    onAction,
    onEffect,
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    getApp: () => app,
    getServer: () => ({
      broadcast: (patches) => server.broadcast(patches),
      broadcastTT: () => server.broadcastTT(),
    }),
    scheduleManager,
    ownManager,
    schedulePersist: (p) => schedulePersist(p),
    getTT: () => tt,
    setTT: (t) => {
      tt = t;
    },
    reportOpts: _reportOpts,
    cellPatchStrategies: config._cellPatchStrategies,
    cellFilterFields: config._cellFilterFields,
    onUdsBroadcast: udsCtrl.onUdsBroadcast,
    onPerf,
    perfCheck: config.perfCheck,
    // Dev holds reduce to ONE FRAME (16ms) instead of the 100ms prod budget:
    // a reduce is on the server's single dispatch path, so every millisecond it
    // takes is a millisecond every client's next action waits. Dev-stricter is
    // the allowed direction (observe-only, throttled to one report per action
    // type per 10s) — it teaches the "keep actions instant, move compute
    // off-thread" habit while the app is still small. Prod keeps 100ms so a
    // deployed app doesn't chatter. Override either with `perfBudget`.
    perfBudget: config.perfBudget ??
      (prod ? undefined : { reduce: DEV_FRAME_BUDGET_MS }),
    perfLog: (source, type, duration, budget, breakdown) =>
      getLogger()?.perf(source, type, duration, budget, breakdown),
    freezeState: config.freezeState ?? !prod,
    effectTimeout: config.effectTimeoutMs,
    reduceBreakdown: config._reduceBreakdown,
    ttSkipActions,
    afterAction: afterActionHook,
    log,
    debug: VERBOSE,
  });
  // ONE ceiling for "how long may this async method run" — the effect side and
  // the `await cell.method()` side resolve from the same numbers. They used to
  // be two 30s timers with opposite semantics, so raising effectTimeoutMs left
  // the caller still giving up at 30s and blaming a crashed executor.
  _setCallTimeouts(
    config.effectTimeoutMs,
    config.perfBudget?.methods
      ? Object.fromEntries(
        Object.entries(config.perfBudget.methods)
          .filter(([, v]) =>
            typeof v?.timeout === "number" || v?.timeout === "warn"
          )
          .map(([k, v]) => [k, v!.timeout as number | "warn"]),
      )
      : undefined,
  );

  // Sync ops apply through the normal dispatch path (late-bound at boot).
  _syncDispatchRef.fn = (a) => dispatch(a as unknown as A);

  const freezeEnabled = config.freezeState ?? !prod;
  log.info(
    `freezeState: ${freezeEnabled}${
      config.freezeState === undefined
        ? (prod ? " (prod default)" : " (dev default)")
        : ""
    }`,
  );

  // Vitals periodic check
  if (vitalsSystem) {
    const interval = (typeof diagResolvedOpts === "object" &&
      typeof diagResolvedOpts.vitals === "object" &&
      diagResolvedOpts.vitals.heartbeatInterval) || 1000;
    _vitalsCheckTimer = startVitalsCheck({
      vitalsSystem,
      heartbeatInterval: interval,
      dispatch,
      getState: () => state,
    });
  }

  // LAN discovery responder — late-bound (started in startLifecycle when
  // exposed), stopped by the shutdown orchestrator.
  const discoveryRef: { stop: (() => void) | null } = { stop: null };

  // AUTH-1/2: session + password-user stores — one auth.db in the data dir,
  // closed by the shutdown orchestrator. `auth: true` implies sessions (the
  // login flow issues them); `sessions: true` alone is just the token store.
  const authEnabled = !!config.auth;
  const authOpts = typeof config.auth === "object" ? config.auth : {};
  // The two stores are MUTUALLY bound, both ways, deliberately:
  //   users → sessions: a password change revokes every session (through the
  //     instance, so live WS sockets are disarmed, not just rows deleted).
  //   sessions → users: a session resolves its role from the users row at USE
  //     time, so `am auth role` reaches sessions that are already open.
  // One of the two edges has to be late-bound; the getter below is it.
  let sessionStore: SessionStore | null = null;
  const userStore = authEnabled
    ? openUserStore(appDirs(appId, config.appDir).authDb, {
      sessions: () => sessionStore,
    })
    : null;
  // serverAuth() ambience — released in shutdown() below.
  const _unregisterAuthStore = userStore ? _registerAuthStore(userStore) : null;
  sessionStore = (config.sessions || authEnabled)
    ? openSessionStore(
      appDirs(appId, config.appDir).authDb,
      typeof config.sessions === "object"
        ? config.sessions.ttlMs
        : authOpts.ttlMs,
      { roleOf: (id) => userStore?.get(id)?.role ?? null },
    )
    : null;

  // Shutdown orchestrator
  // ── Cell workers ──
  // Actions for a `worker: true` cell bypass the main queue entirely; only the
  // patches they commit come back through `dispatch`. Inert (identity routing)
  // when no cell is flagged.
  // Where a worker cell's host boots from. In production that is always the
  // app's own entry. Under libraryMode the main module is a TEST (or a host
  // app), not this app — spawning a worker on it would re-run the test file in
  // another thread — so worker cells run in-isolate, exactly like testCell. The
  // SERIALIZATION boundary is still reproduced below; the isolation is not, and
  // it says so once.
  //
  // `_workerEntry` is the ONE way out, set by `testServer({ workers: "real" })`:
  // the test names a real app-entry module, so the workers are real workers and
  // the test measures isolation instead of assuming it. See
  // docs/testing/prod-parity.md.
  if (config._workerEntry !== undefined && !config.libraryMode) {
    // The only legitimate setter is `testServer({ workers: "real" })`, which
    // always runs under libraryMode. Outside it, an app's worker entry is its
    // OWN entry — accepting an override there would silently host worker cells
    // from someone else's module, which is a data-owner change, not a tweak.
    throw new Error(
      `[aio] _workerEntry is a test-harness key and is only accepted under ` +
        `libraryMode. An app's worker cells are hosted from its own entry ` +
        `(Deno.mainModule); remove _workerEntry, or use ` +
        `testServer({ workers: "real", workerEntry }) in a test ` +
        `(docs/testing/prod-parity.md).`,
    );
  }
  const _workerEntry = config._workerEntry ?? Deno.mainModule;
  const _hostWorkers = !config.libraryMode || config._workerEntry !== undefined;
  const workerPool = createCellWorkerPool({
    // The SAME resolved value the main isolate uses and the boot line
    // prints — one decider, so a worker cell is never freeze-checked more
    // loosely than a local one.
    freezeState: freezeEnabled,
    cells:
      (_hostWorkers ? config._workerCells ?? [] : []) as unknown as Parameters<
        typeof createCellWorkerPool
      >[0]["cells"],
    entry: _workerEntry,
    prod,
    getSlice: (cell) =>
      ((state as Record<string, unknown>)[cell] ?? {}) as Record<
        string,
        unknown
      >,
    dispatch: (a) => dispatch(a as unknown as A),
    // An effect handed back by a worker executes HERE, where the runtime lives.
    // A schedule effect is NOT an action — dispatching it would do nothing at
    // all, and the schedule would silently never fire.
    runEffect: (effect) => {
      if (isScheduleEffect(effect)) {
        scheduleManager.handle(effect);
        return;
      }
      // Same class, and it was live: `__own` fell through to `dispatch` as an
      // action type no cell answers, so an own effect from a worker vanished
      // without a log. Worker cells now hold their resources in their own
      // isolate (cell-worker-host.ts), so nothing should arrive here — and if
      // anything ever does, the own manager says so out loud instead.
      if (isOwnEffect(effect)) {
        ownManager.handle(effect);
        return;
      }
      void dispatch(effect as unknown as A); // cross-cell action
    },
  });
  /** Cells that WOULD run in a worker but are running in this isolate because a
   *  test owns the entry module. Empty in production. */
  const _inIsolateWorkerCells = new Set(
    !_hostWorkers && !prod
      ? (config._workerCells ?? []).map((f) => f.__aio.id)
      : [],
  );
  if (_inIsolateWorkerCells.size > 0) {
    log.info(
      "aio",
      `libraryMode: worker cells (${
        [..._inIsolateWorkerCells].join(", ")
      }) run in-isolate — a test owns the entry module, so there is nothing to ` +
        `host them from. Isolation is not reproduced; the SERIALIZATION ` +
        `boundary is (see below). For the real thing, boot with ` +
        `testServer({ workers: "real", workerEntry }) ` +
        `(docs/testing/prod-parity.md).`,
    );
  }
  _reseedWorkerCells = () => workerPool.reseed();

  /** Make an in-isolate worker cell cross the SAME boundary it crosses in
   *  production.
   *
   *  A real worker cell is reached by `postMessage`, so every argument and
   *  every return value is structured-cloned. In-isolate they were passed by
   *  reference — which is why "behaviour is identical, isolation is not" was
   *  not true, and why this harness could stay green while production threw:
   *  a function, a class instance, a live proxy or anything holding one is
   *  perfectly fine passed by reference and impossible to clone.
   *
   *  That is the harness-versus-production gap this project treats as
   *  disqualifying — a test environment more permissive than production
   *  manufactures green-test-broken-prod. Cloning here costs a test nothing and
   *  moves the failure to the run that can still act on it.
   *
   *  Scoped precisely to cells that WOULD have been hosted: an app with no
   *  worker cells pays nothing, and production never reaches this at all. */
  const _cloneAcrossWorkerBoundary = (
    value: unknown,
    what: string,
    cellId: string,
  ): unknown => {
    try {
      return structuredClone(value);
    } catch (e) {
      throw new Error(
        `cell "${cellId}" is a worker cell, and its ${what} cannot cross a ` +
          `worker boundary: ${e instanceof Error ? e.message : String(e)}.\n` +
          `In this test it runs in-isolate, so a reference would have worked ` +
          `— in production it is reached by postMessage and this throws. ` +
          `Pass plain data (no functions, class instances, or live cell ` +
          `proxies); \`{ ...obj }\` off a proxy is already materialised.`,
      );
    }
  };
  const _workerBoundaryDispatch: typeof dispatch = ((a: A) => {
    const type = (a as unknown as { type?: unknown })?.type;
    if (typeof type !== "string") return dispatch(a);
    const i = type.indexOf(":");
    const cellId = i === -1 ? type : type.slice(0, i);
    if (!_inIsolateWorkerCells.has(cellId)) return dispatch(a);
    const sent = _cloneAcrossWorkerBoundary(a, "action payload", cellId) as A;
    const out = dispatch(sent);
    return Promise.resolve(out).then((v) =>
      v === undefined
        ? v
        : _cloneAcrossWorkerBoundary(v, "return value", cellId)
    );
  }) as typeof dispatch;

  const appDispatch = workerPool.size > 0
    ? (workerPool.route(
      (a) => dispatch(a as unknown as A),
    ) as unknown as typeof dispatch)
    : _inIsolateWorkerCells.size > 0
    ? _workerBoundaryDispatch
    : dispatch;
  if (workerPool.size > 0) {
    // Boot fails loudly if a host can't bind — a silently missing worker cell
    // would answer every call with a hang.
    await workerPool.ready();
  }

  const { shutdown: _shutdownRuntime } = createShutdownOrchestrator({
    sessionStore,
    userStore,
    flushPersist: async () => {
      await persistence.flushPersist();
      // Sync cells' server-origin writes debounce into their snapshot — a
      // clean exit must not leave the last write inside that window.
      await syncHandler?.flushServerWrites();
    },
    setShuttingDown: persistence.setShuttingDown,
    diagHooks,
    getVitalsCheckTimer: () => _vitalsCheckTimer,
    getVitalsSystem: () => vitalsSystem,
    onStop,
    appLock,
    scheduleManager,
    ownManager,
    dispatch,
    // Shutdown aborts + drains THIS app's cells only — another app sharing the
    // process (D2) keeps running its own in-flight methods.
    getCellNames: () => config._cellNames ?? [],
    getAppId: () => resolveAppId(config.appId),
    getElectronProc: () => _electronProc,
    clearElectronProc: () => {
      _electronProc = null;
    },
    disposeUds: udsCtrl.dispose,
    getUdsHandle: () => udsHandle,
    getServer: () => server,
    getDiscoveryStop: () => discoveryRef.stop,
    asyncDb,
    kvDb,
    setRunning: (_v: boolean) => {
      /* multi-instance (D2): no process-wide running flag */
    },
    log,
  });

  /** Stop the worker threads BEFORE the rest of the runtime, and note that the
   *  order is load-bearing rather than incidental.
   *
   *  A worker's in-flight methods live in its own isolate, so Phase 1's
   *  `abortAllInflight` cannot see them; the worker host runs its own
   *  abort + settle on the `close` message and streams the final writes home as
   *  patches, which the ack cannot overtake (FIFO). Those writes arrive as
   *  ordinary dispatches — so they must land while dispatch is still OPEN,
   *  i.e. before `_shutdownRuntime()` closes it and takes the final snapshot.
   *  Closing the pool after the runtime would silently drop exactly the writes
   *  the worker just drained to produce.
   *
   *  `tests/shutdown-worker-cell-durability.test.ts` pins this end to end with
   *  a real worker (libraryMode runs worker cells in-isolate, so an in-process
   *  test cannot reach this path). */
  const shutdown = async (): Promise<void> => {
    await workerPool.close();
    await _shutdownRuntime();
    // A closed app owns nothing: release THIS app's cells so they can bind
    // again. Without it a cell def stayed claimed for the life of the process,
    // so two `testServer()` blocks in one file failed with "already bound" even
    // with `await using` — the second test had to move to its own file for no
    // visible reason. Scoped to our own cells, so a second app in
    // the same process is untouched.
    const release = (app as Record<string, unknown>)._releaseCells as
      | (() => void)
      | undefined;
    release?.();
    _unregisterAuthStore?.();
    _unregisterRuntime();
  };

  /** Tell the PROCESS about this app, so any process-wide exit (a signal,
   *  `am stop`, the Electron window closing) waits for THIS app's final
   *  snapshot too — not just for whichever app got there first. */
  const _unregisterRuntime = registerRuntime(() => shutdown());

  // Content-addressed blob store (tier ③) — resolved through the SAME
  // registered app dirs everything else uses; lazy (no dirs until first put).
  const blobStore = openBlobStore(appId, config.appDir);

  const app = buildAppObject<S, A>({
    dispatch: appDispatch,
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    port,
    asyncDb,
    initialState,
    persistence,
    schedulePersist: () => schedulePersist(),
    getTT: () => tt,
    setTT: (t) => {
      tt = t;
    },
    getServer: () => server,
    udsBroadcastFull: () => udsCtrl.broadcastFull(),
    onStateReplaced: () => workerPool.reseed(),
    shutdown,
    sessionStore,
    userStore,
    blobs: blobStore,
  });

  // --- Phase 4: start transport + lifecycle ---
  // ONE decider — same function the ui:"all" privacy warning uses, so a
  // config-exposed app can never be exposed-but-unwarned (see `_exposeOf`).
  const expose = _exposeOf(cli, config);
  const users = config.users;
  const _resolveUser = config.resolveUser
    ? (tok: string) => config.resolveUser!(tok, state)
    : undefined;
  const sessionResolver = sessionStore
    ? (tok: string) => sessionStore.get(tok)
    : undefined;
  // Per-user credentials (users / resolveUser / auth:true) and the shared app
  // key are mutually exclusive — an app in per-user mode never authenticates
  // anyone with `app.key`.
  const _perUserAuth = !!users || !!_resolveUser || authEnabled;
  // NOTE the condition here is deliberately NOT `_perUserAuth`. `token` means
  // two things downstream — "the credential to enforce" and "the author asked
  // for a shared key" — and server.ts's `key:`+`auth:` boot refusal reads the
  // second. Skipping resolution for an `auth: true` app therefore silenced that
  // refusal and booted an app whose advertised key gated nothing, which is the
  // exact failure the refusal exists to prevent.
  // alpha52: exposed with NO auth story at all (no users/resolveUser/auth,
  // `key` undecided) now defaults to `key: true` — a generated shared key,
  // persisted 0600, carried by the share link — instead of an app open to
  // everyone on the network. `key: false` is the explicit opt-out (aiol's
  // migration fix inserts it to preserve a pre-alpha52 open app).
  const _cfgKey = (config as { key?: string | boolean }).key;
  const { key: _effKey, defaulted: _keyDefaulted } = defaultAppKeyConfig({
    expose,
    perUserAuth: _perUserAuth,
    key: _cfgKey,
  });
  const _keyRes = (expose && !users && !_resolveUser)
    ? resolveAppKey(appId, _effKey)
    : { key: undefined, persisted: false, explicit: false };
  // Named once, in the author's own spelling — see `exposeReason`.
  const _why = exposeReason(
    parseCli(),
    config as { expose?: boolean; host?: string },
  );
  if (_keyDefaulted && _keyRes.key) {
    log.warn(
      `${_why} with no \`key\` configured — generated a shared app key ` +
        `(persisted at ${appKeyPath(appId)}, mode 0600; stable across ` +
        `restarts). The share link below carries it; devices pair by PIN. ` +
        `This is the alpha52 default. To run OPEN to everyone on the ` +
        `network, say so explicitly: key: false.`,
    );
  }
  if (_cfgKey === false && expose && !_perUserAuth) {
    log.warn(
      `${_why} with key: false — this app is OPEN: anyone who can reach ` +
        `the port can read broadcast state and call methods. If that is not ` +
        `intended, delete \`key: false\` (a shared key is generated) or add ` +
        `per-user auth (users/resolveUser/auth).`,
    );
  }
  // An app that MOVED from `key: true --expose` to per-user auth left its old
  // `app.key` on disk, and nothing ever cleared it: `resolveAppKey` owns "the
  // key file tells the truth" but only runs on the shared-key path. `am profile`
  // reads that file directly, so it kept exporting a dead credential as the
  // current one — and it would come back to life the moment the app switched
  // back. Per-user mode is the ONLY safe place to clear it: "not exposed right
  // now" does not mean the key is dead, and deleting it there would regenerate a
  // different one on the next `--expose` and break every already-paired device
  // ("one key, use forever").
  if (_perUserAuth && !_keyRes.key) {
    try {
      Deno.removeSync(appKeyPath(appId));
      log.debug(
        `auth: removed stale app.key — this app uses per-user credentials`,
      );
    } catch { /* none present: the normal case */ }
  }
  const token = _keyRes.key;
  const clientCounter = { value: 0 };
  const udsRef = { current: null as UDSHandle | null };

  // Resolved BEFORE the transport is set up so an invalid `tls` shape fails at
  // boot, where it can name the config key, not at the first handshake.
  const _tls = _tlsOf(config as { tls?: AioConfig<S, A, E>["tls"] });
  const transport = await setupTransport<S, A>({
    appId,
    appVersion: await _appVersion(),
    port,
    portRequested: portFrom !== "default",
    prod,
    distDir,
    electronDistDir,
    // The shell the app runs in: the dev graph evaluation presents its UA.
    shell: defaultClientFor(config.client) === "electron"
      ? "electron"
      : "browser",
    baseDir,
    expose,
    token,
    users,
    resolveUser: _resolveUser,
    sessionResolver,
    // AUTH-2/3: login-flow deps — aio-server adds the TLS-aware `secure` flag.
    authFlows: userStore && sessionStore
      ? {
        users: userStore,
        sessions: sessionStore,
        signup: authOpts.signup !== false,
        cookie: authOpts.cookie !== false,
        ttlMs: authOpts.ttlMs,
        appTitle: title,
        sendMail: authOpts.sendMail,
        requireVerified: authOpts.requireVerified,
        totp: authOpts.totp,
        oidc: authOpts.oidc,
      }
      : undefined,
    // TLS: ONE decider for the flag/config pair. The flags are per-launch and
    // win; `tls` in config is how a compiled binary — a service unit passes no
    // shell flags — declares the same thing (R-7).
    cliCert: cli.cert ?? _tls.cert,
    cliKey: cli.key ?? _tls.key,
    cliNoTls: cli.noTls ?? _tls.noTls,
    // Which of the two said so — the warning names what was actually written.
    noTlsSource: cli.noTls !== undefined ? "flag" : "config",
    cliTransport: cli.transport,
    ui,
    title,
    // HOP 2 of the config bridge — MECHANICAL, never a hand-copied literal.
    // The whole config rides across and `TransportConfig` (aio-server.ts) is
    // the single list of what may be read. The literal that used to stand here
    // silently dropped `serveDirs` (feature dead on arrival) and `_cellNames`
    // (browser drift warning unreachable), after strictOrigin/redactActions/
    // appDir/renderBudget did the same at hop 1. Gate:
    // tests/config-bridge-hop2.test.ts.
    config,
    getState: () => state,
    getUIState: (s, user?) => getUIState(s, user),
    // ROUTED dispatch: a network-borne action for a `worker: true` cell must
    // reach its worker, not be reduced here. The raw dispatcher would have run
    // the method on the main isolate — no isolation at all, and the worker's
    // copy of the slice would drift out of sync with ours.
    dispatch: (action) => appDispatch(action as A),
    app: {
      snapshot: () => app.snapshot!(),
      loadSnapshot: (json) => app.loadSnapshot!(json),
    },
    blobs: blobStore,
    vitalsSystem,
    costMeter,
    useElectron,
    tt: tt ? { handleTTCommand, getTTBroadcast: () => toBroadcast(tt!) } : null,
    syncHandler: syncHandler ?? null,
    syncBroadcastRef,
    shutdown,
    udsHandle: udsRef,
    schedulePersist: () => schedulePersist(),
    shouldPersist,
    scheduleManager,
    // Cell id → method names — trojan `cells` route (amui run-method buttons).
    cellMethods: config._cellMethods ?? {},
    cellAsyncMethods: config._cellAsyncMethods ?? {},
    cellFields: config._cellFields ?? {},
    asyncDb,
    // In-memory dispatch timeline — the trojan `timeline` route.
    getTimeline: (after?: number, limit?: number) =>
      timeline.entries(after, limit),
    // Boot migration + shape-drift picture — trojan `migrations`.
    migrations: migrationSummary,
    appLock,
    clientCounter,
    log,
  });

  server = transport.server;
  // The port this process is REALLY on. `port` above may be the literal 0 of
  // `port: 0` ("pick a free port"); the listener resolved it, and every place
  // that NAMES a port — the boot report, the ws URL, the lock — has to say the
  // resolved one. Printing 0 is the same confidently-wrong line as printing a
  // number for an app that bound nothing.
  const livePort = transport.server.boundPort ?? port;
  udsHandle = transport.udsHandle;
  udsRef.current = udsHandle;

  // `asyncDb` is optional; bind it once so the narrowing survives into the
  // callback that takes the pre-migration backup.
  const _snap = asyncDb?.snapshot?.bind(asyncDb);
  const _snapshotDb = _snap ? (path: string) => _snap(path) : undefined;

  // Updates: opt-in, and off by default in libraryMode (a test or a host app
  // owns this process; nothing it did should replace a binary).
  const _updates = config.updates && !config.libraryMode
    ? await startUpdates({
      updates: config.updates,
      dataDir: _dirs.data,
      appName: appId,
      appVersion: await _appVersion(),
      stamp: (appDenoJson()?.build as { channel?: string } | undefined)
        ?.channel,
      flag: cli.channel,
      local: {
        schema: PERSIST_SCHEMA_VERSION,
        cells: migrationSummary?.stored ?? {},
      },
      exposed: expose,
      log,
      argv: Deno.args,
      snapshot: _snapshotDb,
      shutdown: () => _shutdownRuntime().catch(() => {}),
      prompt: ttyPrompt(),
    })
    : undefined;

  // Problem reports: user-filed and automatic. Off in libraryMode — a test or
  // a host app owns this process, and its failures are not the app's to file.
  const _feedback = config.feedback && !config.libraryMode
    ? await startFeedback({
      feedback: config.feedback,
      log,
      redact,
      sources: {
        appId,
        appVersion: await _appVersion(),
        aioVersion: VERSION,
        dataDir: _dirs.data,
        logsDir: _dirs.logs,
        exposed: expose,
        persist: shouldPersist,
        cells: Object.keys(config._cellMethods ?? {}),
        channel: _updates?.channel,
        getState: () => app.getState() as Record<string, unknown>,
        // The app's own `visible` declaration screens the state a report
        // carries — see ReportSources.visible. Same map the trojan `fields`
        // route serves, so there is one answer to "what may leave the server".
        visible: config._cellFields,
        getTimeline: () => timeline.entries(),
      },
    })
    : undefined;

  // Lifecycle: globals, onStart, schedules, logging, client launch
  startLifecycle({
    // Boot-report auth label — "password+totp+oidc", "sessions", or fallback.
    authMode: authEnabled
      ? [
        "password",
        authOpts.totp !== false ? "totp" : "",
        authOpts.oidc ? "oidc" : "",
        authOpts.requireVerified ? "verified-email" : "",
      ].filter(Boolean).join("+")
      : sessionStore
      ? "sessions"
      : undefined,
    // Facts the report cannot read off the process: where this app keeps what
    // it owns, and what it is actually running.
    bootExtras: {
      pid: Deno.pid,
      client: { value: client, from: clientFrom },
      // An app that binds no TCP port has no port fact to report. It used to
      // print one anyway — `findFreePort()` runs before the transport is even
      // decided — so a zero-port app announced a number it never bound, and
      // anyone who tried it got a refused connection. `sourced()` drops an
      // undefined value, and the socket is named on its own line instead.
      port: transport.httpSocketPath || transport.skipHttp
        ? { value: undefined as unknown as number, from: portFrom }
        : { value: livePort, from: portFrom },
      entry: {
        // What is RUNNING, read from the process — not what a config said
        // should run. Those differ exactly when someone is confused.
        value: Deno.mainModule.replace(/^file:\/\//, ""),
        from: "default",
      },
      heap: _heapLine,
      plugins: config._pluginNames,
      dataDir: _dirs.home,
      logs: { dir: _dirs.logs, level: cli.verbose ? "debug" : "info" },
      journal: config.journal
        ? (typeof config.journal === "string" ? config.journal : _dirs.journal)
        : undefined,
      cells: Object.keys(config._cellMethods ?? {}),
      // What is NOT ordinary about a cell: its own thread, or a second writer.
      // Both change how a symptom is read, and neither was visible without
      // opening the source.
      workers: [...getRegisteredCells().values()]
        .filter((c) => (c as { __aio?: { worker?: boolean } }).__aio?.worker)
        .map((c) => (c as { __aio: { id: string } }).__aio.id),
      syncCells: [...getRegisteredCells().values()]
        .filter((c) =>
          (c as { __aio?: { syncConfig?: unknown } }).__aio?.syncConfig !==
            undefined
        )
        .map((c) => (c as { __aio: { id: string } }).__aio.id),
      routes: config.routes ? Object.keys(config.routes).length : 0,
      feedback: _feedback
        ? {
          auto: _feedback.auto,
          keep: _feedback.keep,
          destination: _feedback.url ??
            (_feedback.hasSink ? "custom sink" : undefined),
        }
        : undefined,
      updates: _updates
        ? {
          source: _updates.source,
          kind: _updates.kind,
          channel: _updates.channel,
          intervalMs: _updates.intervalMs,
          auto: _updates.auto,
        }
        : undefined,
    },
    appId,
    appVersion: await _appVersion(),
    title,
    prod,
    electronDistDir,
    distDir,
    baseDir,
    expose,
    singletonMode,
    childWindows: !!config.childWindows,
    client,
    useElectron,
    isHeadless,
    libraryMode: config.libraryMode,
    transport: transport.transport,
    skipHttp: transport.skipHttp,
    httpSocketPath: transport.httpSocketPath,
    port: livePort,
    token,
    users,
    perUserAuth: _perUserAuth,
    tlsCert: transport.tlsCert,
    shareUrl: transport.shareUrl,
    localUrl: transport.localUrl,
    advertiseHost: transport.advertiseHost,
    server,
    udsHandle,
    app,
    onStart,
    fatalOnStart: config.fatalOnStart,
    scheduleManager,
    schedules: config.schedules,
    shouldPersist,
    persistMode,
    asyncDb,
    db: config.db,
    maxConnections: config.maxConnections,
    cli: {
      width: cli.width,
      height: cli.height,
      keepServer: cli.keepServer,
      open: cli.open,
    },
    // The FULL head-shaped config, not just the window box: the dev Electron
    // aio:// shell is templated at launch and has no other way to learn
    // ui.head/ui.viewport/ui.showStatus. Dropping them here made an app that
    // respected ui.head under `deno task dev` (HTTP) ship it in the packaged
    // window but NOT in the dev Electron window — two dev surfaces, two heads
    // (WYSIDIWYSIP).
    ui: {
      width: ui.width,
      height: ui.height,
      showStatus: ui.showStatus,
      viewport: ui.viewport,
      head: ui.head,
    },
    keepServer: config.keepServer,
    setElectronProc: (proc) => {
      _electronProc = proc;
    },
    setDiscoveryStop: (stop) => {
      discoveryRef.stop = stop;
    },
    appLock,
    log,
  });

  // Whatever was pending has now booted far enough to SERVE — confirm it, so a
  // later boot does not roll back a version that works.
  //
  // After startLifecycle, not before it. "Healthy" used to mean "bound a
  // socket", which a build that throws in `onStart`, fails to open its window
  // or dies in a schedule passes without doing anything an app is for — and
  // confirming it threw away the only rollback it had.
  if (!config.libraryMode) confirmPendingUpdate(_dirs.data, log);

  // Boot is DONE: the crash guard may now supervise runtime rejections. Until
  // this line a rejection means "the app refused to start" (a throwing
  // onMigrate, a failed bind) and must stay fatal — flipping the guard's
  // default without this gate turned the framework's own boot-refusal test
  // into a zombie that idled for an hour.
  diagHooks?.markBootComplete();

  return app;
}

/** Main aio namespace — `aio.run(config)` starts the server.
 *
 *  `aio.stop()` / `aio.restart()` are the handle-free spellings of "end this
 *  process cleanly" and "come back", safe from inside a cell method (deferred
 *  by a macrotask, so the method returns before the shutdown contract drains
 *  the cells). Both run EVERY app in the process through its full shutdown
 *  (finish writing, final snapshot). `restart()` is a promise per launcher —
 *  the matrix, and the launchers where it REFUSES with the manual step, are
 *  in aio-lifecycle.ts (`restartPlan`). */
export const aio = {
  run,
  stop: (): Promise<void> => requestStop(),
  restart: (): Promise<RestartPlan> => requestRestart(),
};
