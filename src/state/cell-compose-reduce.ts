// cell-compose-reduce.ts — per-cell reducer and root reduce function

import { notifyMethodCancel } from "./method-cancel.ts";
import { recordRejection } from "./rejection-tracker.ts";
import {
  applyPatches,
  current,
  type Draft,
  isDraft,
  type Patch,
  produceWithPatches,
} from "immer";
import { log } from "../diagnostics/logger-api.ts";
import { narrowArrayPatches } from "./patch-compact.ts";
import type { ScheduleEffect } from "./schedule.ts";
import type { OwnEffect } from "./own.ts";
import { resolveCall } from "./cell-impl.ts";
import type { AioError } from "../diagnostics/error.ts";
import { createAioError } from "../diagnostics/error.ts";
import { diagEmit } from "../diagnostics/diagnostic-bus.ts";
import {
  type CellDef,
  isReturnEnvelope,
  type Msg,
  readReturn,
  readReturnEffects,
} from "./cell-types.ts";
import type { ReduceBreakdown } from "../diagnostics/time-travel.ts";

type CellPatches = { cell: string; ops: Patch[] };

/** Internal action carrying a worker cell's committed patches into the main
 *  isolate's state. See src/server/cell-worker.ts. */
export const WORKER_PATCH_ACTION = "__aioWorkerPatch";

export type ReduceResult = {
  state: Record<string, unknown>;
  effects: (Msg | ScheduleEffect | OwnEffect)[];
  patches?: CellPatches | CellPatches[];
  /** AIO-427: a sync method's transported return value (undefined when the
   *  method returned void/effects). Threaded to `entry.resolve()` so
   *  `await cell.method()` resolves with it, like an async method. */
  ret?: unknown;
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
  const { machine, reduce, actionTypeToKey } = f.__aio;
  const cellName = f.__aio.id;
  const cellState = fullState[cellName] as Record<string, unknown>;
  const { reportError: _reportError, perfCheck: _perfCheck } = ctx;

  const ownKey = actionTypeToKey.get(action.type);

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
      // D11: a guard block is a REFUSAL — the action did not reach state. The
      // sync handler asks "was this op refused?" right after dispatching it;
      // without this record the answer was "no", so an op the machine blocked
      // was acked to its origin (which kept its optimistic change), broadcast
      // to every peer and compacted — applied everywhere except the server
      // that decided not to take it.
      recordRejection(action, { cell: cellName, reason: msg });
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
    let methodReturn: unknown; // AIO-427: transported return value (or undefined)
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
          // Clone effects NOW — while the draft is still alive. AIO-427: a
          // RETURN_TAG envelope is the sync method's transported value; every
          // other array is effects (the historic contract). alpha52: the
          // envelope may ALSO carry `s.$do`-captured effects — cloned here for
          // the same draft-revocation reason.
          if (isReturnEnvelope(result)) {
            methodReturn = snapshotReturn(readReturn(result));
            const fx = readReturnEffects(result);
            if (fx.length > 0) effects = cloneEffects(fx, action.type);
          } else if (Array.isArray(result)) {
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
    // A list the method appended to travels as its appends, not as the whole
    // list again (see narrowArrayPatches). Done HERE, at generation, because
    // this is the last place the PREVIOUS slice is in hand — by broadcast time
    // only the new state is left, and the prefix can no longer be proven.
    cellPatches = narrowArrayPatches(cellState, cellPatches);
    const tProduce = _perfCheck ? performance.now() - t0 : 0;

    // Effects already cloned inside produceWithPatches (before draft revocation)
    const tClone = _perfCheck ? performance.now() - t0 - tProduce : 0;

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
        // D11: explainable rejection — the sync handler reads this and tells
        // the op's origin client WHY its optimistic change snapped back. Keyed
        // to THIS action: the handler reads it after an await, and a global
        // slot would be cleared/overwritten by any dispatch that interleaves.
        recordRejection(action, { cell: cellName, reason: String(result) });
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
      ret: methodReturn,
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
  let methodReturn: unknown; // AIO-427: transported return value (or undefined)
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
        // making any state refs in effect payloads unreadable. AIO-427: a
        // RETURN_TAG envelope is the sync method's transported value; every
        // other array is effects (the historic contract). alpha52: the
        // envelope may ALSO carry `s.$do`-captured effects.
        if (isReturnEnvelope(result)) {
          methodReturn = snapshotReturn(readReturn(result));
          const fx = readReturnEffects(result);
          if (fx.length > 0) effects = cloneEffects(fx, action.type);
        } else if (Array.isArray(result)) {
          effects = cloneEffects(result, action.type);
        }
      },
    );
  } catch (e) {
    const methodName = ownKey ?? action.type;
    const orig = e instanceof Error ? e.message : String(e);
    // Antipattern hint: mutating frozen state throws a cryptic engine message
    // ("not extensible" / "read only property"). It means the method mutated
    // something OTHER than its own `s` draft — almost always another cell's
    // state (`otherCell.field.push(...)`) or a value captured from a read.
    // Committed state is frozen (dev + prod), so this fails identically
    // everywhere. Turn the cryptic throw into an actionable one.
    const frozen =
      /not extensible|read only|read-only|already been frozen|Cannot delete|preventExtensions|not iterable/i
        .test(orig);
    const hint = frozen
      ? ` — this looks like an in-place mutation of frozen state, or assigning a ` +
        `draft-derived value back into state. A method may only mutate its own ` +
        `\`s\` draft. To change another cell, call its method (e.g. ` +
        `\`otherCell.add(...)\`), never \`otherCell.field.push(...)\`. When ` +
        `composing new state from what you read (\`s.x = {...s.y}\`, spreading ` +
        `\`s.arr\`), snapshot it to a plain copy first: ` +
        `\`const y = JSON.parse(JSON.stringify(s.y))\`.`
      : "";
    throw new Error(
      `Cell '${cellName}' method '${methodName}' threw: ${orig}${hint}`,
      { cause: e },
    );
  }
  // Same narrowing as the guarded path above — both paths produce patches, so
  // both must, or the optimisation would apply only to cells that happen to
  // declare a state machine.
  cellPatches = narrowArrayPatches(cellState, cellPatches);
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
      // D11: explainable rejection (see above).
      recordRejection(action, { cell: cellName, reason: String(result) });
      return { state: fullState, effects: [] };
    }
  }

  const simpleReturn: ReduceResult = {
    state: { ...fullState, [cellName]: nextSlice },
    effects,
    patches: cellPatches.length > 0
      ? { cell: cellName, ops: cellPatches }
      : undefined,
    ret: methodReturn,
  };
  return _perfCheck
    ? {
      ...simpleReturn,
      _bd: { produce: stProduce, clone: stClone, spread: 0 },
    }
    : simpleReturn;
}

/** AIO-427: snapshot a sync method's return value so it survives the recipe.
 *  A method that returns a slice of the draft (e.g. `return s.items[id]`) hands
 *  back an Immer draft proxy that is REVOKED the instant produceWithPatches
 *  returns — reading it later throws. `current()` deep-copies the draft into a
 *  plain, detached value. Non-draft returns (primitives, freshly-built objects)
 *  pass through untouched. */
function snapshotReturn(r: unknown): unknown {
  return isDraft(r) ? current(r as Draft<unknown>) : r;
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

  // a field report: a dispatch whose `cell:` prefix names NO booted cell
  // and NO foreign-action listener used to vanish silently — the client (which
  // imported the cell) exposed its methods while the server never booted it,
  // so a whole feature shipped dead with green tests. Fail loud, once per
  // unknown cell name.
  const warnedUnknownCells = new Set<string>();
  // Same class, one level down: the cell IS booted but has no method by that
  // name (a renamed/removed method still called by an older client, a typo in a
  // hand-built action). The reducer answers "unknown action" and "known action
  // that changed nothing" identically — undefined — so nothing downstream could
  // tell them apart, and a sync op naming a method the server does not have was
  // persisted, ACKED and broadcast while server state never moved. Warned once
  // per action type.
  const warnedUnknownActions = new Set<string>();

  return (
    state: Record<string, unknown>,
    action: Msg,
  ): ReduceResult => {
    let currentState = state;
    const allEffects: (Msg | ScheduleEffect | OwnEffect)[] = [];
    const allPatches: Array<{ cell: string; ops: Patch[] }> = [];
    const { disabledCells, cellLastAction, perfCheck: _perfCheck } = ctx;

    // A `worker: true` cell's state lives in its worker; it streams the patches
    // each commit produced and the main isolate applies them HERE — through the
    // normal dispatch path, so persistence, broadcast and time-travel see the
    // change exactly as they see a local one. Internal type (`__`-prefixed), so
    // the network can never inject it (_isFrameworkInternalActionType).
    if (action.type === WORKER_PATCH_ACTION) {
      const { cell, ops } = (action.payload ?? {}) as {
        cell?: string;
        ops?: Patch[];
      };
      const owner = cell ? ownByPrefix.get(cell) : undefined;
      if (!owner || !ops || ops.length === 0) {
        return { state: currentState, effects: [] };
      }
      // A DISABLED owner drops the worker's committed patches. Every other
      // refusal in this file records itself (`recordRejection` / `log.warn`);
      // this one returned an unchanged state and said nothing, so a worker cell
      // whose breaker had tripped went on computing and committing into
      // silence — the patches gone, the worker none the wiser.
      if (disabledCells.has(owner.__aio.id)) {
        recordRejection(action, {
          cell: owner.__aio.id,
          reason:
            `cell is disabled — ${ops.length} worker patch(es) were dropped`,
        });
        return { state: currentState, effects: [] };
      }
      const slice = (currentState[cell!] ?? {}) as Record<string, unknown>;
      const next = applyPatches(slice, ops);
      currentState = { ...currentState, [cell!]: next };
      return {
        state: currentState,
        effects: [],
        patches: [{ cell: cell!, ops }],
      };
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
    // AIO-427: the owning cell's transported return value (the action's cell).
    let ownerReturn: unknown;
    if (!isLifecycle) {
      const colonIdx = (action.type as string).indexOf(":");
      if (colonIdx !== -1) {
        const prefix = (action.type as string).slice(0, colonIdx);
        const owner = ownByPrefix.get(prefix);
        if (owner && disabledCells.has(owner.__aio.id)) {
          // D11: a disabled cell (circuit breaker, registry.disable) does not
          // apply the action. Recording the refusal is what makes a sync op
          // land as `op-rejected` instead of an ack for a change the server
          // never took. The breaker's own trip is logged elsewhere; this is the
          // per-action fact the op path needs.
          recordRejection(action, {
            cell: owner.__aio.id,
            reason:
              `cell '${owner.__aio.id}' is disabled — '${action.type}' was not applied`,
          });
        } else if (owner) {
          // A cell's reducer only ever handles its OWN action types by prefix
          // (foreign types never share the prefix — detectForeignActions), so
          // `actionTypeToKey` IS the decider for "can this cell apply this
          // action". No entry and no foreign listener → nobody applies it.
          if (
            owner.__aio.actionTypeToKey.has(action.type) ||
            listenersByType.has(action.type)
          ) {
            const result = reduceCell(owner, currentState, action, ctx);
            currentState = result.state;
            ownerReturn = result.ret;
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
          } else {
            const known = [...owner.__aio.actionTypeToKey.values()]
              .filter((k) => !k.startsWith("__")).join(", ");
            const msg =
              `[aio:${prefix}] '${action.type}' does NOTHING — cell ` +
              `'${prefix}' is booted but has no method by that name (known: ${
                known || "none"
              }). A renamed or removed method still called by an older client ` +
              `reaches here. (warned once per action)`;
            if (!warnedUnknownActions.has(action.type)) {
              warnedUnknownActions.add(action.type);
              log.warn("aio", msg);
            }
            // D11 — see the disabled-cell branch: the op path needs the refusal
            // recorded, not just logged.
            recordRejection(action, { cell: owner.__aio.id, reason: msg });
          }
        }
      }
    }
    const tRouting = _perfCheck ? performance.now() - rt0 : 0;

    // Route to foreign action listeners
    const lt0 = _perfCheck ? performance.now() : 0;
    const listeners = listenersByType.get(action.type);

    // Unmatched cell-prefixed action → loud warning.
    // Internal (__-prefixed) types and lifecycle actions are exempt; a
    // disabled cell still counts as booted (the breaker already logs).
    if (!isLifecycle && !listeners) {
      const t = action.type as string;
      const ci = t.indexOf(":");
      if (ci > 0 && !t.startsWith("__")) {
        const prefix = t.slice(0, ci);
        if (!ownByPrefix.has(prefix) && !warnedUnknownCells.has(prefix)) {
          warnedUnknownCells.add(prefix);
          log.warn(
            `dispatch to unregistered cell '${prefix}' (action '${t}') does ` +
              `NOTHING — no booted cell or listener handles it. Did you ` +
              `forget it in aio.run({ cells: [...] })? The client can still ` +
              `render and call an imported cell the server never booted. ` +
              `(warned once per cell)`,
          );
        }
      }
    }
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

    // Abort in-flight async methods whose cancelOn lists this action (D1).
    notifyMethodCancel(action.type);

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
      ret: ownerReturn,
    };
  };
}
