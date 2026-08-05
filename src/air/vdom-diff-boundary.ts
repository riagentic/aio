// AIO VDOM boundary diffing — ErrorBoundary and Suspense reconciliation.
// Separated from vdom-diff.ts for size. Uses DiffFn + DiffChildrenFn callbacks.

import { _domNodeCount, _LAZY_PENDING } from "./vdom-types.ts";
import type { RenderCtx, VNode } from "./vdom-types.ts";
import {
  _advance,
  _removeDomCleanup,
  getDom,
  isChildOf,
  removeDom,
} from "./vdom-remove.ts";
import { _occupied, createDom } from "./vdom-render.ts";
import { _registerLazyListeners } from "./vdom-create.ts";
import type { DiffFn } from "./vdom-diff-children.ts";

/** DiffChildren function signature — injected to break circular dep.
 *  Returns the region's first DOM node (see `diffChildren`). */
export type DiffChildrenFn = (
  parent: Node,
  nextChildren: (VNode | string | number)[],
  oldChildren: (VNode | string | number)[],
  ctx: RenderCtx,
  isSvg: boolean,
  startAnchor?: Node | null,
) => Node | null;

// A boundary occupies a REGION of its parent, not necessarily the end of it.
//
// Recovery and fallback both rebuilt content with `appendChild` / `_render`,
// which append — so a boundary with later siblings had its new content land
// AFTER them: `<span>before</span><ErrorBoundary/><span>after</span>` recovered
// to `before, after, <recovered>`. Capture where the old region sat
// BEFORE removing it, then put the new content back in the same place.

/** The region's first live node, before any mutation. */
function _regionStart(
  parent: Node,
  ov: VNode,
  startAnchor: Node | null,
): Node | null {
  const d = getDom(ov);
  if (d && isChildOf(d, parent)) return d;
  return startAnchor && isChildOf(startAnchor, parent)
    ? startAnchor.nextSibling
    : parent.firstChild;
}

/** The live node that FOLLOWS this region, or null when it ends the parent. */
function _regionAnchor(
  parent: Node,
  region: (VNode | string | number | null | undefined)[],
): Node | null {
  for (let i = region.length - 1; i >= 0; i--) {
    const v = region[i];
    if (v == null) continue;
    const d = getDom(v as VNode | string | number);
    if (d && isChildOf(d, parent)) return d.nextSibling;
  }
  return null;
}

/** Remove a whole region, walking it positionally so bare-text children —
 *  which carry no `_dom` and are therefore invisible to `getDom` — are removed
 *  too instead of being left behind on the page. */
function _removeRegion(
  parent: Node,
  children: (VNode | string | number)[],
  ctx: RenderCtx,
  first: Node | null,
): void {
  let cursor: Node | null = first;
  for (const child of children) {
    const at = getDom(child) ?? cursor;
    cursor = _advance(at, _domNodeCount(child));
    removeDom(parent, child, ctx, at);
  }
}

/** Insert at the region's place; append when the anchor is gone or was null. */
function _insertAt(parent: Node, node: Node, anchor: Node | null): void {
  if (anchor && isChildOf(anchor, parent)) parent.insertBefore(node, anchor);
  else parent.appendChild(node);
}

/** Shared helper: update _dom for boundary/fragment containers after
 *  diffChildren.
 *
 *  `regionFirst` is the container region's first DOM node as measured by
 *  `diffChildren` immediately after it mutated the region — the authoritative
 *  answer. Deriving it here instead ("first child that carries a `_dom`") skips
 *  LEADING BARE TEXT, whose node nothing tracks: the container's `_dom` then
 *  pointed at its second child, and the next diff anchored the whole region one
 *  node too late. When the region is empty, it is the node that FOLLOWS it and
 *  therefore the exact place to put the comment anchor. */
export function _updateContainerDom(
  parent: Node,
  nv: VNode,
  ov: VNode,
  ctx: RenderCtx,
  regionFirst: Node | null = null,
): void {
  // AIO-413: decide emptiness by REALIZED node count, not getDom() alone. Bare
  // text/number children carry no _dom, so a text-only container (a Fragment
  // whose children are all strings — extremely common) looked "empty" to the old
  // getDom scan: it injected a stray comment anchor on every re-render and set
  // _dom to that comment, desyncing the parent's child cursor (frozen/duplicated
  // nodes). Counting realized nodes classifies such containers correctly.
  let count = 0;
  let firstTracked: Node | null = null;
  for (const child of nv.children) {
    const c = _domNodeCount(child);
    count += c;
    if (!firstTracked && c > 0) {
      const d = getDom(child);
      if (d) firstTracked = d; // element/component/nested-fragment first node
    }
  }
  // Was the container empty BEFORE this diff? Only then is `ov._dom` an anchor.
  let oldCount = 0;
  for (const child of ov.children) oldCount += _domNodeCount(child);

  if (count > 0) {
    // AIO-168: remove the old comment anchor now that content is present.
    // Gated on the container having actually BEEN empty: a comment node is not
    // proof of an anchor. A container whose first child is a `null` renders a
    // `_Null` placeholder — also a comment, also `ov._dom` — and removing it
    // silently deleted a real child the moment the container grew a sibling in
    // front of it.
    const ovDom = ov._dom;
    if (
      oldCount === 0 && ovDom && ovDom.nodeType === 8 &&
      ovDom !== regionFirst && isChildOf(ovDom, parent)
    ) {
      parent.removeChild(ovDom);
    }
    // Measured position wins; the tracked-child scan is the fallback for the
    // callers that cannot measure (they pass no regionFirst).
    let first = regionFirst ?? firstTracked;
    if (!first) {
      const od = ov._dom;
      if (od && od.nodeType !== 8 && isChildOf(od, parent)) first = od;
    }
    if (first) nv._dom = first;
  } else {
    // Empty container — comment anchor for positioning (AIO-162)
    const ovDom = ov._dom;
    // The anchor must still BE in the document: when the container's last
    // child was a `_Null` placeholder, its comment node IS `ov._dom` and the
    // child diff just removed it. Adopting it left the fragment anchored to a
    // detached node — no anchor in the DOM at all, and the region then grew
    // back in the wrong place.
    if (ovDom && ovDom.nodeType === 8 && isChildOf(ovDom, parent)) {
      nv._dom = ovDom;
    } else {
      const anchor = ctx.doc.createComment("");
      const at = regionFirst ??
        (ovDom && isChildOf(ovDom, parent) ? ovDom : null);
      if (at && isChildOf(at, parent)) parent.insertBefore(anchor, at);
      else parent.appendChild(anchor);
      nv._dom = anchor;
    }
  }
}

export function _diffErrorBoundary(
  parent: Node,
  nv: VNode,
  ov: VNode,
  ctx: RenderCtx,
  isSvg: boolean,
  _diffFn: DiffFn,
  diffChildrenFn: DiffChildrenFn,
  startAnchor: Node | null = null,
): void {
  const fallback = nv.props.fallback as
    | ((e: Error) => VNode | string | number | null)
    | undefined;
  const wasError = ov._rendered != null;

  try {
    if (wasError) {
      // Recovering from error: remove old fallback, render children fresh —
      // back into the SAME slot the fallback occupied.
      const at = _regionAnchor(parent, [ov._rendered!]);
      removeDom(parent, ov._rendered!, ctx, getDom(ov) ?? null);
      const frag = ctx.doc.createDocumentFragment();
      let firstDom: Node | null = null;
      for (const child of nv.children) {
        const childDom = createDom(child, ctx, isSvg, parent);
        if (childDom) {
          if (!firstDom) firstDom = _occupied(child, childDom);
          frag.appendChild(childDom);
        }
      }
      _insertAt(parent, frag, at);
      nv._dom = firstDom ?? undefined;
    } else {
      const regionFirst = diffChildrenFn(
        parent,
        nv.children,
        ov.children,
        ctx,
        isSvg,
        startAnchor,
      );
      _updateContainerDom(parent, nv, ov, ctx, regionFirst);
    }
    nv._rendered = undefined;
  } catch (error) {
    // AIO-178: re-throw _LAZY_PENDING so Suspense can handle it
    if (error === _LAZY_PENDING) throw error;
    if (!fallback) throw error;
    // AIO-190: call fallback BEFORE removing old DOM
    let fallbackVnode: VNode | string | number | null;
    try {
      fallbackVnode = fallback(error as Error);
    } catch (fallbackError) {
      console.error(
        "[aio:vdom] ErrorBoundary fallback threw:",
        fallbackError,
      );
      throw fallbackError;
    }
    // Fallback succeeded — safe to remove old DOM and render fallback where
    // the boundary's content was, not at the end of the parent.
    const at = _regionAnchor(
      parent,
      !wasError ? ov.children : [ov._rendered],
    );
    if (!wasError) {
      _removeRegion(
        parent,
        ov.children,
        ctx,
        _regionStart(parent, ov, startAnchor),
      );
    } else if (ov._rendered != null) {
      removeDom(parent, ov._rendered, ctx, getDom(ov) ?? null);
    }
    nv._rendered = fallbackVnode;
    if (fallbackVnode != null) {
      const dom = createDom(fallbackVnode, ctx, isSvg, parent);
      if (dom) _insertAt(parent, dom, at);
      nv._dom = getDom(fallbackVnode) ?? undefined;
    }
  }
}

export function _diffSuspense(
  parent: Node,
  nv: VNode,
  ov: VNode,
  ctx: RenderCtx,
  isSvg: boolean,
  _diffFn: DiffFn,
  diffChildrenFn: DiffChildrenFn,
  startAnchor: Node | null = null,
): void {
  const fallback = nv.props.fallback as
    | VNode
    | string
    | number
    | null
    | undefined;
  const wasPending = ov._rendered != null;
  try {
    if (wasPending) {
      // Was showing fallback, try rendering children again — same slot.
      const at = _regionAnchor(parent, [ov._rendered!]);
      removeDom(parent, ov._rendered!, ctx, getDom(ov) ?? null);
      const frag = ctx.doc.createDocumentFragment();
      let firstDom: Node | null = null;
      // AIO-201: track created children so we can clean up on partial failure
      const created: (VNode | string | number)[] = [];
      try {
        for (const child of nv.children) {
          const childDom = createDom(child, ctx, isSvg, parent);
          if (childDom) {
            if (!firstDom) firstDom = _occupied(child, childDom);
            frag.appendChild(childDom);
          }
          created.push(child);
        }
      } catch (innerThrown) {
        // AIO-201: clean up partially-created children
        for (const child of created) {
          if (typeof child === "object") _removeDomCleanup(child, ctx);
        }
        throw innerThrown;
      }
      _insertAt(parent, frag, at);
      nv._dom = firstDom ?? undefined;
    } else {
      const regionFirst = diffChildrenFn(
        parent,
        nv.children,
        ov.children,
        ctx,
        isSvg,
        startAnchor,
      );
      _updateContainerDom(parent, nv, ov, ctx, regionFirst);
    }
    nv._rendered = undefined;
  } catch (thrown) {
    if (thrown !== _LAZY_PENDING) throw thrown;
    // Register for lazy resolution notifications
    _registerLazyListeners(nv.children, ctx);
    const at = _regionAnchor(
      parent,
      !wasPending ? ov.children : [ov._rendered],
    );
    if (!wasPending) {
      _removeRegion(
        parent,
        ov.children,
        ctx,
        _regionStart(parent, ov, startAnchor),
      );
    } else if (ov._rendered != null) {
      removeDom(parent, ov._rendered, ctx, getDom(ov) ?? null);
    }
    nv._rendered = fallback ?? null;
    if (fallback != null) {
      const dom = createDom(fallback, ctx, isSvg, parent);
      if (dom) _insertAt(parent, dom, at);
      nv._dom = getDom(fallback) ?? undefined;
    }
  }
}
