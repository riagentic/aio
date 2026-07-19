// AIO VDOM helpers — signal text-node bindings and action system.
// Leaf module with no deps on vdom-render/diff/remove.

import { effect } from "../state/signal.ts";
import type { Signal } from "../state/signal.ts";
import { _domNodeCount } from "./vdom-types.ts";
import type { VNode } from "./vdom-types.ts";

// ── Signal text-node bindings ─────────────────────────────────────────
// When a Signal is passed as a child (e.g., h("span", null, countSignal)),
// an effect updates the text node directly without re-rendering the component.
const _signalTextCleanups = new WeakMap<Element, (() => void)[]>();

export function _bindSignalTextChildren(
  el: Element,
  signalMap: Map<number, Signal<unknown>>,
  children?: (VNode | string | number)[],
): void {
  // Dispose any prior bindings on this element before overwriting — a re-bind
  // (e.g. hydration re-run, or a caller that doesn't go through the diff path
  // which cleans up first) would otherwise leak the previous effects, leaving
  // them to mutate detached text nodes.
  _cleanupSignalTextChildren(el);
  const cleanups: (() => void)[] = [];

  // AIO-410: locate each signal child's text node by walking the REALIZED DOM,
  // not by its array index. A multi-node sibling (a Fragment splatting several
  // nodes) makes array-index != DOM-index; the old `el.childNodes[idx]` then
  // landed on a non-text node, the nodeType guard skipped the bind, and the
  // signal child silently never updated. Walking the DOM in child order keeps
  // the mapping exact. `children` is optional only for backward safety; when
  // absent (should not happen from the diff/render paths) we fall back to the
  // index so behaviour never regresses below the old baseline.
  if (children) {
    let node: ChildNode | null = el.firstChild;
    for (let i = 0; i < children.length && node; i++) {
      if (signalMap.has(i)) {
        if (node.nodeType === 3) {
          const textNode = node;
          const sig = signalMap.get(i)!;
          cleanups.push(effect(() => {
            const val = sig.value;
            textNode.textContent = val == null ? "" : String(val);
          }));
        }
        node = node.nextSibling; // a signal child is exactly one text node
      } else {
        let span = _domNodeCount(children[i]!);
        while (span-- > 0 && node) node = node.nextSibling;
      }
    }
  } else {
    for (const [idx, sig] of signalMap) {
      const textNode = el.childNodes[idx];
      if (!textNode || textNode.nodeType !== 3) continue;
      cleanups.push(effect(() => {
        const val = sig.value;
        textNode.textContent = val == null ? "" : String(val);
      }));
    }
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
  // Dispose any prior action cleanups before overwriting — defends against
  // callers that re-apply actions without an explicit cleanup step (the diff
  // path cleans up first, but hydration/re-render paths may not).
  _cleanupActions(el);
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
