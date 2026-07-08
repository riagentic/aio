// cell-compose-reduce.ts — per-cell reducer and root reduce function

import { type Draft, type Patch, produceWithPatches } from "immer";
import { log } from "../diagnostics/logger.ts";
import type { ScheduleEffect } from "./schedule.ts";
import type { OwnEffect } from "./own.ts";
import type { FlowDef } from "./flow.ts";
import {
  createFlowReducer,
  notifyFlowListeners,
  notifyStateListeners,
} from "./flow.ts";
import { resolveCall } from "./cell-impl.ts";
import type { AioError } from "../diagnostics/error.ts";
import { createAioError } from "../diagnostics/error.ts";
import { diagEmit } from "../diagnostics/diagnostic-bus.ts";
import type { CellDef, Msg } from "./cell-types.ts";
import type { ReduceBreakdown } from "../diagnostics/time-travel.ts";

type CellPatches = { cell: string; ops: Patch[] };

export type ReduceResult = {
  state: Record<string, unknown>;
  effects: (Msg | ScheduleEffect | OwnEffect)[];
  patches?: CellPatches | CellPatches[];
  _bd?: { produce: number; clone: number; spread: number };
};

/** Context needed by reduceCell and the root reducer */
export type ReduceContext = {
  disabledCells: Set<string>;
  cellLastAction: Map<string, { type: string; at: number }>;
  reportError: ((err: AioError) => void) | undefined;
  perfCheck: boolean;
};

/** Reduce a single cell's slice for a given action */
export function reduceCell(
  f: CellDef,
  fullState: Record<string, unknown>,
  action: Msg,
  ctx: ReduceContext,
): ReduceResult {
  const { machine, reduce, actionTypeToKey, flowTriggers } = f.__aio;
  const cellName = f.__aio.id;
  const cellState = fullState[cellName] as Record<string, unknown>;
  const { reportError: _reportError, perfCheck: _perfCheck } = ctx;

  const ownKey = actionTypeToKey.get(action.type);
  const flowName = ownKey && flowTriggers
    ? flowTriggers.get(ownKey)
    : undefined;

  if (machine !== false) {
    const currentStatus = (cellState.__aio_status ?? machine.initial) as string;
    const stateConfig = machine.states[currentStatus];
    if (!stateConfig) return { state: fullState, effects: [] };

    const lookupKey = ownKey ?? action.type;
    const transitions = stateConfig;

    if (!(lookupKey in transitions)) {
      const allowed = Object.keys(transitions).join(", ");
      // The auto-injected async self-loops (__setMethod, __error) are only
      // allowed in the method's own state. If the machine moved on before the
      // async method resolved, its RESULT is discarded here — a subtle,
      // timing-dependent footgun. Name the method, not the internal action.
      let msg: string;
      let hint: string;
      if (lookupKey.startsWith("__set")) {
        const method = lookupKey.charAt(5).toLowerCase() + lookupKey.slice(6);
        msg =
          `[aio:${cellName}] async result for '${method}()' discarded — the machine left the method's state and is now in '${currentStatus}' before it resolved (allowed: ${
            allowed || "none"
          })`;
        hint =
          `'${method}()' resolved after a transition moved '${cellName}' to '${currentStatus}'. Guard against the stale result, or allow '${lookupKey}' in '${currentStatus}'.`;
      } else if (lookupKey === "__error") {
        msg =
          `[aio:${cellName}] async error discarded — machine is in '${currentStatus}' where the failure handler isn't allowed (allowed: ${
            allowed || "none"
          })`;
        hint =
          `An async method rejected after the machine moved to '${currentStatus}'. Allow '__error' there, or handle the rejection inside the method.`;
      } else {
        msg =
          `[aio:${cellName}] '${action.type}' blocked — machine is in '${currentStatus}' state (allowed: ${
            allowed || "none"
          })`;
        hint =
          "This action is not allowed in the current machine state. May be intentional (guard) or a bug.";
      }
      if ((globalThis as Record<string, unknown>).__aioDev) {
        log.warn("aio", msg);
      } else log.debug("aio", msg);
      diagEmit({
        type: "action-guarded",
        severity: "info",
        source: "cell-compose",
        message: msg,
        detail: {
          cellName,
          actionType: action.type,
          machineState: currentStatus,
        },
        hint,
      });
      return { state: fullState, effects: [] };
    }

    const targetSpec = transitions[lookupKey];
    let effects: (Msg | ScheduleEffect | OwnEffect)[] = [];
    const t0 = _perfCheck ? performance.now() : 0;
    let nextSlice: Record<string, unknown>;
    let cellPatches: Patch[] = [];
    try {
      [nextSlice, cellPatches] = produceWithPatches(
        cellState,
        (draft: Draft<Record<string, unknown>>) => {
          const result = reduce(draft, action, {
            A: f.__aio.actions,
            E: f.__aio.effects,
          });
          // Clone effects NOW — while the draft is still alive.
          if (Array.isArray(result)) {
            effects = cloneEffects(result, action.type);
          }
          // AIO-380: function targets resolve at dispatch time, after the
          // reducer ran — sync methods see post-method state. A throwing or
          // invalid guard never corrupts dispatch: log and stay put.
          let targetStatus: string = currentStatus;
          if (typeof targetSpec === "function") {
            try {
              const payload = (action as { payload?: unknown }).payload;
              const args = payload && typeof payload === "object" &&
                  Array.isArray((payload as { args?: unknown }).args)
                ? (payload as { args: unknown[] }).args
                : payload === undefined
                ? []
                : [payload];
              const resolved = targetSpec(draft, ...args);
              if (resolved == null) {
                targetStatus = currentStatus;
              } else if (machine.states[resolved]) {
                targetStatus = resolved;
              } else {
                log.error(
                  "cell",
                  `${cellName} transition fn for '${lookupKey}' returned unknown state '${resolved}' — staying in '${currentStatus}'`,
                );
              }
            } catch (e) {
              log.error(
                "cell",
                `${cellName} transition fn for '${lookupKey}' threw: ${e} — staying in '${currentStatus}'`,
              );
            }
          } else {
            targetStatus = targetSpec as string;
          }
          if (draft.__aio_status !== targetStatus) {
            draft.__aio_status = targetStatus;
          }
        },
      );
    } catch (e) {
      const methodName = ownKey ?? action.type;
      const orig = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Cell '${cellName}' method '${methodName}' threw: ${orig}`,
        { cause: e },
      );
    }
    const tProduce = _perfCheck ? performance.now() - t0 : 0;

    // Effects already cloned inside produceWithPatches (before draft revocation)
    const tClone = _perfCheck ? performance.now() - t0 - tProduce : 0;

    if (flowName) {
      effects.push({
        type: `${f.__aio.id}:__flow`,
        payload: { _flowName: flowName, _triggerAction: action },
      });
    }

    if (f.__aio.validate) {
      const result = f.__aio.validate(nextSlice);
      if (result !== true) {
        if (_reportError) {
          _reportError(
            createAioError(
              "REDUCE_ERROR",
              `state validation failed: ${result}`,
              {
                cellName,
                actionType: action.type,
              },
            ),
          );
        } else {
          log.error("cell", `${cellName} state validation failed: ${result}`);
        }
        return { state: fullState, effects: [] };
      }
    }

    const t2 = _perfCheck ? performance.now() : 0;
    const returnObj = {
      state: { ...fullState, [cellName]: nextSlice },
      effects,
      patches: cellPatches.length > 0
        ? { cell: cellName, ops: cellPatches }
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

  // Simple path — no machine guards
  let effects: (Msg | ScheduleEffect | OwnEffect)[] = [];
  const st0 = _perfCheck ? performance.now() : 0;
  let nextSlice: Record<string, unknown>;
  let cellPatches: Patch[] = [];
  try {
    [nextSlice, cellPatches] = produceWithPatches(
      cellState,
      (draft: Draft<Record<string, unknown>>) => {
        const result = reduce(draft, action, {
          A: f.__aio.actions,
          E: f.__aio.effects,
        });
        // Clone effects NOW — while the draft is still alive.
        // After produceWithPatches returns, Immer revokes the draft proxy,
        // making any state refs in effect payloads unreadable.
        if (Array.isArray(result)) effects = cloneEffects(result, action.type);
      },
    );
  } catch (e) {
    const methodName = ownKey ?? action.type;
    const orig = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Cell '${cellName}' method '${methodName}' threw: ${orig}`,
      { cause: e },
    );
  }
  const stProduce = _perfCheck ? performance.now() - st0 : 0;

  // Effects already cloned inside produceWithPatches (before draft revocation)
  const stClone = _perfCheck ? performance.now() - st0 - stProduce : 0;

  if (f.__aio.validate) {
    const result = f.__aio.validate(nextSlice);
    if (result !== true) {
      if (_reportError) {
        _reportError(
          createAioError("REDUCE_ERROR", `state validation failed: ${result}`, {
            cellName,
            actionType: action.type,
          }),
        );
      } else {
        log.error("cell", `${cellName} state validation failed: ${result}`);
      }
      return { state: fullState, effects: [] };
    }
  }

  if (flowName) {
    effects.push({
      type: `${f.__aio.id}:__flow`,
      payload: { _flowName: flowName, _triggerAction: action },
    });
  }

  const simpleReturn: ReduceResult = {
    state: { ...fullState, [cellName]: nextSlice },
    effects,
    patches: cellPatches.length > 0
      ? { cell: cellName, ops: cellPatches }
      : undefined,
  };
  return _perfCheck
    ? {
      ...simpleReturn,
      _bd: { produce: stProduce, clone: stClone, spread: 0 },
    }
    : simpleReturn;
}

/** Clone effects array to detach from Immer draft (AIO-146).
 *  Audit F-8: a non-cloneable effect is logged and DROPPED — no JSON-roundtrip
 *  fallback. JSON loses undefined/NaN/Infinity/Date/Map/Set and silently
 *  corrupted the executor's payload contract. */
function cloneEffects(
  effects: (Msg | ScheduleEffect | OwnEffect)[],
  actionType?: string,
): (Msg | ScheduleEffect | OwnEffect)[] {
  if (!effects.length) return effects;
  const cloned: typeof effects = [];
  for (const eff of effects) {
    try {
      cloned.push(structuredClone(eff));
    } catch (cloneErr) {
      const effType = (eff as Record<string, unknown> | null)?.type ?? "?";
      log.error(
        "cell",
        `effect "${effType}" from action "${
          actionType ?? "?"
        }" is not structuredClone-able — dropped. ` +
          `Effects must be plain JSON-shaped objects (no functions, DOM nodes, class instances). ` +
          `Original: ${
            cloneErr instanceof Error ? cloneErr.message : String(cloneErr)
          }`,
      );
      // do NOT push — drop the effect rather than ship a corrupted payload
    }
  }
  return cloned;
}

/** Build the root reduce function from a resolved set of cells */
export function buildRootReducer(
  cells: CellDef[],
  ctx: ReduceContext,
  perfTracker: { set: (bd: ReduceBreakdown) => void } | undefined,
): (
  state: Record<string, unknown>,
  action: Msg,
) => ReduceResult {
  const ownByPrefix = new Map<string, CellDef>();
  const listenersByType = new Map<string, CellDef[]>();

  for (const f of cells) {
    ownByPrefix.set(f.__aio.id, f);
    for (const foreignType of f.__aio.foreignActions) {
      const list = listenersByType.get(foreignType) ?? [];
      list.push(f);
      listenersByType.set(foreignType, list);
    }
  }

  const flowReducers = new Map<string, ReturnType<typeof createFlowReducer>>();
  for (const f of cells) {
    if (f.__aio.flows && Object.keys(f.__aio.flows).length > 0) {
      flowReducers.set(f.__aio.id, createFlowReducer(f.__aio.id));
    }
  }

  return (
    state: Record<string, unknown>,
    action: Msg,
  ): ReduceResult => {
    let currentState = state;
    const allEffects: (Msg | ScheduleEffect | OwnEffect)[] = [];
    const allPatches: Array<{ cell: string; ops: Patch[] }> = [];
    const { disabledCells, cellLastAction, perfCheck: _perfCheck } = ctx;

    // Handle flow state updates (__FlowState)
    if (
      typeof action.type === "string" && action.type.endsWith(":__FlowState")
    ) {
      const colonIdx = action.type.indexOf(":");
      const prefix = action.type.slice(0, colonIdx);
      const flowReducer = flowReducers.get(prefix);
      if (flowReducer) {
        const cellSlice = (currentState[prefix] ?? {}) as Record<
          string,
          unknown
        >;
        const payload = action.payload as { _slice: Record<string, unknown> };
        const [nextSlice, flowPatches] = produceWithPatches(
          cellSlice,
          (draft: Draft<Record<string, unknown>>) => {
            const incoming = payload._slice;
            for (const key of Object.keys(incoming)) {
              draft[key] = incoming[key];
            }
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
            ? { cell: prefix, ops: flowPatches }
            : undefined,
        };
      }
      return { state: currentState, effects: [] };
    }

    // Handle lifecycle actions (Init/Destroy)
    let isLifecycle = false;
    for (const f of cells) {
      if (action.type === f.__aio.initType) {
        const machine = f.__aio.machine;
        const status = machine === false ? undefined : machine.initial;
        const existing = currentState[f.__aio.id] as
          | Record<string, unknown>
          | undefined;
        const base = { ...f.__aio.state, ...existing };
        const targetSlice: Record<string, unknown> = status != null
          ? { ...base, __aio_status: status }
          : base;
        const cellSlice = (existing ?? {}) as Record<string, unknown>;
        const [nextCell, initPatches] = produceWithPatches(
          cellSlice,
          (draft: Draft<Record<string, unknown>>) => {
            for (const key of Object.keys(targetSlice)) {
              draft[key] = targetSlice[key];
            }
            for (const key of Object.keys(draft)) {
              if (!(key in targetSlice)) delete draft[key];
            }
          },
        );
        currentState = { ...currentState, [f.__aio.id]: nextCell };
        if (initPatches.length > 0) {
          allPatches.push({ cell: f.__aio.id, ops: initPatches });
        }
        isLifecycle = true;
        break;
      }
      if (action.type === f.__aio.destroyType) {
        const machine = f.__aio.machine;
        const targetSlice: Record<string, unknown> = machine === false
          ? { ...f.__aio.state }
          : { ...f.__aio.state, __aio_status: machine.initial };
        const cellSlice = (currentState[f.__aio.id] ?? {}) as Record<
          string,
          unknown
        >;
        const [nextCell, destroyPatches] = produceWithPatches(
          cellSlice,
          (draft: Draft<Record<string, unknown>>) => {
            for (const key of Object.keys(targetSlice)) {
              draft[key] = targetSlice[key];
            }
            for (const key of Object.keys(draft)) {
              if (!(key in targetSlice)) delete draft[key];
            }
          },
        );
        currentState = { ...currentState, [f.__aio.id]: nextCell };
        if (destroyPatches.length > 0) {
          allPatches.push({ cell: f.__aio.id, ops: destroyPatches });
        }
        isLifecycle = true;
        break;
      }
    }

    // Route to owning cell (by prefix) — skip for lifecycle actions
    const rt0 = _perfCheck ? performance.now() : 0;
    let ownerBd: { produce: number; clone: number; spread: number } | undefined;
    if (!isLifecycle) {
      const colonIdx = (action.type as string).indexOf(":");
      if (colonIdx !== -1) {
        const prefix = (action.type as string).slice(0, colonIdx);
        const owner = ownByPrefix.get(prefix);
        if (owner && !disabledCells.has(owner.__aio.id)) {
          const result = reduceCell(owner, currentState, action, ctx);
          currentState = result.state;
          allEffects.push(...result.effects);
          if (result.patches) {
            if (Array.isArray(result.patches)) {
              allPatches.push(...result.patches);
            } else allPatches.push(result.patches);
          }
          ownerBd = result._bd;
          cellLastAction.set(owner.__aio.id, {
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
        if (disabledCells.has(listener.__aio.id)) continue;
        const result = reduceCell(listener, currentState, action, ctx);
        currentState = result.state;
        allEffects.push(...result.effects);
        if (result.patches) {
          if (Array.isArray(result.patches)) allPatches.push(...result.patches);
          else allPatches.push(result.patches);
        }
        cellLastAction.set(listener.__aio.id, {
          type: action.type,
          at: Date.now(),
        });
      }
    }
    const tListeners = _perfCheck ? performance.now() - lt0 : 0;

    if (_perfCheck && perfTracker) {
      perfTracker.set({
        produce: ownerBd?.produce ?? 0,
        clone: ownerBd?.clone ?? 0,
        spread: ownerBd?.spread ?? 0,
        routing: tRouting,
        listeners: tListeners,
      });
    }

    notifyFlowListeners(action);
    notifyStateListeners(currentState);

    // Reject pending call() if action was blocked
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
            `call('${action.type}'): blocked — machine guard, cell disabled, or not found`,
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
}

/** Build map of flow definitions per cell prefix */
export function buildFlowsByPrefix(
  cells: CellDef[],
): Map<
  string,
  {
    cellName: string;
    flows: Record<string, FlowDef>;
    triggers: Map<string, string>;
  }
> {
  const map = new Map<
    string,
    {
      cellName: string;
      flows: Record<string, FlowDef>;
      triggers: Map<string, string>;
    }
  >();
  for (const f of cells) {
    if (
      f.__aio.flows && f.__aio.flowTriggers &&
      Object.keys(f.__aio.flows).length > 0
    ) {
      map.set(f.__aio.id, {
        cellName: f.__aio.id,
        flows: f.__aio.flows,
        triggers: f.__aio.flowTriggers,
      });
    }
  }
  return map;
}
