import { produce } from "immer";
import {
  bakedElectronClient,
  bakedElectronRuntime,
  bakedElectronVersion,
  bakedRuntimeSha,
  electronSlug,
} from "../electron/electron-runtime-fetch.ts";
import { validateMemoryConfig } from "../diagnostics/memory-monitor.ts";
import "../state/removals.ts"; // load order: evaluated here, as before the split
import { installBundleSourceMap } from "./sourcemap-boot.ts";
// Core runtime orchestrator — boots KV, server, electron, wires everything together.
// Phase logic lives in aio-boot, aio-dispatch, aio-server, aio-lifecycle, aio-run-helpers.
// Cell composition logic lives in aio-composition and aio-cells-bridge.
// `aio.run()` itself is aio-run-entry, its config deciders aio-run-config —
// both re-exported here; this file keeps `_run` and `_runPhases`.

import {
  appHasStylesheet,
  BUNDLE_JS,
  BUNDLE_MAP,
  UI_ENTRY,
} from "./app-files.ts";
import "./deno-json.ts"; // load order: evaluated here, as before the split
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
import { createOwnManager } from "../state/own.ts";
import { routeEffect } from "../state/route-effect.ts";
import { notifyCrossUserGate, showNotifyEffect } from "./aio-dispatch.ts";
import { getLogger, log } from "../diagnostics/logger-api.ts";
import { timeTravelEnabled } from "../diagnostics/types.ts";
import {
  createAioError,
  reportError as reportAioError,
} from "../diagnostics/error.ts";

// Phase modules — extracted _run() logic
import {
  bootStorage,
  cleanStopThrough,
  getSyncReplayContext,
  issuedThrough,
  moveJournalAside,
  reactionsFormat,
  recordCleanStop,
  replaySyncOps,
  runCellRestore,
  seedSyncReactions,
  stampReactions,
  unwrapReduced,
} from "./aio-boot.ts";
import { getCompactedTs, settleOp } from "../sync/server-store.ts";
import { recordStoreGen } from "./store-gen.ts";
import { inFlightVerdict, opKey, placeOps } from "./op-placement.ts";
import { takeRejectionFor } from "../state/rejection-tracker.ts";
import { withShapeGuard } from "../state/declared-shape-guard.ts";
import { diffState } from "../sync/state-patch.ts";
import { deepMerge } from "../state/deep-merge.ts";
import { unpersistedFromBase } from "../state/cell-persist-filter.ts";
import {
  type ActionCause,
  beginReplaySession,
  chargeReplayAcrossBoots,
  isLegacyTail,
  type JournalEntry,
  type JournalGap,
  journalRefusals,
  journalWatermarkKey,
  LEGACY_RECOVERED_TYPE,
  LISTENS_TO_CMD,
  LISTENS_TO_SYNC_OP_CMD,
  REACTIONS_FORMAT,
  REACTIONS_MARKED,
  replayJournal,
  SYNC_APPLIED_TYPE,
  SYNC_INTENT_TYPE,
  SYNC_REACTION_TYPE,
  syncJournalSnapshotKey,
  syncJournalWatermarkKey,
  type SyncReaction,
  type TimeTravelRestore,
  TT_RESTORE_TYPE,
  unstoredCellOf,
  workerPatchCell,
} from "./journal.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { createTimeline } from "./timeline.ts";
import { makeRedactor } from "../diagnostics/redact.ts";
import { _quietDegraded, degraded } from "../diagnostics/degraded.ts";
import { actionOrigin, isWriteSetAction } from "../diagnostics/action-kind.ts";
import { setupDispatch } from "./aio-dispatch.ts";
import "./cell-worker-host.ts"; // load order: evaluated here, as before the split
import { createCellWorkerPool } from "./cell-worker-pool.ts";

import { validateSchedules } from "../state/schedule.ts";
import {
  currentHeapLimitBytes,
  declaredMaxHeapOf,
  describeHeapPolicy,
  envHeapCapMB,
  physicalMemoryBytes,
  reportHeapCeiling,
} from "./heap-policy.ts";
import type { Provenance } from "./boot-facts.ts";
import { entryPathOf } from "./boot-facts.ts";
import {
  dbPathOf,
  exposeFlagOf,
  hostOf,
  keepServerOf,
  persistOf,
  pick,
  serverUrlOf,
  sourceLines,
  tlsOf,
  windowSizeOf,
} from "./config-sources.ts";
import {
  appDirs,
  checkUnpackLocation,
  ensureAppDirs,
  homeRequested,
  registerAppDirs,
  registeredProfile,
  resolveAppDirs,
  sweepAppPayloadDir,
  writeAppMeta,
} from "./app-dirs.ts";
import { openBlobStore } from "./blobs.ts";
import { adoptHiddenConsole } from "./no-console.ts";
import { resolveDataDirLegacy } from "./paths.ts";
import { carriedPort } from "./dev-restart.ts";
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
import { recoverInterruptedBuild } from "./aio-run-helpers.ts";
import "./app-version.ts"; // load order: evaluated here, as before the split

// Cells-based API modules
import "./aio-composition.ts"; // load order: evaluated here, as before the split
import {
  _cloneAcrossWorkerBoundary,
  _mapCallResult,
  _onCallSettle,
  _setCallTimeouts,
} from "../state/cell-impl.ts";
import {
  _durableFor as _durableForOwed,
  _noteUnsaved,
  _owedVerdict,
  _verdictLost,
} from "./action-ack.ts";
import { PERSIST_REFUSED } from "./server-trojan.ts";
import {
  _moveRejections,
  hasRejectionFor,
} from "../state/rejection-tracker.ts";
import { ownLogFiles } from "./aio-cells-bridge.ts";
import { getRegisteredCells } from "../state/cell-reactive.ts";
import "../state/updates-cell.ts"; // load order: evaluated here, as before the split
import "../state/feedback-cell.ts"; // load order: evaluated here, as before the split
import { createCostMeter } from "../vitals/cost-meter.ts";
import { DEFAULT_HEARTBEAT_INTERVAL } from "../vitals/types.ts";

// CLI + path resolution
import {
  cdpPort,
  DEFAULT_PORT_ENV,
  electronOnlyFlagRefusal,
  envDefaultPort,
  ignoredDebugEnv,
  parseCli,
  portWasRequested,
  printHelp,
  VERSION,
} from "./aio-cli.ts";
import { awaitPredecessor, ownReplayArgs } from "./updates-apply.ts";
import { startFeedback } from "./feedback-boot.ts";
import {
  judgePendingUpdate,
  pendingConfirmer,
  returnBootAttempt,
  startUpdates,
  ttyPrompt,
  updateWindow,
} from "./updates-boot.ts";
import { offerMoveToApplications } from "./macos-move.ts";
import { PERSIST_SCHEMA_VERSION } from "./persist-schema.ts";
import {
  deriveDataContract,
  judgeKeepOld,
  PROBE_NONCE_ENV,
  probeLine,
  probeNonce,
  resolveKeepOld,
} from "./updates-core.ts";
import {
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
import "./deno-version.ts"; // load order: evaluated here, as before the split
import { dirname, join, resolve } from "@std/path";
import { lint, printLint } from "./lint.ts";
import "./plugin.ts"; // load order: evaluated here, as before the split
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
import type { AioApp, AioConfig, AioUser, UiConfig } from "./aio-types.ts";

// Re-export config validation (defined in config.ts)
export {
  VALID_AIO_CONFIG_KEYS,
  VALID_FEATURES_CONFIG_KEYS,
  VALID_UI_KEYS,
  validateConfig,
} from "./config.ts";
import {
  VALID_AIO_CONFIG_KEYS,
  VALID_UI_KEYS,
  validateCallableConfig,
  validateConfig,
} from "./config.ts";
import { count } from "../diagnostics/fmt.ts";
import { isDiagnosticsOptOut } from "../diagnostics/diagnostics-optout.ts";
import { resolveBudgets, setBudgets } from "../state/budgets.ts";
import {
  _appVersion,
  _configExit,
  _exposeOf,
  _helpFacts,
  _inferBaseDirs,
  _themeBootNote,
  _tlsOf,
  _warnPinDrift,
  clientOf,
  defaultClientFor,
  exposeReason,
} from "./aio-run-config.ts";
import { _appSlots, run, sayBootRefused } from "./aio-run-entry.ts";

// ── Run config deciders — ./aio-run-config.ts, re-exported ──

export {
  _appVersion,
  _configExit,
  _denoJsonTargetClient,
  _exposeOf,
  _hostIsExposed,
  _themeBootNote,
  _tlsOf,
  _warnPinDrift,
  clientOf,
  defaultClientFor,
  exposeReason,
} from "./aio-run-config.ts";

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

export async function _run<S, A, E>(
  initialState: S,
  config: AioConfig<S, A, E>,
): Promise<AioApp<S, A>> {
  const bootUndo = createBootUndo();
  // One boot is one replay session, opened HERE — outside everything the boot
  // does — and nowhere else. Opened beside the replay itself, every pass
  // through that code began a new session, so the re-entry the replay ceiling
  // exists to stop was never counted (see `beginReplaySession`).
  beginReplaySession();
  try {
    return await _runPhases(initialState, config, bootUndo);
  } catch (e) {
    // BEFORE the unwind: it may run the app's shutdown, which stops the logger.
    // (Not for an embedded app: its host catches the throw — see `run`.)
    if (!config.libraryMode) sayBootRefused(e);
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

  if (cli.dataContract) _printDataContract();
  function _printDataContract(): void {
    // `aio ship` asks this before publishing: a build whose `updates.keepOld`
    // its boot would refuse is refused HERE (throws, non-zero) — the boot's
    // own refusal comes only after its judge has counted the attempt.
    resolveKeepOld(config.updates);
    // What this build promises about data already on disk. Derived from the
    // very same cell versions and onMigrate hooks the boot path uses, so a
    // published contract cannot drift from what the binary actually does.
    const contract = deriveDataContract(
      config._cellMigrations ?? new Map(),
      PERSIST_SCHEMA_VERSION,
    );
    // `console.log`, NOT `log.info`: this stdout is parsed (`aio ship`,
    // `updates-rebuild`). The logger stamps every line with a timestamp and a
    // category, which prefixed the JSON's first line and made every published
    // manifest data-less. run() has already routed the framework's own lines
    // to stderr for this mode, so this is the only thing on stdout.
    // aio-ok: the machine-readable answer itself. `log.info` would prefix it
    // with a timestamp and a category and make it unparseable — which is the
    // exact defect this mode was fixed for.
    console.log(JSON.stringify(contract, null, 2));
    // …and once more on a line of its own: the app's modules may have printed
    // to stdout before this ran, and a reader finds this line regardless —
    // by the value it handed over, when it handed one.
    const nonce = probeNonce(Deno.env.get(PROBE_NONCE_ENV));
    // aio-ok: a marker `aio ship` parses off stderr, beside the JSON on stdout.
    console.error(probeLine("data-contract", JSON.stringify(contract), nonce));
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
      probeLine(
        "persisting-cells",
        String((config._persistingCellIds ?? []).length),
        nonce,
      ),
    );
    // …and the identity this build RUNS as — the name every install compares a
    // manifest's signed `name` against. `ship` names a release from deno.json;
    // an `aio.run({ appId })` in code that disagrees made every release
    // refused by every install, with nothing said at publish time. Unresolvable
    // (no id anywhere) → no marker: that app cannot boot, and says so there.
    let runsAs: string | undefined;
    try {
      runsAs = resolveAppId(config.appId);
    } catch {
      // aio-ok: no id to report; the boot path throws the teaching error.
    }
    // aio-ok: a marker `aio ship` parses off stderr, beside the JSON on stdout.
    if (runsAs) console.error(probeLine("app-id", runsAs, nonce));
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
  /** The boot's writes into `<data>/` — deferred until the lock is held. */
  let _stampDataDir: (() => Promise<void>) | undefined;
  // A requested home was resolved (and written into appDir) by the outer
  // boot; resolving again would read appDir as the BASE of the profile.
  const _dirs = homeRequested(appId) ? appDirs(appId) : resolveAppDirs({
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
  if (!config.libraryMode) await _checkUnpackPlace();
  async function _checkUnpackPlace(): Promise<void> {
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
    // Everything this boot WRITES into `<data>/` — the heap-notice stamp, the
    // legacy-layout migration, meta.json — runs only once the singleton lock
    // is ours (`_stampDataDir()` below). A boot the lock REFUSES — another
    // instance, or `am backup`/`am restore` holding it — must leave data/
    // byte-identical: it used to rewrite meta.json (a torn copy in a backup)
    // and could refill a data/ a restore had just moved aside.
    _stampDataDir = async () => {
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
        // The launcher may have clamped the ceiling for a controlled
        // environment (see envHeapCapMB); the report must use the same cap or
        // every app the release suite spawns warns "under policy" at boot.
        capMB: envHeapCapMB(),
      });
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
        profile: registeredProfile(appId),
      });
    };
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
  // `electron: { ignoreDebugEnv }` takes both env rungs (and `AIO_CDP`, at
  // the lock below) out of a desktop app's boot: said once, naming them.
  const _debugEnv = ignoredDebugEnv(
    config.electron?.ignoreDebugEnv,
    clientOf(cli, config).value,
    (name) => {
      try {
        return Deno.env.get(name);
      } catch {
        return undefined; // no --allow-env here: nothing ambient to ignore
      }
    },
  );
  if (_debugEnv?.mistyped) {
    log.warn(
      `electron.ignoreDebugEnv is ${
        JSON.stringify(config.electron?.ignoreDebugEnv)
      }, not true or false — read as true: AIO_CDP, AIO_PORT and ` +
        `${DEFAULT_PORT_ENV} are ignored.`,
    );
  }
  if (_debugEnv?.ignored.length) {
    log.warn(
      `${_debugEnv.ignored.join(", ")} ${
        _debugEnv.ignored.length > 1 ? "are" : "is"
      } set and ignored (electron: { ignoreDebugEnv: true }) — no port is ` +
        `opened from the environment. For this launch, type --port / --cdp.`,
    );
  }
  // A dev restart's carried port (dev-restart.ts) is the supervisor's word,
  // not the environment's: `ignoreDebugEnv` does not take it out.
  const _envPort = carriedPort() ?? (_debugEnv ? undefined : envPort());
  // `AIO_DEFAULT_PORT=0` is "pick a free one" — saying nothing, so no rung.
  const _defaultPort = _debugEnv ? undefined : envDefaultPort() || undefined;
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
  // `AIO_PORT=0` means "pick a free one", exactly like `--port=0` and
  // `port: 0` — so the env spelling no longer counts as "named a port". (The
  // predicate reads a 0 as "not said"; the value still travels through
  // `pick`, which treats 0 as an answer.)
  const _portRequested = portWasRequested(cli.port, _envPort, config.port);
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
      profile: registeredProfile(appId),
      cdpPort: cdpPort(clientOf(cli, config).value, !!_debugEnv),
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
      // Where the port it is about to bind will be: a record that names a
      // port and not its address sends whoever checks on it to 127.0.0.1.
      // The server writes the address it really bound once it is up.
      host: hostOf(cli, config)?.value ??
        (_exposeOf(cli, config) ? "0.0.0.0" : "127.0.0.1"),
    },
  );
  bootUndo.push("lock", () => appLock?.release());
  // This launch goes on as the app: its logs are its own now (one that found
  // another instance there wrote nothing into them until here — see
  // `guestLogger`; with `singleton: false` that is every launch).
  await ownLogFiles(appDirs(appId, config.appDir).home);
  // Did the last boot install something? Count this attempt, or — having spent
  // them — put the old artifact back and let the supervisor start it. Runs in
  // the NEW build, because it is the only thing present to judge itself.
  //
  // AFTER the lock, deliberately. It used to run before, so a boot REFUSED by
  // the singleton lock still burned an attempt: start an already-running app
  // twice and the third launch rolled back a perfectly healthy update. A boot
  // that never got as far as owning the app cannot be evidence about the build.
  if (
    !config.libraryMode &&
    await judgePendingUpdate(_dirs.data, log, await _appVersion(), {
      // Never a refusal before the judge has counted: an invalid value is
      // refused by the boot right after, as a failed start it rolls back.
      keepOld: judgeKeepOld(config.updates, (m) => log.error("updates", m)),
    })
  ) {
    appLock?.release();
    Deno.exit(1);
  }

  // The lock is ours (or this boot takes none): only now may it write data/.
  // After the judge: a build the swap helper already rolled back exits there
  // without having stamped this data dir as its own.
  await _stampDataDir?.();

  // Electron-only flags on a non-Electron client are refused HERE, before the
  // thin-client path can act on one: `--connect` with `--client=browser` used
  // to override the client and start a ~100 MB Electron download, while
  // `--keep-server` was refused only after the banner. The client is resolved
  // by the same rule as below (flag > config > deno.json > electron); one
  // pure decider (aio-cli.ts) names what was typed and the client it needs.
  // The FLAGS only. An ambient `AIO_CDP` is not refused: on a client with no
  // window it is ignored, said once, and advertises nothing — `cdpPort(client)`
  // at the lock above settles it. Refusing it (1.0.15–1.0.16) failed the boot
  // of every server-only app under a CI/compose environment that exports it.
  const _electronOnly = electronOnlyFlagRefusal(
    cli,
    clientOf(cli, config).value,
    config,
  );
  if (_electronOnly) {
    // What was typed, not the build: this launch is no boot attempt.
    returnBootAttempt(_dirs.data, log);
    appLock?.release();
    throw _electronOnly;
  }

  // Thin client mode
  if (
    await handleThinClient(serverUrlOf(cli, config)?.value, (_v) => {
      /* multi-instance (D2): no process-wide running flag */
    }, config.electron?.strictPin === true)
  ) return null!;

  // A build killed mid-compile left this project's node_modules trimmed and
  // unlinked; put it back before the dev bundle resolves a package. A binary
  // has no node_modules to repair.
  if (!isCompiled()) await recoverInterruptedBuild();

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
  if (!prod && isCompiled()) await _detectCompiledProd();
  async function _detectCompiledProd(): Promise<void> {
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
    // THIS app's ledger, explicitly — as persistence and the server get it.
    _budgetLedger,
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
  // WHAT reaches the store comes from ONE rule (state/cell-persist-filter.ts),
  // handed in by `buildLegacyConfig`. There is no whole-state default: a
  // `persist: "none"` cell written to disk is the 1.0.7 standalone bug, and a
  // silent `(s) => s` here is how a new caller would reintroduce it on the
  // server. scripts/check-persist-decider.ts holds the line statically.
  const decidedDBState = config._getDBState;
  if (!decidedDBState) {
    throw new Error(
      "[aio] internal: the boot was reached without a persist filter " +
        "(`_getDBState`, built by `buildDBStateGetter`). Refusing to guess — " +
        'a whole-state default would write `persist: "none"` cells to disk.',
    );
  }
  const getDBState: (s: S) => unknown = decidedDBState;
  const persistKey = config.persistKey ?? "state";
  const persistMode = config.persistMode ?? "single";
  const ui = config.ui ?? {} as UiConfig;

  validateConfig(
    config as unknown as Record<string, unknown>,
    VALID_AIO_CONFIG_KEYS,
    "AioConfig",
    _configExit(config.libraryMode),
  );
  if (config.ui) {
    validateConfig(
      config.ui as Record<string, unknown>,
      VALID_UI_KEYS,
      "ui",
      _configExit(config.libraryMode),
    );
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
  // A headless run serves no page, so which look a page WOULD get is noise.
  const themeNote = isHeadless ? null : _themeBootNote(
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
  const _reportOpts = buildReportOpts({
    onError,
    getTT: () => tt,
    prod,
    redact,
  });

  const boot = await bootStorage({
    appId,
    // THIS app's ledger, explicitly — a `budgetsFor()` read inside the async
    // boot can see a concurrently-booting app's (see BootConfig.budgets).
    budgets: _budgetLedger,
    dbPath,
    dbPragmas: config.dbPragmas,
    checkIntegrityOnBoot: config.checkIntegrityOnBoot,
    initialState,
    shouldPersist,
    harnessShapeGuard: config._harnessShapeGuard === true,
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
    persistingCellIds: config._persistingCellIds,
    listenedTypes: Object.values(config._cellForeignActions ?? {}).flat(),
    log,
  });
  state = boot.state as S;
  const {
    kvDb,
    asyncDb,
    persistence,
    journal,
    syncHandler,
    syncBroadcastRef,
    strayJournal,
    storeSavedElsewhere,
    journalHeld,
  } = boot;
  bootUndo.push("sqlite", () => asyncDb?.close());
  bootUndo.push("kv", () => kvDb?.close());
  const migrationSummary = boot.migrations;
  const _syncDispatchRef = boot.syncDispatchRef;
  const { schedulePersist } = persistence;

  // B1/AIO-416: recover sync cells from their op-log at boot (after KV restore +
  // onRestore, before any dispatch/broadcast). Without this, sync cells came back
  // empty on a server restart until a client reconnected — silent data loss.
  /** The store-restored state, when this boot replays a crashed journal an
   *  older build wrote (see `LEGACY_RECOVERED_TYPE`); null otherwise. */
  let _legacyBoot: S | null = null;
  /** This run journals every sync op on a listened action — its intent and
   *  its commit (journal.ts, J1–J7). */
  const _marking = journal !== null && syncCellIds.length > 0 &&
    !!syncHandler?.setFoldWatermark && !!kvDb?.planSet;
  /** Action types some cell `listensTo`. */
  const _listenedTypes = new Set(
    Object.values(config._cellForeignActions ?? {}).flat(),
  );
  /** The ops a crash caught between their persist and their commit
   *  (journal.ts J4): left out of their cells' replay, reduced whole after
   *  the journal. `intentSeq`: where their intent sits in the journal. */
  const _deferred: {
    cell: string;
    id: string;
    action: string;
    payload: unknown;
    ts: number;
    intentSeq: number;
  }[] = [];
  /** The listened ops in the log this boot placed with no commit yet —
   *  committed before any input, so each is placed (and named) once. */
  const _unmarked: { cell: string; id: string; ts: number }[] = [];
  /** A store saved by a run that journals nothing, after this journal's tail
   *  was written (store-gen.ts): the tail is moved aside, never replayed. An
   *  older build's own tail is the legacy path's. */
  const _retireForeign = storeSavedElsewhere && journal !== null &&
    !isLegacyTail(journal.readTail());
  /** Where the ops a clean stop of this run may vouch for start (exclusive):
   *  the ones issued before it were placed — or lost — by an earlier run. */
  let _cleanRunFrom: number | undefined;
  // Each long boot block is a function of its own: V8 builds every Error by
  // scanning the position table of each function on the stack up to its call
  // site, so code deep in one long function made each Error built under it
  // (a missing file's NotFound) ~15x dearer (todo.md, "Boot: every error").
  if (asyncDb && syncCellIds.length > 0) await _recoverSyncLogs(asyncDb);
  async function _recoverSyncLogs(
    asyncDb: NonNullable<typeof boot.asyncDb>,
  ): Promise<void> {
    let tail: JournalEntry[] = [];
    let lines: JournalEntry[] = [];
    try {
      tail = journal?.readTail() ?? [];
      lines = (journal ?? strayJournal)?.readSince(-Infinity) ?? [];
    } catch { /* aio-ok: an unreadable journal is refused, loudly, below */ }
    // Data an OLDER build (1.0.9 or earlier) last wrote holds no record of
    // the `listensTo` reactions of its sync ops on other cells — that build
    // re-derived them at its own boots, through the whole root, and saved
    // them or lost them in ways no record shows. None is re-derived here:
    // re-applying a reaction its save already held counted it twice (a
    // tally of 24 came back 45). Each cell's own ops fold into it, as
    // always, and every listener that may lack reactions is NAMED. Legacy
    // is this build's stamp missing from the op-log (a clean stop compacts
    // the journal empty, and a store may be off) and none of its records in
    // the journal; over data this build HAS run, an op an older build wrote
    // after a downgrade is found by its own missing records (journal.ts J3).
    const ours = await reactionsFormat(asyncDb) !== undefined ||
      lines.some((e) =>
        e.type === SYNC_INTENT_TYPE || e.type === SYNC_APPLIED_TYPE
      );
    const legacyTail = isLegacyTail(tail);
    // The latest clean stop (see `CLEAN_STOP_ROW`): the ops it covers, and
    // where this run's own ops start — continuing that range only when
    // nothing was issued since (no other run came between).
    const clean = await cleanStopThrough(asyncDb);
    const issuedAtBoot = await issuedThrough(asyncDb);
    _cleanRunFrom = clean !== undefined && clean.to >= issuedAtBoot
      ? clean.from
      : issuedAtBoot;
    let legacy = false;
    try {
      legacy = !ours && (legacyTail ||
        (!tail.some((e) => e.fmt !== undefined) &&
          (await asyncDb.query<{ n: number }>(
              "SELECT (SELECT COUNT(*) FROM sync_ops) + " +
                "(SELECT COUNT(*) FROM sync_snapshots) AS n",
            )).rows[0]!.n > 0));
    } catch { /* aio-ok: an unreadable op-log is refused, loudly, below */ }
    // An older build's unstamped lines above the last upgrade marker are
    // CALLS, replayed as calls; the marker this boot writes after them
    // retires them (see `LEGACY_RECOVERED_TYPE`).
    _legacyBoot = legacyTail ? state : null;
    const fa = config._cellForeignActions ?? {};
    const cellOf = (t: string) => t.slice(0, Math.max(0, t.indexOf(":")));
    if (legacy) {
      log.warn(
        `journal: this data was last run by an older aio build (1.0.9 or ` +
          `earlier), which recorded no listensTo reactions of its sync ops — ` +
          `none is re-derived, so nothing is counted twice; every listener ` +
          `that may lack some is named below`,
      );
    }
    /** Listener → what it may lack, in words. */
    const lacks = new Map<string, string[]>();
    const say = (k: string, what: string) =>
      lacks.set(k, [...lacks.get(k) ?? [], what]);
    const listenersOf = (src: string) =>
      Object.entries(fa).filter(([, types]) =>
        types.some((t) => cellOf(t) === src)
      ).map(([k]) => k);
    // Every listened op in the log, placed by the journal's records
    // (journal.ts J1–J7, op-placement.ts `placeOps`). Over legacy data none
    // has a record; with no journal this run records none — and names none,
    // its crash losing them as documented (docs/persistence/crdt.md).
    // With the journal off, a journal a crash left still holds the op
    // records: its ops caught in flight are resolved as a journal-on boot
    // resolves them — and nothing else is placed (`strayJournal`).
    /** COMMIT(X) records read (journal.ts) — `opKey`. */
    const commits = new Set<string>();
    if (_marking || legacy || strayJournal !== null) {
      const intents = new Map<string, number>();
      // A journal that is moved aside unreplayed (below) takes its reaction
      // lines and its commits with it: none of them covers anything any
      // more — each op is named once here and committed anew.
      for (const e of lines) {
        if (e.type !== SYNC_INTENT_TYPE && e.type !== SYNC_APPLIED_TYPE) {
          continue;
        }
        if (e.type === SYNC_APPLIED_TYPE && _retireForeign) continue;
        const p = e.payload as { id?: unknown; ts?: unknown };
        if (typeof p?.id !== "string" || typeof p.ts !== "number") continue;
        if (e.type === SYNC_INTENT_TYPE) intents.set(opKey(p.id, p.ts), e.seq);
        else commits.add(opKey(p.id, p.ts));
      }
      for (const c of syncCellIds) {
        const { rows } = await asyncDb.query<
          {
            id: string;
            action: string;
            payload: string;
            server_ts: number;
            settled: number | null;
          }
        >(
          "SELECT id, action, payload, server_ts, settled FROM sync_ops " +
            "WHERE cell = ? ORDER BY server_ts",
          [c],
        );
        const placed = placeOps(
          rows.map((r) => ({
            id: r.id,
            ts: r.server_ts,
            listened: _listenedTypes.has(`${c}:${r.action}`),
          })),
          new Set(intents.keys()),
          commits,
        );
        const uncovered: number[] = [];
        for (const r of rows) {
          const p = placed.get(r.id);
          if (p === undefined || p === "covered") continue;
          // A row MARKED settled (server-store.ts `settleOp`) was accepted
          // and acknowledged, whatever the journal now holds: its commit
          // line is one the journal lost (a power cut, a restored or cut
          // file). Never in flight — so never removed by a refusal below:
          // it folds with its cell (`replaySyncOps` refuses or quarantines
          // on it, as on any settled row) and its listeners are named.
          if (p === "in-flight" && r.settled !== 1) {
            _deferred.push({
              cell: c,
              id: r.id,
              action: r.action,
              payload: JSON.parse(r.payload),
              ts: r.server_ts,
              intentSeq: intents.get(opKey(r.id, r.server_ts))!,
            });
            continue;
          }
          if (!_marking && !legacy) continue;
          // A run that stopped cleanly after it saved every record: the
          // reactions are in them, journal or not.
          if (
            !legacy && clean !== undefined && r.server_ts > clean.from &&
            r.server_ts <= clean.to
          ) {
            if (_marking) {
              _unmarked.push({ cell: c, id: r.id, ts: r.server_ts });
            }
            continue;
          }
          uncovered.push(r.server_ts);
          if (_marking) _unmarked.push({ cell: c, id: r.id, ts: r.server_ts });
        }
        const n = uncovered.length;
        const folded = legacy && await getCompactedTs(asyncDb, c) > 0;
        for (const k of listenersOf(c)) {
          if (n > 0) {
            say(
              k,
              `${count(n, `"${c}" op`)} in the op-log (server_ts ${
                uncovered[0]
              }–${uncovered[n - 1]})`,
            );
          }
          if (folded) say(k, `the "${c}" ops it folded out of the op-log`);
        }
      }
    }
    // A sync listener of a store CALL: the older build recorded its
    // reaction in no fold it can show — named with the rest.
    if (legacy) {
      for (const c of syncCellIds) {
        const calls = (fa[c] ?? []).filter((t) =>
          !syncCellIds.includes(cellOf(t))
        );
        if (calls.length > 0) {
          say(c, `the ${calls.map((t) => `"${t}"`).join(", ")} calls`);
        }
      }
    }
    for (const [k, what] of lacks) {
      log.warn(
        legacy
          ? `sync: "${k}"'s listensTo reactions to ${what.join(", and to ")} ` +
            `are in no record this boot can read — this data was last ` +
            `written by an older aio build (1.0.9 or earlier), which kept ` +
            `none. Nothing was re-applied, so nothing is counted twice; 1.0.9 ` +
            `may have saved these reactions or lost them — check "${k}".`
          : `sync: cannot tell whether "${k}" holds its listensTo reactions ` +
            `to ${what.join(", and to ")} — those ops were written by a run ` +
            `that recorded neither a journal of them nor a clean stop (an ` +
            `older aio build, or this one with the journal or persistence ` +
            `off), or the journal lost lines (deleted, restored from a ` +
            `backup, cut short). ${
              syncCellIds.includes(k)
                ? `"${k}"'s last fold`
                : "The store's last save"
            } may hold them or not. Nothing was re-applied, so nothing is ` +
            `counted twice — check "${k}".`,
      );
    }
    state = await replaySyncOps(
      asyncDb,
      syncCellIds,
      config.reduce as (
        s: S,
        a: { type: string; payload?: unknown },
      ) => S,
      state,
      log,
      undefined,
      {
        defer: new Map(_deferred.map((d) => [d.cell, d.ts])),
        committed: commits,
      },
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

  /** The replayed state, with every cell the replay touched sent through the
   *  round trip a clean restart gives it: the slice is written exactly as the
   *  store writes it (filter, then `onPersist`, then JSON) and read back the
   *  way boot reads it (`_restartedSlice`).
   *
   *  This used to run for `onPersist`-shaped cells only — a shape names no
   *  fields, so `_keepUnpersistedFields` cannot read one (`onPersist: (s) =>
   *  ({ data: s.data })` kept `cache` off disk, and a `setBoth(7)` came back
   *  `cache: 0` after a clean stop and `cache: 7` after a SIGKILL). But a
   *  PLAIN cell's restore is `deepMerge(declared, stored)` too, and replay
   *  kept its slice as the method left it: `delete s.m.a; s.m.extra = 5` came
   *  back `{ b: 2, extra: 5 }` after a SIGKILL and `{ a: 1, b: 2 }` after a
   *  clean stop — the deleted declared key filled back in and the undeclared
   *  one dropped, as the write guard promises. Every cell takes the one read
   *  now, so the two stops cannot drift apart again one cell kind at a time.
   *
   *  A sync cell is not restored from the store (its op-log is its record —
   *  `replaySyncOps`), so it keeps what replay produced.
   *
   *  A shape that throws here is the same failure the persist path reports on
   *  its next write; the replayed slice is kept and the throw is said now. */
  function _roundTripReplayedCells(restored: S, replayed: S): S {
    if (replayed === restored) return replayed;
    const from = restored as Record<string, unknown>;
    const declared = initialState as Record<string, unknown>;
    let out: Record<string, unknown> | null = null;
    for (const cell of Object.keys(declared)) {
      const now = (replayed as Record<string, unknown>)[cell];
      if (
        now === from[cell] || !_isRecord(now) || !_isRecord(declared[cell]) ||
        syncCellIds.includes(cell)
      ) continue;
      let disk: Record<string, unknown>;
      try {
        const stored = (getDBState({ [cell]: now } as S) as
          | Record<string, unknown>
          | undefined)?.[cell];
        disk = stored === undefined
          ? {}
          : JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;
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
      out ??= { ...(replayed as Record<string, unknown>) };
      out[cell] = _restartedSlice(cell, disk);
    }
    return (out ?? replayed) as S;
  }

  /** One cell's slice as a clean restart reads it back from `disk` (its
   *  stored form, already through JSON): the declared state with the stored
   *  fields merged over it — `bootStorage`'s `deepMerge`, so a declared key
   *  the store lacks is filled in and an undeclared one is dropped — and, for
   *  an `onPersist`-shaped cell, its `onRestore` handed the stored shape. A
   *  plain cell's `onRestore` runs in `_rerunRestoreHooks`, in boot's order.
   *  The one read every replay path shares (`_roundTripReplayedCells`,
   *  `_restoreStoredSlice`). */
  function _restartedSlice(
    cell: string,
    disk: Record<string, unknown>,
  ): Record<string, unknown> {
    const declared = (initialState as Record<string, unknown>)[cell];
    const slice = deepMerge(
      structuredClone(declared) as Record<string, unknown>,
      disk,
    );
    const hook = config._cellPersistShaped?.includes(cell)
      ? config._cellRestores?.get(cell)
      : undefined;
    return hook
      ? runCellRestore(cell, hook, slice, {
        stored: disk,
        declared,
        retyped: true,
      }, log)
      : slice;
  }

  /** A time-travel line's STORED fields as the cell's live slice (see
   *  `replayJournal`'s `restoreStored`): an `onPersist`-shaped cell is rebuilt
   *  the way a restart rebuilds it — declared state, the stored shape merged
   *  over it, the cell's `onRestore` — because the fields are its SHAPE, not
   *  its state, and spreading them over the live slice produced
   *  `{ n: 0, saved: 1 }` for `onPersist: (s) => ({ saved: s.n })`, which
   *  `_roundTripReplayedCells` then reshaped from `n: 0` (external review, rev4).
   *  Every other cell keeps the spread. */
  function _restoreStoredSlice(
    cell: string,
    stored: Record<string, unknown>,
    live: Record<string, unknown>,
  ): Record<string, unknown> {
    const declared = (initialState as Record<string, unknown>)[cell];
    if (!_isRecord(declared)) return { ...live, ...stored };
    const disk = JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;
    if (!config._cellPersistShaped?.includes(cell)) {
      // Rebuilt as a restart rebuilds it — declared state, the stored fields
      // over it — and NOT spread over the live slice: a key the line's state
      // no longer has (a reaction that `delete`d or undefined'd it) is absent
      // from `stored`, and the spread kept the live value, i.e. the OLDER
      // store snapshot's (`err: "boom"` back after a crash, `""` after a
      // clean restart). Only what the persist filter keeps off disk comes
      // from the live slice: the line never had it to say.
      return _unpersistedFromBoot(
        config._cellPersist?.[cell] ?? "all",
        live,
        _restartedSlice(cell, disk),
      );
    }
    return _restartedSlice(cell, disk);
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
  /** Every cell a time-travel line carries state for — whole (`cells`, a
   *  reaction's `keyframes`) or as a delta (`deltas`). Each one is stamped
   *  with its version (`_journalVersions`) and judged by it on replay. */
  function _ttStateCells(
    tt: Partial<TimeTravelRestore> | undefined,
  ): string[] {
    return [
      ...new Set([
        ...Object.keys(tt?.cells ?? {}),
        ...Object.keys(tt?.keyframes ?? {}),
        ...Object.keys(tt?.deltas ?? {}),
      ]),
    ];
  }

  /** A copy of the journal as boot read it, taken once, when boot names lines
   *  it could not judge or replay. The live file is no record of them: the
   *  first save compacts every line at or below its watermark, those included
   *  — and they are the only copy of what those acked writes were. Named like
   *  a journal set aside (`moveJournalAside`), so every scrub that reaches one
   *  reaches this. A copy that cannot be taken is said in the warning, not
   *  thrown: refusing to boot would make recovery the reason the app is down. */
  let _keptJournal: string | undefined;
  function _keepJournalCopy(): string {
    if (_keptJournal !== undefined) return _keptJournal;
    if (!journal) return (_keptJournal = "");
    const to = `${journal.path}.unreplayed-${
      new Date().toISOString().replace(/[:.]/g, "-")
    }`;
    try {
      Deno.copyFileSync(journal.path, to);
      return (_keptJournal = `A copy of the journal as boot read it is kept ` +
        `at ${to} — the live file drops these lines at its next save.`);
    } catch (e) {
      return (_keptJournal = `Keeping a copy of the journal at ${to} FAILED ` +
        `(${e}) — the live file drops these lines at its next save; copy ` +
        `${journal.path} by hand before writing to this app.`);
    }
  }

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
      const cells = e.type === TT_RESTORE_TYPE
        ? _ttStateCells(e.payload as Partial<TimeTravelRestore> | undefined)
        : [
          workerPatchCell(e.type, e.payload) ??
            (e.origin ?? e.type).slice(
              0,
              Math.max(0, (e.origin ?? e.type).indexOf(":")),
            ),
        ];
      for (const c of cells) {
        // Judged per cell: a stamped line that stamps some cells and not
        // this one cannot be judged for it either.
        if (!moved.has(c) || e.v?.[c] !== undefined) continue;
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
              `v${m.to} meaning). Check it against the journal with ` +
              `\`am timeline --from=<file>\`. ${_keepJournalCopy()}`,
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
   *  back to its boot value (or removed, where boot had none) — the shared
   *  rule in `state/cell-persist-filter.ts`, which the dev checkpoint restore
   *  reads too. */
  function _unpersistedFromBoot(
    filter: import("../state/cell-types.ts").CellFieldFilter,
    was: Record<string, unknown>,
    now: Record<string, unknown>,
  ): Record<string, unknown> {
    return unpersistedFromBase(filter, was, now);
  }

  /** The tail minus the lines that write only a quarantined sync cell: its
   *  state is its last snapshot, and a line from before the crash applied to
   *  it would fold a write onto a shape it was never taken on. They stay on
   *  disk (`retireCells` spares them), and are NAMED — fixing the cell's
   *  version/onMigrate and restarting replays them.
   *
   *  The same for a cell this build does not DECLARE (`journalHeld`): it has
   *  no methods to re-run them through, and its stored slice is preserved
   *  untouched — so are its lines, held by the journal (`journalHeldCellsKey`)
   *  until a build declares the cell and replays them onto that slice. They
   *  used to be "replayed" as no-ops, counted recovered, and compacted away
   *  by the first save. */
  function _quarantinedTail(tail: JournalEntry[]): JournalEntry[] {
    const sq = asyncDb ? getSyncReplayContext(asyncDb)?.quarantined : undefined;
    const q = new Set([...(sq ?? []), ...journalHeld]);
    if (!q.size || tail.length === 0) return tail;
    const own = (e: JournalEntry): string | undefined => {
      if (e.only?.length) {
        return e.only.every((k) => q.has(k)) ? e.only[0] : undefined;
      }
      const i = e.type.indexOf(":");
      const c = i > 0 ? e.type.slice(0, i) : undefined;
      return c !== undefined && q.has(c) ? c : undefined;
    };
    const held = new Map<string, number[]>();
    const rest = tail.filter((e) => {
      const c = own(e);
      if (c === undefined) return true;
      const seqs = held.get(c) ?? [];
      held.set(c, seqs);
      seqs.push(e.seq);
      return false;
    });
    for (const [c, seqs] of held) {
      if (journalHeld.has(c)) {
        log.warn(
          `journal: "${c}" is not declared by this build — ${
            count(seqs.length, "journalled line")
          } written for it (seq ${seqs[0]}–${seqs.at(-1)}) are KEPT in ` +
            `${journal!.path}, not applied, like its stored data. Re-declare ` +
            `"${c}" and restart: they are replayed onto that data then.`,
        );
        continue;
      }
      log.error(
        `journal: "${c}" is quarantined — ${
          count(seqs.length, "journalled line")
        } written for it before this boot (seq ${seqs[0]}–${seqs.at(-1)}) ` +
          `are KEPT in ${journal!.path}, not applied. Fix "${c}"'s ` +
          `version/onMigrate and restart: they are replayed then.`,
      );
    }
    return rest;
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
  /** Per sync cell: the highest op-log position (`server_ts`) its LIVE state
   *  holds — advanced at each op's commit (afterAction), read when a
   *  `listensTo` reaction of the cell is journalled (`SyncReaction.at`).
   *  Seeded below, after boot has restored every op the log holds. */
  const _appliedTs = new Map<string, number>();
  /** Per sync cell: the last reaction line of its current chain (see
   *  `SyncReaction`) — its seq and the live slice it recorded, which the next
   *  line is a delta against. Absent ⇒ the next line is a keyframe: at boot,
   *  after a fold capture, after an append that did not land. */
  const _reactionChain = new Map<
    string,
    { seq: number; state: unknown; snapshotAt?: number }
  >();
  /** Per sync cell: the fold in flight — the state it captured and the journal
   *  seq it captured at, the chain's new base once it lands (`folded`).
   *  `lined`: a reaction line was written since the capture (the first one
   *  carries `SyncReaction.alsoSnapshot`, so the chain survives either way). */
  const _captured = new Map<
    string,
    { at: number; state: unknown; lined: boolean }
  >();
  /** The same, per store-persisted cell: the stored slice its last reaction
   *  line resolves to (`TimeTravelRestore.deltas`). */
  const _kvChain = new Map<string, { seq: number; stored: unknown }>();
  // A save captures here: the lines its watermark will drop end here, so the
  // next reaction line of what it saves starts a new chain (whole, not a
  // delta) — a chain never outlives its first line. A sync cell's fold
  // re-bases its chain on the snapshot instead (`setFoldWatermark` below).
  journal?.onCapture((c) => {
    if (c === undefined) _kvChain.clear();
  });
  /** Per sync cell: the `compacted_ts` its last journalled fold left, as
   *  recorded before this boot (`syncJournalSnapshotKey`). */
  const _foldedAt = new Map<string, number>();
  if (journal) await _wireJournal(journal);
  async function _wireJournal(
    journal: NonNullable<typeof boot.journal>,
  ): Promise<void> {
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
      // Where each cell's snapshot stands as this run starts journalling it
      // — once; its folds keep it current from then on.
      for (const c of syncCellIds) {
        const key = syncJournalSnapshotKey(appId, c);
        const at = await kvDb!.get<number>(key);
        if (typeof at === "number") _foldedAt.set(c, at);
        else await kvDb!.set(key, await getCompactedTs(asyncDb!, c));
      }
      journal.trackCells(stored);
      // …and the ones whose watermark will never move (see `retireCells`).
      // Only the lines this boot writes: the ones already there were written
      // before the cell was quarantined, and fixing its version recovers them
      // (kept by its own watermark, not replayed — see `_quarantinedTail`).
      journal.retireCells(
        getSyncReplayContext(asyncDb!)?.quarantined ?? [],
        journal.currentSeq(),
      );
      // Boot has restored every op the log holds: that is where each sync
      // cell's live state starts (`_appliedTs`).
      for (const c of syncCellIds) {
        const { rows } = await asyncDb!.query<{ m: number | null }>(
          "SELECT MAX(server_ts) AS m FROM sync_ops WHERE cell = ?",
          [c],
        );
        _appliedTs.set(
          c,
          Math.max(rows[0]?.m ?? 0, await getCompactedTs(asyncDb!, c)),
        );
      }
      syncHandler!.setFoldWatermark!({
        capture: (c) => {
          // Same synchronous turn as the fold's own state read: this IS the
          // state its snapshot holds.
          const at = journal.capture(c);
          _captured.set(c, {
            at,
            state: (state as Record<string, unknown>)[c],
            lined: false,
          });
          return at;
        },
        plan: (c, at) => [
          ...kvDb!.planSet!(syncJournalWatermarkKey(appId, c), at),
          // Last in the fold's transaction: the `compacted_ts` it just wrote.
          {
            sql: `INSERT INTO aio_kv (k, v)
                    SELECT ?, CAST(compacted_ts AS TEXT) FROM sync_meta
                    WHERE cell = ?
                    ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
            params: [syncJournalSnapshotKey(appId, c), c],
          },
        ],
        folded: (c, at) => {
          journal.setCellWatermark(c, at);
          // The snapshot is on disk, with its watermark: every line at or
          // below `at` is gone from the tail. A line written while the fold
          // was in flight is above it and resolves on its own (a keyframe,
          // or `alsoSnapshot`) — the chain goes on from it. Else the next
          // line is a delta against the snapshot (`baseSnapshotAt`).
          const cap = _captured.get(c);
          _captured.delete(c);
          if (cap?.at === at && cap.lined) return;
          if (cap?.at === at) {
            _reactionChain.set(c, { seq: 0, state: cap.state, snapshotAt: at });
          } else _reactionChain.delete(c);
        },
      });
    }
    // A database that went BACK in time — `checkIntegrityOnBoot` restored its
    // snapshot, or a file was copied over it — is older than the journal's
    // tail, with a hole between the two. Replaying across the hole re-ran
    // actions on a state they never ran on: `withdrawAll()` after three
    // deposits, replayed onto the restored balance of 50, recorded a
    // withdrawal of 50 that never happened. Refused, loudly, and the journal
    // is kept — beside the damaged database when there is one.
    // A store saved by a run that journals nothing, after this tail was
    // written (store-gen.ts): the tail is older than the store — moved aside,
    // never replayed. An older build's own tail is the legacy path's.
    if (_retireForeign) moveJournalAside(journal, "foreign-save", log);
    // …and from here, this boot's picture of the store is the record.
    if (asyncDb && kvDb?.planSet) {
      await recordStoreGen(asyncDb, appId, journalWatermarkKey(appId));
    }
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
    const tail = _quarantinedTail(gap ? [] : journal.readTail());
    // A tail an earlier boot already replayed, and no save since: charged.
    chargeReplayAcrossBoots(journal.path, tail[0]?.seq, tail.length);
    if (tail.length > 0) _warnUnstampedAcrossMigration(tail);
    if (tail.length > 0) {
      // Sync cells' `listensTo` reactions first: each goes back BETWEEN the
      // cell's own ops (see `seedSyncReactions`), and no later line may write
      // the cell again from before that point.
      let seededAt = new Map<string, number>();
      if (_syncJournal && asyncDb) {
        const seeded = await seedSyncReactions(
          asyncDb,
          syncCellIds,
          config.reduce as unknown as (
            s: S,
            a: { type: string; payload?: unknown },
          ) => { state: S },
          state,
          tail,
          (cell) => config._cellVersions?.[cell] ?? 0,
          log,
          (cell) => journal.watermarkFor(cell),
          new Map(_deferred.map((d) => [d.cell, d.ts])),
          (cell) => _foldedAt.get(cell),
        );
        state = seeded.state;
        seededAt = seeded.seededAt;
        for (const c of seededAt.keys()) syncHandler!.noteServerWrite(c);
      }
      const before = state;
      const replay = replayJournal(
        state,
        tail,
        config.reduce as (s: S, a: A) => { state: S },
        (key) => Math.max(journal.watermarkFor(key), seededAt.get(key) ?? 0),
        (cell) => config._cellVersions?.[cell] ?? 0,
        (cell) => !!config._cellMigrations?.get(cell)?.onMigrate,
        _restoreStoredSlice,
      );
      state = _rerunRestoreHooks(
        state,
        _roundTripReplayedCells(
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
            `the recovered state. Skipping is deliberate: failing on an entry ` +
            `that cannot be replayed would make recovery the reason this app ` +
            `can never start. ${_keepJournalCopy()}`,
        );
      }
    }
  }

  // The ops a crash caught between their persist and their commit
  // (`_deferred`, left out of their cells' replay above): reduced now, whole,
  // exactly as the live server decides — a refusal deletes the op and nothing
  // acks it — and recorded below (`_unmarked`). A reaction is applied only
  // where its listener's record certainly lacks it (op-placement.ts
  // `inFlightVerdict`); held and named everywhere else.
  const _rederivedCells = new Set<string>();
  if (_deferred.length > 0 && asyncDb) await _reduceDeferred(asyncDb);
  async function _reduceDeferred(
    asyncDb: NonNullable<typeof boot.asyncDb>,
  ): Promise<void> {
    const quarantined = getSyncReplayContext(asyncDb)?.quarantined;
    // A store another run saved without journalling may hold anything: a
    // store-persisted listener's reaction is held, never applied.
    const storeWm = storeSavedElsewhere
      ? Infinity
      : (journal ?? strayJournal)?.watermark() ?? 0;
    /** Listener → reactions held back. */
    const held = new Map<string, number>();
    let reduced = 0;
    for (const d of [..._deferred].sort((a, b) => a.ts - b.ts)) {
      if (quarantined?.has(d.cell)) continue;
      // A sync op, exactly as the live server dispatches it: the same
      // accept/refuse decision (a refusal discards this whole fold below).
      const action = {
        type: `${d.cell}:${d.action}`,
        payload: d.payload,
        _syncOp: true,
        _syncTs: d.ts,
        _syncId: d.id,
      };
      const was = state as Record<string, unknown>;
      let folded: Record<string, unknown> | undefined;
      let refusal: string | undefined;
      try {
        folded = unwrapReduced(
          (config.reduce as (
            s: S,
            a: { type: string; payload?: unknown },
          ) => S | { state: S })(state, action),
        ) as Record<string, unknown>;
        refusal = takeRejectionFor(action, d.cell)?.reason;
      } catch (e) {
        refusal = String(e);
      }
      if (refusal !== undefined || folded === undefined) {
        // The live server refuses such an op and deletes it (D11): so does
        // this boot — nothing acks it, and a resend meets the same decision.
        await asyncDb.execute("DELETE FROM sync_ops WHERE id = ?", [d.id]);
        log.warn(
          `sync: "${d.cell}"'s op ${d.id} was persisted but not yet ` +
            `committed when the server stopped, and its reduce is refused ` +
            `(${refusal}) — removed from the op-log and not acknowledged, ` +
            `as the live server does`,
        );
        continue;
      }
      const next = { ...was };
      for (const k of Object.keys(folded)) {
        if (folded[k] === was[k]) continue;
        if (k === d.cell) {
          next[k] = folded[k];
          continue;
        }
        // A quarantined listener's live state is not its data.
        if (quarantined?.has(k)) continue;
        const verdict = inFlightVerdict(
          syncCellIds.includes(k)
            ? { snapshotTs: await getCompactedTs(asyncDb, k) }
            : { storeWm },
          { ts: d.ts, intentSeq: d.intentSeq },
        );
        if (verdict === "held") {
          held.set(k, (held.get(k) ?? 0) + 1);
          continue;
        }
        next[k] = folded[k];
        _rederivedCells.add(k);
      }
      state = next as S;
      reduced++;
      // In the state this boot serves: its author's resend is a duplicate,
      // acknowledged (server-store.ts `settleOp`).
      await settleOp(asyncDb, d.id);
      _unmarked.push({ cell: d.cell, id: d.id, ts: d.ts });
    }
    if (reduced > 0) {
      log.info(
        `journal: reduced ${
          count(reduced, "sync op")
        } the crash caught between its persist and its commit${
          _rederivedCells.size > 0
            ? ` (with its listensTo reactions on ${
              [..._rederivedCells].join(", ")
            })`
            : ""
        }`,
      );
    }
    for (const [k, n] of held) {
      log.warn(
        `sync: "${k}": ${count(n, "listensTo reaction")} of the sync op${
          n === 1 ? "" : "s"
        } a crash caught between ` +
          `persist and commit held, not re-applied — ${
            syncCellIds.includes(k)
              ? `"${k}" was folded`
              : "the store was saved"
          } after the op was persisted, so it may already hold ${
            n === 1 ? "it" : "them"
          }; if not, ${n === 1 ? "it is" : "they are"} MISSING — check "${k}".`,
      );
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
  // A journal-off run over a journal a crash left: its op records are used
  // (above), and now it is moved aside BEFORE this run saves anything — then
  // the reactions this boot re-derived for its in-flight ops are saved (they
  // are in no journal). A kill between loses them unrecorded as in-flight;
  // the next journal-on boot names their op (no clean stop covers it).
  if (strayJournal && shouldPersist) {
    moveJournalAside(strayJournal, "journal-off", log);
    if (_rederivedCells.size > 0) {
      persistence.schedulePersist();
      await persistence.flushPersist();
      const sync = [..._rederivedCells].filter((k) => syncCellIds.includes(k));
      for (const k of sync) syncHandler?.noteServerWrite(k);
      if (sync.length > 0) await syncHandler?.flushServerWrites(sync);
    }
  }

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
    // The APP's door (`appDispatch`, below), not the raw loop: a tick that
    // names a `worker: true` cell's method has to reach that cell's worker.
    // Through the raw loop the MAIN isolate's composed reduce ran the method
    // body — off its thread, away from its module singletons, and onto a
    // slice the worker never saw, so the worker's next commit overwrote the
    // tick's write. For every other cell the two doors are the same call.
    (action) => appDispatch(action as A),
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

  function handleTTCommand(
    cmd: string,
    arg?: number,
  ): void | Promise<string | undefined> {
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
    // Only a MOVE replaces live state. `pause`/`resume` return a new TTState
    // (the flag) at the same position, and treating that as a jump rewound
    // live state to the last RECORDED entry — undoing every action
    // `skipActions` had let through since (they "dispatch, broadcast and
    // persist normally"), and journalling the rewind. Same position, same
    // entries: the flag changes, the state does not.
    const moved = tt.index !== prev.index || tt.entries !== prev.entries;
    const restored = moved ? stateAt(tt) : null;
    if (restored !== null) {
      const before = state;
      state = restored;
      // A worker cell's copy would otherwise keep mutating the state we just
      // discarded — re-seed it from the restored slice.
      _reseedWorkerCells();
      if (restored !== before) {
        _owedTo = _ttOwed;
        try {
          _recordTimeTravel(cmd, arg, before, restored);
          _jumpSyncCells(before, restored);
        } finally {
          _owedTo = null;
        }
      }
    }
    log.debug(
      `time-travel: ${cmd}${
        arg !== undefined ? ":" + arg : ""
      } → index ${tt.index}/${tt.entries.length - 1} paused=${tt.paused}`,
    );
    server.broadcastTT();
    server.broadcast();
    udsCtrl.broadcastFull();
    return _durableFor(_ttOwed);
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
  /** A slice as the store would write it (see the note in
   *  `_recordTimeTravel`); undefined when the store keeps none of it or the
   *  shaping threw (said, never silent). */
  /** Set when the last `_storedSlice` call's shaping THREW (not when the
   *  store just keeps none of the cell). */
  let _shapeThrew = false;
  function _storedSlice(cell: string, slice: unknown): unknown {
    _shapeThrew = false;
    try {
      return (getDBState({ [cell]: slice } as S) as
        | Record<string, unknown>
        | undefined)?.[cell];
    } catch (e) {
      _shapeThrew = true;
      // A shape that throws is the same failure the persist path reports
      // on its next write. Nothing is written for the cell — a journal
      // line must never carry what the store refused to.
      log.error(
        `journal: could not shape the "${cell}" slice the way the store ` +
          `writes it, so the journal line carries none of it — a replay ` +
          `leaves the cell where it is: ${
            e instanceof Error ? e.message : String(e)
          }`,
      );
      return undefined;
    }
  }

  /** What a jump owes before its reply (see `_durableFor`). */
  const _ttOwed = {};
  /** A jump moves SYNC cells too — their state is part of the restored tree
   *  — and a sync cell's state is durable only in its op-log and snapshot,
   *  neither of which a jump writes. So the jump went live (every tab showed
   *  it) and a restart put the cell back where the op-log left it: undo half
   *  applied (review rev9). A jumped sync cell is now a SERVER WRITE — the
   *  one path that makes a non-op change durable and pushes it to every
   *  client (`noteServerWrite`) — and under `journal: true` also a
   *  positional state line, exactly as a `listensTo` reaction is (the jump
   *  discards the cell's ops it rewinds past; later ops fold on top). */
  function _jumpSyncCells(before: S, after: S): void {
    const jumped = [..._syncCellSet].filter((c) =>
      (before as Record<string, unknown>)[c] !==
        (after as Record<string, unknown>)[c]
    );
    for (const c of jumped) syncHandler?.noteServerWrite(c);
    if (_syncJournal && jumped.length > 0) {
      _journalReaction(after, jumped, false, true);
    }
  }

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
      let withheld = false;
      for (
        const [cell, slice] of Object.entries(after as Record<string, unknown>)
      ) {
        // A sync cell recovers from its own op-log, never from the journal.
        if (_syncCellSet.has(cell)) continue;
        if (slice === null || typeof slice !== "object") continue;
        // A redacted cell's state goes in no sink — the store keeps the jump
        // (saved now, below), the journal does not.
        if (redact.redactsCell(cell)) {
          withheld = true;
          continue;
        }
        // WHAT THE STORE WOULD WRITE for this slice — the store's own getter,
        // not a second reading of the declaration. `persist` is TWO screens:
        // the include/exclude filter (dot paths included) and then
        // `onPersist`, which reshapes what goes to disk. Screening through
        // the flags map wrote `meta` whole for `exclude: ["meta.cache"]`;
        // screening through the filter alone still wrote the session token an
        // `onPersist` strips — the field the store has never once held, put
        // on disk by pressing undo. The replay side already asks this getter
        // (`_roundTripReplayedCells`); this is the write side asking it too.
        //
        // `persist: "none"` ⇒ nothing of this cell is stored, so the line
        // names it not at all; replay leaves such a cell where it is either
        // way.
        const kept = _storedSlice(cell, slice);
        if (kept !== undefined) {
          cells[cell] = kept as Record<string, unknown>;
        }
      }
      const restore: TimeTravelRestore = { ...ttPayload, cells };
      seq = _journalAppend({ type: TT_RESTORE_TYPE, payload: restore }, ts);
      if (withheld) _saveNow({ clock: "kv" });
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
  // …and the async body's own writes go through a door of its OWN call: a
  // write-set a shared userland queue (the p-queue shape) runs from ANOTHER
  // call's continuation carries that other call's scope, so its failed save
  // was owed to the wrong call and its author was acked as saved. Marked
  // here by identity first; the main door keeps a mark it finds. Same idea
  // as the worker host's per-`__exec` door (cell-worker-host.ts `callOf`).
  const _inCallScope = <T>(
    effect: unknown,
    fn: (call: string | undefined, sure?: boolean) => T,
  ): T => {
    const ef = effect as
      | { type?: unknown; payload?: { _callId?: unknown } }
      | null
      | undefined;
    const id = typeof ef?.type === "string" && ef.type.endsWith(":__exec")
      ? ef.payload?._callId
      : undefined;
    if (typeof id !== "string") return _outsideCall(() => fn(undefined));
    const outer = _nestedCall.get(id);
    _nestedCall.delete(id);
    const root = outer ?? id;
    // A top-level call is OPEN from here to its settlement (`_durableForCall`).
    if (outer === undefined) {
      if (_openCalls.size >= 1024) {
        _openCalls.delete(_openCalls.values().next().value!);
      }
      _openCalls.add(id);
    }
    // A nested call's root was read from the scope it was made in — a guess
    // (see `_sureOf`), so its body's door does not vouch for it either.
    return _callScope.run(root, () => fn(root, outer === undefined));
  };
  // …but a NESTED call (`await peer.m()`) is made through a cell handle, which
  // passes no call's door: it is named by the scope of whoever's continuation
  // runs it — the queue's drainer again. Nothing at that dispatch says which
  // call the job belongs to, so such an action's author is a guess, and a
  // failed save of it (or of the nested body's writes) is owed to the guess
  // AND to every call open right then (`_owe`): the author, if it can still
  // be told, is one of them. One-sided on purpose — an extra `unsaved`, never
  // a missing one.
  /** Actions whose author a call's own door named — known, not guessed. */
  const _sureOf = new WeakSet<object>();
  /** Top-level async calls whose body has started and not settled. */
  const _openCalls = new Set<string>();
  /** `app`, with a dispatch that names `call` as the action's author. */
  const _callDoor = <T extends { dispatch: (a: A) => unknown }>(
    app: T,
    call: string | undefined,
    sure = true,
  ): T =>
    call === undefined ? app : Object.create(app, {
      dispatch: {
        value: (a: A) => {
          if (a !== null && typeof a === "object") {
            _callBorn.set(a as object, call);
            if (sure) _sureOf.add(a as object);
          }
          return app.dispatch(a);
        },
      },
    });
  const afterActionHook = (prev: S, next: S, action: A): void => {
    if (action !== null && typeof action === "object") {
      _afterSeen.add(action as object);
    }
    _owedTo = action as object;
    try {
      // A sync op's marker and the reaction lines it causes land in ONE
      // write (see `SYNC_APPLIED_TYPE`): a kill between them would read as
      // "reduced, reactions lost", silently.
      if ((action as { _syncOp?: boolean })._syncOp && journal?.atomic) {
        _atomically(() => _afterAction(prev, next, action));
      } else _afterAction(prev, next, action);
    } finally {
      _owedTo = null;
    }
  };
  /** Run `fn` with its journal lines written in one write; a refused write
   *  loses them all, and is handled as every refused append is — reported,
   *  and each chain restarted, and the saves that stand in for the lines
   *  run now. */
  function _atomically(fn: () => void): void {
    const owed: SaveNow[] = [];
    _atomicOwed = owed;
    try {
      if (journal?.atomic) journal.atomic(fn);
      else fn();
    } catch (e) {
      _appendOk = false;
      _journalSaid.refused(e); // the owed saves below stand in for the lines
      _reactionChain.clear();
      _kvChain.clear();
      for (const w of owed) _saveNow(w);
    } finally {
      _atomicOwed = null;
    }
  }
  /** The saves the lines of the running `_atomically` block stand in for. */
  let _atomicOwed: SaveNow[] | null = null;
  const _afterAction = (prev: S, next: S, action: A): void => {
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
    // Before anything can return: a reduced sync op, even a no-op one —
    // unless its cell refused it.
    _markSyncApplied(action);
    if (prev === next) return; // no-op action — nothing to record
    const t = (action as { type?: string }).type ?? "";
    const ci = t.indexOf(":");
    const cell = ci >= 0 ? t.slice(0, ci) : "";
    const method = ci >= 0 ? t.slice(ci + 1) : t;
    // A `listensTo` reaction: ANOTHER sync cell changed inside this action's
    // reduce. It is not that cell's op (so not in its op-log), boot replay
    // re-folds only an op's own cell (replaySyncOps), and sync cells are out
    // of KV — so it is durable only once folded into the cell's own snapshot,
    // the same path every server-origin write takes (which also pushes it to
    // live clients). The action's own cell is handled just below.
    for (const c of _syncCellSet) {
      if (
        c !== cell &&
        (prev as Record<string, unknown>)[c] !==
          (next as Record<string, unknown>)[c]
      ) {
        _quarantinedWrite(c);
        syncHandler?.noteServerWrite(c);
      }
    }
    // How far this cell's live state holds its op-log — set at the commit of
    // each op, so a reaction journalled at any later instant knows exactly
    // which of the cell's ops it already contains (`SyncReaction.at`).
    // Honoured only on the sync handler's own op (`_syncOp`, which every
    // network door strips along with `_syncTs` — sanitizeClientAction): a
    // forged position must never move the mark.
    const isSyncOp = !!(action as { _syncOp?: boolean })._syncOp;
    const syncTs = (action as { _syncTs?: unknown })._syncTs;
    if (isSyncOp && typeof syncTs === "number" && _syncCellSet.has(cell)) {
      _appliedTs.set(cell, Math.max(_appliedTs.get(cell) ?? 0, syncTs));
    }
    // `listensTo` reactions that land on a DIFFERENT save clock than the
    // action's own line (a sync cell folds on its own; see `_syncJournal`) are
    // journalled AS DATA — see `_journalReaction`, appended after the
    // action's own line below. A sync op has no journal line at all, so every
    // reaction to one counts; a store-persisted cell reacting to a
    // store-persisted action rides that action's own line.
    const reacted = _syncJournal
      ? _reactedKeys(prev, next, cell).filter((k) =>
        isSyncOp || _syncCellSet.has(k) || _syncCellSet.has(cell)
      )
      : [];
    const multiClock = reacted.length > 0;
    if (_syncCellSet.has(cell)) {
      // A sync op is already durable in the op-log. Anything ELSE that
      // committed to a sync cell — an effect, cron, serverFn, a plain action,
      // an async method's `__set` batch — is durable NOWHERE (sync cells are
      // excluded from KV), so fold current state into the cell's sync
      // snapshot. Without this, a restart silently rewound every server-origin
      // write since the last compaction.
      if (method.startsWith("__") && !method.startsWith("__set")) return;
      if ((action as { _syncOp?: boolean })._syncOp) {
        // The op is durable in the op-log already; its LISTENERS' reactions
        // are in no log at all — journal them (as data, never the op).
        if (reacted.length > 0) _journalReaction(next, reacted, true);
      } else {
        _quarantinedWrite(cell);
        syncHandler?.noteServerWrite(cell);
        // …and the fold is up to 500 ms away, while the caller was acked NOW.
        // A SIGKILL inside that window lost every acked write in it — all 36
        // of them in a 300 ms burst — under the one option that exists to
        // prevent exactly that. So `journal: true` journals it like any other
        // write, by the cell's own watermark (see `_syncJournal`), and boot
        // replays it after the op-log restore. A refused append closes the
        // window by folding now (the fold noted just above is what it flushes).
        if (_syncJournal && _quarantinedSkip(cell)) {
          // No line for the quarantined cell itself — its reactions on
          // other cells are journalled as usual.
          _journalReaction(next, reacted, false);
        } else if (_syncJournal) {
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
            { clock: "sync", cell },
          );
          // …and the state it left, AT its op-log position. Replayed as a
          // call after the whole op-log, the write landed after ops the
          // server applied AFTER it: `clear` then an acked `add("new")`,
          // SIGKILL → boot folded `add` and then cleared it (the op row stays,
          // so the client never resends — for good). As data at `at`, boot
          // puts it back BETWEEN the ops (`seedSyncReactions`), and the call
          // line above — kept for `am timeline`/`am replay` — is covered by
          // it (its seq is below the data line's).
          _journalReaction(next, [cell, ...reacted], false, false, cell);
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
      ? _journalAppend(
        {
          type: t,
          payload,
          origin,
          user: (action as { _user?: AioUser })._user,
          cause,
          call,
        },
        ts,
      )
      : timeline.lastSeq() + 1;
    // A `persist: "none"` cell's call went in with its arguments withheld
    // and is not replayed (`JournalEntry.unstored`) — so what it wrote to
    // PERSISTED cells (a `listensTo` reaction, an `s.$call`) rides no call
    // line: it is journalled as data, the way a reaction to a sync op is.
    const owner = unstoredCellOf(t, payload, origin);
    const asData = journal?.unstored?.(owner)
      ? _reactedKeys(prev, next, owner).filter((k) =>
        !reacted.includes(k) && !_syncCellSet.has(k) &&
        !journal.unstored?.(k)
      )
      : [];
    if (journal && (multiClock || asData.length > 0)) {
      _journalReaction(next, [...reacted, ...asData], false);
    }
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
  // the write — by the clock that holds it (`_saveNow`).
  /** Whether the last `_journalAppend` reached the journal. */
  let _appendOk = true;
  // The journal's own health, for `/__aio/health`. The compensating flush
  // keeps the STATE on disk, so `persist.ok` stays true and is right to — but
  // a `journal: true` app whose every append is refused is paying a full
  // flush per action and has lost the promise the option was set for, and
  // nothing in the health document said so: an uptime monitor stayed green
  // through it. `after: 1` because there is no retry here — each refusal IS
  // a missing line, and the first one already broke the promise. Recovers
  // (and says so) on the next append that lands.
  const _journalKey = `journal:${resolveAppId(config.appId)}`;
  _quietDegraded(_journalKey); // its episodes are said by `_journalSaid`
  const _journalHealth = degraded(_journalKey, { after: 1 });
  // A refused append, said once per episode (`journalRefusals`): a program
  // holding the journal made every click two ERROR lines saying changes
  // "will be lost on restart" — while each was saved by the snapshot below.
  const _journalSaid = journalRefusals({
    path: () => journal?.path ?? "the journal",
    warn: (m) => log.warn(m),
    info: (m) => log.info(m),
    health: _journalHealth,
  });
  /** Journal what `listensTo` reactions WROTE, as data — never the action
   *  (re-running it on replay throws in an idempotency guard, and a build that
   *  predates this re-applied it to the op's own cell; external review rev1).
   *
   *  • A SYNC cell's reaction is its state at a POSITION in its op-log
   *    (`SYNC_REACTION_TYPE`, `at` = the last op of it the live state holds).
   *    Boot seeds the cell from the newest such line and folds only the ops
   *    above `at`, so the reaction lands between the cell's own ops where it
   *    happened live. An absolute slice applied AFTER the op-log instead
   *    rolled back every op acked after the reaction (review rev4).
   *  • A store-persisted cell's reaction is a time-travel line of its stored
   *    slice, marked `LISTENS_TO_CMD`: every write to such a cell is a
   *    journal line, so journal order IS its order.
   *
   *  Each line lives until its cell has saved it (`only`). Cost, only under
   *  `journal: true`: for a sync cell, what the reaction changed (a delta
   *  chain from a keyframe, see `SyncReaction` — a whole-slice line per
   *  reaction was 8× the op cost on a 2 MB listener, review rev7); for a
   *  store-persisted cell, its stored slice.
   *
   *  A REDACTED cell's state is never journalled (the journal is a sink like
   *  any other): its own save runs now instead (`_saveNow`). */
  /** A QUARANTINED sync cell gets no journal line: its log cannot fold, so
   *  its watermark never moves and the lines would never be compacted —
   *  one per op, forever, while boot refuses them anyway (and its writes
   *  cannot be made durable at all; boot said so). Said once per cell. */
  const _quarantineSaid = new Set<string>();
  /** Per quarantined cell: writes not said yet, when it last said, and the
   *  timer that says the rest. */
  const _quarantinedWrites = new Map<
    string,
    { n: number; at: number; timer?: ReturnType<typeof setTimeout> }
  >();
  /** A server-origin write (a plain call, an effect, a cron, a listener's
   *  reaction) to a quarantined sync cell: client ops are refused at the
   *  door, but this one already committed in memory — and its cell can save
   *  nothing (no fold, no journal line), so the next restart loses it. Owed
   *  as a refused save, so every door's ack carries it as `unsaved`, and said
   *  in the log: the first at once, the rest counted and said within 10 s. */
  function _quarantinedWrite(cell: string): void {
    if (!asyncDb || !getSyncReplayContext(asyncDb)?.quarantined.has(cell)) {
      return;
    }
    const why = `"${cell}" is quarantined (its op-log could not be folded ` +
      `at boot) — this write is applied in memory only and is lost on ` +
      `restart; fix its version/onMigrate and restart`;
    void _owe(Promise.resolve(`${PERSIST_REFUSED} ${why}`));
    const said = _quarantinedWrites.get(cell);
    const now = Date.now();
    if (said === undefined || now - said.at >= 10_000) {
      if (said?.timer !== undefined) clearTimeout(said.timer);
      const more = said?.n ? ` (and ${count(said.n, "earlier write")})` : "";
      _quarantinedWrites.set(cell, { n: 0, at: now });
      log.error(`sync: a write to ${why}${more}`);
      return;
    }
    said.n++;
    if (said.timer !== undefined) return;
    const timer = setTimeout(() => {
      _quarantinedWrites.set(cell, { n: 0, at: Date.now() });
      log.error(
        `sync: ${count(said.n, "more write")} to "${cell}" in the last 10 s ` +
          `applied in memory only — it is quarantined; they are lost on ` +
          `restart`,
      );
    }, said.at + 10_000 - now);
    said.timer = timer;
    Deno.unrefTimer(timer);
  }

  /** COMMIT(X) — a sync op on a listened action was REDUCED and not refused
   *  (journal.ts J1–J7). Written inside the op's `_atomically` block, so it and every
   *  reaction line of the op reach a reader together or not at all. */
  function _markSyncApplied(action: A): void {
    if (!_syncJournal) return;
    const a = action as {
      type?: string;
      _syncOp?: boolean;
      _syncTs?: unknown;
      _syncId?: unknown;
    };
    if (
      !a._syncOp || typeof a._syncTs !== "number" ||
      typeof a._syncId !== "string"
    ) return;
    const type = a.type ?? "";
    if (!_listenedTypes.has(type)) return;
    const c = type.slice(0, type.indexOf(":"));
    if (!_syncCellSet.has(c) || _quarantinedSkip(c)) return;
    // Reduced, and REFUSED by its own cell without a throw (a `validate`, a
    // guard): no commit. The commit is what the next boot takes as proof the
    // op was accepted — a kill before the refused row's delete then kept the
    // row, and its author's resend was acknowledged for an op in no state.
    // Uncommitted, the row is in flight (J4): that boot decides it again.
    if (hasRejectionFor(action, c)) return;
    _journalAppend(
      {
        type: SYNC_APPLIED_TYPE,
        payload: { cell: c, id: a._syncId, ts: a._syncTs },
        only: [c],
      },
      Date.now(),
      { clock: "sync", cell: c },
    );
  }

  /** INTENT(X) — see journal.ts J3: after the op's value is issued, before
   *  its row is inserted. A refused append is reported and the op goes on:
   *  the next boot finds it uncovered and names it (never re-derives it). */
  function _intendSyncOp(
    op: { id: string; cell: string; action: string },
    ts: number,
  ): void {
    if (!_listenedTypes.has(`${op.cell}:${op.action}`)) return;
    if (!_syncCellSet.has(op.cell) || _quarantinedSkip(op.cell)) return;
    try {
      journal!.append(
        {
          type: SYNC_INTENT_TYPE,
          payload: { cell: op.cell, id: op.id, ts },
          only: [op.cell],
        },
        Date.now(),
      );
      _journalSaid.landed();
    } catch (e) {
      _journalSaid.refused(e);
      reportAioError(
        createAioError("PERSIST_ERROR", e, { actionType: SYNC_INTENT_TYPE }),
        _reportOpts,
      );
    }
  }

  function _quarantinedSkip(cell: string): boolean {
    if (!asyncDb || !getSyncReplayContext(asyncDb)?.quarantined.has(cell)) {
      return false;
    }
    if (!_quarantineSaid.has(cell)) {
      _quarantineSaid.add(cell);
      log.warn(
        `journal: "${cell}" is quarantined — its writes are not journalled ` +
          `(they cannot be made durable until its log folds; fix its ` +
          `version/onMigrate and restart). Said once.`,
      );
    }
    return true;
  }
  function _journalReaction(
    next: S,
    reacted: readonly string[],
    bySyncOp: boolean,
    /** A time-travel jump's sync cells (`_jumpSyncCells`), not a reaction. */
    jump = false,
    /** The sync cell a server write changed: its line is the state that
     *  write left (`SyncReaction.write`), not a reaction. */
    wrote?: string,
  ): void {
    const cells: TimeTravelRestore["cells"] = {};
    const deltas: NonNullable<TimeTravelRestore["deltas"]> = {};
    const written: [string, unknown][] = [];
    let withheldKv = false;
    for (const k of reacted) {
      const slice = (next as Record<string, unknown>)[k];
      if (slice === null || typeof slice !== "object") continue;
      // A redacted cell's state is written to no diagnostic sink, and the
      // journal is one: made durable by its own save instead, now.
      if (_syncCellSet.has(k) && _quarantinedSkip(k)) continue;
      if (redact.redactsCell(k)) {
        if (_syncCellSet.has(k)) _saveNow({ clock: "sync", cell: k });
        else withheldKv = true;
        continue;
      }
      if (_syncCellSet.has(k)) {
        const link = _reactionChain.get(k);
        const at = _appliedTs.get(k) ?? 0;
        const payload: SyncReaction = link
          ? {
            cell: k,
            at,
            ops: diffState(link.state, slice),
            ...(link.snapshotAt !== undefined
              ? { baseSnapshotAt: link.snapshotAt }
              : { base: link.seq }),
          }
          : { cell: k, at, state: slice as Record<string, unknown> };
        // A fold in flight: its snapshot may land before the next line.
        const inFlight = _captured.get(k);
        if (inFlight !== undefined && !inFlight.lined) {
          inFlight.lined = true;
          if (link) {
            payload.alsoSnapshot = {
              at: inFlight.at,
              ops: diffState(inFlight.state, slice),
            };
          }
        }
        if (bySyncOp) payload.bySyncOp = true;
        if (jump) payload.jump = true;
        if (k === wrote) payload.write = true;
        _appendOk = true;
        const seq = _journalAppend(
          {
            type: SYNC_REACTION_TYPE,
            payload,
            only: [k],
            v: { [k]: config._cellVersions?.[k] ?? 0 },
          },
          Date.now(),
          { clock: "sync", cell: k },
        );
        // A line that did not land cannot be a base: the next one restarts.
        if (_appendOk) _reactionChain.set(k, { seq, state: slice });
        else _reactionChain.delete(k);
        continue;
      }
      const kept = _storedSlice(k, slice);
      if (kept === undefined) {
        // The shape threw: no line can carry it, and the store's own save
        // is the one that says so — owed, so the caller hears `unsaved`.
        if (_shapeThrew) withheldKv = true;
        continue;
      }
      const link = _kvChain.get(k);
      if (link) {
        deltas[k] = { base: link.seq, ops: diffState(link.stored, kept) };
      } else cells[k] = kept as Record<string, unknown>;
      written.push([k, kept]);
    }
    if (withheldKv) _saveNow({ clock: "kv" });
    if (written.length === 0) return;
    _appendOk = true;
    const seq = _journalAppend(
      {
        type: TT_RESTORE_TYPE,
        payload: {
          cmd: bySyncOp ? LISTENS_TO_SYNC_OP_CMD : LISTENS_TO_CMD,
          // Empty on purpose — see `TimeTravelRestore.keyframes`: an older
          // reader must find nothing here to apply.
          cells: {},
          ...(Object.keys(cells).length > 0 ? { keyframes: cells } : {}),
          ...(Object.keys(deltas).length > 0 ? { deltas } : {}),
        } satisfies TimeTravelRestore,
        only: written.map(([k]) => k),
      },
      Date.now(),
      { clock: "kv" },
    );
    for (const [k, kept] of written) {
      if (_appendOk) _kvChain.set(k, { seq, stored: kept });
      else _kvChain.delete(k);
    }
  }

  /** Make a write durable by its own save, NOW — for a line the journal
   *  did not take (a refused append, `_journalAppend`) or may not take (a
   *  redacted cell's state, `_journalReaction`/`_recordTimeTravel`). A sync
   *  cell's save is the fold of THAT cell (folding every pending cell would
   *  restart every other listener's reaction chain, see `SyncReaction`); a
   *  store-persisted cell's is the store's persist.
   *
   *  Coalesced PER CLOCK, never across them: one flag for both let a refused
   *  sync line's fold swallow the KV line's persist in the same burst, and
   *  the KV reaction was gone after a SIGKILL (review rev8). One save at a
   *  time per clock; a request landing while one runs re-runs it when it is
   *  done (a save reads state when it starts). */
  type SaveNow = { clock: "kv" } | { clock: "sync"; cell: string };
  const _saving = {
    sync: {
      tail: null as Promise<string | undefined> | null,
      queued: null as Promise<string | undefined> | null,
      cells: new Set<string>(),
    },
    kv: {
      tail: null as Promise<string | undefined> | null,
      queued: null as Promise<string | undefined> | null,
      cells: new Set<string>(),
    },
  };
  /** Resolves once `what` is durable — the caller's ack waits for it (see
   *  `_durableFor`). */
  /** Resolves once `what` is saved — with why it is NOT (the fold's error,
   *  the store's `lastCycleError()`), or undefined when it is. The caller's
   *  ack waits for it and carries a failure as `unsaved` (see `_durableFor`,
   *  action-ack.ts). */
  function _saveNow(what: SaveNow): Promise<string | undefined> {
    const f = _saving[what.clock];
    if (what.clock === "sync") {
      f.cells.add(what.cell);
      // A fold flushes only a cell with a write pending — and the line that
      // did not land may be the one a sync op's own cell owes (its reduced
      // mark, `SYNC_APPLIED_TYPE`), which no server write announced.
      syncHandler?.noteServerWrite(what.cell);
    }
    // A save that has not started yet reads the state when it does: it
    // covers this request too.
    if (f.queued !== null) return _owe(f.queued);
    const start = (): Promise<string | undefined> => {
      const cells = [...f.cells];
      f.cells.clear();
      // `flushPersist()` never rejects by contract — a refused cycle is
      // reported inside it and read back through `lastCycleError()`, which
      // is what `am persist` and `/__aio/health` answer with. So a rejection
      // HERE is a broken contract, not a refused write, and the one thing it
      // must not be is silent.
      const run: Promise<string | undefined> = what.clock === "sync"
        ? syncHandler!.flushServerWrites(cells)
        : persistence.flushPersist().then(() =>
          persistence.lastCycleError()?.message
        );
      return run.then(
        (why) => why === undefined ? undefined : `${PERSIST_REFUSED} ${why}`,
        (err) => {
          log.error(
            `journal: the save that stands in for a journal line threw — ` +
              `${err}. The verdict is still lastCycleError(); ask \`am ` +
              `persist\`.`,
          );
          return `${PERSIST_REFUSED} ${
            err instanceof Error ? err.message : String(err)
          }`;
        },
      );
    };
    // One save at a time per clock: behind the running one, never beside it.
    const p: Promise<string | undefined> = f.tail === null
      ? start()
      : f.tail.then(() => {
        f.queued = null;
        return start();
      });
    if (f.tail !== null) f.queued = p;
    f.tail = p;
    void p.finally(() => {
      if (f.tail === p) f.tail = null;
    });
    return _owe(p);
  }

  // ── What an ack waits for ────────────────────────────────────────────
  // A save that stands in for a journal line is a promise the CALLER is owed:
  // acked before it lands, a SIGKILL in between lost the write the ack
  // confirmed (review rev9: 1 in 48 under load). Each such save is owed to
  // the action whose commit asked for it, and to its async call (whose
  // caller hears at the method's end). ONE place waits for it for every
  // caller: `dispatch` (below) for an action, the call settlement
  // (`_onCallSettle`) for an async call — so a route, an effect or a
  // serverFn awaiting `cell.method()` waits exactly as a network ack does;
  // the sync handler waits for a `_syncOp` itself, parked (`durableFor`).
  // A save that failed reaches the caller as `unsaved` (action-ack.ts).
  /** The action whose afterAction is running (what `_saveNow` is owed to). */
  let _owedTo: object | null = null;
  // Sets: one save (coalesced per clock) answers many requests in one
  // action, and a spread-append per request was O(n²) for a long burst.
  const _owedByAction = new WeakMap<object, Set<Promise<string | undefined>>>();
  const _owedByCall = new Map<string, Set<Promise<string | undefined>>>();
  /** Actions afterAction has seen — `dispatch` knows at once whether one
   *  can still come to owe something. */
  const _afterSeen = new WeakSet<object>();
  function _owe(p: Promise<string | undefined>): Promise<string | undefined> {
    const a = _owedTo;
    if (a !== null) {
      const owed = _owedByAction.get(a) ?? new Set();
      _owedByAction.set(a, owed.add(p));
      const call = _callOf(a as A);
      // Its author's call — and, when the author is a guess (`_sureOf`),
      // every call open now.
      const calls = _sureOf.has(a) ? [call] : new Set([call, ..._openCalls]);
      for (const c of calls) {
        if (c === undefined) continue;
        if (_owedByCall.size >= 1024 && !_owedByCall.has(c)) {
          // Never silently: a call still waiting to be answered is told
          // its verdict is lost (action-ack.ts `_verdictLost`).
          const lost = _owedByCall.keys().next().value!;
          _owedByCall.delete(lost);
          _verdictLost(lost);
        }
        const byCall = _owedByCall.get(c) ?? new Set();
        _owedByCall.set(c, byCall.add(p));
      }
    }
    return p;
  }
  /** What must be durable before `action` may be acked — action-ack.ts
   *  `_durableFor`, over this run's owed saves. */
  function _durableFor(
    action: object,
  ): Promise<string | undefined> | undefined {
    return _durableForOwed(_owedByAction, action);
  }
  /** The same for an async call's settlement — its write-sets' saves. */
  function _durableForCall(callId: string): Promise<unknown> | undefined {
    _openCalls.delete(callId);
    const owed = _owedByCall.get(callId);
    _owedByCall.delete(callId);
    if (owed === undefined) return undefined;
    return _owedVerdict(owed).then((why) => {
      if (why !== undefined) _noteUnsaved(undefined, callId, why);
    });
  }
  const _offCallSettle = _onCallSettle(_durableForCall);
  bootUndo.push("call settle hook", _offCallSettle);

  /** Top-level keys an action's reduce changed, other than its own cell. */
  function _reactedKeys(prev: S, next: S, own: string): string[] {
    const p = prev as Record<string, unknown>;
    const n = next as Record<string, unknown>;
    const out: string[] = [];
    for (const k of Object.keys(n)) if (k !== own && p[k] !== n[k]) out.push(k);
    return out;
  }

  function _journalAppend(
    entry: Parameters<NonNullable<typeof journal>["append"]>[0],
    ts: number,
    // What makes this write durable without its journal line: the persist
    // flush for a KV cell, the fold for a sync cell (whose state the KV
    // snapshot does not hold, so a persist flush would close nothing).
    save: SaveNow = { clock: "kv" },
  ): number {
    try {
      const v = _journalVersions(entry.type, entry.payload, entry.origin);
      _atomicOwed?.push(save);
      const seq = journal!.append(v ? { ...entry, v } : entry, ts);
      _journalSaid.landed();
      return seq;
    } catch (e) {
      _appendOk = false;
      // Not a PERSIST_ERROR: the snapshot below saves this change now. Only
      // if THAT is refused is anything at risk — and persistence says so.
      _journalSaid.refused(e);
      _saveNow(save);
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
    const tt = payload as Partial<TimeTravelRestore> | undefined;
    const cells = type === TT_RESTORE_TYPE ? _ttStateCells(tt) : [
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
  const _dispatchCore = _setupDispatchCore();
  function _setupDispatchCore() {
    return setupDispatch<S, A, E>({
      reduce: withShapeGuard(reduce, _writeGuard, config._cellBreaker?.count),
      // Effects run inside the effect scope, so everything they dispatch — now,
      // or later from a timer, a promise or an async body they started — is
      // recorded as `cause: "effect"` (see `_effectScope`).
      execute: (app, e) =>
        _effectScope.run(
          true,
          () =>
            _inCallScope(
              e,
              (call, sure) => execute(_callDoor(app, call, sure), e),
            ),
        ),
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
          _effectScope.run(
            true,
            () => _outsideCall(() => ownManager.handle(e)),
          ),
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
  }
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
    // A call's own door (`_callDoor`) has named the author already; else the
    // scope the dispatch was made in.
    const named = action !== null && typeof action === "object"
      ? _callBorn.get(action as object)
      : undefined;
    const call = named ?? _callScope.getStore();
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
    const r = _dispatchCore(action);
    // Answered once what its commit owes is durable (see `_owe`) — for every
    // caller at once. A sync op is waited for by the sync handler, PARKED
    // under its cell's lock (server-handler.ts `_parked`); waiting here,
    // unparked, could deadlock two cells' ops on each other's folds.
    if (
      action === null || typeof action !== "object" ||
      (action as { _syncOp?: unknown })._syncOp === true ||
      (_afterSeen.has(action as object) && !_owedByAction.has(action as object))
    ) return r;
    const waited = r.then((v) => {
      const d = _durableFor(action as object);
      if (d === undefined) return v;
      return d.then((why) => {
        if (why !== undefined) _noteUnsaved(action as object, undefined, why);
        return v;
      });
    });
    // As handled as the promise it replaces: a refusal (paused, closing)
    // still rejects for whoever awaits, and is never an unhandled rejection
    // for a fire-and-forget caller (`_dispatchCore` marks its own the same).
    waited.catch(() => {/* aio-ok: the rejection is `r`'s, reported there */});
    return waited;
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
  _syncDispatchRef.durableFor = _durableFor;
  // Paused time travel drops every dispatch — for a sync op, that was a
  // PERMANENT op-rejected, and the client threw the op (a reconnecting
  // client's whole offline queue) away. It is HELD instead: not persisted,
  // not acked, answered with `sync-err`, which the client meets by retrying
  // its catch-up (pending ops included) every 2 s — so the ops land on
  // resume. Dev-only (time travel is), and the client says why each time.
  //
  // Same for a SHUTDOWN: dispatch closes first (the drain), the sockets last,
  // and an op arriving in between was refused for good — the client pruned
  // the edit, so every deploy/restart lost the edits in flight. Held, the
  // client keeps it and resends it to the next server.
  _syncDispatchRef.heldBecause = () =>
    tt?.paused === true
      ? "time travel is paused — sync ops are held (not applied, not " +
        "dropped) and resent until it resumes"
      : dispatch.phase() !== "open"
      ? "the server is shutting down — sync ops are held (not applied, not " +
        "dropped): the client keeps them and resends them to the next server"
      : undefined;

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
    // 0 / NaN / a negative reach startVitalsCheck, which says so and uses
    // the default (a silent `|| 1000` here hid them).
    const interval = (typeof diagResolvedOpts === "object" &&
        typeof diagResolvedOpts.vitals === "object"
      ? diagResolvedOpts.vitals.heartbeatInterval
      : undefined) ?? DEFAULT_HEARTBEAT_INTERVAL;
    _vitalsCheckTimer = startVitalsCheck({
      vitalsSystem,
      heartbeatInterval: interval,
      dispatch,
      getState: () => state,
      ...(config._cellHealth ? { cellHealth: config._cellHealth } : {}),
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
      {
        roleOf: (id) => userStore?.get(id)?.role ?? null,
        maxPerUser: authOpts.maxSessions,
      },
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
  const workerPool = _createWorkerPool();
  function _createWorkerPool() {
    return createCellWorkerPool({
      // The SAME resolved value the main isolate uses and the boot line
      // prints — one decider, so a worker cell is never freeze-checked more
      // loosely than a local one.
      freezeState: freezeEnabled,
      // …and the SAME `refusalsReject` the composed reduce was given, for the
      // same reason: it decides what an in-process `await cell.method()` sees
      // when the reduce refuses the write, and a worker that never learned it
      // answered its callers differently from the cell sitting next to it.
      refusalsReject: config._refusalsReject === true,
      // …and the SAME supervision of a stray rejection (see initDiagAndVitals
      // above): a worker cell survives what the main isolate survives.
      guardRejections: config.guardDispatches ?? true,
      // …and the dev refusal of a declared-type change, which a worker cell's
      // reduce must run itself (the owner sees only its committed patches).
      ...(boot.strictTypeFilter
        ? { strictTypeFilter: boot.strictTypeFilter }
        : {}),
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
      // The main door's paused-time-travel refusal, for calls routed around it.
      isPaused: () => tt?.paused === true,
      // A worker cell's INIT_ERROR / EFFECT_ASYNC_ERROR reaches the app's
      // `onError` exactly as the same cell's does on this isolate.
      reportError: (err) => reportAioError(err, _reportOpts),
      // …and counts toward the app's `circuitBreaker`, as it does there.
      ...(config._cellBreaker ? { breaker: config._cellBreaker } : {}),
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
  }
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
    // A clone failure is the call's REJECTION, as `postMessage`'s is on the
    // real bridge (cell-worker.ts `call`) — a synchronous throw out of here
    // escaped every door's ack: a WS caller whose `_user` could not be cloned
    // waited out its ceiling with no answer, where the real worker refused it
    // at once by name.
    let sent: A;
    try {
      sent = _cloneAcrossWorkerBoundary(a, "action payload", cellId) as A;
    } catch (e) {
      return Promise.reject(e);
    }
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
      // see `_workerUserCalls`. The same user the worker's method itself runs
      // under: the action's `_user` stamp, never the ambient (cell-worker.ts
      // `ambient`) — a server-origin call inside some user's scope is
      // anonymous there, as it is in-isolate.
      const user = (a as { _user?: unknown })._user;
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

  const { shutdown: _shutdownRuntime } = _createShutdown();
  function _createShutdown() {
    return createShutdownOrchestrator({
      sessionStore,
      userStore,
      flushPersist: async () => {
        await persistence.flushPersist();
        // Sync cells' server-origin writes debounce into their snapshot — a
        // clean exit must not leave the last write inside that window.
        const unfolded = await syncHandler?.flushServerWrites();
        // What a clean stop covers: every value this run issued (input is
        // closed by now) — read AFTER the folds, which take values of their
        // own, so the next run's first value continues the range. Only a run
        // that SAVES: with persist off no store holds a store-persisted
        // listener's reactions, so there is nothing to vouch for.
        const cleanTo = asyncDb && shouldPersist && _cleanRunFrom !== undefined
          ? await issuedThrough(asyncDb).catch(() => undefined)
          : undefined;
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
        } else if (
          !unfolded && cleanTo !== undefined && _cleanRunFrom !== undefined &&
          asyncDb
        ) {
          // Every record is saved: say so, for the next boot (`CLEAN_STOP_ROW`).
          await recordCleanStop(asyncDb, _cleanRunFrom, cleanTo).catch((e) =>
            log.warn(`shutdown: could not record the clean stop — ${e}`)
          );
        }
        if (!failed && shouldPersist) {
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
      // In the orchestrator's own sequence (after onStopping, before dispatch
      // closes) — so no shutdown path can skip it or run it out of order.
      closeWorkers: () => workerPool.close(),
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
  }

  /** The worker threads stop INSIDE the orchestrator's sequence
   *  (`closeWorkers`: after `onStopping`, before dispatch closes), and the
   *  order is load-bearing rather than incidental.
   *
   *  A worker's in-flight methods live in its own isolate, so Phase 1's
   *  `abortAllInflight` cannot see them; the worker host runs its own
   *  abort + settle on the `close` message and streams the final writes home as
   *  patches, which the ack cannot overtake (FIFO). Those writes arrive as
   *  ordinary dispatches — so they must land while dispatch is still OPEN,
   *  i.e. before the orchestrator closes it and takes the final snapshot.
   *  Closing the pool after the runtime would silently drop exactly the writes
   *  the worker just drained to produce; closing it BEFORE `onStopping` (as
   *  this did until 1.0.11) refused the worker-cell calls that hook exists to
   *  make; and a path that skipped it (the update handover) let worker-cell
   *  calls start new work for the whole drain.
   *
   *  `tests/shutdown-worker-cell-durability.test.ts` pins this end to end with
   *  a real worker (libraryMode runs worker cells in-isolate, so an in-process
   *  test cannot reach this path). */
  /** Aborted when this app's shutdown begins — see `shutdown`. */
  const _stopCtl = new AbortController();
  const shutdown = async (): Promise<void> => {
    // FIRST, before anything awaits: boot steps still in flight (the Electron
    // launch) read this and refuse to start what the shutdown would miss.
    _stopCtl.abort();
    await _shutdownRuntime(); // closes the worker cells too (`closeWorkers`)
    _offCallSettle();
    // A closed app owns nothing: release THIS app's cells so they can bind
    // again. Without it a cell def stayed claimed for the life of the process,
    // so two `testServer()` blocks in one file failed with "already bound" even
    // with `await using` — the second test had to move to its own file for no
    // visible reason. Scoped to our own cells, so a second app in
    // the same process is untouched.
    // The closed worker cells' reasons ride along as plain data: released,
    // they keep answering by name, as the closed pool does.
    const release = (app as Record<string, unknown>)._releaseCells as
      | ((closedWorkers: Record<string, string | null>) => void)
      | undefined;
    release?.(workerPool.closedBy());
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

  const app = _buildApp();
  function _buildApp() {
    return buildAppObject<S, A>({
      dispatch: appDispatch,
      getState: () => state,
      // Only a snapshot load replaces state through here. Journalled as the
      // state it put in place, in the same turn, exactly like a time-travel
      // jump: the load only SCHEDULES a persist, so an action acked on the
      // loaded state and a crash inside the debounce replayed that action onto
      // the PRE-load database (5, load 1000, deposit(1), SIGKILL → 6).
      // tests/journal-snapshot-load-crash.test.ts.
      // …and its SYNC cells as a server write, as a jump's are: a sync cell is
      // durable only in its op-log and fold snapshot, which the scheduled KV
      // persist never writes — so `am snapshot load` answered "loaded" and a
      // restart brought back the writes it undid.
      // tests/snapshot-load-sync-cell-durable.test.ts.
      setState: (s) => {
        const before = state;
        state = s;
        if (s !== before) {
          _recordTimeTravel("snapshot", undefined, before, s);
          _jumpSyncCells(before, s);
        }
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
  }

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
  // Per-user credentials (users / resolveUser / sessions / auth:true) and the
  // shared app key are mutually exclusive — an app in per-user mode never
  // authenticates anyone with `app.key`.
  //
  // `sessions: true` ALONE counts: server.ts resolves every request through
  // the session store and that path always returns, so a key there can only
  // 401. Left out, an exposed sessions-only app was defaulted to `key: true`
  // and printed a share link and a pair code that let nobody in.
  const _sessionsOnly = !!sessionStore && !authEnabled;
  const _perUserAuth = !!users || !!_resolveUser || !!sessionStore;
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
  const _keyRes = (expose && !users && !_resolveUser && !_sessionsOnly)
    ? resolveAppKey(appId, _effKey)
    : { key: undefined, persisted: false, explicit: false };
  // An explicit key the per-user gate can never consult. It used to be
  // resolved and ADVERTISED (share link, pair code) for a sessions-only app,
  // and ignored without a word next to `users`/`resolveUser` — say so instead.
  if (
    expose && _cfgKey !== undefined && _cfgKey !== false &&
    (users || _resolveUser || _sessionsOnly)
  ) {
    log.warn(
      `\`key\` is ignored: this app authenticates per user (${
        users ? "users" : _resolveUser ? "resolveUser" : "sessions"
      }), and that gate never consults a shared app key. Drop \`key\`, or ` +
        `drop per-user auth and share the key.`,
    );
  }
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

  // A boot over an older build's data re-derived what that build never
  // recorded (the reactions of its sync ops). Written down NOW, before any
  // input — as stamped state lines and then the marker that retires the old
  // tail, or (no journal) by saving the store and folding each changed sync
  // cell. Only then is the store stamped as this build's: a crash before
  // that re-derives again, from the same data.
  // Every op this boot placed (see `_unmarked`) is committed now, before any
  // input — in ONE line with the reaction lines this boot re-derived for the
  // in-flight ones (journal.ts J1): a kill between would read as "covered"
  // next boot with the reactions nowhere. Over a legacy tail the same line
  // carries the recovery's state lines and marker (below).
  const _commitPlaced = (): void => {
    for (const { cell, id, ts } of _unmarked) {
      _journalAppend(
        { type: SYNC_APPLIED_TYPE, payload: { cell, id, ts }, only: [cell] },
        Date.now(),
        { clock: "sync", cell },
      );
    }
    if (_rederivedCells.size > 0) {
      _journalReaction(state, [..._rederivedCells], true);
    }
  };
  if (_unmarked.length > 0 && journal && _legacyBoot === null) {
    _atomically(_commitPlaced);
  }
  if (journal) {
    for (const k of _rederivedCells) {
      if (_syncCellSet.has(k)) syncHandler?.noteServerWrite(k);
    }
  }
  let _legacySaved = true;
  // An older build's crashed tail (`_legacyBoot`): its CALLS were replayed
  // above, their reactions with them — on a sync listener, in no fold yet.
  // Written down now, before any input, as stamped state lines closed by
  // the marker that retires the old lines (see `LEGACY_RECOVERED_TYPE`).
  if (_legacyBoot !== null && asyncDb && journal) {
    const was = _legacyBoot as Record<string, unknown>;
    const now = state as Record<string, unknown>;
    const changed = Object.keys(now).filter((k) =>
      // OWN keys: an undeclared slice named `constructor`/`toString` is
      // "in" every plain object, and was replayed as a declared cell.
      Object.hasOwn(initialState as Record<string, unknown>, k) &&
      now[k] !== was[k]
    );
    for (const c of syncCellIds) {
      const { rows } = await asyncDb.query<{ ts: number | null }>(
        "SELECT MAX(server_ts) AS ts FROM sync_ops WHERE cell = ?",
        [c],
      );
      _appliedTs.set(c, rows[0]?.ts ?? 0);
    }
    _appendOk = true;
    // ONE line (J1): the commits of the ops this boot placed, the state it
    // recovered, and the marker — a kill that kept the commits without the
    // rest would read as "this build's data, covered" next boot, with the
    // recovered state in no record.
    _atomically(() => {
      _commitPlaced();
      if (changed.length > 0) _journalReaction(state, changed, false);
      _journalAppend(
        {
          type: LEGACY_RECOVERED_TYPE,
          payload: { cells: changed },
          only: Object.keys(initialState as Record<string, unknown>),
        },
        Date.now(),
      );
    });
    _legacySaved = _appendOk;
    if (_legacySaved) {
      log.info(
        `journal: recorded the state this boot recovered from the older ` +
          `build's journal (${changed.join(", ") || "nothing changed"})`,
      );
    }
  }
  // This op-log is now this build's: its reactions are recorded from here
  // on. Never over a legacy recovery that did not land — the next boot
  // recovers again, from the same data.
  if (_legacySaved && asyncDb && syncCellIds.length > 0) {
    await stampReactions(
      asyncDb,
      _marking ? REACTIONS_MARKED : REACTIONS_FORMAT,
    );
  }

  // From here every op on a listened action journals its intent before its
  // row (journal.ts J3) — installed before the transport takes any input.
  if (_marking) syncHandler!.setOpIssueHook?.(_intendSyncOp);

  // Resolved BEFORE the transport is set up so an invalid `tls` shape fails at
  // boot, where it can name the config key, not at the first handshake.
  const _tls = _tlsOf(config as { tls?: AioConfig<S, A, E>["tls"] });
  const transport = await _setupTransport();
  async function _setupTransport() {
    return setupTransport<S, A>({
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
          publicDir: authOpts.publicDir,
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
      //
      // …and an action that came in through a network door has no call for an
      // author — no call's continuation made it. Known, not guessed (`_sureOf`):
      // its failed save is its own ack's, not every open call's.
      dispatch: (action) => {
        if (action !== null && typeof action === "object") {
          _sureOf.add(action as object);
        }
        return appDispatch(action as A);
      },
      closing: () => dispatch.phase() !== "open",
      app: {
        snapshot: () => app.snapshot!(),
        loadSnapshot: (json, opts) => app.loadSnapshot!(json, opts),
      },
      blobs: blobStore,
      vitalsSystem,
      costMeter,
      useElectron,
      tt: tt
        ? { handleTTCommand, getTTBroadcast: () => toBroadcast(tt!) }
        : null,
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
      // `am persist --drop`: an undeclared stored cell out of every future
      // write — and out of `am migrations`' drift list, which said it was
      // still stored.
      dropStoredCell: (cell: string) => {
        const r = persistence.dropOrphanCell?.(cell) ?? [];
        if (r === true && migrationSummary) {
          migrationSummary.drift = migrationSummary.drift.filter((d) =>
            !(d.cell === cell && d.issue === "unknown-cell")
          );
        }
        return r;
      },
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
  }

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
      argv: ownReplayArgs(),
      snapshot: _snapshotDb,
      // The app's ONE shutdown — not the orchestrator alone, which is what
      // this was, and the worker pool was never closed on an update. NOT
      // swallowed: a rejection reaches `deferHandOver`, which logs "update
      // handover FAILED" and exits without relaunching onto a half-stopped
      // app — the rule `aio.restart()` follows. A `.catch(() => {})` here made
      // that line unreachable and the failed shutdown silent.
      shutdown,
      prompt: ttyPrompt(),
      slot: _appSlots.get(config)?.updates,
    })
    : undefined;

  // macOS: a desktop app opened from its disk image or from Downloads offers,
  // once, to move itself into Applications (macos-move.ts). Un-awaited on
  // purpose: the app is up, and a question must never hold it.
  if (
    Deno.build.os === "darwin" && isCompiled() && !config.libraryMode &&
    clientOf(cli, config).value === "electron"
  ) {
    void offerMoveToApplications({
      title,
      dataDir: _dirs.data,
      argv: ownReplayArgs(),
      log,
      shutdown: () => shutdown(),
      stopSignal: _stopCtl.signal,
      // A page has connected, so the window exists; then a moment more, for
      // it to have checked in with the window server.
      windowUp: async () => {
        for (let waited = 0; clientCounter.value === 0; waited += 500) {
          if (waited >= 300_000) return false;
          await new Promise((r) => setTimeout(r, 500));
        }
        await new Promise((r) => setTimeout(r, 3000));
        return true;
      },
    });
  }

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
        // …and the disk gate: a report is written to disk, so what a cell
        // keeps off disk (`persist: "none"`, `persist: { exclude }`) stays
        // out of it — the rule the dev checkpoint already reads.
        _persistFilters: config._cellPersist,
        getTimeline: () => timeline.entries(),
      },
    })
    : undefined;

  // Lifecycle: globals, onStart, schedules, logging, client launch
  await _startLifecycle();
  async function _startLifecycle(): Promise<void> {
    return startLifecycle({
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
          value: entryPathOf(Deno.mainModule),
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
          ? (typeof config.journal === "string"
            ? config.journal
            : _dirs.journal)
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
      //
      // Worker cells' `onInit` runs in THEIR isolate, started here — beside the
      // main cells' and no earlier: a patch it dispatches is applied through
      // this isolate's dispatch, whose broadcast is wired only now. Posted
      // BEFORE the main `onInit`s, so a main cell calling a worker cell from its
      // own `onInit` reaches one that has already initialised (per-worker FIFO).
      onStart: onStart || workerPool.size > 0
        ? ((a: Parameters<NonNullable<typeof onStart>>[0]) => {
          workerPool.start();
          if (onStart) return _effectScope.run(true, () => onStart(a));
        })
        : undefined,
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
      wire: config.wire,
      keepServer: config.keepServer,
      setElectronProc: (proc) => {
        _electronProc = proc;
      },
      stopSignal: _stopCtl.signal,
      // The update this boot judged, told what the window's start did.
      window: !config.libraryMode && _appSlots.get(config)
        ? updateWindow(
          _dirs.data,
          log,
          _appSlots.get(config)!.window,
          ownReplayArgs(),
        )
        : undefined,
      setDiscoveryStop: (stop) => {
        discoveryRef.stop = stop;
      },
      appLock,
      log,
    });
  }

  // Whatever was pending has booted far enough to SERVE. It is confirmed —
  // so a later boot does not roll back a version that works — by `run()`,
  // once the APP's `onStart` has come through too: that hook fires after
  // this returns, and a build that died in it was confirmed first and never
  // rolled back (measured on a real AppImage update). "Healthy" used to mean
  // "bound a socket", which a build that fails to open its window or dies in
  // a schedule passes without doing anything an app is for.
  const slot = _appSlots.get(config);
  if (!config.libraryMode && slot) {
    slot.confirm = pendingConfirmer(
      _dirs.data,
      log,
      resolveKeepOld(config.updates),
    );
  }

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

/** What `--aio-electron-runtime` prints: the `electron.json` the build baked
 *  into the binary's dist/, read where boot reads its dist from. */
export async function electronRuntimeAnswer(): Promise<
  | {
    runtime: "bundled" | "shared";
    version: string;
    sha256?: string;
    /** The client this binary boots in, when the build baked one (an online
     *  binary that is not the desktop package): the updater fetches no
     *  Electron for a browser-default binary. */
    client?: string;
  }
  | { runtime: "none" }
> {
  for (
    const dir of distCandidates({
      mainModule: Deno.mainModule,
      cwd: Deno.cwd(),
      execDir: dirname(Deno.execPath()),
      moduleDir: import.meta.dirname ?? null,
    })
  ) {
    const version = await bakedElectronVersion(dir);
    if (version) {
      // The checksum this build pinned for THIS machine's runtime zip: the
      // updater downloads the new version's Electron against it.
      const sha256 = await bakedRuntimeSha(dir, electronSlug());
      const client = await bakedElectronClient(dir);
      return {
        runtime: await bakedElectronRuntime(dir),
        version,
        ...(sha256 ? { sha256 } : {}),
        ...(client ? { client } : {}),
      };
    }
  }
  return { runtime: "none" };
}
