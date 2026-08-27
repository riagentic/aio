// The component tree `connectAioDevTools().tree` reads — walked from the live
// AIR roots on demand.
//
// It lives on THIS side of the boundary because only the renderer knows the
// tree: `src/diagnostics` may not import `src/air`, so devtools holds a
// late-bound source function and this module fills it in at import time. The
// walk is the same shape `ui-surface.ts` uses (component vnodes are the nodes;
// host elements are just the space between them), kept separate because the two
// answer different questions — the UI surface is about what a test can DRIVE,
// this is about what the renderer is DOING.

import { _setComponentTreeSource } from "../diagnostics/devtools.ts";
import type { ComponentTreeNode } from "../diagnostics/devtools.ts";
import { _liveRoots } from "./renderer-state.ts";
import type { ComponentInstance } from "./renderer-types.ts";
import type { VNode } from "./vdom-types.ts";

const isVNode = (c: unknown): c is VNode =>
  !!c && typeof c === "object" && "tag" in (c as Record<string, unknown>);

/** Collect the component nodes at or below `node`, appending to `out`. A host
 *  element is not a node of this tree — it is descended THROUGH, so a component
 *  nested inside plain markup still lands under its nearest component ancestor
 *  rather than at the root. */
function collect(
  node: VNode | string | number | null | undefined,
  out: ComponentTreeNode[],
): void {
  if (!isVNode(node)) return;
  if (typeof node.tag === "function") {
    const inst = node._instance as ComponentInstance | undefined;
    const fn = node.tag as { name?: string; _lazyName?: string };
    const children: ComponentTreeNode[] = [];
    collect(node._rendered, children);
    out.push({
      name: fn._lazyName ??
        (fn.name && fn.name.length > 0 ? fn.name : "Anonymous"),
      // `children` is the vnode's own child list, not data — it would serialize
      // the whole subtree back into every node.
      props: Object.fromEntries(
        Object.entries(node.props).filter(([k]) => k !== "children"),
      ),
      renderCount: inst?._dtRenders ?? 0,
      signalCount: inst?.deps.size ?? 0,
      children,
      lastRenderMs: inst?._dtLastMs ?? 0,
    });
    return;
  }
  // Host element / Fragment / boundary: not a node here, but its children may be.
  for (const c of node.children) collect(c, out);
  collect(node._rendered, out);
}

/** Every mounted root's component tree, newest walk each call. */
export function _componentTree(): ComponentTreeNode[] {
  const out: ComponentTreeNode[] = [];
  for (const root of _liveRoots) {
    if (root.disposed) continue;
    collect(root.vnode, out);
  }
  return out;
}

_setComponentTreeSource(_componentTree);
