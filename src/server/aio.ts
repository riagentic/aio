// Core runtime orchestrator — boots KV, server, electron, wires everything together.
// Phase logic lives in aio-boot, aio-dispatch, aio-server, aio-lifecycle, aio-run-helpers.
// Cell composition logic lives in aio-composition and aio-cells-bridge.

import { createShutdownOrchestrator } from "./shutdown.ts";
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
import { getLogger, log } from "../diagnostics/logger.ts";
import { teachableError } from "../diagnostics/error.ts";

// Phase modules — extracted _run() logic
import { bootStorage, replaySyncOps } from "./aio-boot.ts";
import { replayJournal } from "./journal.ts";
import { createTimeline } from "./timeline.ts";
import { setupDispatch } from "./aio-dispatch.ts";
import { setupTransport } from "./aio-server.ts";
import { startLifecycle } from "./aio-lifecycle.ts";
import {
  acquireSingletonLock,
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

// Cells-based API modules
import { composeCellsWiring } from "./aio-composition.ts";
import {
  buildLegacyConfig,
  filterCellsByIsolate,
  initLogger,
  wrapAppWithCells,
} from "./aio-cells-bridge.ts";
import { getRegisteredCells } from "../state/cell-reactive.ts";

// CLI + path resolution
import { parseCli, printHelp, VERSION } from "./aio-cli.ts";
import {
  distCandidates,
  findFreePort,
  isCompiled,
  realDistCandidates,
  resolveDataDir,
} from "./paths.ts";
import { openSessionStore } from "./sessions.ts";
import { openUserStore } from "./auth-users.ts";
import { resolveAppId } from "./single-instance-lock.ts";
import { resolveAppKey } from "./app-key.ts";
import { assertDenoVersion } from "./deno-version.ts";
import { dirname, join, resolve } from "@std/path";
import { lint, printLint } from "./lint.ts";

// ── Re-exports: public API surface ────────────────────────────────────
export { VERSION } from "./aio-cli.ts";
export { parseCli, printHelp } from "./aio-cli.ts";
export type { CliFlags } from "./aio-cli.ts";
export { createUDSListener, type UDSHandle } from "./uds.ts";
export type { AioError } from "../diagnostics/error.ts";
export type { PerfBudget, PerfCheck } from "../state/dispatch.ts";
export { type Lint, lint } from "./lint.ts";
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
  VALID_AIO_CONFIG_KEYS,
  VALID_FEATURES_CONFIG_KEYS,
  VALID_UI_KEYS,
  validateConfig,
} from "./config.ts";

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

function _denoJsonVersion(): string | undefined {
  try {
    const raw = Deno.readTextFileSync(join(Deno.cwd(), "deno.json"));
    return (JSON.parse(raw) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/** The app's `target` from deno.json (written by `am create --target=…`) as a
 *  client-mode default. Makes the scaffolded `deno task dev` (no --client
 *  flag) run the CHOSEN target instead of the framework's electron fallback.
 *  `server` → `server-only` (aio's name for "no client UI"); `android` → the
 *  browser client (dev:android's emulator connects to the same dev server). */
function _denoJsonTargetClient():
  | "browser"
  | "electron"
  | "cli"
  | "server-only"
  | undefined {
  try {
    const raw = Deno.readTextFileSync(join(Deno.cwd(), "deno.json"));
    const target = (JSON.parse(raw) as { target?: string }).target;
    switch (target) {
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
  } catch {
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

/** Single entry point — boots KV, server, electron, wires everything. CLI
 *  args override config. (perfect-aio D9: the legacy 2-arg
 *  `aio.run(initialState, config)` overload was removed — zero callers
 *  existed; `aio.run({ cells })` / zero-config `aio.run()` is the API.) */
// deno-lint-ignore no-explicit-any
async function run(fc?: CellsConfig): Promise<AioApp<any, any>>;
// deno-lint-ignore no-explicit-any
async function run(a?: any, b?: any): Promise<AioApp<any, any>> {
  // Fail fast on an unsupported Deno — aio uses ≥2.9 behavior directly.
  assertDenoVersion();
  if (b !== undefined) {
    throw new Error(
      "aio.run(initialState, config) was removed in the alpha27 restructure (perfect-aio D9) — " +
        "define cells with cell() and call aio.run({ cells: [...] }) (or " +
        "zero-config aio.run()). Migration: docs/upgrade/restructure.md",
    );
  }

  // Cells-based API: aio.run(cellsConfig) — zero-config: aio.run()
  const fc = (a ?? {}) as CellsConfig;
  validateConfig(
    fc as unknown as Record<string, unknown>,
    VALID_FEATURES_CONFIG_KEYS,
    "CellsConfig",
  );
  if (fc.ui) {
    validateConfig(fc.ui as Record<string, unknown>, VALID_UI_KEYS, "ui");
  }
  // Multi-instance (perfect-aio D2): several aio.run() calls may coexist in
  // one process — each app's cells bind exclusively (bindCell throws on a
  // def already bound to another app), each appId takes its own singleton
  // lock, and zero-config auto-cells only work for the FIRST app (later apps
  // must pass explicit disjoint `cells:` lists — the bind error says so).

  try {
    // Isolate filter
    const cliIsolate = parseCli().isolate;
    const isolate = fc.isolate ?? cliIsolate;
    // Zero-config cells: every cell() self-registers on definition — boot
    // whatever the entry imported (same behavior as the standalone runtime).
    const allCells = fc.cells && fc.cells.length > 0
      ? fc.cells
      : [...getRegisteredCells().values()];
    if (allCells.length === 0) {
      throw teachableError(
        "no cells to run",
        "define at least one cell() (importing its module is enough), or pass " +
          "cells: [...] to aio.run()",
        "docs/quickstart.md",
      );
    }
    const cellEntries = filterCellsByIsolate(allCells, isolate);

    // Imported-but-unregistered cells (opt-in `strictCells`): a cell() that ran
    // (its module was imported) but was left out of aio.run({ cells }) dispatches
    // into the void — no error, dead feature, green tests (risoto 2026-07-24
    // Bad #2). Opt-in because the global registry accumulates across a process
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
      cellEntries,
      cellDefaults: fc.cellDefaults,
      circuitBreaker: fc.circuitBreaker,
      perfCheck: fc.perfCheck,
      onError: fc.onError,
      beforeReduce: fc.beforeReduce,
      onRestore: fc.onRestore,
    });

    if (parseCli().expose || fc.users || fc.resolveUser) {
      const allUi = visibilityReport
        .filter((r) => r.ui === "all")
        .map((r) => r.cell);
      if (allUi.length) {
        const mode = parseCli().expose ? "--expose" : "multi-user auth";
        log.warn(
          `${mode} with ui="all" on cells: ${
            allUi.join(", ")
          } — every authenticated client sees this state. Narrow with ui:{include:[...]} if needed.`,
        );
      }
    }

    // Logger
    const logger = await initLogger(fc);
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

    // AIO-418 (TBD B6): fire the user's onStart NOW — after the callable cell
    // method surface is bound — so seeding via a cell method (members.seed())
    // works instead of throwing "cell runtime not booted". Error-guarded: a
    // throwing onStart must not abort a successful boot.
    if (fc.onStart) {
      try {
        fc.onStart(app);
      } catch (e) {
        log.error(`onStart hook error: ${e}`);
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
    printHelp();
    Deno.exit(0);
  }
  if (cli.version) {
    console.log(`aio ${VERSION}`);
    Deno.exit(0);
  }

  const appId = resolveAppId(config.appId);
  log.debug(`app-id: ${appId}`);
  const port = cli.port ?? config.port ?? await findFreePort();

  // Singleton lock — libraryMode implies no lock (embeddable / testable).
  const singletonMode = config.libraryMode ? false : (config.singleton ?? true);
  const killExisting = (config.killExisting ?? false) ||
    (cli.killExisting ?? false);
  const appLock = await acquireSingletonLock(
    appId,
    port,
    singletonMode,
    killExisting,
  );

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
    for (const dir of candidates) {
      try {
        await Deno.stat(join(dir, "app.js"));
        distDir = dir;
        prod = true;
        log.info("auto-detected dist/app.js → prod mode");
        break;
      } catch { /* not found */ }
    }
    // A HEADLESS build (`--service`/`--cli`) never bundles, so there is no
    // dist/app.js to find — but a compiled binary is prod by definition (dev
    // mode means running from source). Without this the service binary fell
    // through to dev: it emitted the "esbuild not installed" warning and ran
    // the dev lint, which demands src/App.tsx at cwd → crash on any real
    // server. `deno task compile:service` shipped exactly that.
    if (!prod) {
      prod = true;
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
        await Deno.stat(join(dir, "app.js"));
        electronDistDir = dir;
        break;
      } catch { /* not found */ }
    }
  }

  // Diagnostics + vitals
  const { diagHooks, vitalsSystem, diagResolvedOpts } = initDiagAndVitals(
    config._diagnostics,
    prod,
    config._cellNames,
    config.guardDispatches,
  );

  // Client mode: CLI flag > aio.run config > app deno.json `target` >
  // electron. The deno.json step is what makes `am create --target=X` +
  // `deno task dev` (no --client flag) actually run target X.
  const client = cli.client ?? config.client ?? _denoJsonTargetClient() ??
    "electron";
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
  }
  printLint(
    await lint(initialState, config, baseDir, prod, isHeadless, useElectron),
  );

  const title = await resolveTitle(cli.title, ui.title);
  log.debug(
    `config: port=${port} persist=${shouldPersist} client=${client} title="${title}" baseDir=${baseDir}`,
  );

  // --- Phase 2: boot storage ---
  const syncCellIds = config._syncCellIds ?? [];
  let state = initialState;
  const boot = await bootStorage({
    appId,
    dbPath: config.dbPath ?? cli.dbPath,
    initialState,
    shouldPersist,
    persistKey,
    persistMode,
    persistDebounceMs: config.persistDebounceMs ?? 100,
    dbSchema: config.db,
    syncCellIds,
    cellAccess: config._cellAccess,
    cellMigrations: config._cellMigrations,
    onRestore: config.onRestore,
    onCheckpointRestore: config._onCheckpointRestore,
    diagHooks,
    healthGetter: config._healthGetter,
    getDBState: getDBState as (s: S) => unknown,
    getState: () => state as Record<string, unknown>,
    getReportOpts: () => _reportOpts,
    journal: config.journal,
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

  // Journal recovery (risoto #3): replay the actions committed AFTER the last
  // snapshot (the debounce window a SIGKILL/power-cut would otherwise lose) on
  // top of the restored state — after sync-ops so cross-cell reads see recovered
  // sync state. State transitions only; effects are never re-run.
  if (journal) {
    const tail = journal.readSince(journal.watermark());
    if (tail.length > 0) {
      state = replayJournal(
        state,
        tail,
        config.reduce as (s: S, a: A) => { state: S },
      );
      log.info(
        `journal: recovered ${tail.length} action(s) past the last snapshot`,
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

  // Time-travel — dev only
  let tt: TTState<S, { type: string }> | null = null;
  if (!prod) {
    tt = createTT<S, { type: string }>();
    tt = record(tt, { type: "__init" }, state);
    log.debug("time-travel: initialized");
  }

  const _reportOpts = buildReportOpts({ onError, getTT: () => tt, prod });
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
  const onPerf = buildOnPerf(tt, vitalsSystem);

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
    if (restored !== null) state = restored;
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
  //  • the durable journal (risoto #3) — the crash-recovery tail (actions only),
  //    present only when `journal: true`; sync cells recover via their op-log.
  //  • the in-memory timeline (risoto #4) — always on, bounded, carries the diff
  //    each action produced; the live view behind `am timeline`.
  // Both share the same seq (the journal's when journaling, else the timeline's
  // own counter) so a timeline entry and its journal line line up for replay.
  const _diagAfterAction = diagHooks?.afterAction as
    | ((prev: S, next: S, action: A) => void)
    | undefined;
  const _syncCellSet = new Set(syncCellIds);
  const timeline = createTimeline();
  const afterActionHook = (prev: S, next: S, action: A): void => {
    _diagAfterAction?.(prev, next, action);
    if (prev === next) return; // no-op action — nothing to record
    const t = (action as { type?: string }).type ?? "";
    const ci = t.indexOf(":");
    const cell = ci >= 0 ? t.slice(0, ci) : "";
    const method = ci >= 0 ? t.slice(ci + 1) : t;
    if (method.startsWith("__")) return; // framework-internal (init/destroy)
    if (_syncCellSet.has(cell)) return; // sync cell → op-log handles it
    const payload = (action as { payload?: unknown }).payload;
    const ts = Date.now();
    const seq = journal
      ? journal.append({ type: t, payload }, ts)
      : timeline.lastSeq() + 1;
    timeline.record(seq, t, payload, prev, next, ts);
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
    schedulePersist: () => schedulePersist(),
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
    perfBudget: config.perfBudget,
    perfLog: (source, type, duration, budget, breakdown) =>
      getLogger()?.perf(source, type, duration, budget, breakdown),
    freezeState: config.freezeState ?? !prod,
    effectTimeout: config.effectTimeoutMs,
    reduceBreakdown: config._reduceBreakdown,
    afterAction: afterActionHook,
    log,
    debug: VERBOSE,
  });
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
  const sessionStore = (config.sessions || authEnabled)
    ? openSessionStore(
      join(resolveDataDir(appId), "auth.db"),
      typeof config.sessions === "object"
        ? config.sessions.ttlMs
        : authOpts.ttlMs,
    )
    : null;
  const userStore = authEnabled
    ? openUserStore(join(resolveDataDir(appId), "auth.db"))
    : null;

  // Shutdown orchestrator
  const { shutdown } = createShutdownOrchestrator({
    sessionStore,
    userStore,
    flushPersist: persistence.flushPersist,
    setShuttingDown: persistence.setShuttingDown,
    diagHooks,
    getVitalsCheckTimer: () => _vitalsCheckTimer,
    getVitalsSystem: () => vitalsSystem,
    onStop,
    appLock,
    scheduleManager,
    ownManager,
    dispatch,
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

  const app = buildAppObject<S, A>({
    dispatch,
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
    shutdown,
    sessionStore,
    userStore,
  });

  // --- Phase 4: start transport + lifecycle ---
  const expose = cli.expose ?? false;
  const users = config.users;
  const _resolveUser = config.resolveUser
    ? (tok: string) => config.resolveUser!(tok, state)
    : undefined;
  const sessionResolver = sessionStore
    ? (tok: string) => sessionStore.get(tok)
    : undefined;
  const _keyRes = (expose && !users && !_resolveUser)
    ? resolveAppKey(appId, (config as { key?: string | boolean }).key)
    : { key: undefined, persisted: false, explicit: false };
  const token = _keyRes.key;
  const clientCounter = { value: 0 };
  const udsRef = { current: null as UDSHandle | null };

  const transport = await setupTransport<S, A>({
    appId,
    port,
    prod,
    distDir,
    electronDistDir,
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
    cliCert: cli.cert,
    cliKey: cli.key,
    cliTransport: cli.transport,
    ui,
    title,
    config: {
      transport: config.transport,
      renderBudget: config.renderBudget,
      fullStateThreshold: config.fullStateThreshold,
      routes: config.routes,
      maxConnections: config.maxConnections,
      wsLimits: config.wsLimits,
      allowedOrigins: config.allowedOrigins,
      strictOrigin: config.strictOrigin,
      trustProxyHeader: config.trustProxyHeader,
      syncIntervalMs: config.syncIntervalMs,
      _cellPatchStrategies: config._cellPatchStrategies,
      _cellFilterFields: config._cellFilterFields,
      _cellAccess: config._cellAccess,
      onConnect: config.onConnect,
      onDisconnect: config.onDisconnect,
      libraryMode: config.libraryMode,
    },
    getState: () => state,
    getUIState: (s, user?) => getUIState(s, user),
    dispatch: (action) => dispatch(action as A),
    app: {
      snapshot: () => app.snapshot!(),
      loadSnapshot: (json) => app.loadSnapshot!(json),
    },
    vitalsSystem,
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
    cellFields: config._cellFields ?? {},
    asyncDb,
    // In-memory dispatch timeline (risoto #4) — the trojan `timeline` route.
    getTimeline: (after?: number, limit?: number) =>
      timeline.entries(after, limit),
    // Boot migration + shape-drift picture (risoto #1) — trojan `migrations`.
    migrations: migrationSummary,
    appLock,
    clientCounter,
    log,
  });

  server = transport.server;
  udsHandle = transport.udsHandle;
  udsRef.current = udsHandle;

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
    appId,
    appVersion: config.appVersion ?? _denoJsonVersion() ?? "0.0.0",
    title,
    prod,
    electronDistDir,
    expose,
    singletonMode,
    childWindows: !!config.childWindows,
    client,
    useElectron,
    isHeadless,
    transport: transport.transport,
    skipHttp: transport.skipHttp,
    port,
    token,
    users,
    tlsCert: transport.tlsCert,
    shareUrl: transport.shareUrl,
    localUrl: transport.localUrl,
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
    cli: { width: cli.width, height: cli.height, keepServer: cli.keepServer },
    ui: { width: ui.width, height: ui.height },
    keepServer: config.keepServer,
    shutdown,
    setElectronProc: (proc) => {
      _electronProc = proc;
    },
    setDiscoveryStop: (stop) => {
      discoveryRef.stop = stop;
    },
    appLock,
    log,
  });

  return app;
}

/** Main aio namespace — `aio.run(config)` starts the server. */
export const aio = { run };
