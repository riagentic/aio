// feature-create.ts — feature() function + createFeatureFromMethods + createFeatureFromActions

import type { Draft } from "immer";
import type { FlowDef, Gen, GenCtx } from "./flow.ts";
import type { ScheduleEffect } from "./schedule.ts";
import type {
  AsyncMethod,
  FeatureMethods,
  Method,
  Mutation,
  SyncMethod,
} from "./feature-impl.ts";
import {
  applyMutations,
  classifyMethods,
  createBatcher,
  createLiveProxy,
  resolveCall,
  setKey,
} from "./feature-impl.ts";
import type {
  ActionUnion,
  Creators,
  DirectCalling,
  FeatureAio,
  FeatureDef,
  FeatureExecuteFn,
  FeatureReduceFn,
  FlatActions,
  MachineConfig,
  Msg,
  ScopedApp,
} from "./feature-types.ts";
import { checkReservedKeys, RESERVED_KEYS } from "./feature-types.ts";
import { type AioError, createAioError } from "./error.ts";
import { buildCatalog, flattenOnto } from "./feature-catalog.ts";
import { validateMachine } from "./feature-machine.ts";
import { log } from "./logger.ts";

// ── Config types ──────────────────────────────────────────────────────

/** Generator function — pass through cancel() to attach cancelOn triggers.
 *  Uses `any` for rest args so typed signatures (e.g. `{ n: number }`) are assignable. */
// deno-lint-ignore no-explicit-any
type GeneratorEntry = ((ctx: GenCtx<any>, ...args: any[]) => Gen<unknown>) & {
  cancelOn?: string[];
};

/** Methods-based config (reactive style) */
export type MethodsFeatureConfig<
  N extends string,
  S extends Record<string, unknown>,
  M extends Record<string, Method<S>> = Record<string, Method<S>>,
> = {
  state: S;
  methods: M;
  /** Generator functions — sequential async workflows, auto-triggered by dispatching their action. */
  // deno-lint-ignore no-explicit-any
  generators?: Record<string, (ctx: GenCtx<S>, ...args: any[]) => Gen<unknown>>;
  /** Cancellation triggers per generator — { generatorKey: [actionsOrTypes] }.
   *  Accepts bound action creators (.type) or plain strings. */
  cancelOn?: Record<string, (string | { type: string })[]>;
  selectors?: Record<string, (s: S) => unknown>;
  machine?: MachineConfig | false;
  /** Listen to foreign actions — auto-generates machine transitions.
   *  Accept strings or bound methods/actions with .type (e.g. `inventory.reserve.type`). */
  listensTo?: (string | { type: string })[];
  /** Explicit actions — typed creators with custom payloads (mixed mode). Names must not collide with methods. */
  // deno-lint-ignore no-explicit-any
  actions?: Record<string, (...args: any[]) => Record<string, unknown>>;
  // deno-lint-ignore no-explicit-any
  effects?: Record<string, (...args: any[]) => Record<string, unknown>>;
  /** Reduce handlers for explicit actions (mixed mode). Each key matches an action key. */
  // deno-lint-ignore no-explicit-any
  reduce?: Record<string, (state: Draft<S>, payload: any) => void | any[]>;
  /** Object form (default): named handlers per effect key.
   *  Function form (advanced): receives full effect + { emit } map of type strings. */
  execute?:
    | ExecuteHandlers<S, Record<string, never>>
    | ((
      app: ScopedApp<S>,
      effect: Msg,
      ctx: { emit: Record<string, unknown> },
    ) => void);
  /** Features this feature's execute() is allowed to dispatch to.
   *  Acts as an explicit dependency declaration — prevents accidental
   *  cross-feature dispatch and makes dependencies visible at a glance.
   *  @example dispatchTo: [wallet, notifications] */
  dispatchTo?: (string | { name: string })[];
  /** Optional state validator — called after every reduce. Return true to accept, or a string error message to reject. */
  validate?: (state: S) => true | string;
  /** State keys to exclude from KV persistence — e.g. { exclude: ['htmlCache', 'largeBlob'] } */
  persist?: { exclude?: string[] };
  onInit?: (app: ScopedApp<S>) => void;
  onDestroy?: (app: ScopedApp<S>) => void;
};

/** Object-form reduce handlers — each key matches an action key, receives typed payload.
 *  Own-feature keys infer payload from action creator; foreign/computed keys get any (no cast needed). */
export type ReduceHandlers<S, A extends Creators> =
  & Partial<
    {
      [K in keyof A]: (state: Draft<S>, payload: ReturnType<A[K]>) => void;
    }
  >
  // deno-lint-ignore no-explicit-any
  & Record<string, (state: Draft<S>, payload: any) => void>;

/** Object-form execute handlers — each key matches an effect key, receives typed payload. */
export type ExecuteHandlers<S, E extends Creators> =
  & Partial<
    {
      [K in keyof E]: (
        app: ScopedApp<S>,
        payload: ReturnType<E[K]>,
      ) => void | Promise<void>;
    }
  >
  // deno-lint-ignore no-explicit-any
  & Record<string, (app: ScopedApp<S>, payload: any) => void | Promise<void>>;

/** Actions-based config (explicit style) */
export type ActionsFeatureConfig<
  N extends string,
  S extends Record<string, unknown>,
  A extends Creators,
  E extends Creators,
> = {
  state: S;
  actions: A;
  effects?: E;
  machine?: MachineConfig | false;
  /** Object form (default): named handlers per action key — receives typed payload.
   *  Function form (advanced escape hatch): receives full action + { on } map of type strings. */
  reduce?:
    | ReduceHandlers<S, A>
    | ((
      state: Draft<S>,
      action: ActionUnion<N, A>,
      ctx: { on: Record<string, string> },
    ) => (Msg | ScheduleEffect)[] | void);
  /** Object form (default): named handlers per effect key — receives typed payload.
   *  Function form (advanced escape hatch): receives full effect + { emit } map of type strings. */
  execute?:
    | ExecuteHandlers<S, E>
    | ((
      app: ScopedApp<S>,
      effect: Msg,
      ctx: { emit: Record<string, string> },
    ) => void);
  selectors?: Record<string, (s: S) => unknown>;
  /** Generator functions keyed by their trigger action — action key must be in `actions`. */
  // deno-lint-ignore no-explicit-any
  generators?: Record<string, (ctx: GenCtx<S>, ...args: any[]) => Gen<unknown>>;
  /** Cancellation triggers per generator — { generatorKey: [actionsOrTypes] }.
   *  Accepts bound action creators (.type) or plain strings. */
  cancelOn?: Record<string, (string | { type: string })[]>;
  /** Features this feature's execute() is allowed to dispatch to.
   *  Acts as an explicit dependency declaration — prevents accidental
   *  cross-feature dispatch and makes dependencies visible at a glance.
   *  @example dispatchTo: [wallet, notifications] */
  dispatchTo?: (string | { name: string })[];
  /** Optional state validator — called after every reduce. Return true to accept, or a string error message to reject. */
  validate?: (state: S) => true | string;
  /** State keys to exclude from KV persistence — e.g. { exclude: ['htmlCache', 'largeBlob'] } */
  persist?: { exclude?: string[] };
  onInit?: (app: ScopedApp<S>) => void;
  onDestroy?: (app: ScopedApp<S>) => void;
};

// ── feature() ──────────────────────────────────────────────────────

/** Define a feature — methods, actions, or mixed.
 *  Methods: reactive style with sync/async functions.
 *  Actions: explicit typed action creators + reduce handlers.
 *  Mixed: methods + actions/effects in one feature (names must not collide). */
export function feature<
  N extends string,
  S extends Record<string, unknown>,
  M extends Record<string, Method<S>>,
>(
  name: N,
  config: MethodsFeatureConfig<N, S, M>,
  // deno-lint-ignore no-explicit-any
): FeatureDef<N, any, any, S> & DirectCalling<M>;
/** Define a feature with explicit actions/reduce style — typed action creators + reducer handlers. */
export function feature<
  N extends string,
  S extends Record<string, unknown>,
  A extends Creators,
  E extends Creators = Record<string, never>,
>(
  name: N,
  config: ActionsFeatureConfig<N, S, A, E>,
): FeatureDef<N, A, E, S> & FlatActions<A>;
// deno-lint-ignore no-explicit-any
export function feature(name: string, config: any): any {
  const hasMethods = config.methods &&
    Object.keys(config.methods as Record<string, unknown>).length > 0;
  const hasGenerators = config.generators &&
    Object.keys(config.generators as Record<string, unknown>).length > 0;
  const hasActions = config.actions &&
    Object.keys(config.actions as Record<string, () => unknown>).length > 0;

  // Methods present (with optional generators, actions, effects) → unified builder
  if (hasMethods || (hasGenerators && !hasActions)) {
    return createFeatureFromMethods(
      name,
      config as MethodsFeatureConfig<string, Record<string, unknown>>,
    );
  }

  // Actions-only (no methods) → explicit builder
  return createFeatureFromActions(
    name,
    config as ActionsFeatureConfig<
      string,
      Record<string, unknown>,
      Creators,
      Creators
    >,
  );
}

// ── Methods-based feature (reactive style) ───────────────────────────

function createFeatureFromMethods<
  N extends string,
  S extends Record<string, unknown>,
  M extends Record<string, Method<S>> = Record<string, Method<S>>,
>(
  name: N,
  config: MethodsFeatureConfig<N, S, M>,
):
  & FeatureDef<N, Record<string, never>, Record<string, never>, S>
  & DirectCalling<M> {
  const prefix = name;
  const methods = (config.methods ?? {}) as Record<string, Method<S>>;
  const methodNames = Object.keys(methods);
  const rawGenerators = (config.generators ?? {}) as Record<
    string,
    GeneratorEntry
  >;
  const generatorNames = Object.keys(rawGenerators);
  const selectorNames = Object.keys(config.selectors ?? {});
  // deno-lint-ignore no-explicit-any
  const explicitActions = (config as any).actions as Creators | undefined;
  const explicitActionNames = Object.keys(explicitActions ?? {});
  // deno-lint-ignore no-explicit-any
  const explicitEffects = (config as any).effects as Creators | undefined;
  const explicitEffectNames = Object.keys(explicitEffects ?? {});
  // deno-lint-ignore no-explicit-any
  const explicitReduce = (config as any).reduce as
    | Record<string, (state: unknown, payload: unknown) => void>
    | undefined;
  // deno-lint-ignore no-explicit-any
  const explicitExecute = (config as any).execute as
    | Record<string, (app: ScopedApp, payload: unknown) => void | Promise<void>>
    | undefined;

  // Validate names against reserved keys — fail fast with clear message
  checkReservedKeys(name, methodNames, "method");
  checkReservedKeys(name, generatorNames, "generator");
  checkReservedKeys(name, explicitActionNames, "action");
  checkReservedKeys(name, explicitEffectNames, "effect");
  checkReservedKeys(name, selectorNames, "selector");

  // Validate no name collisions across methods, generators, actions, effects
  const allNames = new Map<string, string>();
  for (const n of methodNames) allNames.set(n, "method");
  for (const n of generatorNames) {
    if (allNames.has(n)) {
      throw new Error(
        `[feature:${name}] generator "${n}" collides with ${
          allNames.get(n)
        } of same name`,
      );
    }
    allNames.set(n, "generator");
  }
  for (const n of explicitActionNames) {
    if (allNames.has(n)) {
      throw new Error(
        `[feature:${name}] action "${n}" collides with ${
          allNames.get(n)
        } of same name`,
      );
    }
    allNames.set(n, "action");
  }
  for (const n of explicitEffectNames) {
    if (allNames.has(n)) {
      throw new Error(
        `[feature:${name}] effect "${n}" collides with ${
          allNames.get(n)
        } of same name`,
      );
    }
    allNames.set(n, "effect");
  }

  // Classify methods as sync or async (uses isAsyncFunction — symbol-based, minification-safe)
  const { syncMethods, asyncMethods } = classifyMethods(
    methods as FeatureMethods<Record<string, unknown>>,
  );

  // Build action creators from methods + generators
  const actionCreators: Record<
    string,
    // deno-lint-ignore no-explicit-any
    (...args: any[]) => Record<string, unknown>
  > = {};
  for (const key of methodNames) {
    actionCreators[key] = (...args: unknown[]) => ({ args });
  }
  // Generator actions — same payload shape as methods (args array)
  for (const key of generatorNames) {
    actionCreators[key] = (...args: unknown[]) => ({ args });
  }
  // Explicit actions — custom payload shapes
  if (explicitActions) {
    for (const key of explicitActionNames) {
      actionCreators[key] = explicitActions[key]!;
    }
  }
  // Add __setMethod actions for async mutations
  for (const key of asyncMethods) {
    actionCreators[setKey(key)] = (mutations: Mutation[], _origin: string) => ({
      mutations,
      _origin,
    });
  }
  // Add __error action for async failures
  if (asyncMethods.size > 0) {
    actionCreators["__error"] = (_method: string, error: string) => ({
      _method,
      error,
    });
  }

  const { typeToKey: actionTypeToKey } = buildCatalog(prefix, actionCreators);

  // Build effect creators
  const effectCreators: Record<
    string,
    // deno-lint-ignore no-explicit-any
    (...args: any[]) => Record<string, unknown>
  > = {};
  const effectKeys = Object.keys(config.effects ?? {});
  for (const key of effectKeys) {
    effectCreators[key] = (config.effects as Record<
      string,
      (...args: unknown[]) => Record<string, unknown>
    >)[key]!;
  }
  const { catalog: eCatalog } = buildCatalog(prefix, effectCreators);

  // Build machine
  let machine: MachineConfig | false;
  if (!config.machine) {
    machine = false;
  } else {
    machine = config.machine as MachineConfig;
  }

  // Auto-generate machine from listensTo
  if (config.listensTo?.length && machine === false) {
    const on: Record<string, string> = {};
    for (const key of methodNames) on[key] = "active";
    for (const key of asyncMethods) on[setKey(key)] = "active";
    if (asyncMethods.size > 0) on["__error"] = "active";
    for (const entry of config.listensTo) {
      const actionType = typeof entry === "string" ? entry : entry.type;
      on[actionType] = "active";
    }
    machine = { initial: "active", states: { active: on } };
  }

  // Inject __setMethod and __error transitions for async methods.
  // Clone first — never mutate the user-provided config object.
  if (machine !== false) {
    const cloned: MachineConfig = {
      ...machine,
      states: Object.fromEntries(
        Object.entries(machine.states).map(([k, v]) => [k, { ...v }]),
      ),
    };
    for (const stateConfig of Object.values(cloned.states)) {
      for (const [key, target] of Object.entries(stateConfig)) {
        if (
          !key.includes(":") && asyncMethods.has(key) && cloned.states[target]
        ) {
          cloned.states[target][setKey(key)] = target;
        }
      }
    }
    if (asyncMethods.size > 0) {
      for (const [stateName, stateConfig] of Object.entries(cloned.states)) {
        stateConfig["__error"] = stateName;
      }
    }
    machine = cloned;
    // Dev mode: print generated machine so auto-injected transitions are visible
    if (
      typeof (globalThis as Record<string, unknown>).__aioDev !== "undefined"
    ) {
      log.debug("aio", `${name} machine: ${JSON.stringify(machine, null, 2)}`);
    }
  }

  const foreignActions = detectForeignActions(machine, prefix);

  const allActionKeys = [
    ...methodNames,
    ...generatorNames,
    ...explicitActionNames,
    ...[...asyncMethods].map((k) => setKey(k)),
  ];
  if (asyncMethods.size > 0) allActionKeys.push("__error");

  // Validate machine if provided
  if (machine !== false) {
    validateMachine(name, machine, new Set(allActionKeys));
  }

  // Build reducer
  const reduce: FeatureReduceFn = (
    state: unknown,
    action: Msg,
  ): (Msg | ScheduleEffect)[] | void => {
    const s = state as Record<string, unknown>;
    const ownKey = actionTypeToKey.get(action.type);
    if (!ownKey) return;

    // Handle batched mutations from async methods
    if (ownKey.startsWith("__set")) {
      const payload = action.payload as { mutations: Mutation[] };
      applyMutations(s, payload.mutations);
      return;
    }

    // Error action — no state change
    if (ownKey === "__error") return;

    // Method-style: call method directly on draft
    const method = methods[ownKey];
    if (method) {
      if (syncMethods.has(ownKey)) {
        const args =
          ((action.payload as Record<string, unknown>)?.args as unknown[]) ??
            [];
        const result = (method as SyncMethod<S>)(s as S, ...args);
        return result ? (Array.isArray(result) ? result : [result]) : undefined;
      }
      if (asyncMethods.has(ownKey)) {
        const p = (action.payload ?? {}) as Record<string, unknown>;
        const args = (p.args as unknown[]) ?? [];
        const _callId = p._callId as string | undefined;
        return [{
          type: `${prefix}:__exec`,
          payload: { _method: ownKey, _args: args, _callId },
        }];
      }
      return; // method handled
    }

    // Explicit action-style: call reduce handler with custom payload
    if (explicitReduce) {
      const h = explicitReduce[ownKey];
      if (h) {
        return h(s, (action as { payload: unknown }).payload) as
          | (Msg | ScheduleEffect)[]
          | void;
      }
    }
  };

  // Build executor for async methods
  const execute: FeatureExecuteFn | undefined =
    asyncMethods.size > 0 || config.effects || explicitExecute
      ? (app: ScopedApp, effect: Msg): void => {
        // Handle async method execution
        if (effect.type === `${prefix}:__exec`) {
          const { _method, _args, _callId } = effect.payload as {
            _method: string;
            _args: unknown[];
            _callId?: string;
          };
          const method = methods[_method];
          if (!method || !asyncMethods.has(_method)) return;

          const batcher = createBatcher(prefix, (a) => app.dispatch(a));
          const proxy = createLiveProxy(
            name,
            prefix,
            _method,
            () => app.getState() as Record<string, unknown>,
            batcher,
          );
          (method as AsyncMethod<S>)(proxy as S, ..._args)
            .then((value) => {
              // If feature was disabled while method was running, reject instead of resolving with stale result
              if (
                (app as Record<string, unknown>)._isDisabled &&
                ((app as Record<string, unknown>)._isDisabled as () =>
                  boolean)()
              ) {
                resolveCall(
                  _callId,
                  undefined,
                  new Error(
                    `[${name}] feature disabled while ${_method}() was running`,
                  ),
                );
              } else {
                resolveCall(_callId, value);
              }
            })
            .catch((e: Error) => {
              resolveCall(_callId, undefined, e);
              const _onError = (app as Record<string, unknown>)._onError as
                | ((err: AioError) => void)
                | undefined;
              if (_onError) {
                _onError(
                  createAioError("EFFECT_ASYNC_ERROR", e, {
                    featureName: name,
                    actionType: `${prefix}:${_method}`,
                  }),
                );
              } else {
                log.error("feature", `${name} ${_method}() threw: ${e}`);
              }
              app.dispatch({
                type: `${prefix}:__error`,
                payload: { _method, error: String(e) },
                _source: "Effect",
              } as Msg);
            });
          return;
        }

        // Handle effects — methods-style execute config and/or explicit execute handlers
        const executeHandlers = {
          ...(typeof config.execute === "object" ? config.execute : {}),
          ...(explicitExecute ?? {}),
        } as Record<
          string,
          (app: ScopedApp, payload: unknown) => void | Promise<void>
        >;
        if (Object.keys(executeHandlers).length > 0) {
          const effectTypeToKey = new Map<string, string>();
          for (const k of effectKeys) effectTypeToKey.set(`${prefix}:${k}`, k);
          const key = effectTypeToKey.get(effect.type) ?? effect.type;
          const h = executeHandlers[key];
          if (h) {
            void h(
              app as ScopedApp<S>,
              (effect as { payload: unknown }).payload,
            );
          }
        } else if (config.execute && typeof config.execute === "function") {
          const emitMap: Record<string, string> = {};
          for (const k of effectKeys) emitMap[k] = `${prefix}:${k}`;
          (config.execute as (
            app: ScopedApp<S>,
            effect: Msg,
            ctx: { emit: Record<string, unknown> },
          ) => void)(
            app as ScopedApp<S>,
            effect,
            { emit: emitMap },
          );
        }
      }
      : undefined;

  const { flows, flowTriggers } = buildFlows(
    rawGenerators,
    new Set(allActionKeys),
    name,
    config,
    "spread",
  );

  // Assemble internals
  const internals: Omit<
    FeatureAio,
    "actions" | "effects" | "selectors" | "bound"
  > = {
    state: config.state as Record<string, unknown>,
    machine,
    reduce,
    execute,
    actionKeys: allActionKeys,
    effectKeys,
    id: prefix,
    actionTypeToKey,
    foreignActions,
    initType: `${prefix}:__init`,
    destroyType: `${prefix}:__destroy`,
    crossDispatchPrefixes: resolveCrossDispatchPrefixes(config.dispatchTo),
    onInit: config.onInit as ((app: ScopedApp) => void) | undefined,
    onDestroy: config.onDestroy as ((app: ScopedApp) => void) | undefined,
    methods: methods as FeatureMethods<Record<string, unknown>>,
    syncMethods,
    asyncMethods,
    flows: Object.keys(flows).length > 0 ? flows : undefined,
    flowTriggers: flowTriggers.size > 0 ? flowTriggers : undefined,
    validate: config.validate,
    persistExclude: config.persist?.exclude,
  };

  const selectors = scopeSelectors(name, config.selectors);

  // Build public catalog — methods + generators (args-style) + explicit actions (custom payload)
  const publicCatalog: Record<string, unknown> = {};
  for (const key of [...methodNames, ...generatorNames]) {
    const label = `${prefix}:${key}`;
    publicCatalog[key] = Object.assign(
      (...args: unknown[]) => ({ type: label, payload: { args } }),
      { type: label },
    );
  }
  // Explicit actions — custom payload shape
  if (explicitActions) {
    for (const key of explicitActionNames) {
      const label = `${prefix}:${key}`;
      publicCatalog[key] = Object.assign(
        (...args: unknown[]) => ({
          type: label,
          payload: explicitActions[key]!(...args) ?? {},
        }),
        { type: label },
      );
    }
  }

  const def: Record<string, unknown> = {
    __aio: {
      ...internals,
      selectors,
      actions: publicCatalog,
      effects: eCatalog,
      bound: false,
    },
  };

  // Flatten onto feature def
  const selectorKeys = new Set(Object.keys(config.selectors ?? {}));
  for (const key of selectorKeys) {
    if (RESERVED_KEYS.has(key)) {
      throw new Error(
        `[${name}] selector '${key}' collides with reserved property`,
      );
    }
  }
  for (const [key, value] of Object.entries(publicCatalog)) {
    if (RESERVED_KEYS.has(key)) continue;
    if (selectorKeys.has(key)) {
      throw new Error(
        `[${name}] method '${key}' collides with selector of same name`,
      );
    }
    def[key] = value;
  }

  return def as unknown as
    & FeatureDef<N, Record<string, never>, Record<string, never>, S>
    & DirectCalling<M>;
}

// ── Shared helpers ────────────────────────────────────────────────────

/** Detect foreign action types from machine transitions (types containing ':' from other features) */
function detectForeignActions(
  machine: MachineConfig | false,
  prefix: string,
): string[] {
  if (machine === false) return [];
  const foreignSet = new Set<string>();
  for (const sc of Object.values(machine.states)) {
    for (const key of Object.keys(sc)) {
      if (key.includes(":") && !key.startsWith(prefix + ":")) {
        foreignSet.add(key);
      }
    }
  }
  return [...foreignSet];
}

/** Resolve cross-dispatch prefixes from dispatchTo config (feature refs → prefix strings) */
function resolveCrossDispatchPrefixes(
  dispatchTo: (string | FeatureDef | { name: string })[] | undefined,
): Set<string> {
  return new Set(
    (dispatchTo ?? []).map((f) =>
      typeof f === "string"
        ? f
        : ("__aio" in f
          ? (f as FeatureDef).__aio.id
          : (f as { name: string }).name)
    ),
  );
}

/** Auto-scope selectors: user writes (s: S) => ..., we wrap to extract state[name] */
function scopeSelectors<S>(
  name: string,
  selectors: Record<string, (state: S) => unknown> | undefined,
): Record<string, (state: unknown) => unknown> {
  const scoped: Record<string, (state: unknown) => unknown> = {};
  if (!selectors) return scoped;
  for (const [key, fn] of Object.entries(selectors)) {
    scoped[key] = (fullState: unknown) =>
      fn((fullState as Record<string, unknown>)[name] as S);
  }
  return scoped;
}

/** Build flow definitions from generator entries */
function buildFlows(
  rawGenerators: Record<string, GeneratorEntry>,
  actionKeySet: Set<string>,
  name: string,
  config: { cancelOn?: Record<string, (string | { type: string })[]> },
  argsStyle: "spread" | "payload",
): { flows: Record<string, FlowDef>; flowTriggers: Map<string, string> } {
  const flows: Record<string, FlowDef> = {};
  const flowTriggers = new Map<string, string>();
  for (const [key, fn] of Object.entries(rawGenerators)) {
    if (argsStyle === "payload" && !actionKeySet.has(key)) {
      throw new Error(
        `[feature:${name}] generator '${key}' must match an action key`,
      );
    }
    const triggers = config.cancelOn?.[key] ?? fn.cancelOn;
    const cancelOnStrings = triggers?.map((t: string | { type: string }) =>
      typeof t === "string" ? t : t.type
    );
    flows[key] = {
      trigger: key,
      generator: fn,
      _stepNames: [],
      cancelOn: cancelOnStrings,
      argsStyle,
    };
    flowTriggers.set(key, key);
  }
  return { flows, flowTriggers };
}

// ── Actions-based feature (classic style) ─────────────────────────────

function createFeatureFromActions<
  N extends string,
  S extends Record<string, unknown>,
  A extends Creators,
  E extends Creators,
>(
  name: N,
  config: ActionsFeatureConfig<N, S, A, E>,
): FeatureDef<N, A, E, S> & FlatActions<A> {
  const prefix = name;
  const actionKeySet = new Set(Object.keys(config.actions));
  const effectKeyList = Object.keys(config.effects ?? {});
  const selectorNames = Object.keys(config.selectors ?? {});

  // Validate names against reserved keys — fail fast with clear message
  checkReservedKeys(name, [...actionKeySet], "action");
  checkReservedKeys(name, effectKeyList, "effect");
  checkReservedKeys(name, selectorNames, "selector");

  const machine = (config.machine === false || config.machine == null)
    ? false
    : config.machine as MachineConfig;

  // Build catalogs
  const { catalog: aCatalog, typeToKey: actionTypeToKey } = buildCatalog(
    prefix,
    config.actions,
  );
  const { catalog: eCatalog } = buildCatalog(prefix, config.effects ?? {});

  // Validate machine
  if (machine !== false) {
    validateMachine(name, machine, actionKeySet);
  }

  const foreignActions = detectForeignActions(machine, prefix);

  // Build flows from generators (keyed by trigger action key)
  const rawGenerators = (config.generators ?? {}) as Record<
    string,
    GeneratorEntry
  >;
  const { flows, flowTriggers } = buildFlows(
    rawGenerators,
    actionKeySet,
    name,
    config,
    "payload",
  );

  // Default noop reducer when only generators are used
  const noopReduce: FeatureReduceFn = () => undefined;

  // Build { on } map: camelCase key → full type string (for function-form reduce/execute)
  const onMap: Record<string, string> = {};
  for (const key of actionKeySet) onMap[key] = `${prefix}:${key}`;
  const emitMap: Record<string, string> = {};
  for (const key of effectKeyList) emitMap[key] = `${prefix}:${key}`;

  // Normalize reduce: object form → FeatureReduceFn, function form → wrap with { on }
  let reduceFn: FeatureReduceFn;
  if (!config.reduce) {
    reduceFn = noopReduce;
  } else if (typeof config.reduce === "object") {
    const handlers = config.reduce as Record<
      string,
      (state: unknown, payload: unknown) => void
    >;
    reduceFn = (
      state: unknown,
      action: Msg,
    ): (Msg | ScheduleEffect)[] | void => {
      const key = actionTypeToKey.get(action.type);
      if (!key) {
        // Foreign action key — use full type string
        const h = handlers[action.type];
        if (h) {
          return h(state, (action as { payload: unknown }).payload) as
            | (Msg | ScheduleEffect)[]
            | void;
        }
        return;
      }
      const h = handlers[key];
      if (h) {
        return h(state, (action as { payload: unknown }).payload) as
          | (Msg | ScheduleEffect)[]
          | void;
      }
    };
  } else {
    // Function form: wrap to inject { on } instead of { A, E }
    const userReduceFn = config.reduce as (
      state: unknown,
      action: Msg,
      ctx: { on: Record<string, string> },
    ) => (Msg | ScheduleEffect)[] | void;
    reduceFn = (state: unknown, action: Msg): (Msg | ScheduleEffect)[] | void =>
      userReduceFn(state, action, { on: onMap });
  }

  // Normalize execute: object form → FeatureExecuteFn, function form → wrap with { emit }
  let executeFn: FeatureExecuteFn | undefined;
  if (!config.execute) {
    executeFn = undefined;
  } else if (typeof config.execute === "object") {
    const handlers = config.execute as Record<
      string,
      (app: ScopedApp, payload: unknown) => void | Promise<void>
    >;
    const effectTypeToKey = new Map<string, string>();
    for (const key of effectKeyList) {
      effectTypeToKey.set(`${prefix}:${key}`, key);
    }
    executeFn = (app: ScopedApp, effect: Msg): void => {
      const key = effectTypeToKey.get(effect.type) ?? effect.type;
      const h = handlers[key];
      if (h) void h(app, (effect as { payload: unknown }).payload);
    };
  } else {
    // Function form: wrap to inject { emit } instead of { E, A }
    const userExecuteFn = config.execute as (
      app: ScopedApp,
      effect: Msg,
      ctx: { emit: Record<string, string> },
    ) => void;
    executeFn = (app: ScopedApp, effect: Msg): void =>
      userExecuteFn(app, effect, { emit: emitMap });
  }

  const internals: Omit<
    FeatureAio,
    "actions" | "effects" | "selectors" | "bound"
  > = {
    state: config.state,
    machine,
    reduce: reduceFn,
    execute: executeFn,
    actionKeys: [...actionKeySet],
    effectKeys: effectKeyList,
    id: prefix,
    actionTypeToKey,
    foreignActions,
    initType: `${prefix}:__init`,
    destroyType: `${prefix}:__destroy`,
    crossDispatchPrefixes: resolveCrossDispatchPrefixes(config.dispatchTo),
    onInit: config.onInit as ((app: ScopedApp) => void) | undefined,
    onDestroy: config.onDestroy as ((app: ScopedApp) => void) | undefined,
    flows: Object.keys(flows).length > 0 ? flows : undefined,
    flowTriggers: flowTriggers.size > 0 ? flowTriggers : undefined,
    validate: config.validate,
    persistExclude: config.persist?.exclude,
  };

  // Validate selector names don't collide with reserved keys
  const selectorKeys = new Set(Object.keys(config.selectors ?? {}));
  for (const key of selectorKeys) {
    if (RESERVED_KEYS.has(key)) {
      throw new Error(
        `[${name}] selector '${key}' collides with reserved property`,
      );
    }
  }

  const scopedSelectors = scopeSelectors(name, config.selectors);

  const def: Record<string, unknown> = {
    __aio: {
      ...internals,
      selectors: scopedSelectors,
      actions: aCatalog as unknown,
      effects: eCatalog as unknown,
      bound: false,
    },
  };

  // Flatten action creators + string constants directly onto the feature def
  flattenOnto(def, aCatalog, selectorKeys, name);

  return def as unknown as FeatureDef<N, A, E, S> & FlatActions<A>;
}
