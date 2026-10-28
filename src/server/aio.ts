import { checkPeerTypes } from "./peer-describe.ts";
import "immer"; // load order: evaluated here, as before the split
import { inheritedParentEnv } from "./process-liveness.ts";
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
import { registerRuntime } from "./shutdown.ts";
import { _registerAuthStore } from "./auth-context.ts";
import type { ServerHandle } from "./server-types.ts";
import type { UDSHandle } from "./uds.ts";
import {
  createTT,
  record,
  toBroadcast,
  type TTState,
} from "../diagnostics/time-travel.ts";
import { createScheduleManager } from "../state/schedule.ts";
import { createOwnManager } from "../state/own.ts";
import "../state/framework-cells.ts"; // load order: evaluated here, as before the split
import "../state/route-effect.ts"; // load order: evaluated here, as before the split
import { notifyCrossUserGate } from "./aio-dispatch.ts";
import { log } from "../diagnostics/logger-api.ts";
import { timeTravelEnabled } from "../diagnostics/types.ts";
import "../diagnostics/error.ts"; // load order: evaluated here, as before the split

// Phase modules — extracted _run() logic
import {
  bootStorage,
  getSyncReplayContext,
  moveJournalAside,
  stampReactions,
} from "./aio-boot.ts";
import "../sync/server-store.ts"; // load order: evaluated here, as before the split
import "./store-gen.ts"; // load order: evaluated here, as before the split
import "./op-placement.ts"; // load order: evaluated here, as before the split
import "../state/rejection-tracker.ts"; // load order: evaluated here, as before the split
import "../state/declared-shape-guard.ts"; // load order: evaluated here, as before the split
import "../sync/state-patch.ts"; // load order: evaluated here, as before the split
import "../state/deep-merge.ts"; // load order: evaluated here, as before the split
import { unpersistedFromBase } from "../state/cell-persist-filter.ts";
import {
  type ActionCause,
  beginReplaySession,
  isLegacyTail,
  journalRefusals,
  LEGACY_RECOVERED_TYPE,
  REACTIONS_FORMAT,
  REACTIONS_MARKED,
  SYNC_APPLIED_TYPE,
  type TimeTravelRestore,
  TT_RESTORE_TYPE,
  workerPatchCell,
} from "./journal.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { createTimeline } from "./timeline.ts";
import { makeRedactor } from "../diagnostics/redact.ts";
import { _quietDegraded, degraded } from "../diagnostics/degraded.ts";
import "../diagnostics/action-kind.ts"; // load order: evaluated here, as before the split
import "./aio-dispatch.ts"; // load order: evaluated here, as before the split
import "./cell-worker-host.ts"; // load order: evaluated here, as before the split
import "./cell-worker-pool.ts"; // load order: evaluated here, as before the split

import { validateSchedules } from "../state/schedule.ts";
import "./heap-policy.ts"; // load order: evaluated here, as before the split
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
  ensureAppDirs,
  homeRequested,
  registerAppDirs,
  registeredProfile,
  resolveAppDirs,
} from "./app-dirs.ts";
import { openBlobStore } from "./blobs.ts";
import { adoptHiddenConsole } from "./no-console.ts";
import "./paths.ts"; // load order: evaluated here, as before the split
import { carriedPort } from "./dev-restart.ts";
import "./app-dirs-migrate.ts"; // load order: evaluated here, as before the split
import "../state/dispatch.ts"; // load order: evaluated here, as before the split
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
} from "./action-ack.ts";
import "./server-trojan.ts"; // load order: evaluated here, as before the split
import { _moveRejections } from "../state/rejection-tracker.ts";
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
import { buildChannel, judgeKeepOld, resolveKeepOld } from "./updates-core.ts";
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
import {
  isWeakToken,
  WEAK_TOKEN_MIN_BITS,
  WEAK_TOKEN_MIN_CHARS,
} from "./server-auth.ts";
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
  ResolvePeerFn,
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
import "../diagnostics/fmt.ts"; // load order: evaluated here, as before the split
import "../diagnostics/diagnostics-optout.ts"; // load order: evaluated here, as before the split
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
import * as configSteps from "./boot-config.ts";
import * as storageSteps from "./boot-storage.ts";
import * as dispatchSteps from "./boot-dispatch.ts";
import {
  type BootCtx,
  liveCtx,
  type SaveNow,
  type StepArgs,
} from "./boot-ctx.ts";

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
  // The locals the moved-out steps use, live — see boot-ctx.ts.
  const ctx: BootCtx<S, A, E> = liveCtx<BootCtx<S, A, E>>({
    _electronProc: [() => _electronProc, (v) => (_electronProc = v)],
    initialState: () => initialState,
    config: () => config,
    cli: () => cli,
    appId: () => appId,
    _heapLine: [() => _heapLine, (v) => (_heapLine = v)],
    _stampDataDir: [() => _stampDataDir, (v) => (_stampDataDir = v)],
    _dirs: () => _dirs,
    port: () => port,
    releaseFileSizeGuard: () => releaseFileSizeGuard,
    appLock: () => appLock,
    VERBOSE: () => VERBOSE,
    distDir: [() => distDir, (v) => (distDir = v)],
    prod: [() => prod, (v) => (prod = v)],
    redact: () => redact,
    diagHooks: () => diagHooks,
    vitalsSystem: () => vitalsSystem,
    reduce: () => reduce,
    execute: () => execute,
    onAction: () => onAction,
    onEffect: () => onEffect,
    onStopping: () => onStopping,
    onStop: () => onStop,
    shouldPersist: () => shouldPersist,
    dbPath: () => dbPath,
    getDBState: () => getDBState,
    syncCellIds: () => syncCellIds,
    state: [() => state, (v) => (state = v)],
    tt: [() => tt, (v) => (tt = v)],
    _reportOpts: () => _reportOpts,
    boot: () => boot,
    kvDb: () => kvDb,
    asyncDb: () => asyncDb,
    persistence: () => persistence,
    journal: () => journal,
    syncHandler: () => syncHandler,
    strayJournal: () => strayJournal,
    storeSavedElsewhere: () => storeSavedElsewhere,
    journalHeld: () => journalHeld,
    migrationSummary: () => migrationSummary,
    schedulePersist: () => schedulePersist,
    _legacyBoot: [() => _legacyBoot, (v) => (_legacyBoot = v)],
    _marking: () => _marking,
    _listenedTypes: () => _listenedTypes,
    _deferred: () => _deferred,
    _unmarked: () => _unmarked,
    _retireForeign: () => _retireForeign,
    _cleanRunFrom: [() => _cleanRunFrom, (v) => (_cleanRunFrom = v)],
    _keepUnpersistedFields: () => _keepUnpersistedFields,
    _roundTripReplayedCells: () => _roundTripReplayedCells,
    _restartedSlice: () => _restartedSlice,
    _restoreStoredSlice: () => _restoreStoredSlice,
    _ttStateCells: () => _ttStateCells,
    _keepJournalCopy: () => _keepJournalCopy,
    _warnUnstampedAcrossMigration: () => _warnUnstampedAcrossMigration,
    _rerunRestoreHooks: () => _rerunRestoreHooks,
    _isRecord: () => _isRecord,
    _unpersistedFromBoot: () => _unpersistedFromBoot,
    _quarantinedTail: () => _quarantinedTail,
    _refuseJournalAcrossGap: () => _refuseJournalAcrossGap,
    _syncJournal: () => _syncJournal,
    _appliedTs: () => _appliedTs,
    _reactionChain: () => _reactionChain,
    _captured: () => _captured,
    _kvChain: () => _kvChain,
    _foldedAt: () => _foldedAt,
    _rederivedCells: () => _rederivedCells,
    ttSkipActions: () => ttSkipActions,
    server: () => server,
    udsHandle: () => udsHandle,
    _vitalsCheckTimer: () => _vitalsCheckTimer,
    scheduleManager: () => scheduleManager,
    ownManager: () => ownManager,
    udsCtrl: () => udsCtrl,
    onPerf: () => onPerf,
    _reseedWorkerCells: () => _reseedWorkerCells,
    _shapeThrew: [() => _shapeThrew, (v) => (_shapeThrew = v)],
    _storedSlice: () => _storedSlice,
    _ttOwed: () => _ttOwed,
    _jumpSyncCells: () => _jumpSyncCells,
    _recordTimeTravel: () => _recordTimeTravel,
    _diagAfterAction: () => _diagAfterAction,
    _syncCellSet: () => _syncCellSet,
    timeline: () => timeline,
    _effectScope: () => _effectScope,
    _causeOf: () => _causeOf,
    _outsideCall: () => _outsideCall,
    _callOf: () => _callOf,
    _inCallScope: () => _inCallScope,
    _sureOf: () => _sureOf,
    _openCalls: () => _openCalls,
    _callDoor: () => _callDoor,
    _isDisableReset: () => _isDisableReset,
    afterActionHook: () => afterActionHook,
    _atomicOwed: () => _atomicOwed,
    _appendOk: [() => _appendOk, (v) => (_appendOk = v)],
    _journalSaid: () => _journalSaid,
    _quarantinedWrites: () => _quarantinedWrites,
    _quarantinedWrite: () => _quarantinedWrite,
    _markSyncApplied: () => _markSyncApplied,
    _quarantinedSkip: () => _quarantinedSkip,
    _journalReaction: () => _journalReaction,
    _saving: () => _saving,
    _saveNow: () => _saveNow,
    _owedTo: [() => _owedTo, (v) => (_owedTo = v)],
    _owedByAction: () => _owedByAction,
    _owedByCall: () => _owedByCall,
    _owe: () => _owe,
    _durableFor: () => _durableFor,
    _offCallSettle: () => _offCallSettle,
    _reactedKeys: () => _reactedKeys,
    _journalAppend: () => _journalAppend,
    _journalVersions: () => _journalVersions,
    _notifyCrossUser: () => _notifyCrossUser,
    _writeGuard: () => _writeGuard,
    dispatch: () => dispatch,
    freezeEnabled: () => freezeEnabled,
    discoveryRef: () => discoveryRef,
    sessionStore: () => sessionStore,
    userStore: () => userStore,
    _unregisterAuthStore: () => _unregisterAuthStore,
    _workerEntry: () => _workerEntry,
    _hostWorkers: () => _hostWorkers,
    _workerUserCalls: () => _workerUserCalls,
    workerPool: () => workerPool,
    appDispatch: () => appDispatch,
    _shutdownRuntime: () => _shutdownRuntime,
    _stopCtl: () => _stopCtl,
    shutdown: () => shutdown,
    _unregisterRuntime: () => _unregisterRuntime,
    blobStore: () => blobStore,
    app: () => app,
  });
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
  // Moved: boot-config.ts.
  function _printDataContract(
    ...a: StepArgs<typeof configSteps._printDataContract<S, A, E>>
  ) {
    return configSteps._printDataContract(ctx, ...a);
  }

  // An update hands over by starting the new artifact and exiting. aio refuses
  // to boot while another instance holds the app lock, so the successor is
  // launched with its predecessor's pid and waits here — BEFORE the lock is
  // taken, and before anything else can fail for a reason that is really just
  // this race.
  inheritedParentEnv(); // before anything the app starts can inherit it
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
  // Moved: boot-config.ts.
  function _checkUnpackPlace(
    ...a: StepArgs<typeof configSteps._checkUnpackPlace<S, A, E>>
  ) {
    return configSteps._checkUnpackPlace(ctx, ...a);
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
  // Moved: boot-config.ts.
  function _detectCompiledProd(
    ...a: StepArgs<typeof configSteps._detectCompiledProd<S, A, E>>
  ) {
    return configSteps._detectCompiledProd(ctx, ...a);
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
    // structural view. The RAW getter: aio-boot hands it a one-cell state,
    // and the memoized one would evict every client's cached view for it.
    getUIState: (s: Record<string, unknown>) => _rawGetUIState(s as S),
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
  // Moved: boot-storage.ts.
  function _recoverSyncLogs(
    ...a: StepArgs<typeof storageSteps._recoverSyncLogs<S, A, E>>
  ) {
    return storageSteps._recoverSyncLogs(ctx, ...a);
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
      const slice = _unpersistedFromBoot(cell, filter, was, now);
      if (slice !== now) {
        out ??= { ...(replayed as Record<string, unknown>) };
        out[cell] = slice;
      }
    }
    return (out ?? replayed) as S;
  }

  // Moved: boot-storage.ts.
  function _roundTripReplayedCells(
    ...a: StepArgs<typeof storageSteps._roundTripReplayedCells<S, A, E>>
  ) {
    return storageSteps._roundTripReplayedCells(ctx, ...a);
  }

  // Moved: boot-storage.ts.
  function _restartedSlice(
    ...a: StepArgs<typeof storageSteps._restartedSlice<S, A, E>>
  ) {
    return storageSteps._restartedSlice(ctx, ...a);
  }

  // Moved: boot-storage.ts.
  function _restoreStoredSlice(
    ...a: StepArgs<typeof storageSteps._restoreStoredSlice<S, A, E>>
  ) {
    return storageSteps._restoreStoredSlice(ctx, ...a);
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

  // Moved: boot-storage.ts.
  function _warnUnstampedAcrossMigration(
    ...a: StepArgs<typeof storageSteps._warnUnstampedAcrossMigration<S, A, E>>
  ) {
    return storageSteps._warnUnstampedAcrossMigration(ctx, ...a);
  }

  // Moved: boot-storage.ts.
  function _rerunRestoreHooks(
    ...a: StepArgs<typeof storageSteps._rerunRestoreHooks<S, A, E>>
  ) {
    return storageSteps._rerunRestoreHooks(ctx, ...a);
  }

  function _isRecord(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  /** One cell's replayed slice with what `filter` keeps out of the store put
   *  back to its boot value (or removed, where boot had none) — the shared
   *  rule in `state/cell-persist-filter.ts`, which the dev checkpoint restore
   *  reads too. */
  function _unpersistedFromBoot(
    cell: string,
    filter: import("../state/cell-types.ts").CellFieldFilter,
    was: Record<string, unknown>,
    now: Record<string, unknown>,
  ): Record<string, unknown> {
    return unpersistedFromBase(
      filter,
      was,
      now,
      (initialState as Record<string, unknown>)[cell],
    );
  }

  // Moved: boot-storage.ts.
  function _quarantinedTail(
    ...a: StepArgs<typeof storageSteps._quarantinedTail<S, A, E>>
  ) {
    return storageSteps._quarantinedTail(ctx, ...a);
  }

  // Moved: boot-storage.ts.
  function _refuseJournalAcrossGap(
    ...a: StepArgs<typeof storageSteps._refuseJournalAcrossGap<S, A, E>>
  ) {
    return storageSteps._refuseJournalAcrossGap(ctx, ...a);
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
  // Moved: boot-storage.ts.
  function _wireJournal(
    ...a: StepArgs<typeof storageSteps._wireJournal<S, A, E>>
  ) {
    return storageSteps._wireJournal(ctx, ...a);
  }

  // The ops a crash caught between their persist and their commit
  // (`_deferred`, left out of their cells' replay above): reduced now, whole,
  // exactly as the live server decides — a refusal deletes the op and nothing
  // acks it — and recorded below (`_unmarked`). A reaction is applied only
  // where its listener's record certainly lacks it (op-placement.ts
  // `inFlightVerdict`); held and named everywhere else.
  const _rederivedCells = new Set<string>();
  if (_deferred.length > 0 && asyncDb) await _reduceDeferred(asyncDb);
  // Moved: boot-storage.ts.
  function _reduceDeferred(
    ...a: StepArgs<typeof storageSteps._reduceDeferred<S, A, E>>
  ) {
    return storageSteps._reduceDeferred(ctx, ...a);
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

  // Moved: boot-dispatch.ts.
  function handleTTCommand(
    ...a: StepArgs<typeof dispatchSteps.handleTTCommand<S, A, E>>
  ) {
    return dispatchSteps.handleTTCommand(ctx, ...a);
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
  // Moved: boot-dispatch.ts.
  function _storedSlice(
    ...a: StepArgs<typeof dispatchSteps._storedSlice<S, A, E>>
  ) {
    return dispatchSteps._storedSlice(ctx, ...a);
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

  // Moved: boot-dispatch.ts.
  function _recordTimeTravel(
    ...a: StepArgs<typeof dispatchSteps._recordTimeTravel<S, A, E>>
  ) {
    return dispatchSteps._recordTimeTravel(ctx, ...a);
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
  /** `app.cells.disable`'s state reset (`cell-compose-registry.ts` marks it
   *  `reset`) — a write like any other, unlike the shutdown's `__destroy`. */
  const _isDisableReset = (action: A): boolean => {
    const a = action as { type?: unknown; payload?: { reset?: unknown } };
    return typeof a.type === "string" && a.type.endsWith(":__destroy") &&
      a.payload?.reset === true;
  };
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
  // Moved: boot-dispatch.ts.
  const _afterAction = (
    ...a: StepArgs<typeof dispatchSteps._afterAction<S, A, E>>
  ) => dispatchSteps._afterAction(ctx, ...a);
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
  // Moved: boot-dispatch.ts.
  function _quarantinedWrite(
    ...a: StepArgs<typeof dispatchSteps._quarantinedWrite<S, A, E>>
  ) {
    return dispatchSteps._quarantinedWrite(ctx, ...a);
  }

  // Moved: boot-dispatch.ts.
  function _markSyncApplied(
    ...a: StepArgs<typeof dispatchSteps._markSyncApplied<S, A, E>>
  ) {
    return dispatchSteps._markSyncApplied(ctx, ...a);
  }

  // Moved: boot-dispatch.ts.
  function _intendSyncOp(
    ...a: StepArgs<typeof dispatchSteps._intendSyncOp<S, A, E>>
  ) {
    return dispatchSteps._intendSyncOp(ctx, ...a);
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
  // Moved: boot-dispatch.ts.
  function _journalReaction(
    ...a: StepArgs<typeof dispatchSteps._journalReaction<S, A, E>>
  ) {
    return dispatchSteps._journalReaction(ctx, ...a);
  }

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
  // Moved: boot-dispatch.ts.
  function _saveNow(...a: StepArgs<typeof dispatchSteps._saveNow<S, A, E>>) {
    return dispatchSteps._saveNow(ctx, ...a);
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
  // Moved: boot-dispatch.ts.
  function _owe(...a: StepArgs<typeof dispatchSteps._owe<S, A, E>>) {
    return dispatchSteps._owe(ctx, ...a);
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

  // Moved: boot-dispatch.ts.
  function _journalAppend(
    ...a: StepArgs<typeof dispatchSteps._journalAppend<S, A, E>>
  ) {
    return dispatchSteps._journalAppend(ctx, ...a);
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
  // Moved: boot-dispatch.ts.
  function _setupDispatchCore(
    ...a: StepArgs<typeof dispatchSteps._setupDispatchCore<S, A, E>>
  ) {
    return dispatchSteps._setupDispatchCore(ctx, ...a);
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
  // Moved: boot-dispatch.ts.
  function _createWorkerPool(
    ...a: StepArgs<typeof dispatchSteps._createWorkerPool<S, A, E>>
  ) {
    return dispatchSteps._createWorkerPool(ctx, ...a);
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
      const refused = Promise.reject(e);
      refused.catch(() => {
        // aio-ok: fire-and-forget guard, as below — the awaiter still gets it
      });
      return refused;
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
    const back = Promise.resolve(out).then((v) => {
      _moveRejections(sent, a); // …and again for a refusal recorded on commit
      return v === undefined
        ? v
        : _cloneAcrossWorkerBoundary(v, "return value", cellId);
    });
    // A new promise, so dispatch's own fire-and-forget guard (B-4) does not
    // cover it: an unawaited call that threw was an `unhandledrejection` here
    // and on the real bridge, quiet on a main-isolate cell. Awaiters still
    // get the rejection.
    back.catch(() => {
      // aio-ok: fire-and-forget guard — the awaiter still gets the rejection
    });
    return back;
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
  // Moved: boot-dispatch.ts.
  function _createShutdown(
    ...a: StepArgs<typeof dispatchSteps._createShutdown<S, A, E>>
  ) {
    return dispatchSteps._createShutdown(ctx, ...a);
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
  // Moved: boot-dispatch.ts.
  const shutdown = (...a: StepArgs<typeof dispatchSteps.shutdown<S, A, E>>) =>
    dispatchSteps.shutdown(ctx, ...a);

  /** Tell the PROCESS about this app, so any process-wide exit (a signal,
   *  `am stop`, the Electron window closing) waits for THIS app's final
   *  snapshot too — not just for whichever app got there first. */
  const _unregisterRuntime = registerRuntime(() => shutdown());

  // Content-addressed blob store (tier ③) — resolved through the SAME
  // registered app dirs everything else uses; lazy (no dirs until first put).
  const blobStore = openBlobStore(appId, config.appDir);

  const app = _buildApp();
  // Moved: boot-dispatch.ts.
  function _buildApp(...a: StepArgs<typeof dispatchSteps._buildApp<S, A, E>>) {
    return dispatchSteps._buildApp(ctx, ...a);
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
  // The same bar a static `users:` token is held to — the shared key is the
  // ONLY credential in front of an exposed app, and the failure budget slows
  // a guesser without stopping one (a valid key is always served).
  if (
    typeof _cfgKey === "string" && _cfgKey === _keyRes.key &&
    isWeakToken(_cfgKey)
  ) {
    log.warn(
      "auth",
      `security: weak fixed \`key\` — under ${WEAK_TOKEN_MIN_CHARS} chars ` +
        `or ~${WEAK_TOKEN_MIN_BITS} bits, it is ` +
        `guessable at network speed, and it is the only thing in front of ` +
        `this exposed app. Use key: true (a generated key, persisted), or ` +
        "generate one with `openssl rand -base64 24` and load it from the " +
        "environment.",
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
      ...(config.peerTypes !== undefined
        ? { peerTypes: checkPeerTypes(config.peerTypes) }
        : {}),
      ...(config.resolvePeer
        ? {
          resolvePeer: (p: { app: string; pid: number }) =>
            config.resolvePeer!(p, state),
        }
        : {}),
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
      stamp: buildChannel(appDenoJson()?.build),
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
      splash: config.splash,
      client,
      useElectron,
      isHeadless,
      libraryMode: config.libraryMode,
      transport: transport.transport,
      skipHttp: transport.skipHttp,
      httpSocketPath: transport.httpSocketPath,
      port: livePort,
      token,
      pairingPake: config.pairing?.pake === true,
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
