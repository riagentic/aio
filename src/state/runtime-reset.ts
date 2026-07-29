// runtime-reset.ts — ONE reset for the module-scoped runtime state (B2
// down-payment, perfect-aio D2). Until the instance-scoped runtime lands,
// tests get hermeticity from a single call instead of remembering five
// scattered _reset* functions (forgetting one = cross-test bleed).

import {
  _resetCellBindings,
  _resetCellRegistry,
  _resetUiReadWarnings,
} from "./cell-reactive.ts";
import { _resetCallTimeouts, resetPending } from "./cell-impl.ts";
import { _resetMethodCancel } from "./method-cancel.ts";
import { _resetSubs } from "./state-subs.ts";

/** Reset every module-scoped piece of the cell runtime — definitions,
 *  bindings, pending async calls, cancellation registry, subscriptions.
 *  Test isolation in one call. */
export function _resetAioRuntime(): void {
  _resetCellRegistry();
  _resetCellBindings();
  _resetUiReadWarnings();
  resetPending();
  _resetCallTimeouts();
  _resetMethodCancel();
  _resetSubs();
}
