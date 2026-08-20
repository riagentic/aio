// Streaming SSR — async generator that yields HTML chunks.

import type { ComponentFn, VNode } from "./vdom.ts";
import {
  _invokeSsrStartHook,
  ErrorBoundary,
  Fragment,
  Portal,
  Suspense,
} from "./vdom.ts";
import { escapeHtml as _escapeHtml, VOID_ELEMENTS } from "./ssr-utils.ts";
// The attribute rule is shared with renderToString — see _renderPropsHtml.
import {
  _renderPropsHtml as _renderProps,
  _ssrTextareaText,
} from "./vdom-ssr.ts";

const _LAZY_PENDING = Symbol.for("aio.LazyPending");

/** Render sync (for fallbacks and simple content). */
function _renderSync(vnode: VNode | string | number | null): string {
  if (vnode == null) return "";
  if (typeof vnode === "string") return _escapeHtml(vnode);
  if (typeof vnode === "number") return String(vnode);
  if (typeof vnode.tag === "function") {
    const rendered = (vnode.tag as ComponentFn)({
      ...vnode.props,
      children: vnode.children.length > 0
        ? vnode.children
        : (vnode.props.children ?? vnode.children),
    });
    // Nothing to render is still a POSITION — identical to renderToString, or
    // the stream and the string renderer ship different markup for the same
    // tree (the differential gate catches exactly that). See nullSlot().
    return rendered == null ? "<!---->" : _renderSync(rendered);
  }
  if (vnode.tag === Portal) return "";
  if (vnode.tag === Symbol.for("aio.Null")) return "<!---->";
  if (vnode.tag === Suspense) {
    const fallback = vnode.props.fallback as
      | VNode
      | string
      | number
      | null
      | undefined;
    try {
      const html = vnode.children.map((c) => _renderSync(c)).join("");
      return html === "" ? "<!---->" : html;
    } catch (thrown) {
      if (thrown !== _LAZY_PENDING) throw thrown;
      return _renderSync(fallback ?? null);
    }
  }
  if (vnode.tag === Fragment) {
    const html = vnode.children.map((c) => _renderSync(c)).join("");
    // AIO-195 parity with createDom/renderToString: an empty Fragment holds
    // its slot with a comment anchor. Streamed HTML that omits it hydrates
    // into a Fragment with no position (see vdom-ssr.ts).
    return html === "" ? "<!---->" : html;
  }
  if (vnode.tag === ErrorBoundary) {
    const fallback = vnode.props.fallback as
      | ((e: Error) => VNode | string | number | null)
      | undefined;
    try {
      const html = vnode.children.map((c) => _renderSync(c)).join("");
      return html === "" ? "<!---->" : html;
    } catch (error) {
      if (!fallback) throw error;
      return _renderSync(fallback(error as Error));
    }
  }
  // Element
  const tag = vnode.tag as string;
  const selfClosing = VOID_ELEMENTS.has(tag);
  let html = `<${tag}${_renderProps(vnode.props, tag)}>`;
  if (selfClosing) return html;
  const dih = vnode.props.dangerouslySetInnerHTML as
    | { __html: string }
    | undefined;
  const areaText = _ssrTextareaText(vnode);
  if (dih) html += dih.__html;
  else if (areaText !== null) html += areaText;
  else for (const child of vnode.children) html += _renderSync(child);
  html += `</${tag}>`;
  return html;
}

/**
 * Streaming SSR — async generator yielding HTML chunks.
 * Renders elements by yielding opening tag, then children, then closing tag.
 * Suspense boundaries with lazy children yield fallback content.
 */
export async function* renderToStream(
  vnode: VNode | string | number | null,
): AsyncGenerator<string, void, unknown> {
  // AIO-191: reset SSR ID counter so concurrent requests get unique IDs
  _invokeSsrStartHook();
  if (vnode == null) return;
  if (typeof vnode === "string") {
    yield _escapeHtml(vnode);
    return;
  }
  if (typeof vnode === "number") {
    yield String(vnode);
    return;
  }

  // Component
  if (typeof vnode.tag === "function") {
    let rendered: VNode | string | number | null;
    try {
      rendered = (vnode.tag as ComponentFn)({
        ...vnode.props,
        children: vnode.children.length > 0
          ? vnode.children
          : (vnode.props.children ?? vnode.children),
      });
    } catch (thrown) {
      // Re-throw _LAZY_PENDING so Suspense boundaries can catch it
      throw thrown;
    }
    if (rendered == null) {
      // Same rule as the sync path above and as renderToString.
      yield "<!---->";
      return;
    }
    yield* renderToStream(rendered);
    return;
  }

  // Portal — skip
  if (vnode.tag === Portal) return;

  // Null placeholder (AIO-107)
  if (vnode.tag === Symbol.for("aio.Null")) {
    yield "<!---->";
    return;
  }

  // Suspense — buffer children first; only yield if ALL succeed (AIO-186).
  // yield* inside try would leak partial HTML before the fallback on _LAZY_PENDING.
  if (vnode.tag === Suspense) {
    const fallback = vnode.props.fallback as
      | VNode
      | string
      | number
      | null
      | undefined;
    try {
      const chunks: string[] = [];
      for (const child of vnode.children) {
        for await (const chunk of renderToStream(child)) chunks.push(chunk);
      }
      // Same empty-region anchor as Fragment (AIO-195) — a boundary is a region
      // of its parent too, and must hold its slot.
      if (chunks.every((c) => c === "")) yield "<!---->";
      else for (const c of chunks) yield c;
    } catch (thrown) {
      if (thrown !== _LAZY_PENDING) throw thrown;
      if (fallback != null) yield _renderSync(fallback);
    }
    return;
  }

  // Fragment
  if (vnode.tag === Fragment) {
    // Buffered, not streamed child-by-child: an empty Fragment must emit its
    // comment anchor (AIO-195 parity), which is only knowable once every child
    // has produced nothing.
    const chunks: string[] = [];
    for (const child of vnode.children) {
      for await (const chunk of renderToStream(child)) chunks.push(chunk);
    }
    if (chunks.every((c) => c === "")) yield "<!---->";
    else for (const c of chunks) yield c;
    return;
  }

  // ErrorBoundary — buffer children first; yield* inside try would leak partial
  // HTML before the fallback (same pattern as Suspense above, AIO-215).
  if (vnode.tag === ErrorBoundary) {
    const fallback = vnode.props.fallback as
      | ((e: Error) => VNode | string | number | null)
      | undefined;
    try {
      const chunks: string[] = [];
      for (const child of vnode.children) {
        for await (const chunk of renderToStream(child)) chunks.push(chunk);
      }
      if (chunks.every((c) => c === "")) yield "<!---->";
      else for (const c of chunks) yield c;
    } catch (error) {
      if (!fallback) throw error;
      yield _renderSync(fallback(error as Error));
    }
    return;
  }

  // Element — yield opening tag, children, closing tag
  const tag = vnode.tag as string;
  const selfClosing = VOID_ELEMENTS.has(tag);
  yield `<${tag}${_renderProps(vnode.props, tag)}>`;
  if (selfClosing) return;
  const dih = vnode.props.dangerouslySetInnerHTML as
    | { __html: string }
    | undefined;
  const areaText = _ssrTextareaText(vnode);
  if (dih) yield dih.__html;
  else if (areaText !== null) yield areaText;
  else for (const child of vnode.children) yield* renderToStream(child);
  yield `</${tag}>`;
}
