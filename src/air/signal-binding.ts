// Signal-bound attributes: direct Signal→DOM bindings bypassing VDOM diff.
// Used by vdom.ts to create per-prop effects when Signal values are passed as props.

import { effect } from "../state/signal.ts";
import type { Signal } from "../state/signal.ts";
import { styleValue } from "./ssr-utils.ts";
// The prop→DOM rule is shared with `applyProps`. It used to be copied here, and
// the copy had no `svgAttrName` mapping and no `k in el` guard: `strokeWidth`
// landed as a literal attribute SVG ignores, and `disabled` on a non-form
// element became an invisible JS expando. Same prop, different DOM, purely
// because the value was a signal.
import { _RESERVED_PROPS, _writeProp } from "./prop-write.ts";

/** Check if a value is a Signal (duck-typing: _subscribers + set + peek).
 *
 *  `"function"` is accepted alongside `"object"` because a signal IS callable
 *  (`count()` is the same tracked read as `count.value`) — and `typeof` says
 *  "function" for a callable object. This is THE decider for "is this a
 *  signal": every prop binding, child binding and hydration check routes
 *  through it, so an `"object"`-only test would silently reclassify every
 *  signal in the renderer at once. */
export function isSignal(v: unknown): v is Signal<unknown> {
  return (
    v !== null &&
    (typeof v === "object" || typeof v === "function") &&
    "_subscribers" in (v as Record<string, unknown>) &&
    "set" in (v as Record<string, unknown>) &&
    "peek" in (v as Record<string, unknown>)
  );
}

const _signalBindingCleanups = new WeakMap<Element, (() => void)[]>();

/** For each Signal prop, create an effect that updates the DOM attribute directly. */
export function bindSignalProps(
  el: HTMLElement,
  props: Record<string, unknown>,
): void {
  const cleanups: (() => void)[] = [];

  for (const [k, v] of Object.entries(props)) {
    if (_RESERVED_PROPS.has(k)) continue;

    if (isSignal(v)) {
      const sig = v as Signal<unknown>;
      // `prev` lets a style OBJECT retire the declarations it dropped, exactly
      // as the diff path does — the old copy cleared `cssText` wholesale.
      let prev: unknown;
      const dispose = effect(() => {
        const val = sig.value;
        _writeProp(el, k, val, prev);
        prev = val;
      });
      cleanups.push(dispose);
    } else if (k === "style" && typeof v === "object" && v !== null) {
      // Style object may contain signal values per-property
      for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
        if (isSignal(sv)) {
          const sig = sv as Signal<unknown>;
          const styleProp = sk.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
          const dispose = effect(() => {
            const val = sig.value;
            el.style.setProperty(
              styleProp,
              val == null ? "" : styleValue(sk, val),
            );
          });
          cleanups.push(dispose);
        }
      }
    }
  }

  // Always dispose old bindings first (AIO-88: even when no new signal props,
  // old effects must be stopped to prevent stale DOM updates)
  cleanupSignalBindings(el);
  if (cleanups.length > 0) {
    _signalBindingCleanups.set(el, cleanups);
  }
}

/** Dispose all signal-binding effects for an element. */
export function cleanupSignalBindings(el: Element): void {
  const cleanups = _signalBindingCleanups.get(el);
  if (cleanups) {
    for (const fn of cleanups) fn();
    _signalBindingCleanups.delete(el);
  }
}

/** Resolve a signal to its current value without tracking (for initial render). */
export function resolveSignalProp(v: unknown): unknown {
  return isSignal(v) ? (v as Signal<unknown>).peek() : v;
}
