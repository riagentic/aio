// AIO VDOM render — createDom and _render.
// Creates real DOM from VNode trees. Depends on helpers + remove (getDom).

import { bindSignalProps } from "./signal-binding.ts";
import { _applyActions, _bindSignalTextChildren } from "./vdom-helpers.ts";
import {
  _callRef,
  _registerLazyListeners,
  _tagComponentError,
  nullSlot,
} from "./vdom-create.ts";
import { _componentName } from "./hook-error.ts";
import { applyChildDependentProps, applyProps } from "./vdom-props.ts";
import { getDom } from "./vdom-remove.ts";
import { _getActiveDelegationRoot, _setDelegationRoot } from "./vdom-events.ts";
import {
  _devA11yCheckFn,
  _LAZY_PENDING,
  _Null,
  ErrorBoundary,
  Fragment,
  Portal,
  Suspense,
  SVG_TAGS,
} from "./vdom-types.ts";
import type { ComponentFn, RenderCtx, VNode } from "./vdom-types.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

/** The node a just-created child actually OCCUPIES once appended.
 *
 *  `createDom` returns a DocumentFragment for a Fragment/boundary child — a
 *  carrier that `appendChild` empties and leaves detached. Recording it as the
 *  container's first node (`_dom`) therefore anchored the container to a node
 *  that is not in the document: every later diff found `isChildOf` false, fell
 *  back to "the region starts at parent.firstChild", and reconciled the
 *  fragment's children against its EARLIER SIBLINGS' nodes. The component
 *  branch already unwrapped this (AIO-167); the Fragment/EB/Suspense child
 *  loops did not. */
export function _occupied(
  child: VNode | string | number,
  childDom: Node,
): Node | null {
  return childDom.nodeType === 11 ? getDom(child) : childDom;
}

/** An empty container holds its SLOT with a comment anchor (AIO-195).
 *
 *  Without one it has no `_dom`, so the next diff cannot tell where its region
 *  begins and falls back to "the parent's first child" — a list that starts
 *  empty and then fills renders ABOVE its header. That was fixed for `Fragment`
 *  and left unfixed for `ErrorBoundary` and `Suspense`, which are the same kind
 *  of thing: a region of the parent shared with siblings. `_domNodeCount` and
 *  `_updateContainerDom` already counted the anchor for all three — only the
 *  three CREATION paths (mount, SSR, hydrate) disagreed, so `<ErrorBoundary>`
 *  around a list that starts empty put its rows in the wrong place on mount and
 *  grew a stray comment on the first re-render. */
function _anchorEmpty(ctx: RenderCtx, frag: Node, vnode: VNode): void {
  const anchor = ctx.doc.createComment("");
  frag.appendChild(anchor);
  vnode._dom = anchor;
}

export function _render(
  parent: Node,
  vnode: VNode | string | number | null,
  _oldVnode: VNode | string | number | null,
  ctx: RenderCtx,
  isSvg = false,
): void {
  if (vnode == null) return;
  const dom = createDom(vnode, ctx, isSvg, parent);
  if (dom) parent.appendChild(dom);
}

/** Create real DOM nodes from a VNode tree — handles elements, text, fragments, and components. */
export function createDom(
  vnode: VNode | string | number,
  ctx: RenderCtx,
  isSvg: boolean,
  parentDom?: Node,
): Node | null {
  if (typeof vnode === "string" || typeof vnode === "number") {
    return ctx.doc.createTextNode(String(vnode));
  }

  // Not a VNode at all — an array, a promise, a plain object. The most common
  // cause is a component returning a LIST (`return items.map(…)`), which React
  // allows and AIR does not. It used to die eleven frames deeper on
  // `Cannot use 'in' operator to search for 'onInput' in undefined`, naming
  // nothing; `_tagComponentError` adds the component to this one.
  if ((vnode as VNode).tag === undefined) {
    throw new Error(
      `A component returned ${
        Array.isArray(vnode)
          ? `an array of ${vnode.length}`
          : `a ${typeof vnode}`
      } where AIR expects a single node. Wrap the list in a fragment: ` +
        `<>{items.map(…)}</> (or h(Fragment, null, ...items)).`,
    );
  }

  // Null placeholder — comment node preserving child position (AIO-107)
  if (vnode.tag === _Null) {
    const comment = ctx.doc.createComment("");
    vnode._dom = comment;
    return comment;
  }

  // Component — call hooks, invoke function, recurse on output
  if (typeof vnode.tag === "function") {
    const hookState = ctx.hooks?.beforeComponent(
      vnode,
      null,
      parentDom ?? ctx.doc.body,
      isSvg,
    );
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
      if (e !== _LAZY_PENDING) _tagComponentError(e, vnode.tag);
      throw e;
    }
    // A component that renders nothing still OCCUPIES its written position —
    // the placeholder is what the next diff inserts before. See nullSlot().
    if (rendered == null) rendered = nullSlot();
    vnode._rendered = rendered;
    try {
      ctx.hooks?.afterComponent(vnode, rendered, hookState);
      let dom: Node | null;
      try {
        dom = createDom(rendered, ctx, isSvg, parentDom);
      } catch (e) {
        // A child's render failed — record this component on the error's
        // component chain (the innermost already stamped the message).
        if (e !== _LAZY_PENDING) _tagComponentError(e, vnode.tag);
        throw e;
      }
      // AIO-167: if rendered is a Fragment, dom is a DocumentFragment that becomes
      // empty after insertion. Store the first child DOM instead (via getDom on the
      // rendered VNode) so the component has a valid position anchor for future diffs.
      vnode._dom = (dom && dom.nodeType === 11)
        ? (getDom(rendered) ?? undefined)
        : (dom ?? undefined);
      return dom;
    } finally {
      ctx.hooks?.afterSubtree?.(vnode);
    }
  }

  // ErrorBoundary — render children with error catching
  if (vnode.tag === ErrorBoundary) {
    const fallback = vnode.props.fallback as
      | ((e: Error) => VNode | string | number | null)
      | undefined;
    try {
      const frag = ctx.doc.createDocumentFragment();
      let firstDom: Node | null = null;
      for (const child of vnode.children) {
        const childDom = createDom(child, ctx, isSvg, parentDom);
        if (childDom) {
          if (!firstDom) firstDom = _occupied(child, childDom);
          frag.appendChild(childDom);
        }
      }
      if (firstDom) vnode._dom = firstDom;
      else _anchorEmpty(ctx, frag, vnode);
      return frag;
    } catch (error) {
      // AIO-178: re-throw _LAZY_PENDING so Suspense can handle it
      if (error === _LAZY_PENDING) throw error;
      if (!fallback) throw error;
      const fallbackVnode = fallback(error as Error);
      vnode._rendered = fallbackVnode;
      if (fallbackVnode == null) return null;
      const dom = createDom(fallbackVnode, ctx, isSvg, parentDom);
      // The node the fallback OCCUPIES — never the DocumentFragment a Fragment
      // fallback returns, which insertion empties and leaves detached (AIO-167
      // for the happy path; the fallback branch had the same hole, so a
      // boundary showing a multi-node fallback had no position at all).
      vnode._dom = (dom ? _occupied(fallbackVnode, dom) : null) ?? undefined;
      return dom;
    }
  }

  // Suspense — render children, catch lazy pending and show fallback
  if (vnode.tag === Suspense) {
    const fallback = vnode.props.fallback as
      | VNode
      | string
      | number
      | null
      | undefined;
    try {
      const frag = ctx.doc.createDocumentFragment();
      let firstDom: Node | null = null;
      for (const child of vnode.children) {
        const childDom = createDom(child, ctx, isSvg, parentDom);
        if (childDom) {
          if (!firstDom) firstDom = _occupied(child, childDom);
          frag.appendChild(childDom);
        }
      }
      if (firstDom) vnode._dom = firstDom;
      else _anchorEmpty(ctx, frag, vnode);
      return frag;
    } catch (thrown) {
      if (thrown !== _LAZY_PENDING) throw thrown;
      // Register for lazy resolution notifications
      _registerLazyListeners(vnode.children, ctx);
      // Lazy child not ready — render fallback
      vnode._rendered = fallback ?? null;
      if (fallback == null) return null;
      const dom = createDom(fallback, ctx, isSvg, parentDom);
      vnode._dom = (dom ? _occupied(fallback, dom) : null) ?? undefined;
      return dom;
    }
  }

  // Portal — render children into target DOM node
  if (vnode.tag === Portal) {
    const target = vnode.props.target as Node;
    if (!target) return null;
    // AIO-184: try-finally ensures delegation root is restored on error
    const prevDelegation = _getActiveDelegationRoot();
    if ((target as Node).nodeType === 1) {
      _setDelegationRoot(target as Element);
    }
    try {
      for (const child of vnode.children) {
        const childDom = createDom(child, ctx, false, target);
        if (childDom) target.appendChild(childDom);
      }
    } finally {
      _setDelegationRoot(prevDelegation);
    }
    // Portal has no DOM in its parent — it renders elsewhere
    return null;
  }

  // Fragment — track first child DOM for getDom() lookups
  if (vnode.tag === Fragment) {
    const frag = ctx.doc.createDocumentFragment();
    let firstDom: Node | null = null;
    for (const child of vnode.children) {
      const childDom = createDom(child, ctx, isSvg, parentDom);
      if (childDom) {
        if (!firstDom) firstDom = _occupied(child, childDom);
        frag.appendChild(childDom);
      }
    }
    if (firstDom) vnode._dom = firstDom;
    else _anchorEmpty(ctx, frag, vnode);
    return frag;
  }

  // Element
  const tag = vnode.tag as string;
  const nowSvg = isSvg || SVG_TAGS.has(tag);
  const el = nowSvg
    ? ctx.doc.createElementNS(SVG_NS, tag)
    : ctx.doc.createElement(tag);

  applyProps(el as HTMLElement, vnode.props, {});
  bindSignalProps(el as HTMLElement, vnode.props);
  if (_devA11yCheckFn) _devA11yCheckFn(tag, vnode.props);

  for (let i = 0; i < vnode.children.length; i++) {
    const childDom = createDom(vnode.children[i]!, ctx, nowSvg, el);
    if (childDom) el.appendChild(childDom);
  }

  // Bind signal text children — direct text-node effects bypassing VDOM diff
  if (vnode._signalChildren) {
    _bindSignalTextChildren(el, vnode._signalChildren, vnode.children);
  }

  // Props that only take effect once the children exist (`<select value>`).
  applyChildDependentProps(el as HTMLElement, vnode.props, {});

  // Call ref after element + children are fully built
  if (vnode.props.ref) _callRef(vnode.props.ref, el, _componentName(vnode.tag));
  if (vnode.props.use) _applyActions(el as HTMLElement, vnode.props.use);

  vnode._dom = el;
  return el;
}
