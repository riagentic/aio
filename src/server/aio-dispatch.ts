// Dispatch wiring — hooks reduce/execute, time-travel, patches, persistence broadcast
import { createDispatch, type PerfBudget } from "../state/dispatch.ts";
import {
  type CellPatchStrategy,
  filterPatchesByStrategy,
  type PatchFilterFields,
} from "../state/state-filter.ts";
import {
  createAioError,
  reportError as reportAioError,
  type ReportErrorOpts,
} from "../diagnostics/error.ts";
import {
  record,
  type ReduceBreakdown,
  type TTState,
} from "../diagnostics/time-travel.ts";
import { isScheduleEffect, type ScheduleEffect } from "../state/schedule.ts";
import { isOwnEffect, type OwnEffect } from "../state/own.ts";
import { diagEmit } from "../diagnostics/diagnostic-bus.ts";
import { runWithUser } from "./auth-context.ts";

/** User identity — mirrors AioUser from aio.ts without circular import */
type User = { id: string; role: string };

/** Patch entry — cell name + immer ops from a single reduce call */
export type PatchEntry = { cell: string; ops: import("immer").Patch[] };

/** Everything the dispatch wiring needs from the host runtime */
// App default must be `any` for function parameter contravariance
// deno-lint-ignore no-explicit-any
export type DispatchSetupDeps<S, A, E, App = any> = {
  reduce: (
    state: S,
    action: A,
  ) => { state: S; effects: (E | ScheduleEffect | OwnEffect)[] };
  execute: (app: App, effect: E) => void;
  beforeReduce?: (action: A, state: S, user?: User) => A | null;
  onAction?: (action: A, state: S, user?: User) => void;
  onEffect?: (effect: E, user?: User) => void;
  getState: () => S;
  setState: (s: S) => void;
  /** Late-bound app ref — called in execute, set after dispatch is created */
  getApp: () => App;
  /** Late-bound server ref — called in onDone/TT, set after server is created */
  getServer: () => {
    broadcast: (patches?: PatchEntry[]) => void;
    broadcastTT: () => void;
  };
  scheduleManager: { handle: (e: ScheduleEffect) => void };
  ownManager: { handle: (e: OwnEffect) => void };
  schedulePersist: () => void;
  getTT: () => TTState<S, { type: string }> | null;
  setTT: (tt: TTState<S, { type: string }>) => void;
  reportOpts: ReportErrorOpts;
  cellPatchStrategies?: Map<string, CellPatchStrategy>;
  cellFilterFields?: Map<string, PatchFilterFields>;
  /** UDS broadcast — called with filtered patches after each dispatch batch */
  onUdsBroadcast?: (patches?: PatchEntry[]) => void;
  onPerf?: (timing: {
    actionType: string;
    reduce: number;
    effects: number;
    budget: { reduce: number; effect: number };
    breakdown?: ReduceBreakdown;
  }) => void;
  perfCheck?: "on" | "off";
  perfBudget?: PerfBudget;
  perfLog?: (
    source: "reduce" | "effect",
    type: string,
    duration: number,
    budget: number,
    breakdown?: ReduceBreakdown,
  ) => void;
  freezeState: boolean;
  effectTimeout?: number;
  reduceBreakdown?: () => ReduceBreakdown | undefined;
  afterAction?: (prev: S, next: S, action: A) => void;
  log: {
    debug: (msg: string) => void;
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  debug: boolean;
};

// Internal action types to hide from time-travel history (framework noise)
const TT_SKIP_SUFFIXES = [":__exec", ":__FlowState", ":__flow"];
const TT_SKIP_CONTAINS = [":__set", ":__error"];
function isInternalAction(type: string): boolean {
  if (TT_SKIP_SUFFIXES.some((s) => type.endsWith(s))) return true;
  if (TT_SKIP_CONTAINS.some((s) => type.includes(s))) return true;
  return false;
}

/** Wire reduce/execute hooks, time-travel, patch collection, and create dispatch loop.
 *
 *  Hook execution order (per action in a batch):
 *    1. beforeReduce(action, state, user) — intercept: transform, filter, or drop (return null)
 *    2. onAction(action, state, user)     — observe action before reduce runs
 *    3. reduce(state, action)             — pure state transformation → new state + effects
 *    4. onEffect(effect, user)            — observe each effect before execution
 *    5. execute(app, effect)              — run side effect
 *  After the batch drains (all queued actions processed):
 *    6. onDone()                          — persist state + broadcast patches to clients
 *
 *  Any hook throwing is caught, reported via AioError, and does not abort the batch. */
// App default must be `any` for function parameter contravariance
// deno-lint-ignore no-explicit-any
export function setupDispatch<S, A, E, App = any>(
  deps: DispatchSetupDeps<S, A, E, App>,
): ReturnType<typeof createDispatch<S, A, E>> {
  const {
    reduce,
    beforeReduce,
    onAction,
    onEffect,
    getState,
    setState,
    getApp,
    getServer,
    scheduleManager,
    ownManager,
    schedulePersist,
    getTT,
    setTT,
    reportOpts,
    cellPatchStrategies,
    cellFilterFields,
    onUdsBroadcast,
    log,
    debug,
  } = deps;

  // Per-action user tag — set in hookedReduce, consumed in hookedExecute
  let _currentActionUser: User | undefined;
  // Tracks whether any action actually ran reduce() in this drain cycle
  let _anyProcessed = false;

  const hookedReduce: typeof reduce = (s, a) => {
    const user = (a as Record<string, unknown>)?._user as User | undefined;
    if (beforeReduce) {
      try {
        const filtered = beforeReduce(a, s, user);
        if (filtered === null) {
          diagEmit({
            type: "action-filtered",
            severity: "info",
            source: "middleware",
            message: `Action '${
              (a as { type?: string }).type
            }' filtered by beforeReduce`,
            detail: { actionType: (a as { type?: string }).type },
            hint:
              "A middleware or beforeReduce hook returned null, dropping this action.",
          });
          return { state: s, effects: [] as E[] };
        }
        a = filtered as A;
      } catch (e) {
        const actionType = (a as Record<string, unknown>)?.type as
          | string
          | undefined;
        const err = createAioError("HOOK_ERROR", e, {
          hookName: "beforeReduce",
          actionType,
        });
        reportAioError(err, reportOpts);
        return { state: s, effects: [] as E[] };
      }
    }
    _anyProcessed = true;
    _currentActionUser = user;
    if (onAction) {
      try {
        onAction(a, s, user);
      } catch (e) {
        const actionType = (a as Record<string, unknown>)?.type as
          | string
          | undefined;
        const err = createAioError("HOOK_ERROR", e, {
          hookName: "onAction",
          actionType,
        });
        reportAioError(err, reportOpts);
      }
    }
    // Ambient identity: reduce (cell methods) runs inside runWithUser so
    // serverUser() answers the caller anywhere downstream — including code the
    // method awaits. Server-origin actions carry no _user → undefined.
    return runWithUser(user, () => reduce(s, a));
  };

  const hookedExecute = onEffect
    ? (app: App, e: E) => {
      try {
        onEffect(e, _currentActionUser);
      } catch (err) {
        const effectType = (e as Record<string, unknown>)?.type as
          | string
          | undefined;
        const aioErr = createAioError("HOOK_ERROR", err, {
          hookName: "onEffect",
          effectType,
        });
        reportAioError(aioErr, reportOpts);
      }
      // Effects triggered by a user's action execute as that user.
      runWithUser(_currentActionUser, () => deps.execute(app, e));
    }
    : deps.execute;

  // Immer patch accumulator — collects patches across all reduce calls in a batch
  let _pendingPatches: PatchEntry[] = [];

  function _collectPatches(
    result: { state: S; effects: (E | ScheduleEffect | OwnEffect)[] },
  ): void {
    const patches =
      (result as unknown as { patches?: PatchEntry | PatchEntry[] }).patches;
    if (!patches) return;
    if (Array.isArray(patches)) _pendingPatches.push(...patches);
    else _pendingPatches.push(patches);
  }

  return createDispatch<S, A, E>({
    reduce: getTT()
      ? (s, a) => {
        const tt = getTT()!;
        if (tt.paused) {
          log.debug(
            `time-travel: paused, dropping action ${
              (a as { type?: string }).type ?? "?"
            }`,
          );
          return { state: s, effects: [] as E[] };
        }
        const result = hookedReduce(s, a);
        _collectPatches(result);
        const actionType = (a as { type?: string }).type ?? "";
        if (!isInternalAction(actionType)) {
          setTT(
            record(
              tt,
              a as unknown as { type: string },
              result.state,
              undefined,
            ),
          );
          getServer().broadcastTT();
        }
        return result;
      }
      : (s, a) => {
        const result = hookedReduce(s, a);
        _collectPatches(result);
        return result;
      },
    execute: (effect) => {
      if (isScheduleEffect(effect)) {
        scheduleManager.handle(effect as ScheduleEffect);
        return;
      }
      if (isOwnEffect(effect)) {
        ownManager.handle(effect);
        return;
      }
      hookedExecute(getApp(), effect as E);
    },
    getState,
    setState,
    onDone: () => {
      const processed = _anyProcessed;
      _anyProcessed = false;
      const patches = _pendingPatches;
      _pendingPatches = [];
      if (!processed) return;
      const tt = getTT();
      if (!tt?.paused) schedulePersist();
      const validPatches = patches.length > 0 && cellPatchStrategies
        ? filterPatchesByStrategy(
          patches,
          cellPatchStrategies,
          cellFilterFields ?? new Map(),
        )
        : (patches.length > 0 ? patches : undefined);
      getServer().broadcast(validPatches);
      if (onUdsBroadcast) onUdsBroadcast(validPatches);
    },
    log,
    debug,
    reportOpts,
    perfCheck: deps.perfCheck,
    perfBudget: deps.perfBudget,
    perfLog: deps.perfLog,
    freezeState: deps.freezeState,
    effectTimeout: deps.effectTimeout,
    onPerf: deps.onPerf,
    reduceBreakdown: deps.reduceBreakdown,
    afterAction: deps.afterAction as
      | ((prev: S, next: S, action: A) => void)
      | undefined,
  });
}
