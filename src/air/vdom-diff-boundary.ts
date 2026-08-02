// AIO VDOM boundary diffing — ErrorBoundary and Suspense reconciliation.
// Separated from vdom-diff.ts for size. Uses DiffFn + DiffChildrenFn callbacks.

import { _domNodeCount, _LAZY_PENDING } from "./vdom-types.ts";
import type { RenderCtx, VNode } from "./vdom-types.ts";
import {
  _removeDomCleanup,
  getDom,
  isChildOf,
  removeDom,
} from "./vdom-remove.ts";
import { createDom } from "./vdom-render.ts";
import { _registerLazyListeners } from "./vdom-create.ts";
import type { DiffFn } from "./vdom-diff-children.ts";

/** DiffChildren function signature — injected to break circular dep. */
export type DiffChildrenFn = (
  parent: Node,
  nextChildren: (VNode | string | number)[],
  oldChildren: (VNode | string | number)[],
  ctx: RenderCtx,
  isSvg: boolean,
) => void;

// A boundary occupies a REGION of its parent, not necessarily the end of it.
//
// Recovery and fallback both rebuilt content with `appendChild` / `_render`,
// which append — so a boundary with later siblings had its new content land
// AFTER them: `<span>before</span><ErrorBoundary/><span>after</span>` recovered
// to `before, after, <recovered>`. Capture where the old region sat
// BEFORE removing it, then put the new content back in the same place.

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

/** Insert at the region's place; append when the anchor is gone or was null. */
function _insertAt(parent: Node, node: Node, anchor: Node | null): void {
  if (anchor && isChildOf(anchor, parent)) parent.insertBefore(node, anchor);
  else parent.appendChild(node);
}

/** Shared helper: update _dom for boundary/fragment containers after diffChildren. */
export function _updateContainerDom(
  parent: Node,
  nv: VNode,
  ov: VNode,
  ctx: RenderCtx,
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

  if (count > 0) {
    // Non-empty. Prefer the first tracked child node; otherwise the container
    // leads with bare text whose node getDom can't see — the old first node
    // (ov._dom) still points at it (text diffs in place), unless it was the
    // stale comment anchor.
    let first = firstTracked;
    if (!first) {
      const od = ov._dom;
      if (od && od.nodeType !== 8 && isChildOf(od, parent)) first = od;
    }
    // AIO-168: remove the old comment anchor now that content is present.
    const ovDom = ov._dom;
    if (ovDom && ovDom.nodeType === 8 && isChildOf(ovDom, parent)) {
      parent.removeChild(ovDom);
    }
    if (first) nv._dom = first;
  } else {
    // Empty container — comment anchor for positioning (AIO-162)
    const ovDom = ov._dom;
    if (ovDom && ovDom.nodeType === 8) {
      nv._dom = ovDom;
    } else {
      const anchor = ctx.doc.createComment("");
      if (ovDom && isChildOf(ovDom, parent)) {
        parent.insertBefore(anchor, ovDom);
      } else {
        parent.appendChild(anchor);
      }
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
      removeDom(parent, ov._rendered!, ctx);
      const frag = ctx.doc.createDocumentFragment();
      let firstDom: Node | null = null;
      for (const child of nv.children) {
        const childDom = createDom(child, ctx, isSvg, parent);
        if (childDom) {
          if (!firstDom) firstDom = childDom;
          frag.appendChild(childDom);
        }
      }
      _insertAt(parent, frag, at);
      nv._dom = firstDom ?? undefined;
    } else {
      diffChildrenFn(parent, nv.children, ov.children, ctx, isSvg);
      _updateContainerDom(parent, nv, ov, ctx);
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
      for (const child of ov.children) removeDom(parent, child, ctx);
    } else if (ov._rendered != null) {
      removeDom(parent, ov._rendered, ctx);
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
      removeDom(parent, ov._rendered!, ctx);
      const frag = ctx.doc.createDocumentFragment();
      let firstDom: Node | null = null;
      // AIO-201: track created children so we can clean up on partial failure
      const created: (VNode | string | number)[] = [];
      try {
        for (const child of nv.children) {
          const childDom = createDom(child, ctx, isSvg, parent);
          if (childDom) {
            if (!firstDom) firstDom = childDom;
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
      diffChildrenFn(parent, nv.children, ov.children, ctx, isSvg);
      _updateContainerDom(parent, nv, ov, ctx);
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
      for (const child of ov.children) removeDom(parent, child, ctx);
    } else if (ov._rendered != null) {
      removeDom(parent, ov._rendered, ctx);
    }
    nv._rendered = fallback ?? null;
    if (fallback != null) {
      const dom = createDom(fallback, ctx, isSvg, parent);
      if (dom) _insertAt(parent, dom, at);
      nv._dom = getDom(fallback) ?? undefined;
    }
  }
}
