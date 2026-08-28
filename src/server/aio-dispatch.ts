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
import type { ScheduleEffect } from "../state/schedule.ts";
import type { OwnEffect } from "../state/own.ts";
import { routeEffect } from "../state/route-effect.ts";
import { diagEmit } from "../diagnostics/diagnostic-bus.ts";
import { runWithUser } from "./auth-context.ts";

/** User identity — mirrors AioUser from aio.ts without circular import */
type User = { id: string; role: string };

/** Patch entry — cell name + immer ops from a single reduce call */
export type PatchEntry = {
  cell: string;
  ops: import("../protocol/patch-ops.ts").WirePatch[];
};

/** Row-level change information for ONE dispatch batch, in the shape
 *  persistence consumes (perf audit P8): every cell that was written in the
 *  batch → its Immer ops, in commit order, UNFILTERED (the client-facing
 *  `patch` strategy filter is a broadcast concern, not a durability one).
 *
 *  What a consumer may rely on:
 *  - a cell absent from the map was not written in this batch;
 *  - each op's `path` is relative to the CELL's state: for a `db:` table the
 *    row is `path[1]` under `path[0] === <table>` (`["users", "u1", "name"]`
 *    → row `u1` of `users`), so a one-row write no longer needs a whole-table
 *    clone-and-diff;
 *  - a `path` of length `< 2` under a table (`["users"]`, `[]`) means the
 *    table — or the cell — was replaced wholesale: fall back to the full diff
 *    for that table;
 *  - the map is a fresh object per batch and is never mutated after `onDone`
 *    hands it over; a consumer that debounces accumulates across batches
 *    itself.
 *
 *  Passed to `schedulePersist(cellPatches)`. `undefined` there means "no
 *  patch information for this write" — restore, time-travel and the boot
 *  persist assign state directly — and MUST be treated as "diff everything". */
export type CellPatches = ReadonlyMap<
  string,
  readonly import("../protocol/patch-ops.ts").WirePatch[]
>;

/** Group a batch's patch entries per cell, in commit order. Pure. */
export function groupCellPatches(entries: readonly PatchEntry[]): CellPatches {
  const out = new Map<string, import("../protocol/patch-ops.ts").WirePatch[]>();
  for (const { cell, ops } of entries) {
    if (ops.length === 0) continue;
    const list = out.get(cell);
    if (list) list.push(...ops);
    else out.set(cell, [...ops]);
  }
  return out;
}

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
  onEffect?: (effect: E, state: S, user?: User) => void;
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
  /** Persist after a batch. Receives the batch's row-level patch information
   *  ({@link CellPatches}); a consumer that ignores the argument diffs whole
   *  tables exactly as before. */
  schedulePersist: (cellPatches?: CellPatches) => void;
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
  /** Exact action types omitted from time-travel history (diagnostics
   *  `skipActions`) — framework-internal suffixes are always skipped. */
  ttSkipActions?: Set<string>;
  /** Accepted and unused since alpha70: the drain gate no longer counts
   *  pending calls (it reads the `_inflight` flag on the action instead —
   *  dispatch.ts INFLIGHT), so there is nothing left to scope.
   *  ASK(alpha70): drop the `cellNames:` line from aio.ts's setupDispatch
   *  call, then this field. */
};

// Internal action types to hide from time-travel history (framework noise).
//
// `:__set` is NOT in this list, and must not be put back. An async or
// transactional method commits everything it wrote as one atomic
// `cell:__setMethod`; hiding it meant time travel recorded the state BEFORE the
// write and never the state after. `undo` therefore restored a state the app
// had never been in, and in the `undo`-then-`redo` shape the committed write
// was destroyed outright — the history had no entry that contained it.
//
// Time travel's contract is that every entry is a state the app really had.
// Anything that CHANGED state belongs in it; only markers that change nothing
// (`:__exec`) or that carry a transition the user cannot meaningfully step
// through (`:__error`) are noise.
const TT_SKIP_SUFFIXES = [":__exec"];
const TT_SKIP_CONTAINS = [":__error"];
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
 *    4. onEffect(effect, state, user)     — observe each effect before execution
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

  // Effects triggered by a user's action execute AS that user — always, not
  // only when the app happens to configure an unrelated `onEffect` hook.
  //
  // The identity wrap used to live inside the `onEffect ? … : …` ternary, so
  // with no hook (the default) effects ran outside the ALS scope. An async
  // cell method's body IS an effect (`cell:__exec`), which made
  // `serverUser()` `undefined` inside every async method in production —
  // while adding a no-op `onEffect: () => {}` made the same method see
  // "alice". `auth-context.ts` and the API reference both advertise
  // serverUser() as usable in effects, and the test harness wraps whole
  // `t.as()` bodies itself, so the harness was more permissive than prod:
  // a green test over a broken path.
  const hookedExecute = (app: App, e: E) => {
    if (onEffect) {
      try {
        // (effect, state, user) — positional parity with onAction.
        onEffect(e, getState(), _currentActionUser);
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
    }
    return runWithUser(_currentActionUser, () => deps.execute(app, e));
  };

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
        // NOTE: the paused check that used to live here is gone, deliberately.
        // Returning unchanged state from reduce made a dropped action look
        // SUCCESSFUL to its caller. The refusal now happens at the dispatch
        // door (`isPaused` below → createDispatch), which is the only place
        // that still holds the caller's promise and can reject it.
        const result = hookedReduce(s, a);
        _collectPatches(result);
        const actionType = (a as { type?: string }).type ?? "";
        if (
          !isInternalAction(actionType) &&
          !deps.ttSkipActions?.has(actionType)
        ) {
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
    execute: (effect) =>
      // ONE exhaustive classifier for all three effect runtimes — a new
      // framework effect kind is a compile error here (see route-effect.ts).
      routeEffect<E>(effect, {
        schedule: (e) => scheduleManager.handle(e),
        own: (e) => ownManager.handle(e),
        app: (e) => hookedExecute(getApp(), e),
      }),
    getState,
    setState,
    onDone: () => {
      const processed = _anyProcessed;
      _anyProcessed = false;
      const patches = _pendingPatches;
      _pendingPatches = [];
      if (!processed) return;
      const tt = getTT();
      // Row-level information rides along with the persist request: the
      // patches already name the rows a batch touched (perf audit P8), so
      // persistence need not clone-and-diff a whole `db:` table to find them.
      if (!tt?.paused) schedulePersist(groupCellPatches(patches));
      // NOTHING CHANGED → NOTHING TO SEND. A dispatch that produces no patches
      // (an idempotent reducer: "the device is still absent", "the poll found
      // the same value") used to fall through to the full-state branch, which
      // resends the ENTIRE state whenever any other field has moved since the
      // last full send. With a 1s clock cell that condition is always true, so
      // every no-op poll cost a full-state broadcast: one app measured a 438 KB
      // frame every ~2s — 12 MB in 20 seconds — for state that had not
      // meaningfully changed. Writing reducers that avoid pointless writes is
      // the RIGHT thing for an app to do; the framework must not punish it.
      //
      // Patches that exist but are all filtered out by cell strategy still
      // fall through to full state below — that fallback is what "full"
      // strategy cells depend on.
      if (patches.length === 0) return;
      const validPatches = cellPatchStrategies
        ? filterPatchesByStrategy(
          patches,
          cellPatchStrategies,
          cellFilterFields ?? new Map(),
        )
        : patches;
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
    // Read per dispatch, never captured: `record()` returns a NEW TTState
    // object for every action, so a value captured here would be a stale
    // snapshot that never reports a pause.
    isPaused: () => getTT()?.paused === true,
  });
}
