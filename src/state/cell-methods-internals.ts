// cell-methods-internals.ts — machine, reducer, and executor builders for methods-based cells

import { isScheduleEffect, type ScheduleEffect } from "./schedule.ts";
import { trackCall } from "./method-cancel.ts";
import { isOwnEffect, type OwnEffect } from "./own.ts";
import type { AsyncMethod, Method, Mutation, SyncMethod } from "./cell-impl.ts";
import {
  applyMutations,
  createBatcher,
  createLiveProxy,
  resolveCall,
  setKey,
} from "./cell-impl.ts";
import {
  type CellExecuteFn,
  type CellReduceFn,
  markReturn,
  type Msg,
  type ScopedApp,
} from "./cell-types.ts";
import { type AioError, createAioError } from "../diagnostics/error.ts";
import { log } from "../diagnostics/logger.ts";

// ── Machine builder ────────────────────────────────────────────────────

/** Build and clone the machine config for a methods-based cell.
 *  Auto-generates from listensTo, injects __setMethod/__error transitions for async methods. */
export function buildMethodsMachine(
  name: string,
  // deno-lint-ignore no-explicit-any
  config: any,
  methodNames: string[],
  asyncMethods: Set<string>,
  generatorNames: string[],
  explicitActionNames: string[],
  // deno-lint-ignore no-explicit-any
): any {
  let machine = config.machine === false || !config.machine
    ? false
    : config.machine;

  // Auto-generate machine from listensTo
  if (config.listensTo?.length && machine === false) {
    const on: Record<string, string> = {};
    for (const key of methodNames) on[key] = "active";
    for (const key of asyncMethods) on[setKey(key)] = "active";
    for (const key of generatorNames) on[key] = "active";
    for (const key of explicitActionNames) on[key] = "active";
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
    const cloned = {
      ...machine,
      states: Object.fromEntries(
        Object.entries(machine.states).map(([k, v]: [string, unknown]) => [
          k,
          { ...(v as object) },
        ]),
      ),
    };
    for (
      const stateConfig of Object.values(cloned.states) as Record<
        string,
        unknown
      >[]
    ) {
      for (const [key, target] of Object.entries(stateConfig)) {
        if (key.includes(":") || !asyncMethods.has(key)) continue;
        if (typeof target === "function") {
          // AIO-380: function target — possible targets unknown statically.
          // Allow the method's writes in every state (consistent with "if the
          // method is allowed, its writes are allowed").
          for (
            const [sn, sc] of Object.entries(cloned.states) as [
              string,
              Record<string, unknown>,
            ][]
          ) {
            if (!(setKey(key) in sc)) sc[setKey(key)] = sn;
          }
        } else if (cloned.states[target as string]) {
          // __setMethod must be allowed in the TARGET state (self-transition),
          // not the source — async proxy writes dispatch after the machine
          // has already transitioned to the target state.
          (cloned.states[target as string] as Record<string, string>)[
            setKey(key)
          ] = target as string;
        }
      }
    }
    if (asyncMethods.size > 0) {
      for (
        const [stateName, stateConfig] of Object.entries(cloned.states) as [
          string,
          Record<string, string>,
        ][]
      ) {
        stateConfig["__error"] = stateName;
        // AIO-381: async methods can return schedule effects — routed through
        // an internal self-loop action so they reach the scheduler.
        stateConfig["__effects"] = stateName;
      }
    }
    machine = cloned;
    if (
      typeof (globalThis as Record<string, unknown>).__aioDev !== "undefined"
    ) {
      log.debug("aio", `${name} machine: ${JSON.stringify(machine, null, 2)}`);
    }
  }
  return machine;
}

// ── Reducer builder ────────────────────────────────────────────────────

/** Build the CellReduceFn for a methods-based cell. */
export function buildMethodsReducer(
  actionTypeToKey: Map<string, string>,
  methods: Record<string, Method<Record<string, unknown>>>,
  syncMethods: Set<string>,
  asyncMethods: Set<string>,
  prefix: string,
  // Foreign action type → SYNC method that reacts to it (listensTo object
  // form, D1). Runs with the FOREIGN action's payload as the single arg.
  foreignHandlers: Map<string, string> | undefined,
): CellReduceFn {
  return (
    state: unknown,
    action: Msg,
  ): ReturnType<CellReduceFn> => {
    const s = state as Record<string, unknown>;
    // listensTo reaction — a foreign action with a mapped handler method.
    const foreignKey = foreignHandlers?.get(action.type);
    if (foreignKey) {
      const handler = methods[foreignKey];
      if (handler) {
        // Method actions carry the positional `{ args }` envelope — spread it
        // so the handler is written with the foreign method's own parameter
        // list (`onAdded(s, item, qty)`), not a hand-destructured envelope
        // (quant, alpha28 migration). Non-method triggers pass payload as-is.
        const p = action.payload as { args?: unknown[] } | undefined;
        const args = p && Array.isArray(p.args) ? p.args : [action.payload];
        return (handler as SyncMethod<Record<string, unknown>>)(
          s,
          ...args,
        ) as ReturnType<CellReduceFn>;
      }
    }
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

    // AIO-381: schedule effects returned by an async method — the executor
    // bridges them here so they flow through the standard effect path.
    if (ownKey === "__effects") {
      const eff = (action.payload as { effects?: unknown[] })?.effects;
      return Array.isArray(eff)
        ? (eff as (Msg | ScheduleEffect | OwnEffect)[])
        : undefined;
    }

    // Method-style: call method directly on draft
    const method = methods[ownKey];
    if (method) {
      if (syncMethods.has(ownKey)) {
        const args =
          ((action.payload as Record<string, unknown>)?.args as unknown[]) ??
            [];
        const result = (method as SyncMethod<Record<string, unknown>>)(
          s as Record<string, unknown>,
          ...args,
        );
        // AIO-8.2: a sync-classified method returning a thenable means the
        // build transpiled async functions (constructor.name check defeated).
        // Dev: throw before the half-applied state dispatches. Prod: log on.
        if (
          result && typeof (result as { then?: unknown }).then === "function"
        ) {
          const msg =
            `[${name}] method '${ownKey}' returned a Promise but was classified sync — ` +
            `your build transpiled async functions. Wrap it: ` +
            `${ownKey}: markAsync(async (s) => {...})`;
          if ((globalThis as Record<string, unknown>).__aioDev) {
            throw new Error(msg);
          }
          log.error("cell", msg);
          return;
        }
        // AIO-427: classify the sync method's return at its one ambiguous
        // source. A single tagged effect → wrapped to the reducer's effects
        // array; an all-effect array → passed through as effects; anything else
        // (primitive, plain object, data array, `[]`) is a transported VALUE,
        // wrapped in a RETURN_TAG envelope so compose-reduce never mistakes it
        // for a `Msg[]` effects array.
        if (result == null) return undefined;
        if (isScheduleEffect(result) || isOwnEffect(result)) return [result];
        if (
          Array.isArray(result) && result.length > 0 &&
          (isScheduleEffect(result[0]) || isOwnEffect(result[0]))
        ) {
          return result as (Msg | ScheduleEffect | OwnEffect)[];
        }
        return markReturn(result);
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
      return;
    }
  };
}

// ── Executor builder ───────────────────────────────────────────────────

/** Build the CellExecuteFn for a methods-based cell (async method dispatch + effect handlers). */
export function buildMethodsExecutor(
  name: string,
  prefix: string,
  methods: Record<string, Method<Record<string, unknown>>>,
  asyncMethods: Set<string>,
  // deno-lint-ignore no-explicit-any
  config: any,
  effectKeys: string[],
  explicitExecute:
    | Record<string, (app: ScopedApp, payload: unknown) => void | Promise<void>>
    | undefined,
): CellExecuteFn {
  return (app: ScopedApp, effect: Msg): void => {
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
      // Cancellation (perfect-aio D1): every async call gets an
      // AbortController; cancelOn triggers abort it, the method observes it
      // via `s.$signal`. Untracked on settle either way.
      const controller = new AbortController();
      const untrack = trackCall(prefix, _method, controller);
      const proxy = createLiveProxy(
        name,
        prefix,
        _method,
        () => app.getState() as Record<string, unknown>,
        batcher,
        [],
        new Map(),
        { v: null },
        controller.signal,
      );
      (method as AsyncMethod<Record<string, unknown>>)(
        proxy as Record<string, unknown>,
        ..._args,
      )
        .finally(() => untrack())
        .then((value) => {
          // AIO-381/382: async methods can return schedule + own effects,
          // same as sync methods. Detection is conservative — only
          // `__schedule`/`__own`-typed values count, so data returns to
          // direct callers are never eaten.
          const isRuntimeEffect = (v: unknown) =>
            isScheduleEffect(v) || isOwnEffect(v);
          const retEffects = isRuntimeEffect(value)
            ? [value as ScheduleEffect | OwnEffect]
            : Array.isArray(value) && value.length > 0 &&
                value.every(isRuntimeEffect)
            ? value as (ScheduleEffect | OwnEffect)[]
            : [];
          if (retEffects.length > 0) {
            app.dispatch({
              type: `${prefix}:__effects`,
              payload: { effects: retEffects },
              _source: "Effect",
            } as Msg);
          }
          if (
            (app as Record<string, unknown>)._isDisabled &&
            ((app as Record<string, unknown>)._isDisabled as () => boolean)()
          ) {
            resolveCall(
              _callId,
              undefined,
              new Error(
                `[${name}] cell disabled while ${_method}() was running`,
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
            _onError(createAioError("EFFECT_ASYNC_ERROR", e, {
              cellName: name,
              actionType: `${prefix}:${_method}`,
            }));
          } else {
            log.error("cell", `${name} ${_method}() threw: ${e}`);
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
        const result = h(app, (effect as { payload: unknown }).payload);
        if (result && typeof result === "object" && "catch" in result) {
          (result as Promise<void>).catch((e) => {
            const _onError = (app as Record<string, unknown>)._onError as
              | ((err: import("../diagnostics/error.ts").AioError) => void)
              | undefined;
            if (_onError) {
              _onError(createAioError("EFFECT_ASYNC_ERROR", e, {
                cellName: name,
                actionType: `${prefix}:${key}`,
                effectType: effect.type as string,
              }));
            } else {
              log.error("cell", `${name} ${key}() execute threw: ${e}`);
            }
          });
        }
      }
    } else if (config.execute && typeof config.execute === "function") {
      const emitMap: Record<string, string> = {};
      for (const k of effectKeys) emitMap[k] = `${prefix}:${k}`;
      (config.execute as (
        app: ScopedApp,
        effect: Msg,
        ctx: { emit: Record<string, unknown> },
      ) => void)(app, effect, { emit: emitMap });
    }
  };
}
