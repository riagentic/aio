// flow.ts — generator-based sequential workflows for cells
//
// Write top-to-bottom async code. Each yield point is observable:
// dispatches an action, transitions the machine, appears in time-travel.
//
// GenCtx   — context passed to generator (call, mutate, done, fail, dispatch, all, race, sleep)
// runFlow() — internal: advances generator, dispatches actions, mutates state

// ── Re-exports ────────────────────────────────────────────────────────

export type {
  FlowApp,
  FlowDef,
  FlowOptions,
  FlowStep,
  Gen,
  GenCtx,
  SingleStepGen,
  TypedCreator,
} from "./flow-types.ts";

export { FlowHistory } from "./flow-types.ts";

export {
  _actionListeners,
  cancelCellFlows,
  cancelFlow,
  notifyFlowListeners,
  notifyStateListeners,
  resetFlows,
} from "./flow-listeners.ts";

export { executeStep } from "./flow-execute.ts";

export {
  createFlowExecutor,
  createFlowReducer,
  runFlow,
} from "./flow-runner.ts";
