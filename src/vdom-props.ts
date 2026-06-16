// VDOM prop application — DOM attribute/property/event/style patching.
// Imports from vdom-types.ts, vdom-events.ts, signal-binding.ts, ssr-utils.ts.

import { batch } from "./signal.ts";
import { isSignal, resolveSignalProp } from "./signal-binding.ts";
import {
  camelToKebab as _camelToKebab,
  resolveClassName as _resolveClassName,
  styleValue as _styleValue,
} from "./ssr-utils.ts";
import { _DOM_PROPS } from "./vdom-types.ts";
import {
  _CHANGE_TARGETS,
  _DELEGATED_EVENTS,
  _deleteWrapped,
  _ensureDelegation,
  _getActiveDelegationRoot,
  _getWrapped,
  _mapEventName,
  _setWrapped,
} from "./vdom-events.ts";

// SVG namespaced attribute prefixes — require setAttributeNS/removeAttributeNS
// so the attr lands in the correct namespace. Plain setAttribute puts it in the
// null namespace, which xlink: consumers (e.g. <use xlink:href>) won't resolve.
const _XLINK_NS = "http://www.w3.org/1999/xlink";
const _XML_NS = "http://www.w3.org/XML/1998/namespace";
function _attrNS(k: string): string | null {
  if (k.startsWith("xlink:")) return _XLINK_NS;
  if (k.startsWith("xml:")) return _XML_NS;
  return null;
}

// ── applyProps ────────────────────────────────────────────────────────

export function applyProps(
  el: HTMLElement,
  next: Record<string, unknown>,
  prev: Record<string, unknown>,
): void {
  // AIO-166: detect onChange+onInput collision on form elements
  const _hasOnInput = "onInput" in next && _CHANGE_TARGETS.has(el.tagName);

  // Remove old props not in next
  for (const k of Object.keys(prev)) {
    if (k === "key" || k === "children" || k === "ref" || k === "use") continue;
    if (!(k in next)) {
      if (k.startsWith("on")) {
        const evt = _mapEventName(
          k.slice(2).toLowerCase(),
          el,
          k === "onChange" ? _hasOnInput : undefined,
        );
        if (_DELEGATED_EVENTS.has(evt)) {
          // Also removeEventListener in case it was per-element fallback (AIO-154)
          const wrapped = _getWrapped(el, evt);
          if (wrapped) el.removeEventListener(evt, wrapped);
          _deleteWrapped(el, evt);
        } else {
          const wrapped = _getWrapped(el, evt);
          el.removeEventListener(evt, wrapped ?? prev[k] as EventListener);
          _deleteWrapped(el, evt);
        }
      } else if (k === "className") {
        el.removeAttribute("class");
      } else if (k === "style") {
        el.removeAttribute("style");
      } else if (k === "dangerouslySetInnerHTML") {
        el.innerHTML = ""; // AIO-80: clear stale innerHTML
      } else if (k in el && _DOM_PROPS.has(k)) {
        // deno-lint-ignore no-explicit-any
        (el as any)[k] = typeof (el as any)[k] === "boolean" ? false : "";
      } else {
        const ns = _attrNS(k);
        if (ns) el.removeAttributeNS(ns, k.slice(k.indexOf(":") + 1));
        else el.removeAttribute(k);
      }
    }
  }

  // Set new/changed props
  for (const [k, v] of Object.entries(next)) {
    if (k === "key" || k === "children" || k === "ref" || k === "use") continue;
    const rv = resolveSignalProp(v);
    if (isSignal(v)) continue; // Signal binding handles ongoing updates via effect
    if (prev[k] === rv) continue;

    if (k.startsWith("on")) {
      const evt = _mapEventName(
        k.slice(2).toLowerCase(),
        el,
        k === "onChange" ? _hasOnInput : undefined,
      );
      // AIO-106: null/false handler = removal only, don't wrap non-function
      if (rv == null || rv === false) {
        if (!_DELEGATED_EVENTS.has(evt)) {
          const oldWrapped = _getWrapped(el, evt);
          if (oldWrapped) el.removeEventListener(evt, oldWrapped);
          else if (prev[k]) {
            el.removeEventListener(evt, prev[k] as EventListener);
          }
        }
        _deleteWrapped(el, evt);
        continue;
      }
      // Wrap handler in batch() to coalesce multiple signal writes into one render
      const handler = rv as EventListener;
      const wrapped = (e: Event) => batch(() => handler(e));
      const delegationRoot = _getActiveDelegationRoot();
      if (_DELEGATED_EVENTS.has(evt) && delegationRoot) {
        // Delegated: store in lookup map — root listener dispatches via composedPath
        _ensureDelegation(delegationRoot, evt);
        _setWrapped(el, evt, wrapped);
      } else {
        // Non-delegated (focus, blur, scroll, etc.): per-element listener
        const oldWrapped = _getWrapped(el, evt);
        if (oldWrapped) el.removeEventListener(evt, oldWrapped);
        else if (prev[k]) el.removeEventListener(evt, prev[k] as EventListener);
        el.addEventListener(evt, wrapped);
        _setWrapped(el, evt, wrapped);
      }
    } else if (k === "className") {
      const cls = _resolveClassName(rv);
      if (cls) el.setAttribute("class", cls);
      else el.removeAttribute("class");
    } else if (k === "style" && typeof rv === "string") {
      el.style.cssText = rv;
    } else if (k === "style" && typeof rv === "object" && rv !== null) {
      const style = el.style;
      const newStyle = rv as Record<string, unknown>;
      const prevIsString = typeof prev[k] === "string";
      const oldStyle: Record<string, unknown> = prevIsString
        ? {}
        : ((prev[k] as Record<string, unknown>) ?? {});
      // AIO-163: if old style was a string, clear all before applying object
      if (prevIsString) {
        style.cssText = "";
      } else {
        // Remove stale style properties not in new style
        for (const sk of Object.keys(oldStyle)) {
          if (!(sk in newStyle)) {
            style.removeProperty(_camelToKebab(sk));
          }
        }
      }
      // Set new/changed style properties (resolve any signal values within style obj)
      for (const [sk, sv] of Object.entries(newStyle)) {
        const rsv = resolveSignalProp(sv);
        if (isSignal(sv)) continue; // style-level signal binding handles via effect
        const oldRsv = resolveSignalProp(oldStyle[sk]);
        if (oldRsv !== rsv) {
          style.setProperty(_camelToKebab(sk), _styleValue(sk, rsv));
        }
      }
    } else if (k === "dangerouslySetInnerHTML") {
      // AIO-200: handle both truthy object and null/false transition
      if (rv && typeof rv === "object") {
        el.innerHTML = (rv as { __html: string }).__html ?? "";
      } else {
        el.innerHTML = "";
      }
    } else if (k in el && _DOM_PROPS.has(k)) {
      // DOM properties (form elements): assign directly instead of setAttribute
      // deno-lint-ignore no-explicit-any
      (el as any)[k] = rv ?? "";
    } else if (rv === false || rv == null) {
      const ns = _attrNS(k);
      if (ns) el.removeAttributeNS(ns, k.slice(k.indexOf(":") + 1));
      else el.removeAttribute(k);
    } else {
      const ns = _attrNS(k);
      if (ns) el.setAttributeNS(ns, k, String(rv));
      else el.setAttribute(k, String(rv));
    }
  }
}

// ── Signal prop change detection ──────────────────────────────────────

/** Check if any signal prop identity changed between old and new props. */
export function _hasSignalPropChange(
  next: Record<string, unknown>,
  prev: Record<string, unknown>,
): boolean {
  for (const [k, v] of Object.entries(next)) {
    if (isSignal(v) && v !== prev[k]) return true;
  }
  for (const [k, v] of Object.entries(prev)) {
    if (isSignal(v) && !isSignal(next[k])) return true;
  }
  return false;
}
