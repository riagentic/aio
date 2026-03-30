// feature-compose.ts — composeFeatures + resolve + registry

import {
  type Draft,
  enablePatches,
  type Patch,
  produceWithPatches,
} from "immer";
import { log } from "./logger.ts";
import type { ScheduleEffect } from "./schedule.ts";
import type { FlowDef } from "./flow.ts";
import {
  cancelFeatureFlows,
  createFlowReducer,
  notifyFlowListeners,
  notifyStateListeners,
  runFlow,
} from "./flow.ts";
import { resolveCall } from "./feature-impl.ts";

enablePatches();
import type { ReduceBreakdown } from "./time-travel.ts";
import { type AioError, createAioError } from "./error.ts";
import { diagEmit } from "./diagnostic-bus.ts";
import type {
  FeatureDef,
  FeatureEntry,
  Msg,
  ScopedApp,
} from "./feature-types.ts";
import { tagSource } from "./feature-types.ts";

/** Feature status info for health/status reporting */
export type FeatureStatus = {
  name: string;
  status: string | undefined;
  enabled: boolean;
  errors: number;
  lastAction?: string;
  lastActionAt?: number;
};

/** Resolved + sorted features with dependency info */
export type ComposedFeatures = {
  initialState: Record<string, unknown>;
  reduce: (
    state: Record<string, unknown>,
    action: Msg,
  ) => { state: Record<string, unknown>; effects: (Msg | ScheduleEffect)[] };
  execute: (
    app: { dispatch: (a: Msg) => void; getState: () => unknown },
    effect: Msg,
  ) => void;
  features: FeatureDef[];
  featureNames: string[];
  /** Init all features in dependency order */
  initAll: (
    app: { dispatch: (a: Msg) => void; getState: () => unknown },
  ) => void;
  /** Destroy all features in reverse dependency order */
  destroyAll: (
    app: { dispatch: (a: Msg) => void; getState: () => unknown },
  ) => void;
  /** Feature registry for enable/disable/status/health */
  registry: {
    enable: (
      name: string,
      app: { dispatch: (a: Msg) => void; getState: () => unknown },
    ) => void;
    disable: (
      name: string,
      app: { dispatch: (a: Msg) => void; getState: () => unknown },
    ) => void;
    isEnabled: (name: string) => boolean;
    status: (
      name: string,
      state: Record<string, unknown>,
    ) => string | undefined;
    health: (state: Record<string, unknown>) => FeatureStatus[];
    /** Set callback for schedule cleanup on feature disable */
    setOnDisable: (fn: (prefix: string) => void) => void;
  };
  /** Side-channel getter for last reduce breakdown (only when perfCheck is on) */
  lastBreakdown?: () => ReduceBreakdown | undefined;
};

/** Resolve feature entries, validate dependencies, return topologically sorted list */
function resolveFeatures(entries: FeatureEntry[]): FeatureDef[] {
  const features: FeatureDef[] = [];
  const deps = new Map<string, string[]>();

  const seen = new Set<string>();
  for (const entry of entries) {
    const f = "__aio" in entry
      ? entry as FeatureDef
      : (entry as { feature: FeatureDef }).feature;
    if (seen.has(f.__aio.id)) {
      throw new Error(`duplicate feature name: '${f.__aio.id}'`);
    }
    seen.add(f.__aio.id);
    features.push(f);
    if ("__aio" in entry) {
      deps.set(f.__aio.id, []);
    } else {
      deps.set(f.__aio.id, (entry as { dependsOn?: string[] }).dependsOn ?? []);
    }
  }

  // Validate dependencies exist
  const names = new Set(features.map((f) => f.__aio.id));
  for (const [name, depList] of deps) {
    for (const dep of depList) {
      if (!names.has(dep)) {
        throw new Error(
          `[feature:${name}] depends on unknown feature '${dep}'`,
        );
      }
    }
  }

  // Cycle detection (DFS)
  const visited = new Set<string>();
  const inStack = new Set<string>();
  function visit(name: string, path: string[]): void {
    if (inStack.has(name)) {
      throw new Error(`dependency cycle: ${[...path, name].join(" → ")}`);
    }
    if (visited.has(name)) return;
    inStack.add(name);
    for (const dep of deps.get(name) ?? []) {
      visit(dep, [...path, name]);
    }
    inStack.delete(name);
    visited.add(name);
  }
  for (const name of names) visit(name, []);

  // Topological sort
  const sorted: FeatureDef[] = [];
  const placed = new Set<string>();
  function place(name: string): void {
    if (placed.has(name)) return;
    for (const dep of deps.get(name) ?? []) place(dep);
    placed.add(name);
    sorted.push(features.find((f) => f.__aio.id === name)!);
  }
  for (const f of features) place(f.__aio.id);

  return sorted;
}

/** Compose features into {initialState, reduce, execute} compatible with existing dispatch loop */
export type CircuitBreakerConfig = {
  /** Max errors before auto-disabling a feature (default: 0 = disabled) */
  maxErrors?: number;
  /** Called when a feature is auto-disabled by circuit breaker */
  onTrip?: (featureName: string, errorCount: number) => void;
  /** Rolling window in ms — only count errors within this period. Omit for cumulative counting. */
  window?: number;
};

/** Compose an array of features into a single dispatch/reduce/execute pipeline with dependency resolution. */
export function composeFeatures(
  entries: FeatureEntry[],
  opts?: {
    onFeatureError?: (err: AioError) => void;
    circuitBreaker?: CircuitBreakerConfig;
    perfCheck?: boolean;
  },
): ComposedFeatures {
  if (entries.length === 0) {
    log.warn("aio", "no features provided to composeFeatures()");
  }

  const features = resolveFeatures(entries);
  const _reportError = opts?.onFeatureError;
  const _circuitBreaker = opts?.circuitBreaker;
  const _cbMaxErrors = _circuitBreaker?.maxErrors ?? 0;
  const _cbWindow = _circuitBreaker?.window;
  let _cbApp:
    | { dispatch: (a: Msg) => void; getState: () => unknown }
    | undefined;
  let onFeatureDisable: ((prefix: string) => void) | undefined;
  const _perfCheck = opts?.perfCheck ?? false;
  let _lastBreakdown: ReduceBreakdown | undefined;

  // ── Validation ──
  for (const f of features) {
    if (f.__aio.state._status !== undefined) {
      log.warn(
        "feature",
        `${f.__aio.id} state._status is reserved for machine status — rename it to avoid conflicts`,
      );
    }
    if (f.__aio.actionKeys.length === 0) {
      log.warn(
        "feature",
        `${f.__aio.id} has no actions — is this intentional?`,
      );
    }
  }

  // ── Initial state ──
  const initialState: Record<string, unknown> = {};
  for (const f of features) {
    const machine = f.__aio.machine;
    const status = machine === false ? undefined : machine.initial;
    initialState[f.__aio.id] = status != null
      ? { ...f.__aio.state, _status: status }
      : { ...f.__aio.state };
  }

  // ── Action routing ──
  const ownByPrefix = new Map<string, FeatureDef>();
  const listenersByType = new Map<string, FeatureDef[]>();

  for (const f of features) {
    ownByPrefix.set(f.__aio.id, f);
    // Foreign action listeners (detected from machine)
    for (const foreignType of f.__aio.foreignActions) {
      const list = listenersByType.get(foreignType) ?? [];
      list.push(f);
      listenersByType.set(foreignType, list);
    }
  }

  // ── Per-feature reduce ──
  type FeaturePatches = { feature: string; ops: Patch[] };
  type ReduceResult = {
    state: Record<string, unknown>;
    effects: (Msg | ScheduleEffect)[];
    patches?: FeaturePatches | FeaturePatches[];
    _bd?: { produce: number; clone: number; spread: number };
  };

  function reduceFeature(
    f: FeatureDef,
    fullState: Record<string, unknown>,
    action: Msg,
  ): ReduceResult {
    const { machine, reduce, actionTypeToKey, flowTriggers } = f.__aio;
    const featureName = f.__aio.id;
    const featureState = fullState[featureName] as Record<string, unknown>;

    // Check if this action triggers a flow
    const ownKey = actionTypeToKey.get(action.type);
    const flowName = ownKey && flowTriggers
      ? flowTriggers.get(ownKey)
      : undefined;

    // Machine guard
    if (machine !== false) {
      const currentStatus = (featureState._status ?? machine.initial) as string;
      const stateConfig = machine.states[currentStatus];
      if (!stateConfig) return { state: fullState, effects: [] };

      // Lookup: own action → camelCase key; foreign → full type string
      const lookupKey = ownKey ?? action.type;
      const transitions = stateConfig;

      if (!(lookupKey in transitions)) {
        const allowed = Object.keys(transitions).join(", ");
        const msg =
          `[aio:${featureName}] '${action.type}' blocked — machine is in '${currentStatus}' state (allowed: ${
            allowed || "none"
          })`;
        if ((globalThis as Record<string, unknown>).__aioDev) {
          log.warn("aio", msg);
        } else log.debug("aio", msg);
        diagEmit({
          type: "action-guarded",
          severity: "info",
          source: "feature-compose",
          message:
            `'${action.type}' blocked — machine '${featureName}' in '${currentStatus}' (allowed: ${
              allowed || "none"
            })`,
          detail: {
            featureName,
            actionType: action.type,
            machineState: currentStatus,
          },
          hint:
            "This action is not allowed in the current machine state. May be intentional (guard) or a bug.",
        });
        return { state: fullState, effects: [] }; // invalid transition → drop
      }

      // Run reduce with Immer (feature's slice only)
      // _status is set INSIDE the draft so produceWithPatches captures it in patches
      const targetStatus = transitions[lookupKey];
      let effects: (Msg | ScheduleEffect)[] = [];
      const t0 = _perfCheck ? performance.now() : 0;
      let nextSlice: Record<string, unknown>;
      let featurePatches: Patch[] = [];
      try {
        [nextSlice, featurePatches] = produceWithPatches(
          featureState,
          (draft: Draft<Record<string, unknown>>) => {
            const result = reduce(draft, action, {
              A: f.__aio.actions,
              E: f.__aio.effects,
            });
            if (Array.isArray(result)) effects = result;
            // Set machine _status inside draft so patch captures the transition
            if (draft._status !== targetStatus) {
              draft._status = targetStatus;
            }
          },
        );
      } catch (e) {
        const methodName = ownKey ?? action.type;
        const orig = e instanceof Error ? e.message : String(e);
        throw new Error(
          `Feature '${featureName}' method '${methodName}' threw: ${orig}`,
          { cause: e },
        );
      }
      const tProduce = _perfCheck ? performance.now() - t0 : 0;

      // Clone effects individually to detach from Immer draft (AIO-146)
      const t1 = _perfCheck ? performance.now() : 0;
      if (effects.length) {
        const cloned: typeof effects = [];
        for (const eff of effects) {
          try {
            cloned.push(structuredClone(eff));
          } catch {
            try {
              cloned.push(JSON.parse(JSON.stringify(eff)));
            } catch {
              log.warn("feature", "effect not cloneable — dropped");
            }
          }
        }
        effects = cloned;
      }
      const tClone = _perfCheck ? performance.now() - t1 : 0;

      // Inject flow trigger effect if this action starts a flow
      if (flowName) {
        effects.push({
          type: `${f.__aio.id}:__flow`,
          payload: { _flowName: flowName, _triggerAction: action },
        });
      }

      // State validation (nextSlice already has correct _status from draft)
      if (f.__aio.validate) {
        const result = f.__aio.validate(nextSlice);
        if (result !== true) {
          if (_reportError) {
            _reportError(
              createAioError(
                "REDUCE_ERROR",
                `state validation failed: ${result}`,
                { featureName, actionType: action.type },
              ),
            );
          } else {log.error(
              "feature",
              `${featureName} state validation failed: ${result}`,
            );}
          return { state: fullState, effects: [] }; // reject — keep old state
        }
      }

      const t2 = _perfCheck ? performance.now() : 0;
      const returnObj = {
        state: { ...fullState, [featureName]: nextSlice },
        effects,
        patches: featurePatches.length > 0
          ? { feature: featureName, ops: featurePatches }
          : undefined,
      };
      const tSpread = _perfCheck ? performance.now() - t2 : 0;

      return _perfCheck
        ? {
          ...returnObj,
          _bd: { produce: tProduce, clone: tClone, spread: tSpread },
        }
        : returnObj;
    }

    // Simple path — no guards, no _status
    let effects: (Msg | ScheduleEffect)[] = [];
    const st0 = _perfCheck ? performance.now() : 0;
    let nextSlice: Record<string, unknown>;
    let featurePatches: Patch[] = [];
    try {
      [nextSlice, featurePatches] = produceWithPatches(
        featureState,
        (draft: Draft<Record<string, unknown>>) => {
          const result = reduce(draft, action, {
            A: f.__aio.actions,
            E: f.__aio.effects,
          });
          if (Array.isArray(result)) effects = result;
        },
      );
    } catch (e) {
      const methodName = ownKey ?? action.type;
      const orig = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Feature '${featureName}' method '${methodName}' threw: ${orig}`,
        { cause: e },
      );
    }
    const stProduce = _perfCheck ? performance.now() - st0 : 0;

    // Clone effects individually to detach from Immer draft (AIO-146)
    const st1 = _perfCheck ? performance.now() : 0;
    if (effects.length) {
      const cloned: typeof effects = [];
      for (const eff of effects) {
        try {
          cloned.push(structuredClone(eff));
        } catch {
          try {
            cloned.push(JSON.parse(JSON.stringify(eff)));
          } catch {
            log.warn("feature", "effect not cloneable — dropped");
          }
        }
      }
      effects = cloned;
    }
    const stClone = _perfCheck ? performance.now() - st1 : 0;

    // State validation
    if (f.__aio.validate) {
      const result = f.__aio.validate(nextSlice);
      if (result !== true) {
        if (_reportError) {
          _reportError(
            createAioError(
              "REDUCE_ERROR",
              `state validation failed: ${result}`,
              { featureName, actionType: action.type },
            ),
          );
        } else {log.error(
            "feature",
            `${featureName} state validation failed: ${result}`,
          );}
        return { state: fullState, effects: [] }; // reject — keep old state
      }
    }

    // Inject flow trigger effect if this action starts a flow
    if (flowName) {
      effects.push({
        type: `${f.__aio.id}:__flow`,
        payload: { _flowName: flowName, _triggerAction: action },
      });
    }

    const simpleReturn: ReduceResult = {
      state: { ...fullState, [featureName]: nextSlice },
      effects,
      patches: featurePatches.length > 0
        ? { feature: featureName, ops: featurePatches }
        : undefined,
    };
    return _perfCheck
      ? {
        ...simpleReturn,
        _bd: { produce: stProduce, clone: stClone, spread: 0 },
      }
      : simpleReturn;
  }

  // ── Feature enable/disable registry ──
  const disabledFeatures = new Set<string>();
  const featureErrors = new Map<string, number[]>(); // error timestamps
  const featureLastAction = new Map<string, { type: string; at: number }>();

  /** Increment error count and trip circuit breaker if threshold exceeded */
  function countFeatureError(name: string): void {
    const now = Date.now();
    const timestamps = featureErrors.get(name) ?? [];
    timestamps.push(now);
    if (_cbWindow) {
      const cutoff = now - _cbWindow;
      while (timestamps.length && timestamps[0]! < cutoff) timestamps.shift();
    }
    featureErrors.set(name, timestamps);
    const count = timestamps.length;
    if (
      _cbMaxErrors > 0 && count >= _cbMaxErrors &&
      !disabledFeatures.has(name) && _cbApp
    ) {
      registry.disable(name, _cbApp);
      if (_circuitBreaker?.onTrip) _circuitBreaker.onTrip(name, count);
      if (_reportError) {
        _reportError(
          createAioError(
            "EFFECT_ERROR",
            `circuit breaker tripped: feature "${name}" auto-disabled after ${count} errors${
              _cbWindow ? ` in ${_cbWindow}ms` : ""
            }`,
            { featureName: name },
          ),
        );
      }
    }
  }

  // ── Flow reducers (handle __FlowState actions) ──
  const flowReducers = new Map<string, ReturnType<typeof createFlowReducer>>();
  for (const f of features) {
    if (f.__aio.flows && Object.keys(f.__aio.flows).length > 0) {
      flowReducers.set(f.__aio.id, createFlowReducer(f.__aio.id));
    }
  }

  // ── Root reducer ──
  const rootReduce = (
    state: Record<string, unknown>,
    action: Msg,
  ): ReduceResult => {
    let currentState = state;
    const allEffects: (Msg | ScheduleEffect)[] = [];
    const allPatches: Array<{ feature: string; ops: Patch[] }> = [];

    // Handle flow state updates (__FlowState) — produceWithPatches on feature slice
    if (
      typeof action.type === "string" && action.type.endsWith(":__FlowState")
    ) {
      const colonIdx = action.type.indexOf(":");
      const prefix = action.type.slice(0, colonIdx);
      const flowReducer = flowReducers.get(prefix);
      if (flowReducer) {
        const featureSlice = (currentState[prefix] ?? {}) as Record<
          string,
          unknown
        >;
        const payload = action.payload as { _slice: Record<string, unknown> };
        const [nextSlice, flowPatches] = produceWithPatches(
          featureSlice,
          (draft: Draft<Record<string, unknown>>) => {
            const incoming = payload._slice;
            // Apply incoming fields
            for (const key of Object.keys(incoming)) {
              draft[key] = incoming[key];
            }
            // Remove keys not in incoming slice
            for (const key of Object.keys(draft)) {
              if (!(key in incoming)) delete draft[key];
            }
          },
        );
        const nextState = { ...currentState, [prefix]: nextSlice };
        notifyStateListeners(nextState);
        return {
          state: nextState,
          effects: [],
          patches: flowPatches.length > 0
            ? { feature: prefix, ops: flowPatches }
            : undefined,
        };
      }
      return { state: currentState, effects: [] };
    }

    // Handle lifecycle actions (Init/Destroy) — produceWithPatches on feature slice
    // Continue routing so foreign action listeners can react to lifecycle events
    let isLifecycle = false;
    for (const f of features) {
      if (action.type === f.__aio.initType) {
        const machine = f.__aio.machine;
        const status = machine === false ? undefined : machine.initial;
        const existing = currentState[f.__aio.id] as
          | Record<string, unknown>
          | undefined;
        const base = { ...f.__aio.state, ...existing };
        const targetSlice: Record<string, unknown> = status != null
          ? { ...base, _status: status }
          : base;
        const featureSlice = (existing ?? {}) as Record<string, unknown>;
        const [nextFeature, initPatches] = produceWithPatches(
          featureSlice,
          (draft: Draft<Record<string, unknown>>) => {
            for (const key of Object.keys(targetSlice)) {
              draft[key] = targetSlice[key];
            }
            // Remove keys not in target
            for (const key of Object.keys(draft)) {
              if (!(key in targetSlice)) delete draft[key];
            }
          },
        );
        currentState = { ...currentState, [f.__aio.id]: nextFeature };
        if (initPatches.length > 0) {
          allPatches.push({ feature: f.__aio.id, ops: initPatches });
        }
        isLifecycle = true;
        break;
      }
      if (action.type === f.__aio.destroyType) {
        const machine = f.__aio.machine;
        const targetSlice: Record<string, unknown> = machine === false
          ? { ...f.__aio.state }
          : { ...f.__aio.state, _status: machine.initial };
        const featureSlice = (currentState[f.__aio.id] ?? {}) as Record<
          string,
          unknown
        >;
        const [nextFeature, destroyPatches] = produceWithPatches(
          featureSlice,
          (draft: Draft<Record<string, unknown>>) => {
            for (const key of Object.keys(targetSlice)) {
              draft[key] = targetSlice[key];
            }
            for (const key of Object.keys(draft)) {
              if (!(key in targetSlice)) delete draft[key];
            }
          },
        );
        currentState = { ...currentState, [f.__aio.id]: nextFeature };
        if (destroyPatches.length > 0) {
          allPatches.push({ feature: f.__aio.id, ops: destroyPatches });
        }
        isLifecycle = true;
        break;
      }
    }

    // Route to owning feature (by prefix) — skip for lifecycle actions (state already handled)
    const rt0 = _perfCheck ? performance.now() : 0;
    let ownerBd: { produce: number; clone: number; spread: number } | undefined;
    if (!isLifecycle) {
      const colonIdx = (action.type as string).indexOf(":");
      if (colonIdx !== -1) {
        const prefix = (action.type as string).slice(0, colonIdx);
        const owner = ownByPrefix.get(prefix);
        if (owner && !disabledFeatures.has(owner.__aio.id)) {
          const result = reduceFeature(owner, currentState, action);
          currentState = result.state;
          allEffects.push(...result.effects);
          if (result.patches) {
            if (Array.isArray(result.patches)) {
              allPatches.push(...result.patches);
            } else allPatches.push(result.patches);
          }
          ownerBd = result._bd;
          featureLastAction.set(owner.__aio.id, {
            type: action.type,
            at: Date.now(),
          });
        }
      }
    }
    const tRouting = _perfCheck ? performance.now() - rt0 : 0;

    // Route to foreign action listeners
    const lt0 = _perfCheck ? performance.now() : 0;
    const listeners = listenersByType.get(action.type);
    if (listeners) {
      for (const listener of listeners) {
        if (disabledFeatures.has(listener.__aio.id)) continue;
        const result = reduceFeature(listener, currentState, action);
        currentState = result.state;
        allEffects.push(...result.effects);
        if (result.patches) {
          if (Array.isArray(result.patches)) allPatches.push(...result.patches);
          else allPatches.push(result.patches);
        }
        featureLastAction.set(listener.__aio.id, {
          type: action.type,
          at: Date.now(),
        });
      }
    }
    const tListeners = _perfCheck ? performance.now() - lt0 : 0;

    if (_perfCheck) {
      _lastBreakdown = {
        produce: ownerBd?.produce ?? 0,
        clone: ownerBd?.clone ?? 0,
        spread: ownerBd?.spread ?? 0,
        routing: tRouting,
        listeners: tListeners,
      };
    }

    // Notify waiting flows (ctx.waitFor) about dispatched actions
    notifyFlowListeners(action);
    notifyStateListeners(currentState);

    // Reject pending call() if the action was blocked (machine dropped it, feature disabled, etc.)
    const callId = (action.payload as Record<string, unknown>)?._callId as
      | string
      | undefined;
    if (callId) {
      const forwarded = allEffects.some((e) =>
        typeof e === "object" && "payload" in e &&
        (e as Msg).type.endsWith(":__exec") &&
        ((e as Msg).payload as Record<string, unknown>)?._callId === callId
      );
      if (!forwarded) {
        resolveCall(
          callId,
          undefined,
          new Error(
            `call('${action.type}'): blocked — machine guard, feature disabled, or not found`,
          ),
        );
      }
    }

    return {
      state: currentState,
      effects: allEffects,
      patches: allPatches.length > 0 ? allPatches : undefined,
    };
  };

  // ── Flow executors ──
  // Flows are triggered by actions via internal __flow effects from the reducer
  const flowsByPrefix = new Map<
    string,
    {
      featureName: string;
      flows: Record<string, FlowDef>;
      triggers: Map<string, string>;
    }
  >();
  for (const f of features) {
    if (
      f.__aio.flows && f.__aio.flowTriggers &&
      Object.keys(f.__aio.flows).length > 0
    ) {
      flowsByPrefix.set(f.__aio.id, {
        featureName: f.__aio.id,
        flows: f.__aio.flows,
        triggers: f.__aio.flowTriggers,
      });
    }
  }

  // ── Root executor ──
  const executorByPrefix = new Map<string, FeatureDef>();
  for (const f of features) {
    if (f.__aio.execute) {
      executorByPrefix.set(f.__aio.id, f);
    }
  }

  const rootExecute = (
    app: { dispatch: (a: Msg) => void; getState: () => unknown },
    effect: Msg,
  ): void => {
    const colonIdx = (effect.type as string).indexOf(":");
    if (colonIdx === -1) return;

    const prefix = (effect.type as string).slice(0, colonIdx);

    // Handle __flow effects — start a generator flow
    if ((effect.type as string).endsWith(":__flow")) {
      const flowInfo = flowsByPrefix.get(prefix);
      if (!flowInfo) return;
      const payload = effect.payload as {
        _flowName: string;
        _triggerAction: Msg;
      };
      const flowDef = flowInfo.flows[payload._flowName];
      if (!flowDef) return;

      const flowApp = {
        dispatch: (a: Msg) => app.dispatch(a),
        getState: () => app.getState() as Record<string, unknown>,
      };

      runFlow(
        flowDef,
        payload._flowName,
        flowInfo.featureName,
        payload._triggerAction,
        flowApp,
        _reportError
          ? (raw, ctx) => {
            _reportError(createAioError("FLOW_UNCAUGHT", raw, ctx));
          }
          : undefined,
      )
        .catch((e) => {
          if (_reportError) {
            _reportError(
              createAioError("FLOW_UNCAUGHT", e, {
                featureName: flowInfo.featureName,
                flowName: payload._flowName,
              }),
            );
          } else {
            log.error(
              "feature",
              `${flowInfo.featureName} flow '${payload._flowName}' error: ${e}`,
            );
          }
        });
      return;
    }

    // Skip internal flow state actions — handled by reducer
    if ((effect.type as string).endsWith(":__FlowState")) return;

    const f = executorByPrefix.get(prefix);
    if (!f || !f.__aio.execute) return;
    if (disabledFeatures.has(f.__aio.id)) return;

    // Scoped dispatch — runtime guard: own actions + dispatchTo allowlist
    const ownPrefix = f.__aio.id + ":";
    const crossPrefixes = f.__aio.crossDispatchPrefixes;
    const featureName = f.__aio.id;
    const scopedApp: ScopedApp & {
      _isDisabled?: () => boolean;
      _onError?: (err: AioError) => void;
    } = {
      _isDisabled: () => disabledFeatures.has(featureName),
      _onError: _reportError,
      dispatch: (a: Msg) => {
        if (typeof a?.type !== "string") return;
        if (!a.type.startsWith(ownPrefix)) {
          // Check dispatchTo allowlist
          const colonIdx = a.type.indexOf(":");
          const targetPrefix = colonIdx !== -1 ? a.type.slice(0, colonIdx) : "";
          if (!crossPrefixes.has(targetPrefix)) {
            const msg =
              `[${f.__aio.id}] cross-dispatch blocked → '${targetPrefix}'. Fix: add dispatchTo: [${targetPrefix}]`;
            countFeatureError(f.__aio.id);
            if ((globalThis as Record<string, unknown>).__aioDev) {
              throw new Error(msg);
            }
            if (_reportError) {
              _reportError(
                createAioError("MACHINE_BLOCKED", msg, {
                  featureName: f.__aio.id,
                  actionType: a.type,
                }),
              );
            } else {
              log.error("feature", msg);
            }
            return;
          }
        }
        app.dispatch(tagSource(a, "Effect"));
      },
      getState: () =>
        (app.getState() as Record<string, unknown>)[f.__aio.id] as unknown,
      getFullState: () => app.getState() as Record<string, unknown>,
    };

    try {
      f.__aio.execute(scopedApp, effect, {
        E: f.__aio.effects,
        A: f.__aio.actions,
      });
    } catch (e) {
      if (_reportError) {
        _reportError(
          createAioError("EFFECT_ERROR", e, {
            featureName: f.__aio.id,
            effectType: (effect as { type: string }).type,
          }),
        );
      } else {
        log.error("feature", `${f.__aio.id} executor threw: ${e}`);
      }
      countFeatureError(f.__aio.id);
    }
  };

  // ── Lifecycle ──
  const initAll = (
    app: { dispatch: (a: Msg) => void; getState: () => unknown },
  ): void => {
    // Wire circuit breaker dispatch — first time we have access to app.dispatch
    if (!_cbApp) _cbApp = app;
    for (const f of features) {
      app.dispatch(
        tagSource({ type: f.__aio.initType, payload: {} }, "System"),
      );
      if (f.__aio.onInit) {
        const scopedApp: ScopedApp & { _onError?: (err: AioError) => void } = {
          _onError: _reportError,
          dispatch: (a: Msg) => app.dispatch(tagSource(a, "System")),
          getState: () =>
            (app.getState() as Record<string, unknown>)[f.__aio.id] as unknown,
          getFullState: () => app.getState() as Record<string, unknown>,
        };
        try {
          f.__aio.onInit(scopedApp);
        } catch (e) {
          if (_reportError) {
            _reportError(
              createAioError("INIT_ERROR", e, { featureName: f.__aio.id }),
            );
          } else {
            log.error("feature", `${f.__aio.id} init: ${e}`);
          }
          countFeatureError(f.__aio.id);
        }
      }
    }
  };

  const destroyAll = (
    app: { dispatch: (a: Msg) => void; getState: () => unknown },
  ): void => {
    for (let i = features.length - 1; i >= 0; i--) {
      const f = features[i]!;
      // Cancel any running flows for this feature
      cancelFeatureFlows(f.__aio.id);
      if (f.__aio.onDestroy) {
        const scopedApp: ScopedApp & { _onError?: (err: AioError) => void } = {
          _onError: _reportError,
          dispatch: (a: Msg) => app.dispatch(tagSource(a, "System")),
          getState: () =>
            (app.getState() as Record<string, unknown>)[f.__aio.id] as unknown,
          getFullState: () => app.getState() as Record<string, unknown>,
        };
        try {
          f.__aio.onDestroy(scopedApp);
        } catch (e) {
          if (_reportError) {
            _reportError(
              createAioError("DESTROY_ERROR", e, { featureName: f.__aio.id }),
            );
          } else {
            log.error("feature", `${f.__aio.id} destroy: ${e}`);
          }
          countFeatureError(f.__aio.id);
        }
      }
      app.dispatch(
        tagSource({ type: f.__aio.destroyType, payload: {} }, "System"),
      );
      // Clear error tracking for destroyed features (AIO-147)
      featureErrors.delete(f.__aio.id);
      featureLastAction.delete(f.__aio.id);
    }
  };

  // ── Registry ──
  const registry = {
    enable: (
      name: string,
      app: { dispatch: (a: Msg) => void; getState: () => unknown },
    ) => {
      disabledFeatures.delete(name);
      featureErrors.set(name, []); // reset error timestamps on re-enable
      const f = features.find((f) => f.__aio.id === name);
      if (f) {
        app.dispatch(
          tagSource({ type: f.__aio.initType, payload: {} }, "System"),
        );
        // AIO-202: call onInit — match initAll() pattern
        if (f.__aio.onInit) {
          const scopedApp: ScopedApp & { _onError?: (err: AioError) => void } =
            {
              _onError: _reportError,
              dispatch: (a: Msg) => app.dispatch(tagSource(a, "System")),
              getState: () =>
                (app.getState() as Record<string, unknown>)[
                  f.__aio.id
                ] as unknown,
              getFullState: () => app.getState() as Record<string, unknown>,
            };
          try {
            f.__aio.onInit(scopedApp);
          } catch (e) {
            if (_reportError) {
              _reportError(
                createAioError("INIT_ERROR", e, { featureName: f.__aio.id }),
              );
            } else {
              log.error("feature", `${f.__aio.id} init: ${e}`);
            }
            countFeatureError(f.__aio.id);
          }
        }
      }
    },
    disable: (
      name: string,
      app: { dispatch: (a: Msg) => void; getState: () => unknown },
    ) => {
      disabledFeatures.add(name);
      const f = features.find((f) => f.__aio.id === name);
      if (f) {
        cancelFeatureFlows(f.__aio.id);
        // AIO-203: call onDestroy — match destroyAll() pattern
        if (f.__aio.onDestroy) {
          const scopedApp: ScopedApp & { _onError?: (err: AioError) => void } =
            {
              _onError: _reportError,
              dispatch: (a: Msg) => app.dispatch(tagSource(a, "System")),
              getState: () =>
                (app.getState() as Record<string, unknown>)[
                  f.__aio.id
                ] as unknown,
              getFullState: () => app.getState() as Record<string, unknown>,
            };
          try {
            f.__aio.onDestroy(scopedApp);
          } catch (e) {
            if (_reportError) {
              _reportError(
                createAioError("DESTROY_ERROR", e, {
                  featureName: f.__aio.id,
                }),
              );
            } else {
              log.error("feature", `${f.__aio.id} destroy: ${e}`);
            }
            countFeatureError(f.__aio.id);
          }
        }
        app.dispatch(
          tagSource({ type: f.__aio.destroyType, payload: {} }, "System"),
        );
        // Clear error tracking for disabled features (AIO-147)
        featureErrors.delete(f.__aio.id);
        featureLastAction.delete(f.__aio.id);
        // Notify host to cancel schedules for this feature
        if (onFeatureDisable) onFeatureDisable(f.__aio.id);
      }
    },
    isEnabled: (name: string) => !disabledFeatures.has(name),
    status: (
      name: string,
      state: Record<string, unknown>,
    ): string | undefined => {
      const fs = state[name] as Record<string, unknown> | undefined;
      return fs?._status as string | undefined;
    },
    health: (state: Record<string, unknown>): FeatureStatus[] => {
      return features.map((f) => {
        const fs = state[f.__aio.id] as Record<string, unknown> | undefined;
        const last = featureLastAction.get(f.__aio.id);
        return {
          name: f.__aio.id,
          status: fs?._status as string | undefined,
          enabled: !disabledFeatures.has(f.__aio.id),
          errors: (featureErrors.get(f.__aio.id) ?? []).length,
          lastAction: last?.type,
          lastActionAt: last?.at,
        };
      });
    },
    setOnDisable: (fn: (prefix: string) => void) => {
      onFeatureDisable = fn;
    },
  };

  return {
    initialState,
    reduce: rootReduce,
    execute: rootExecute,
    features,
    featureNames: features.map((f) => f.__aio.id),
    initAll,
    destroyAll,
    registry,
    ...(_perfCheck ? { lastBreakdown: () => _lastBreakdown } : {}),
  };
}
