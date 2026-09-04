// AIO VDOM child diffing — keyed and unkeyed reconciliation.
// Accepts diffFn callback to avoid circular imports with vdom-diff.ts.

import { _devWarn, _domNodeCount } from "./vdom-types.ts";
import { isDevMode } from "../state/dev-flag.ts";
import type { RenderCtx, VNode } from "./vdom-types.ts";
import {
  _cancelExitFor,
  _firstLive,
  _markExitKey,
  _nextLive,
  getDom,
  isChildOf,
  removeDom,
} from "./vdom-remove.ts";
import { createDom } from "./vdom-render.ts";
import { _isFromArray } from "./vdom-create.ts";

/** Diff function signature — injected from vdom-diff.ts to break circular dep.
 *
 *  `oldDom` is the node `old` POSITIONALLY occupies (or, when it occupies none,
 *  the node that follows its slot); the return value is the node `next` now
 *  occupies. Both exist because bare strings/numbers cannot carry a `_dom`, so
 *  position is the only handle on their text node. */
export type DiffFn = (
  parent: Node,
  next: VNode | string | number | null,
  old: VNode | string | number | null,
  ctx: RenderCtx,
  isSvg?: boolean,
  oldDom?: Node | null,
) => Node | null;

/** Diff a child list; returns the FIRST DOM node of the region afterwards.
 *
 *  The region is delimited by `startAnchor` (exclusive) — a node OUTSIDE the
 *  region that no child diff may touch — so reading `startAnchor.nextSibling`
 *  after the mutations yields the region's first node exactly, with no scan and
 *  no guess. Container vnodes (Fragment/EB/Suspense) need it because their
 *  `_dom` must be their first node even when that node is bare text. */
/** Where a keys warning points. The warning used to name a TAG and nothing
 *  else — "4 <div> children without keys" — which in any real app is a grep
 *  through every component for a parent with four divs; the visual app
 *  manager has dozens, and the one that fired was found by elimination over
 *  three boots. The parent DOM node is right here, and so are the children:
 *  name the parent (`tag#id.class`), then the first text each child renders,
 *  which is how the reader will recognise the spot on screen. Dev-only,
 *  observe-only — this string is never read by anything but a person. */
function _whereInTree(
  parent: Node,
  children: (VNode | string | number)[],
): string {
  const el = parent as Partial<Element> & Node;
  const tag = String(el.nodeName ?? "?").toLowerCase();
  const id = typeof el.id === "string" && el.id ? `#${el.id}` : "";
  const cls = typeof el.className === "string" && el.className
    ? `.${el.className.split(/\s+/)[0]}`
    : "";
  const firstText = (c: VNode | string | number): string => {
    if (typeof c !== "object") return String(c);
    for (const k of c.children ?? []) {
      if (typeof k === "string" || typeof k === "number") return String(k);
      const t = firstText(k);
      if (t) return t;
    }
    return "";
  };
  const samples = children.slice(0, 4).map((c) => {
    const t = firstText(c).trim().replace(/\s+/g, " ").slice(0, 24);
    return t ? JSON.stringify(t) : "(no text)";
  });
  return ` — inside <${tag}${id}${cls}>, children start: ${
    samples.join(", ")
  }` +
    (children.length > 4 ? `, … (${children.length} total)` : "");
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
): Node | null {
  const hasKeys = nextChildren.some(
    (c) => typeof c === "object" && c.key !== undefined,
  );

  if (isDevMode() && nextChildren.length > 1) {
    const someKeyed = hasKeys;
    const someUnkeyed = nextChildren.some(
      (c) => typeof c === "object" && c.key === undefined,
    );
    // AIO-69: Warn when multiple element children have no keys at all — but
    // only for children that came out of an ARRAY EXPRESSION (a `.map`
    // result, or any nested array the runtime flattened; see `_isFromArray`).
    // Positional reconciliation of siblings written out by hand is always
    // right and no key would change it, yet the check counted them too: a
    // sidebar of four literal `<div>` panes warned on every boot of the
    // visual app manager, and the reader learned to skip the channel.
    if (!someKeyed && someUnkeyed && nextChildren.length > 2) {
      const vnodeChildren = nextChildren.filter(
        (c) =>
          typeof c === "object" && typeof c.tag !== "undefined" &&
          _isFromArray(c),
      );
      if (vnodeChildren.length > 2) {
        const tags = new Set(vnodeChildren.map((c) => (c as VNode).tag));
        if (tags.size === 1) {
          // Deduped per SITE, not per kind: on a fixed id a page with three
          // offending parents reported the first and the next surfaced only
          // once that one was fixed (measured on the visual app manager —
          // fix one, reboot, a different one appears). The location suffix
          // IS the site, so it is the id; each distinct one warns once, and
          // all of them show up on the first boot.
          const where = _whereInTree(parent, nextChildren);
          _devWarn(
            `missing-keys${where}`,
            `${vnodeChildren.length} <${
              String([...tags][0])
            }> children without keys. Add key props for correct reconciliation.${where}`,
          );
        }
      }
    }
    if (someKeyed && someUnkeyed) {
      const where = _whereInTree(parent, nextChildren);
      _devWarn(
        `mixed-keys${where}`,
        "Mixed keyed and unkeyed children — all siblings should have keys or none." +
          where,
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
    diffUnkeyed(
      parent,
      nextChildren,
      oldChildren,
      ctx,
      isSvg,
      diffFn,
      startAnchor,
    );
  }
  return _regionFirst(parent, startAnchor);
}

/** The region's first node, read AFTER the diff mutated it. */
export function _regionFirst(
  parent: Node,
  startAnchor: Node | null,
): Node | null {
  // Exiting nodes (mid animation, owned by no vnode) are stepped over — the
  // region's first node is the first one the reconciler still owns.
  if (!startAnchor) return _firstLive(parent);
  // The anchor sits outside the region, so it must have survived; if it did
  // not, the region's bounds are unknowable and a guess would be worse than
  // an honest null.
  return isChildOf(startAnchor, parent) ? _nextLive(startAnchor) : null;
}

function diffUnkeyed(
  parent: Node,
  nextChildren: (VNode | string | number)[],
  oldChildren: (VNode | string | number)[],
  ctx: RenderCtx,
  isSvg: boolean,
  diffFn: DiffFn,
  // AIO-414: an unkeyed Fragment shares `parent` with its siblings — its region
  // starts AFTER this node, not at parent.firstChild. diffKeyed already honored
  // this (AIO-395) but diffUnkeyed did not, so a text-only Fragment sitting after
  // other children reconciled from parent.firstChild and clobbered those earlier
  // siblings (the "component's nodes get overwritten by a following fragment's
  // text" corruption). All positional walks + inserts are anchored to the region.
  startAnchor: Node | null = null,
): void {
  const regionStart: Node | null = startAnchor
    ? _nextLive(startAnchor)
    : _firstLive(parent);

  // Snapshot DOM nodes for old children BEFORE mutations, walking from the
  // region start. `cursor` ends at the node just past the region — a stable
  // reference (outside the region) used as the insertion anchor for new nodes so
  // growth lands inside the region instead of at the parent's end.
  const oldDoms: (Node | null)[] = [];
  let cursor: Node | null = regionStart;
  for (let i = 0; i < oldChildren.length; i++) {
    const child = oldChildren[i]!;
    const dom = getDom(child);
    if (dom) {
      oldDoms.push(dom);
      const count = _domNodeCount(child);
      for (let j = 0; j < count; j++) {
        cursor = _nextLive(cursor);
      }
    } else {
      oldDoms.push(cursor);
      // Advance by the child's realized span, not a hardcoded 1: a bare
      // string is one node, but a Portal (renders elsewhere) or a component
      // that rendered null occupies zero — advancing past the following
      // sibling there duplicates/misplaces it (AIO-414 " tail" duplication).
      const count = _domNodeCount(child);
      for (let j = 0; j < count; j++) {
        cursor = _nextLive(cursor);
      }
    }
  }
  const regionEnd: Node | null = cursor; // node after the region (or null = end)

  // Departures FIRST, as diffKeyed does — the surplus old children go before
  // any new child is built. They used to go last, after the positional walk
  // had already created the new nodes, and a `ref` shared by an old child at
  // the tail and a new child near the head (the same element, moved deeper —
  // `<A ref={r}/>` wrapped into `<><A ref={r}/></>`) was set to the new node
  // and then NULLED by the tail removal, leaving `r` empty while its element
  // was on screen. Unmount-then-mount is also the order every other commit
  // path uses (`_diff` on a type mismatch, `diffKeyed`), so `onCleanup` of the
  // departing runs before `onMount` of the arriving here too.
  for (let i = nextChildren.length; i < oldChildren.length; i++) {
    removeDom(parent, oldChildren[i]!, ctx, oldDoms[i] ?? null);
  }

  const max = nextChildren.length;
  for (let i = 0; i < max; i++) {
    const nc = nextChildren[i]!;
    const oc = i < oldChildren.length ? oldChildren[i]! : null;

    if (oc == null) {
      const newDom = createDom(nc, ctx, isSvg, parent);
      if (newDom) parent.insertBefore(newDom, regionEnd);
    } else if (
      (typeof nc === "string" || typeof nc === "number") &&
      (typeof oc === "string" || typeof oc === "number")
    ) {
      const oldDom = oldDoms[i];
      if (oldDom && oldDom.nodeType === 3) {
        if (String(nc) !== String(oc)) oldDom.textContent = String(nc);
      } else {
        // The cursor points at something that is NOT a text node — the
        // positional model has desynced. This branch used to `removeChild` it:
        // a silent deletion of a DOM element the vnode tree still owns (its
        // vnode keeps a `_dom` pointing at a detached node, so it stops
        // updating), with no warning even in dev — while `_diff`'s own
        // text branch, for the identical situation, KEEPS the node and warns.
        // Two deciders for one question. There is now one: `_diff`'s.
        diffFn(parent, nc, oc, ctx, isSvg, oldDom ?? regionEnd);
      }
    } else {
      // The positional node is the ONLY handle on a bare-text old child: it
      // has no `_dom`. Passing it is what keeps `_diff` from having to guess
      // (it used to scan `parent.childNodes` for a text node with equal
      // content and matched whichever equal-valued node came first — often one
      // this very pass had just inserted, silently rendering the wrong order).
      diffFn(parent, nc!, oc!, ctx, isSvg, oldDoms[i] ?? null);
    }
  }
}

/** Move a child's ENTIRE realized span to sit right after `lastPlaced`, and
 *  return the new `lastPlaced`.
 *
 *  A keyed child is not always one node: a Fragment, a boundary, or a component
 *  that renders either of those spans N siblings. Moving "its `_dom`" moves the
 *  first node and strands the rest, and walking its children via `getDom` skips
 *  bare text (a primitive carries no `_dom`) — a reordered `<>{"a"}<b/></>`
 *  left the `"a"` behind. The span is contiguous by construction, so it is
 *  taken by node count: exact, and blind to what the children happen to be. */
function _placeSpan(
  parent: Node,
  first: Node,
  count: number,
  lastPlaced: Node | null,
): Node | null {
  const nodes: Node[] = [];
  let n: Node | null = first;
  for (let i = 0; i < count && n; i++) {
    nodes.push(n);
    n = _nextLive(n);
  }
  let placed = lastPlaced;
  for (const node of nodes) {
    // The anchor skips exiting nodes: a row still fading out is not a slot in
    // the list, and treating it as one is what sent it to the bottom.
    const anchor: Node | null = placed ? _nextLive(placed) : _firstLive(parent);
    if (node !== anchor) parent.insertBefore(node, anchor);
    placed = node;
  }
  return placed;
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
  // AIO-417: duplicate keys are an app bug (dev warns above), but they must
  // degrade gracefully. Old duplicates shadowed in oldMap were never removed
  // (orphan DOM nodes), and next duplicates re-matched the same old vnode,
  // stealing its single DOM node. Track shadowed old dups for removal.
  const oldShadowedDups: VNode[] = [];

  // Start walking the DOM from the Fragment's anchor (if any) so the
  // DOM→vnode mapping is aligned for Fragments whose region sits mid-parent.
  // Walking from parent.firstChild would assume the region starts at the
  // parent's first child and misalign non-keyed DOM nodes for mid-parent
  // Fragments, removing/moving the wrong nodes.
  let cursor: Node | null = startAnchor
    ? _nextLive(startAnchor)
    : _firstLive(parent);
  for (const oc of (oldChildren as (VNode | string | number)[])) {
    if (
      typeof oc === "object" && oc !== null && (oc as VNode).key !== undefined
    ) {
      const prevDup = oldMap.get((oc as VNode).key!);
      if (prevDup) oldShadowedDups.push(prevDup); // AIO-417: last-wins, remove shadowed
      oldMap.set((oc as VNode).key!, oc as VNode);
      const count = _domNodeCount(oc);
      for (let j = 0; j < count; j++) {
        cursor = _nextLive(cursor);
      }
    } else {
      oldNonKeyed.push(oc);
      const dom = getDom(oc);
      if (dom) {
        oldNonKeyedDoms.push(dom);
        const count = _domNodeCount(oc);
        for (let j = 0; j < count; j++) {
          cursor = _nextLive(cursor);
        }
      } else {
        oldNonKeyedDoms.push(cursor);
        // Advance by realized span (AIO-414): 0 for Portal / null-rendering
        // component, 1 for bare text — a hardcoded 1 skips the next sibling.
        const count = _domNodeCount(oc);
        for (let j = 0; j < count; j++) {
          cursor = _nextLive(cursor);
        }
      }
    }
  }

  // The keys `next` asks for — known BEFORE any placement, which is what lets
  // the departures happen first (below).
  const nextKeys = new Set<string | number>();
  for (const nc of (nextChildren as (VNode | string | number)[])) {
    if (typeof nc === "object" && nc !== null && nc.key !== undefined) {
      nextKeys.add(nc.key);
    }
  }

  // Remove old keyed nodes not in next — BEFORE placing the survivors, not
  // after. A deferred removal (exit animation) leaves its node in the DOM, and
  // a node that is not yet FLAGGED as exiting is indistinguishable from a live
  // slot: placement anchored on it and pushed the survivors past the dying row,
  // so `["a","b","c"] → ["a","c"]` rendered `a,c,b` — the dying row teleported
  // to the bottom for the whole fade. Departures first, then placement, and the
  // anchors only ever see nodes the tree still owns.
  for (const oc of oldChildren) {
    if (oc.key !== undefined && !nextKeys.has(oc.key)) {
      removeDom(parent, oc, ctx);
      // If the removal was DEFERRED for an exit animation, remember which key
      // the surviving node belongs to (see _cancelExitFor).
      _markExitKey(getDom(oc), oc.key);
    }
  }
  // AIO-417: shadowed old duplicates whose key IS used are matched by nothing —
  // remove them or they orphan. (Unused keys are already handled just above,
  // which iterates oldChildren and thus removes every dup of an unused key.)
  for (const oc of oldShadowedDups) {
    if (nextKeys.has(oc.key!)) removeDom(parent, oc, ctx);
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
        diffFn(parent, nc, onk as VNode, ctx, isSvg, onkDom);
        const dom = (nc as VNode)._dom ?? (onk as VNode)._dom;
        if (dom) {
          lastPlaced = _placeSpan(
            parent,
            dom,
            _domNodeCount(nc as VNode),
            lastPlaced,
          );
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
          if (isChildOf(onkDom, parent)) parent.removeChild(onkDom!);
        }
        if (textDom) {
          const a: Node | null = lastPlaced
            ? _nextLive(lastPlaced)
            : _firstLive(parent);
          if (textDom !== a) parent.insertBefore(textDom, a);
          lastPlaced = textDom;
        }
      } else {
        // Type mismatch or no old match — remove old, create new (AIO-181)
        if (onk != null) removeDom(parent, onk, ctx, onkDom);
        const newDom = createDom(
          nc as VNode | string | number,
          ctx,
          isSvg,
          parent,
        );
        if (newDom) {
          const anchor = lastPlaced
            ? _nextLive(lastPlaced)
            : _firstLive(parent);
          parent.insertBefore(newDom, anchor);
          lastPlaced = newDom;
        }
      }
      continue;
    }
    const key = (nc as VNode).key!;
    // AIO-417: a duplicate key in nextChildren must NOT re-match the old vnode
    // its first occurrence already consumed — that would move the same DOM node
    // twice (one position ends up empty). Treat later occurrences as new.
    const oc = usedKeys.has(key) ? undefined : oldMap.get(key);
    usedKeys.add(key);

    if (oc) {
      // Existing node — diff in place
      diffFn(parent, nc, oc, ctx, isSvg);
      const dom = nc._dom ?? oc._dom;
      // AIO-177: a Fragment/boundary/component child spans N nodes — move the
      // whole span, not just its first node.
      if (dom) {
        lastPlaced = _placeSpan(parent, dom, _domNodeCount(nc), lastPlaced);
      }
    } else {
      // A key coming BACK while its old row is still animating out must
      // replace that row, not stack a second one beside it.
      _cancelExitFor(parent, key);
      // New node — create and insert at correct position
      const newDom = createDom(nc, ctx, isSvg, parent);
      if (newDom) {
        const anchor2: Node | null = lastPlaced
          ? _nextLive(lastPlaced)
          : _firstLive(parent);
        parent.insertBefore(newDom, anchor2);
        // AIO-177/AIO-248: a multi-node child (Fragment, boundary, or a
        // component that renders one) arrives as a DocumentFragment that the
        // insertion empties — `newDom` is then nobody's position. `lastPlaced`
        // did not move, so the first inserted node is the one after it;
        // advance to the LAST one so the next child lands beyond the span.
        let node: Node | null = lastPlaced
          ? _nextLive(lastPlaced)
          : _firstLive(parent);
        for (let i = 1; i < _domNodeCount(nc) && node; i++) {
          node = _nextLive(node);
        }
        if (node) lastPlaced = node;
      }
    }
  }

  // Remove excess old non-keyed children not matched above (AIO-114)
  for (let i = nkIdx; i < oldNonKeyed.length; i++) {
    removeDom(parent, oldNonKeyed[i]!, ctx, oldNonKeyedDoms[i] ?? null);
  }
}
