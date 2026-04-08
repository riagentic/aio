// AIO VDOM helpers — signal text-node bindings and action system.
// Leaf module with no deps on vdom-render/diff/remove.

import { effect } from "./signal.ts";
import type { Signal } from "./signal.ts";

// ── Signal text-node bindings ─────────────────────────────────────────
// When a Signal is passed as a child (e.g., h("span", null, countSignal)),
// an effect updates the text node directly without re-rendering the component.
const _signalTextCleanups = new WeakMap<Element, (() => void)[]>();

export function _bindSignalTextChildren(
  el: Element,
  signalMap: Map<number, Signal<unknown>>,
): void {
  const cleanups: (() => void)[] = [];
  for (const [idx, sig] of signalMap) {
    const textNode = el.childNodes[idx];
    if (!textNode || textNode.nodeType !== 3) continue; // safety: must be text node
    const dispose = effect(() => {
      const val = sig.value;
      textNode.textContent = val == null ? "" : String(val);
    });
    cleanups.push(dispose);
  }
  if (cleanups.length > 0) _signalTextCleanups.set(el, cleanups);
}

export function _cleanupSignalTextChildren(el: Element): void {
  const cleanups = _signalTextCleanups.get(el);
  if (cleanups) {
    for (const fn of cleanups) fn();
    _signalTextCleanups.delete(el);
  }
}

// ── Action cleanup handles per element ──────────────────────────────
const _actionCleanups = new WeakMap<HTMLElement, (() => void)[]>();

/** Run action functions and store cleanup handles. */
export function _applyActions(el: HTMLElement, actions: unknown): void {
  if (!Array.isArray(actions)) return;
  const cleanups: (() => void)[] = [];
  for (const action of actions) {
    if (typeof action !== "function") continue;
    try {
      const result =
        (action as (node: HTMLElement) => { cleanup?(): void } | void)(el);
      if (result && typeof result.cleanup === "function") {
        cleanups.push(result.cleanup);
      }
    } catch (e) {
      console.error("[aio:vdom] action execution error:", e);
    }
  }
  if (cleanups.length > 0) {
    _actionCleanups.set(el, cleanups);
  }
}

/** Run stored cleanup functions for an element's actions. */
export function _cleanupActions(el: HTMLElement): void {
  const cleanups = _actionCleanups.get(el);
  if (cleanups) {
    try {
      for (const fn of cleanups) {
        try {
          fn();
        } catch (e) {
          console.error("[aio:vdom] action cleanup error:", e);
        }
      }
    } finally {
      _actionCleanups.delete(el);
    }
  }
}
