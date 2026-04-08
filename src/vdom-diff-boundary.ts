// AIO VDOM boundary diffing — ErrorBoundary and Suspense reconciliation.
// Separated from vdom-diff.ts for size. Uses DiffFn + DiffChildrenFn callbacks.

import { _LAZY_PENDING } from "./vdom-types.ts";
import type { RenderCtx, VNode } from "./vdom-types.ts";
import { _removeDomCleanup, getDom, removeDom } from "./vdom-remove.ts";
import { _render, createDom } from "./vdom-render.ts";
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

/** Shared helper: update _dom for boundary/fragment containers after diffChildren. */
export function _updateContainerDom(
  parent: Node,
  nv: VNode,
  ov: VNode,
  ctx: RenderCtx,
): void {
  let foundDom = false;
  for (const child of nv.children) {
    const d = getDom(child);
    if (d) {
      nv._dom = d;
      foundDom = true;
      break;
    }
  }
  if (foundDom) {
    // AIO-168: remove old comment anchor when content returns
    const ovDom = ov._dom;
    if (ovDom && ovDom.nodeType === 8 && ovDom.parentNode === parent) {
      parent.removeChild(ovDom);
    }
  } else {
    // Empty container — comment anchor for positioning (AIO-162)
    const ovDom = ov._dom;
    if (ovDom && ovDom.nodeType === 8) {
      nv._dom = ovDom;
    } else {
      const anchor = ctx.doc.createComment("");
      if (ovDom && ovDom.parentNode === parent) {
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
      // Recovering from error: remove old fallback, render children fresh
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
      parent.appendChild(frag);
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
    // Fallback succeeded — safe to remove old DOM and render fallback
    if (!wasError) {
      for (const child of ov.children) removeDom(parent, child, ctx);
    } else if (ov._rendered != null) {
      removeDom(parent, ov._rendered, ctx);
    }
    nv._rendered = fallbackVnode;
    if (fallbackVnode != null) {
      _render(parent, fallbackVnode, null, ctx, isSvg);
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
      // Was showing fallback, try rendering children again
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
      parent.appendChild(frag);
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
    if (!wasPending) {
      for (const child of ov.children) removeDom(parent, child, ctx);
    } else if (ov._rendered != null) {
      removeDom(parent, ov._rendered, ctx);
    }
    nv._rendered = fallback ?? null;
    if (fallback != null) {
      _render(parent, fallback, null, ctx, isSvg);
      nv._dom = getDom(fallback) ?? undefined;
    }
  }
}
