// flow.ts — generator-based sequential workflows for features
//
// Write top-to-bottom async code. Each yield point is observable:
// dispatches an action, transitions the machine, appears in time-travel.
//
// GenCtx   — context passed to generator (call, mutate, done, fail, dispatch, all, race, sleep)
// runFlow() — internal: advances generator, dispatches actions, mutates state

import { produce } from "immer";
import { callWithOpts } from "./feature-impl.ts";
import type { Msg } from "./feature-types.ts";
import type { FlowStepRecord } from "./error.ts";
import { log } from "./logger.ts";

class FlowFailError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "FlowFailError";
  }
}

// ── FlowHistory — ring buffer for step tracking ─────────────────────

export class FlowHistory {
  private _entries: FlowStepRecord[] = [];
  private _cap: number;

  constructor(cap = 50) {
    this._cap = cap;
  }

  push(action: string): number {
    const step = this._entries.length > 0
      ? this._entries[this._entries.length - 1]!.step + 1
      : 0;
    this._entries.push({ step, action, status: "pending" });
    if (this._entries.length > this._cap) this._entries.shift();
    return step;
  }

  markOk(stepNum: number): void {
    const e = this._entries.find((e) => e.step === stepNum);
    if (e) e.status = "ok";
  }

  markError(stepNum: number): void {
    const e = this._entries.find((e) => e.step === stepNum);
    if (e) e.status = "error";
  }

  entries(): FlowStepRecord[] {
    return [...this._entries];
  }
}

// ── Types ────────────────────────────────────────────────────────────

type FlowApp = {
  dispatch: (action: Msg) => void;
  getState: () => Record<string, unknown>;
};

/** Yielded descriptor — internal protocol between generator and runner */
export type FlowStep =
  | {
    kind: "call";
    name: string;
    fn: () => unknown | Promise<unknown>;
    opts?: { timeout?: number; retries?: number };
  }
  | {
    kind: "step";
    name: string;
    mutate: (draft: Record<string, unknown>) => void;
  }
  | { kind: "done"; mutate?: (draft: Record<string, unknown>) => void }
  | { kind: "fail"; reason: string }
  | { kind: "dispatch"; action: { type: string; payload?: unknown } }
  | { kind: "all"; entries: FlowStep[] }
  | { kind: "race"; entries: Record<string, FlowStep> }
  | { kind: "sleep"; name: string; ms: number }
  | { kind: "waitFor"; actionType: string; timeout?: number }
  | {
    kind: "when";
    predicate: (state: Record<string, unknown>) => boolean;
    timeout?: number;
  };

/** Generator return type for flows */
export type Gen<T = void> = Generator<FlowStep, T, unknown>;

/** Action creator with attached .type — as returned by feature.actionKey.
 *  Pass to waitFor() for typed payload inference: `yield* ctx.waitFor(gateway.running)` */
export type TypedCreator<P = unknown> = {
  readonly type: string;
  (...args: unknown[]): { type: string; payload: P };
};

/** Context object passed to flow generators.
 *  S is the feature's state shape — inferred from the `state:` config. */
export type GenCtx<S = Record<string, unknown>> = {
  /** Async call — dispatches action, executes fn, returns result.
   *  Optional opts for timeout (ms) and retries (count). */
  call: <T>(
    name: string,
    fn: () => T | Promise<T>,
    opts?: { timeout?: number; retries?: number },
  ) => Gen<Awaited<T>>;
  /** State mutation — dispatches action, applies Immer draft update */
  mutate: (name: string, mutate: (draft: S) => void) => Gen<void>;
  /** Terminal success — dispatches done action, optional final state update */
  done: (mutate?: (draft: S) => void) => Gen<void>;
  /** Terminal failure — dispatches fail action with reason */
  fail: (reason: string) => Gen<never>;
  /** Dispatch an action to any feature */
  dispatch: (action: { type: string; payload?: unknown }) => Gen<void>;
  /** Shorthand dispatch — pass a bound method (with .type) or plain type string.
   *  @example yield* ctx.send(analytics.log, { msg: 'done' }) */
  send: (
    creatorOrType: { type: string } | string,
    payload?: unknown,
  ) => Gen<void>;
  /** Run multiple calls in parallel, wait for all.
   *  Spread form: const [a, b] = yield* ctx.all(gen1, gen2)
   *  Named form:  const { a, b } = yield* ctx.all({ a: gen1, b: gen2 }) */
  all: {
    <T extends readonly Gen<unknown>[]>(
      ...gens: T
    ): Gen<{ [K in keyof T]: T[K] extends Gen<infer R> ? R : never }>;
    <T extends Record<string, Gen<unknown>>>(
      entries: T,
    ): Gen<{ [K in keyof T]: T[K] extends Gen<infer R> ? R : never }>;
  };
  /** Race multiple calls — first to complete wins, rest are conceptually cancelled */
  race: <T extends Record<string, Gen<unknown>>>(
    entries: T,
  ) => Gen<{ [K in keyof T]?: T[K] extends Gen<infer R> ? R : never }>;
  /** Sleep for N ms — dispatches a named action for visibility */
  sleep: (name: string, ms: number) => Gen<void>;
  /** Wait for an action to be dispatched — pauses flow until matching action arrives.
   *  Pass a bound method (.type) or action creator for typed payload inference.
   *  @example yield* ctx.waitFor(gateway.running)       // bound method — untyped payload
   *  @example yield* ctx.waitFor(gateway.running)     // bound method — typed payload */
  waitFor: {
    <P>(
      creator: TypedCreator<P>,
      timeout?: number,
    ): Gen<{ type: string; payload: P }>;
    (creatorOrType: { type: string } | string, timeout?: number): Gen<Msg>;
  };
  /** Wait until a state condition is true. Checks immediately, then after every dispatch.
   *  @param predicate — receives full app state, returns boolean
   *  @param opts.timeout — ms before the wait fails (default: no timeout) */
  when: (
    predicate: (appState: Record<string, unknown>) => boolean,
    opts?: { timeout?: number },
  ) => Gen<void>;
  /** Read current feature state (fresh after each step) */
  getState: () => S;
  /** Read full app state tree (all features). Fresh after each flow step. */
  getFullState: () => Record<string, unknown>;
};

/** Flow options — kept for internal use */
type FlowOptions = {
  cancelOn?: string[];
};

/** Flow definition — internal, consumed by feature() */
export type FlowDef = {
  trigger: string;
  // deno-lint-ignore no-explicit-any
  generator: (ctx: GenCtx<any>, ...args: unknown[]) => Gen<unknown>;
  /** Auto-generated action types from yield point names */
  _stepNames: string[];
  /** Action keys that cancel this flow */
  cancelOn?: string[];
  /** How to unpack the triggering action's payload into generator args:
   *  'spread' — payload.args array is spread (methods-style: item, qty, ...)
   *  'payload' — payload object is passed directly (actions-style: { item, qty }) */
  argsStyle: "spread" | "payload";
};

// ── ctx generators (yield descriptors) ───────────────────────────────

function* callGen<T>(
  name: string,
  fn: () => T | Promise<T>,
  opts?: { timeout?: number; retries?: number },
): Gen<Awaited<T>> {
  return (yield { kind: "call", name, fn, opts } as FlowStep) as Awaited<T>;
}

function* mutateGen(
  name: string,
  mutate: (draft: Record<string, unknown>) => void,
): Gen<void> {
  yield { kind: "step", name, mutate } as FlowStep;
}

function* doneGen(
  mutate?: (draft: Record<string, unknown>) => void,
): Gen<void> {
  yield { kind: "done", mutate } as FlowStep;
}

function* failGen(reason: string): Gen<never> {
  yield { kind: "fail", reason } as FlowStep;
  // unreachable — runner throws after fail
  throw new Error("flow failed: " + reason);
}

function* dispatchGen(action: { type: string; payload?: unknown }): Gen<void> {
  yield { kind: "dispatch", action } as FlowStep;
}

function* allGen<T extends readonly Gen<unknown>[]>(
  ...gens: T
): Gen<{ [K in keyof T]: T[K] extends Gen<infer R> ? R : never }> {
  // Collect first step from each generator — only single-step generators supported (ctx.call, ctx.sleep)
  const entries: FlowStep[] = [];
  for (const g of gens) {
    const first = g.next();
    if (!first.done && first.value) {
      entries.push(first.value);
      // Guard: multi-step generators silently lose steps — reject them
      const second = g.next();
      if (!second.done) {
        throw new Error(
          "ctx.all() only supports single-step generators (ctx.call, ctx.sleep) — multi-step generators are not supported",
        );
      }
    }
  }
  return (yield { kind: "all", entries } as FlowStep) as {
    [K in keyof T]: T[K] extends Gen<infer R> ? R : never;
  };
}

function* raceGen<T extends Record<string, Gen<unknown>>>(
  entries: T,
): Gen<{ [K in keyof T]?: T[K] extends Gen<infer R> ? R : never }> {
  // Extract first step from each generator — only single-step generators supported (ctx.call, ctx.sleep)
  const stepEntries: Record<string, FlowStep> = {};
  for (const [key, gen] of Object.entries(entries)) {
    const first = gen.next();
    if (!first.done && first.value) {
      stepEntries[key] = first.value;
      const second = gen.next();
      if (!second.done) {
        throw new Error(
          "ctx.race() only supports single-step generators (ctx.call, ctx.sleep) — multi-step generators are not supported",
        );
      }
    }
  }
  return (yield { kind: "race", entries: stepEntries } as FlowStep) as {
    [K in keyof T]?: T[K] extends Gen<infer R> ? R : never;
  };
}

function* sleepGen(name: string, ms: number): Gen<void> {
  yield { kind: "sleep", name, ms } as FlowStep;
}

function* sendGen(
  creatorOrType: { type: string } | string,
  payload?: unknown,
): Gen<void> {
  const type = typeof creatorOrType === "string"
    ? creatorOrType
    : creatorOrType.type;
  yield { kind: "dispatch", action: { type, payload } } as FlowStep;
}

function* namedAllGen<T extends Record<string, Gen<unknown>>>(
  entries: T,
): Gen<{ [K in keyof T]: T[K] extends Gen<infer R> ? R : never }> {
  const keys = Object.keys(entries);
  const gens = keys.map((k) => entries[k]!);
  const results = (yield* (allGen as (...g: Gen<unknown>[]) => Gen<unknown[]>)(
    ...gens,
  )) as unknown[];
  const out: Record<string, unknown> = {};
  for (let i = 0; i < keys.length; i++) out[keys[i]!] = results[i];
  return out as { [K in keyof T]: T[K] extends Gen<infer R> ? R : never };
}

function* waitForGen(
  creatorOrType: string | { type: string },
  timeout?: number,
): Gen<Msg> {
  const actionType = typeof creatorOrType === "string"
    ? creatorOrType
    : creatorOrType.type;
  return (yield { kind: "waitFor", actionType, timeout } as FlowStep) as Msg;
}

function* whenGen(
  predicate: (appState: Record<string, unknown>) => boolean,
  opts?: { timeout?: number },
): Gen<void> {
  yield { kind: "when", predicate, timeout: opts?.timeout } as FlowStep;
}

/** Build a GenCtx — the context object passed to flow generators */
function buildCtx(
  featureName: string,
  getFullState: () => Record<string, unknown>,
): GenCtx {
  // deno-lint-ignore no-explicit-any
  const allDispatch = (...args: any[]): Gen<unknown> => {
    // Named object form: ctx.all({ a: gen, b: gen })
    if (
      args.length === 1 && args[0] !== null && typeof args[0] === "object" &&
      typeof (args[0] as Record<string, unknown>).next !== "function"
    ) {
      return namedAllGen(args[0] as Record<string, Gen<unknown>>);
    }
    return allGen(...args as Gen<unknown>[]);
  };
  return {
    call: callGen,
    mutate: mutateGen as GenCtx["mutate"],
    done: doneGen as GenCtx["done"],
    fail: failGen,
    dispatch: dispatchGen,
    send: sendGen,
    all: allDispatch as GenCtx["all"],
    race: raceGen,
    sleep: sleepGen,
    waitFor: waitForGen as GenCtx["waitFor"],
    when: whenGen,
    getState: () => getFullState()[featureName] as Record<string, unknown>,
    getFullState: () => getFullState(),
  };
}

// ── Flow runner ──────────────────────────────────────────────────────

/** Internal: status for a running flow instance */
type FlowInstance = {
  generator: Gen<unknown>;
  featureName: string;
  flowName: string;
  prefix: string;
  aborted: boolean;
  /** AbortController for waitFor — cancellation is instant via signal, no polling */
  abortController?: AbortController;
  /** Active state listener for ctx.when — tracked for abort cleanup */
  stateListener?: StateListener;
};

/** Active flow instances per feature — keyed by featureName:flowName.
 *  Module-level for cross-function access (cancelFlow, cancelFeatureFlows, runFlow).
 *  Call resetFlows() between test runs to prevent cross-contamination. */
const activeFlows = new Map<string, FlowInstance>();

// ── Action listener registry for waitFor ──────────────────────────────

type ActionListener = { actionType: string; resolve: (action: Msg) => void };
/** @internal — exported for test assertions only */
export const _actionListeners = new Set<ActionListener>();

/** Notify waiting flows when an action is dispatched — called from the dispatch loop */
export function notifyFlowListeners(action: Msg): void {
  const snapshot = [..._actionListeners];
  for (const listener of snapshot) {
    if (action.type === listener.actionType) {
      _actionListeners.delete(listener);
      listener.resolve(action);
    }
  }
}

// ── State listener registry for ctx.when ─────────────────────────────

type StateListener = {
  predicate: (state: Record<string, unknown>) => boolean;
  resolve: () => void;
};
const _stateListeners = new Set<StateListener>();

/** Notify waiting flows when state changes — called from the dispatch loop after every reduce */
export function notifyStateListeners(state: Record<string, unknown>): void {
  for (const listener of _stateListeners) {
    try {
      if (listener.predicate(state)) {
        listener.resolve();
        _stateListeners.delete(listener);
      }
    } catch (e) {
      // AIO-199: remove broken predicate to prevent infinite retry leak.
      // Resolve the listener so the flow can proceed (generator receives
      // undefined, re-checks state, and handles the error condition).
      log.debug("aio", `when() predicate threw — removing listener: ${e}`);
      _stateListeners.delete(listener);
      listener.resolve();
    }
  }
}

function abortInstance(instance: FlowInstance): void {
  if (instance.stateListener) {
    _stateListeners.delete(instance.stateListener);
    instance.stateListener = undefined;
  }
  instance.aborted = true;
  instance.abortController?.abort();
  try {
    instance.generator.return(undefined);
  } catch { /* ignore */ }
}

/** Reset all active flows — for test isolation */
export function resetFlows(): void {
  for (const [, instance] of activeFlows) abortInstance(instance);
  activeFlows.clear();
  _actionListeners.clear();
  _stateListeners.clear();
}

/** Cancel a running flow (if any) */
export function cancelFlow(featureName: string, flowName: string): void {
  const key = `${featureName}:${flowName}`;
  const instance = activeFlows.get(key);
  if (instance) {
    abortInstance(instance);
    activeFlows.delete(key);
  }
}

/** Cancel all flows for a feature (on disable/destroy) */
export function cancelFeatureFlows(featureName: string): void {
  for (const [key, instance] of activeFlows) {
    if (instance.featureName === featureName) {
      abortInstance(instance);
      activeFlows.delete(key);
    }
  }
}

/** Run a flow — advances generator, dispatches actions at each yield point */
export async function runFlow(
  flowDef: FlowDef,
  flowName: string,
  featureName: string,
  action: Msg,
  app: FlowApp,
  onFlowError?: (
    raw: unknown,
    ctx: {
      featureName: string;
      flowName: string;
      flowStep: number;
      flowHistory: FlowStepRecord[];
    },
  ) => void,
): Promise<void> {
  const prefix = featureName;
  const flowKey = `${featureName}:${flowName}`;

  // Cancel any existing instance of this flow
  cancelFlow(featureName, flowName);

  const ctx = buildCtx(featureName, () => app.getState());
  const payload = action.payload as Record<string, unknown>;
  const genArgs: unknown[] = flowDef.argsStyle === "spread"
    ? (Array.isArray(payload?.args) ? payload.args : [])
    : [payload];
  const gen = flowDef.generator(ctx, ...genArgs);

  const instance: FlowInstance = {
    generator: gen,
    featureName,
    flowName,
    prefix,
    aborted: false,
  };
  activeFlows.set(flowKey, instance);

  // Track waitFor listeners for cleanup in finally block (AIO-117)
  const waitForListeners = new Set<ActionListener>();

  // Register cancelOn listeners
  const cancelListeners: ActionListener[] = [];
  if (flowDef.cancelOn) {
    for (const actionKey of flowDef.cancelOn) {
      // Resolve action key to full type: "stop" → "featureName:stop"
      const fullType = actionKey.includes(":")
        ? actionKey
        : `${prefix}:${actionKey}`;
      const listener: ActionListener = {
        actionType: fullType,
        resolve: () => cancelFlow(featureName, flowName),
      };
      cancelListeners.push(listener);
      _actionListeners.add(listener);
    }
  }

  const flowSteps = new FlowHistory(50);
  let stepIndex = 0;

  try {
    let result = gen.next();
    let doneSeen = false;

    while (!result.done) {
      if (instance.aborted) return;

      const step = result.value as FlowStep;
      if (step.kind === "done" || step.kind === "fail") doneSeen = true;

      // Track step
      const stepAction = step.kind === "call"
        ? `${prefix}:${(step as { name: string }).name}`
        : step.kind;
      const currentStep = flowSteps.push(stepAction);

      try {
        const stepResult = await executeStep(
          step,
          instance,
          app,
          waitForListeners,
        );
        flowSteps.markOk(currentStep);
        if (instance.aborted) return;
        result = gen.next(stepResult);
      } catch (stepError) {
        flowSteps.markError(currentStep);
        if (instance.aborted) return;
        // Feed error back into generator so try/catch inside flow works
        result = gen.throw(stepError);
      }
      stepIndex++;
    }

    // Auto-complete if generator returned without ctx.done()
    if (!doneSeen && !instance.aborted) {
      app.dispatch({
        type: `${prefix}:__flow:done`,
        payload: {},
        _source: "Effect",
      } as Msg);
    }
  } catch (e) {
    // AIO-253: FlowFailError means ctx.fail() already dispatched its action — just exit cleanly
    if (e instanceof FlowFailError) return;

    if (!instance.aborted) {
      // Dispatch error action (keep existing behavior)
      app.dispatch({
        type: `${prefix}:__flow:error`,
        payload: { flow: flowName, error: String(e) },
        _source: "Effect",
      });

      // Report through error infrastructure
      if (onFlowError) {
        onFlowError(e, {
          featureName,
          flowName,
          flowStep: stepIndex,
          flowHistory: flowSteps.entries(),
        });
      } else {
        log.error("feature", `${featureName} flow '${flowName}' threw: ${e}`);
      }
    }
  } finally {
    // Only delete from activeFlows if this instance is still the current one
    // (a re-triggered flow may have already replaced it)
    if (activeFlows.get(flowKey) === instance) {
      activeFlows.delete(flowKey);
    }
    for (const l of cancelListeners) _actionListeners.delete(l);
    // AIO-117: clean up any pending waitFor listeners
    for (const l of waitForListeners) _actionListeners.delete(l);
    waitForListeners.clear();
  }
}

/** Execute a single flow step — returns the value to feed back into the generator */
async function executeStep(
  step: FlowStep,
  instance: FlowInstance,
  app: FlowApp,
  waitForListeners?: Set<ActionListener>,
): Promise<unknown> {
  // AIO-255: bail immediately if flow was aborted (prevents all/race continuations)
  if (instance.aborted) return undefined;

  const { prefix, featureName } = instance;
  const flowPrefix = `${prefix}:__flow:`;

  switch (step.kind) {
    case "call": {
      // Dispatch start action
      app.dispatch({
        type: `${flowPrefix}${step.name}`,
        payload: { _flow: instance.flowName, _step: step.name },
        _source: "Effect",
      });

      // Execute with optional timeout/retry
      const result = step.opts
        ? await callWithOpts(step.fn, step.opts)
        : await step.fn();
      return result;
    }

    case "step": {
      // Dispatch step action
      app.dispatch({
        type: `${flowPrefix}${step.name}`,
        payload: { _flow: instance.flowName, _step: step.name },
        _source: "Effect",
      });

      // Apply state mutation via Immer
      const fullState = app.getState();
      const featureState = fullState[featureName] as Record<string, unknown>;
      const nextSlice = produce(featureState, (draft) => {
        step.mutate(draft as Record<string, unknown>);
      });

      // Dispatch internal state update
      app.dispatch({
        type: `${prefix}:__FlowState`,
        payload: { _slice: nextSlice },
        _source: "Effect",
      });

      return undefined;
    }

    case "done": {
      // Apply optional final mutation
      if (step.mutate) {
        const fullState = app.getState();
        const featureState = fullState[featureName] as Record<string, unknown>;
        const nextSlice = produce(featureState, (draft) => {
          step.mutate!(draft as Record<string, unknown>);
        });

        app.dispatch({
          type: `${prefix}:__FlowState`,
          payload: { _slice: nextSlice },
          _source: "Effect",
        });
      }

      // Dispatch done action
      app.dispatch({
        type: `${flowPrefix}done`,
        payload: { _flow: instance.flowName },
        _source: "Effect",
      });

      return undefined;
    }

    case "fail": {
      // Dispatch fail action
      app.dispatch({
        type: `${flowPrefix}failed`,
        payload: { _flow: instance.flowName, reason: step.reason },
        _source: "Effect",
      });

      // AIO-253: throw sentinel so generator try/finally blocks execute properly
      throw new FlowFailError(step.reason);
    }

    case "dispatch": {
      app.dispatch({ _source: "Effect", payload: {}, ...step.action });
      return undefined;
    }

    case "all": {
      // Execute all entries in parallel
      const promises = step.entries.map((entry) =>
        executeStep(entry, instance, app, waitForListeners)
      );
      return Promise.all(promises);
    }

    case "race": {
      // Race all entries — first to resolve wins
      const entries = Object.entries(step.entries);
      const result = await Promise.race(
        entries.map(async ([key, entry]) => {
          const value = await executeStep(
            entry,
            instance,
            app,
            waitForListeners,
          );
          return { key, value };
        }),
      );
      return { [result.key]: result.value };
    }

    case "sleep": {
      app.dispatch({
        type: `${flowPrefix}${step.name}`,
        payload: { _flow: instance.flowName, _step: step.name, ms: step.ms },
        _source: "Effect",
      });
      const controller = new AbortController();
      instance.abortController = controller;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, step.ms);
        controller.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      instance.abortController = undefined;
      return undefined;
    }

    case "waitFor": {
      // Dispatch waiting action for visibility
      app.dispatch({
        type: `${flowPrefix}waitFor`,
        payload: {
          _flow: instance.flowName,
          actionType: step.actionType,
          timeout: step.timeout,
        },
        _source: "Effect",
      });

      // AbortController per-step — cancellation is instant via signal, no polling loop.
      const controller = new AbortController();
      instance.abortController = controller;

      // Hoist listener ref so timeout can delete the exact instance (not first match)
      let listener: ActionListener;
      const actionPromise = new Promise<Msg>((resolve) => {
        listener = { actionType: step.actionType, resolve };
        _actionListeners.add(listener);
        waitForListeners?.add(listener);

        // Resolve immediately on flow cancellation — no 50ms poll needed
        controller.signal.addEventListener("abort", () => {
          _actionListeners.delete(listener);
          waitForListeners?.delete(listener);
          resolve({ type: "__aborted", payload: {} });
        }, { once: true });
      });

      if (step.timeout !== undefined) {
        const timeoutSentinel = Symbol("timeout");
        const result = await Promise.race([
          actionPromise,
          new Promise<typeof timeoutSentinel>((resolve) =>
            setTimeout(() => resolve(timeoutSentinel), step.timeout)
          ),
        ]);
        instance.abortController = undefined;
        if (result === timeoutSentinel) {
          _actionListeners.delete(listener!); // delete exact instance, not first match
          waitForListeners?.delete(listener!);
          throw new Error(
            `waitFor('${step.actionType}') timed out after ${step.timeout}ms`,
          );
        }
        waitForListeners?.delete(listener!);
        return result;
      }

      // Dev mode: warn if waitFor has no timeout and has been waiting 30s
      let warnTimer: ReturnType<typeof setTimeout> | undefined;
      if ((globalThis as Record<string, unknown>).__aioDev) {
        warnTimer = setTimeout(() => {
          log.warn(
            "aio",
            `${instance.featureName} waitFor('${step.actionType}') has been waiting 30s with no timeout — did you mean to add one?`,
          );
        }, 30_000);
      }

      const result = await actionPromise;
      if (warnTimer) clearTimeout(warnTimer);
      instance.abortController = undefined;
      waitForListeners?.delete(listener!);
      return result;
    }

    case "when": {
      // Check immediately — if already true, no suspension needed
      const currentState = app.getState();
      try {
        if (step.predicate(currentState)) return undefined;
      } catch (e) {
        log.debug("aio", `when() predicate threw: ${e}`);
        // Fall through to register listener — treat throw as false
      }

      // Dispatch waiting action for visibility
      app.dispatch({
        type: `${flowPrefix}when`,
        payload: {
          _flow: instance.flowName,
          timeout: step.timeout,
        },
        _source: "Effect",
      });

      // AbortController for instant cancellation (same pattern as waitFor)
      const controller = new AbortController();
      instance.abortController = controller;

      let listener: StateListener;
      const statePromise = new Promise<void>((resolve) => {
        listener = { predicate: step.predicate, resolve };
        _stateListeners.add(listener);
        instance.stateListener = listener;

        controller.signal.addEventListener("abort", () => {
          _stateListeners.delete(listener);
          instance.stateListener = undefined;
          resolve(); // resolve with undefined on abort — abortInstance sets instance.aborted
        }, { once: true });
      });

      if (step.timeout !== undefined) {
        const timeoutSentinel = Symbol("timeout");
        let timeoutId: ReturnType<typeof setTimeout>;
        const result = await Promise.race([
          statePromise.then(() => undefined as undefined),
          new Promise<typeof timeoutSentinel>((resolve) => {
            timeoutId = setTimeout(
              () => resolve(timeoutSentinel),
              step.timeout,
            );
          }),
        ]);
        clearTimeout(timeoutId!); // clear timer whether state won or timeout won
        instance.abortController = undefined;
        instance.stateListener = undefined;
        _stateListeners.delete(listener!); // AIO-207: always clean up listener
        if (result === timeoutSentinel) {
          throw new Error(
            `when() timed out after ${step.timeout}ms`,
          );
        }
        return undefined;
      }

      // Dev mode: warn if when() has no timeout and has been waiting 30s
      let warnTimer: ReturnType<typeof setTimeout> | undefined;
      if ((globalThis as Record<string, unknown>).__aioDev) {
        warnTimer = setTimeout(() => {
          log.warn(
            "aio",
            `${instance.featureName} when() has been waiting 30s with no timeout — did you mean to add one?`,
          );
        }, 30_000);
      }

      await statePromise;
      if (warnTimer) clearTimeout(warnTimer);
      instance.abortController = undefined;
      instance.stateListener = undefined;
      return undefined;
    }
  }
}

// ── Integration helpers (used by feature.ts) ─────────────────────────

/** Wire flows into a feature's executor — called by composeFeatures */
export function createFlowExecutor(
  featureName: string,
  flows: Record<string, FlowDef>,
  triggerToFlow: Map<string, string>,
  onFlowError?: (
    raw: unknown,
    ctx: {
      featureName: string;
      flowName: string;
      flowStep: number;
      flowHistory: FlowStepRecord[];
    },
  ) => void,
): (app: FlowApp, action: Msg) => boolean {
  return (app: FlowApp, action: Msg): boolean => {
    const prefix = featureName;

    // Check if this action triggers a flow
    const actionSuffix = action.type.startsWith(prefix + ":")
      ? action.type.slice(prefix.length + 1)
      : null;

    if (!actionSuffix) return false;

    const flowName = triggerToFlow.get(actionSuffix);

    if (!flowName) return false;

    const flowDef = flows[flowName];
    if (!flowDef) return false;

    // Fire-and-forget: runFlow is async but NOT awaited here.
    // The dispatch loop returns immediately; flow advances in the background.
    // Each yield point dispatches its own observable action when it resolves.
    runFlow(flowDef, flowName, featureName, action, app, onFlowError)
      .catch((e) => {
        if (onFlowError) {
          onFlowError(e, {
            featureName,
            flowName,
            flowStep: -1,
            flowHistory: [],
          });
        } else {
          log.error("feature", `${featureName} flow '${flowName}' error: ${e}`);
        }
      });

    return true;
  };
}

/** Build the __FlowState reducer — handles internal state updates from flows */
export function createFlowReducer(featureName: string) {
  const prefix = featureName;
  const flowStateType = `${prefix}:__FlowState`;

  return (
    state: Record<string, unknown>,
    action: Msg,
  ): Record<string, unknown> | null => {
    if (action.type !== flowStateType) return null;

    const payload = action.payload as { _slice: Record<string, unknown> };
    return { ...state, [featureName]: payload._slice };
  };
}
