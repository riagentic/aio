// renderer-flush.ts — afterRender queue, flush scheduler, and root re-render.
// Provides: afterRender, _flushAfterRender, _flushPending, _rerenderRoot.
// Component-level re-render engine is in renderer-rerender.ts.

import type { VNode } from "./vdom.ts";
import { _diff, _setDelegationRoot, h } from "./vdom.ts";
import type { RootState } from "./renderer-types.ts";
import {
  _activeRoot,
  _currentCollector,
  _setActiveRoot,
} from "./renderer-state.ts";
import { _rerenderComponent } from "./renderer-rerender.ts";
import { _reportHookError } from "./hook-error.ts";

// ── afterRender queue (per-root isolated) ────────────────────────────

/**
 * Register a callback to run after the current render cycle commits to the DOM.
 * Works for both initial mount and signal-triggered re-renders.
 *
 * The callback is a SIDE EFFECT: if it throws, it is reported (named with the
 * component that registered it) and the committed render stands — an effect can
 * never un-render the tree that scheduled it.
 */
export function afterRender(fn: () => void): void {
  if (_activeRoot) {
    // Capture WHO registered it, at registration time — the flush happens long
    // after the component's frame is gone, so this is the only moment the name
    // is knowable.
    _activeRoot.afterRenderQueue.push({
      fn,
      component: _currentCollector?._component,
    });
    return;
  }
  // No active root: there is no render cycle to run after, so the callback can
  // only be dropped. Dropping it SILENTLY is the bug — called from a
  // `setTimeout`, a promise continuation or an event handler (all of which run
  // outside the render pass) the callback simply never fired, and the symptom
  // was "my DOM measurement never happens" with nothing to search for.
  //
  // Observe-only, so dev and prod behave identically: prod drops it exactly as
  // before, dev additionally says so. Not a throw — this is reachable from
  // legitimate transition paths where the root has already unmounted, and
  // breaking those to report a no-op would be the worse trade.
  if ((globalThis as Record<string, unknown>).__aioDev === true) {
    console.warn(
      "[aio] afterRender() called outside a render — no render cycle is " +
        "active, so the callback was DROPPED. It only works during a " +
        "component's render pass; from a timer, a promise continuation or an " +
        "event handler there is nothing to run after. Move the call into the " +
        "component body, or do the work directly.",
    );
  }
}

export function _flushAfterRender(root: RootState): void {
  const cbs = root.afterRenderQueue;
  if (cbs.length === 0) return;
  root.afterRenderQueue = [];
  for (const entry of cbs) {
    try {
      entry.fn();
    } catch (e) {
      _reportHookError("afterRender", e, entry.component);
    }
  }
}

// ── Flush scheduler ───────────────────────────────────────────────────

// Budget per flush cycle: yield after 12ms so input stays responsive.
// Leaves ~4ms for browser work within a 16ms frame budget.
let _FLUSH_BUDGET_MS = 12;

/** Override the per-flush time budget. Test-only: lets a regression pin the
 *  mid-batch yield path (unreachable in fast test flushes) deterministically —
 *  a budget of 0 forces a yield after every component. Pass a negative value or
 *  omit to restore the production default. */
export function _setFlushBudget(ms?: number): void {
  _FLUSH_BUDGET_MS = ms == null || ms < 0 ? 12 : ms;
}

export function _flushPending(root: RootState): void {
  root.flushScheduled = false;
  if (root.disposed) return; // AIO-243
  const prevRoot = _activeRoot;
  _setActiveRoot(root);
  _setDelegationRoot(root.root);
  const _now = typeof performance !== "undefined"
    ? () => performance.now()
    : Date.now;
  root.flushing = true;
  try {
    const deadline = _now() + _FLUSH_BUDGET_MS;
    // AIO-167: Cycle detection — per-component render count within a single flush.
    // AIO-209: root-scoped map persists across yield boundaries.
    // AIO-288: limit raised from 10 to 25 to avoid false positives.
    const _renderCounts = root._renderCounts;
    const _CYCLE_LIMIT = 25;
    while (root.pendingComponents.size > 0) {
      const batchItems = [...root.pendingComponents];
      root.pendingComponents.clear();
      for (let bi = 0; bi < batchItems.length; bi++) {
        const inst = batchItems[bi]!;
        if (inst.disposed || !inst.pendingRender) continue;
        const count = (_renderCounts.get(inst) ?? 0) + 1;
        _renderCounts.set(inst, count);
        if (count > _CYCLE_LIMIT) {
          const name = typeof inst.vnode.tag === "function"
            ? (inst.vnode.tag.name || "Anonymous")
            : "Component";
          console.error(
            `[aio-renderer] ${name} re-rendered ${_CYCLE_LIMIT} times in a single flush — ` +
              `likely signal write during render. Breaking cycle for this component.`,
          );
          inst.pendingRender = false;
          continue;
        }
        inst.pendingRender = false;
        // AIO-409: isolate each component's re-render. A throw here — an uncaught
        // render error in this component or a descendant reached via _diff —
        // otherwise escapes the whole flush loop, abandoning every not-yet-
        // processed instance in the batch (pendingRender stuck true → permanently
        // frozen, same strand as AIO-408). One broken component must never freeze
        // its siblings. pendingRender was already cleared above, so the failed
        // component stays re-schedulable; the error is surfaced, not swallowed.
        try {
          _rerenderComponent(inst);
        } catch (e) {
          const name = typeof inst.vnode.tag === "function"
            ? (inst.vnode.tag.name || "Anonymous")
            : "Component";
          console.error(
            `[aio-renderer] Uncaught error re-rendering <${name}> — ` +
              `its siblings in this flush are unaffected:`,
            e,
          );
        }
        // Yield to browser if over budget — schedule continuation. `>=` (not
        // `>`) so a budget of 0 deterministically yields after each component
        // (the regression harness for AIO-408); at the 12ms production budget
        // the boundary is immaterial. The check runs AFTER a render, so at least
        // one component always makes progress per batch — no starvation.
        if (_now() >= deadline) {
          // AIO-408: re-queue the UNPROCESSED tail before yielding. batchItems is
          // a snapshot and pendingComponents was cleared above; returning here
          // without this strands every not-yet-rendered instance — its
          // pendingRender stays true, so it's neither in the queue nor re-addable
          // (_scheduleComponentRender early-returns on pendingRender), freezing it
          // and silently dropping all its future signal updates. Only reachable
          // under heavy bursts (>budget mid-batch), which is why fast test flushes
          // never surfaced it — the a field report "rows freeze during an airdrop" class.
          for (let j = bi + 1; j < batchItems.length; j++) {
            const rest = batchItems[j]!;
            if (!rest.disposed && rest.pendingRender) {
              root.pendingComponents.add(rest);
            }
          }
          if (root.pendingComponents.size > 0) {
            _setActiveRoot(prevRoot);
            _setDelegationRoot(null);
            root.flushScheduled = true;
            queueMicrotask(() => _flushPending(root));
            return; // afterRender fires when continuation completes
          }
        }
      }
    }
    root._renderCounts.clear(); // AIO-209: reset after full flush completes
    _flushAfterRender(root);
  } finally {
    // Covers normal completion AND the mid-budget yield-return (which passes
    // through here). The continuation microtask re-enters and re-arms the flag.
    root.flushing = false;
    _setActiveRoot(prevRoot);
    _setDelegationRoot(null);
  }
}

// ── Full root re-render ───────────────────────────────────────────────

import type { ComponentInstance } from "./renderer-types.ts";

/** Full root-level re-render (used when lazy components resolve). */
export function _rerenderRoot(state: RootState): void {
  if (state.disposed) return;
  const oldVnode = state.vnode;
  if (oldVnode && typeof oldVnode === "object") {
    const inst = (oldVnode as VNode)._instance as ComponentInstance | undefined;
    if (inst) inst.selfTriggered = true;
  }
  const prevRoot = _activeRoot;
  _setActiveRoot(state);
  _setDelegationRoot(state.root);
  try {
    const vnode = h(state.App, null);
    _diff(state.root, vnode, oldVnode, state.ctx);
    state.vnode = vnode;
    _flushAfterRender(state);
  } finally {
    _setActiveRoot(prevRoot);
    _setDelegationRoot(null);
  }
}
