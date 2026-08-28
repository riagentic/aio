// cell-compose.ts — composeCells orchestrator + public re-exports

import { enablePatches } from "immer";
import { registerCancelOn } from "./method-cancel.ts";
import { _registerLongMethods, longMethodKeys } from "./cell-impl.ts";
import { log } from "../diagnostics/logger-api.ts";
import type { AioError } from "../diagnostics/error.ts";
import type { CellEntry, Msg } from "./cell-types.ts";
import type { ReduceBreakdown } from "../diagnostics/time-travel.ts";

import { resolveCells } from "./cell-compose-resolve.ts";
import { buildRootReducer } from "./cell-compose-reduce.ts";
import { cloneState } from "./immutable.ts";
import { buildRootExecutor } from "./cell-compose-execute.ts";
import {
  buildRegistry,
  destroyAll as _destroyAll,
  initAll as _initAll,
} from "./cell-compose-registry.ts";

enablePatches();

// ── Re-exports for public API ──
export type {
  CellStatus,
  CircuitBreakerConfig,
  ComposedCells,
} from "./cell-compose-types.ts";

/** Compose an array of cells into a single dispatch/reduce/execute pipeline with dependency resolution. */
export function composeCells(
  entries: CellEntry[],
  opts?: {
    onCellError?: (err: AioError) => void;
    circuitBreaker?: import("./cell-compose-types.ts").CircuitBreakerConfig;
    perfCheck?: boolean;
    /** The app identity — scopes cancellation (see method-cancel.ts). */
    appId?: string;
  },
): import("./cell-compose-types.ts").ComposedCells {
  if (entries.length === 0) {
    log.warn("aio", "no cells provided to composeCells()");
  }

  const cells = resolveCells(entries);
  const _reportError = opts?.onCellError;
  const _perfCheck = opts?.perfCheck ?? false;

  // ── Validation ──
  for (const f of cells) {
    const reservedKeys = Object.keys(f.__aio.state).filter((k) =>
      k === "_status" || k.startsWith("__aio_")
    );
    if (reservedKeys.length > 0) {
      throw new Error(
        `cell "${f.__aio.id}" uses reserved key(s): ${
          reservedKeys.join(", ")
        }. ` +
          `Rename '_status' to avoid conflicts with aio internals.`,
      );
    }
    if (f.__aio.actionKeys.length === 0) {
      // debug, not warn: state-only cells (shared data, read via selectors)
      // are a legitimate pattern flagged the warn as boot noise on
      // every testUI run.
      log.debug("cell", `${f.__aio.id} has no methods (state-only cell)`);
    }
  }

  // ── Initial state ──
  const initialState: Record<string, unknown> = {};
  for (const f of cells) {
    const machine = f.__aio.machine;
    const status = machine === false ? undefined : machine.initial;
    // Deep clone (not a shallow spread) so live state never aliases the
    // declared initial — a shallow `{ ...state }` shares nested arrays/objects
    // by reference, which is the classic in-place-mutation state-leak source.
    const base = cloneState(f.__aio.state);
    initialState[f.__aio.id] = status != null
      ? { ...base, __aio_status: status }
      : base;
  }

  // ── Shared mutable state (passed by reference into subsystems) ──
  const disabledCells = new Set<string>();
  const cellLastAction = new Map<string, { type: string; at: number }>();

  // ── Registry (includes countCellError, setCbApp, clearCell) ──
  const { registry, countCellError, setCbApp, clearCell } = buildRegistry(
    cells,
    disabledCells,
    cellLastAction,
    opts?.circuitBreaker,
    _reportError,
  );

  // ── Perf tracker ──
  let _lastBreakdown: ReduceBreakdown | undefined;
  const perfTracker = _perfCheck
    ? {
      set: (bd: ReduceBreakdown) => {
        _lastBreakdown = bd;
      },
    }
    : undefined;

  // ── Reduce context ──
  const reduceCtx = {
    appId: opts?.appId ?? "",
    disabledCells,
    cellLastAction,
    reportError: _reportError,
    perfCheck: _perfCheck,
  };

  // ── Cancellation triggers (D1): rebuild the runtime registry from defs ──
  for (const f of cells) {
    if (f.__aio.cancelTriggers) {
      for (const [m, triggers] of Object.entries(f.__aio.cancelTriggers)) {
        registerCancelOn(f.__aio.id, m, triggers, opts?.appId ?? "");
      }
    }
  }

  // ── `long` methods: lift the caller-side ceiling, from the DEF ──
  // Here rather than at boot, because compose is the one path every runtime
  // shares — the app, `bootCells`, `testUI` and `testCell`. A `long` that only
  // worked in a booted app would leave every test of the app's main feature
  // polling instead of awaiting, which is the workaround it exists to delete.
  // The EFFECT-side deadline is lifted at boot (`mergeLongIntoPerfBudget`);
  // testCell has no effect tracker, so this is the whole story there.
  _registerLongMethods(longMethodKeys(cells));

  // ── Root reducer ──
  const _innerReduce = buildRootReducer(cells, reduceCtx, perfTracker);
  // Async-method failures dispatch `cell:__error` — count them toward the
  // cell's health/circuit-breaker stats, exactly like a sync execute throw.
  // (perfect-aio D1 gate: error counting must not depend on the deleted
  // Style-B execute path.)
  const rootReduce: typeof _innerReduce = (state, action) => {
    if (action.type.endsWith(":__error")) {
      const cellId = action.type.slice(0, -"__error".length - 1);
      if (cells.some((c) => c.__aio.id === cellId)) countCellError(cellId);
    }
    return _innerReduce(state, action);
  };

  // ── Root executor ──
  const rootExecute = buildRootExecutor(
    cells,
    reduceCtx,
    _reportError,
    countCellError,
  );

  // ── Lifecycle ──
  const initAllFn = (
    app: { dispatch: (a: Msg) => void; getState: () => unknown },
  ): void => {
    setCbApp(app);
    _initAll(cells, app, _reportError, countCellError);
  };

  const destroyAllFn = (
    app: { dispatch: (a: Msg) => void; getState: () => unknown },
  ): void => {
    _destroyAll(cells, app, _reportError, countCellError, clearCell);
  };

  return {
    appId: opts?.appId ?? "",
    initialState,
    reduce: rootReduce,
    execute: rootExecute,
    cells,
    cellNames: cells.map((f) => f.__aio.id),
    initAll: initAllFn,
    destroyAll: destroyAllFn,
    registry,
    ...(_perfCheck ? { lastBreakdown: () => _lastBreakdown } : {}),
  };
}
