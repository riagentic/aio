// AIO VDOM boundary diffing — ErrorBoundary and Suspense reconciliation.
// Separated from vdom-diff.ts for size. Uses DiffFn + DiffChildrenFn callbacks.

import { _domNodeCount, _LAZY_PENDING } from "./vdom-types.ts";
import type { RenderCtx, VNode } from "./vdom-types.ts";
import {
  _advance,
  _firstLive,
  _isExiting,
  _nextLive,
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

/** The region's first live node, before any mutation.
 *
 *  `_nextLive`/`_firstLive`, not `nextSibling`/`firstChild`: a node kept in the
 *  DOM only to finish its exit animation belongs to no vnode, so counting it as
 *  the region's first node put a boundary's whole span one position off. A
 *  `<Suspense>`/`<ErrorBoundary>` (or a Fragment region) that fell back while a
 *  sibling row was fading out rebuilt its content around the dying node —
 *  measured as content appended after the region, and as the dev child-desync
 *  tripwire firing on a legitimate exit. Everywhere else the reconciler already
 *  steps over them; inside a boundary it did not. */
function _regionStart(
  parent: Node,
  ov: VNode,
  startAnchor: Node | null,
): Node | null {
  const d = getDom(ov);
  if (d && isChildOf(d, parent) && !_isExiting(d)) return d;
  return startAnchor && isChildOf(startAnchor, parent)
    ? _nextLive(startAnchor)
    : _firstLive(parent);
}

/** The live node that FOLLOWS the boundary's old region, or null when the
 *  region ends the parent.
 *
 *  The span is taken from `_domNodeCount(ov)` and walked from the region's
 *  first node: exact, and blind to what the region happens to hold. Scanning
 *  backwards for a member carrying a `_dom` is neither — a bare string/number
 *  is a primitive with nowhere to hold one (so a string fallback answered "the
 *  region ends the parent" and the boundary re-inserted it at the END of its
 *  parent's children on every re-render: `<Suspense fallback="Loading…">` and
 *  `<ErrorBoundary fallback={() => "Oops"}>`, the two most ordinary spellings
 *  there are, visibly jumped to the bottom of the page), a Fragment's `_dom` is
 *  its FIRST node so the scan landed inside a multi-node fallback, and an EMPTY
 *  region is one comment ANCHOR that is not a child at all. `_domNodeCount`
 *  already answers all three. The scan stays as the last resort for when the
 *  region's position is unknown. */
function _regionAnchor(
  parent: Node,
  ov: VNode,
  first: Node | null,
): Node | null {
  if (first && isChildOf(first, parent)) {
    return _advance(first, _domNodeCount(ov));
  }
  const region = ov._rendered !== undefined ? [ov._rendered] : ov.children;
  for (let i = region.length - 1; i >= 0; i--) {
    const v = region[i];
    if (v == null) continue;
    const d = getDom(v as VNode | string | number);
    // `_nextLive`: the node after the region's last child may be a sibling
    // that is only finishing its exit animation, and anchoring the boundary's
    // new content before a node the reconciler no longer owns inserts it in
    // the wrong slot for the whole duration of that animation.
    if (d && isChildOf(d, parent)) return _nextLive(d);
  }
  return null;
}

/** Remove a whole region, walking it positionally so bare-text children —
 *  which carry no `_dom` and are therefore invisible to `getDom` — are removed
 *  too instead of being left behind on the page.
 *
 *  `end` is the node just PAST the region and is a hard stop. Without it the
 *  walk could step outside it: the child diff may have thrown PART WAY THROUGH
 *  (`diffKeyed` removes a type-mismatched child before creating its
 *  replacement, and creating the replacement is exactly what throws), so the
 *  region is already shorter than the model being replayed over it — and the
 *  last bare-text child's cursor then landed on the boundary's NEXT SIBLING and
 *  removed it. Keyed children inside an `<ErrorBoundary>` that start throwing
 *  silently deleted the node after the boundary. */
function _removeRegion(
  parent: Node,
  children: (VNode | string | number)[],
  ctx: RenderCtx,
  first: Node | null,
  end: Node | null = null,
): void {
  let cursor: Node | null = first;
  for (const child of children) {
    const at = getDom(child) ?? cursor;
    if (at && at === end) break; // the region ran out before the model did
    cursor = _advance(at, _domNodeCount(child));
    removeDom(parent, child, ctx, at);
  }
}

/** Retire the boundary's whole old region.
 *
 *  Every child goes through `removeDom` first, so unmount hooks, refs and exit
 *  transitions still fire. Then whatever is STILL standing between the region's
 *  bounds is swept: an empty region is a comment ANCHOR that is not one of the
 *  children (nothing removed it, so it stayed as a phantom node the boundary's
 *  own node count does not include, putting every later sibling one position
 *  off), and a child diff that threw part way through may have left nodes it
 *  created behind.
 *
 *  The bounds are measured BEFORE the failed attempt, and the sweep only runs
 *  when the region's position was actually known — a guessed start is not
 *  something to bulk-delete from. */
function _retireRegion(
  parent: Node,
  ov: VNode,
  ctx: RenderCtx,
  first: Node | null,
  startAnchor: Node | null,
  end: Node | null,
): void {
  const d = getDom(ov);
  const known = !!(d && isChildOf(d, parent));
  _removeRegion(parent, ov.children, ctx, first, end);
  if (!known) return;
  let n: Node | null = startAnchor && isChildOf(startAnchor, parent)
    ? _nextLive(startAnchor)
    : _firstLive(parent);
  while (n && n !== end) {
    // `_nextLive` and the skip: a node mid-exit is NOT leftover debris from a
    // failed diff — `removeDom` deliberately left it standing so its exit
    // animation can finish, and it removes itself when it does. Sweeping it
    // here tore the animation off the screen AND leaked the exiting-node
    // counter (nothing would ever clear the flag on a node the reconciler
    // detached behind the animation's back), which slows every positional walk
    // in the process for the rest of the session.
    const next: Node | null = _nextLive(n);
    if (!_isExiting(n)) parent.removeChild(n);
    n = next;
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

  // Where the boundary's region sits, measured BEFORE anything is removed.
  // It used to be measured again inside `catch`, by which point the try block
  // had already detached the old fallback — every lookup then found a node that
  // was no longer in the document, answered "the region ends the parent", and
  // the fallback was appended at the END of the parent instead of put back
  // where the boundary lives.
  const oldFirst = _regionStart(parent, ov, startAnchor);
  const at = _regionAnchor(parent, ov, oldFirst);

  try {
    if (wasError) {
      // Recovering from error: build the children FIRST and only then retire
      // the fallback. Removing it up front meant that when the children failed
      // AGAIN — the normal case for a boundary that stays in its fallback, and
      // for every Suspense re-render during a load — the catch had nothing
      // left to patch and had to build a whole new fallback, so the fallback's
      // DOM was destroyed and re-created on EVERY render: a spinner's CSS
      // animation restarted from frame zero each time, and focus, selection
      // and scroll inside an error fallback were lost.
      const frag = ctx.doc.createDocumentFragment();
      let firstDom: Node | null = null;
      for (const child of nv.children) {
        const childDom = createDom(child, ctx, isSvg, parent);
        if (childDom) {
          if (!firstDom) firstDom = _occupied(child, childDom);
          frag.appendChild(childDom);
        }
      }
      const produced = frag.firstChild;
      removeDom(parent, ov._rendered!, ctx, oldFirst);
      if (produced) {
        _insertAt(parent, frag, at);
        nv._dom = firstDom ?? produced;
      } else {
        // Recovering into EMPTY content. `createDom` gives an empty boundary a
        // comment ANCHOR to hold its slot (AIO-195) and this path did not, so
        // a boundary that came back from its fallback with nothing to show —
        // `<ErrorBoundary>{rows.map(...)}</ErrorBoundary>` retried while the
        // list is empty — was left with no position at all. The next diff then
        // anchored its whole region at the parent's FIRST child and the rows
        // grew ABOVE the header. Same rule as mount, on the path nobody
        // re-checked.
        const anchor = ctx.doc.createComment("");
        _insertAt(parent, anchor, at);
        nv._dom = anchor;
      }
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
    nv._rendered = fallbackVnode;
    if (wasError && ov._rendered != null) {
      // Already showing a fallback and still failing — PATCH it. The nodes on
      // screen are the ones the user is looking at; rebuilding them because the
      // error happens to still be there is the reconciler doing the one thing
      // it exists to avoid.
      nv._dom = _diffFn(
        parent,
        fallbackVnode,
        ov._rendered,
        ctx,
        isSvg,
        oldFirst,
      ) ?? undefined;
      return;
    }
    _retireRegion(parent, ov, ctx, oldFirst, startAnchor, at);
    if (fallbackVnode != null) {
      const dom = createDom(fallbackVnode, ctx, isSvg, parent);
      // The node the fallback OCCUPIES, not the carrier `createDom` returned: a
      // bare-string fallback has no `_dom` to look up and a Fragment's carrier
      // is a DocumentFragment that insertion empties and leaves detached, so
      // the boundary was left anchored to nothing and lost its slot.
      const first = dom ? _occupied(fallbackVnode, dom) : null;
      if (dom) _insertAt(parent, dom, at);
      nv._dom = first ?? undefined;
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
  // Measured before any removal — see the same comment in _diffErrorBoundary.
  const oldFirst = _regionStart(parent, ov, startAnchor);
  const at = _regionAnchor(parent, ov, oldFirst);
  try {
    if (wasPending) {
      // Was showing fallback, try rendering children again — same slot. The
      // fallback is retired only once they SUCCEED (see _diffErrorBoundary).
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
      const produced = frag.firstChild;
      removeDom(parent, ov._rendered!, ctx, oldFirst);
      if (produced) {
        _insertAt(parent, frag, at);
        nv._dom = firstDom ?? produced;
      } else {
        // Recovering into EMPTY content. `createDom` gives an empty boundary a
        // comment ANCHOR to hold its slot (AIO-195) and this path did not, so
        // a boundary that came back from its fallback with nothing to show —
        // `<ErrorBoundary>{rows.map(...)}</ErrorBoundary>` retried while the
        // list is empty — was left with no position at all. The next diff then
        // anchored its whole region at the parent's FIRST child and the rows
        // grew ABOVE the header. Same rule as mount, on the path nobody
        // re-checked.
        const anchor = ctx.doc.createComment("");
        _insertAt(parent, anchor, at);
        nv._dom = anchor;
      }
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
    nv._rendered = fallback ?? null;
    if (wasPending && ov._rendered != null && fallback != null) {
      // Still pending — patch the fallback that is already on screen instead of
      // rebuilding it. This is the whole duration of a lazy load, so rebuilding
      // restarted a spinner's animation on every render in between.
      nv._dom = _diffFn(parent, fallback, ov._rendered, ctx, isSvg, oldFirst) ??
        undefined;
      return;
    }
    if (!wasPending) {
      _retireRegion(parent, ov, ctx, oldFirst, startAnchor, at);
    } else if (ov._rendered != null) {
      removeDom(parent, ov._rendered, ctx, oldFirst);
    }
    if (fallback != null) {
      const dom = createDom(fallback, ctx, isSvg, parent);
      const first = dom ? _occupied(fallback, dom) : null;
      if (dom) _insertAt(parent, dom, at);
      nv._dom = first ?? undefined;
    }
  }
}
