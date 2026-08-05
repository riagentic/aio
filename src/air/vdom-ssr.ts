// VDOM SSR — renderToString and SSR lifecycle hooks.
// Renders a VNode tree to an HTML string without requiring a DOM environment.

import { resolveSignalProp } from "./signal-binding.ts";
import {
  camelToKebab as _camelToKebab,
  escapeAttr as _escapeAttr,
  escapeHtml as _escapeHtml,
  resolveClassName as _resolveClassName,
  styleValue as _styleValue,
  svgAttrName,
  VOID_ELEMENTS,
} from "./ssr-utils.ts";
import { _propAttr, _RESERVED_PROPS } from "./prop-write.ts";
import type { ComponentFn, VNode } from "./vdom-types.ts";
import {
  _LAZY_PENDING,
  _Null,
  ErrorBoundary,
  Fragment,
  Portal,
  Suspense,
} from "./vdom-types.ts";

// ── SSR start hook ─────────────────────────────────────────────────

/** Hook called at the start of top-level renderToString/renderToStream (for resetting useId counter etc). */
let _onSsrStart: (() => void) | null = null;

export function _setSsrStartHook(fn: (() => void) | null): void {
  _onSsrStart = fn;
}

/** Invoke the SSR start hook (AIO-191: used by renderToStream). */
export function _invokeSsrStartHook(): void {
  if (_onSsrStart) _onSsrStart();
}

// ── Attribute serialization — the ONE decider both SSR writers use ────

/** Which tags actually OWN each boolean form property.
 *
 *  `applyProps` decides "is this a boolean DOM property?" by asking the element
 *  (`k in el && _DOM_PROPS.has(k)`), so it writes `checked`/`disabled`/… as a
 *  property on a form control and as a PLAIN ATTRIBUTE on anything else —
 *  `<div disabled>` becomes `disabled="true"`. SSR answered by name alone and
 *  emitted the bare boolean token `disabled` for every tag, so the server sent
 *  `<div disabled="">` where the client builds `<div disabled="true">`: the
 *  same vnode, two documents, and an attribute selector that matches on one
 *  render and not the other. Same question, one answer. */
const _BOOL_ATTR_TAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  checked: new Set(["input"]),
  selected: new Set(["option"]),
  disabled: new Set([
    "button",
    "fieldset",
    "input",
    "optgroup",
    "option",
    "select",
    "textarea",
  ]),
  readOnly: new Set(["input", "textarea"]),
  multiple: new Set(["input", "select"]),
};

/** Serialize an element's props to an HTML attribute string.
 *
 *  `renderToString` and `renderToStream` are two entry points to the SAME
 *  document; each used to carry its own copy of this loop, and the copies drifted
 *  — the streaming writer kept emitting the `t` semantic marker for a whole
 *  release after the string writer stopped, so a streamed page shipped
 *  attributes the client renderer never produces and hydration could not
 *  reconcile. There is one rule for how a prop becomes an attribute; it lives
 *  here, and both writers call it. */
export function _renderPropsHtml(
  props: Record<string, unknown>,
  tag?: string,
): string {
  let html = "";
  for (const [k, rawV] of Object.entries(props)) {
    if (
      // Framework metadata — the same set the client renderer refuses to write,
      // `t` (the semantic marker) included.
      _RESERVED_PROPS.has(k) ||
      k === "dangerouslySetInnerHTML" ||
      // `t` is the SEMANTIC marker (testUI / `am surface` read it from the
      // component tree, never from the DOM). The client renderer already
      // skips it; SSR used to emit it, so server HTML and the live DOM
      // disagreed — and every DOM-probing tool that looked for it found
      // nothing once hydration replaced the markup.
      k === "t"
    ) continue;
    if (k.startsWith("on")) continue; // Skip event handlers in SSR
    // A DOM-property prop is written under the attribute that expresses it —
    // `<select value>` and `<textarea value>` have none, so they emit nothing
    // (the textarea's value is emitted as its TEXT by `_ssrTextareaText`).
    const mapped = _propAttr(tag ?? "", k);
    if (mapped === null) continue;
    const name = mapped ?? k;
    // AIO-109: resolve signals to current value for SSR
    const v = resolveSignalProp(rawV);

    if (k === "className") {
      const cls = _resolveClassName(v);
      if (cls) html += ` class="${_escapeAttr(cls)}"`;
    } else if (k === "style" && typeof v === "string") {
      if (v) html += ` style="${_escapeAttr(v)}"`;
    } else if (k === "style" && typeof v === "object" && v !== null) {
      const pairs = Object.entries(v as Record<string, string>)
        .filter(([_, sv]) => sv != null) // AIO-164: skip null/undefined values
        .map(([sk, sv]) =>
          `${_camelToKebab(sk)}:${_styleValue(sk, resolveSignalProp(sv))}`
        )
        .join(";");
      if (pairs) html += ` style="${_escapeAttr(pairs)}"`;
    } else if (_BOOL_ATTR_TAGS[name]?.has(tag ?? "")) {
      if (v) html += ` ${name}`;
    } else if (v !== false && v != null) {
      // AIO-187: render all non-boolean attrs with explicit value
      // (known boolean attrs like checked/disabled handled above)
      html += ` ${svgAttrName(name)}="${_escapeAttr(String(v))}"`;
    }
  }
  return html;
}

/** The text a `<textarea value={…}>` must carry in markup, or null when the
 *  element has no value prop (or has explicit children, which win).
 *
 *  A textarea has no `value` content attribute: its value IS its child text.
 *  `<textarea value={state.body}>` — the shape `docs/examples/04-electron-app.md`
 *  documents — therefore server-rendered as an EMPTY box with a meaningless
 *  `value="…"` attribute, and hydration never wrote the property, so the editor
 *  stayed empty. Typing into it and letting the `onChange` write back then
 *  replaced the stored note with what was typed into a blank textarea.
 *
 *  All three SSR element writers (`renderToString`, `renderToStream` and its
 *  sync fallback) call this, so there is one answer to "what is inside a
 *  textarea". */
export function _ssrTextareaText(vnode: VNode): string | null {
  if (vnode.tag !== "textarea" || vnode.children.length > 0) return null;
  const raw = vnode.props.value ?? vnode.props.defaultValue;
  const v = resolveSignalProp(raw);
  return v == null ? null : _escapeHtml(String(v));
}

/** AIO-195 parity: an empty Fragment / ErrorBoundary / Suspense gets a comment
 *  ANCHOR when built by `createDom`, because it must keep its slot among its
 *  siblings. SSR emitted nothing, so a hydrated empty container had no `_dom` at
 *  all and its next diff anchored at the parent's FIRST child — a list that
 *  starts empty and then fills rendered its rows ABOVE the header. Server HTML
 *  and client DOM must be the same document. */
const _EMPTY_ANCHOR = "<!---->";

// ── SSR depth counter ──────────────────────────────────────────────
let _ssrDepth = 0;

/** Render a VNode tree to an HTML string (no DOM required). */
export function renderToString(
  vnode: VNode | string | number | null,
): string {
  // Use local depth tracking instead of module-level global.
  // Each top-level call resets state — safe for concurrent SSR requests.
  const isTopLevel = _ssrDepth === 0;
  if (isTopLevel && _onSsrStart) _onSsrStart();
  _ssrDepth++;
  try {
    if (vnode == null) return "";
    if (typeof vnode === "string") return _escapeHtml(vnode);
    if (typeof vnode === "number") return String(vnode);

    // Component — execute and render output
    if (typeof vnode.tag === "function") {
      const rendered = (vnode.tag as ComponentFn)({
        ...vnode.props,
        children: vnode.children.length > 0
          ? vnode.children
          : (vnode.props.children ?? vnode.children),
      });
      return renderToString(rendered);
    }

    // Null placeholder — comment node in HTML (AIO-107)
    if (vnode.tag === _Null) return "<!---->";

    // Portal — skip in SSR (no target DOM available)
    if (vnode.tag === Portal) return "";

    // Suspense — try to render children, show fallback if lazy throws
    if (vnode.tag === Suspense) {
      const fallback = vnode.props.fallback as
        | VNode
        | string
        | number
        | null
        | undefined;
      try {
        const html = vnode.children.map((c) => renderToString(c)).join("");
        return html === "" ? _EMPTY_ANCHOR : html;
      } catch (thrown) {
        if (thrown !== _LAZY_PENDING) throw thrown;
        return renderToString(fallback ?? null);
      }
    }

    // Fragment — render children
    if (vnode.tag === Fragment) {
      const html = vnode.children.map((c) => renderToString(c)).join("");
      return html === "" ? _EMPTY_ANCHOR : html;
    }

    // ErrorBoundary — render children with error catching
    if (vnode.tag === ErrorBoundary) {
      const fallback = vnode.props.fallback as
        | ((e: Error) => VNode | string | number | null)
        | undefined;
      try {
        const html = vnode.children.map((c) => renderToString(c)).join("");
        return html === "" ? _EMPTY_ANCHOR : html;
      } catch (error) {
        if (!fallback) throw error;
        return renderToString(fallback(error as Error));
      }
    }

    // Element
    const tag = vnode.tag as string;
    const selfClosing = VOID_ELEMENTS.has(tag);
    let html = `<${tag}${_renderPropsHtml(vnode.props, tag)}`;

    html += ">";
    if (selfClosing) return html;

    // dangerouslySetInnerHTML
    const dih = vnode.props.dangerouslySetInnerHTML as
      | { __html: string }
      | undefined;
    const areaText = _ssrTextareaText(vnode);
    if (dih) {
      html += dih.__html;
    } else if (areaText !== null) {
      html += areaText;
    } else {
      for (const child of vnode.children) {
        html += renderToString(child);
      }
    }

    html += `</${tag}>`;
    return html;
  } finally {
    _ssrDepth--;
  }
}
