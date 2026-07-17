// AIO VDOM removal — getDom, cleanup, and DOM removal.
// Depends on vdom-helpers (leaf). No deps on vdom-render or vdom-diff.

import { cleanupSignalBindings } from "./signal-binding.ts";
import { _cleanupActions, _cleanupSignalTextChildren } from "./vdom-helpers.ts";
import { _callRef } from "./vdom-create.ts";
import { ErrorBoundary, Fragment, Portal, Suspense } from "./vdom-types.ts";
import type { RenderCtx, VNode } from "./vdom-types.ts";

/** Get the real DOM node associated with a VNode, or null if not mounted. */
export function getDom(vnode: VNode | string | number): Node | null {
  if (typeof vnode === "object" && vnode !== null) {
    return vnode._dom ?? null;
  }
  return null;
}

/** True when `node` is a live child of `parent`. A plain `.parentNode ===
 *  parent` identity check breaks under happy-dom, which wraps <form> in a
 *  Proxy (named-element access): a child's .parentNode may be the raw node or
 *  the proxy depending on how it was inserted, while the reconciler holds the
 *  proxy — identity fails even though the child IS inside the parent, so
 *  conditional bindings froze inside <form> under testUI (risoto 2026-07-16d).
 *  The fallback scans childNodes by identity (stable in both worlds); it only
 *  runs when the fast path misses, i.e. proxy containers or true non-children. */
export function isChildOf(
  node: Node | null | undefined,
  parent: Node,
): boolean {
  if (!node?.parentNode) return false;
  if (node.parentNode === parent) return true;
  const kids = parent.childNodes;
  for (let i = 0; i < kids.length; i++) {
    if (kids[i] === node) return true;
  }
  return false;
}

/** Cleanup component instances without removing DOM (for type-mismatch replacement). */
export function _removeDomCleanup(
  vnode: VNode | string | number,
  ctx: RenderCtx,
): void {
  if (typeof vnode !== "object") return;
  if (typeof vnode.tag === "function") {
    ctx.hooks?.unmountComponent(vnode);
    if (vnode._rendered != null) _removeDomCleanup(vnode._rendered, ctx);
  }
  // Cleanup actions before nulling refs
  if (typeof vnode.tag === "string" && vnode._dom) {
    cleanupSignalBindings(vnode._dom as Element);
    _cleanupSignalTextChildren(vnode._dom as Element);
    _cleanupActions(vnode._dom as HTMLElement);
  }
  // AIO-58: Null element refs on cleanup (was missing — ref callbacks never got
  // null on replace/unmount, leaking event listeners and DOM references)
  if (typeof vnode.tag === "string" && vnode.props.ref) {
    _callRef(vnode.props.ref, null);
  }
  if (
    vnode.tag === Fragment || vnode.tag === ErrorBoundary ||
    vnode.tag === Suspense || vnode.tag === Portal ||
    typeof vnode.tag === "string"
  ) {
    for (const child of vnode.children) {
      if (typeof child === "object") _removeDomCleanup(child, ctx);
    }
  }
}

export function removeDom(
  parent: Node,
  vnode: VNode | string | number,
  ctx: RenderCtx,
): void {
  // Portal: remove children from target DOM
  if (typeof vnode === "object" && vnode.tag === Portal) {
    const target = vnode.props.target as Node;
    if (target) {
      for (const child of vnode.children) removeDom(target, child, ctx);
    }
    return;
  }
  // Fragment/ErrorBoundary/Suspense: remove all child DOMs
  if (
    typeof vnode === "object" &&
    (vnode.tag === Fragment || vnode.tag === ErrorBoundary ||
      vnode.tag === Suspense)
  ) {
    // If ErrorBoundary/Suspense was in fallback state, remove fallback instead
    if (
      (vnode.tag === ErrorBoundary || vnode.tag === Suspense) &&
      vnode._rendered != null
    ) {
      removeDom(parent, vnode._rendered, ctx);
      return;
    }
    for (const child of vnode.children) {
      removeDom(parent, child, ctx);
    }
    // AIO-168: remove empty Fragment/EB/Suspense comment anchor — children loop
    // doesn't touch it because children is [] for empty containers.
    if (
      vnode._dom && vnode._dom.nodeType === 8 &&
      isChildOf(vnode._dom, parent)
    ) {
      parent.removeChild(vnode._dom);
    }
    return;
  }
  // Component: unmount instance, remove the rendered output
  if (typeof vnode === "object" && typeof vnode.tag === "function") {
    ctx.hooks?.unmountComponent(vnode);
    if (vnode._rendered != null) {
      removeDom(parent, vnode._rendered, ctx);
    }
    return;
  }
  // Element: null ref before removing
  if (
    typeof vnode === "object" && typeof vnode.tag === "string" &&
    vnode.props.ref
  ) {
    _callRef(vnode.props.ref, null);
  }
  const dom = getDom(vnode);
  if (dom && isChildOf(dom, parent)) {
    // Deferred removal for exit animations — cleanup AFTER animation completes
    const HtmlEl = ctx.doc?.defaultView?.HTMLElement ?? globalThis.HTMLElement;
    if (
      ctx.onBeforeRemove && typeof vnode === "object" && HtmlEl &&
      dom instanceof HtmlEl
    ) {
      const result = ctx.onBeforeRemove(dom, vnode);
      if (result && typeof result.then === "function") {
        const SAFETY_TIMEOUT = 5000;
        // AIO-210: guard against double-cleanup when timeout fires before promise
        let removed = false;
        const _cleanup = () => {
          cleanupSignalBindings(dom as Element);
          _cleanupSignalTextChildren(dom as Element);
          _cleanupActions(dom as HTMLElement);
          // AIO-204: recurse into children for cleanup
          if (typeof vnode === "object") {
            for (const child of vnode.children) {
              if (typeof child === "object") _removeDomCleanup(child, ctx);
            }
          }
          if (isChildOf(dom, parent)) parent.removeChild(dom);
        };
        const timeout = setTimeout(() => {
          if (removed) return;
          removed = true;
          _cleanup();
        }, SAFETY_TIMEOUT);
        const _doRemove = () => {
          if (removed) return;
          removed = true;
          clearTimeout(timeout);
          _cleanup();
        };
        result.then(_doRemove, (e) => {
          console.error("[aio:vdom] onBeforeRemove rejected:", e);
          _doRemove();
        });
        return;
      }
    }
    // Immediate removal — cleanup first
    if (
      typeof vnode === "object" && typeof vnode.tag === "string" && vnode._dom
    ) {
      cleanupSignalBindings(vnode._dom as Element);
      _cleanupSignalTextChildren(vnode._dom as Element);
      _cleanupActions(vnode._dom as HTMLElement);
      // AIO-204: recurse into children for cleanup
      for (const child of vnode.children) {
        if (typeof child === "object") _removeDomCleanup(child, ctx);
      }
    }
    parent.removeChild(dom);
  }
}
