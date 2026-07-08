// Streaming SSR — async generator that yields HTML chunks.

import type { ComponentFn, VNode } from "./vdom.ts";
import {
  _invokeSsrStartHook,
  ErrorBoundary,
  Fragment,
  Portal,
  Suspense,
} from "./vdom.ts";
import {
  camelToKebab as _camelToKebab,
  escapeAttr as _escapeAttr,
  escapeHtml as _escapeHtml,
  resolveClassName as _resolveClassName,
  styleValue as _styleValue,
  VOID_ELEMENTS,
} from "./ssr-utils.ts";
import { resolveSignalProp } from "./signal-binding.ts";

const _LAZY_PENDING = Symbol.for("aio.LazyPending");

/** Render props to HTML attribute string. */
function _renderProps(props: Record<string, unknown>): string {
  let html = "";
  for (const [k, rawV] of Object.entries(props)) {
    if (
      k === "key" || k === "children" || k === "ref" ||
      k === "dangerouslySetInnerHTML" || k === "use"
    ) continue;
    if (k.startsWith("on")) continue;
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
      html += ` ${k}="${_escapeAttr(String(v))}"`;
    }
  }
  return html;
}

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
    return _renderSync(rendered);
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
      return vnode.children.map((c) => _renderSync(c)).join("");
    } catch (thrown) {
      if (thrown !== _LAZY_PENDING) throw thrown;
      return _renderSync(fallback ?? null);
    }
  }
  if (vnode.tag === Fragment) {
    return vnode.children.map((c) => _renderSync(c)).join("");
  }
  if (vnode.tag === ErrorBoundary) {
    const fallback = vnode.props.fallback as
      | ((e: Error) => VNode | string | number | null)
      | undefined;
    try {
      return vnode.children.map((c) => _renderSync(c)).join("");
    } catch (error) {
      if (!fallback) throw error;
      return _renderSync(fallback(error as Error));
    }
  }
  // Element
  const tag = vnode.tag as string;
  const selfClosing = VOID_ELEMENTS.has(tag);
  let html = `<${tag}${_renderProps(vnode.props)}>`;
  if (selfClosing) return html;
  const dih = vnode.props.dangerouslySetInnerHTML as
    | { __html: string }
    | undefined;
  if (dih) html += dih.__html;
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
      for (const c of chunks) yield c;
    } catch (thrown) {
      if (thrown !== _LAZY_PENDING) throw thrown;
      if (fallback != null) yield _renderSync(fallback);
    }
    return;
  }

  // Fragment
  if (vnode.tag === Fragment) {
    for (const child of vnode.children) yield* renderToStream(child);
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
      for (const c of chunks) yield c;
    } catch (error) {
      if (!fallback) throw error;
      yield _renderSync(fallback(error as Error));
    }
    return;
  }

  // Element — yield opening tag, children, closing tag
  const tag = vnode.tag as string;
  const selfClosing = VOID_ELEMENTS.has(tag);
  yield `<${tag}${_renderProps(vnode.props)}>`;
  if (selfClosing) return;
  const dih = vnode.props.dangerouslySetInnerHTML as
    | { __html: string }
    | undefined;
  if (dih) yield dih.__html;
  else for (const child of vnode.children) yield* renderToStream(child);
  yield `</${tag}>`;
}
