// cell-compose.ts — composeCells orchestrator + public re-exports

import { enablePatches } from "immer";
import { log } from "./logger.ts";
import type { AioError } from "./error.ts";
import type { CellEntry, Msg } from "./cell-types.ts";
import type { ReduceBreakdown } from "./time-travel.ts";

import { resolveCells } from "./cell-compose-resolve.ts";
import { buildFlowsByPrefix, buildRootReducer } from "./cell-compose-reduce.ts";
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
      log.warn("cell", `${f.__aio.id} has no actions — is this intentional?`);
    }
  }

  // ── Initial state ──
  const initialState: Record<string, unknown> = {};
  for (const f of cells) {
    const machine = f.__aio.machine;
    const status = machine === false ? undefined : machine.initial;
    initialState[f.__aio.id] = status != null
      ? { ...f.__aio.state, __aio_status: status }
      : { ...f.__aio.state };
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
    disabledCells,
    cellLastAction,
    reportError: _reportError,
    perfCheck: _perfCheck,
  };

  // ── Root reducer ──
  const rootReduce = buildRootReducer(cells, reduceCtx, perfTracker);

  // ── Flow registry ──
  const flowsByPrefix = buildFlowsByPrefix(cells);

  // ── Root executor ──
  const rootExecute = buildRootExecutor(
    cells,
    flowsByPrefix,
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
