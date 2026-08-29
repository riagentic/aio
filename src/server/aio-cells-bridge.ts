// Cells-to-legacy config bridge — converts CellsConfig → AioConfig for _run()
// Also wraps the returned AioApp with memory monitor, cells API, and bindCell.

import { physicalMemoryBytes } from "./heap-policy.ts";
import type { CellDef, ComposedCells } from "../state/cell.ts";
import { _releaseCellBindings } from "../state/cell-reactive.ts";
import { mergeLongIntoPerfBudget } from "../state/cell-impl.ts";
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
import { makeRedactor } from "../diagnostics/redact.ts";
import { parseCli } from "./aio-cli.ts";
import { resolveAppId } from "./single-instance-lock.ts";
import { VALID_AIO_CONFIG_KEYS } from "./config.ts";
import { appDirs } from "./app-dirs.ts";
import type { AioApp, AioConfig, AioUser, CellsConfig } from "./aio-types.ts";
import type { CellFieldFilter } from "../state/cell-types.ts";

/** Whether a top-level state key survives a `persist`/`ui` field filter.
 *  Mirrors the runtime filter semantics ("all"/"none"/include/exclude; default
 *  = "all"). Powers the trojan `fields` route (amui State overview). */
function fieldIncluded(
  key: string,
  filter: CellFieldFilter | undefined,
): boolean {
  if (filter === undefined || filter === "all") return true;
  if (filter === "none") return false;
  if ("include" in filter) return filter.include.includes(key);
  if ("exclude" in filter) {
    // exclude entries may be dot-paths ("a.b"); a top-level key is excluded only
    // by an exact match (a nested exclude still persists/exposes the parent key).
    return !filter.exclude.includes(key);
  }
  return true;
}

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
    // `true`/omitted → defaults; object → tuned; false → disabled (above).
    ...(typeof fc.dispatchStorm === "object" ? fc.dispatchStorm : {}),
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

  // ── Mechanical passthrough — the fail-closed core of this bridge ──
  // Every plain CellsConfig option rides through by DEFAULT. This used to be a
  // hand-maintained field-by-field copy, and a forgotten line silently dropped
  // the option after it was typed and validated (`strictOrigin`, then
  // `redactActions`, then `appDir` — data written to the wrong directory, and
  // `renderBudget` — never reached the browser). Only keys the bridge CONSUMES
  // are held back; keys it wraps or computes are overridden below, after the
  // spread. tests/config-bridge-completeness.test.ts proves the passthrough at
  // runtime with a sentinel per documented option.
  const {
    cells: _consumedCells, // composed already
    logging: _consumedLogging, // became `logger`
    dispatchStorm: _consumedStorm, // became the storm detector above
    diagnostics: _renamedDiagnostics, // forwarded as _diagnostics below
    onCheckpointRestore: _renamedOcr, // forwarded as _onCheckpointRestore below
    ...passthrough
  } = fc as Record<string, unknown>;
  // Composition-time options (cellDefaults, localFirst, isolate, …) are
  // consumed BEFORE this bridge and are not AioConfig keys — the runtime
  // validator rightly rejects them. Filter to the runtime's own whitelist, so
  // both directions stay mechanical: a new option added to both whitelists
  // (which option validation already forces) rides through with no edit here.
  for (const k of Object.keys(passthrough)) {
    if (!VALID_AIO_CONFIG_KEYS.has(k)) delete passthrough[k];
  }

  return {
    ...(passthrough as Partial<
      AioConfig<Record<string, unknown>, unknown, unknown>
    >),
    appId: fc.appId,
    // The EFFECT side of `long`. The caller side is lifted at compose time (so
    // testCell gets it too); this is the same declaration reaching the effect
    // tracker's abandon-the-effect deadline, from the same list. Two ceilings
    // resolved from one source — the trap the `effectTimeoutMs` unification
    // already fixed once, and a per-method flag that lifted only ONE of them
    // would have re-opened.
    perfBudget: mergeLongIntoPerfBudget(fc.perfBudget, composed.cells),
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
    onStart: ((app: AioApp<Record<string, unknown>, unknown>) => {
      composed.initAll({
        dispatch: (a) => app.dispatch(a),
        getState: () => app.getState(),
      });
      logger?.onStart(composed.cellNames, app.port);
      // AIO-418: user `onStart` is fired by the cells runner AFTER
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
      // AWAITED. The orchestrator budgets this phase (5 s teardown) precisely
      // so arbitrary app code can finish; calling the hook without awaiting it
      // resolved the phase the moment the hook STARTED, and an async `onStop`
      // — a flush to a remote, a handle to close, a child to wait for — was
      // abandoned ~ms before `Deno.exit`. Measured: a 4.5 s hook logged its
      // first line and never its last, on every `am stop`.
      if (fc.onStop) await fc.onStop();
    },
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
    // Cell id → public method names — trojan `cells` route (amui run-method
    // buttons). Internal keys (__set* reducer synonyms, __error, __effects) are
    // dropped: they're framework plumbing, not user-dispatchable actions.
    _cellMethods: Object.fromEntries(
      composed.cells.map((
        c,
      ) => [c.__aio.id, c.__aio.actionKeys.filter((k) => !k.startsWith("__"))]),
    ),
    // Cell id → the ASYNC subset. A correlation id (`_callId`) is settled by
    // the async executor; on a sync method the reducer resolves it as
    // "blocked". The trojan needs the split to correlate only what can answer.
    _cellAsyncMethods: Object.fromEntries(
      composed.cells.map((
        c,
      ) => [c.__aio.id, [...(c.__aio.asyncMethods ?? [])]]),
    ),
    // Cell id → per-field { persisted, ui } flags — trojan `fields` route (amui
    // State overview). Answers "what survives a restart" (persist) and "what
    // ships to the browser" (ui) for every top-level state key.
    _cellFields: Object.fromEntries(
      composed.cells.map((c) => [
        c.__aio.id,
        Object.fromEntries(
          Object.keys(c.__aio.state ?? {}).map((k) => [k, {
            persisted: fieldIncluded(k, c.__aio.persist),
            ui: fieldIncluded(k, c.__aio.ui),
          }]),
        ),
      ]),
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
    _pluginNames: fc._pluginNames,
    // The defs of cells flagged `worker: true` — _run spawns one Deno worker
    // each and routes their actions off the main dispatch queue.
    _workerCells: composed.cells.filter((f) => f.__aio.worker === true),
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
    // Per-cell boot repair. Collected like `_cellMigrations`, and applied at
    // the same point in boot — see aio-boot step 5.
    _cellRestores: (() => {
      const m = new Map<
        string,
        (state: Record<string, unknown>) => Record<string, unknown> | void
      >();
      for (const f of composed.cells) {
        if (f.__aio.onRestore) m.set(f.__aio.id, f.__aio.onRestore);
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
  // Tri-state on purpose: the flag used to be spread only when TRUTHY, which
  // was harmless while `false` was the default and silently unusable the moment
  // it stopped being — `--no-backup-logs` would have parsed and done nothing.
  const { backupLogs: cliBackup, logBudget: cliBudget } = parseCli();
  const logCfg = fc.logging === false
    ? null
    : (fc.logging === true || fc.logging === undefined ? {} : fc.logging);
  // Logs are tier ② — regenerable, excluded from a backup — but they live in the
  // app's own directory so there is ONE place to look for everything an app
  // writes (`~/.<appId>/logs`, was `./.aio/log` relative to cwd, which meant a
  // service started from `/` wrote to `/.aio/log`). An explicit `logging.dir`
  // still wins.
  const dirs = appDirs(appId, fc.appDir);
  const logger = logCfg
    ? new AioLogger({
      dir: dirs.logs,
      ...logCfg,
      ...(cliBackup !== undefined ? { backupLogs: cliBackup } : {}),
      ...(cliBudget !== undefined ? { logBudget: cliBudget } : {}),
      appName: appId,
      // `debug.log` retains action payloads on disk, so it obeys the SAME
      // `redactActions` list as the journal, the timeline, the action log and
      // the checkpoint. It was the one sink that never saw the list, and it
      // wrote a redacted method's arguments — and the diff values it produced —
      // in cleartext (`docs/persistence/where-files-live.md` promises they are
      // kept nowhere).
      redact: makeRedactor(fc.redactActions),
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
    machineWarnFraction: fc.memory?.machineWarnFraction ?? 0.5,
    growthReportRatio: fc.memory?.growthReportRatio ?? 0.15,
    getMemoryUsage: () => Deno.memoryUsage(),
    getHeapLimit: () => _heapLimit,
    // The machine, not just the ceiling: 75%-of-a-47 GB-ceiling is 35 GB, and a
    // desktop is long gone by then. Without this denominator the monitor can
    // only ever warn about the app's health, never the machine's.
    getTotalMemory: () => physicalMemoryBytes() ?? 0,
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
  // …and record how to give them back. A cell def binds to exactly one app, and
  // that claim used to outlive the app: a second `testServer()` in the same file
  // failed with "already bound" even after `await using` closed the first
  //. Shutdown calls this; scoped to OUR cells, so a second app in
  // the same process keeps its own bindings.
  (app as Record<string, unknown>)._releaseCells = () =>
    _releaseCellBindings(composed.cells, composed.appId);
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
