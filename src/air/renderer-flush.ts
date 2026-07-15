// renderer-flush.ts — afterRender queue, flush scheduler, and root re-render.
// Provides: afterRender, _flushAfterRender, _flushPending, _rerenderRoot.
// Component-level re-render engine is in renderer-rerender.ts.

import type { VNode } from "./vdom.ts";
import { _diff, _setDelegationRoot, h } from "./vdom.ts";
import type { RootState } from "./renderer-types.ts";
import { _activeRoot, _setActiveRoot } from "./renderer-state.ts";
import { _rerenderComponent } from "./renderer-rerender.ts";

// ── afterRender queue (per-root isolated) ────────────────────────────

/**
 * Register a callback to run after the current render cycle commits to the DOM.
 * Works for both initial mount and signal-triggered re-renders.
 */
export function afterRender(fn: () => void): void {
  if (_activeRoot) {
    _activeRoot.afterRenderQueue.push(fn);
  }
}

export function _flushAfterRender(root: RootState): void {
  const cbs = root.afterRenderQueue;
  if (cbs.length === 0) return;
  root.afterRenderQueue = [];
  for (const cb of cbs) {
    try {
      cb();
    } catch (e) {
      _reportHookError("afterRender", e);
    }
  }
}

/**
 * Report an error thrown by a lifecycle hook (`onMount`/`afterRender`) without
 * letting it abort the render — one bad hook must never collapse the surface
 * (risoto #3). Adds an actionable hint when the cause is DOM access with no DOM
 * (testUI/SSR), where the raw "document is not defined" lands far from its fix.
 */
export function _reportHookError(kind: string, e: unknown): void {
  console.error(`[aio-renderer] ${kind} callback error:`, e);
  const msg = String((e as { message?: unknown })?.message ?? e);
  if (
    /\b(document|window)\b[^]*?(is not defined|undefined)/.test(msg) &&
    typeof document === "undefined"
  ) {
    console.error(
      `[aio-renderer] ↑ this ${kind} ran without a DOM (testUI/SSR). ` +
        "Guard DOM access — `if (typeof document !== 'undefined') { … }` — " +
        "or use a `useRef` on the element instead of `document.getElementById`.",
    );
  }
}

// ── Flush scheduler ───────────────────────────────────────────────────

// Budget per flush cycle: yield after 12ms so input stays responsive.
// Leaves ~4ms for browser work within a 16ms frame budget.
const _FLUSH_BUDGET_MS = 12;

export function _flushPending(root: RootState): void {
  root.flushScheduled = false;
  if (root.disposed) return; // AIO-243
  const prevRoot = _activeRoot;
  _setActiveRoot(root);
  _setDelegationRoot(root.root);
  const _now = typeof performance !== "undefined"
    ? () => performance.now()
    : Date.now;
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
      for (const inst of batchItems) {
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
        _rerenderComponent(inst);
        // Yield to browser if over budget — schedule continuation
        if (_now() > deadline && root.pendingComponents.size > 0) {
          _setActiveRoot(prevRoot);
          _setDelegationRoot(null);
          root.flushScheduled = true;
          queueMicrotask(() => _flushPending(root));
          return; // afterRender fires when continuation completes
        }
      }
    }
    root._renderCounts.clear(); // AIO-209: reset after full flush completes
    _flushAfterRender(root);
  } finally {
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
