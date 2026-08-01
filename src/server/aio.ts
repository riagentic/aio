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
import { timeTravelEnabled } from "../diagnostics/types.ts";
import { teachableError } from "../diagnostics/error.ts";

// Phase modules — extracted _run() logic
import { bootStorage, replaySyncOps } from "./aio-boot.ts";
import { replayJournal } from "./journal.ts";
import { createTimeline } from "./timeline.ts";
import { makeRedactor } from "../diagnostics/redact.ts";
import { setupDispatch } from "./aio-dispatch.ts";
import { hostedCellName, startCellWorkerHost } from "./cell-worker-host.ts";
import { createCellWorkerPool } from "./cell-worker-pool.ts";
import { isScheduleEffect } from "../state/schedule.ts";
import {
  appDirs,
  ensureAppDirs,
  registerAppDirs,
  resolveAppDirs,
  writeAppMeta,
} from "./app-dirs.ts";
import { resolveDataDirLegacy } from "./paths.ts";
import { describeMigration, migrateLegacyLayout } from "./app-dirs-migrate.ts";
import { DEV_FRAME_BUDGET_MS } from "../state/dispatch.ts";
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
import { _setCallTimeouts } from "../state/cell-impl.ts";
import {
  buildLegacyConfig,
  filterCellsByIsolate,
  initLogger,
  wrapAppWithCells,
} from "./aio-cells-bridge.ts";
import { getRegisteredCells } from "../state/cell-reactive.ts";
import { createCostMeter } from "../vitals/cost-meter.ts";

// CLI + path resolution
import { parseCli, printHelp, VERSION, versionLine } from "./aio-cli.ts";
import {
  distCandidates,
  findFreePort,
  isCompiled,
  realDistCandidates,
} from "./paths.ts";
import { openSessionStore } from "./sessions.ts";
import { openUserStore } from "./auth-users.ts";
import { resolveAppId } from "./single-instance-lock.ts";
import { resolveAppKey } from "./app-key.ts";
import { assertDenoVersion } from "./deno-version.ts";
import { removalMessage, removalOf } from "../state/removals.ts";
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
    // Message comes from the removal registry — one decider for every
    // "that spelling is gone" the framework prints (src/state/removals.ts).
    throw new Error(removalMessage(removalOf("aio.run(initialState, config)")));
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
    // you to read the method instead of the config (llama-master #15).
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
          __aio: { id: string; methodKeys?: string[]; actionKeys?: string[] };
        };
        const id = def.__aio.id;
        for (
          const m of def.__aio.methodKeys ?? def.__aio.actionKeys ?? []
        ) known.add(`${id}:${m}`);
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
      localFirst: fc.localFirst,
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
    // An artifact has to be able to say what it IS and what it was built with —
    // a binary found on a server months later is otherwise unidentifiable, and
    // "which aio is this running?" is the first question when it misbehaves.
    // Same sources the app itself uses for its identity (resolveAppId handles
    // the compiled-binary case), so --version cannot describe a different app
    // than the one that would boot.
    console.log(
      versionLine(
        resolveAppId(config.appId),
        config.appVersion ?? _denoJsonVersion(),
      ),
    );
    Deno.exit(0);
  }

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
  if (!config.libraryMode) {
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
      app: (config as { appVersion?: string }).appVersion,
    });
  }
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

  // One redaction predicate for every place an action is recorded — the
  // journal (disk), the timeline (`am timeline`) and the action log. Built
  // here, before any of them exists, so none can be created without it.
  const redact = makeRedactor(config.redactActions);

  // Diagnostics + vitals
  const { diagHooks, vitalsSystem, diagResolvedOpts } = initDiagAndVitals(
    config._diagnostics,
    prod,
    config._cellNames,
    config.guardDispatches,
    redact,
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
    dbPragmas: config.dbPragmas,
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
  // them out of history (space-invaders field report).
  const ttSkipActions =
    typeof diagResolvedOpts === "object" && diagResolvedOpts.skipActions?.length
      ? new Set(diagResolvedOpts.skipActions)
      : undefined;
  let tt: TTState<S, { type: string }> | null = null;
  if (ttEnabled) {
    tt = createTT<S, { type: string }>();
    tt = record(tt, { type: "__init" }, state);
    log.debug("time-travel: initialized");
  } else if (!prod) {
    log.debug("time-travel: disabled by diagnostics config");
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
  // Cost meter (`am cost`): always on, bounded rings, zero configuration. The
  // question it answers — "what does aio move on my behalf, and where does it
  // come from" — is asked AFTER something feels slow, which is exactly when an
  // opt-in diagnostic is not enabled. See src/vitals/cost-meter.ts.
  const costMeter = createCostMeter();
  costMeter.setKnownCells(config._cellNames ?? []);
  const onPerf = buildOnPerf(tt, vitalsSystem, costMeter);

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
    if (method.startsWith("__")) return; // framework-internal (init/destroy)
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
          .filter(([, v]) => typeof v?.timeout === "number")
          .map(([k, v]) => [k, v!.timeout as number]),
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
  const sessionStore = (config.sessions || authEnabled)
    ? openSessionStore(
      appDirs(appId, config.appDir).authDb,
      typeof config.sessions === "object"
        ? config.sessions.ttlMs
        : authOpts.ttlMs,
    )
    : null;
  const userStore = authEnabled
    ? openUserStore(appDirs(appId, config.appDir).authDb)
    : null;

  // Shutdown orchestrator
  // ── Cell workers ──
  // Actions for a `worker: true` cell bypass the main queue entirely; only the
  // patches they commit come back through `dispatch`. Inert (identity routing)
  // when no cell is flagged.
  const workerPool = createCellWorkerPool({
    // libraryMode means the entry module is a TEST (or a host app), not this
    // app — spawning a worker on it would re-run the test file in another
    // thread. Worker cells then run in-isolate, exactly like testCell: same
    // behavior, no isolation, and it says so once.
    cells: (config.libraryMode
      ? []
      : config._workerCells ?? []) as unknown as Parameters<
        typeof createCellWorkerPool
      >[0]["cells"],
    entry: Deno.mainModule,
    prod,
    getSlice: (cell) =>
      ((state as Record<string, unknown>)[cell] ?? {}) as Record<
        string,
        unknown
      >,
    dispatch: (a) =>
      dispatch(a as unknown as A),
    // An effect handed back by a worker executes HERE, where the runtime lives.
    // A schedule effect is NOT an action — dispatching it would do nothing at
    // all, and the schedule would silently never fire.
    runEffect: (effect) => {
      if (isScheduleEffect(effect)) {
        scheduleManager.handle(effect);
        return;
      }
      void dispatch(effect as unknown as A); // cross-cell action
    },
  });
  if (
    config.libraryMode && (config._workerCells ?? []).length > 0 && !prod
  ) {
    log.info(
      "aio",
      `libraryMode: worker cells (${
        (config._workerCells ?? []).map((f) => f.__aio.id).join(", ")
      }) run in-isolate — a test owns the entry module, so there is nothing to ` +
        `host them from. Behavior is identical; isolation is not.`,
    );
  }
  _reseedWorkerCells = () => workerPool.reseed();
  const appDispatch = workerPool.size > 0
    ? (workerPool.route(
      (a) => dispatch(a as unknown as A),
    ) as unknown as typeof dispatch)
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

  /** Stop the worker threads before the rest of the runtime: their state is
   *  already replicated here, so this can only cut an in-flight method short —
   *  never lose a committed write. */
  const shutdown = async (): Promise<void> => {
    await workerPool.close();
    await _shutdownRuntime();
    // A closed app owns nothing: release THIS app's cells so they can bind
    // again. Without it a cell def stayed claimed for the life of the process,
    // so two `testServer()` blocks in one file failed with "already bound" even
    // with `await using` — the second test had to move to its own file for no
    // visible reason (llama.md #8). Scoped to our own cells, so a second app in
    // the same process is untouched.
    const release = (app as Record<string, unknown>)._releaseCells as
      | (() => void)
      | undefined;
    release?.();
  };

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
      _syncCellIds: config._syncCellIds,
      _cellPatchStrategies: config._cellPatchStrategies,
      _cellFilterFields: config._cellFilterFields,
      _cellAccess: config._cellAccess,
      onConnect: config.onConnect,
      onDisconnect: config.onDisconnect,
      libraryMode: config.libraryMode,
    },
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
