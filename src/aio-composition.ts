// Cell composition wiring — extracts composition logic from run()
import {
  type CellEntry,
  type CircuitBreakerConfig,
  composeCells,
  type ComposedCells,
} from "./cell.ts";
import {
  applyCellFieldFilter,
  type CellPatchStrategy,
  type PatchFilterFields,
} from "./state-filter.ts";
import type { CellFieldFilter, FilterUser } from "./cell-types.ts";
import type { AioError, ReportErrorOpts } from "./error.ts";
import { reportError as reportAioError } from "./error.ts";
import { log } from "./logger.ts";
import type { MiddlewareFn } from "./middleware.ts";

/** User identity shape — matches AioUser without importing from aio.ts (avoids circular) */
type User = { id: string; role: string };

/** Inputs for cell composition — subset of CellsConfig relevant to wiring */
export type ComposeCellsInput = {
  cellEntries: CellEntry[];
  cellDefaults?: { ui?: CellFieldFilter; persist?: CellFieldFilter };
  circuitBreaker?: CircuitBreakerConfig;
  perfCheck?: "on" | "off";
  onError?: (error: AioError) => void;
  middleware?: MiddlewareFn[];
  beforeReduce?: (
    action: unknown,
    state: unknown,
    user?: User,
  ) => unknown | null;
  onRestore?: (state: unknown) => unknown;
};

/** Everything produced by cell composition wiring */
export type ComposeCellsResult = {
  composed: ComposedCells;
  autoGetDBState: (s: unknown) => unknown;
  autoGetUIState: ((s: unknown, user?: unknown) => unknown) | undefined;
  cellPatchStrategies: Map<string, CellPatchStrategy>;
  cellFilterFields: Map<string, PatchFilterFields>;
  beforeReduce:
    | ((action: unknown, state: unknown, user?: User) => unknown | null)
    | undefined;
  onRestore: ((state: unknown) => unknown) | undefined;
  cellReportOpts: ReportErrorOpts;
};

/** Compose cells, apply defaults, build state filters + middleware chain */
export function composeCellsWiring(
  input: ComposeCellsInput,
): ComposeCellsResult {
  const cellReportOpts: ReportErrorOpts = { onError: input.onError };
  const perfEnabled = input.perfCheck !== "off";

  const composed = composeCells(input.cellEntries, {
    onCellError: (err) => reportAioError(err, cellReportOpts),
    circuitBreaker: input.circuitBreaker,
    perfCheck: perfEnabled,
  });

  applyCellDefaults(composed, input.cellDefaults);
  const autoGetDBState = buildDBStateGetter(composed);
  const { autoGetUIState, cellPatchStrategies, cellFilterFields } =
    buildUIStateGetter(composed);
  const beforeReduce = buildBeforeReduce(input.middleware, input.beforeReduce);
  const onRestore = input.onRestore as
    | ((state: unknown) => unknown)
    | undefined;

  logComposition(composed);

  return {
    composed,
    autoGetDBState,
    autoGetUIState,
    cellPatchStrategies,
    cellFilterFields,
    beforeReduce,
    onRestore,
    cellReportOpts,
  };
}

/** Apply cellDefaults to cells missing explicit persist/ui config */
function applyCellDefaults(
  composed: ComposedCells,
  cellDefaults?: { ui?: CellFieldFilter; persist?: CellFieldFilter },
): void {
  if (!cellDefaults) return;
  for (const f of composed.cells) {
    if (!f.__aio.persist && cellDefaults.persist) {
      f.__aio.persist = cellDefaults.persist;
    }
    if (!f.__aio.ui && cellDefaults.ui) {
      f.__aio.ui = cellDefaults.ui;
    }
  }
}

/** Build getDBState from per-cell persist filters */
function buildDBStateGetter(composed: ComposedCells): (s: unknown) => unknown {
  const cellPersistFilters = new Map<string, CellFieldFilter>();
  for (const f of composed.cells) {
    if (f.__aio.persist) {
      cellPersistFilters.set(f.__aio.id, f.__aio.persist);
    }
  }
  if (cellPersistFilters.size > 0) {
    return (s: unknown) => {
      const full = s as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const [cellName, filter] of cellPersistFilters) {
        const cellState = full[cellName];
        if (!cellState || typeof cellState !== "object") continue;
        const filtered = applyCellFieldFilter(
          filter,
          cellState as Record<string, unknown>,
        );
        if (filtered) result[cellName] = filtered;
      }
      return result;
    };
  }
  // No cells opted into persistence — persist nothing
  return () => ({});
}

type UiEntry = {
  filter: CellFieldFilter;
  forUser?: (
    exposed: Record<string, unknown>,
    user?: FilterUser,
  ) => Record<string, unknown>;
};

type UIStateResult = {
  autoGetUIState: ((s: unknown, user?: unknown) => unknown) | undefined;
  cellPatchStrategies: Map<string, CellPatchStrategy>;
  cellFilterFields: Map<string, PatchFilterFields>;
};

/** Build getUIState from per-cell ui filters + patch strategy map (with memoization) */
function buildUIStateGetter(composed: ComposedCells): UIStateResult {
  const cellPatchStrategies = new Map<string, CellPatchStrategy>();
  const cellFilterFields = new Map<string, PatchFilterFields>();
  const cellUiEntries = new Map<string, UiEntry>();

  for (const f of composed.cells) {
    const resolved = f.__aio.ui ?? "none";
    if (resolved === "all") {
      cellPatchStrategies.set(f.__aio.id, "raw");
    } else if (resolved === "none") {
      cellPatchStrategies.set(f.__aio.id, "skip");
    } else if (f.__aio.uiForUser) {
      cellPatchStrategies.set(f.__aio.id, "full");
    } else {
      cellPatchStrategies.set(f.__aio.id, "filter");
      if ("include" in resolved) {
        cellFilterFields.set(f.__aio.id, {
          mode: "include",
          fields: new Set(resolved.include),
        });
      } else if ("exclude" in resolved) {
        cellFilterFields.set(f.__aio.id, {
          mode: "exclude",
          fields: new Set(resolved.exclude),
        });
      }
    }
    if (f.__aio.ui) {
      cellUiEntries.set(f.__aio.id, {
        filter: f.__aio.ui,
        forUser: f.__aio.uiForUser,
      });
    }
  }

  if (cellUiEntries.size === 0) {
    return { autoGetUIState: undefined, cellPatchStrategies, cellFilterFields };
  }

  // Memoization state — closure-captured, preserved across calls
  let _structCache: Record<string, unknown> | null = null;
  let _structStateRef: unknown = null;

  const getStructural = (s: unknown): Record<string, unknown> => {
    if (s === _structStateRef && _structCache) return _structCache;
    _structStateRef = s;
    const full = s as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [cellName, entry] of cellUiEntries) {
      const cellState = full[cellName];
      if (!cellState || typeof cellState !== "object") continue;
      const filtered = applyCellFieldFilter(
        entry.filter,
        cellState as Record<string, unknown>,
      );
      if (filtered) result[cellName] = filtered;
    }
    _structCache = result;
    return result;
  };

  const hasForUser = [...cellUiEntries.values()].some((e) => e.forUser);
  let autoGetUIState: (s: unknown, user?: unknown) => unknown;

  if (hasForUser) {
    autoGetUIState = (s: unknown, user?: unknown) => {
      const structural = getStructural(s);
      const result: Record<string, unknown> = { ...structural };
      for (const [cellName, entry] of cellUiEntries) {
        if (!entry.forUser || !result[cellName]) continue;
        try {
          result[cellName] = entry.forUser(
            structuredClone(result[cellName] as Record<string, unknown>),
            user as Record<string, unknown> | undefined,
          );
        } catch (e) {
          log.error(
            `[${cellName}] ui.forUser threw — using structural filter: ${e}`,
          );
        }
      }
      return result;
    };
  } else {
    autoGetUIState = (s: unknown) => getStructural(s);
  }

  return { autoGetUIState, cellPatchStrategies, cellFilterFields };
}

/** Build beforeReduce from middleware array + explicit beforeReduce */
function buildBeforeReduce(
  middleware?: MiddlewareFn[],
  explicitBeforeReduce?: (
    action: unknown,
    state: unknown,
    user?: User,
  ) => unknown | null,
):
  | ((action: unknown, state: unknown, user?: User) => unknown | null)
  | undefined {
  let beforeReduce = explicitBeforeReduce;
  if (middleware?.length) {
    const mws = middleware;
    const chainedMw = (
      action: unknown,
      state: unknown,
      user?: User,
    ): unknown | null => {
      let result: unknown | null = action;
      for (const mw of mws) {
        if (result === null) return null;
        result = mw(result, state, user);
      }
      return result;
    };
    if (beforeReduce) {
      const prev = beforeReduce;
      beforeReduce = (action, state, user?: User) => {
        const r = chainedMw(action, state, user);
        if (r === null) return null;
        return prev(r, state, user);
      };
    } else {
      beforeReduce = chainedMw;
    }
  }
  return beforeReduce;
}

/** Log cell composition info */
function logComposition(composed: ComposedCells): void {
  log.info(`cells: ${composed.cellNames.join(", ")}`);
  for (const f of composed.cells) {
    if (f.__aio.foreignActions.length) {
      for (const fa of f.__aio.foreignActions) {
        log.info(`${f.__aio.id}: listens to ${fa}`);
      }
    }
  }
}
