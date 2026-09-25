// Streaming SSR — async generator that yields HTML chunks.

import type { VNode } from "./vdom.ts";
import {
  _enterSsr,
  _exitSsr,
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
import {
  escapeHtml as _escapeHtml,
  keepLeadingNewline,
  RAW_TEXT_ELEMENTS,
  rawTextContent,
  ssrCloseSelect,
  ssrOpenSelect,
  ssrOptionProps,
  VOID_ELEMENTS,
} from "./ssr-utils.ts";
import { isDevMode } from "../state/dev-flag.ts";
import { resolveSignalProp } from "./signal-binding.ts";
// The attribute rule and the empty-region rule are shared with renderToString
// — see _renderPropsHtml and _regionHtml.
import {
  _ssrRenderBindKey,
  _ssrRenderFinish,
  _ssrRenderNew,
  _ssrRenderOf,
  _ssrRenderStart,
  type SsrRender,
  type SsrRoute,
} from "./ssr-render.ts";
import {
  _fallbackHtml,
  _inSsrCall,
  _regionHtml,
  _renderPropsHtml as _renderProps,
  _ssrComponent,
  _ssrExplicitScope,
  _ssrIn,
  _ssrRootEpoch,
  _ssrRootScope,
  _ssrRouteAtCall,
  _ssrRouteNow,
  _ssrRouteOf,
  _ssrScoped,
  _ssrStreamSettler,
  _ssrTextareaText,
  type SsrContexts,
  type SsrNodes,
} from "./vdom-ssr.ts";

const _LAZY_PENDING = Symbol.for("aio.LazyPending");

/** Render sync (for fallbacks and simple content). `nodes` counts the DOM
 *  nodes the markup stands for (see `_regionHtml`). */
function _renderSync(
  vnode: VNode | string | number | null,
  nodes: SsrNodes,
  scope: SsrContexts,
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
    const { out: rendered, scope: inner } = _ssrComponent(vnode, scope);
    // Nothing to render is still a POSITION — identical to renderToString, or
    // the stream and the string renderer ship different markup for the same
    // tree (the differential gate catches exactly that). See nullSlot().
    if (rendered == null) {
      nodes.n++;
      return "<!---->";
    }
    return _renderSync(rendered, nodes, inner);
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
      return _regionSync(vnode, nodes, scope);
    } catch (thrown) {
      if (thrown !== _LAZY_PENDING) throw thrown;
      return _fallbackHtml(
        fallback,
        nodes,
        (v, n) => _renderSync(v, n, scope),
      );
    }
  }
  // AIO-195 parity with createDom/renderToString: an empty Fragment holds
  // its slot with a comment anchor. Streamed HTML that omits it hydrates
  // into a Fragment with no position (see vdom-ssr.ts).
  if (vnode.tag === Fragment) return _regionSync(vnode, nodes, scope);
  if (vnode.tag === ErrorBoundary) {
    const fallback = vnode.props.fallback as
      | ((e: Error) => VNode | string | number | null)
      | undefined;
    try {
      return _regionSync(vnode, nodes, scope);
    } catch (error) {
      if (!fallback) throw error;
      const fb = _ssrScoped(scope, () => fallback(error as Error));
      return _fallbackHtml(
        fb.out,
        nodes,
        (v, n) => _renderSync(v, n, fb.scope),
      );
    }
  }
  // Element
  nodes.n++;
  const tag = vnode.tag as string;
  const selfClosing = VOID_ELEMENTS.has(tag);
  const ownValue = resolveSignalProp(
    vnode.props.value ?? vnode.props.defaultValue,
  );
  const render = _ssrRenderOf(scope);
  const props = ssrOptionProps(
    render,
    tag,
    vnode.props,
    vnode.children,
    ownValue,
  );
  let html = `<${tag}${_renderProps(props, tag)}>`;
  if (selfClosing) return html;
  const areaText = _ssrTextareaText(vnode);
  const inSelect = ssrOpenSelect(render, tag, ownValue);
  const start = html.length;
  try {
    if (_hasRawHtml(vnode.props)) {
      html += (vnode.props.dangerouslySetInnerHTML as { __html: string })
        .__html;
    } else if (areaText !== null) html += areaText;
    else if (RAW_TEXT_ELEMENTS.has(tag)) {
      const inner: SsrNodes = { n: 0 };
      for (const child of vnode.children) {
        html += typeof child === "string" || typeof child === "number"
          ? (inner.n++, rawTextContent(tag, String(child), isDevMode()))
          : _renderSync(child, inner, scope);
      }
    } else {
      const inner: SsrNodes = { n: 0 };
      for (const child of vnode.children) {
        html += _renderSync(child, inner, scope);
      }
    }
  } finally {
    ssrCloseSelect(render, inSelect);
  }
  html = html.slice(0, start) + keepLeadingNewline(tag, html.slice(start));
  html += `</${tag}>`;
  return html;
}

function _regionSync(
  vnode: VNode,
  nodes: SsrNodes,
  scope: SsrContexts,
): string {
  const inner: SsrNodes = { n: 0 };
  const html = vnode.children.map((c) => _renderSync(c, inner, scope)).join(
    "",
  );
  nodes.n++;
  return _regionHtml(html, inner.n);
}

/**
 * Streaming SSR — async generator yielding HTML chunks.
 * Renders elements by yielding opening tag, then children, then closing tag.
 * Suspense boundaries with lazy children yield fallback content.
 *
 * Every top-level stream renders in state of its OWN — its `useId` sequence,
 * the `<head>` its components ask for, the `<select>` scopes it opens — so two
 * responses being written at once can neither read nor reset each other's. See
 * air/ssr-render.ts for what that used to cost.
 *
 * @param key Anything that identifies THIS response — the `Request` is the
 * natural one. Pass the same object to {@linkcode collectHead} and you get
 * exactly this render's head back, however many other renders overlapped it.
 * Omitted, nothing changes: the render is still its own, and `collectHead()`
 * answers for the most recent one.
 *
 * @param opts `opts.route` (and `opts.search`) route this render explicitly —
 * the concurrency-safe form: every route read in it, nested renders and later
 * pulls included, sees that route; the global `routePath` / `routeSearch` are
 * never written and never rendered from (a read still subscribes to them).
 * Omitted, it routes by the globals (1.x).
 */
export function renderToStream(
  vnode: VNode | string | number | null,
  key?: object,
  opts?: { route?: string; search?: URLSearchParams },
): AsyncGenerator<string, void, unknown> {
  // The ROUTE is taken NOW, before the first pull, while the handler that
  // called this is still the one running. As an `async function*` it waited
  // for the first `next()` — and a handler that awaited anything before
  // handing the body over (a session read, a log line) let the next request's
  // `routePath.set()` win: measured, 200 of 200 overlapping pairs served the
  // other visitor's page, keyed head or not.
  //
  // Only the route moved. Whether the stream is NESTED in an enclosing page,
  // and the key it answers to, are still settled at the first pull, as in
  // 1.0.9: a stream created inside a server component and read after that
  // page ended is its own render (its own `useId` sequence, its own keyed
  // head) exactly as before. A call made inside a component call takes no
  // snapshot at all — it can only be the enclosing page's or, read later, a
  // render of its own that reads the route at its first pull, as 1.0.9 did.
  //
  // Caller-invisible otherwise: whatever the eager part throws (a route
  // snapshot that throws) is thrown from the FIRST PULL, exactly where the
  // generator function threw it — never at the call.
  try {
    // `renderToString(v, { route })` takes its options second; the natural
    // slip here puts them in the KEY slot, where they would name the head
    // and route nothing — the global route, silently. Refused.
    if (
      opts === undefined && key !== null && typeof key === "object" &&
      (Object.getPrototypeOf(key) === Object.prototype ||
        Object.getPrototypeOf(key) === null) &&
      (Object.hasOwn(key, "route") || Object.hasOwn(key, "search"))
    ) {
      throw new TypeError(
        "[aio] renderToStream: options are the 3rd argument " +
          "(renderToStream(vnode, key, { route })) — the 2nd is the key " +
          "collectHead(key) answers for; pass `undefined` if you have none",
      );
    }
    const route = _ssrRouteOf(opts);
    // Inside a component call: its own route, or the enclosing render's
    // explicit one — kept for a pull that comes after that page ended.
    if (_inSsrCall()) {
      return _renderStream(vnode, key, null, route ?? _ssrRouteNow());
    }
    const render = _ssrRenderNew("stream");
    if (route) {
      // Nothing to snapshot, nothing to settle: the route is the caller's.
      const scope = _ssrExplicitScope(render, route);
      return _renderStream(vnode, key, { render, settle: () => scope }, route);
    }
    _ssrRouteAtCall(render);
    const scope = _ssrRootScope(render);
    const settle = _ssrStreamSettler(scope, _ssrRootEpoch(), new Error());
    return _renderStream(vnode, key, { render, settle }, null);
  } catch (e) {
    return _failedStream(e);
  }
}

/** A stream whose set-up threw: the error, at the first pull. */
// deno-lint-ignore require-yield
async function* _failedStream(
  e: unknown,
): AsyncGenerator<string, void, unknown> {
  throw e;
}

/** The body of {@linkcode renderToStream}: runs from the first pull on.
 *  `early` is the top-level set-up taken at the call; null for a call made
 *  inside a component call, which is settled here exactly as 1.0.9 did. */
async function* _renderStream(
  vnode: VNode | string | number | null,
  key: object | undefined,
  early: { render: SsrRender; settle: (pull: boolean) => SsrContexts } | null,
  route: SsrRoute | null,
): AsyncGenerator<string, void, unknown> {
  // Pulled from inside a server component call, a stream is part of the
  // enclosing page (1.0.9's rule, decided here and nowhere else).
  const nested = _inSsrCall();
  const render = early && !nested ? early.render : _ssrRenderNew("stream");
  if (key) _ssrRenderBindKey(key, render);
  // The request values this page renders with: the call's, plus any write in
  // the call's own synchronous turn (1.0.9's create-then-set) — never later.
  const scope = early && !nested
    ? early.settle(true)
    : route
    ? _ssrExplicitScope(render, route)
    : _ssrRootScope(render);
  const isTopLevel = _ssrRenderOf(scope) === render;
  // A stream created inside a component call and read after that page ended
  // is its own render, set up here: its route check is taken here too.
  if (isTopLevel && render !== early?.render && !route) _ssrRouteAtCall(render);
  if (isTopLevel) _ssrRenderStart(render);
  // SAY that a server render is in progress, for the whole stream. Every hook
  // that asks `_isSsrRendering()` took the client branch here, because only
  // `renderToString` had ever set the flag — see `_enterSsr`.
  _enterSsr();
  // RETURNED by its consumer (the client went away) is the one way to reach
  // `finally` without finishing or throwing — see `_ssrRenderFinish` for why
  // the head cares.
  let returned = true;
  try {
    yield* _stream(vnode, scope);
    returned = false;
  } catch (e) {
    returned = false;
    throw e;
  } finally {
    _exitSsr();
    if (isTopLevel) _ssrRenderFinish(render, returned);
  }
}

/** Buffer a region's children: the chunks, and how many nodes they stand for
 *  — a region can only know it is empty once every child has produced
 *  nothing (see `_regionHtml`), so it cannot stream child-by-child. */
async function _bufferRegion(
  vnode: VNode,
  scope: SsrContexts,
): Promise<{ chunks: string[]; nodes: number }> {
  const chunks: string[] = [];
  let nodes = 0;
  for (const child of vnode.children) {
    const gen = _stream(child, scope);
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
  scope: SsrContexts,
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
    const { out: rendered, scope: inner } = _ssrComponent(vnode, scope);
    if (rendered == null) {
      // Same rule as the sync path above and as renderToString.
      yield "<!---->";
      return 1;
    }
    return yield* _stream(rendered, inner);
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
    yield _ssrIn(
      scope,
      () => _escapeHtml(_sigText((vnode._sig as Signal<unknown>).peek())),
    );
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
      region = await _bufferRegion(vnode, scope);
    } catch (thrown) {
      if (thrown !== _LAZY_PENDING) throw thrown;
      const nodes: SsrNodes = { n: 0 };
      const html = _ssrIn(scope, () =>
        _fallbackHtml(
          fallback,
          nodes,
          (v, n) => _renderSync(v, n, scope),
        ));
      if (html !== "") yield html;
      return nodes.n;
    }
    // Same empty-region anchor as Fragment (AIO-195) — a boundary is a region
    // of its parent too, and must hold its slot.
    yield* _yieldRegion(region);
    return 1;
  }

  // Fragment — streamed, holding back only until it is known to be non-empty.
  // Stream a Fragment's children, holding chunks back only until the region
  // is known to hold a node — then everything held is released and the rest
  // streams as it is rendered. Returns the region's node count (always 1: its
  // content or its anchor, see `_regionHtml`).
  //
  // It used to buffer the WHOLE region, because an empty Fragment must emit
  // its comment anchor (AIO-195 parity) and emptiness is only certain at the
  // end. But a Provider renders a Fragment, so a page under a root Provider —
  // the ordinary way to give an app its context — was computed in ONE pull:
  // `renderToStream` streamed nothing at all, in silence, and two requests
  // never interleaved. Measured by the SSR soak, whose first page shape had a
  // root Provider and could not see a shared `<select>` stack in 40 rounds.
  //
  // What makes early release safe: every writer path that yields NON-EMPTY
  // markup counts at least one node for it (an element, a text, a `<!---->`
  // slot, a fallback), so the first non-empty chunk proves the region is not
  // empty. A child that yields only `""` (an empty text is still one node) is
  // settled by its returned count instead.
  //
  // Written here, not in a helper generator: a `yield* helper()` is one more
  // async level that every chunk of the region passes through — measured,
  // a Fragment then cost ~1.3x an element per nesting level.
  if (vnode.tag === Fragment) {
    const held: string[] = [];
    let live = false;
    let nodes = 0;
    for (const child of vnode.children) {
      if (live) {
        yield* _stream(child, scope);
        continue;
      }
      const gen = _stream(child, scope);
      let done = false;
      try {
        for (;;) {
          const r = await gen.next();
          if (r.done) {
            nodes += r.value;
            done = true;
            break;
          }
          held.push(r.value);
          if (r.value !== "") {
            live = true;
            yield* _drainHeld(held);
            break;
          }
        }
        // Live mid-child: DELEGATE the rest of it. A hand-written
        // next()/yield loop costs an extra await per chunk per enclosing
        // Fragment, and a Fragment's first child is on that path for its whole
        // length. `yield*` also closes the child itself when the consumer
        // returns.
        if (!done) {
          nodes += yield* gen;
          done = true;
        }
      } finally {
        // Returned while the held chunks were being released (the client went
        // away): close the child too, so its own `finally` blocks run — its
        // `<select>` scope among them.
        if (!done) await gen.return(0);
      }
      if (!live && nodes > 0) {
        live = true;
        yield* _drainHeld(held);
      }
    }
    if (!live) yield _regionHtml("", 0);
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
      region = await _bufferRegion(vnode, scope);
    } catch (error) {
      if (!fallback) throw error;
      const nodes: SsrNodes = { n: 0 };
      const fb = _ssrScoped(scope, () => fallback(error as Error));
      const html = _ssrIn(fb.scope, () =>
        _fallbackHtml(
          fb.out,
          nodes,
          (v, n) => _renderSync(v, n, fb.scope),
        ));
      if (html !== "") yield html;
      return nodes.n;
    }
    yield* _yieldRegion(region);
    return 1;
  }

  // Element — yield opening tag, children, closing tag
  const tag = vnode.tag as string;
  const selfClosing = VOID_ELEMENTS.has(tag);
  const render = _ssrRenderOf(scope);
  // Every signal the element reads (its value, its attributes, a textarea's
  // text) is read in the render's route — before the yield, never across it.
  const { ownValue, open, areaText } = _ssrIn(scope, () => {
    const ownValue = resolveSignalProp(
      vnode.props.value ?? vnode.props.defaultValue,
    );
    return {
      ownValue,
      open: `<${tag}${
        _renderProps(
          ssrOptionProps(render, tag, vnode.props, vnode.children, ownValue),
          tag,
        )
      }>`,
      areaText: selfClosing ? null : _ssrTextareaText(vnode),
    };
  });
  yield open;
  if (selfClosing) return 1;
  const inSelect = ssrOpenSelect(render, tag, ownValue);
  try {
    if (_hasRawHtml(vnode.props)) {
      yield (vnode.props.dangerouslySetInnerHTML as { __html: string }).__html;
    } else if (areaText !== null) yield keepLeadingNewline(tag, areaText);
    else if (RAW_TEXT_ELEMENTS.has(tag)) {
      for (const child of vnode.children) {
        if (typeof child === "string" || typeof child === "number") {
          yield rawTextContent(tag, String(child), isDevMode());
        } else yield* _stream(child, scope);
      }
    } else if (tag === "pre" || tag === "listing") {
      yield* _keepLeadingNewline(tag, vnode.children, scope);
    } else for (const child of vnode.children) yield* _stream(child, scope);
  } finally {
    ssrCloseSelect(render, inSelect);
  }
  yield `</${tag}>`;
  return 1;
}

/** A `<pre>`'s children with `keepLeadingNewline` applied to the first
 *  non-empty chunk — the only one that can start the element's text. */
async function* _keepLeadingNewline(
  tag: string,
  children: VNode["children"],
  scope: SsrContexts,
): AsyncGenerator<string, void, unknown> {
  let first = true;
  for (const child of children) {
    for await (const chunk of _stream(child, scope)) {
      if (first && chunk !== "") {
        first = false;
        yield keepLeadingNewline(tag, chunk);
      } else yield chunk;
    }
  }
}

/** Yield what a region held back, and empty it. Module-level on purpose: a
 *  generator function created per region is a new closure and prototype per
 *  Fragment — measured on the 10k-node Provider page, ~3% slower and no heap
 *  difference; not worth it for nothing. */
function* _drainHeld(held: string[]): Generator<string, void, unknown> {
  for (const c of held) yield c;
  held.length = 0;
}

/** Yield a buffered region — its chunks, or the anchor when it holds no node. */
function* _yieldRegion(
  region: { chunks: string[]; nodes: number },
): Generator<string, void, unknown> {
  if (region.nodes === 0) yield _regionHtml("", 0);
  else for (const c of region.chunks) yield c;
}
