// The ONE rule for "this prop becomes this DOM mutation".
//
// Deciding whether a prop is a class, a style, a DOM property or an attribute —
// and under which NAME and namespace it lands — used to be written twice: once
// in `applyProps` (vdom-props.ts, the diff/mount path) and once in `_applyProp`
// (signal-binding.ts, the path a Signal-valued prop takes). The copies drifted,
// so the SAME prop rendered differently depending on whether its value happened
// to be a signal:
//
//   strokeWidth={2}        → stroke-width="2"   (the attribute SVG reads)
//   strokeWidth={sig}      → strokeWidth="2"    (an attribute nothing reads)
//   disabled={true} on div → disabled="true"
//   disabled={sig}  on div → nothing at all — a JS expando on the element
//
// All silent, and invisible to any test that only exercises one of the two. The
// rule lives here now; both callers apply it and neither owns a variant.
//
// Leaf module by design: vdom-types.ts + ssr-utils.ts only, so both the prop
// patcher and the signal binder can reach it without a cycle.

import {
  camelToKebab as _camelToKebab,
  resolveClassName as _resolveClassName,
  styleValue as _styleValue,
  svgAttrName as _attrName,
} from "./ssr-utils.ts";
import { _DOM_PROPS } from "./vdom-types.ts";

// SVG namespaced attribute prefixes — require setAttributeNS/removeAttributeNS
// so the attr lands in the correct namespace. Plain setAttribute puts it in the
// null namespace, which xlink: consumers (e.g. <use xlink:href>) won't resolve.
const _XLINK_NS = "http://www.w3.org/1999/xlink";
const _XML_NS = "http://www.w3.org/XML/1998/namespace";

/** Props that are NEVER an attribute or a DOM property: framework metadata and
 *  escape hatches whose effect is applied somewhere else. `t` in particular is
 *  the SEMANTIC marker that `testUI` and `am surface` read off the component
 *  tree — it must not reach the DOM at all.
 *
 *  This list was written out three times (the diff patcher, the signal binder,
 *  the SSR writer) and they disagreed: the signal binder had no `t`, so
 *  `t={someSignal}` leaked the marker into the markup that plain `t="…"` and
 *  SSR both keep out. */
export const _RESERVED_PROPS: ReadonlySet<string> = new Set([
  "key",
  "children",
  "ref",
  "use",
  "t",
]);

/** The CONTENT ATTRIBUTE that expresses a `_DOM_PROPS` prop on a given tag:
 *  the attribute's name, `null` when markup has no way to express it, or
 *  `undefined` when the prop is not a DOM property at all.
 *
 *  A DOM property and its attribute are two different things and the mapping is
 *  neither identity nor mechanical — `readOnly` is spelled `readonly`,
 *  `defaultValue`/`defaultChecked` ARE the `value`/`checked` attributes,
 *  `indeterminate` has no attribute, and a `<textarea>`/`<select>` has no
 *  `value` attribute (their value is child text / a selected `<option>`).
 *
 *  Two callers need that answer and used to guess it separately: the SSR writer
 *  emitted the JSX name verbatim (shipping `defaultValue="…"`, attributes no
 *  browser reads) and `applyProps` cleared a removed prop by resetting the
 *  PROPERTY only — which is not the same as removing it whenever the property
 *  reads through its attribute. `<input type="checkbox" value="a">` losing its
 *  `value` prop kept `value=""` and reported `""`, where a fresh render of the
 *  same model reports the checkbox default `"on"`: the form submitted a value
 *  the component no longer describes. One question, one answer. */
const _DOM_PROP_ATTR: Readonly<Record<string, string | null>> = {
  value: "value",
  checked: "checked",
  selected: "selected",
  disabled: "disabled",
  readOnly: "readonly",
  multiple: "multiple",
  indeterminate: null, // property-only — no content attribute exists
  defaultValue: "value",
  defaultChecked: "checked",
};

/** Tags on which the prop has no content attribute at all, whatever its name. */
const _NO_ATTR_ON: Readonly<Record<string, ReadonlySet<string>>> = {
  value: new Set(["textarea", "select"]),
  defaultValue: new Set(["textarea", "select"]),
};

export function _propAttr(
  tag: string,
  k: string,
): string | null | undefined {
  if (!_DOM_PROPS.has(k)) return undefined;
  if (_NO_ATTR_ON[k]?.has(tag)) return null;
  return _DOM_PROP_ATTR[k] ?? null;
}

/** The namespace an attribute name belongs to, or null for the default one. */
export function _attrNS(k: string): string | null {
  if (k.startsWith("xlink:")) return _XLINK_NS;
  if (k.startsWith("xml:")) return _XML_NS;
  return null;
}

/**
 * Write one already-resolved prop value onto an element.
 *
 * `prev` is the value this prop last held (undefined when unknown) and is used
 * only to retire stale style declarations — every other branch is a full write.
 * Event props are NOT handled here: listener bookkeeping belongs to whoever
 * owns the element's lifecycle.
 */
export function _writeProp(
  el: HTMLElement,
  k: string,
  v: unknown,
  prev?: unknown,
): void {
  if (k === "className") {
    const cls = _resolveClassName(v);
    if (cls) el.setAttribute("class", cls);
    else el.removeAttribute("class");
    return;
  }
  if (k === "style") {
    if (typeof v === "string") {
      el.style.cssText = v;
      return;
    }
    if (typeof v === "object" && v !== null) {
      const style = el.style;
      const newStyle = v as Record<string, unknown>;
      const prevIsString = typeof prev === "string";
      const oldStyle: Record<string, unknown> = prevIsString
        ? {}
        : ((prev as Record<string, unknown>) ?? {});
      // AIO-163: if old style was a string, clear all before applying object
      if (prevIsString) {
        style.cssText = "";
      } else {
        for (const sk of Object.keys(oldStyle)) {
          if (!(sk in newStyle)) style.removeProperty(_camelToKebab(sk));
        }
      }
      for (const [sk, sv] of Object.entries(newStyle)) {
        if (oldStyle[sk] !== sv) {
          style.setProperty(_camelToKebab(sk), _styleValue(sk, sv));
        }
      }
      return;
    }
    // AIO-170: a null/false style clears everything.
    el.style.cssText = "";
    return;
  }
  if (k === "dangerouslySetInnerHTML") {
    // AIO-200: handle both truthy object and null/false transition
    el.innerHTML = (v && typeof v === "object")
      ? ((v as { __html: string }).__html ?? "")
      : "";
    return;
  }
  if (k in el && _DOM_PROPS.has(k)) {
    // DOM properties (form elements): assign directly instead of setAttribute.
    // The `k in el` guard is load-bearing — `disabled`/`value` on a <div> are
    // NOT properties there, and assigning them creates an invisible expando
    // instead of the attribute the server rendered.
    // deno-lint-ignore no-explicit-any
    (el as any)[k] = v ?? "";
    return;
  }
  const ns = _attrNS(k);
  if (v === false || v == null) {
    if (ns) el.removeAttributeNS(ns, k.slice(k.indexOf(":") + 1));
    else el.removeAttribute(_attrName(k));
    return;
  }
  if (ns) el.setAttributeNS(ns, k, String(v));
  else el.setAttribute(_attrName(k), String(v));
}
