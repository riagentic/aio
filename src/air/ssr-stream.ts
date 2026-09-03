// Streaming SSR — async generator that yields HTML chunks.

import type { ComponentFn, VNode } from "./vdom.ts";
import {
  _invokeSsrStartHook,
  _SignalText,
  _sigText,
  ErrorBoundary,
  Fragment,
  Portal,
  Suspense,
} from "./vdom.ts";
import type { Signal } from "../state/signal.ts";
import { _hasRawHtml } from "./vdom-types.ts";
import { _notANode } from "./vdom-create.ts";
import { escapeHtml as _escapeHtml, VOID_ELEMENTS } from "./ssr-utils.ts";
// The attribute rule and the empty-region rule are shared with renderToString
// — see _renderPropsHtml and _regionHtml.
import {
  _regionHtml,
  _renderPropsHtml as _renderProps,
  _ssrTextareaText,
  type SsrNodes,
} from "./vdom-ssr.ts";

const _LAZY_PENDING = Symbol.for("aio.LazyPending");

/** Render sync (for fallbacks and simple content). `nodes` counts the DOM
 *  nodes the markup stands for (see `_regionHtml`). */
function _renderSync(
  vnode: VNode | string | number | null,
  nodes: SsrNodes = { n: 0 },
): string {
  if (vnode == null) return "";
  if (typeof vnode === "string") {
    nodes.n++;
    return _escapeHtml(vnode);
  }
  if (typeof vnode === "number") {
    nodes.n++;
    return String(vnode);
  }
  const bad = _notANode(vnode);
  if (bad) throw new Error(bad);
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
    if (rendered == null) {
      nodes.n++;
      return "<!---->";
    }
    return _renderSync(rendered, nodes);
  }
  if (vnode.tag === Portal) return "";
  if (vnode.tag === Symbol.for("aio.Null")) {
    nodes.n++;
    return "<!---->";
  }
  if (vnode.tag === _SignalText) {
    nodes.n++;
    return _escapeHtml(_sigText((vnode._sig as Signal<unknown>).peek()));
  }
  if (vnode.tag === Suspense) {
    const fallback = vnode.props.fallback as
      | VNode
      | string
      | number
      | null
      | undefined;
    try {
      return _regionSync(vnode, nodes);
    } catch (thrown) {
      if (thrown !== _LAZY_PENDING) throw thrown;
      return _renderSync(fallback ?? null, nodes);
    }
  }
  // AIO-195 parity with createDom/renderToString: an empty Fragment holds
  // its slot with a comment anchor. Streamed HTML that omits it hydrates
  // into a Fragment with no position (see vdom-ssr.ts).
  if (vnode.tag === Fragment) return _regionSync(vnode, nodes);
  if (vnode.tag === ErrorBoundary) {
    const fallback = vnode.props.fallback as
      | ((e: Error) => VNode | string | number | null)
      | undefined;
    try {
      return _regionSync(vnode, nodes);
    } catch (error) {
      if (!fallback) throw error;
      return _renderSync(fallback(error as Error), nodes);
    }
  }
  // Element
  nodes.n++;
  const tag = vnode.tag as string;
  const selfClosing = VOID_ELEMENTS.has(tag);
  let html = `<${tag}${_renderProps(vnode.props, tag)}>`;
  if (selfClosing) return html;
  const areaText = _ssrTextareaText(vnode);
  if (_hasRawHtml(vnode.props)) {
    html += (vnode.props.dangerouslySetInnerHTML as { __html: string }).__html;
  } else if (areaText !== null) html += areaText;
  else {
    const inner: SsrNodes = { n: 0 };
    for (const child of vnode.children) html += _renderSync(child, inner);
  }
  html += `</${tag}>`;
  return html;
}

function _regionSync(vnode: VNode, nodes: SsrNodes): string {
  const inner: SsrNodes = { n: 0 };
  const html = vnode.children.map((c) => _renderSync(c, inner)).join("");
  nodes.n++;
  return _regionHtml(html, inner.n);
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
  yield* _stream(vnode);
}

/** Buffer a region's children: the chunks, and how many nodes they stand for
 *  — a region can only know it is empty once every child has produced
 *  nothing (see `_regionHtml`), so it cannot stream child-by-child. */
async function _bufferRegion(
  vnode: VNode,
): Promise<{ chunks: string[]; nodes: number }> {
  const chunks: string[] = [];
  let nodes = 0;
  for (const child of vnode.children) {
    const gen = _stream(child);
    for (;;) {
      const r = await gen.next();
      if (r.done) {
        nodes += r.value;
        break;
      }
      chunks.push(r.value);
    }
  }
  return { chunks, nodes };
}

/** The recursive streamer behind `renderToStream`. Its RETURN value is the
 *  number of DOM nodes the yielded markup stands for (see `_regionHtml`). */
async function* _stream(
  vnode: VNode | string | number | null,
): AsyncGenerator<string, number, unknown> {
  if (vnode == null) return 0;
  if (typeof vnode === "string") {
    yield _escapeHtml(vnode);
    return 1;
  }
  if (typeof vnode === "number") {
    yield String(vnode);
    return 1;
  }
  const bad = _notANode(vnode);
  if (bad) throw new Error(bad);

  // Component
  if (typeof vnode.tag === "function") {
    // A throw here — a lazy's `_LAZY_PENDING` included — propagates to the
    // enclosing Suspense/ErrorBoundary, which buffers exactly for that.
    const rendered = (vnode.tag as ComponentFn)({
      ...vnode.props,
      children: vnode.children.length > 0
        ? vnode.children
        : (vnode.props.children ?? vnode.children),
    });
    if (rendered == null) {
      // Same rule as the sync path above and as renderToString.
      yield "<!---->";
      return 1;
    }
    return yield* _stream(rendered);
  }

  // Portal — skip
  if (vnode.tag === Portal) return 0;

  // Null placeholder (AIO-107)
  if (vnode.tag === Symbol.for("aio.Null")) {
    yield "<!---->";
    return 1;
  }

  // Signal child — its current value, as the text the client will bind.
  if (vnode.tag === _SignalText) {
    yield _escapeHtml(_sigText((vnode._sig as Signal<unknown>).peek()));
    return 1;
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
    let region: { chunks: string[]; nodes: number };
    try {
      region = await _bufferRegion(vnode);
    } catch (thrown) {
      if (thrown !== _LAZY_PENDING) throw thrown;
      const nodes: SsrNodes = { n: 0 };
      const html = _renderSync(fallback ?? null, nodes);
      if (html !== "") yield html;
      return nodes.n;
    }
    // Same empty-region anchor as Fragment (AIO-195) — a boundary is a region
    // of its parent too, and must hold its slot.
    yield* _yieldRegion(region);
    return 1;
  }

  // Fragment
  if (vnode.tag === Fragment) {
    // Buffered, not streamed child-by-child: an empty Fragment must emit its
    // comment anchor (AIO-195 parity), which is only knowable once every child
    // has produced nothing.
    yield* _yieldRegion(await _bufferRegion(vnode));
    return 1;
  }

  // ErrorBoundary — buffer children first; yield* inside try would leak partial
  // HTML before the fallback (same pattern as Suspense above, AIO-215).
  if (vnode.tag === ErrorBoundary) {
    const fallback = vnode.props.fallback as
      | ((e: Error) => VNode | string | number | null)
      | undefined;
    let region: { chunks: string[]; nodes: number };
    try {
      region = await _bufferRegion(vnode);
    } catch (error) {
      if (!fallback) throw error;
      const nodes: SsrNodes = { n: 0 };
      const html = _renderSync(fallback(error as Error), nodes);
      if (html !== "") yield html;
      return nodes.n;
    }
    yield* _yieldRegion(region);
    return 1;
  }

  // Element — yield opening tag, children, closing tag
  const tag = vnode.tag as string;
  const selfClosing = VOID_ELEMENTS.has(tag);
  yield `<${tag}${_renderProps(vnode.props, tag)}>`;
  if (selfClosing) return 1;
  const areaText = _ssrTextareaText(vnode);
  if (_hasRawHtml(vnode.props)) {
    yield (vnode.props.dangerouslySetInnerHTML as { __html: string }).__html;
  } else if (areaText !== null) yield areaText;
  else for (const child of vnode.children) yield* _stream(child);
  yield `</${tag}>`;
  return 1;
}

/** Yield a buffered region — its chunks, or the anchor when it holds no node. */
function* _yieldRegion(
  region: { chunks: string[]; nodes: number },
): Generator<string, void, unknown> {
  if (region.nodes === 0) yield _regionHtml("", 0);
  else for (const c of region.chunks) yield c;
}
