// Shared dispatch loop — used by both aio.ts (server) and standalone.ts (Android)
// Re-entrant-safe: effects can call dispatch(), actions are queued and drained in order
import type { ScheduleEffect } from "./schedule.ts";
import type { ReduceBreakdown } from "./time-travel.ts";
import {
  type AioErrorCode,
  clearCorrelationId,
  createAioError,
  generateCorrelationId,
  reportError as reportAioError,
  type ReportErrorOpts,
  setCorrelationId,
} from "./error.ts";
import { diagEmit } from "./diagnostic-bus.ts";
export type { AioError } from "./error.ts";

/** Performance check — on: warn on violations, off: silent */
export type PerfCheck = "on" | "off";

/** @deprecated Use PerfCheck instead */
export type PerfMode = "strict" | "soft";

/** Performance budgets in milliseconds */
export type PerfBudget = {
  reduce?: number; // default: 100 — "feels instant" threshold
  effect?: number; // default: 5 — sync portion only, async by definition doesn't block
};

/** Per-action performance timing */
export type PerfTiming = {
  actionType: string;
  reduce: number;
  effects: number;
  budget: { reduce: number; effect: number };
  breakdown?: ReduceBreakdown;
};

/** Default budgets */
const DEFAULT_REDUCE_BUDGET = 100;
const DEFAULT_EFFECT_BUDGET = 5;

/** Deep freeze for dev mode immutability checking */
export function deepFreeze<T>(obj: T, _seen?: WeakSet<object>): T {
  if (obj === null || typeof obj !== "object") return obj;
  if (Object.isFrozen(obj)) return obj;
  const seen = _seen ?? new WeakSet();
  if (seen.has(obj as object)) return obj; // cycle guard
  seen.add(obj as object);
  Object.freeze(obj);
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    const val = (obj as Record<string, unknown>)[key];
    if (val !== null && typeof val === "object") deepFreeze(val, seen);
  }
  return obj;
}

/** Safety limit — prevents infinite effect→dispatch loops */
const DISPATCH_MAX = 1000;
/** Queue depth limit — prevents unbounded memory growth from burst dispatches */
const QUEUE_MAX = 10_000;

/** Dependencies injected into the dispatch loop by the host runtime */
export type DispatchDeps<S, A, E> = {
  reduce: (
    state: S,
    action: A,
  ) => { state: S; effects: (E | ScheduleEffect)[] };
  execute: (effect: E | ScheduleEffect) => void | Promise<void>;
  getState: () => S;
  setState: (s: S) => void;
  onDone: () => void; // called once after queue fully drains (persist + broadcast)
  log: {
    debug: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  debug: boolean;
  reportOpts?: Partial<ReportErrorOpts>;
  onPerf?: (timing: PerfTiming) => void; // called after each action with timing
  /** Write to perf.log — deduped by action type, once per violation */
  perfLog?: (
    source: "reduce" | "effect",
    type: string,
    duration: number,
    budget: number,
    breakdown?: ReduceBreakdown,
  ) => void;
  perfCheck?: PerfCheck;
  perfBudget?: PerfBudget;
  freezeState?: boolean; // deep freeze state after reduce in dev mode
  afterAction?: (prev: S, next: S, action: A) => void; // diagnostics hook — called after setState
  effectTimeout?: number; // ms before warning on a slow async effect (default: 30000, 0 = disabled)
  /** Optional getter for reduce phase breakdown — provided by composeFeatures when perfCheck is on */
  reduceBreakdown?: () => ReduceBreakdown | undefined;
};

/** Dispatch function with close() to reject further actions.
 *  Returns Promise<void> that resolves after action is fully processed (reduce + sync effects). */
type DispatchFn<A> = ((action: A) => Promise<void>) & {
  close: () => void;
  errorCount: () => number;
  getQueueDepth: () => number;
  getEffectBacklog: () => number;
};

/** Creates a re-entrant-safe dispatch loop that drains queued actions in order */
export function createDispatch<S, A, E>(
  deps: DispatchDeps<S, A, E>,
): DispatchFn<A> {
  const {
    reduce,
    execute,
    getState,
    setState,
    onDone,
    log,
    onPerf,
    perfLog,
    perfCheck,
    perfBudget,
    freezeState,
  } = deps;
  const getBreakdown = deps.reduceBreakdown;
  const effectTimeout = deps.effectTimeout ?? 30_000; // 0 = disabled
  const perfEnabled = perfCheck !== "off"; // default: on
  const reduceBudget = perfBudget?.reduce ?? DEFAULT_REDUCE_BUDGET;
  const effectBudget = perfBudget?.effect ?? DEFAULT_EFFECT_BUDGET;
  let dispatching = false;
  let closed = false;
  let errors = 0;
  let depth = 0; // global re-entrant depth counter (survives across dispatch calls)
  let effectsInFlight = 0;
  const queue: { action: A; resolve: () => void; cid: string }[] = [];

  const _reportOpts: ReportErrorOpts = {
    onError: deps.reportOpts?.onError,
    logger: deps.reportOpts?.logger,
    tt: deps.reportOpts?.tt,
    countError: () => {
      errors++;
    },
    prod: deps.reportOpts?.prod,
  };

  function tag(v: unknown): string {
    const o = v as Record<string, unknown>;
    return `${o?.type ?? "?"} ${JSON.stringify(o?.payload ?? {})}`;
  }

  function reportPerf(
    source: "reduce" | "effect",
    duration: number,
    budget: number,
    type?: string,
  ): void {
    if (!perfEnabled) return;
    const code: AioErrorCode = source === "reduce"
      ? "BUDGET_REDUCE"
      : "BUDGET_EFFECT";
    const err = createAioError(
      code,
      `${source} exceeded budget: ${duration.toFixed(1)}ms > ${budget}ms`,
      { featureName: type?.split(":")[0], actionType: type, duration, budget },
    );
    reportAioError(err, _reportOpts);
    if (perfLog) {
      perfLog(source, type ?? "unknown", duration, budget, getBreakdown?.());
    }
  }

  function dispatch(action: A): Promise<void> {
    if (closed) {
      log.warn("dispatch after close() — ignored");
      return Promise.resolve();
    }
    if (queue.length >= QUEUE_MAX) {
      const err = createAioError(
        "QUEUE_OVERFLOW",
        `dispatch queue depth exceeded (${QUEUE_MAX})`,
        { actionType: (action as Record<string, unknown>)?.type as string },
      );
      reportAioError(err, _reportOpts);
      return Promise.resolve();
    }
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    const cid = generateCorrelationId();
    queue.push({ action, resolve, cid });
    if (dispatching) return promise;
    dispatching = true;

    let iterations = 0;
    let overflowed = false;
    depth++;
    for (;;) { // outer loop: drain queue → onDone → re-drain if onDone queued more
      while (queue.length > 0) {
        if (++iterations > DISPATCH_MAX) {
          const err = createAioError(
            "DISPATCH_LOOP",
            `dispatch overflow (${DISPATCH_MAX} iterations, depth ${depth}) — possible infinite loop`,
            { actionType: tag(queue[0]!.action) },
          );
          reportAioError(err, _reportOpts);
          for (const entry of queue) entry.resolve();
          queue.length = 0;
          try {
            onDone();
          } catch (e) {
            const err2 = createAioError("EFFECT_ERROR", e, {
              actionType: "onDone",
            });
            reportAioError(err2, _reportOpts);
          }
          clearCorrelationId();
          overflowed = true;
          closed = true;
          break;
        }
        const entry = queue.shift()!;
        setCorrelationId(entry.cid);
        const current = entry.action;
        if (deps.debug) log.debug(`action → reduce: ${tag(current)}`);

        let reduced: { state: S; effects: (E | ScheduleEffect)[] };
        const actionType = (current as Record<string, unknown>)?.type as
          | string
          | undefined;

        // Measure reduce time
        const reduceStart = performance.now();
        try {
          reduced = reduce(getState(), current);
        } catch (e) {
          const err = createAioError("REDUCE_ERROR", e, {
            featureName: actionType?.split(":")[0],
            actionType,
          }, getState() as Record<string, unknown>);
          reportAioError(err, _reportOpts);
          entry.resolve();
          clearCorrelationId();
          continue;
        }
        const reduceDuration = performance.now() - reduceStart;

        // Track total effect time for this action
        let totalEffectDuration = 0;

        // Check reduce performance budget
        if (reduceDuration > reduceBudget) {
          reportPerf("reduce", reduceDuration, reduceBudget, actionType);
        }

        if (
          !reduced || typeof reduced !== "object" || !("state" in reduced) ||
          !Array.isArray(reduced.effects)
        ) {
          const err = createAioError(
            "REDUCE_ERROR",
            `reduce() must return { state, effects[] } — got ${
              JSON.stringify(reduced)
            }`,
            { featureName: actionType?.split(":")[0], actionType },
          );
          reportAioError(err, _reportOpts);
          entry.resolve();
          clearCorrelationId();
          continue;
        }

        // Deep-clone effects to detach from Immer draft references.
        // Without this, effects created inside produce() hold revoked draft refs
        // that crash on JSON.stringify or property access after produce() finalizes.
        // Clone individually so one non-cloneable effect doesn't drop all (AIO-139).
        if (reduced.effects.length) {
          const cloned: (E | ScheduleEffect)[] = [];
          for (const eff of reduced.effects) {
            try {
              cloned.push(structuredClone(eff));
            } catch (cloneErr) {
              // Try JSON round-trip as fallback — WARNING: loses undefined, NaN, Infinity, Date
              try {
                const jsoned = JSON.parse(JSON.stringify(eff));
                // AIO-272: warn when JSON fallback is used — data loss occurred
                console.warn(
                  `[aio:dispatch] effect clone fallback for "${
                    tag(current)
                  }" — ` +
                    `undefined, NaN, Infinity, Date values become null. ` +
                    `Original error: ${
                      cloneErr instanceof Error
                        ? cloneErr.message
                        : String(cloneErr)
                    }`,
                );
                cloned.push(jsoned);
              } catch {
                const err = createAioError(
                  "EFFECT_ERROR",
                  `effect not cloneable for ${
                    tag(current)
                  } — revoked Immer draft refs will crash downstream. ` +
                    `Ensure effects are plain objects, not derived from the draft. ` +
                    `Original: ${
                      cloneErr instanceof Error
                        ? cloneErr.message
                        : String(cloneErr)
                    }`,
                  {
                    featureName: actionType?.split(":")[0],
                    actionType,
                  },
                );
                reportAioError(err, _reportOpts);
                cloned.push(eff);
              }
            }
          }
          reduced = { ...reduced, effects: cloned };
        }

        const prev = getState();
        const nextState = freezeState
          ? deepFreeze(reduced.state)
          : reduced.state;
        setState(nextState);
        if (
          deps.debug && prev !== reduced.state &&
          typeof reduced.state === "object" && reduced.state &&
          typeof prev === "object" && prev
        ) {
          const changed = Object.keys(reduced.state as Record<string, unknown>)
            .filter((k) =>
              (reduced.state as Record<string, unknown>)[k] !==
                (prev as Record<string, unknown>)[k]
            );
          if (changed.length) {
            log.debug(`state: changed [${changed.join(", ")}]`);
          }
        }
        if (deps.afterAction) deps.afterAction(prev as S, nextState, current);

        for (const effect of reduced.effects) {
          if (
            !effect ||
            typeof (effect as Record<string, unknown>).type !== "string"
          ) {
            log.warn(
              `reducer returned invalid effect (missing .type string) — skipping. Action was: ${
                tag(current)
              }`,
            );
            diagEmit({
              type: "effect-invalid",
              severity: "warning",
              source: "dispatch",
              message: `Invalid effect skipped (missing .type) from action '${
                tag(current)
              }'`,
              detail: { actionType: tag(current) },
              hint:
                "Effects must be plain objects with a .type string. Check your reducer return value.",
            });
            continue;
          }
          if (deps.debug) log.debug(`effect → execute: ${tag(effect)}`);

          const effectType = (effect as Record<string, unknown>)?.type as
            | string
            | undefined;
          const effectStart = performance.now();

          try {
            const r = execute(effect);
            const effectDuration = performance.now() - effectStart;
            totalEffectDuration += effectDuration;

            // Check effect performance budget (sync portion only)
            // Async effects return promises immediately — we measure sync time
            if (effectDuration > effectBudget) {
              reportPerf("effect", effectDuration, effectBudget, effectType);
            }

            // catch rejected promises from async effects + hard timeout
            if (r && typeof (r as Promise<void>).catch === "function") {
              effectsInFlight++;
              const promise = r as Promise<void>;
              // Capture CID now — async callbacks fire after clearCorrelationId()
              const asyncCid = entry.cid;
              // Hard timeout: report error and stop tracking the effect.
              // The underlying promise may still complete, but the framework
              // considers the effect failed after effectTimeout ms.
              let settled = false;
              const tid = effectTimeout > 0
                ? setTimeout(() => {
                  if (settled) return;
                  effectsInFlight--;
                  settled = true;
                  const err = createAioError(
                    "EFFECT_TIMEOUT",
                    `async effect hard-timeout: ${
                      effectType ?? "?"
                    } exceeded ${effectTimeout}ms — effect abandoned`,
                    {
                      featureName: effectType?.split(":")[0],
                      effectType,
                      duration: effectTimeout,
                      budget: effectTimeout,
                    },
                    undefined,
                    asyncCid,
                  );
                  reportAioError(err, _reportOpts);
                }, effectTimeout)
                : null;
              promise
                .then(() => {
                  if (tid !== null) clearTimeout(tid);
                  if (!settled) effectsInFlight--;
                  settled = true;
                })
                .catch((e) => {
                  if (tid !== null) clearTimeout(tid);
                  if (!settled) effectsInFlight--;
                  if (settled) { // AIO-235: log real error even after timeout
                    log.warn(
                      `async effect '${
                        effectType ?? "?"
                      }' rejected after timeout: ${
                        e instanceof Error ? e.message : String(e)
                      }`,
                    );
                    return;
                  }
                  settled = true;
                  const err = createAioError(
                    "EFFECT_ASYNC_ERROR",
                    e,
                    {
                      featureName: effectType?.split(":")[0],
                      actionType,
                      effectType,
                    },
                    undefined,
                    asyncCid,
                  );
                  reportAioError(err, _reportOpts);
                });
            }
          } catch (e) {
            const err = createAioError("EFFECT_ERROR", e, {
              featureName: effectType?.split(":")[0],
              actionType,
              effectType,
            });
            reportAioError(err, _reportOpts);
          }
        }

        // Report per-action performance timing
        if (onPerf && actionType) {
          onPerf({
            actionType,
            reduce: reduceDuration,
            effects: totalEffectDuration,
            budget: { reduce: reduceBudget, effect: effectBudget },
            breakdown: getBreakdown?.(),
          });
        }
        entry.resolve();
        clearCorrelationId();
      }

      // onDone (persist + broadcast) runs while dispatching=true so re-entrant dispatches queue
      // Skip if overflow already called onDone (AIO-118: avoid double call)
      if (!overflowed) {
        try {
          onDone();
        } catch (e) {
          const err = createAioError("EFFECT_ERROR", e, {
            actionType: "onDone",
          });
          reportAioError(err, _reportOpts);
        }
      }
      // If onDone queued new actions, loop back to drain them
      // AIO-229: also break on overflow to prevent infinite loop if onDone dispatches
      if (queue.length === 0 || overflowed) break;
    } // end outer loop
    depth--;
    dispatching = false;
    return promise;
  }

  dispatch.close = () => {
    closed = true;
  };
  dispatch.errorCount = () => errors;
  dispatch.getQueueDepth = () => queue.length;
  dispatch.getEffectBacklog = () => effectsInFlight;
  return dispatch as DispatchFn<A>;
}
