// renderer-hydrate.ts — SSR hydration: attach to existing server-rendered DOM.
// Provides: hydrate, _hydrateNode, _hydrateProps.

import { batch } from "../state/signal.ts";
import {
  bindSignalProps,
  cleanupSignalBindings,
  isSignal,
} from "./signal-binding.ts";
import { _writeProp } from "./prop-write.ts";
import { _DOM_PROPS } from "./vdom-types.ts";
import type { ComponentFn, RenderCtx, VNode } from "./vdom.ts";
import {
  _applyActions,
  _bindSignalTextChildren,
  _callRef,
  _cleanupSignalTextChildren,
  _ensureDelegation,
  _isDelegated,
  _LAZY_PENDING,
  _mapEventName,
  _render,
  _setDelegationRoot,
  _setWrapped,
  ErrorBoundary,
  Fragment,
  getDom,
  h,
  Suspense,
  SVG_TAGS,
} from "./vdom.ts";
import { _registerLazyListeners } from "./vdom-create.ts";
import { _cleanupActions } from "./vdom-helpers.ts";
import { applyChildDependentProps } from "./vdom-props.ts";
import { _devWarn } from "./vdom-types.ts";
import { _getExitHandler } from "./transition-component.ts";
import { _getGroupExitHandler } from "./transition-group.ts";
import type { MountHandle, RootState } from "./renderer-types.ts";
import {
  _activeRoot,
  _registerRoot,
  _setActiveRoot,
} from "./renderer-state.ts";
import {
  _flushAfterRender,
  _flushPending,
  _rerenderRoot,
} from "./renderer-flush.ts";
import { _createHooks } from "./renderer-rerender.ts";

// deno-lint-ignore no-explicit-any
type AnyDoc = any;

// _doc is kept local to hydrate — the aio-renderer.ts orchestrator sets it via _setDocument
// which is also the setter used by mount. Both share the same _doc via aio-renderer.ts.
let _doc: AnyDoc = typeof globalThis !== "undefined" && "document" in globalThis
  // deno-lint-ignore no-explicit-any
  ? (globalThis as any).document
  : null;

export function _setHydrateDoc(doc: AnyDoc): void {
  _doc = doc;
}

/**
 * Attach to existing server-rendered DOM without re-creating elements.
 * Walks the VNode tree and existing DOM in parallel, attaching _dom
 * references and event listeners. Falls back to full render on mismatch.
 */
// deno-lint-ignore no-explicit-any
export function hydrate(root: any, App: ComponentFn): MountHandle {
  const state: RootState = {
    root,
    vnode: null,
    disposed: false,
    ctx: { doc: _doc },
    pendingComponents: new Set(),
    flushScheduled: false,
    App,
    afterRenderQueue: [],
    _idCounter: 0,
    _renderCounts: new Map(),
  };

  const handle: MountHandle = {
    _flush() {
      if (state.disposed) return;
      _flushPending(state);
    },
  };

  _registerRoot(handle, state);
  state.ctx.hooks = _createHooks(state);
  state.ctx.onLazyResolve = () => {
    if (state.disposed) return;
    _rerenderRoot(state);
  };
  state.ctx.onBeforeRemove = (el) => {
    const inner = _getExitHandler(el);
    const outer = _getGroupExitHandler(el);
    if (inner && outer) {
      return Promise.all([inner(el), outer(el)]).then(() => {});
    }
    const handler = inner ?? outer;
    return handler ? handler(el) : undefined;
  };

  _setActiveRoot(state);
  _setDelegationRoot(root);
  try {
    const vnode = h(App, null);
    const consumed = _hydrateNode(root, vnode, state.ctx, false, 0);
    if (consumed < 0) {
      // Recovery is correct but INVISIBLE, and it throws away everything SSR
      // was for: the page is re-created from scratch on the client, losing the
      // server markup, the paint that was already on screen, and any DOM state
      // in it. Silently degrading a documented feature to nothing is the worst
      // outcome — say so in dev, where it can still be fixed.
      _devWarn(
        "hydrate-mismatch",
        `hydrate() found DOM that does not match the component tree and fell ` +
          `back to a full client render — the server HTML was discarded. The ` +
          `usual cause is markup that differs between server and client ` +
          `(Date/random/window in render), or two ADJACENT text children: ` +
          `HTML parsing merges them into one text node, which cannot be ` +
          `hydrated as two.`,
      );
      // Hydration mismatch — release the signal-binding effects, signal-text
      // bindings, and action cleanups created for elements hydrated before the
      // mismatch. Without this, those effects stay alive and keep mutating DOM
      // nodes that innerHTML="" is about to detach (leak + stale writes).
      cleanupSignalBindings(root);
      _cleanupSignalTextChildren(root);
      if (typeof (root as HTMLElement).setAttribute === "function") {
        _cleanupActions(root as HTMLElement);
      }
      for (const el of root.querySelectorAll("*")) {
        cleanupSignalBindings(el);
        _cleanupSignalTextChildren(el);
        if (typeof (el as HTMLElement).setAttribute === "function") {
          _cleanupActions(el as HTMLElement);
        }
      }
      root.innerHTML = "";
      _render(root, vnode, null, state.ctx);
    }
    state.vnode = vnode;
    _flushAfterRender(state);
  } finally {
    _setActiveRoot(null);
    _setDelegationRoot(null);
  }

  return handle;
}

/**
 * Hydrate a single VNode against existing DOM.
 * Returns the number of DOM nodes consumed (>= 0) on success, or -1 on failure.
 * AIO-92: Fragments/components can consume N DOM nodes, not always 1.
 */
export function _hydrateNode(
  parent: Node,
  vnode: VNode | string | number,
  ctx: RenderCtx,
  isSvg: boolean,
  childIndex: number,
): number {
  if (typeof vnode === "string" || typeof vnode === "number") {
    const want = String(vnode);
    const domNode = parent.childNodes[childIndex];
    // Two text children are two nodes in the client tree but ONE node in parsed
    // HTML — the parser merges adjacent character data, and `renderToString`
    // has no separator to stop it. That made `{"Hello "}{name}` — the single
    // most ordinary thing a template does — unhydratable: the second child
    // found no node of its own, the whole tree reported a mismatch, and
    // `hydrate()` threw the server HTML away and re-rendered the page from
    // scratch (a dev warning, and in prod nothing at all).
    //
    // The merge is undone HERE, where the boundary is known exactly: the vnode
    // says how much of the run belongs to this child, so the node is split at
    // that offset and the remainder is left for the next child. One decider —
    // the SSR writer keeps emitting plain text, and nothing about the wire
    // format changes.
    if (!domNode || domNode.nodeType !== 3) {
      // SSR emits NOTHING for an empty text child while `createDom` makes an
      // empty text node, so the client tree has a slot the markup does not.
      // Materialize it rather than failing the whole tree.
      if (want !== "") return -1;
      const empty = (parent.ownerDocument ?? document).createTextNode("");
      if (domNode) parent.insertBefore(empty, domNode);
      else parent.appendChild(empty);
      return 1;
    }
    const have = domNode.textContent ?? "";
    if (have !== want) {
      if (have.length > want.length && have.startsWith(want)) {
        (domNode as Text).splitText(want.length);
      } else {
        domNode.textContent = want;
      }
    }
    return 1;
  }

  // Null placeholder — consume 1 comment node (AIO-107)
  if (vnode.tag === Symbol.for("aio.Null") as typeof vnode.tag) {
    const domNode = parent.childNodes[childIndex];
    if (domNode && domNode.nodeType === 8) {
      vnode._dom = domNode;
      return 1;
    }
    const comment = (parent.ownerDocument ?? document).createComment("");
    const anchor = parent.childNodes[childIndex];
    if (anchor) parent.insertBefore(comment, anchor);
    else parent.appendChild(comment);
    vnode._dom = comment;
    return 1;
  }

  // Component — consume whatever the rendered output consumes
  if (typeof vnode.tag === "function") {
    const hookState = ctx.hooks?.beforeComponent(vnode, null, parent, isSvg);
    let rendered: VNode | string | number | null;
    try {
      rendered = (vnode.tag as ComponentFn)({
        ...vnode.props,
        children: vnode.children.length > 0
          ? vnode.children
          : (vnode.props.children ?? vnode.children),
      });
    } catch (e) {
      ctx.hooks?.abortComponent?.(vnode, hookState);
      throw e;
    }
    vnode._rendered = rendered;
    ctx.hooks?.afterComponent(vnode, rendered, hookState);
    if (rendered == null) {
      ctx.hooks?.afterSubtree?.(vnode);
      return 0;
    }
    const count = _hydrateNode(parent, rendered, ctx, isSvg, childIndex);
    if (count >= 0) vnode._dom = getDom(rendered) ?? undefined;
    ctx.hooks?.afterSubtree?.(vnode);
    return count;
  }

  // Portal — consumes 0 DOM nodes (renders elsewhere)
  if (vnode.tag === Symbol.for("aio.Portal") as typeof vnode.tag) {
    return 0;
  }

  // ErrorBoundary / Suspense / Fragment — children inline in parent DOM
  const isFragment = vnode.tag === Fragment;
  const isBoundary = vnode.tag === ErrorBoundary;
  const isSuspense = vnode.tag === Suspense;
  if (isFragment || isBoundary || isSuspense) {
    let idx = childIndex;
    try {
      for (const child of vnode.children) {
        const consumed = _hydrateNode(parent, child, ctx, isSvg, idx);
        if (consumed < 0) return -1;
        idx += consumed;
      }
    } catch (thrown) {
      // `createDom` and `renderToString` both catch here; hydrate did not, so a
      // boundary that WORKS on the server and WORKS on a client mount let the
      // error escape `hydrate()` on the one path that matters most. The server
      // had already rendered the fallback, the page looked fine — and the app
      // never booted: no handlers, no updates, a dead screenshot of itself.
      // The markup at `childIndex` IS the fallback, so it is hydrated in place.
      const claimFallback = (
        fb: VNode | string | number | null,
      ): number => {
        vnode._rendered = fb;
        if (fb == null) return 0;
        const n = _hydrateNode(parent, fb, ctx, isSvg, childIndex);
        if (n >= 0) {
          vnode._dom = getDom(fb) ?? parent.childNodes[childIndex] ?? undefined;
        }
        return n;
      };
      if (isSuspense && thrown === _LAZY_PENDING) {
        _registerLazyListeners(vnode.children, ctx);
        return claimFallback(
          (vnode.props.fallback as VNode | string | number | null) ?? null,
        );
      }
      // A lazy child inside an ErrorBoundary belongs to the enclosing Suspense.
      if (isBoundary && thrown !== _LAZY_PENDING) {
        const fallback = vnode.props.fallback as
          | ((e: Error) => VNode | string | number | null)
          | undefined;
        if (fallback) return claimFallback(fallback(thrown as Error));
      }
      throw thrown;
    }
    if (idx === childIndex) {
      // An empty Fragment / ErrorBoundary / Suspense occupies a comment ANCHOR
      // (AIO-195) — createDom makes one and the SSR writers emit one, so
      // hydration must claim it. Without a `_dom` the container has no position,
      // and the next diff anchored its whole region at the parent's first child.
      const domNode = parent.childNodes[childIndex];
      if (domNode && domNode.nodeType === 8) {
        vnode._dom = domNode;
        return 1;
      }
      const comment = (parent.ownerDocument ?? document).createComment("");
      if (domNode) parent.insertBefore(comment, domNode);
      else parent.appendChild(comment);
      vnode._dom = comment;
      return 1;
    }
    // The region's first node — `parent.childNodes[childIndex]` by definition.
    // Scanning children for the first one carrying a `_dom` (AIO-256) SKIPS
    // leading bare text, whose node nothing tracks, so a fragment that starts
    // with text anchored one node too late.
    if (idx > childIndex) {
      vnode._dom = parent.childNodes[childIndex] ?? undefined;
    }
    return idx - childIndex;
  }

  // Element — consume exactly 1 DOM node, hydrate children inside it
  const domNode = parent.childNodes[childIndex];
  if (!domNode || domNode.nodeType !== 1) return -1;
  const el = domNode as HTMLElement;
  if (el.tagName.toLowerCase() !== (vnode.tag as string).toLowerCase()) {
    return -1;
  }

  vnode._dom = el;
  _hydrateProps(el, vnode.props);

  const nowSvg = isSvg || SVG_TAGS.has(el.tagName.toLowerCase());
  let childIdx = 0;
  for (let i = 0; i < vnode.children.length; i++) {
    const consumed = _hydrateNode(
      el,
      vnode.children[i]!,
      ctx,
      nowSvg,
      childIdx,
    );
    if (consumed < 0) return -1;
    childIdx += consumed;
  }

  // AIO-249: bind signal text children during hydration
  if (vnode._signalChildren) {
    _bindSignalTextChildren(el, vnode._signalChildren);
  }

  // `<select value>` selects an <option>, so it can only be written once the
  // options are hydrated — and SSR cannot express it in markup at all (`value`
  // is not a <select> attribute). Without this a server-rendered controlled
  // select showed its FIRST option no matter what the state said.
  applyChildDependentProps(el, vnode.props, {});

  return 1;
}

/** Apply event listeners, signal bindings, and refs during hydration (attrs already set). */
function _hydrateProps(el: HTMLElement, props: Record<string, unknown>): void {
  // AIO-166: detect onChange+onInput collision on form elements
  const _isFormEl = el.tagName === "INPUT" || el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT";
  const _hasOnInput = "onInput" in props && _isFormEl;
  for (const [k, v] of Object.entries(props)) {
    if (k === "key" || k === "children" || k === "ref" || k === "use") continue;
    if (k.startsWith("on") && typeof v === "function") {
      const evt = _mapEventName(
        k.slice(2).toLowerCase(),
        el,
        k === "onChange" ? _hasOnInput : undefined,
      );
      const handler = v as EventListener;
      const wrapped = ((e: Event) => batch(() => handler(e))) as EventListener;
      if (_isDelegated(evt) && _activeRoot) {
        _ensureDelegation(_activeRoot.root, evt);
        _setWrapped(el, evt, wrapped);
      } else {
        el.addEventListener(evt, wrapped);
        _setWrapped(el, evt, wrapped);
      }
    }
  }
  // Form state is a DOM PROPERTY, and not every property has a content
  // attribute for the markup to carry (`indeterminate` has none at all). The
  // parser only infers `.value`/`.checked` from the attributes it recognizes,
  // and hydration never ran `applyProps`, so anything markup could not express
  // was simply never applied: the control came up in a state the vnode tree
  // does not describe and no later render fixed it (the diff compares the new
  // props against the old ones and skips what did not change). `_writeProp` is
  // the same decider the mount path uses.
  for (const [k, v] of Object.entries(props)) {
    if (!_DOM_PROPS.has(k) || !(k in el) || isSignal(v)) continue;
    // `<select>.value` needs its <option>s — applyChildDependentProps owns it
    // and runs after the children are hydrated.
    if (k === "value" && el.tagName === "SELECT") continue;
    _writeProp(el, k, v);
  }
  bindSignalProps(el, props);
  if (props.ref) _callRef(props.ref, el, el.tagName?.toLowerCase());
  // AIO-89: apply action directives
  if (props.use) _applyActions(el, props.use);
}
