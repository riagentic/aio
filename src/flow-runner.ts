// flow-runner.ts — runFlow, createFlowExecutor, createFlowReducer

import type { Msg } from "./cell-types.ts";
import type { FlowStepRecord } from "./error.ts";
import { log } from "./logger.ts";
import type {
  ActionListener,
  FlowApp,
  FlowDef,
  FlowInstance,
  FlowStep,
} from "./flow-types.ts";
import { FlowFailError, FlowHistory } from "./flow-types.ts";
import { buildCtx } from "./flow-ctx.ts";
import { _actionListeners, activeFlows, cancelFlow } from "./flow-listeners.ts";
import { executeStep } from "./flow-execute.ts";

// ── Flow runner ───────────────────────────────────────────────────────

/** Run a flow — advances generator, dispatches actions at each yield point */
export async function runFlow(
  flowDef: FlowDef,
  flowName: string,
  cellName: string,
  action: Msg,
  app: FlowApp,
  onFlowError?: (
    raw: unknown,
    ctx: {
      cellName: string;
      flowName: string;
      flowStep: number;
      flowHistory: FlowStepRecord[];
    },
  ) => void,
): Promise<void> {
  const prefix = cellName;
  const flowKey = `${cellName}:${flowName}`;

  // Cancel any existing instance of this flow
  cancelFlow(cellName, flowName);

  const ctx = buildCtx(cellName, () => app.getState());
  const payload = action.payload as Record<string, unknown>;
  const genArgs: unknown[] = flowDef.argsStyle === "spread"
    ? (Array.isArray(payload?.args) ? payload.args : [])
    : [payload];
  const gen = flowDef.generator(ctx, ...genArgs);

  const instance: FlowInstance = {
    generator: gen,
    cellName,
    flowName,
    prefix,
    aborted: false,
    stateListeners: new Set(),
  };
  activeFlows.set(flowKey, instance);

  // Track waitFor listeners for cleanup in finally block (AIO-117)
  const waitForListeners = new Set<ActionListener>();

  // Register cancelOn listeners
  const cancelListeners: ActionListener[] = [];
  if (flowDef.cancelOn) {
    for (const actionKey of flowDef.cancelOn) {
      // Resolve action key to full type: "stop" → "cellName:stop"
      const fullType = actionKey.includes(":")
        ? actionKey
        : `${prefix}:${actionKey}`;
      const listener: ActionListener = {
        actionType: fullType,
        resolve: () => cancelFlow(cellName, flowName),
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
      app.dispatch({
        type: `${prefix}:__flow:error`,
        payload: { flow: flowName, error: String(e) },
        _source: "Effect",
      });

      if (onFlowError) {
        onFlowError(e, {
          cellName,
          flowName,
          flowStep: stepIndex,
          flowHistory: flowSteps.entries(),
        });
      } else {
        log.error("cell", `${cellName} flow '${flowName}' threw: ${e}`);
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

// ── Integration helpers (used by cell.ts) ─────────────────────────────

/** Wire flows into a cell's executor — called by composeCells */
export function createFlowExecutor(
  cellName: string,
  flows: Record<string, FlowDef>,
  triggerToFlow: Map<string, string>,
  onFlowError?: (
    raw: unknown,
    ctx: {
      cellName: string;
      flowName: string;
      flowStep: number;
      flowHistory: FlowStepRecord[];
    },
  ) => void,
): (app: FlowApp, action: Msg) => boolean {
  return (app: FlowApp, action: Msg): boolean => {
    const prefix = cellName;

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
    runFlow(flowDef, flowName, cellName, action, app, onFlowError)
      .catch((e) => {
        if (onFlowError) {
          onFlowError(e, {
            cellName,
            flowName,
            flowStep: -1,
            flowHistory: [],
          });
        } else {
          log.error("cell", `${cellName} flow '${flowName}' error: ${e}`);
        }
      });

    return true;
  };
}

/** Build the __FlowState reducer — handles internal state updates from flows */
export function createFlowReducer(cellName: string) {
  const prefix = cellName;
  const flowStateType = `${prefix}:__FlowState`;

  return (
    state: Record<string, unknown>,
    action: Msg,
  ): Record<string, unknown> | null => {
    if (action.type !== flowStateType) return null;

    const payload = action.payload as { _slice: Record<string, unknown> };
    return { ...state, [cellName]: payload._slice };
  };
}
