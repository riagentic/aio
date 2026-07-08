// flow-listeners.ts — action/state listener registries, flow cancellation, reset

import { log } from "../diagnostics/logger.ts";
import type { Msg } from "./cell-types.ts";
import type {
  ActionListener,
  FlowInstance,
  StateListener,
} from "./flow-types.ts";

// ── Active flow registry ─────────────────────────────────────────────

/** Active flow instances per cell — keyed by cellName:flowName.
 *  Module-level for cross-function access (cancelFlow, cancelCellFlows, runFlow).
 *  Call resetFlows() between test runs to prevent cross-contamination. */
export const activeFlows = new Map<string, FlowInstance>();

// ── Action listener registry for waitFor ─────────────────────────────

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

export const _stateListeners = new Set<StateListener>();

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

// ── Instance abort/cancel/reset ───────────────────────────────────────

export function abortInstance(instance: FlowInstance): void {
  for (const sl of instance.stateListeners) {
    _stateListeners.delete(sl);
  }
  instance.stateListeners.clear();
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
export function cancelFlow(cellName: string, flowName: string): void {
  const key = `${cellName}:${flowName}`;
  const instance = activeFlows.get(key);
  if (instance) {
    abortInstance(instance);
    activeFlows.delete(key);
  }
}

/** Cancel all flows for a cell (on disable/destroy) */
export function cancelCellFlows(cellName: string): void {
  for (const [key, instance] of activeFlows) {
    if (instance.cellName === cellName) {
      abortInstance(instance);
      activeFlows.delete(key);
    }
  }
}
