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
import { deepFreeze } from "./immutable.ts";
import {
  buildRegistry,
  destroyAll as _destroyAll,
  initAll as _initAll,
  type RemoteLifecycle,
} from "./cell-compose-registry.ts";

enablePatches();

// ── Re-exports for public API ──
export type {
  CellStatus,
  CircuitBreakerConfig,
  ComposedCells,
} from "./cell-compose-types.ts";

/** A composition's circuit-breaker counter, for failures of its cells that
 *  happen outside its reduce/execute — a `worker: true` cell's method runs in
 *  another isolate. Not on `ComposedCells` (the public shape is frozen).
 *  @internal */
const _errorCounters = new WeakMap<object, (cell: string) => void>();

/** Count one error against `cell` in `composed`'s breaker — see
 *  `_errorCounters`. @internal */
export function _countCellError(composed: object, cell: string): void {
  _errorCounters.get(composed)?.(cell);
}

/** A composition's `health()[i].lastAction` recorder, for the method calls of
 *  its cells that reduce in another isolate — a `worker: true` cell's action
 *  never reaches this reduce, so its health row said `lastAction: undefined`
 *  for the whole life of the app while the same cell in-isolate named its
 *  last call. Not on `ComposedCells`, for the same reason as `_errorCounters`.
 *  @internal */
const _actionNoters = new WeakMap<
  object,
  (cell: string, type: string) => void
>();

/** Record `type` as `cell`'s last action in `composed` — see `_actionNoters`.
 *  @internal */
export function _noteCellAction(
  composed: object,
  cell: string,
  type: string,
): void {
  _actionNoters.get(composed)?.(cell, type);
}

/** Per composition: hand the lifecycle of the cells another isolate runs to
 *  that isolate — see `RemoteLifecycle`. Not on `ComposedCells`, for the same
 *  reason as `_errorCounters`. @internal */
const _remoteSetters = new WeakMap<object, (r: RemoteLifecycle) => void>();

/** Bind `composed`'s remote lifecycle — see `_remoteSetters`. @internal */
export function _setRemoteLifecycle(
  composed: object,
  remote: RemoteLifecycle,
): void {
  _remoteSetters.get(composed)?.(remote);
}

/** Compose an array of cells into a single dispatch/reduce/execute pipeline with dependency resolution. */
export function composeCells(
  entries: CellEntry[],
  opts?: {
    onCellError?: (err: AioError) => void;
    circuitBreaker?: import("./cell-compose-types.ts").CircuitBreakerConfig;
    perfCheck?: boolean;
    /** The app identity — scopes cancellation (see method-cancel.ts). */
    appId?: string;
    /** See `ReduceContext.refusalsReject` — align the in-process caller with
     *  the wire when a write is refused. */
    refusalsReject?: boolean;
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
  // FROZEN, exactly like every state after it.
  //
  // Committed state is frozen: immer's `autoFreeze` is never disabled, so a
  // write to it throws in dev AND prod. The state BEFORE the first dispatch
  // was the one exception — nothing produced it, so nothing froze it — and the
  // hole was silent in the worst way: `app.state.count = 99` at boot, in an
  // `onInit` hook or a component that ran before any action, SUCCEEDED and
  // changed what `getState()` reported. The same line one dispatch later
  // throws. A rule with a window in it is not a rule, and the window was
  // exactly the moment an app is being wired up.
  //
  // Frozen in both modes on purpose: the freeze that catches this in
  // production is immer's, and immer is never off, so matching it here keeps
  // t=0 and t=1 the same shape. `freezeState` gates the EXTRA belt-and-braces
  // pass in `dispatch.ts`, not this invariant.
  deepFreeze(initialState);

  // ── Shared mutable state (passed by reference into subsystems) ──
  const disabledCells = new Set<string>();
  const cellLastAction = new Map<string, { type: string; at: number }>();

  // ── Registry (includes countCellError, setCbApp, clearCell) ──
  const { registry, countCellError, setCbApp, clearCell, setRemote } =
    buildRegistry(
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
    refusalsReject: opts?.refusalsReject === true,
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
    try {
      return _innerReduce(state, action);
    } catch (e) {
      // A SYNC method that throws is a cell error too, and it was counted
      // nowhere: the `:__error` branch above is the ASYNC path, and the
      // effect-executor catch covers effects. A reduce throw propagates
      // straight out of here, so the most common failure there is — a
      // reducer that throws on every dispatch — was invisible to every
      // health surface and immune to the circuit breaker. Measured: three
      // sync throws left `/__aio/health` "healthy" with `errors: 0` and
      // `aio_cell_errors_total` at 0, while ONE async throw moved both; ten
      // sync throws never tripped a `maxErrors: 3` breaker that the same ten
      // async throws tripped on the third.
      //
      // `docs/debugging/troubleshooting.md` tells operators to diagnose
      // exactly this with "high error counts" at `/__aio/health`. The
      // existing coverage uses `async crash()` only, which is why the gap
      // survived.
      const ci = action.type.indexOf(":");
      const cellId = ci > 0 ? action.type.slice(0, ci) : "";
      if (cellId && cells.some((c) => c.__aio.id === cellId)) {
        countCellError(cellId);
      }
      throw e;
    }
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
    skip?: (cellId: string) => boolean,
  ): void => {
    setCbApp(app);
    _initAll(cells, app, _reportError, countCellError, skip);
  };

  const destroyAllFn = (
    app: { dispatch: (a: Msg) => void; getState: () => unknown },
    skip?: (cellId: string) => boolean,
  ): void => {
    _destroyAll(cells, app, _reportError, countCellError, clearCell, skip);
  };

  const composed: import("./cell-compose-types.ts").ComposedCells = {
    appId: opts?.appId ?? "",
    initialState,
    reduce: rootReduce,
    execute: rootExecute,
    cells,
    cellNames: cells.map((f) => f.__aio.id),
    // One implementation, two doors. The `Except` pair is a NEW name rather
    // than a parameter on the frozen ones — see `ComposedCells`.
    initAll: (app) => initAllFn(app),
    destroyAll: (app) => destroyAllFn(app),
    initAllExcept: initAllFn,
    destroyAllExcept: destroyAllFn,
    registry,
    ...(_perfCheck ? { lastBreakdown: () => _lastBreakdown } : {}),
  };
  _errorCounters.set(composed, countCellError);
  _remoteSetters.set(composed, setRemote);
  _actionNoters.set(
    composed,
    (cell, type) => cellLastAction.set(cell, { type, at: Date.now() }),
  );
  return composed;
}
