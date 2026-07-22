// Cells-to-legacy config bridge — converts CellsConfig → AioConfig for _run()
// Also wraps the returned AioApp with memory monitor, cells API, and bindCell.

import type { CellDef, ComposedCells } from "../state/cell.ts";
import { bindCell } from "../state/cell.ts";
import { createMemoryMonitor } from "../diagnostics/memory-monitor.ts";
import {
  createAioError,
  reportError as reportAioError,
  type ReportErrorOpts,
} from "../diagnostics/error.ts";
import { AioLogger, log, setLogger } from "../diagnostics/logger.ts";
import { createStormDetector } from "../diagnostics/dispatch-storm.ts";
import { diagEmit } from "../diagnostics/diagnostic-bus.ts";
import { parseCli } from "./aio-cli.ts";
import { resolveAppId } from "./single-instance-lock.ts";
import type { AioApp, AioConfig, AioUser, CellsConfig } from "./aio-types.ts";

/** Inputs for buildLegacyConfig — avoids 12-param function signature */
export type BuildLegacyConfigInput = {
  fc: CellsConfig;
  composed: ComposedCells;
  beforeReduce:
    | ((action: unknown, state: unknown, user?: AioUser) => unknown | null)
    | undefined;
  onRestore: ((state: unknown) => unknown) | undefined;
  autoGetUIState: ((s: unknown, user?: unknown) => unknown) | undefined;
  autoGetDBState: (s: unknown) => unknown;
  cellPatchStrategies: Map<
    string,
    import("../state/state-filter.ts").CellPatchStrategy
  >;
  cellFilterFieldsMap: Map<
    string,
    import("../state/state-filter.ts").PatchFilterFields
  >;
  cellReportOpts: ReportErrorOpts;
  logger: AioLogger | null;
  appRef: { current: AioApp<Record<string, unknown>, unknown> | null };
};

/** Build an AioConfig from composed cells + CellsConfig (the v0.5 cells-based API) */
export function buildLegacyConfig(
  input: BuildLegacyConfigInput,
): AioConfig<Record<string, unknown>, unknown, unknown> {
  const {
    fc,
    composed,
    beforeReduce,
    onRestore,
    autoGetUIState,
    autoGetDBState,
    cellPatchStrategies,
    cellFilterFieldsMap,
    cellReportOpts: _cellReportOpts,
    logger,
    appRef,
  } = input;
  // Dispatch-storm guard (watcher-loop field report #2) — every server dispatch
  // flows through beforeReduce, so frequency is measured (and optionally
  // circuit-broken) before reducers/effects/logging amplify the loop.
  const storm = fc.dispatchStorm === false ? null : createStormDetector({
    ...(fc.dispatchStorm ?? {}),
    onStorm: (info) => {
      if (info.rate === 0) {
        log.info(
          "storm",
          `${info.type} storm ended after ${info.seconds}s above threshold`,
        );
        return;
      }
      log.warn(
        "storm",
        `DISPATCH_STORM: ${info.type} fired ${info.rate}×/s for ${info.seconds}s${
          info.breaking ? " — circuit-breaking (dropping) it" : ""
        } — look for a feedback loop (e.g. an fs watcher observing your own writes)`,
      );
      diagEmit({
        type: "dispatch:storm",
        severity: "warning",
        source: "dispatch",
        message: `${info.type} fired ${info.rate}×/s for ${info.seconds}s`,
        detail: info,
        hint:
          "find the feedback loop; set dispatchStorm.breaker to drop it automatically",
      });
    },
  });
  const userBeforeReduce = beforeReduce as
    | ((a: unknown, s: unknown, u?: unknown) => unknown)
    | undefined;

  return {
    appId: fc.appId,
    reduce: composed.reduce as AioConfig<
      Record<string, unknown>,
      unknown,
      unknown
    >["reduce"],
    execute:
      ((app: AioApp<Record<string, unknown>, unknown>, effect: unknown) => {
        composed.execute(
          {
            dispatch: (a) => app.dispatch(a),
            getState: () => app.getState(),
          },
          effect as { type: string; payload: unknown },
        );
      }) as AioConfig<Record<string, unknown>, unknown, unknown>["execute"],
    persist: fc.persist,
    persistKey: fc.persistKey,
    dbPath: fc.dbPath,
    persistDebounceMs: fc.persistDebounceMs,
    persistMode: fc.persistMode,
    port: fc.port,
    baseDir: fc.baseDir,
    client: fc.client,
    users: fc.users,
    resolveUser: fc.resolveUser,
    sessions: fc.sessions,
    auth: fc.auth,
    key: fc.key,
    db: fc.db,
    perfCheck: fc.perfCheck,
    perfBudget: fc.perfBudget,
    effectTimeoutMs: fc.effectTimeoutMs,
    freezeState: fc.freezeState,
    singleton: fc.singleton,
    libraryMode: fc.libraryMode,
    killExisting: fc.killExisting,
    keepServer: fc.keepServer,
    syncIntervalMs: fc.syncIntervalMs,
    fullStateThreshold: fc.fullStateThreshold,
    routes: fc.routes,
    maxConnections: fc.maxConnections,
    // Security options — these MUST survive every hop: they were typed and
    // validated but silently dropped here, so `aio.run({ strictOrigin: true })`
    // never reached the WS origin check (complexity-audit finding).
    wsLimits: fc.wsLimits,
    allowedOrigins: fc.allowedOrigins,
    strictOrigin: fc.strictOrigin,
    schedules: fc.schedules,
    appVersion: fc.appVersion,
    transport: fc.transport,
    serverUrl: fc.serverUrl,
    ui: fc.ui,
    beforeReduce: ((action, state, user) => {
      if (
        storm &&
        !storm.track((action as { type: string }).type ?? "unknown")
      ) {
        return null; // breaker active — drop mid-storm dispatches
      }
      return userBeforeReduce ? userBeforeReduce(action, state, user) : action;
    }) as AioConfig<
      Record<string, unknown>,
      unknown,
      unknown
    >["beforeReduce"],
    onAction: logger
      ? ((action, state, user) => {
        logger.observe(
          action as { type: string; payload?: unknown },
          state as Record<string, unknown>,
        );
        if (fc.onAction) fc.onAction(action, state, user);
      }) as AioConfig<Record<string, unknown>, unknown, unknown>["onAction"]
      : fc.onAction as AioConfig<
        Record<string, unknown>,
        unknown,
        unknown
      >["onAction"],
    onEffect: fc.onEffect as AioConfig<
      Record<string, unknown>,
      unknown,
      unknown
    >["onEffect"],
    onConnect: fc.onConnect,
    onDisconnect: fc.onDisconnect,
    onStart: ((app: AioApp<Record<string, unknown>, unknown>) => {
      composed.initAll({
        dispatch: (a) => app.dispatch(a),
        getState: () => app.getState(),
      });
      logger?.onStart(composed.cellNames, app.port);
      // AIO-418 (TBD B6): user `onStart` is fired by the cells runner AFTER
      // wrapAppWithCells() binds the callable method surface — NOT here. Calling
      // e.g. `members.seed()` in onStart threw ("cell runtime not booted")
      // because the method binding happened after this hook. See aio.ts.
    }) as AioConfig<Record<string, unknown>, unknown, unknown>["onStart"],
    onStop: async () => {
      logger?.onStop();
      // Drain in-flight writes before clearing the singleton. Without this,
      // the final "stopped" entry + any late error logs race the process exit
      // and can be lost (F-3).
      await logger?.flush();
      setLogger(null);
      if (appRef.current) {
        composed.destroyAll({
          dispatch: (a) => appRef.current!.dispatch(a),
          getState: () => appRef.current!.getState(),
        });
      }
      if (fc.onStop) fc.onStop();
    },
    onError: fc.onError,
    onRestore: onRestore as AioConfig<
      Record<string, unknown>,
      unknown,
      unknown
    >["onRestore"],
    _getUIState: autoGetUIState as AioConfig<
      Record<string, unknown>,
      unknown,
      unknown
    >["_getUIState"],
    _getDBState: autoGetDBState as AioConfig<
      Record<string, unknown>,
      unknown,
      unknown
    >["_getDBState"],
    _cellPatchStrategies: cellPatchStrategies,
    _cellFilterFields: cellFilterFieldsMap,
    // AUTH-1: cell → declarative network-access rule (absent = open).
    _cellAccess: new Map(
      composed.cells
        .filter((c) => c.__aio.access !== undefined)
        .map((c) => [c.__aio.id, c.__aio.access!]),
    ),
    _onScheduleReady: (cancelByPrefix) =>
      composed.registry.setOnDisable(cancelByPrefix),
    _onReportOptsReady: (opts) => {
      _cellReportOpts.logger = opts.logger;
      _cellReportOpts.tt = opts.tt;
      _cellReportOpts.prod = opts.prod;
    },
    _diagnostics: fc.diagnostics,
    _onCheckpointRestore: fc.onCheckpointRestore,
    _cellNames: composed.cellNames,
    _reduceBreakdown: composed.lastBreakdown,
    _healthGetter: (state: unknown) => {
      const health = composed.registry.health(
        state as Record<string, unknown>,
      );
      const result: Record<string, { errors: number; enabled: boolean }> = {};
      for (const h of health) {
        result[h.name] = { errors: h.errors, enabled: h.enabled };
      }
      return result;
    },
    _syncCellIds: composed.cells
      .filter((f) => f.__aio.syncConfig)
      .map((f) => f.__aio.id),
    _cellMigrations: (() => {
      const m = new Map<
        string,
        {
          version: number;
          initialState: Record<string, unknown>;
          onMigrate?: (
            state: Record<string, unknown>,
            fromVersion: number,
          ) => Record<string, unknown>;
        }
      >();
      for (const f of composed.cells) {
        if (f.__aio.version > 0 || f.__aio.onMigrate) {
          m.set(f.__aio.id, {
            version: f.__aio.version,
            initialState: f.__aio.state,
            onMigrate: f.__aio.onMigrate,
          });
        }
      }
      return m.size > 0 ? m : undefined;
    })(),
    _cellVersions: (() => {
      const v: Record<string, number> = {};
      let any = false;
      for (const f of composed.cells) {
        if (f.__aio.version > 0) {
          v[f.__aio.id] = f.__aio.version;
          any = true;
        }
      }
      return any ? v : undefined;
    })(),
  };
}

/** Initialize structured logger from CellsConfig */
export async function initLogger(
  fc: CellsConfig,
): Promise<AioLogger | null> {
  const appId = resolveAppId(fc.appId);
  const cliBackup = parseCli().backupLogs;
  const logCfg = fc.logging === false
    ? null
    : (fc.logging === true || fc.logging === undefined ? {} : fc.logging);
  const logger = logCfg
    ? new AioLogger({
      ...logCfg,
      ...(cliBackup ? { backupLogs: true } : {}),
      appName: appId,
    })
    : null;
  if (logger) await logger.init();
  setLogger(logger);
  return logger;
}

/** Wrap app with memory monitor, cells API, and bindCell — post-_run() setup */
export async function wrapAppWithCells(
  app: AioApp<Record<string, unknown>, unknown>,
  composed: ComposedCells,
  fc: CellsConfig,
  _cellReportOpts: ReportErrorOpts,
): Promise<void> {
  // Initialize memory pressure monitor
  let _heapLimit = 0;
  try {
    const v8 = await import("node:v8");
    _heapLimit = (v8.getHeapStatistics() as { heap_size_limit: number })
      .heap_size_limit;
  } catch { /* node:v8 unavailable — fall back to heapTotal in monitor */ }

  const memoryMonitor = createMemoryMonitor({
    enabled: fc.memory?.enabled ?? true,
    interval: fc.memory?.interval ?? 10_000,
    warnThreshold: fc.memory?.warnThreshold ?? 0.75,
    criticalThreshold: fc.memory?.criticalThreshold ?? 0.90,
    gcStressRatio: fc.memory?.gcStressRatio ?? 0.05,
    onReport: (report) => {
      const code = report.level === "critical"
        ? "MEMORY_CRITICAL"
        : "MEMORY_PRESSURE";
      const topCell = report.cellStates[0];
      const err = createAioError(
        code as import("../diagnostics/error.ts").AioErrorCode,
        `heap at ${(report.heapPct * 100).toFixed(0)}% (${
          (report.heapUsed / 1e6).toFixed(0)
        } MB / ${(report.heapLimit / 1e6).toFixed(0)} MB)`,
        { cellName: topCell?.name },
      );
      reportAioError(err, _cellReportOpts);
      fc.memory?.onMemoryPressure?.(report);
    },
    getMemoryUsage: () => Deno.memoryUsage(),
    getHeapLimit: () => _heapLimit,
    getCellStates: () => {
      const fullState = app.getState() as Record<string, unknown>;
      return composed.cells.map((f) => ({
        name: f.__aio.id,
        state: fullState[f.__aio.id],
      }));
    },
  });

  // Wrap close to also stop memory monitor
  const origClose = app.close;
  (app as Record<string, unknown>).close = async () => {
    memoryMonitor.stop();
    await origClose();
  };

  // Attach cells API to app
  const cellsApi = {
    enable: (name: string) =>
      composed.registry.enable(name, {
        dispatch: (a) => app.dispatch(a),
        getState: () => app.getState(),
      }),
    disable: (name: string) =>
      composed.registry.disable(name, {
        dispatch: (a) => app.dispatch(a),
        getState: () => app.getState(),
      }),
    status: (name: string) =>
      composed.registry.status(
        name,
        app.getState() as Record<string, unknown>,
      ),
    health: () =>
      composed.registry.health(app.getState() as Record<string, unknown>),
    list: () => composed.cellNames,
  };
  (app as Record<string, unknown>).cells = cellsApi;

  // Bind cells — enables todo.add('milk') syntax (dispatch + selector binding)
  for (const f of composed.cells) {
    bindCell(
      f,
      (a) => app.dispatch(a),
      () => app.getState() as Record<string, unknown>,
    );
  }
}

/** Filter cell entries by --isolate flag */
export function filterCellsByIsolate(
  cellEntries: NonNullable<CellsConfig["cells"]>,
  isolate: string[] | undefined,
): NonNullable<CellsConfig["cells"]> {
  if (!isolate || isolate.length === 0) return cellEntries;
  const isolateSet = new Set(isolate);
  const filtered = cellEntries.filter((entry) => {
    const f = "__aio" in entry
      ? entry as CellDef
      : (entry as { cell: CellDef }).cell;
    return isolateSet.has(f.__aio.id);
  });
  if (filtered.length === 0) {
    log.warn(
      `isolate: no cells matched [${
        [...isolateSet].join(", ")
      }] — check spelling`,
    );
  } else {
    log.info(
      `isolate: ${
        filtered.map((e) =>
          ("__aio" in e ? e as CellDef : (e as { cell: CellDef }).cell).__aio.id
        ).join(", ")
      }`,
    );
  }
  return filtered;
}
