import { produce } from "immer";
import { validateMemoryConfig } from "../diagnostics/memory-monitor.ts";
import { refuseRetired } from "../state/removals.ts";
import { installBundleSourceMap } from "./sourcemap-boot.ts";
// Core runtime orchestrator — boots KV, server, electron, wires everything together.
// Phase logic lives in aio-boot, aio-dispatch, aio-server, aio-lifecycle, aio-run-helpers.
// Cell composition logic lives in aio-composition and aio-cells-bridge.

import {
  APP_STYLE,
  appHasStylesheet,
  BUNDLE_JS,
  BUNDLE_MAP,
  UI_ENTRY,
} from "./app-files.ts";
import { readLocalPinSync } from "./deno-json.ts";
import { createShutdownOrchestrator, registerRuntime } from "./shutdown.ts";
import { _registerAuthStore, serverUser } from "./auth-context.ts";
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
import { createOwnManager } from "../state/own.ts";
import { routeEffect } from "../state/route-effect.ts";
import { notifyCrossUserGate, showNotifyEffect } from "./aio-dispatch.ts";
import { getLogger, log, setLogger } from "../diagnostics/logger-api.ts";
import type { LogSink } from "../diagnostics/logger-types.ts";
import { timeTravelEnabled } from "../diagnostics/types.ts";
import {
  createAioError,
  reportError as reportAioError,
  teachableError,
} from "../diagnostics/error.ts";

// Phase modules — extracted _run() logic
import {
  bootStorage,
  isDevBoot,
  replaySyncOps,
  runCellRestore,
} from "./aio-boot.ts";
import { deepMerge } from "../state/deep-merge.ts";
import { restoreExcluded } from "../state/state-filter.ts";
import {
  type ActionCause,
  type JournalEntry,
  type JournalGap,
  replayJournal,
  syncJournalWatermarkKey,
  type TimeTravelRestore,
  TT_RESTORE_TYPE,
  workerPatchCell,
} from "./journal.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { createTimeline } from "./timeline.ts";
import { makeRedactor } from "../diagnostics/redact.ts";
import { degraded } from "../diagnostics/degraded.ts";
import { actionOrigin, isWriteSetAction } from "../diagnostics/action-kind.ts";
import { setupDispatch } from "./aio-dispatch.ts";
import { hostedCellName, startCellWorkerHost } from "./cell-worker-host.ts";
import { createCellWorkerPool } from "./cell-worker-pool.ts";

import { validateSchedules } from "../state/schedule.ts";
import {
  currentHeapLimitBytes,
  declaredMaxHeapOf,
  describeHeapPolicy,
  physicalMemoryBytes,
  reportHeapCeiling,
} from "./heap-policy.ts";
import type { Provenance, Sourced } from "./boot-facts.ts";
import {
  dbPathOf,
  exposeFlagOf,
  hostOf,
  keepServerOf,
  persistOf,
  pick,
  pickOr,
  serverUrlOf,
  sourceLines,
  tlsOf,
  windowSizeOf,
} from "./config-sources.ts";
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
import { adoptHiddenConsole } from "./no-console.ts";
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
import {
  _cloneAcrossWorkerBoundary,
  _mapCallResult,
  _setCallTimeouts,
} from "../state/cell-impl.ts";
import { _moveRejections } from "../state/rejection-tracker.ts";
import {
  buildLegacyConfig,
  filterCellsByIsolate,
  initLogger,
  runAsApp,
  wrapAppWithCells,
} from "./aio-cells-bridge.ts";
import { getRegisteredCells } from "../state/cell-reactive.ts";
import {
  _releaseUpdatesClaim,
  _updatesForApp,
  type UpdatesSlot,
} from "../state/updates-cell.ts";
import {
  _feedbackForApp,
  _releaseFeedbackClaim,
  type FeedbackSlot,
} from "../state/feedback-cell.ts";
import { createCostMeter } from "../vitals/cost-meter.ts";

// CLI + path resolution
import {
  cdpPort,
  declareAppFlags,
  electronOnlyFlagRefusal,
  envDefaultPort,
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
  baseDirCandidates,
  distCandidates,
  envPort,
  findFreePort,
  isCompiled,
  realDistCandidates,
} from "./paths.ts";
import { openSessionStore, type SessionStore } from "./sessions.ts";
import { openUserStore } from "./auth-users.ts";
import { holdFileSizeGuard, resolveAppId } from "./single-instance-lock.ts";
import { appKeyPath, defaultAppKeyConfig, resolveAppKey } from "./app-key.ts";
import { assertDenoVersion } from "./deno-version.ts";
import { removalMessage, removalOf } from "../state/removals.ts";
import { basename, dirname, fromFileUrl, join, resolve } from "@std/path";
import { lint, printLint } from "./lint.ts";
import { composeAsyncHooks, composeHooks, resolvePlugins } from "./plugin.ts";
import { setFallbackLogDir } from "../diagnostics/logger-api.ts";
import {
  installProcessSignals,
  releaseProcessListenersIfIdle,
} from "./shutdown.ts";

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
  refuseWrongShapes,
  retiredDenoJsonKeys,
  VALID_AIO_CONFIG_KEYS,
  VALID_FEATURES_CONFIG_KEYS,
  VALID_UI_KEYS,
  validateCallableConfig,
  validateConfig,
} from "./config.ts";
import { count } from "../diagnostics/fmt.ts";
import { isDiagnosticsOptOut } from "../diagnostics/diagnostics-optout.ts";
import { resolveBudgets, setBudgets } from "../state/budgets.ts";

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
  if (exposeFlagOf(cli, config).value) return true;
  return _hostIsExposed(hostOf(cli, config)?.value);
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
      `app declares, or \`am pin latest\` to record what it is running.`,
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
  layout?: boolean,
): { level: "info" | "warn"; message: string } | null {
  if (theme !== "full" && theme !== "auto") {
    // `ui.layout: false` on a theme that paints nothing is a setting with no
    // effect — and a setting with no effect is worse than a missing one,
    // because the author believes it is doing something.
    if (layout === false) {
      return {
        level: "warn",
        message:
          `ui.layout: false has no effect with ui.theme "${
            theme ?? "tokens"
          }" — ` +
          `that theme emits no visual rules, so there is no layout to drop. ` +
          `Set ui.theme "full" (or "auto") to get the ELEMENT defaults ` +
          `— canvas, type, forms, tables, focus rings — without the page ` +
          `container or the six layout classes.`,
      };
    }
    return null;
  }
  if (layout === false) {
    return {
      level: "info",
      message:
        `theme: ui.theme "${theme}" with ui.layout false — aio styles ELEMENTS ` +
        `(canvas, type, forms, tables, code, focus rings) and emits NO layout: ` +
        `no \`<main>\` page container and none of .card/.row/.stack/.grid/` +
        `.muted/.badge. Your CSS owns where things go.`,
    };
  }
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
  return clientOf({}, { client: configClient }).value;
}

/** THE client decider: `--client` > `aio.run({ client })` > the app's
 *  deno.json `client` > electron — value and source from one list. It was
 *  spelled out at three sites, with its source re-derived at a fourth. */
export function clientOf(
  cli: { client?: string },
  config: { client?: string },
): Sourced<string> {
  return pickOr<string>(
    "electron",
    ["flag", cli.client],
    ["config", config.client],
    ["deno.json", _denoJsonTargetClient()],
  );
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

/** THE app-dir ladder for this process, most authoritative first — see
 *  `baseDirCandidates`, which owns the rule. Every input is read here and
 *  nowhere downstream, so one process has one answer. */
function _inferBaseDirs(): [string, ...string[]] {
  return baseDirCandidates({
    mainModule: Deno.mainModule,
    cwd: Deno.cwd(),
    compiled: isCompiled(),
  });
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
function run(a?: any, b?: any): Promise<AioApp<any, any>> {
  // AS ITS APP: every line, diagnostic and `degraded()` failure this boot —
  // and every handler, socket and timer it starts — belongs to this app, not
  // to whichever app in the process booted last (`runAsApp`). Before its
  // logger exists the app is console-only.
  return runAsApp(() => _runAsApp(a, b));
}

// deno-lint-ignore no-explicit-any
async function _runAsApp(a?: any, b?: any): Promise<AioApp<any, any>> {
  // ── the app's OWN flags join the vocabulary before argv is ever read ──
  //
  // This used to happen at the end of config composition, ~120 lines below —
  // long after the `--help` query on the very next line calls `parseCli()`,
  // which REFUSES an unknown flag by throwing. So `appFlags` never worked at
  // all: `aio.run({ appFlags: ["--sync"] })` invoked as `app --sync` died in
  // the parser before the declaration it needed was made. That is the escape
  // hatch every "unknown flag" error names ("declare it: aio.run({ appFlags:
  // [...] })"), so the remedy aio recommends was itself broken, and
  // `deno task soak`/`soak:72h` — a named beta gate — could not start.
  //
  // `declareAppFlags` clears the parse cache, so declaring here is what makes
  // every later `parseCli()` see the app's vocabulary. Plugins contribute no
  // flags (the merge below touches routes/schedules/origins/hooks only), so
  // the raw config is the whole truth at this point.
  if (typeof a === "object" && a && "appFlags" in a) {
    declareAppFlags((a as CellsConfig).appFlags);
  }
  // ── `--help` is a QUERY: it must not boot the app ──
  //
  // This check used to live in `_run`, three phases later — by which time the
  // composition report had printed ("cells: counter", "cells: counter
  // visible=all persist=all") and, worse, the logger had ROTATED the app's log
  // files: `app.log` → `app.log.1`, one generation lost off the end of `keep`
  // every time someone asked what the flags were. Asking a binary for its usage
  // is the safest thing anyone does with it; it must have no side effects at
  // all. Same reasoning as `--aio-data-contract` below, one step earlier.
  // A TYPO IS THE COMMONEST THING ANYONE GETS WRONG AT A CLI, and it got the
  // ugliest answer in the framework. The message `parseCli` throws is
  // carefully teachable — it names the flag, offers `appFlags`, and explains
  // why a bare `--` cannot help a compiled binary — and it reached the user
  // wrapped in `error: Uncaught (in promise)` with five frames of aio
  // internals above it (the shape a field report quoted, verbatim, in
  // tests/app-flags.test.ts's header). Every other refusal at this stage
  // ("Already running", a bad config) prints one line and exits.
  //
  // `console.error`, not the logger: installing the logger is a side effect
  // this phase deliberately avoids (see `--help` just below), and it would
  // stamp a timestamp and a category on the answer to "what did I type
  // wrong". `libraryMode` keeps the throw — an embedding host and the test
  // harness want the exception, not an exit, and `libraryMode` is the
  // documented flag for exactly that ("no Deno.exit, no SIGINT handlers, no
  // singleton lock"). Exiting when it is OFF follows the precedent already in
  // this file: `judgePendingUpdate` below ends the process the same way, under
  // the same `!config.libraryMode` guard, for the same kind of fatal pre-boot
  // condition.
  try {
    parseCli();
  } catch (e) {
    const cfg = typeof a === "object" && a !== null
      ? a as { libraryMode?: boolean }
      : null;
    if (cfg?.libraryMode) throw e;
    // aio-ok: the logger is not installed yet, and installing it is the side
    // effect this phase exists to avoid — `--help` and `--version` below take
    // the same exemption for the same reason. A levelled line would also stamp
    // a timestamp and a category on the answer to "what did I type wrong".
    console.error(e instanceof Error ? e.message : String(e));
    Deno.exit(1);
  }
  if (parseCli().help) {
    printHelp(_helpFacts(typeof a === "object" && a ? a.client : undefined));
    Deno.exit(0);
  }
  // ── …and `--version`, for the same reason and one of its own ──
  //
  // It sat three phases later, AFTER `resolveAppDirs` — so a compiled binary
  // asked for its version with `$HOME` unset answered with a stack trace out
  // of the directory resolver, and with `$HOME` set it printed two boot lines,
  // ROTATED the app's log files and ended with a stray empty `detail=` field.
  // Asking an artifact what it is must cost nothing and touch nothing.
  //
  // `console.log`, not `log.info`: this is the answer itself, and the logger
  // would stamp it with a timestamp and a category — and installing the logger
  // is the side effect being avoided.
  if (parseCli().version) {
    // An artifact has to be able to say what it IS and what it was built with
    // — a binary found on a server months later is otherwise unidentifiable,
    // and "which aio is this running?" is the first question when it
    // misbehaves. Same sources the app itself uses for its identity
    // (`resolveAppId` handles the compiled-binary case), so `--version` cannot
    // describe a different app than the one that would boot.
    // aio-ok: the answer itself — a log stamp would prefix what a script reads.
    console.log(
      versionLine(
        resolveAppId(typeof a === "object" && a ? a.appId : undefined),
        await _appVersion(),
      ),
    );
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
  // Hook authorship is read HERE, from the object the app actually wrote, and
  // nowhere later. Every rebuild below materialises omitted hooks — the plugin
  // merge writes `onStopping: fc.onStopping` and composes the rest, the cells
  // bridge spreads them again — so downstream "the key is present" stops
  // meaning "the app wrote it", and warning there fired on every boot of every
  // app about hooks it had never mentioned.
  validateCallableConfig(fc as unknown as Record<string, unknown>);
  // The SHAPE of every key, BEFORE the first reader of one — and the plugin
  // merge just below is that reader. It spreads `allowedOrigins` and `routes`,
  // and a spread bare string becomes its characters, so with a plugin loaded
  // `allowedOrigins: "https://app.example.com"` reached `validateConfig` as a
  // valid array of 23 one-character origins and the Origin gate became the
  // substring test SHAPE_VALUES exists to stop. `resolvePlugins(fc.plugins…)`
  // on the next line reads one more. Same function `validateConfig` runs
  // below — one decider, called at the moment the answer is first needed.
  refuseWrongShapes(fc as unknown as Record<string, unknown>, "CellsConfig");
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
        // App FIRST, in insertion order, and a plugin entry only for a key the
        // app did not write. The matcher tries patterns in insertion order, and
        // `{ ...plugins, ...app }` put every plugin pattern ahead of the app's
        // (a key keeps its FIRST position even when a later spread overwrites
        // its value) — so a plugin's `/*` or `/files/:name` answered the app's
        // own `/files/*` and `/api/:thing`. An app route with the same key
        // still wins outright, as before.
        ? {
          ...(fc.routes ?? {}),
          ...Object.fromEntries(
            Object.entries(_plugins.routes).filter(([k]) =>
              !Object.hasOwn(fc.routes ?? {}, k)
            ),
          ),
        }
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
      // No plugin twin: `onStopping` quiesces the APP's own producers, and a
      // plugin that owns one closes it in its `onStop` as it always has.
      onStopping: fc.onStopping,
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
  // `killExisting` is retired (alpha76): the flag has been `--takeover` since
  // alpha52 and the key had not moved, so a COMPILED service binary — which
  // cannot pass a flag — was forced to write the deprecated spelling. Dev
  // refuses; prod logs the registry line and HONOURS the old key, because a
  // service that silently stopped taking over its own lock would fail to boot
  // rather than fail loudly.
  if ("killExisting" in fc) {
    refuseRetired(removalOf("aio.run({ killExisting })"), "aio.run");
    const legacy = (fc as Record<string, unknown>).killExisting;
    delete (fc as Record<string, unknown>).killExisting;
    if (fc.takeover === undefined) fc.takeover = legacy as boolean;
  }
  validateConfig(
    fc as unknown as Record<string, unknown>,
    VALID_FEATURES_CONFIG_KEYS,
    "CellsConfig",
  );
  // Statically knowable, so it is refused while it is still config — not out
  // of scheduleManager.start() once persistence is open and the port is bound.
  if (fc.schedules !== undefined) validateSchedules(fc.schedules);
  // Post-merge: refuse a non-function, but do not read absence as intent —
  // authorship was checked above, on the app's own object.
  validateCallableConfig(fc as unknown as Record<string, unknown>, false);
  // BEFORE anything reads argv. The app's own verbs join aio's vocabulary
  // here, so a declared flag is passed through rather than refused — and a
  // typo in one gets the same did-you-mean as a typo in aio's own.
  declareAppFlags(fc.appFlags);
  if (fc.ui) {
    validateConfig(fc.ui as Record<string, unknown>, VALID_UI_KEYS, "ui");
  }
  // An app with `memory` and no `ui` had its memory keys accepted unchecked,
  // typos and all — the check lived inside the `ui` one. It still boots (the
  // surface is frozen: refusing what booted yesterday is a break), but the
  // typo is now said out loud. With `ui` it was always a refusal.
  if (fc.memory && !fc.ui) {
    try {
      validateMemoryConfig(fc.memory as Record<string, unknown>);
    } catch (e) {
      log.warn(`${(e as Error).message}\n  (ignored — this key does nothing)`);
    }
  } else if (fc.memory) {
    validateMemoryConfig(fc.memory as Record<string, unknown>);
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

  // Hoisted out of the `try` so a boot that REFUSES can put back what it had
  // already started — see the catch below.
  let logger: Awaited<ReturnType<typeof initLogger>> = null;
  const appRef = {
    current: null as AioApp<Record<string, unknown>, unknown> | null,
  };
  // …and the builtin-cell slots, whose process-slot CLAIM the `finally` gives
  // back once this boot has bound them or refused (see `_feedbackForApp`).
  let _updatesSlot: UpdatesSlot | undefined;
  let _feedbackSlot: FeedbackSlot | undefined;
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
    // feature dead. A field report (report 10) shipped a self-update that could
    // never run for the app's whole life, green in every test and every
    // `deno task dev`, because the config that reaches this branch only
    // exists in a released build.
    //
    // PER APP. The cell a single-app process gets is the one `aio/updates` /
    // `aio/feedback` export; a SECOND app in the same process used to be handed
    // that same, already-bound cell and refused to boot ("[updates] already
    // bound — use a factory"), a factory no app can write for a cell aio owns.
    // `_updatesForApp` gives it a cell (and a runtime slot) of its own.
    _updatesSlot = fc.updates ? _updatesForApp() : undefined;
    _feedbackSlot = fc.feedback ? _feedbackForApp() : undefined;
    const _builtins = [_updatesSlot?.cell, _feedbackSlot?.cell].filter(
      (c): c is NonNullable<typeof c> => c !== undefined,
    );

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
      refusalsReject: fc.refusalsReject,
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
    logger = _contractMode ? null : await initLogger(fc);
    (globalThis as Record<string, unknown>).__aioCells = composed;

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

    // Which cells `startUpdates`/`startFeedback` wire, handed to the boot by
    // the config object's identity rather than as a config KEY (which every
    // layer of validation would have to learn about).
    _appSlots.set(config, { updates: _updatesSlot, feedback: _feedbackSlot });
    const app = await _run(composed.initialState, config);
    appRef.current = app;

    // Post-run: memory monitor, cells API, bindCell
    await wrapAppWithCells(app, composed, fc, cellReportOpts);

    // Cells are bound — the update check can now call cell methods. Armed in
    // _run, fired here, because dispatching before binding throws.
    beginUpdates(_updatesSlot);
    beginFeedback(_feedbackSlot);

    // AIO-418: fire the user's onStart NOW — after the callable cell
    // method surface is bound — so seeding via a cell method (members.seed())
    // works instead of throwing "cell runtime not booted". Error-guarded: a
    // throwing onStart must not abort a successful boot.
    // Guarded for a sync throw AND an async rejection: an `async onStart` used
    // to bypass the catch entirely and surface as an unhandled rejection.
    if (fc.onStart) {
      // `fatalOnStart` is documented to end the process when `onStart` fails
      // (docs/state/lifecycle.md), and it only ever guarded aio's OWN start
      // hook (aio-lifecycle.ts) — this, the app's hook, logged and carried on,
      // so `fatalOnStart: true` left the half-started app running. Same exit
      // as the lifecycle's; under `libraryMode` (no `Deno.exit` allowed) the
      // app is closed instead, so the embedder is not left holding a broken one.
      const failed = (e: unknown) => {
        log.error(`onStart hook error: ${e}`);
        if (!fc.fatalOnStart) return;
        log.error("fatalOnStart is true — exiting due to onStart failure");
        if (fc.libraryMode) void app.close();
        else Deno.exit(1);
      };
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
    // A BOOT THAT REFUSES LEAVES NOTHING BEHIND.
    //
    // The logger is installed before `_run()` and torn down by the app's
    // shutdown — which a refusal (a lint error, a config conflict, a
    // persistence that will not open) never reaches. So a refused boot left
    // the heartbeat interval and the pending flush of its own refusal line
    // armed: the caller got a correct error and a process that would not
    // exit — the "worst of both" shape `logger-core.ts` describes, answered
    // there with an unref that only hides it from the event loop. The op
    // sanitizer named it in every test that asserts a refusal. Torn down
    // HERE, the same way shutdown does it: stop, drain, detach — and an app
    // that did come up before the throw (a hook after `_run`) closes fully.
    // The refusal itself is what the caller sees; a teardown fault is said
    // out loud beside it, never instead of it.
    try {
      if (appRef.current) await appRef.current.close();
      else if (logger) {
        logger.onStop();
        await logger.flush();
        setLogger(null);
      }
      // The SIGINT/SIGTERM listeners go in before `_run()`; with no runtime
      // ever registered, nothing else would take them out again.
      releaseProcessListenersIfIdle();
    } catch (teardown) {
      log.error(
        `boot refused, and the teardown after it failed too: ${teardown}`,
      );
    }
    throw e;
  } finally {
    _releaseUpdatesClaim(_updatesSlot);
    _releaseFeedbackClaim(_feedbackSlot);
  }
}

// ── _run: thin orchestrator calling phase modules ─────────────────────

/** What a boot has started so far — undone in REVERSE when a later step
 *  refuses. `replace` hands the whole list to the app's own shutdown once
 *  that exists (it covers everything registered before it, and more). */
interface BootUndo {
  push(name: string, fn: () => void | Promise<void>): void;
  replace(shutdown: () => Promise<void>): void;
  unwind(): Promise<void>;
}

function createBootUndo(): BootUndo {
  let steps: Array<[string, () => void | Promise<void>]> = [];
  return {
    push: (name, fn) => void steps.push([name, fn]),
    replace: (shutdown) => {
      steps = [["shutdown", shutdown]];
    },
    async unwind() {
      const pending = steps.reverse();
      steps = [];
      for (const [name, fn] of pending) {
        try {
          await fn();
        } catch (e) {
          // Loud, never fatal: the refusal that started this is the error the
          // caller gets; a step that cannot be undone is said beside it.
          log.warn("boot", `refused boot: undoing "${name}" failed — ${e}`);
        }
      }
    },
  };
}

/** A BOOT THAT REFUSES LEAVES NOTHING BEHIND.
 *
 *  `_runPhases` is one long straight line — lock, diagnostics, vitals,
 *  storage, dispatch, workers, then the server — and any step on it can
 *  refuse: a lint error, a route with a wildcard in the middle, a store that
 *  will not open. The refusal reached the caller as a clean error while
 *  everything started before it kept running: the vitals sampler, the
 *  heartbeat, the SQLite worker, the lock. Measured as "a correct error and a
 *  process that never exits" (`logger-core.ts` names the corrupt-`state.db`
 *  case), and by the op sanitizer as an interval left behind by every test
 *  that asserts a refusal. Each step registers its undo as it starts, and a
 *  throw runs them in reverse — dev and prod alike. */
/** The per-app `updates` / `feedback` slots `run()` chose, keyed by the
 *  config it hands `_run`. */
const _appSlots = new WeakMap<
  object,
  { updates?: UpdatesSlot; feedback?: FeedbackSlot }
>();

async function _run<S, A, E>(
  initialState: S,
  config: AioConfig<S, A, E>,
): Promise<AioApp<S, A>> {
  const bootUndo = createBootUndo();
  try {
    return await _runPhases(initialState, config, bootUndo);
  } catch (e) {
    await bootUndo.unwind();
    throw e;
  }
}

async function _runPhases<S, A, E>(
  initialState: S,
  config: AioConfig<S, A, E>,
  bootUndo: BootUndo,
): Promise<AioApp<S, A>> {
  // --- Phase 1: resolve CLI, env, config validation, lint ---
  const cli = parseCli();
  if (cli.help) {
    printHelp(_helpFacts(config.client));
    Deno.exit(0);
  }
  // `--version` is answered in `run()`, before anything resolves a directory
  // or installs a logger — see the hoist there. Nothing to do here.

  // A Windows GUI exe (double-clicked, no console): one hidden console, so no
  // console program this app starts — a native dialog's PowerShell,
  // openExternal's cmd, an update step, the app's own spawn() — flashes a
  // window (src/server/no-console.ts). A terminal-started app is untouched.
  if (Deno.build.os === "windows") {
    const hidden = adoptHiddenConsole();
    if (hidden !== "adopted" && hidden !== "has-console") {
      log.warn("boot", `console children may flash a window: ${hidden}`);
    }
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
      // `memory.maxHeap` from the app's OWN deno.json — the same place
      // `build-compile.ts` reads it, entry-relative like `version` and
      // `title`. It reaches V8 only through the launch, so a bare `deno run`
      // is capped at the automatic share while the config file says 12 GB;
      // this is the surface that tells the author so (see reportHeapCeiling).
      declaredMaxHeap: declaredMaxHeapOf(appDenoJson()),
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
  // THE port chain, in one place, with `am` reading the same four rungs
  // (`declaredPort`): `--port` (operator, this run) > `AIO_PORT` (operator, no
  // command line to hang a flag on — a service unit, a container, a compiled
  // binary) > `aio.run({ port })` (the author) > `AIO_DEFAULT_PORT` (a
  // supervisor's "a stable port, unless the app declares one" — the generated
  // systemd unit) > the runtime picks a free one.
  //
  // deno.json is deliberately NOT a rung: it carries identity and build only
  // (see `_warnMisplacedDenoJson`, which WARNS that a top-level `port` there is
  // inert). `am` used to read it anyway, so a key the runtime told you it was
  // ignoring silently decided where `am` aimed.
  const _envPort = envPort();
  // `AIO_DEFAULT_PORT=0` is "pick a free one" — saying nothing, so no rung.
  const _defaultPort = envDefaultPort() || undefined;
  // Value and source from ONE candidate list (config-sources.ts): the source
  // used to be re-derived with truthiness checks, so `--port=0` was labelled
  // "default" while it was the flag that decided.
  const _portPick = pick<number>(
    ["flag", cli.port],
    ["env", _envPort],
    ["config", config.port],
    ["env", _defaultPort],
  );
  const port = _portPick?.value ?? await findFreePort();
  // Did anyone NAME a port? That opts a local Electron app out of zero TCP
  // ports. The default rung does not count (it fills only the slot a free
  // port would), and neither does `--port=0` / `port: 0` ("pick one") — the
  // exact predicate this had when the source was derived by truthiness, kept
  // now that the source label is honest about a 0.
  const _portRequested = !!cli.port || _envPort !== undefined ||
    !!config.port;
  // "default" = picked by findFreePort — worth saying, since a port that
  // changes between runs is otherwise a mystery.
  const portFrom: Provenance = _portPick?.from ?? "default";

  // Every setting with more than one home, and WHO decided it — from the same
  // resolvers that decide it (config-sources.ts), so a label cannot disagree
  // with its value. Into the lock (for `am doctor`) and, under `--verbose`,
  // the boot report. `client` and `port` have report lines of their own.
  const _settings = sourceLines([
    ["host", hostOf(cli, config)],
    ["expose", exposeFlagOf(cli, config)],
    ["persist", persistOf(cli, config)],
    ["dbPath", dbPathOf(cli, config)],
    ["serverUrl", serverUrlOf(cli, config)],
    ["width", windowSizeOf(cli, config.ui ?? {}).width],
    ["height", windowSizeOf(cli, config.ui ?? {}).height],
    ["keepServer", keepServerOf(cli, config.keepServer)],
  ]);

  // A write past `ulimit -f` must be a refused persist, not a dead process —
  // and that is true of an app EMBEDDED in someone else's process too. The
  // guard used to ride on the singleton lock, so `libraryMode` (which takes
  // no lock, deliberately) inherited the kernel default and died of SIGXFSZ.
  // Held for every boot, lock or no lock: it is process-wide, costs one no-op
  // listener, and grants no exclusivity of any kind.
  const releaseFileSizeGuard = holdFileSizeGuard();
  bootUndo.push("file-size guard", releaseFileSizeGuard);

  // Singleton lock — libraryMode implies no lock (embeddable / testable).
  const singletonMode = config.libraryMode ? false : (config.singleton ?? true);
  // Either one asks for it — an OR, not a precedence.
  const takeover = config.takeover === true || cli.takeover === true;
  const appLock = await acquireSingletonLock(
    appId,
    appDirs(appId, config.appDir).home,
    port,
    singletonMode,
    takeover,
    {
      aioVersion: VERSION,
      cdpPort: cdpPort(),
      // What `am doctor` shows: each multi-home setting and who decided it.
      settings: Object.fromEntries(_settings),
      // The CLIENT, so `am` can answer "is there a window here at all?"
      // without guessing. `am shot` used to tell the operator of a browser app
      // to restart with `--cdp` and try again — a path that ends nowhere,
      // because a browser app has no window to shoot. Same rule as the
      // electron-only refusal below.
      client: clientOf(cli, config).value,
      // Where the DATA is, which is not the same question as `home` — see
      // LockData.dataDir. `am instances` prints it so "why is my data not
      // where I think it is" stops being answered by reading source.
      dataDir: appDirs(appId, config.appDir).data,
    },
  );
  bootUndo.push("lock", () => appLock?.release());

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

  // Electron-only flags on a non-Electron client are refused HERE, before the
  // thin-client path can act on one: `--connect` with `--client=browser` used
  // to override the client and start a ~100 MB Electron download, while
  // `--keep-server` was refused only after the banner. The client is resolved
  // by the same rule as below (flag > config > deno.json > electron); one
  // pure decider (aio-cli.ts) names what was typed and the client it needs.
  const _electronOnly = electronOnlyFlagRefusal(
    cli,
    clientOf(cli, config).value,
    config,
  );
  if (_electronOnly) {
    appLock?.release();
    throw _electronOnly;
  }

  // Thin client mode
  if (
    await handleThinClient(serverUrlOf(cli, config)?.value, (_v) => {
      /* multi-instance (D2): no process-wide running flag */
    })
  ) return null!;

  // Zero-config baseDir: the main module's directory — always right for
  // `deno run src/app.ts` regardless of cwd, and in a compiled binary the VFS
  // directory that `compile.include` embedded the app's assets into. A binary
  // ALSO keeps `<cwd>/src` behind it (baseDirFallbacks), so one run beside a
  // real source tree still serves from it. An explicit `baseDir` is the app's
  // decision and gets no ladder under it.
  const baseDirs = _inferBaseDirs();
  const baseDir = resolve(config.baseDir ?? baseDirs[0]);
  const baseDirFallbacks = config.baseDir ? [] : baseDirs.slice(1);
  const VERBOSE = cli.verbose;

  // Prod detection
  let distDir = resolve(join(Deno.cwd(), "dist"));
  let prod = cli.prod === true;
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

  // `budgets` — the limits this app declares, parsed BEFORE anything reads
  // them, so an unreadable value fails the boot rather than silently falling
  // back to aio's own number (report 2 §9.3). A budget that did not parse is a
  // limit nobody declared and nobody can see.
  // THIS app's ledger, handed to its own health route and broadcaster — a
  // second app in the process takes another (see `BudgetLedger`).
  const _budgetLedger = setBudgets(resolveBudgets(config.budgets));

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
  bootUndo.push("vitals", () => vitalsSystem?.destroy());
  bootUndo.push("diagnostics", async () => {
    await diagHooks?.onStop();
    diagHooks?.uninstallCrashHandler?.();
  });

  // Client mode: CLI flag > aio.run config > app deno.json `target` >
  // electron. The deno.json step is what makes `am create --target=X` +
  // `deno task dev` (no --client flag) actually run target X.
  const { value: client, from: clientFrom } = clientOf(cli, config);
  // …and WHO decided, kept beside the decision so the two cannot drift. The
  // boot report says `client electron (deno.json)` instead of leaving someone
  // to grep three files for the one that won.
  const useElectron = client === "electron";
  const isHeadless = client === "server-only" || client === "cli";

  // ── `--prod` from SOURCE with no bundle to serve ──
  //
  // This is the NORMAL state after a fleet build: `deno task build` moves the
  // bundle into the binary and deletes `dist/app.js`. Running the source with
  // `--prod` afterwards booted with "running (prod, browser)" and printed
  // "open http://localhost:PORT" — and every page there answered 503 with a
  // body saying the server was built `--headless`, which it was not. The
  // compiled-binary case has been guarded for a while (the `sawDistDir` warn
  // above); the source case had only a `deps.debug` line, invisible at the
  // default log level. A client with a PAGE and nothing to put on it must say
  // so where the URL is printed, not in the browser.
  if (prod && !isCompiled() && !isHeadless) {
    let hasBundle = false;
    try {
      await Deno.stat(join(distDir, BUNDLE_JS));
      hasBundle = true;
    } catch { /* the case this exists for */ }
    if (!hasBundle) {
      log.warn(
        `--prod, but there is no ${
          join(distDir, BUNDLE_JS)
        } to serve: every page will answer 503. \`deno task build\` moves the ` +
          `bundle INTO the binary and removes dist/app.js, so this is the ` +
          `normal state after a build — run the binary in dist/ instead, or ` +
          `\`deno task dev\` for the dev server. (A headless run is fine: ` +
          `--client=server-only / --client=cli serve no page.)`,
      );
    }
  }
  // THE CLIENT BUNDLE'S SOURCE MAP, if the build left one. Without it every
  // error a browser forwards lands in the log as `app.js:1:22073` — the
  // bundle is one minified line, and no browser applies a map to the string
  // form of `Error.stack`, so the server is the only place this can happen.
  // See diagnostics/stack-remap.ts.
  //
  // A dotfile by design (`serveStatic` refuses dot-prefixed segments), so it
  // ships beside the bundle without being readable over HTTP. Absent is the
  // normal case for a dev server, which serves unbundled modules whose
  // positions are already the author's own.
  if (prod) {
    const mapped = await installBundleSourceMap(distDir);
    log.debug(
      mapped
        ? `sourcemap: ${
          join(distDir, BUNDLE_MAP)
        } loaded — forwarded client errors name your source`
        : `sourcemap: no usable ${
          join(distDir, BUNDLE_MAP)
        }; forwarded client errors keep bundle positions`,
    );
  }

  const {
    reduce,
    execute,
    onAction,
    onEffect,
    onStart,
    onStopping,
    onStop,
    onError,
  } = config;
  const shouldPersist = persistOf(cli, config).value !== false;
  // ONE decider for the database file. Three sites used to decide it: storage
  // opened `config ?? cli`, while the shutdown "database is GONE" check and the
  // boot report read `config.dbPath` alone — so a run with only
  // `--db-path=/tmp/x.db` reported the default file as the database and ended
  // with a false "GONE" alarm about a file it never used.
  //
  // The CONFIG wins when both are set, as storage always had it. Every other
  // flag beats its config twin, and so should this one — but flipping it
  // would open a DIFFERENT database under a deployment that passes both, and
  // an app that boots onto an empty store looks exactly like data loss. So:
  // unchanged, and said out loud. (A v2 candidate: the flag should win.)
  const dbPath = dbPathOf(cli, config)?.value;
  if (
    config.dbPath !== undefined && cli.dbPath !== undefined &&
    config.dbPath !== cli.dbPath
  ) {
    log.warn(
      `--db-path=${cli.dbPath} is ignored: aio.run({ dbPath: ` +
        `${JSON.stringify(config.dbPath)} }) is set, and the config wins for ` +
        `this key. Remove one of the two.`,
    );
  }
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
  if (config.schedules !== undefined) validateSchedules(config.schedules);
  // Post-bridge: hooks the app omitted have been materialised as `undefined`
  // by the mechanical spread, so presence no longer implies authorship.
  validateCallableConfig(config as unknown as Record<string, unknown>, false);
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
  // not a second copy: a compiled binary's stylesheet lives in the embedded
  // dist/ while its app dir is the VFS entry dir with `<cwd>/src` behind it,
  // so asking only one of the three made this line confidently wrong there.
  const themeNote = _themeBootNote(
    ui.theme,
    [baseDir, ...baseDirFallbacks].some((d) => appHasStylesheet(d, distDir)),
    ui.layout,
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
    dbPath,
    dbPragmas: config.dbPragmas,
    checkIntegrityOnBoot: config.checkIntegrityOnBoot,
    initialState,
    shouldPersist,
    persistKey,
    persistMode,
    persistDebounceMs: config.persistDebounceMs ?? 100,
    dbSchema: config.db,
    syncCellIds,
    syncRetentionMs: config._syncRetentionMs,
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
    cellPersist: config._cellPersist,
    cellPersistShaped: config._cellPersistShaped,
    log,
  });
  state = boot.state as S;
  const { kvDb, asyncDb, persistence, journal, syncHandler, syncBroadcastRef } =
    boot;
  bootUndo.push("sqlite", () => asyncDb?.close());
  bootUndo.push("kv", () => kvDb?.close());
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

  /** The replayed state, with every field the store does not hold put back
   *  to what boot restored it as.
   *
   *  Replay re-runs the actions after the last snapshot, and those actions
   *  write fields the app keeps OUT of the store (`persist: { exclude }`,
   *  `persist: "none"`) as readily as any other. So a field that comes back at
   *  its default after a clean restart came back holding its pre-crash value
   *  after a SIGKILL — `setCache(4242)` replayed — and the app's own
   *  declaration of what survives a restart depended on HOW it stopped. The
   *  restored value is the one a clean restart gives: the declared default, or
   *  whatever the app's `onRestore` derived it as.
   *
   *  Read from the persist FILTER, dot paths included — the same value the
   *  store's getter applies. It used to read the top-level `_cellFields`
   *  flags, and a nested exclude leaves its top-level key "persisted", so
   *  `exclude: ["meta.cache"]` came back `0` after a clean stop and `4242`
   *  after a SIGKILL. */
  function _keepUnpersistedFields(restored: S, replayed: S): S {
    const filters = config._cellPersist;
    if (!filters || replayed === restored) return replayed;
    const from = restored as Record<string, unknown>;
    let out: Record<string, unknown> | null = null;
    for (const [cell, filter] of Object.entries(filters)) {
      if (filter === "all") continue;
      const was = from[cell];
      const now = (replayed as Record<string, unknown>)[cell];
      if (!_isRecord(was) || !_isRecord(now) || now === was) continue;
      const slice = _unpersistedFromBoot(filter, was, now);
      if (slice !== now) {
        out ??= { ...(replayed as Record<string, unknown>) };
        out[cell] = slice;
      }
    }
    return (out ?? replayed) as S;
  }

  /** The replayed state, with every `onPersist`-shaped cell the replay
   *  touched sent through the round trip a clean restart gives it: the slice
   *  is shaped exactly as the store writes it (filter, then `onPersist`, then
   *  JSON), merged over the declared state, and repaired by the cell's
   *  `onRestore`.
   *
   *  A shape names no fields, so `_keepUnpersistedFields` cannot read one:
   *  `onPersist: (s) => ({ data: s.data })` kept `cache` off disk, and a
   *  `setBoth(7)` came back `cache: 0` after a clean stop and `cache: 7` after
   *  a SIGKILL — the journal replayed the write the shape exists to drop.
   *  Only the round trip itself is exact for a shape that RESHAPES, too.
   *
   *  A shape that throws here is the same failure the persist path reports on
   *  its next write; the replayed slice is kept and the throw is said now. */
  function _roundTripShapedCells(restored: S, replayed: S): S {
    const shaped = config._cellPersistShaped;
    if (!shaped?.length || replayed === restored) return replayed;
    const from = restored as Record<string, unknown>;
    const declared = initialState as Record<string, unknown>;
    const restores = config._cellRestores;
    let out: Record<string, unknown> | null = null;
    for (const cell of shaped) {
      const now = (replayed as Record<string, unknown>)[cell];
      if (now === from[cell] || !_isRecord(now) || !_isRecord(declared[cell])) {
        continue;
      }
      let slice: Record<string, unknown>;
      let disk: Record<string, unknown>;
      try {
        const stored = (getDBState({ [cell]: now } as S) as
          | Record<string, unknown>
          | undefined)?.[cell];
        disk = stored === undefined
          ? {}
          : JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;
        slice = deepMerge(
          structuredClone(declared[cell]) as Record<string, unknown>,
          disk,
        );
      } catch (e) {
        log.error(
          `journal: could not shape the replayed "${cell}" slice the way ` +
            `the store writes it — it keeps what replay produced, including ` +
            `whatever its onPersist keeps off disk: ${
              e instanceof Error ? e.message : String(e)
            }`,
        );
        continue;
      }
      const hook = restores?.get(cell);
      if (hook) {
        slice = runCellRestore(cell, hook, slice, {
          stored: disk,
          declared: declared[cell],
          retyped: true,
        }, log);
      }
      out ??= { ...(replayed as Record<string, unknown>) };
      out[cell] = slice;
    }
    return (out ?? replayed) as S;
  }

  /** Say it when the tail holds lines with NO version stamp for a cell this
   *  boot migrated (an `onMigrate` ran, or a downgrade).
   *
   *  The stamp (`JournalEntry.v`) is how replay refuses a line written under
   *  another cell version; a journal from a build before the stamp cannot be
   *  judged. Such a line ran either under the snapshot's version — then
   *  re-running it through the new method on migrated state is a guess (a v1
   *  "+5 units" replayed as "+5 cents") — or under the new one, by a build
   *  that migrated in memory and crashed before its first snapshot, where
   *  replaying it is right. Neither is provable from the file, so replay keeps
   *  doing what it always did with them; it used to do it silently. */
  function _warnUnstampedAcrossMigration(tail: JournalEntry[]): void {
    const moved = new Map<string, { from: number; to: number }>();
    for (const r of migrationSummary?.report ?? []) {
      if (r.outcome === "migrated" || r.outcome === "downgrade") {
        moved.set(r.cell, { from: r.from, to: r.to });
      }
    }
    if (moved.size === 0) return;
    const hits = new Map<string, number[]>();
    for (const e of tail) {
      if (e.v !== undefined) continue;
      const cells = e.type === TT_RESTORE_TYPE
        ? Object.keys(
          (e.payload as Partial<TimeTravelRestore> | undefined)?.cells ?? {},
        )
        : [
          workerPatchCell(e.type, e.payload) ??
            (e.origin ?? e.type).slice(
              0,
              Math.max(0, (e.origin ?? e.type).indexOf(":")),
            ),
        ];
      for (const c of cells) {
        if (!moved.has(c)) continue;
        const seqs = hits.get(c) ?? [];
        seqs.push(e.seq);
        hits.set(c, seqs);
      }
    }
    for (const [cell, seqs] of hits) {
      const m = moved.get(cell)!;
      reportAioError(
        createAioError(
          "PERSIST_ERROR",
          new Error(
            `journal: ${count(seqs.length, "line")} for "${cell}" (seq ${
              seqs.length > 8
                ? `${seqs.slice(0, 8).join(", ")}, …${seqs.at(-1)}`
                : seqs.join(", ")
            }) carry no version stamp — ` +
              `written by an aio build from before stamps existed — and this ` +
              `boot migrated "${cell}" v${m.from} → v${m.to}. They are ` +
              `REPLAYED through this build's methods on the migrated state, ` +
              `as before; if they ran under v${m.from}, the recovered ` +
              `"${cell}" may be wrong (a v${m.from} argument read with ` +
              `v${m.to} meaning). Check it, and compare against ` +
              `\`am timeline --from=${journal?.path ?? "<journal>"}\`.`,
          ),
          { cellName: cell },
        ),
        _reportOpts,
      );
    }
  }

  /** The restore hooks a clean restart runs, run again on what journal
   *  replay produced — so a crash and a clean stop come back the same.
   *
   *  Boot ran them on the SNAPSHOT, and the tail then replayed on top: after a
   *  clean stop the hooks see every action (the final snapshot holds them);
   *  after a SIGKILL the tail's actions landed AFTER them, so what a hook
   *  repairs ("nobody is online after a restart") was undone by the replayed
   *  action that set it — measured `online: false` after a clean stop and
   *  `online: true` after a crash. Only when replay changed state, in the
   *  clean restart's order: each plain cell's `onRestore` whose slice the
   *  replay touched (a shaped cell's already ran in its round trip), then the
   *  app-level one. Error-guarded like boot's own run: a throw is logged and
   *  the state kept as the replay left it. */
  function _rerunRestoreHooks(restored: S, replayed: S): S {
    if (replayed === restored) return replayed;
    let next = replayed;
    const restores = config._cellRestores;
    if (restores?.size) {
      const shaped = new Set(config._cellPersistShaped ?? []);
      const was = restored as Record<string, unknown>;
      next = produce(next, (d) => {
        const s = d as Record<string, unknown>;
        for (const [id, hook] of restores) {
          if (shaped.has(id) || !_isRecord(s[id])) continue;
          if ((replayed as Record<string, unknown>)[id] === was[id]) continue;
          s[id] = runCellRestore(
            id,
            hook,
            s[id] as Record<string, unknown>,
            undefined,
            log,
          );
        }
      });
    }
    const appHook = config.onRestore;
    if (appHook) {
      try {
        next = produce(next as unknown, (d: unknown) => {
          const r = appHook(d as S) as unknown;
          // Mutated in place (or handed the draft back) ⇒ the draft's edits.
          return r === undefined || r === d ? undefined : r;
        }) as S;
      } catch (e) {
        log.error(`hook onRestore (after journal replay): ${e}`);
      }
    }
    return next;
  }

  function _isRecord(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  /** One cell's replayed slice with what `filter` keeps out of the store put
   *  back to its boot value (or removed, where boot had none). Identity is
   *  kept when nothing differs. */
  function _unpersistedFromBoot(
    filter: import("../state/cell-types.ts").CellFieldFilter,
    was: Record<string, unknown>,
    now: Record<string, unknown>,
  ): Record<string, unknown> {
    if (filter === "all") return now;
    if (filter === "none") return was;
    let slice = now;
    const revert = (key: string) => {
      if (slice[key] === was[key] && (key in slice) === (key in was)) return;
      if (slice === now) slice = { ...now };
      if (key in was) slice[key] = was[key];
      else delete slice[key];
    };
    if ("include" in filter) {
      // Top level only — `persist.include` refuses dot paths at definition.
      const kept = new Set(filter.include);
      for (const key of new Set([...Object.keys(now), ...Object.keys(was)])) {
        if (!kept.has(key)) revert(key);
      }
      return slice;
    }
    // A filter object that names NEITHER key keeps everything — the answer
    // `fieldIncluded`, the store's own projection and the startup report all
    // give it (it is a type error, so it arrives from JS, from a runtime-built
    // `cellDefaults`, or from `onPersist` written inside `persist:`; boot says
    // so out loud). This was the one decider that instead read `undefined` as
    // iterable: the first boot after a CRASH threw before the server started,
    // and so did every boot after it.
    if (!("exclude" in filter)) return now;
    for (const path of filter.exclude) {
      // BOTH READINGS, as the store's own projection takes them: the key
      // literally named `path` (a no-op when the cell has none), and the
      // dotted path under its head. A replay that put back a literal `"a.b"`
      // the store never wrote is the same divergence this function exists to
      // close, one spelling over.
      revert(path);
      if (path.includes(".")) {
        slice = restoreExcluded(slice, was, path.split(".")) as Record<
          string,
          unknown
        >;
      }
    }
    return slice;
  }

  /** Refuse a journal replay across a hole (see `JournalGap`), keep the
   *  journal, and say where both halves of the evidence went. Boot goes on:
   *  the database is consistent on its own, and the integrity check already
   *  said it is older. Replaying nothing is the one answer that invents
   *  nothing. */
  async function _refuseJournalAcrossGap(
    j: NonNullable<typeof journal>,
    gap: JournalGap,
  ): Promise<void> {
    const { integrityRecoveries } = await import("./db-integrity.ts");
    // The recovery this journal belongs with: its own database (`<db>.journal`)
    // or the one in its directory (`<data>/state.db` beside `<data>/journal`).
    const recoveries = [...integrityRecoveries()];
    const recovery = (recoveries.find(([db]) => j.path === `${db}.journal`) ??
      recoveries.find(([db]) => dirname(db) === dirname(j.path)))?.[1];
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const to = recovery?.quarantinedTo
      ? `${recovery.quarantinedTo}.journal`
      : `${j.path}.gap-${stamp}`;
    const why = recovery?.restoredFrom
      ? `checkIntegrityOnBoot restored ${recovery.restoredFrom}; the damaged ` +
        `database is kept at ${recovery.quarantinedTo}`
      : recovery?.quarantinedTo
      ? `checkIntegrityOnBoot started it EMPTY; the damaged database is kept ` +
        `at ${recovery.quarantinedTo}`
      : `it was restored from a snapshot or a backup, or replaced`;
    const stream = gap.stream === "actions"
      ? "the app's actions"
      : `sync cell "${gap.stream}"`;
    let kept: string;
    try {
      j.quarantine(to);
      kept = `The journal is kept at ${to} (with ${to}.base)`;
    } catch (e) {
      kept = `The journal could NOT be moved aside (${e}) and is still at ` +
        `${j.path} — copy it away before the first snapshot compacts it`;
    }
    const msg =
      `journal: REFUSED to replay ${j.path} — the database holds ${stream} ` +
      `only up to seq ${gap.storeAt}, but the journal had already dropped ` +
      `everything up to seq ${gap.droppedThrough}: the database went back in ` +
      `time (${why}). Replaying the tail across that hole would re-run ` +
      `actions on a state they never ran on and record history that never ` +
      `happened, so nothing was replayed and the app boots on the database ` +
      `as it is. ${kept}.`;
    reportAioError(
      createAioError("PERSIST_ERROR", new Error(msg), {
        ...(gap.stream !== "actions" ? { cellName: gap.stream } : {}),
      }),
      _reportOpts,
    );
  }

  // Journal recovery: replay the actions committed AFTER the last
  // snapshot (the debounce window a SIGKILL/power-cut would otherwise lose) on
  // top of the restored state — after sync-ops so cross-cell reads see recovered
  // sync state. State transitions only; effects are never re-run.
  //
  // Sync cells journal their server-origin writes too (see `_syncJournal` in
  // the afterAction hook) — each by its OWN watermark, recorded inside the
  // fold that makes the write durable, so a write the fold already holds is
  // not applied a second time.
  const _syncJournal = journal !== null && syncCellIds.length > 0 &&
    !!syncHandler?.setFoldWatermark && !!kvDb?.planSet;
  if (journal) {
    if (_syncJournal) {
      const stored: Record<string, number> = {};
      for (const c of syncCellIds) {
        const key = syncJournalWatermarkKey(appId, c);
        const at = await kvDb!.get<number>(key);
        if (typeof at === "number") {
          stored[c] = at;
          continue;
        }
        // First boot with this cell journalled by its own watermark. Every line
        // the journal already holds for it was written while the app-wide
        // watermark governed it — the cell was not `sync: true`, or not
        // journalled — so the KV snapshot holds exactly those up to that mark.
        // Recorded BEFORE any write can be journalled under the new rule.
        stored[c] = journal.watermark();
        await kvDb!.set(key, stored[c]);
      }
      journal.trackCells(stored);
      syncHandler!.setFoldWatermark!({
        capture: () => journal.currentSeq(),
        plan: (c, at) => kvDb!.planSet!(syncJournalWatermarkKey(appId, c), at),
        folded: (c, at) => journal.setCellWatermark(c, at),
      });
    }
    // A database that went BACK in time — `checkIntegrityOnBoot` restored its
    // snapshot, or a file was copied over it — is older than the journal's
    // tail, with a hole between the two. Replaying across the hole re-ran
    // actions on a state they never ran on: `withdrawAll()` after three
    // deposits, replayed onto the restored balance of 50, recorded a
    // withdrawal of 50 that never happened. Refused, loudly, and the journal
    // is kept — beside the damaged database when there is one.
    let gap = journal.gap();
    // Nothing past the store's watermarks: the hole has nothing after it to
    // invent history with (a clean stop compacts the journal empty before a
    // backup is put back). The base moves back to the store instead — left
    // ahead of it, the next crash would refuse a tail this boot writes.
    if (gap && journal.readTail().length === 0) {
      try {
        journal.rebase();
      } catch (e) {
        log.warn(
          `journal: could not record ${journal.path}.base (${e}) — the ` +
            `database is older than the journal's last compaction, and until ` +
            `this succeeds a crash makes the next boot refuse to replay`,
        );
      }
      gap = null;
    }
    if (gap) await _refuseJournalAcrossGap(journal, gap);
    const tail = gap ? [] : journal.readTail();
    if (tail.length > 0) _warnUnstampedAcrossMigration(tail);
    if (tail.length > 0) {
      const before = state;
      const replay = replayJournal(
        state,
        tail,
        config.reduce as (s: S, a: A) => { state: S },
        (key) => journal.watermarkFor(key),
        (cell) => config._cellVersions?.[cell] ?? 0,
        (cell) => !!config._cellMigrations?.get(cell)?.onMigrate,
      );
      state = _rerunRestoreHooks(
        state,
        _roundTripShapedCells(
          state,
          _keepUnpersistedFields(state, replay.state),
        ),
      );
      // A sync cell's replayed writes are live again but in no snapshot, and
      // no fold is pending for them: fold now, or a client catching up is
      // served a history without them and a second crash depends on the
      // journal alone.
      if (_syncJournal) {
        for (const c of syncCellIds) {
          if (
            (before as Record<string, unknown>)[c] !==
              (state as Record<string, unknown>)[c]
          ) syncHandler!.noteServerWrite(c);
        }
      }
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
        // A version bump between the crash and this boot: those entries ran
        // through methods this build no longer has, on a snapshot this boot
        // just migrated — re-running them through the new methods is a
        // guess (a v1 "+5 units" replayed as "+5 cents").
        const stale = replay.skipped.filter((s) => s.reason === "version");
        const rest = replay.skipped.filter((s) => s.reason !== "version");
        const threw = rest.filter((s) => s.reason === "threw");
        const whyRest = rest.length === 0
          ? ""
          : threw.length === 0
          ? `their payload was dropped by redactActions, so the arguments ` +
            `needed to re-run them are gone`
          : threw.length === rest.length
          ? `the reducer REJECTED them: ${
            [...new Set(threw.map((s) => s.error ?? "threw"))].join("; ")
          }`
          : `some had their payload dropped by redactActions and ${threw.length} ` +
            `were rejected by the reducer: ${
              [...new Set(threw.map((s) => s.error ?? "threw"))].join("; ")
            }`;
        const whyStale = stale.length === 0
          ? ""
          : `${
            stale.length === replay.skipped.length ? "they" : stale.length
          } ` +
            `ran under a cell version this build has migrated away from (${
              [...new Set(stale.map((s) => s.error ?? "version"))].join("; ")
            }), so the methods that wrote them are not this build's and ` +
            `re-running them on the migrated state would guess`;
        const why = [whyRest, whyStale].filter(Boolean).join("; and ");
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
  bootUndo.push("schedules", () => scheduleManager.cancelAll());
  const ownManager = createOwnManager(log);
  bootUndo.push("own processes", () => ownManager.disposeAll());
  if (config._onScheduleReady) {
    config._onScheduleReady((prefix) => {
      scheduleManager.cancelByPrefix(prefix);
      ownManager.disposeByPrefix(prefix);
    });
  }

  // Cost meter (`am cost`): always on, bounded rings, zero configuration. The
  // question it answers — "what does aio move on my behalf, and where does it
  // come from" — is asked AFTER something feels slow, which is exactly when an
  // opt-in diagnostic is not enabled. See src/vitals/cost-meter.ts.
  //
  // Created BEFORE the UDS controller, which now attributes its own rounds:
  // a local desktop app opens no TCP ports, so every one of its clients is on
  // the socket and `am cost` reported an idle app (a field report).
  const costMeter = createCostMeter();
  costMeter.setKnownCells(config._cellNames ?? []);

  const udsCtrl = createUdsBroadcastController({
    getUdsHandle: () => udsHandle,
    syncIntervalMs: udsSyncIntervalMs,
    costMeter: () => costMeter,
    onBroadcastRound: () => vitalsSystem?.pressureMonitor?.onBroadcastRound(),
    // The same projection the WS path attributes from — `state` is the live
    // binding this closure reads at send time, not a value captured now.
    getUIState: () => getUIState(state) as Record<string, unknown> | undefined,
  });
  bootUndo.push("uds dispose", () => udsCtrl.dispose());
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
      const before = state;
      state = restored;
      // A worker cell's copy would otherwise keep mutating the state we just
      // discarded — re-seed it from the restored slice.
      _reseedWorkerCells();
      if (restored !== before) _recordTimeTravel(cmd, arg, before, restored);
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

  /** Make a time-travel jump as durable as the actions around it.
   *
   *  A jump assigns `state` directly — no action — so it reached no sink at
   *  all: the journal tail after it held actions taken on the jumped-to state,
   *  and a crash replayed them onto the PRE-jump snapshot (22 + inc(100) = 122
   *  for an app that was at 117). It is journalled here as the state it put in
   *  place, in the same synchronous turn as the assignment, so no action can
   *  land between the two. No persist is scheduled: time travel deliberately
   *  does not write a historical state to the snapshot on its own (the first
   *  action after `resume` does, and that snapshot compacts the line away).
   *  Crash and clean stop now agree — both come back at the jumped-to state
   *  when the process ends paused there. The timeline records it too:
   *  its diffs are the only description of how state got where it is, and a
   *  change missing from them cannot be folded back into the real state. */
  function _recordTimeTravel(
    cmd: string,
    arg: number | undefined,
    before: S,
    after: S,
  ): void {
    const ts = Date.now();
    const ttPayload = { cmd, ...(arg !== undefined ? { arg } : {}) };
    let seq: number;
    if (journal) {
      const cells: TimeTravelRestore["cells"] = {};
      for (
        const [cell, slice] of Object.entries(after as Record<string, unknown>)
      ) {
        // A sync cell recovers from its own op-log, never from the journal.
        if (_syncCellSet.has(cell)) continue;
        if (slice === null || typeof slice !== "object") continue;
        // WHAT THE STORE WOULD WRITE for this slice — the store's own getter,
        // not a second reading of the declaration. `persist` is TWO screens:
        // the include/exclude filter (dot paths included) and then
        // `onPersist`, which reshapes what goes to disk. Screening through
        // the flags map wrote `meta` whole for `exclude: ["meta.cache"]`;
        // screening through the filter alone still wrote the session token an
        // `onPersist` strips — the field the store has never once held, put
        // on disk by pressing undo. The replay side already asks this getter
        // (`_roundTripShapedCells`); this is the write side asking it too.
        //
        // `persist: "none"` ⇒ nothing of this cell is stored, so the line
        // names it not at all; replay leaves such a cell where it is either
        // way.
        let kept: unknown;
        try {
          kept = (getDBState({ [cell]: slice } as S) as
            | Record<string, unknown>
            | undefined)?.[cell];
        } catch (e) {
          // A shape that throws is the same failure the persist path reports
          // on its next write. Nothing is written for the cell — a journal
          // line must never carry what the store refused to.
          log.error(
            `journal: could not shape the "${cell}" slice the way the store ` +
              `writes it, so the time-travel line carries none of it — a ` +
              `replay of this jump leaves the cell where it is: ${
                e instanceof Error ? e.message : String(e)
              }`,
          );
          continue;
        }
        if (kept !== undefined) {
          cells[cell] = kept as Record<string, unknown>;
        }
      }
      const restore: TimeTravelRestore = { ...ttPayload, cells };
      seq = _journalAppend({ type: TT_RESTORE_TYPE, payload: restore }, ts);
    } else seq = timeline.lastSeq() + 1;
    timeline.record(seq, TT_RESTORE_TYPE, ttPayload, before, after, ts);
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
  // Which journalled actions an earlier action CAUSED — see `ActionCause`.
  //
  // `am replay` re-dispatches a journal range against a live app, and the
  // app's own machinery re-creates everything a replayed action causes: its
  // async body's write-sets, the timer it arms, what its `$do` dispatches. A
  // journal that could not tell those apart made replay send them twice —
  // `later(4)` (which schedules `inc(4)`) replayed as +9 with `4, 4` in the
  // history, and an async method's write-set row halted the run outright.
  //
  // Recorded by provenance, not guessed from `_source`: a schedule's tick and
  // a server-code call both arrive with no `_source`, and a bound async call
  // from server code carries "Effect" while being an input. The scope is
  // entered around effect execution and inherits into every callback started
  // inside it (AsyncLocalStorage), and the door marks an action by identity —
  // the action object reaches `afterAction` unchanged.
  const _effectScope = new AsyncLocalStorage<true>();
  const _effectBorn = new WeakSet<object>();
  const _causeOf = (action: A): ActionCause =>
    action !== null && typeof action === "object" &&
      _effectBorn.has(action as object)
      ? "effect"
      : "input";
  // WHICH async call's run an action belongs to — its `_callId`.
  //
  // `am record` replayed every call one `await` after the other. Two calls
  // that overlapped live (both read `n` before either wrote it) lost an update
  // the replay could never lose, so the generated test reached a state the app
  // never had. The generator can only start them together if it knows a later
  // call began before an earlier one's run was over, and nothing recorded
  // which run a write-set came from — two `__setRaceRead` rows look the same.
  //
  // Same mechanism as the effect scope: entered around `cell:__exec` (the
  // async body starts inside it, so its write-sets, direct dispatches and
  // nested calls inherit it), and read at the door. Left OUTSIDE it: a timer or
  // resource the run arms (it fires on its own clock, not as part of the call),
  // and every other effect — the drain loop runs effects in whichever context
  // started it, which may be a different call's.
  //
  // Left with `run(undefined, …)`, never `exit(…)`: measured on Deno 2.9,
  // `exit` clears the store for the synchronous part only — a timer or promise
  // started inside it still sees the call, so every tick a method armed was
  // attributed to the call that armed it.
  const _callScope = new AsyncLocalStorage<string | undefined>();
  const _outsideCall = <T>(fn: () => T): T => _callScope.run(undefined, fn);
  const _callBorn = new WeakMap<object, string>();
  // A call made from inside another call's run (`await peer.slow()`) is part of
  // the OUTER call: the outer one is not over until it is. Keyed by the inner
  // call's id from the door until its `__exec` runs; capped, because a call
  // refused before it executes never gets here to be removed.
  const _nestedCall = new Map<string, string>();
  const _callOf = (action: A): string | undefined =>
    action !== null && typeof action === "object"
      ? _callBorn.get(action as object)
      : undefined;
  const _inCallScope = <T>(effect: unknown, fn: () => T): T => {
    const ef = effect as
      | { type?: unknown; payload?: { _callId?: unknown } }
      | null
      | undefined;
    const id = typeof ef?.type === "string" && ef.type.endsWith(":__exec")
      ? ef.payload?._callId
      : undefined;
    if (typeof id !== "string") return _outsideCall(fn);
    const root = _nestedCall.get(id) ?? id;
    _nestedCall.delete(id);
    return _callScope.run(root, fn);
  };
  const afterActionHook = (prev: S, next: S, action: A): void => {
    _diagAfterAction?.(prev, next, action);
    // An async method's failure is its own frame, `cell:__error`, which is
    // not recorded (and usually changes nothing, so it would stop at the
    // no-op check below). Its CALL was recorded at call time — say on that
    // entry that it threw, before anything else can return.
    const errType = (action as { type?: unknown }).type;
    if (typeof errType === "string" && errType.endsWith(":__error")) {
      const callId = (action as { payload?: { _callId?: unknown } }).payload
        ?._callId;
      if (typeof callId === "string") timeline.markThrew(callId);
    }
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
        // …and the fold is up to 500 ms away, while the caller was acked NOW.
        // A SIGKILL inside that window lost every acked write in it — all 36
        // of them in a 300 ms burst — under the one option that exists to
        // prevent exactly that. So `journal: true` journals it like any other
        // write, by the cell's own watermark (see `_syncJournal`), and boot
        // replays it after the op-log restore. A refused append closes the
        // window by folding now (the fold noted just above is what it flushes).
        if (_syncJournal) {
          const payload = (action as { payload?: unknown }).payload;
          _journalAppend(
            {
              type: t,
              payload,
              origin: isWriteSetAction(t)
                ? actionOrigin(t, payload)
                : undefined,
              user: (action as { _user?: AioUser })._user,
              cause: _causeOf(action),
              call: _callOf(action),
            },
            Date.now(),
            () => syncHandler!.flushServerWrites(),
          );
        }
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
    //
    // A `worker: true` cell's commits are the other exception. Its method runs
    // in the worker and never reaches this hook; only the patches it commits
    // do, as `__aioWorkerPatch` — a type with no `cell:` prefix, so it read as
    // framework noise and a worker cell reached NO sink: a `journal: true` app
    // never created its journal file and lost acked writes to a SIGKILL, and
    // `am timeline` never showed the cell. The patch batch is that cell's
    // write-set; it is recorded under the type that really ran (replay applies
    // it exactly as the live reduce did) and attributed to the cell.
    const isWriteSet = isWriteSetAction(t);
    const payload = (action as { payload?: unknown }).payload;
    const workerCell = workerPatchCell(t, payload);
    if (method.startsWith("__") && !isWriteSet && workerCell === undefined) {
      return;
    }
    // Who wrote it — from the ONE decider (diagnostics/action-kind.ts), which
    // the action log and the logger resolve the same fact with. It was computed
    // here by hand and again in the diagnostics sink, and the redactor depends
    // on it: an exact `redactActions` pattern matches the CALL, so a sink whose
    // copy of this drifts leaks the same secret under the write-set's type.
    const origin = isWriteSet
      ? actionOrigin(t, payload)
      : workerCell !== undefined
      ? `${workerCell}:__worker`
      : undefined;
    const ts = Date.now();
    const cause = _causeOf(action);
    const call = _callOf(action);
    const seq = journal
      ? _journalAppend({
        type: t,
        payload,
        origin,
        user: (action as { _user?: AioUser })._user,
        cause,
        call,
      }, ts)
      : timeline.lastSeq() + 1;
    // `cell({ diagnostics: false })` covers `am timeline` too. A key by that
    // name that still listed the cell in the diagnostic surface people
    // actually read would be dishonest.
    //
    // AFTER the journal append, never instead of it: `journal: true` is a
    // durability promise, and dropping a cell's committed actions from the
    // replay log would be data loss dressed as a privacy feature.
    // By the origin when there is one: a worker batch's type names no cell.
    if (!isDiagnosticsOptOut(origin ?? t)) {
      timeline.record(seq, t, payload, prev, next, ts, origin, cause, call);
    }
  };
  // The journal append is NOT an observe-only hook — it is the durability
  // promise `journal: true` makes ("every committed action is appended before
  // the debounce window closes"). It rides in `afterAction`, which the
  // dispatcher guards as observe-only: a refused append (EACCES, ENOSPC, a
  // journal chmod'd read-only) was reported as HOOK_ERROR — "diagnostics for
  // this action are lost" — the call was acked ok, and the write lived
  // nowhere durable until the debounce timer fired. A SIGKILL in that window
  // lost an acked write under the one option that exists to prevent exactly
  // that.
  //
  // The state is already committed and broadcast when this runs, so
  // rejecting the caller would tell one client "no" about a write every other
  // client has already seen. The honest move is to keep the promise by the
  // other mechanism: report it as what it is (PERSIST_ERROR — the durability
  // path failed) and close the debounce window NOW, so the snapshot carries
  // the write. One flush per burst: a second refusal while one is pending
  // rides on it (the cycle reads state after this commit, or the batch-end
  // schedulePersist re-arms the flush loop).
  let _journalFlushPending = false;
  // The journal's own health, for `/__aio/health`. The compensating flush
  // keeps the STATE on disk, so `persist.ok` stays true and is right to — but
  // a `journal: true` app whose every append is refused is paying a full
  // flush per action and has lost the promise the option was set for, and
  // nothing in the health document said so: an uptime monitor stayed green
  // through it. `after: 1` because there is no retry here — each refusal IS
  // a missing line, and the first one already broke the promise. Recovers
  // (and says so) on the next append that lands.
  const _journalHealth = degraded(`journal:${resolveAppId(config.appId)}`, {
    after: 1,
  });
  function _journalAppend(
    entry: Parameters<NonNullable<typeof journal>["append"]>[0],
    ts: number,
    // What makes this write durable without its journal line: the persist
    // flush for a KV cell, the fold for a sync cell (whose state the KV
    // snapshot does not hold, so a persist flush would close nothing).
    compensate: () => Promise<void> = () => persistence.flushPersist(),
  ): number {
    try {
      const v = _journalVersions(entry.type, entry.payload, entry.origin);
      const seq = journal!.append(v ? { ...entry, v } : entry, ts);
      _journalHealth.ok();
      return seq;
    } catch (e) {
      _journalHealth.fail(e);
      reportAioError(
        createAioError("PERSIST_ERROR", e, { actionType: entry.type }),
        _reportOpts,
      );
      if (!_journalFlushPending) {
        _journalFlushPending = true;
        // `flushPersist()` never rejects by contract — a refused cycle is
        // reported inside it and read back through `lastCycleError()`, which
        // is what `am persist` and `/__aio/health` answer with. So a
        // rejection HERE is a broken contract, not a refused write, and the
        // one thing it must not be is silent.
        compensate().catch((err) => {
          log.error(
            `journal: the compensating flush itself threw — ${err}. The ` +
              `verdict is still lastCycleError(); ask \`am persist\`.`,
          );
        }).finally(() => {
          _journalFlushPending = false;
        });
      }
      // The counter already advanced; the timeline keeps the same seq so its
      // entries and the journal's lines stay aligned for replay.
      return journal!.currentSeq();
    }
  }

  /** The `version` of every declared cell a journal line writes — see
   *  `JournalEntry.v`. A method's cell is its type's prefix (a write-set's
   *  origin names the same cell, a worker batch's payload names it); a
   *  time-travel line writes every cell it carries. Undefined when the line
   *  names no declared cell. */
  const _declaredCells = new Set(config._cellNames ?? []);
  function _journalVersions(
    type: string,
    payload: unknown,
    origin: string | undefined,
  ): Record<string, number> | undefined {
    const cells = type === TT_RESTORE_TYPE
      ? Object.keys(
        (payload as Partial<TimeTravelRestore> | undefined)?.cells ?? {},
      )
      : [
        workerPatchCell(type, payload) ??
          (origin ?? type).slice(0, Math.max(0, (origin ?? type).indexOf(":"))),
      ];
    const out: Record<string, number> = {};
    let any = false;
    for (const c of cells) {
      if (!_declaredCells.has(c)) continue;
      out[c] = config._cellVersions?.[c] ?? 0;
      any = true;
    }
    return any ? out : undefined;
  }

  // One per app, shared by the dispatch loop and the worker pool's effect
  // router below — see `notifyCrossUserGate`.
  const _notifyCrossUser = notifyCrossUserGate((m) => log.warn("aio", m));
  // Observe-only: a committed write the next boot will undo (a deleted
  // declared key, a key added under a closed declared object) is said at the
  // write, dev and prod — see declared-shape-guard.ts.
  const _writeGuard = boot.writeGuard;
  const _dispatchCore = setupDispatch<S, A, E>({
    reduce: _writeGuard
      ? (s, a) => {
        const r = reduce(s, a);
        if (r.state !== s) {
          _writeGuard(
            String((a as { type?: unknown }).type ?? ""),
            (r as { patches?: unknown }).patches,
          );
        }
        return r;
      }
      : reduce,
    // Effects run inside the effect scope, so everything they dispatch — now,
    // or later from a timer, a promise or an async body they started — is
    // recorded as `cause: "effect"` (see `_effectScope`).
    execute: (app, e) =>
      _effectScope.run(true, () => _inCallScope(e, () => execute(app, e))),
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
      broadcastUi: (raw) => server.broadcastUi?.(raw) ?? 0,
    }),
    // A timer a method arms and a process it owns dispatch LATER, from their
    // own callbacks — which inherit the scope they were created in.
    scheduleManager: {
      handle: (e) =>
        _effectScope.run(
          true,
          () => _outsideCall(() => scheduleManager.handle(e)),
        ),
    },
    ownManager: {
      handle: (e) =>
        _effectScope.run(true, () => _outsideCall(() => ownManager.handle(e))),
    },
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
    notifyCrossUser: _notifyCrossUser,
    afterAction: afterActionHook,
    log,
    debug: VERBOSE,
  });
  // THE one door every dispatch passes — client, trojan, server code, a
  // schedule, an effect. Whether the effect scope is active is decided HERE,
  // at the call, because by the time the action is reduced the drain loop is
  // running in whichever context started it. Same function in every other
  // respect: the core's own members (`close`, `drain`, …) are carried over.
  const dispatch = Object.assign((action: A) => {
    if (
      _effectScope.getStore() === true && action !== null &&
      typeof action === "object"
    ) {
      _effectBorn.add(action as object);
    }
    const call = _callScope.getStore();
    if (call !== undefined && action !== null && typeof action === "object") {
      _callBorn.set(action as object, call);
      const inner = (action as { payload?: { _callId?: unknown } }).payload
        ?._callId;
      if (typeof inner === "string" && inner !== call) {
        if (_nestedCall.size >= 1024) {
          _nestedCall.delete(_nestedCall.keys().next().value!);
        }
        _nestedCall.set(inner, call);
      }
    }
    return _dispatchCore(action);
  }, _dispatchCore) as typeof _dispatchCore;
  bootUndo.push("close dispatch", () => dispatch.close());
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
  // `freezeState: false (prod default)` on its own read as "state is not
  // frozen in production" — false: Immer's autoFreeze is never off, so every
  // commit is frozen in every mode (tests/prod-committed-state-frozen.test.ts).
  // The option only gates the EXTRA full-tree freeze pass after each commit.
  log.info(
    `freezeState: ${freezeEnabled}${
      config.freezeState === undefined
        ? (prod ? " (prod default)" : " (dev default)")
        : ""
    } — committed state is frozen in every mode; this toggles only the ` +
      `extra full-tree freeze pass after each commit`,
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
  bootUndo.push("vitals check", () => {
    if (_vitalsCheckTimer) clearInterval(_vitalsCheckTimer);
  });

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
  bootUndo.push("sessions", () => sessionStore?.close());
  bootUndo.push("users", () => userStore?.close());

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
  // Worker-cell calls in flight with a signed-in user in scope — the worker
  // half of `notifyCrossUserGate`. A worker's notify reaches `runEffect` as
  // plain data with no caller attached, so "raised inside a user's call" is
  // read off the calls in flight: a worker posts a call's effects BEFORE its
  // `done` (cell-worker-host.ts), so a user call's notify always lands inside
  // that call's window here. The one imprecision is conservative — a
  // user-less notify landing while some user's worker call is also in flight
  // counts too — and it can only ever produce the once-per-app notice, never
  // suppress it.
  let _workerUserCalls = 0;
  const workerPool = createCellWorkerPool({
    // The SAME resolved value the main isolate uses and the boot line
    // prints — one decider, so a worker cell is never freeze-checked more
    // loosely than a local one.
    freezeState: freezeEnabled,
    // …and the SAME `refusalsReject` the composed reduce was given, for the
    // same reason: it decides what an in-process `await cell.method()` sees
    // when the reduce refuses the write, and a worker that never learned it
    // answered its callers differently from the cell sitting next to it.
    refusalsReject: config._refusalsReject === true,
    // EVERY worker cell, hosted or not: the pool refuses what a thread
    // boundary cannot honour (selectors, sync, listensTo, a machine) before it
    // decides whether to host. It used to be handed `[]` under libraryMode, so
    // `testServer` booted a `worker: true` + `selectors` cell that the real
    // app refused to start.
    cells: (config._workerCells ?? []) as unknown as Parameters<
      typeof createCellWorkerPool
    >[0]["cells"],
    host: _hostWorkers,
    entry: _workerEntry,
    prod,
    getSlice: (cell) =>
      ((state as Record<string, unknown>)[cell] ?? {}) as Record<
        string,
        unknown
      >,
    dispatch: (a) => dispatch(a as unknown as A),
    // The SAME identity `composeCells` was given (aio-composition.ts), so the
    // pool scopes the cancel registry exactly as the composed reduce does.
    appId,
    // An effect handed back by a worker executes HERE, where the runtime lives.
    // A schedule effect is NOT an action — dispatching it would do nothing at
    // all, and the schedule would silently never fire.
    // Inside the effect scope, like a main-isolate effect: what it dispatches
    // or schedules is `cause: "effect"` (see `_effectScope`).
    runEffect: (effect) =>
      _effectScope.run(true, () =>
        // ONE exhaustive classifier, the same one the dispatch loop and the
        // worker host use — a new framework effect kind is a compile error here
        // rather than something this router silently treats as an app action
        // (see route-effect.ts). This site hand-wrote the chain, and the kind it
        // had never been taught about was `notify`: a `notify()` from a worker
        // cell was posted home correctly and then dispatched here as an action
        // type no cell answers, so the notification simply never appeared.
        // `__own` had been exactly the same bug one kind earlier.
        routeEffect<unknown>(effect, {
          schedule: (e) => scheduleManager.handle(e),
          // Worker cells hold their resources in their own isolate
          // (cell-worker-host.ts), so nothing should arrive here — and if
          // anything ever does, the own manager says so out loud.
          own: (e) => ownManager.handle(e),
          // The clients live on this isolate; same semantics as a notify from a
          // main-isolate cell, because it is the same function.
          notify: (e) =>
            _notifyCrossUser(
              showNotifyEffect(
                e,
                server?.broadcastUi,
                (m) => log.warn("aio", m),
              ),
              _workerUserCalls > 0,
            ),
          app: (e) => void dispatch(e as unknown as A), // cross-cell action
        })),
  });
  bootUndo.push("workers", () => workerPool.close());
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
   *  worker cells pays nothing, and production never reaches this at all.
   *  The clone itself is `_cloneAcrossWorkerBoundary` (cell-impl.ts), shared
   *  with the in-process harnesses so every test boundary says the same. */
  const _workerBoundaryDispatch: typeof dispatch = ((a: A) => {
    const type = (a as unknown as { type?: unknown })?.type;
    if (typeof type !== "string") return dispatch(a);
    const i = type.indexOf(":");
    const cellId = i === -1 ? type : type.slice(0, i);
    if (!_inIsolateWorkerCells.has(cellId)) return dispatch(a);
    const sent = _cloneAcrossWorkerBoundary(a, "action payload", cellId) as A;
    // An ASYNC method answers through its registered call, not through this
    // dispatch's promise (that one resolves `undefined` once the method is
    // queued) — so its return value is cloned where the call settles.
    const callId = (sent as unknown as { payload?: { _callId?: unknown } })
      .payload?._callId;
    if (typeof callId === "string") {
      _mapCallResult(
        callId,
        (v) =>
          v === undefined
            ? v
            : _cloneAcrossWorkerBoundary(v, "return value", cellId),
      );
    }
    const out = dispatch(sent);
    // The refusal follows the action across the same boundary the value does.
    // `action-ack.ts` keys "did this action actually DO anything?" to the
    // action OBJECT, and the reducer refused the CLONE — so a method this cell
    // does not have (a rename, a stale client) was acked `ok: true` here while
    // the identical frame on a main-isolate cell was `ok:false,
    // ACTION_REFUSED`. Moved in the same turn, by the code that made the
    // stand-in, before the ack path asks.
    _moveRejections(sent, a);
    return Promise.resolve(out).then((v) => {
      _moveRejections(sent, a); // …and again for a refusal recorded on commit
      return v === undefined
        ? v
        : _cloneAcrossWorkerBoundary(v, "return value", cellId);
    });
  }) as typeof dispatch;

  const _routed = workerPool.route((a) => dispatch(a as unknown as A));
  type _RoutedMsg = Parameters<typeof _routed>[0];
  const appDispatch = workerPool.size > 0
    ? (((a: _RoutedMsg) => {
      // A worker call with a user in scope opens a window for its notify —
      // see `_workerUserCalls`. The same "user in scope" the worker's method
      // itself runs under (the ambient user it is handed), or the stamped one.
      const user = serverUser() ?? (a as { _user?: unknown })._user;
      if (!user || !workerPool.owns(a)) return _routed(a);
      // Counted AFTER the call is posted, so a synchronous throw cannot leave
      // the window open forever; the worker's effects arrive by message, later.
      const out = Promise.resolve(_routed(a));
      _workerUserCalls++;
      const done = () => void _workerUserCalls--;
      out.then(done, done);
      return out;
    }) as unknown as typeof dispatch)
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
      // The manager never rejects (the loop has to survive a bad window), so
      // the verdict is read back — and on the LAST flush there is no next
      // window to fix it in. A clean-looking exit that dropped every write
      // since the first refusal is exactly the shape this line exists to
      // break: the process is still going down (refusing to exit would strand
      // the operator), but it says what it is taking with it.
      const failed = persistence.lastCycleError();
      if (failed) {
        log.error(
          `shutdown: the FINAL persist was refused — ${failed.message}`,
        );
      } else if (shouldPersist) {
        // A clean verdict from the HANDLE is not a fact about the disk. Delete
        // the database out from under a running app (a cleared tmp dir, a
        // container volume that was not really persistent, `am remove --data
        // --force`) and POSIX keeps the inode alive for the open fd: SQLite
        // commits happily into a file no path can reach. Measured: every
        // window after the deletion reported success, `lastCycleError()` stayed
        // null, and the app exited `errors=0` having lost every write since.
        // Existence is the cheapest fact that catches it, and this is the one
        // moment it costs nothing — there is no next window to notice in.
        // `:memory:` is SQLite's SENTINEL for "there is no file", not a path.
        // Resolving it produced `<cwd>/:memory:`, which of course does not
        // exist, so every in-memory app ended a clean run with a FATAL-sounding
        // "the database file is GONE … NONE of them are on disk" — about a
        // database that was never meant to be on disk. A false alarm in the one
        // message that must be believed the day it is real is worse than no
        // message: it is how a reader learns to discount this exact line.
        const dbFile = dbPath ? resolve(dbPath) : _dirs.stateDb;
        const inMemory = dbPath === ":memory:" ||
          dbPath === "file::memory:" ||
          String(dbPath ?? "").startsWith(":memory:");
        const gone = inMemory ? false : await Deno.stat(dbFile).then(
          () => false,
          (e) => e instanceof Deno.errors.NotFound,
        );
        if (gone) {
          log.error(
            `shutdown: the database file is GONE (${dbFile}) — it was deleted ` +
              `while the app was running, so writes since then committed into ` +
              `an unlinked file and NONE of them are on disk.`,
          );
        }
      }
    },
    setShuttingDown: persistence.setShuttingDown,
    diagHooks,
    getVitalsCheckTimer: () => _vitalsCheckTimer,
    getVitalsSystem: () => vitalsSystem,
    onStopping,
    onStop,
    appLock,
    releaseFileSizeGuard,
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
    // Only a snapshot load replaces state through here. Journalled as the
    // state it put in place, in the same turn, exactly like a time-travel
    // jump: the load only SCHEDULES a persist, so an action acked on the
    // loaded state and a crash inside the debounce replayed that action onto
    // the PRE-load database (5, load 1000, deposit(1), SIGKILL → 6).
    // tests/journal-snapshot-load-crash.test.ts.
    setState: (s) => {
      const before = state;
      state = s;
      if (s !== before) _recordTimeTravel("snapshot", undefined, before, s);
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

  // From here the orchestrator above owns every step so far AND whatever
  // Phase 4 starts (it reads the server, the UDS handle, the watcher and the
  // Electron child through getters), so a refusal past this point is an
  // ordinary shutdown.
  bootUndo.replace(shutdown);

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
    portRequested: _portRequested,
    prod,
    distDir,
    electronDistDir,
    // The shell the app runs in: the dev graph evaluation presents its UA.
    shell: defaultClientFor(config.client) === "electron"
      ? "electron"
      : "browser",
    baseDir,
    baseDirFallbacks,
    expose,
    token,
    users,
    resolveUser: _resolveUser,
    sessionResolver,
    // Every source of "this socket's user is not who it was" the boot has.
    // Built from the STORES, not from `authFlows` — `authFlows` exists only
    // under `auth: true`, which left `sessions: true` on the 5-second sweep
    // (measured: 4.8s and ten more frames of private state after a revoke).
    // A role change had no source at all; `onUserChanged` is the new one.
    onIdentityChange: (sessionStore || userStore)
      ? (fn: () => void) => {
        const offs: (() => void)[] = [];
        if (sessionStore) offs.push(sessionStore.onRevoked(fn));
        if (userStore?.onUserChanged) offs.push(userStore.onUserChanged(fn));
        return () => {
          for (const off of offs) off();
        };
      }
      : undefined,
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
    cliCert: tlsOf(cli, _tls).cert?.value,
    cliKey: tlsOf(cli, _tls).key?.value,
    cliNoTls: tlsOf(cli, _tls).noTls?.value,
    // Which of the two said so — the warning names what was actually written.
    noTlsSource: cli.noTls !== undefined ? "flag" : "config",
    certSource: cli.cert !== undefined || cli.key !== undefined
      ? "flag" as const
      : "config" as const,
    cliTransport: cli.transport,
    // `--no-watch` / `--watch=…` beats the config value: a flag is a decision
    // about THIS run, a config value is the app's standing preference. Merged
    // HERE because `config` below is passed whole and must stay the app's own
    // object (tests/config-bridge-hop2.test.ts).
    cliWatch: cli.watch,
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
      loadSnapshot: (json, opts) => app.loadSnapshot!(json, opts),
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
    // `am persist` / trojan `persist`: the reply is the claim "on disk", so
    // this is the flush itself, awaited, and a cycle that reported a failure
    // rejects (the manager never rejects on its own — it keeps the loop alive
    // — so the verdict is read back from `lastCycleError`). Sync cells'
    // server-origin writes debounce into their own snapshot; they ride too,
    // exactly as on a clean exit.
    flushPersist: async () => {
      await persistence.flushPersist();
      await syncHandler?.flushServerWrites();
      const failed = persistence.lastCycleError();
      if (failed) throw failed;
    },
    // The SAME value, read by `/__aio/health` — one verdict, every door.
    lastPersistError: () => persistence.lastCycleError(),
    budgets: _budgetLedger,
    shouldPersist,
    scheduleManager,
    // Cell id → method names — trojan `cells` route (amui run-method buttons).
    cellMethods: config._cellMethods ?? {},
    cellAsyncMethods: config._cellAsyncMethods ?? {},
    cellMethodArity: config._cellMethodArity ?? {},
    cellFields: config._cellFields ?? {},
    // The same version / converts-state facts boot replay reads, for every
    // declared cell — `am replay` applies the one stamp rule (staleStamps).
    cellVersions: Object.fromEntries(
      (config._cellNames ?? []).map((c) => [c, {
        version: config._cellVersions?.[c] ?? 0,
        migrates: !!config._cellMigrations?.get(c)?.onMigrate,
      }]),
    ),
    asyncDb,
    // In-memory dispatch timeline — the trojan `timeline` route.
    getTimeline: (after?: number, limit?: number) =>
      timeline.entries(after, limit),
    getTimelineRotated: () => timeline.rotated(),
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
  // …including `app.port`, which the type calls "server port — available after
  // aio.run(), useful for connectCli()". The app object is built ~200 lines
  // above, BEFORE a listener exists, so it carried the REQUESTED port: an app
  // started with `port: 0` handed its caller a 0 while serving on a real one,
  // and `connectCli()` — the use the type names — could not be done from the
  // handle at all. The boot report, the ws URL and the lock all learned to say
  // the resolved port; this is the surface that did not.
  (app as { port?: number }).port = livePort;
  udsHandle = transport.udsHandle;
  udsRef.current = udsHandle;
  // What this app ACTUALLY listens on — the one decider for every line that
  // names it. `app.port` above stays the number it has always been (a surface
  // fact), but a zero-port app binds no TCP port at all, and the logger's
  // `started` line printed that number anyway: `started cells=c port=49725`
  // for an app whose only listener is a socket. Internal, like `_releaseCells`.
  const _tcpPort = transport.httpSocketPath || transport.skipHttp
    ? undefined
    : livePort;
  (app as { _listening?: unknown })._listening = {
    port: _tcpPort,
    socketPath: udsHandle?.socketPath,
  };

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
        // What this install's data IS by the time anyone can press "install":
        // the version on disk where there was one at boot, and the version
        // THIS run writes for every cell that had none. `stored` alone is the
        // boot-time snapshot, which is EMPTY on a fresh install — so for the
        // whole first run the gate saw "nothing on disk to protect" and
        // offered a release that cannot read the v1 data the run had just
        // written (boot 1: offer; boot 2, same data: blocked). A stored
        // version still wins where it exists: until this run rewrites that
        // cell, the older version is what is on disk, and the gate must
        // judge the data that is actually there.
        // `migrationSummary` is not even built on a fresh install (there is
        // nothing to migrate), so the declared versions come from the config.
        // Version 0 is "unversioned" — no promise, nothing to judge — and a
        // `persist: "none"` cell writes nothing to protect.
        cells: {
          ...(shouldPersist
            ? Object.fromEntries(
              Object.entries(config._cellVersions ?? {}).filter(([id, v]) =>
                v > 0 && (config._persistingCellIds?.includes(id) ?? true)
              ),
            )
            : {}),
          ...(migrationSummary?.stored ?? {}),
        },
      },
      exposed: expose,
      log,
      argv: Deno.args,
      snapshot: _snapshotDb,
      shutdown: () => _shutdownRuntime().catch(() => {}),
      prompt: ttyPrompt(),
      slot: _appSlots.get(config)?.updates,
    })
    : undefined;

  // Problem reports: user-filed and automatic. Off in libraryMode — a test or
  // a host app owns this process, and its failures are not the app's to file.
  const _feedback = config.feedback && !config.libraryMode
    ? await startFeedback({
      feedback: config.feedback,
      log,
      redact,
      slot: _appSlots.get(config)?.feedback,
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
        // carries — see ReportSources.visibleFilters. The FILTER, not the
        // per-key flags: a report screens values, and a flag map reads
        // `exclude: ["seeds.encSeed"]` as "the key `seeds` ships", which kept
        // every row's ciphertext. One answer to "what may leave the server",
        // and it is the wire's.
        visibleFilters: config._cellVisible,
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
      // `--verbose`: every setting with more than one home, the value it
      // resolved to and WHO decided — from the same resolvers that decided it
      // (config-sources.ts), so the label cannot disagree with the value.
      sources: VERBOSE ? _settings : undefined,
      client: { value: client, from: clientFrom },
      // An app that binds no TCP port has no port fact to report. It used to
      // print one anyway — `findFreePort()` runs before the transport is even
      // decided — so a zero-port app announced a number it never bound, and
      // anyone who tried it got a refused connection. `sourced()` drops an
      // undefined value, and the socket is named on its own line instead.
      port: { value: _tcpPort as number, from: portFrom },
      entry: {
        // What is RUNNING, read from the process — not what a config said
        // should run. Those differ exactly when someone is confused.
        value: Deno.mainModule.replace(/^file:\/\//, ""),
        from: "default",
      },
      heap: _heapLine,
      plugins: config._pluginNames,
      dataDir: _dirs.home,
      // `--db-path` moves the state file OUT of the data dir, and a relative
      // one resolves against CWD — so the `data` line above was pointing at a
      // directory the state was not in. Resolved, because "./rel.db" is not an
      // answer to "where is it".
      dbFile: dbPath ? resolve(dbPath) : undefined,
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
    electron: config.electron,
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
    bindHost: transport.bindHost,
    server,
    udsHandle,
    app,
    // `onStart` here is the cells bridge's: it runs every cell's `onInit`
    // (the app's own `onStart` fires later, from `aio.run`). Boot re-creates
    // what `onInit` dispatches — every harness runs it too — so it is caused,
    // like a timer a method arms. Recorded as an input, `am record` emitted
    // the call AND `bootCells` ran `onInit`: applied twice.
    onStart: onStart &&
      ((a: Parameters<typeof onStart>[0]) =>
        _effectScope.run(true, () => onStart(a))),
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
      // Read by the report only, to say when `--channel` can do nothing.
      channel: cli.channel,
    },
    // The FULL head-shaped config, not just the window box: the dev Electron
    // aio:// shell is templated at launch and has no other way to learn
    // ui.head/ui.viewport/ui.showStatus. Dropping them here made an app that
    // respected ui.head under `deno task dev` (HTTP) ship it in the packaged
    // window but NOT in the dev Electron window — two dev surfaces, two heads
    // (WYSIDIWYSIP).
    // EVERY key the lifecycle's `ui` type names — not a hand-picked five.
    // The list here silently lost chrome, theme, layout and lang (and then
    // tray) on the way to the dev Electron launch: the lifecycle read
    // `ui.chrome` from an object that never had it, so the templated shell
    // drew the OS frame whatever the app asked for. Measured: `const TRAY =
    // null` in the generated main of an app that configured a tray.
    ui: {
      width: ui.width,
      height: ui.height,
      showStatus: ui.showStatus,
      viewport: ui.viewport,
      head: ui.head,
      chrome: ui.chrome,
      theme: ui.theme,
      layout: ui.layout,
      // …and `dir` is the key it lost NEXT, after the five the comment above
      // was written about. The lifecycle's `ui` shape is a `Pick<UiConfig>`
      // now, so a key it names and this object omits is a compile error
      // rather than a config that reaches no target.
      dir: ui.dir,
      lang: ui.lang,
      tray: ui.tray,
    },
    security: config.security,
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
