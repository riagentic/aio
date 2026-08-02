// runtime-reset.ts — ONE reset for the module-scoped runtime state (B2
// down-payment, perfect-aio D2). Until the instance-scoped runtime lands,
// tests get hermeticity from a single call instead of remembering five
// scattered _reset* functions (forgetting one = cross-test bleed).

import { _resetCellBindings, _resetUiReadWarnings } from "./cell-reactive.ts";
import { _resetCallTimeouts, resetPending } from "./cell-impl.ts";
import { _resetDegraded } from "../diagnostics/degraded.ts";
import { _resetMethodCancel } from "./method-cancel.ts";
import { _resetSubs } from "./state-subs.ts";

/** Reset every module-scoped piece of the cell RUNTIME — bindings, pending
 *  async calls, cancellation registry, subscriptions. Test isolation in one
 *  call.
 *
 *  It deliberately does NOT clear the cell REGISTRY. The registry is populated
 *  once, at module-import time, by `cell()` itself — nothing ever re-populates
 *  it. Clearing it here emptied it for the rest of the process, so the first
 *  `testCell` in a file silently disarmed every later `testUI(App)` in it: with
 *  no registered cells, `testUI` booted ZERO of them, and `expectCell` then
 *  asserted against each cell's declared initial state and passed. A green test
 *  covering nothing — precisely the harness-more-lenient-than-production
 *  failure the doctrine bans.
 *
 *  A test that genuinely wants an empty registry (registration behaviour
 *  itself) calls `_resetCellRegistry()` directly. */
export function _resetAioRuntime(): void {
  _resetCellBindings();
  _resetUiReadWarnings();
  resetPending();
  _resetCallTimeouts();
  // The degraded registry is process-global; without this a test's escalation
  // bleeds into every later test's /__aio/health.
  _resetDegraded();
  _resetMethodCancel();
  _resetSubs();
}
