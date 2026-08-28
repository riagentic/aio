// runtime-reset.ts — ONE reset for the module-scoped runtime state (B2
// down-payment, perfect-aio D2). Until the instance-scoped runtime lands,
// tests get hermeticity from a single call instead of remembering five
// scattered _reset* functions (forgetting one = cross-test bleed).

import { _resetCellBindings } from "./cell-reactive.ts";
import { _resetCallTimeouts, resetPending } from "./cell-impl.ts";
import { _resetDegraded } from "../diagnostics/degraded.ts";
import { _resetMethodCancel } from "./method-cancel.ts";
import { _resetSubs } from "./state-subs.ts";
import { _resetRootSignals } from "./signal.ts";
import { _resetSelectorHints } from "./cell-helpers.ts";
import { _resetTransactionHints } from "./cell-methods-factory.ts";
import { _resetReturnEffectHints } from "./cell-methods-internals.ts";
import { _resetArrayRefStats } from "./state-array-utils.ts";
import { _resetPerfThrottle } from "../diagnostics/error.ts";

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
  resetPending();
  _resetCallTimeouts();
  // The degraded registry is process-global; without this a test's escalation
  // bleeds into every later test's /__aio/health.
  _resetDegraded();
  _resetMethodCancel();
  _resetSubs();
  // Module-level `signal()`s are state a test can write just as easily as a
  // cell, and they used to be the one kind nothing reset — so a test that
  // bumped a module signal changed the meaning of every later test in the file
  // (a field report read this as "cells leak between tests", because from the
  // outside the two are indistinguishable). Per-render signals are not
  // recorded, so this only restores the module-scope population.
  _resetRootSignals();
  // WARN/HINT dedup sets — "have I already said this?" memories that live for
  // the whole process. Unreset, they make a test's own diagnostics
  // order-dependent: the SECOND test to trigger the same hint sees silence, so
  // "it warns about X" passes alone and fails in a suite (or the reverse). Same
  // class as the signal leak above — state a test writes that nothing restored.
  _resetSelectorHints();
  _resetTransactionHints();
  _resetReturnEffectHints();
  _resetArrayRefStats();
  _resetPerfThrottle();
}
