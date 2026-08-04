// renderer-hydrate.ts — SSR hydration: attach to existing server-rendered DOM.
// Provides: hydrate, _hydrateNode, _hydrateProps.

import { batch } from "../state/signal.ts";
import { bindSignalProps, cleanupSignalBindings } from "./signal-binding.ts";
import type { ComponentFn, RenderCtx, VNode } from "./vdom.ts";
import {
  _applyActions,
  _bindSignalTextChildren,
  _callRef,
  _cleanupSignalTextChildren,
  _ensureDelegation,
  _isDelegated,
  _mapEventName,
  _render,
  _setDelegationRoot,
  _setWrapped,
  getDom,
  h,
  SVG_TAGS,
} from "./vdom.ts";
import { _cleanupActions } from "./vdom-helpers.ts";
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
    const domNode = parent.childNodes[childIndex];
    if (!domNode) return -1;
    if (domNode.nodeType !== 3) return -1;
    if (domNode.textContent !== String(vnode)) {
      domNode.textContent = String(vnode);
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
  if (
    vnode.tag === (Symbol.for("aio.Fragment") as typeof vnode.tag) ||
    vnode.tag === (Symbol.for("aio.ErrorBoundary") as typeof vnode.tag) ||
    vnode.tag === (Symbol.for("aio.Suspense") as typeof vnode.tag)
  ) {
    let idx = childIndex;
    for (const child of vnode.children) {
      const consumed = _hydrateNode(parent, child, ctx, isSvg, idx);
      if (consumed < 0) return -1;
      idx += consumed;
    }
    // AIO-256: find first DOM-bearing child
    for (const child of vnode.children) {
      const d = getDom(child);
      if (d) {
        vnode._dom = d;
        break;
      }
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
  bindSignalProps(el, props);
  if (props.ref) _callRef(props.ref, el, el.tagName?.toLowerCase());
  // AIO-89: apply action directives
  if (props.use) _applyActions(el, props.use);
}
