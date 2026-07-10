// AIO VDOM child diffing — keyed and unkeyed reconciliation.
// Accepts diffFn callback to avoid circular imports with vdom-diff.ts.

import { _devMode, _devWarn, Fragment } from "./vdom-types.ts";
import type { RenderCtx, VNode } from "./vdom-types.ts";
import { getDom, removeDom } from "./vdom-remove.ts";
import { createDom } from "./vdom-render.ts";

/** Diff function signature — injected from vdom-diff.ts to break circular dep. */
export type DiffFn = (
  parent: Node,
  next: VNode | string | number | null,
  old: VNode | string | number | null,
  ctx: RenderCtx,
  isSvg?: boolean,
) => void;

/** Count the number of direct DOM nodes a vnode occupies (Fragments expand). */
export function _domNodeCount(child: VNode | string | number): number {
  if (typeof child !== "object") return 1; // text node
  if (child.tag === Fragment) {
    let n = 0;
    for (const c of child.children) n += _domNodeCount(c);
    // AIO-169: empty Fragment with comment anchor occupies 1 DOM node.
    return n || (child._dom ? 1 : 0);
  }
  return 1; // element, component, _Null placeholder
}

export function diffChildren(
  parent: Node,
  nextChildren: (VNode | string | number)[],
  oldChildren: (VNode | string | number)[],
  ctx: RenderCtx,
  isSvg: boolean,
  diffFn: DiffFn,
  // AIO-395: when the children belong to a Fragment that shares `parent`
  // with siblings, the region starts AFTER this node — not at
  // parent.firstChild. Without it, every keyed sub-diff re-anchors at the
  // parent start and drags its nodes to the front (list reversal).
  startAnchor: Node | null = null,
): void {
  const hasKeys = nextChildren.some(
    (c) => typeof c === "object" && c.key !== undefined,
  );

  if (_devMode && nextChildren.length > 1) {
    const someKeyed = hasKeys;
    const someUnkeyed = nextChildren.some(
      (c) => typeof c === "object" && c.key === undefined,
    );
    // AIO-69: Warn when multiple element children have no keys at all
    if (!someKeyed && someUnkeyed && nextChildren.length > 2) {
      const vnodeChildren = nextChildren.filter(
        (c) => typeof c === "object" && typeof c.tag !== "undefined",
      );
      if (vnodeChildren.length > 2) {
        const tags = new Set(vnodeChildren.map((c) => (c as VNode).tag));
        if (tags.size === 1) {
          _devWarn(
            "missing-keys",
            `${vnodeChildren.length} <${
              String([...tags][0])
            }> children without keys. Add key props for correct reconciliation.`,
          );
        }
      }
    }
    if (someKeyed && someUnkeyed) {
      _devWarn(
        "mixed-keys",
        "Mixed keyed and unkeyed children — all siblings should have keys or none.",
      );
    }
    if (hasKeys) {
      const keys = new Set<string | number>();
      for (const c of nextChildren) {
        if (typeof c === "object" && c.key !== undefined) {
          if (keys.has(c.key)) {
            _devWarn(
              `dup-key-${String(c.key)}`,
              `Duplicate key "${String(c.key)}" in children list.`,
            );
          }
          keys.add(c.key);
        }
      }
    }
  }

  if (hasKeys) {
    diffKeyed(
      parent,
      nextChildren as VNode[],
      oldChildren as VNode[],
      ctx,
      isSvg,
      diffFn,
      startAnchor,
    );
  } else {
    diffUnkeyed(parent, nextChildren, oldChildren, ctx, isSvg, diffFn);
  }
}

function diffUnkeyed(
  parent: Node,
  nextChildren: (VNode | string | number)[],
  oldChildren: (VNode | string | number)[],
  ctx: RenderCtx,
  isSvg: boolean,
  diffFn: DiffFn,
): void {
  // Snapshot DOM nodes for old children BEFORE mutations.
  const oldDoms: (Node | null)[] = [];
  let cursor: ChildNode | null = parent.firstChild;
  for (let i = 0; i < oldChildren.length; i++) {
    const child = oldChildren[i]!;
    const dom = getDom(child);
    if (dom) {
      oldDoms.push(dom);
      const count = _domNodeCount(child);
      for (let j = 0; j < count; j++) {
        cursor = cursor?.nextSibling ?? null;
      }
    } else {
      oldDoms.push(cursor);
      cursor = cursor?.nextSibling ?? null;
    }
  }

  const max = Math.max(nextChildren.length, oldChildren.length);
  for (let i = 0; i < max; i++) {
    const nc = i < nextChildren.length ? nextChildren[i]! : null;
    const oc = i < oldChildren.length ? oldChildren[i]! : null;

    if (nc == null && oc != null) {
      if (typeof oc === "string" || typeof oc === "number") {
        const textNode = oldDoms[i];
        if (textNode?.parentNode === parent) parent.removeChild(textNode);
      } else {
        removeDom(parent, oc, ctx);
      }
    } else if (nc != null && oc == null) {
      const newDom = createDom(nc, ctx, isSvg, parent);
      if (newDom) parent.appendChild(newDom);
    } else if (
      (typeof nc === "string" || typeof nc === "number") &&
      (typeof oc === "string" || typeof oc === "number")
    ) {
      const oldDom = oldDoms[i];
      if (oldDom && oldDom.nodeType === 3) {
        if (String(nc) !== String(oc)) oldDom.textContent = String(nc);
      } else {
        const newText = ctx.doc.createTextNode(String(nc));
        if (oldDom && oldDom.parentNode === parent) {
          parent.insertBefore(newText, oldDom);
          parent.removeChild(oldDom);
        } else {
          parent.appendChild(newText);
        }
      }
    } else {
      diffFn(parent, nc!, oc!, ctx, isSvg);
    }
  }
}

function diffKeyed(
  parent: Node,
  nextChildren: VNode[],
  oldChildren: VNode[],
  ctx: RenderCtx,
  isSvg: boolean,
  diffFn: DiffFn,
  startAnchor: Node | null = null,
): void {
  // Build map of old keys → old VNode, collect old non-keyed (AIO-114)
  const oldMap = new Map<string | number, VNode>();
  const oldNonKeyed: (VNode | string | number)[] = [];
  const oldNonKeyedDoms: (Node | null)[] = [];

  // Start walking the DOM from the Fragment's anchor (if any) so the
  // DOM→vnode mapping is aligned for Fragments whose region sits mid-parent.
  // Walking from parent.firstChild would assume the region starts at the
  // parent's first child and misalign non-keyed DOM nodes for mid-parent
  // Fragments, removing/moving the wrong nodes.
  let cursor: ChildNode | null = startAnchor
    ? startAnchor.nextSibling
    : parent.firstChild;
  for (const oc of (oldChildren as (VNode | string | number)[])) {
    if (
      typeof oc === "object" && oc !== null && (oc as VNode).key !== undefined
    ) {
      oldMap.set((oc as VNode).key!, oc as VNode);
      const count = _domNodeCount(oc);
      for (let j = 0; j < count; j++) {
        cursor = cursor?.nextSibling ?? null;
      }
    } else {
      oldNonKeyed.push(oc);
      const dom = getDom(oc);
      if (dom) {
        oldNonKeyedDoms.push(dom);
        const count = _domNodeCount(oc);
        for (let j = 0; j < count; j++) {
          cursor = cursor?.nextSibling ?? null;
        }
      } else {
        oldNonKeyedDoms.push(cursor);
        cursor = cursor?.nextSibling ?? null;
      }
    }
  }

  const usedKeys = new Set<string | number>();
  // AIO-395: seed placement at the region start — `lastPlaced.nextSibling`
  // then resolves to the first node of THIS fragment's region instead of
  // parent.firstChild.
  let lastPlaced: Node | null = startAnchor;
  let nkIdx = 0;

  for (const nc of (nextChildren as (VNode | string | number)[])) {
    // Non-keyed child: positionally match against old non-keyed (AIO-114)
    if (
      typeof nc !== "object" || nc === null || (nc as VNode).key === undefined
    ) {
      const onk = nkIdx < oldNonKeyed.length ? oldNonKeyed[nkIdx] : null;
      const onkDom = nkIdx < oldNonKeyedDoms.length
        ? oldNonKeyedDoms[nkIdx]
        : null;
      nkIdx++;

      if (
        onk != null && typeof nc !== "string" && typeof nc !== "number" &&
        typeof onk !== "string" && typeof onk !== "number"
      ) {
        // Both are VNodes — diff in place
        diffFn(parent, nc, onk as VNode, ctx, isSvg);
        const dom = (nc as VNode)._dom ?? (onk as VNode)._dom;
        if (dom) {
          const a: Node | null = lastPlaced
            ? lastPlaced.nextSibling
            : parent.firstChild;
          if (dom !== a) parent.insertBefore(dom, a);
          lastPlaced = dom;
        }
      } else if (
        onk != null && (typeof nc === "string" || typeof nc === "number") &&
        (typeof onk === "string" || typeof onk === "number")
      ) {
        // Both text — update in place
        let textDom: Node | null = onkDom && onkDom.nodeType === 3
          ? onkDom
          : null;
        if (textDom) {
          if (String(nc) !== String(onk)) textDom.textContent = String(nc);
        } else {
          textDom = ctx.doc.createTextNode(String(nc));
          if (onkDom?.parentNode === parent) parent.removeChild(onkDom);
        }
        if (textDom) {
          const a: Node | null = lastPlaced
            ? lastPlaced.nextSibling
            : parent.firstChild;
          if (textDom !== a) parent.insertBefore(textDom, a);
          lastPlaced = textDom;
        }
      } else {
        // Type mismatch or no old match — remove old, create new (AIO-181)
        if (onk != null) {
          if (typeof onk === "object") {
            removeDom(parent, onk as VNode, ctx);
          } else if (onkDom?.parentNode === parent) {
            parent.removeChild(onkDom);
          }
        }
        const newDom = createDom(
          nc as VNode | string | number,
          ctx,
          isSvg,
          parent,
        );
        if (newDom) {
          const anchor = lastPlaced
            ? lastPlaced.nextSibling
            : parent.firstChild;
          parent.insertBefore(newDom, anchor);
          lastPlaced = newDom;
        }
      }
      continue;
    }
    const key = (nc as VNode).key!;
    usedKeys.add(key);
    const oc = oldMap.get(key);

    if (oc) {
      // Existing node — diff in place
      diffFn(parent, nc, oc, ctx, isSvg);
      const dom = nc._dom ?? oc._dom;
      if (dom) {
        // Move to correct position: after lastPlaced (or at start if null)
        const anchor: Node | null = lastPlaced
          ? lastPlaced.nextSibling
          : parent.firstChild;
        // AIO-177: For Fragments, move ALL children (not just first)
        if (typeof nc === "object" && (nc as VNode).tag === Fragment) {
          for (const child of (nc as VNode).children) {
            const childDom = getDom(child);
            if (childDom && childDom.parentNode === parent) {
              const a: Node | null = lastPlaced
                ? lastPlaced.nextSibling
                : parent.firstChild;
              if (childDom !== a) parent.insertBefore(childDom, a);
              lastPlaced = childDom;
            }
          }
          // Handle empty Fragment comment anchor
          if (dom.nodeType === 8 && dom.parentNode === parent) {
            const a: Node | null = lastPlaced
              ? lastPlaced.nextSibling
              : parent.firstChild;
            if (dom !== a) parent.insertBefore(dom, a);
            lastPlaced = dom;
          }
        } else {
          if (dom !== anchor) {
            parent.insertBefore(dom, anchor);
          }
          lastPlaced = dom;
        }
      }
    } else {
      // New node — create and insert at correct position
      const newDom = createDom(nc, ctx, isSvg, parent);
      if (newDom) {
        const anchor2: Node | null = lastPlaced
          ? lastPlaced.nextSibling
          : parent.firstChild;
        parent.insertBefore(newDom, anchor2);
        // AIO-177/AIO-248: For new Fragments, advance lastPlaced to LAST child DOM.
        if (typeof nc === "object" && (nc as VNode).tag === Fragment) {
          const count = _domNodeCount(nc as VNode);
          const firstInserted = lastPlaced
            ? lastPlaced.nextSibling
            : parent.firstChild;
          let node: Node | null = firstInserted;
          for (let i = 1; i < count && node; i++) {
            node = node.nextSibling;
          }
          if (node) lastPlaced = node;
        } else {
          lastPlaced = newDom;
        }
      }
    }
  }

  // Remove old keyed nodes not in next
  for (const oc of oldChildren) {
    if (oc.key !== undefined && !usedKeys.has(oc.key)) {
      removeDom(parent, oc, ctx);
    }
  }
  // Remove excess old non-keyed children not matched above (AIO-114)
  for (let i = nkIdx; i < oldNonKeyed.length; i++) {
    const onk = oldNonKeyed[i]!;
    const dom = oldNonKeyedDoms[i];
    if (typeof onk === "object") {
      removeDom(parent, onk as VNode, ctx);
    } else if (dom?.parentNode === parent) {
      parent.removeChild(dom);
    }
  }
}
