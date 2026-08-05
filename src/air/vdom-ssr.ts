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
        return vnode.children.map((c) => renderToString(c)).join("");
      } catch (thrown) {
        if (thrown !== _LAZY_PENDING) throw thrown;
        return renderToString(fallback ?? null);
      }
    }

    // Fragment — render children
    if (vnode.tag === Fragment) {
      const html = vnode.children.map((c) => renderToString(c)).join("");
      // AIO-195 parity: an empty Fragment gets a comment ANCHOR when built by
      // createDom, because it must keep its slot among its siblings. SSR emitted
      // nothing, so a hydrated empty Fragment had no `_dom` at all and its next
      // diff anchored at the parent's FIRST child — a list that starts empty and
      // then fills rendered its rows ABOVE the header. Server HTML and client
      // DOM must be the same document.
      return html === "" ? "<!---->" : html;
    }

    // ErrorBoundary — render children with error catching
    if (vnode.tag === ErrorBoundary) {
      const fallback = vnode.props.fallback as
        | ((e: Error) => VNode | string | number | null)
        | undefined;
      try {
        return vnode.children.map((c) => renderToString(c)).join("");
      } catch (error) {
        if (!fallback) throw error;
        return renderToString(fallback(error as Error));
      }
    }

    // Element
    const tag = vnode.tag as string;
    const selfClosing = VOID_ELEMENTS.has(tag);
    let html = `<${tag}`;

    for (const [k, rawV] of Object.entries(vnode.props)) {
      if (
        k === "key" || k === "children" || k === "ref" ||
        k === "dangerouslySetInnerHTML" || k === "use" ||
        // `t` is the SEMANTIC marker (testUI / `am surface` read it from the
        // component tree, never from the DOM). The client renderer already
        // skips it; SSR used to emit it, so server HTML and the live DOM
        // disagreed — and every DOM-probing tool that looked for it found
        // nothing once hydration replaced the markup.
        k === "t"
      ) continue;
      if (k.startsWith("on")) continue; // Skip event handlers in SSR
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
      } else if (
        k === "checked" || k === "selected" || k === "disabled" ||
        k === "readOnly" || k === "multiple"
      ) {
        if (v) html += ` ${k}`;
      } else if (v !== false && v != null) {
        // AIO-187: render all non-boolean attrs with explicit value
        // (known boolean attrs like checked/disabled handled above)
        html += ` ${svgAttrName(k)}="${_escapeAttr(String(v))}"`;
      }
    }

    html += ">";
    if (selfClosing) return html;

    // dangerouslySetInnerHTML
    const dih = vnode.props.dangerouslySetInnerHTML as
      | { __html: string }
      | undefined;
    if (dih) {
      html += dih.__html;
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
