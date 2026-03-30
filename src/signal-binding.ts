// Signal-bound attributes: direct Signal→DOM bindings bypassing VDOM diff.
// Used by vdom.ts to create per-prop effects when Signal values are passed as props.

import { effect } from "./signal.ts";
import type { Signal } from "./signal.ts";
import { styleValue } from "./ssr-utils.ts";

/** Check if a value is a Signal (duck-typing: _subscribers + set + peek). */
export function isSignal(v: unknown): v is Signal<unknown> {
  return (
    v !== null &&
    typeof v === "object" &&
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
    if (k === "key" || k === "children" || k === "ref" || k === "use") continue;

    if (isSignal(v)) {
      const sig = v as Signal<unknown>;
      const dispose = effect(() => {
        const val = sig.value;
        _applyProp(el, k, val);
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

function _applyProp(el: HTMLElement, k: string, v: unknown): void {
  if (k === "className") {
    const cls = typeof v === "string"
      ? v
      : Array.isArray(v)
      ? v.filter(Boolean).join(" ")
      : typeof v === "object" && v !== null
      ? Object.entries(v as Record<string, unknown>)
        .filter(([, val]) => val)
        .map(([key]) => key)
        .join(" ")
      : "";
    if (cls) el.setAttribute("class", cls);
    else el.removeAttribute("class");
  } else if (k === "style") {
    // AIO-170: handle style signal values — string, object, or null/false
    if (typeof v === "string") {
      el.style.cssText = v;
    } else if (typeof v === "object" && v !== null) {
      el.style.cssText = "";
      for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
        if (sv != null) {
          const prop = sk.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
          el.style.setProperty(prop, styleValue(sk, sv));
        }
      }
    } else {
      el.style.cssText = "";
    }
  } else if (
    k === "value" ||
    k === "checked" ||
    k === "selected" ||
    k === "disabled" ||
    k === "readOnly" ||
    k === "multiple" ||
    k === "indeterminate" ||
    k === "defaultChecked" ||
    k === "defaultValue"
  ) {
    // deno-lint-ignore no-explicit-any
    (el as any)[k] = v ?? "";
  } else if (v === false || v == null) {
    el.removeAttribute(k);
  } else if (v === true) {
    el.setAttribute(k, "");
  } else {
    el.setAttribute(k, String(v));
  }
}
