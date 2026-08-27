// Shared dispatch loop — used by both aio.ts (server) and standalone.ts (Android)
// Re-entrant-safe: effects can call dispatch(), actions are queued and drained in order
import type { ScheduleEffect } from "./schedule.ts";
import type { OwnEffect } from "./own.ts";
import { pendingCallsFor } from "./method-cancel.ts";
import { isFrameworkCell } from "./framework-cells.ts";
import type { ReduceBreakdown } from "../diagnostics/time-travel.ts";
import {
  type AioError,
  type AioErrorCode,
  clearCorrelationId,
  createAioError,
  generateCorrelationId,
  reportError as reportAioError,
  type ReportErrorOpts,
  setCorrelationId,
} from "../diagnostics/error.ts";
import { diagEmit } from "../diagnostics/diagnostic-bus.ts";
export type { AioError } from "../diagnostics/error.ts";

/** Performance check — on: warn on violations, off: silent */
export type PerfCheck = "on" | "off";

/** Performance budgets in milliseconds */

/** `"cell:method"` for an async-method exec effect, else null.
 *  Async methods all arrive as `<cell>:__exec`, so the method name has to come
 *  from the payload for a per-method budget to be addressable. */
function methodBudgetKey(effect: unknown): string | null {
  const e = effect as { type?: string; payload?: { _method?: unknown } };
  if (typeof e?.type !== "string" || !e.type.endsWith(":__exec")) return null;
  const method = e.payload?._method;
  if (typeof method !== "string") return null;
  return `${e.type.slice(0, -":__exec".length)}:${method}`;
}

/** THE per-method budget key for one effect — the single decider for both
 *  `perfBudget.methods[key]` lookups and the violation message's escape hatch.
 *
 *  Two shapes reach here and BOTH are a cell method:
 *   - an async method: the reducer turns `cell:method` into a `cell:__exec`
 *     effect carrying `payload._method`, so the key comes from the effect;
 *   - a sync method: its effects are the app's own `{type}` objects and carry
 *     no method name at all — but the ACTION that produced them is exactly
 *     `<cell>:<method>`, which is the same key. Without this fallback a slow
 *     effect from a sync method reported a violation whose only visible fix was
 *     raising the GLOBAL budget (the "lost the signal everywhere to silence one
 *     poller" report), while the identical async method had a per-method hatch.
 *
 *  Internal action types (`cell:__exec`, `cell:__set*`, `cell:__destroy`) and
 *  non-namespaced ones are excluded: they name no method, so no per-method
 *  budget can legitimately be declared for them (`aio.run` validates the keys
 *  against the real method lists). A miss is just `undefined` — lookup only. */
function budgetKeyFor(effect: unknown, actionType?: string): string | null {
  const fromEffect = methodBudgetKey(effect);
  if (fromEffect) return fromEffect;
  if (typeof actionType !== "string") return null;
  return /^[^:\s]+:[^:\s]+$/.test(actionType) && !actionType.includes(":__")
    ? actionType
    : null;
}

/** A concrete per-method budget to suggest for an observed duration: the next
 *  10ms step at/above 2× what it actually took, so the number in the message is
 *  one a legitimate one-off can actually live with (14ms → 30, not 15). */
function suggestBudget(duration: number): number {
  return Math.max(10, Math.ceil((duration * 2) / 10) * 10);
}

/** Per-dispatch time budgets (ms). Exceeding one is reported, never enforced:
 *  a slow reducer is a diagnosis, not a reason to drop the user's action. */
export type PerfBudget = {
  reduce?: number; // default: 100 — "feels instant" threshold
  effect?: number; // default: 5 — sync portion only, async by definition doesn't block
  /** Per-method overrides, keyed `"cell:method"`.
   *
   *  The global budget answers "did this block the loop", and for most methods
   *  that is the whole story. But a method whose job IS to take minutes — spawn
   *  cmake, read a 2 MB header, drain a subprocess — makes the app choose between
   *  a stream of violations on every poll tick and raising the budget globally,
   *  which blinds every tight reducer at once. One app ended up at
   *  `{ reduce: 100, effect: 1000 }` + `effectTimeoutMs: 30_000` "and lost the
   *  signal everywhere to silence one poller".
   *
   *  ```ts
   *  perfBudget: {
   *    effect: 5,                                   // everything stays strict…
   *    methods: {
   *      "builds:compile": { effect: 5_000, timeout: 600_000 }, // …except this
   *      "hw:poll": { effect: 250 },
   *    },
   *  }
   *  ```
   *  `timeout` also raises the hard abandon-the-effect deadline for that method
   *  only, so a four-minute build no longer needs a four-minute global timeout.
   *
   *  Covers BOTH method flavours: an async method's `__exec` effect (keyed from
   *  the effect payload) and the effects a SYNC method returns (keyed from the
   *  action, which is `cell:method` either way) — see {@link budgetKeyFor}. */
  methods?: Record<
    string,
    {
      effect?: number;
      /** A number raises this method's hard deadline; `"warn"` removes it —
       *  the caller-side wait reports once at the default ceiling and keeps
       *  waiting instead of rejecting a method that is still running. */
      timeout?: number | "warn";
    }
  >;
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

/** One animation frame. Dev uses this as the reduce budget (aio.ts) — the
 *  server's dispatch path is shared by every client, so a reduce that takes
 *  longer than a frame is a delay everyone feels. Prod keeps the 100ms
 *  "feels instant" budget. */
export const DEV_FRAME_BUDGET_MS = 16;

/** Deep freeze for dev mode immutability checking.
 *
 *  Re-exported, not reimplemented: this was one of THREE hand-written
 *  `deepFreeze`s that had drifted apart (see `state/immutable.ts`). */
export { deepFreeze } from "./immutable.ts";
import { deepFreeze } from "./immutable.ts";

/** Queue depth limit — prevents unbounded memory growth from burst dispatches.
 *  THE number: whatever the queue is allowed to hold, the drain must be
 *  allowed to process. */
const QUEUE_MAX = 10_000;
/** Safety limit — prevents infinite effect→dispatch loops.
 *
 *  It was 1000 against a queue of 10 000, which is two answers to "how many
 *  actions may exist at once": a legitimate 1500-action effect cascade (a bulk
 *  import fanning out per row) filled the queue happily and then had 501 of
 *  its actions REJECTED as a "possible infinite loop" — an accusation the app
 *  could do nothing about, because the queue itself had said yes. Loud and
 *  recoverable, but wrong. The loop guard is the same bound as the queue: past
 *  it, something really is generating actions without end. */
const DISPATCH_MAX = QUEUE_MAX;

/** Dependencies injected into the dispatch loop by the host runtime */
export type DispatchDeps<S, A, E> = {
  reduce: (
    state: S,
    action: A,
  ) => { state: S; effects: (E | ScheduleEffect | OwnEffect)[] };
  execute: (effect: E | ScheduleEffect | OwnEffect) => void | Promise<void>;
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
  /** Optional getter for reduce phase breakdown — provided by composeCells when perfCheck is on */
  reduceBreakdown?: () => ReduceBreakdown | undefined;
  /** THIS app's cell names. Scopes the drain gate's pending-call count to the
   *  owning app — with two apps in one process (D2), a closed queue must not
   *  stay open on the other app's in-flight calls. */
  cellNames?: Set<string>;
  /** True while time travel is PAUSED (undo/redo/goto all pause). An action
   *  dispatched then is not applied, so it must be refused HERE — at the queue
   *  door, where a refusal can reject the caller's promise — rather than
   *  swallowed later during reduce. See the gate in `dispatch()`. */
  isPaused?: () => boolean;
};

/** Dispatch function with close() to reject further actions.
 *  Resolves after the action is fully processed (reduce + sync effects) with
 *  the method's transported return value, or undefined (AIO-427). */
type DispatchFn<A> = ((action: A) => Promise<unknown>) & {
  close: () => void;
  /** Await in-flight effects, then SEAL the queue. `timeoutMs` bounds the
   *  wait — an effect that ignores its abort signal must not hold shutdown
   *  open (0 = wait forever, the pre-alpha44 behaviour). */
  drain: (timeoutMs?: number) => Promise<void>;
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
  // Sealed = closed AND done draining: after this nothing lands, effect or
  // not. `close()` alone only shuts the door on new input (see below).
  let sealed = false;
  // a field report: warn once per action TYPE after close — a shutdown
  // used to emit one identical warn line per queued tick (hundreds/ms).
  const closedWarnedTypes = new Set<string>();
  let closedDropCount = 0;
  let errors = 0;
  let depth = 0; // global re-entrant depth counter (survives across dispatch calls)
  let effectsInFlight = 0;
  const effectPromises = new Set<Promise<void>>();
  // Per-dispatch-instance set: a reducer that returns an invalid effect does
  // so for every dispatch of that action — warn once per action type instead
  // of flooding the log. Moved off the module level so a second aio.run() in
  // the same process (or a subsequent test) doesn't silently suppress the
  // warning for action types already seen.
  const warnedInvalidEffect = new Set<string>();
  // Same treatment for a throwing afterAction hook: it throws for every action
  // of that type, and the failure is observe-only — one report per type, plus a
  // running count so a suppressed storm is still visible.
  const hookFailures = new Map<string, number>();
  type QueueEntry = {
    action: A;
    resolve: (value?: unknown) => void; // AIO-427: carries a method's return value
    reject: (e: AioError) => void;
    cid: string;
  };
  const queue: QueueEntry[] = [];

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
    // A label must never be the thing that throws: JSON.stringify dies on a
    // BigInt or a cycle, and tag() is called from the error and debug paths —
    // i.e. exactly when the payload is already unusual.
    let payload: string;
    try {
      payload = JSON.stringify(o?.payload ?? {}, (_k, val) =>
        typeof val === "bigint" ? `${val}n` : val) ?? "undefined";
    } catch {
      payload = "[unserializable payload]";
    }
    return `${o?.type ?? "?"} ${payload}`;
  }

  function reportPerf(
    source: "reduce" | "effect",
    duration: number,
    budget: number,
    type?: string,
    /** The `cell:method` this effect belongs to, when it has one — the key of
     *  the per-method budget that can raise the ceiling for THIS method alone.
     *  A violation that never names its own escape hatch reads as "your app is
     *  defective", and the only visible move is raising the global budget,
     *  which blinds every tight reducer at once. */
    methodKey?: string | null,
  ): void {
    if (!perfEnabled) return;
    // The framework's OWN cells are measured, never billed to the app.
    //
    // `updates:check` is one network round-trip at boot; on a cold DNS it
    // takes 5.5 ms and blew a 5 ms effect budget, so a healthy hello-world
    // greeted its author with three red framework ERRORs advising a
    // `perfBudget` override for a method they did not write and cannot change.
    // A diagnostic nobody can act on is noise, and noise is how the ones that
    // matter get ignored. Still recorded in perf.log (below) — observable, not
    // an error.
    const perfCell = type?.split(":")[0];
    if (isFrameworkCell(perfCell)) {
      if (perfLog) {
        perfLog(source, type ?? "unknown", duration, budget, getBreakdown?.());
      }
      return;
    }
    const code: AioErrorCode = source === "reduce"
      ? "BUDGET_REDUCE"
      : "BUDGET_EFFECT";
    const hatch = source === "effect" && methodKey
      ? `. Legitimately slow just here? Raise the budget for THIS method only: ` +
        `perfBudget: { methods: { "${methodKey}": { effect: ${
          suggestBudget(duration)
        } } } } — every other effect stays strict`
      : "";
    const err = createAioError(
      code,
      `${source} exceeded budget: ${duration.toFixed(1)}ms > ${budget}ms` +
        (source === "effect"
          // FACT only. The remedy for this code lives in ONE place —
          // `errorTip()` in diagnostics/error.ts — because two half-overlapping
          // pieces of advice on one violation read as two different problems.
          // What belongs here is what only the dispatcher knows: which part of
          // an async method was measured, and the per-method hatch below.
          ? " (async method: only the SYNC prefix before the first await counts here)"
          : "") +
        hatch,
      { cellName: type?.split(":")[0], actionType: type, duration, budget },
    );
    reportAioError(err, _reportOpts);
    if (perfLog) {
      perfLog(source, type ?? "unknown", duration, budget, getBreakdown?.());
    }
  }

  /** An observe-only hook failed. The action is already committed, so this is
   *  never fatal and never rejects the caller — but it is never swallowed
   *  either: the hook's whole output (a diff line, a journal entry, a timeline
   *  frame) is missing for this action, and only this report says so. */
  function reportHookFailure(e: unknown, action: A): void {
    const actionType = String(
      (action as Record<string, unknown>)?.type ?? "(unknown)",
    );
    const n = (hookFailures.get(actionType) ?? 0) + 1;
    hookFailures.set(actionType, n);
    if (n > 1) return; // already reported for this action type
    const err = createAioError(
      "HOOK_ERROR",
      `afterAction hook threw for '${actionType}' — the action itself was ` +
        `applied, but this action is MISSING from everything the hook feeds ` +
        `(state diffs, action log, checkpoint, journal, timeline). ` +
        `Observe-only hooks never break dispatch, so this was reported and ` +
        `swallowed (further failures of this action type are counted, not ` +
        `logged). Original: ${e instanceof Error ? e.message : String(e)}`,
      { cellName: actionType.split(":")[0], actionType },
    );
    reportAioError(err, _reportOpts);
    diagEmit({
      type: "hook-error",
      severity: "error",
      source: "dispatch",
      message: `afterAction hook threw for '${actionType}': ${
        e instanceof Error ? e.message : String(e)
      }`,
      detail: { actionType },
      hint:
        "Diagnostics/journal/timeline for this action are lost. Common cause: a value in state that JSON cannot serialize (BigInt, a class instance, a cycle).",
    });
  }

  // B-4: a dropped action must REJECT, not resolve — `await cell.method()` has
  // to learn the state change was never applied. Awaiters get the rejection;
  // a no-op .catch keeps fire-and-forget callers from surfacing an unhandled
  // rejection (same policy as the browser ack wrapper, cell-reactive.ts).
  function rejectDropped(err: AioError): Promise<void> {
    const p = Promise.reject<void>(err);
    p.catch(() => {});
    return p;
  }

  /** Action types already warned about while paused — one line per type, like
   *  the closed-dispatch path. A paused app with a 1s clock cell would
   *  otherwise fill the log while the developer reads the panel. */
  const pausedWarnedTypes = new Set<string>();

  function dispatch(action: A): Promise<unknown> {
    // TIME TRAVEL PAUSED — refuse, don't pretend.
    //
    // This drop used to happen inside `reduce`, which returned the state
    // unchanged. By then the action had been accepted, so the caller's promise
    // settled as SUCCESS with nothing applied — and an async method, whose
    // result rides a later commit that now never comes, hung for the full call
    // timeout and then rejected with a message that was simply false ("it may
    // still be running... its writes will still commit"). `undo` pauses, so
    // pressing undo in the debug panel put the app in that state.
    //
    // B-4's contract is that a dropped action REJECTS rather than resolving.
    // The refusal has to happen at the door, because that is the only place
    // that still owns the caller's promise. Time travel's own restore does not
    // come through here — `handleTTCommand` assigns state directly — so this
    // cannot block undo/redo itself.
    if (deps.isPaused?.()) {
      const t = String(
        (action as Record<string, unknown>)?.type ?? "(unknown)",
      );
      if (!pausedWarnedTypes.has(t)) {
        pausedWarnedTypes.add(t);
        log.warn(
          `time travel is PAUSED — '${t}' was not applied (further drops of ` +
            `this type suppressed). Resume time travel to dispatch again.`,
        );
      }
      return rejectDropped(createAioError(
        "DISPATCH_CLOSED",
        "time travel is paused — action dropped, not applied. Resume time " +
          "travel (or close the debug panel) to dispatch again.",
        { actionType: (action as Record<string, unknown>)?.type as string },
      ));
    }
    if (closed) {
      const t = String(
        (action as Record<string, unknown>)?.type ?? "(unknown)",
      );
      // Framework teardown must still run after close(). Shutdown closes
      // dispatch up front (to reject late CLIENT input before the final
      // persist), but cell destroy is dispatched later, from onStop's
      // destroyAll(). Dropping it left cell state un-reset AND logged a warning
      // on every shutdown. A System-sourced ':__destroy' is lifecycle, not
      // client input — let it through; everything else still drops.
      const isTeardown =
        (action as Record<string, unknown>)?._source === "System" &&
        t.endsWith(":__destroy");
      // An in-flight async method's ONLY way to publish anything — its
      // draft writes, its return value, its error — is dispatch. Shutdown
      // closes dispatch and THEN drains those effects (shutdown.ts Phase 1),
      // so every commit they made while draining hit a closed queue: the
      // method died mid-write with EFFECT_ASYNC_ERROR, and the state it was
      // about to write never reached the final persist that ran next. A user
      // chatting with a streaming model when the window closed got a stack
      // trace instead of their reply. Late CLIENT input is what close() is
      // for, and that still drops; the framework's own drain does not.
      //
      // KNOWN ASYMMETRY, stated rather than left to be rediscovered: this reads
      // `_source: "Effect"`, which cell-catalog sets on every BOUND ASYNC call
      // for a different reason (the ack/callId path). So a serverFn that calls
      // `await cell.asyncMethod()` DURING the drain is admitted as if it were
      // in-flight work, while its sync twin — which carries no `_source` — is
      // refused. One tag, two meanings: "a bound async call" and "the
      // framework's own draining work", and the gate wants only the second.
      //
      // Left alone deliberately. The data outcome is safe either way (the write
      // is captured by the final persist or loudly dropped), and separating the
      // meanings means a new dispatch-level flag — a wire-contract change that
      // deserves its own release and its own gate run, not a quiet widening
      // here. See todo.md.
      const isDraining = !sealed &&
        (effectPromises.size > 0 || pendingCallsFor(deps.cellNames) > 0) &&
        (action as Record<string, unknown>)?._source === "Effect";
      if (!isTeardown && !isDraining) {
        closedDropCount++;
        if (!closedWarnedTypes.has(t)) {
          closedWarnedTypes.add(t);
          log.warn(
            `dispatch after close() — '${t}' ignored (further drops of this ` +
              `type suppressed; ${closedDropCount} dropped so far)`,
          );
        }
        return rejectDropped(createAioError(
          "DISPATCH_CLOSED",
          "dispatch after close() — action dropped, not applied",
          { actionType: (action as Record<string, unknown>)?.type as string },
        ));
      }
    }
    if (queue.length >= QUEUE_MAX) {
      const err = createAioError(
        "QUEUE_OVERFLOW",
        `dispatch queue depth exceeded (${QUEUE_MAX})`,
        { actionType: (action as Record<string, unknown>)?.type as string },
      );
      reportAioError(err, _reportOpts);
      return rejectDropped(err);
    }
    let resolve!: (value?: unknown) => void;
    let reject!: (e: AioError) => void;
    const promise = new Promise<unknown>((r, rej) => {
      resolve = r;
      reject = rej as (e: AioError) => void;
    });
    // Swallow the unhandled-rejection that would otherwise surface for
    // fire-and-forget callers (B-4: awaiters still receive the rejection).
    promise.catch(() => {});
    const cid = generateCorrelationId();
    queue.push({ action, resolve, reject, cid });
    if (dispatching) return promise;
    dispatching = true;

    let iterations = 0;
    let overflowed = false;
    depth++;
    // The entry currently being reduced/committed. If anything in the drain
    // body throws, this is the caller nobody would otherwise ever answer.
    let inFlight: QueueEntry | null = null;
    try {
      for (;;) { // outer loop: drain queue → onDone → re-drain if onDone queued more
        while (queue.length > 0) {
          if (++iterations > DISPATCH_MAX) {
            const err = createAioError(
              "DISPATCH_LOOP",
              `dispatch overflow (${DISPATCH_MAX} iterations, depth ${depth}) — possible infinite loop`,
              { actionType: tag(queue[0]!.action) },
            );
            reportAioError(err, _reportOpts);
            // B-4: dropped actions must REJECT, not resolve — `await cell.method()`
            // has to learn the state change was never applied. Same contract as
            // close() and QUEUE_OVERFLOW above.
            for (const entry of queue) {
              entry.reject(err);
            }
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
            break;
          }
          const entry = queue.shift()!;
          inFlight = entry;
          setCorrelationId(entry.cid);
          const current = entry.action;
          if (deps.debug) log.debug(`action → reduce: ${tag(current)}`);

          let reduced: {
            state: S;
            effects: (E | ScheduleEffect | OwnEffect)[];
            ret?: unknown; // AIO-427: transported return value
          };
          const actionType = (current as Record<string, unknown>)?.type as
            | string
            | undefined;

          // Measure reduce time
          const reduceStart = performance.now();
          try {
            reduced = reduce(getState(), current);
          } catch (e) {
            const err = createAioError("REDUCE_ERROR", e, {
              cellName: actionType?.split(":")[0],
              actionType,
            }, getState() as Record<string, unknown>);
            reportAioError(err, _reportOpts);
            // Emit a diag event so the health overlay / diagnostic bus
            // subscribers see reduce failures — previously only EFFECT_ERROR
            // paths emitted, so the blank-screen health card stayed silent
            // while a reducer crashed on every dispatch.
            diagEmit({
              type: "reduce-error",
              severity: "error",
              source: "dispatch",
              message: `Reduce threw for action '${actionType ?? "?"}': ${
                e instanceof Error ? e.message : String(e)
              }`,
              detail: { actionType, cellName: actionType?.split(":")[0] },
              hint:
                "Check the cell method body — the reducer threw before producing a new state.",
            });
            // B-4: a reducer throw means the state change never applied —
            // `await cell.method()` must learn the action failed, not resolve
            // cleanly. Mirrors QUEUE_OVERFLOW / DISPATCH_CLOSED contract.
            entry.reject(err);
            inFlight = null;
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
              { cellName: actionType?.split(":")[0], actionType },
            );
            reportAioError(err, _reportOpts);
            // B-4: malformed reduce shape = action not applied — reject the
            // awaiter so `await cell.method()` learns the failure rather than
            // resolving as if the state had advanced.
            entry.reject(err);
            inFlight = null;
            clearCorrelationId();
            continue;
          }

          // Deep-clone effects to detach from Immer draft references.
          // Without this, effects created inside produce() hold revoked draft refs
          // that crash on JSON.stringify or property access after produce() finalizes.
          // Clone individually so one non-cloneable effect doesn't drop all (AIO-139).
          // Audit F-8: a non-cloneable effect is REPORTED and DROPPED — never
          // silently coerced via JSON round-trip (that lost undefined/NaN/Infinity
          // /Date and corrupted the executor's payload contract).
          if (reduced.effects.length) {
            const cloned: (E | ScheduleEffect | OwnEffect)[] = [];
            for (const eff of reduced.effects) {
              try {
                cloned.push(structuredClone(eff));
              } catch (cloneErr) {
                const effType = (eff as Record<string, unknown> | null)?.type as
                  | string
                  | undefined;
                const err = createAioError(
                  "EFFECT_ERROR",
                  `effect "${effType ?? "?"}" from action "${
                    tag(current)
                  }" is not structuredClone-able — dropped. ` +
                    `Effects must be plain JSON-shaped objects (no functions, DOM nodes, class instances, etc). ` +
                    `Original: ${
                      cloneErr instanceof Error
                        ? cloneErr.message
                        : String(cloneErr)
                    }`,
                  {
                    cellName: actionType?.split(":")[0],
                    actionType,
                    effectType: effType,
                  },
                );
                reportAioError(err, _reportOpts);
                // do NOT push — drop the effect rather than corrupt its payload
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
            const changed = Object.keys(
              reduced.state as Record<string, unknown>,
            )
              .filter((k) =>
                (reduced.state as Record<string, unknown>)[k] !==
                  (prev as Record<string, unknown>)[k]
              );
            if (changed.length) {
              log.debug(`state: changed [${changed.join(", ")}]`);
            }
          }
          // `afterAction` is OBSERVE-ONLY (diagnostics, journal, timeline). The
          // state is already committed here, so a hook that throws must NOT
          // unwind dispatch: unguarded it escaped the drain loop, left every
          // queued action's promise forever unsettled (`await cell.method()`
          // hanging), and — reaching the top as an unhandled rejection — took the
          // process down. One BigInt in state, via the diagnostics differ, was
          // enough. Report loudly, then continue: the action itself succeeded.
          if (deps.afterAction) {
            try {
              const r = deps.afterAction(prev as S, nextState, current) as
                | undefined
                | Promise<void>;
              // A hook declared `void` may still hand back a promise; its
              // rejection has to land here too, not on the process.
              if (r && typeof (r as Promise<void>).then === "function") {
                (r as Promise<void>).catch((e) =>
                  reportHookFailure(e, current)
                );
              }
            } catch (e) {
              reportHookFailure(e, current);
            }
          }

          for (const effect of reduced.effects) {
            if (
              !effect ||
              typeof (effect as Record<string, unknown>).type !== "string"
            ) {
              const actionType = tag(current);
              // Keyed by the action TYPE, which is what "logged once per action"
              // says. `tag()` renders type + full payload, so keying on it warned
              // once per distinct PAYLOAD — the same broken reducer shouting on
              // every keystroke — and grew the set by one entry per call for the
              // life of the process.
              const warnKey = typeof (current as { type?: unknown })?.type ===
                  "string"
                ? (current as { type: string }).type
                : actionType;
              if (!warnedInvalidEffect.has(warnKey)) {
                warnedInvalidEffect.add(warnKey);
                log.warn(
                  `reducer returned invalid effect (missing .type string) — ` +
                    `skipping. Action was: ${actionType} (logged once per action)`,
                );
                diagEmit({
                  type: "effect-invalid",
                  severity: "warning",
                  source: "dispatch",
                  message:
                    `Invalid effect skipped (missing .type) from action '${actionType}'`,
                  detail: { actionType },
                  hint:
                    "Effects must be plain objects with a .type string. Check your reducer return value.",
                });
              }
              continue;
            }
            if (deps.debug) log.debug(`effect → execute: ${tag(effect)}`);

            const effectType = (effect as Record<string, unknown>)?.type as
              | string
              | undefined;
            // `cell:__exec` carries the method name in its payload — that is what a
            // per-method budget is keyed by, since the effect TYPE is the same for
            // every async method of a cell. A sync method's effects carry no
            // method name, so the key falls back to the ACTION (`cell:method`).
            const methodKey = budgetKeyFor(effect, actionType);
            const perMethod = methodKey
              ? perfBudget?.methods?.[methodKey]
              : undefined;
            const thisEffectBudget = perMethod?.effect ?? effectBudget;
            // `"warn"` = no hard deadline here; the caller-side wait reports.
            const thisEffectTimeout = perMethod?.timeout === "warn"
              ? 0
              : (perMethod?.timeout ?? effectTimeout);
            // What the violation is LABELLED with (perf.log dedup key). The
            // effect's own type, except for the `cell:__exec` wrapper — that one
            // names no method, so the method key is the informative label.
            const perfLabel = effectType && !effectType.endsWith(":__exec")
              ? effectType
              : (methodKey ?? effectType);
            const effectStart = performance.now();

            try {
              const r = execute(effect);
              const effectDuration = performance.now() - effectStart;
              totalEffectDuration += effectDuration;

              // Check effect performance budget (sync portion only)
              // Async effects return promises immediately — we measure sync time
              if (effectDuration > thisEffectBudget) {
                reportPerf(
                  "effect",
                  effectDuration,
                  thisEffectBudget,
                  perfLabel,
                  methodKey,
                );
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
                const tid = thisEffectTimeout > 0
                  ? setTimeout(() => {
                    if (settled) return;
                    effectsInFlight--;
                    settled = true;
                    const err = createAioError(
                      "EFFECT_TIMEOUT",
                      `async effect hard-timeout: ${
                        effectType ?? "?"
                      } exceeded ${thisEffectTimeout}ms — the framework stopped ` +
                        `TRACKING it. The method itself was NOT stopped and was ` +
                        `not observed to crash: it may still be running, and if ` +
                        `it finishes its writes still commit. Under ` +
                        `transaction:{serialize:true} it also still holds the ` +
                        `cell's turn, so later calls queue behind it until it ` +
                        `settles. A method that is legitimately this slow ` +
                        `should say so (long: ["name"] on the cell); one that ` +
                        `should be stoppable needs cancelOn + s.$signal.`,
                      {
                        cellName: effectType?.split(":")[0],
                        effectType,
                        duration: thisEffectTimeout,
                        budget: thisEffectTimeout,
                      },
                      undefined,
                      asyncCid,
                    );
                    reportAioError(err, _reportOpts);
                    // "Abandoned" has to mean abandoned. The tracked promise was
                    // only removed from `effectPromises` when the underlying
                    // promise SETTLED — so an effect that never settles (a hung
                    // await that ignores its signal) left the set non-empty
                    // forever and `drain()` waited on work the timeout had
                    // already given up on: a shutdown that hangs on an effect
                    // nobody is waiting for. Two words, two behaviours, one of
                    // them silent.
                    if (_trackedRef) effectPromises.delete(_trackedRef);
                  }, thisEffectTimeout)
                  : null;
                // Assigned immediately below; the timeout closure needs the same
                // reference the set holds.
                let _trackedRef: Promise<void> | null = null;
                const tracked = promise
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
                        cellName: effectType?.split(":")[0],
                        actionType,
                        effectType,
                      },
                      undefined,
                      asyncCid,
                    );
                    reportAioError(err, _reportOpts);
                  }).finally(() => effectPromises.delete(tracked));
                _trackedRef = tracked;
                effectPromises.add(tracked);
              }
            } catch (e) {
              const err = createAioError("EFFECT_ERROR", e, {
                cellName: effectType?.split(":")[0],
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
          entry.resolve(reduced.ret);
          inFlight = null;
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
    } finally {
      // `depth--; dispatching = false;` used to sit after the loop, on the
      // success path only. Any throw from inside the drain body therefore left
      // `dispatching === true` FOREVER: every later dispatch pushed onto the
      // queue, saw the flag, returned a promise, and nothing ever drained it
      // again — the cell went silent after the first error, in prod as in dev.
      // One reachable trigger: a `Uint8Array` in cell state with `freezeState`
      // on (the dev default), where `Object.freeze` throws on a non-empty
      // typed array. Reset is not optional; it belongs in a `finally`.
      depth--;
      dispatching = false;
      clearCorrelationId();
      // Nobody is going to drain what is left, and a promise that neither
      // resolves nor rejects is the one outcome the queue contract forbids
      // (same rule as close(), QUEUE_OVERFLOW and DISPATCH_LOOP). Only reached
      // when the loop exited abnormally — a normal exit leaves both empty.
      if (inFlight || queue.length > 0) {
        const err = createAioError(
          "DISPATCH_ABORTED",
          `the dispatch drain loop aborted; ${
            (inFlight ? 1 : 0) + queue.length
          } action(s) were NOT applied. The action being processed threw ` +
            `outside every per-action guard — the error above this one names ` +
            `the cause. Dispatch itself has been reset and accepts new ` +
            `actions; the listed actions must be retried by their callers.`,
          { actionType: inFlight ? tag(inFlight.action) : undefined },
        );
        reportAioError(err, _reportOpts);
        const stranded = inFlight ? [inFlight, ...queue] : [...queue];
        queue.length = 0;
        inFlight = null;
        for (const e of stranded) e.reject(err);
      }
    }
    return promise;
  }

  dispatch.close = () => {
    closed = true;
  };
  dispatch.drain = async (timeoutMs = 0) => {
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
    while (effectPromises.size > 0) {
      if (deadline) {
        const left = deadline - Date.now();
        if (left <= 0) {
          log.warn(
            `shutdown: ${effectPromises.size} effect(s) still running after ` +
              `${timeoutMs}ms — sealing the queue; their writes are lost`,
          );
          break;
        }
        let t: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.allSettled([...effectPromises]),
          new Promise((r) => t = setTimeout(r, left)),
        ]);
        if (t !== undefined) clearTimeout(t);
      } else {
        await Promise.allSettled([...effectPromises]);
      }
    }
    // Draining is over: from here a late effect commit is as unwelcome as
    // late client input, because persist has read the state it would change.
    sealed = true;
  };
  dispatch.errorCount = () => errors;
  dispatch.getQueueDepth = () => queue.length;
  dispatch.getEffectBacklog = () => effectsInFlight;
  return dispatch as DispatchFn<A>;
}
