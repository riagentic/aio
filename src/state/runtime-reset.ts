// runtime-reset.ts — ONE reset for the module-scoped runtime state (B2
// down-payment, perfect-aio D2). Until the instance-scoped runtime lands,
// tests get hermeticity from a single call instead of remembering five
// scattered _reset* functions (forgetting one = cross-test bleed).

import { _resetCellBindings } from "./cell-reactive.ts";
import { _resetCallTimeouts, resetPending } from "./cell-impl.ts";
import { _resetDegraded } from "../diagnostics/degraded.ts";
import { _resetMethodCancel } from "./method-cancel.ts";
import { _resetSubs } from "./state-subs.ts";
import { _resetBudgetMisses } from "./dispatch.ts";
import { _resetRootSignals } from "./signal.ts";
import { _resetSelectorHints } from "./cell-helpers.ts";
import { _resetTransactionHints } from "./cell-methods-factory.ts";
import { _resetReturnEffectHints } from "./cell-methods-internals.ts";
import { _resetArrayRefStats } from "./state-array-utils.ts";
import { _resetPerfThrottle } from "../diagnostics/error.ts";
import { _resetActionWarnings } from "./action-encode.ts";
import { _resetSwallowedRefusals } from "./cell-compose-reduce.ts";
import { _resetShortCallWarnings } from "./cell-methods-internals.ts";
import { resetDiagnosticsOptOut } from "../diagnostics/diagnostics-optout.ts";
import { resetBudgets } from "./budgets.ts";
import { resetMethodPolicy } from "./method-policy.ts";
import { resetPendingSignals } from "./pending.ts";
import { resetPendingCalls } from "../protocol/pending-calls.ts";
import { resetServerImportStubs } from "./server-import.ts";

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
  // `cell({ diagnostics: false })` is registered per boot and replaced on the
  // next one — but a test that never boots again would otherwise leave one
  // app's opt-outs silencing another's actions, and a diagnostic that is
  // quiet for a reason nobody can see is the worst kind.
  resetDiagnosticsOptOut();
  // Declared `budgets` are per-app too: one app's 4 MB cellState limit
  // silently applying to the next test's app is a threshold nobody can see.
  resetBudgets();
  // `concurrency`/`ttl` bookkeeping is process-global: one test's cached
  // result answering the next test's call is a green test over a method
  // that never ran.
  resetMethodPolicy();
  // In-flight counts and their signals: a leftover count from one test
  // makes the next test's spinner true forever.
  // One test's module stub silently applying to the next is a green test
  // over a module nobody meant to fake.
  resetServerImportStubs();
  resetPendingCalls();
  resetPendingSignals();
  resetPending();
  _resetCallTimeouts();
  // The degraded registry is process-global; without this a test's escalation
  // bleeds into every later test's /__aio/health.
  _resetDegraded();
  // Per-cell budget-violation counts: three misses promote a cell to "repeat
  // offender" and change the tip it gets, so carrying them between tests
  // rewrites a later test's message.
  _resetBudgetMisses();
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
  // "which wire conversions have I already named?" — the same class as the
  // hint sets above. Its key carries the CHANGED PATHS, so it is also the one
  // that could grow without a bound in a long-lived client; the cap lives with
  // the set itself.
  _resetActionWarnings();
  // "have I already said this method's refusal was swallowed?" — the same
  // order-dependent memory as the hint sets above.
  _resetSwallowedRefusals();
  _resetShortCallWarnings();
}
