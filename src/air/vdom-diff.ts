// AIO VDOM diff — core reconciliation dispatcher.
// Imports boundary logic and child diffing from sub-modules.

import { bindSignalProps } from "./signal-binding.ts";
import { isDevMode } from "../state/dev-flag.ts";
import { devHooks } from "./dev-hooks.ts";
import {
  _actionsChanged,
  _applyActions,
  _bindSignalText,
  _cleanupActions,
  _unbindSignalText,
} from "./vdom-helpers.ts";
import {
  _attachRef,
  _detachRef,
  _enterCommit,
  _keepsTyped,
  _leaveCommit,
  _saysTypedKept,
  _staticEqual,
  _tagComponentError,
  _throwIfNotANode,
  nullSlot,
} from "./vdom-create.ts";
import { _componentName } from "./hook-error.ts";
import {
  _hasSignalPropChange,
  applyChildDependentProps,
  applyProps,
} from "./vdom-props.ts";
import {
  _advance,
  _firstLive,
  _liveFirstDom,
  _removeDomCleanup,
  _supersededPortals,
  getDom,
  isChildOf,
  removeDom,
} from "./vdom-remove.ts";
import { createDom } from "./vdom-render.ts";
import { _detachReused } from "./vdom-reuse.ts";
import { _getActiveDelegationRoot, _setDelegationRoot } from "./vdom-events.ts";
import {
  _BUG,
  _domNodeCount,
  _hasRawHtml,
  _LAZY_PENDING,
  _MOVED,
  _Null,
  _SignalText,
  _wrong,
  childSvgMode,
  ErrorBoundary,
  Fragment,
  Portal,
  Suspense,
  SVG_TAGS,
} from "./vdom-types.ts";
import type { ComponentFn, RenderCtx, VNode } from "./vdom-types.ts";
import { diffChildren as _diffChildrenRaw } from "./vdom-diff-children.ts";
import {
  _diffErrorBoundary,
  _diffSuspense,
  _updateContainerDom,
} from "./vdom-diff-boundary.ts";

/** The dev half of "has no DOM node to diff against" (`_BUG`, the half a
 *  production page says too, is vdom-types'). */
const _NO_DOM = " The previous vnode was rendered without a _dom (partial " +
  "hydration, or an earlier reconciler failure).";

/** Carry `_dom` across an unchanged static subtree, at every depth.
 *
 *  The static short-circuit skips diffing because `_staticEqual` proved the two
 *  trees identical — but the NEW vnodes then own the DOM, so each must inherit
 *  its node's handle. Copying only the top two levels left grandchildren with
 *  `_dom: undefined`: the next render could not find their nodes, so removals
 *  silently no-oped and replacements were appended instead of swapped
 *  (duplicated/stale DOM in element-only subtrees like `div > span > b`).
 *  Recursion mirrors `_staticEqual`'s traversal, so exactly what was compared
 *  is what gets transferred. */
function _copyStaticDom(nv: VNode, ov: VNode): void {
  nv._dom = ov._dom;
  const n = Math.min(nv.children.length, ov.children.length);
  for (let i = 0; i < n; i++) {
    const nc = nv.children[i];
    const oc = ov.children[i];
    if (
      nc !== null && oc !== null && typeof nc === "object" &&
      typeof oc === "object"
    ) {
      _copyStaticDom(nc as VNode, oc as VNode);
    }
  }
}

/** The node a freshly-created vnode occupies: its `_dom` when it tracks one,
 *  otherwise the created node itself (bare text — the one kind that cannot).
 *  Never the DocumentFragment a Fragment/boundary returns: that is emptied by
 *  insertion and is nobody's position. */
function _realized(v: VNode | string | number, created: Node | null):
  | Node
  | null {
  if (typeof v === "object" && v !== null) return v._dom ?? null;
  return created;
}

/** Wrapper that binds _diff into diffChildren (breaks circular dep). */
function _diffChildren(
  parent: Node,
  nextChildren: (VNode | string | number)[],
  oldChildren: (VNode | string | number)[],
  ctx: RenderCtx,
  isSvg: boolean,
  startAnchor: Node | null = null,
): Node | null {
  return _diffChildrenRaw(
    parent,
    nextChildren,
    oldChildren,
    ctx,
    isSvg,
    _diff,
    startAnchor,
  );
}

/** Reconcile `old` → `next` inside `parent`; returns the FIRST DOM node `next`
 *  occupies afterwards, or null when it occupies none.
 *
 *  `oldDom` is the node `old` positionally occupies — or, when `old` occupies
 *  no node at all (null, a Portal, a component that rendered null), the node
 *  that FOLLOWS its empty slot, which is exactly the right insertion anchor.
 *
 *  Position is threaded rather than searched for because a bare string/number
 *  child is a primitive: it has nowhere to hold a `_dom`. The reconciler used
 *  to recover by scanning `parent.childNodes` for a text node with equal
 *  content (AIO-156/AIO-416) — which finds the FIRST equal-valued text node,
 *  not the right one. Two siblings with the same text (`{" "}` separators,
 *  repeated labels, equal numbers) were therefore reconciled into each other's
 *  nodes: `["a",<div/>] ← [<div/>,"a"]` re-rendered byte-identical DOM while
 *  the model had changed, with no warning. The caller always knows the
 *  position; nothing else does. */
export function _diff(
  parent: Node,
  next: VNode | string | number | null,
  old: VNode | string | number | null,
  ctx: RenderCtx,
  isSvg = false,
  oldDom: Node | null = null,
): Node | null {
  // One of the THREE reconciler entry points that open a COMMIT (see
  // `_enterCommit`). Its own recursion re-enters here and merely nests: the
  // OUTERMOST call is the commit, so every ref this diff detaches is nulled
  // before any ref it attaches is set — the order React commits in, and the
  // only order in which a ref that MOVES (retag, reorder, re-key, wrap) ends up
  // holding its element instead of `null`.
  _enterCommit();
  try {
    return _diffNode(parent, next, old, ctx, isSvg, oldDom);
  } finally {
    _leaveCommit();
  }
}

function _diffNode(
  parent: Node,
  next: VNode | string | number | null,
  old: VNode | string | number | null,
  ctx: RenderCtx,
  isSvg = false,
  oldDom: Node | null = null,
): Node | null {
  if (old === next) {
    return typeof next === "object" && next !== null
      ? (next._dom ?? null)
      : (next == null ? null : oldDom);
  }

  // Remove
  if (next == null) {
    if (old != null) removeDom(parent, old, ctx, oldDom);
    return null;
  }

  // Add — `oldDom` is the node following the empty slot, so the new content
  // lands in the slot instead of at the parent's end.
  if (old == null) {
    const created = createDom(next, ctx, isSvg, parent);
    if (created) {
      if (oldDom && isChildOf(oldDom, parent)) {
        parent.insertBefore(created, oldDom);
      } else {
        parent.appendChild(created);
      }
    }
    return _realized(next, created);
  }

  // Text nodes
  if (
    (typeof next === "string" || typeof next === "number") &&
    (typeof old === "string" || typeof old === "number")
  ) {
    const dom = oldDom && oldDom.nodeType === 3 ? oldDom : null;
    if (!dom) {
      // No position, or the caller's cursor points at something that is not a
      // text node: the old text cannot be located, so the update would be
      // silently dropped. Replace it positionally rather than pretend.
      const fresh = ctx.doc.createTextNode(String(next));
      // Said in dev and in production (`_wrong`): the positional model
      // desynced, which is a reconciler bug, not an app one.
      const what = `A text child (${JSON.stringify(String(old))} → ${
        JSON.stringify(String(next))
      }) was diffed `;
      if (oldDom && isChildOf(oldDom, parent)) {
        parent.insertBefore(fresh, oldDom);
        // The node in the way is real and stays: deleting it would take a
        // subtree the vnode tree still owns.
        _wrong(
          "text-cursor-not-text",
          `${what}against a <${
            (oldDom as Element).nodeName ?? "?"
          }> instead of its text node, so it was written next to it rather ` +
            `than updated in place.${_MOVED}`,
          ` The node in the way was kept.`,
        );
      } else {
        parent.appendChild(fresh);
        _wrong(
          "text-no-position",
          `${what}without its DOM position, so it was appended instead ` +
            `of updated in place.${_MOVED}`,
        );
      }
      return fresh;
    }
    if (String(next) !== String(old)) dom.textContent = String(next);
    return dom;
  }

  // Type mismatch (text vs vnode or different tags) — REPLACE.
  //
  // The replacement is BUILT and inserted before the old subtree is removed,
  // and the order is load-bearing: the old node is the only positional handle
  // this parent's other cursors have. Tearing down first moves every following
  // sibling up, and the caller's cursors — a boundary replaying its region, a
  // child loop holding pre-walked positions — then point one node off, so a
  // bare-text sibling was left on the page and the replacement landed after it
  // (a `<Suspense>` flipping to its fallback stranded `{"1"}` beside it).
  //
  // A `ref` shared by the departing and the arriving element (`<p ref={r}/>`
  // retagged to `<i ref={r}/>`) is NOT what decides this order: refs attach at
  // the END of the commit and detach at once (see `_enterCommit`), so the ref
  // holds the new node whichever way round the DOM work happens. Ordering a
  // commit around a ref would trade a silent DOM corruption for a tidier
  // lifecycle, which is the wrong way round.
  if (
    typeof next !== typeof old ||
    (typeof next === "object" && typeof old === "object" &&
      (next as VNode).tag !== (old as VNode).tag)
  ) {
    const anchor = _liveFirstDom(old) ?? oldDom;
    const newDom = createDom(next, ctx, isSvg, parent);
    if (newDom && anchor && isChildOf(anchor, parent)) {
      parent.insertBefore(newDom, anchor);
    } else if (newDom) {
      parent.appendChild(newDom);
    }
    removeDom(parent, old, ctx, oldDom);
    return _realized(next, newDom);
  }

  // Same tag VNodes — patch in place
  const nv = next as VNode;
  const ov = old as VNode;

  // Static VNode short-circuit
  if (nv._static && ov._static && nv.tag === ov.tag && _staticEqual(nv, ov)) {
    _copyStaticDom(nv, ov);
    return nv._dom ?? null;
  }

  // A control that keeps what was typed into it (`_keepsTyped`), rendered
  // again with the same props: left alone, and said once if it shows it.
  if (
    nv.tag === ov.tag && _keepsTyped(nv) && _keepsTyped(ov) &&
    _staticEqual(nv, ov)
  ) {
    _copyStaticDom(nv, ov);
    _saysTypedKept(nv);
    return nv._dom ?? null;
  }

  // Null placeholder — transfer DOM reference (AIO-107)
  if (nv.tag === _Null) {
    nv._dom = ov._dom;
    return nv._dom ?? null;
  }

  // Signal child — the text node is kept; so is the effect when the signal is
  // the same one (nothing to rebind, and no per-render dispose/re-subscribe
  // churn). A different signal takes the node over.
  if (nv.tag === _SignalText) {
    const text = ov._dom as Text | undefined;
    if (!text) {
      _wrong(
        "diff-no-dom-signal-text",
        `A signal child has no text node to diff against — it will stop ` +
          `updating.${_BUG}`,
        _NO_DOM,
      );
      return null;
    }
    nv._dom = text;
    if (nv._sig === ov._sig && ov._unbind) {
      nv._unbind = ov._unbind;
      ov._unbind = undefined;
    } else {
      _unbindSignalText(ov);
      _bindSignalText(nv, text);
    }
    return text;
  }

  // Components
  if (typeof nv.tag === "function") {
    return _diffComponent(parent, nv, ov, ctx, isSvg, oldDom);
  }

  // ErrorBoundary / Suspense / Fragment — a REGION of `parent` shared with
  // siblings. The region starts after `startAnchor`; every child insert, move
  // and the container's own `_dom` are resolved against it (AIO-395).
  if (
    nv.tag === ErrorBoundary || nv.tag === Suspense || nv.tag === Fragment
  ) {
    const firstDom = _liveRegionFirst(parent, ov, oldDom);
    const startAnchor = firstDom && isChildOf(firstDom, parent)
      ? firstDom.previousSibling
      : null;
    if (nv.tag === ErrorBoundary) {
      _diffErrorBoundary(
        parent,
        nv,
        ov,
        ctx,
        isSvg,
        _diff,
        _diffChildren,
        startAnchor,
      );
    } else if (nv.tag === Suspense) {
      _diffSuspense(
        parent,
        nv,
        ov,
        ctx,
        isSvg,
        _diff,
        _diffChildren,
        startAnchor,
      );
    } else {
      const regionFirst = _diffChildren(
        parent,
        nv.children,
        ov.children,
        ctx,
        isSvg,
        startAnchor,
      );
      _updateContainerDom(parent, nv, ov, ctx, regionFirst);
    }
    // A boundary showing its FALLBACK does not hold its children at all — its
    // region is the fallback. Checking the children against it reported a
    // desync for every correct render in that state: an app whose
    // ErrorBoundary had caught, or whose Suspense was still loading, printed
    // "this is an aio bug; please report" on every re-render. A tripwire that
    // fires when nothing is wrong is worse than none — it teaches the reader
    // to ignore the real one. `_rendered` is undefined exactly on the happy
    // path (Fragment never sets it).
    if (isDevMode() && nv._rendered === undefined) {
      devHooks.assertAligned?.(nv, nv._dom ?? null, false);
    }
    return nv._dom ?? null;
  }

  // Portal
  if (nv.tag === Portal) {
    _diffPortal(nv, ov, ctx);
    return null;
  }

  // Element
  _diffElement(parent, nv, ov, ctx, isSvg);
  return nv._dom ?? null;
}

/** Where a region's old content starts in `parent`, for a region whose own
 *  `_dom` may be STALE.
 *
 *  A container's `_dom` is refreshed only when the CONTAINER is diffed. A child
 *  component re-renders on its own — `<Outlet>` hands its route children
 *  through as the same vnode objects, and each one reads `routePath` itself —
 *  and when its first node is replaced (a `null` placeholder becoming a `<p>`,
 *  the index route giving way to `:id`) the fragment around it still points at
 *  the detached node. The start anchor then came out null, which reads as "the
 *  region starts at the parent's FIRST child": the fragment adopted the
 *  `<h1>` before it as its `_dom`, and the alignment tripwire rightly said the
 *  region "holds the wrong node at child 0" on the docs' own nested-route
 *  example. The DOM survived only because nothing moved in that pass; a diff
 *  that did move nodes would have walked from the wrong place.
 *
 *  The children know better than the container: an old child's `_dom` is
 *  kept current by its own re-render. Only the FIRST child that occupies
 *  nodes can say where the region starts (a bare text child has no `_dom`, so
 *  it says nothing), and only while it is still in `parent`. A fallback
 *  boundary's children are not realized, so it is not asked. */
function _liveRegionFirst(
  parent: Node,
  ov: VNode,
  oldDom: Node | null,
): Node | null {
  // The children FIRST, even when the container's own copy is still attached:
  // a copy can be attached and still wrong. A child component whose keyed
  // output reorders on its own (`<>{"x"}<em key/></>` → `<><em key/>{"x"}</>`)
  // MOVES the text node the enclosing fragment holds as its first — the node
  // is in `parent`, just no longer first, so the region was read as starting
  // one node late and a sibling this pass added landed past the region's end
  // (after the footer that follows it).
  if (ov._rendered === undefined) {
    for (const child of ov.children) {
      if (_domNodeCount(child) === 0) continue;
      const d = _liveFirstDom(child);
      if (d && isChildOf(d, parent)) return d;
      break;
    }
  }
  const own = getDom(ov);
  if (own && isChildOf(own, parent)) return own;
  return own ?? oldDom;
}

function _diffComponent(
  parent: Node,
  nv: VNode,
  ov: VNode,
  ctx: RenderCtx,
  isSvg: boolean,
  oldDom: Node | null = null,
): Node | null {
  nv._instance = ov._instance;
  const hookState = ctx.hooks?.beforeComponent(nv, ov, parent, isSvg);

  // deno-lint-ignore no-explicit-any
  if (hookState && (hookState as any).skip) {
    nv._rendered = ov._rendered;
    // The LIVE first node of the output, not `ov`'s copy of it. A component
    // BELOW this one re-renders on its own and swaps its root element — one
    // dialog giving way to the next — and no ancestor's copy hears about it.
    // Carrying the copy across an auto-memo skip handed the child reconciler a
    // DETACHED node as this child's position, and the caller then re-inserted
    // that node: a list whose rows moved in the same pass grew a second,
    // resurrected copy of the swapped-away element (`<p>L</p>` back beside the
    // `<b>L</b>` that replaced it). Its quieter half is the dev alignment
    // tripwire calling a correct render a desync (a field report).
    nv._dom = _liveFirstDom(ov) ?? ov._dom;
    ctx.hooks?.afterComponent(nv, nv._rendered ?? null, hookState);
    return nv._dom ?? null;
  }

  let rendered: VNode | string | number | null;
  try {
    rendered = (nv.tag as ComponentFn)({
      ...nv.props,
      children: nv.children.length > 0
        ? nv.children
        : (nv.props.children ?? nv.children),
    });
    _throwIfNotANode(rendered);
  } catch (e) {
    ctx.hooks?.abortComponent?.(nv, hookState);
    if (e !== _LAZY_PENDING) {
      _tagComponentError(e, nv.tag);
      // Contained (no boundary inside this re-render pass): the component's
      // body threw BEFORE its subtree was touched, so its old output is still
      // exactly what is on screen — keep it, and let the rest of the pass
      // finish. Unwinding instead abandoned the parent's diff half-applied.
      if (ctx.hooks?.isolateComponentError?.(nv, ov, e, hookState)) {
        nv._rendered = ov._rendered;
        nv._dom = _liveFirstDom(ov) ?? ov._dom; // live, as on the skip path
        return nv._dom ?? null;
      }
    }
    throw e;
  }
  // Same rule as the create path: nothing to render is still a POSITION.
  // Without the placeholder the component had no `_dom` anchor, so when it
  // later returned an element the reconciler appended it to the parent
  // instead of putting it back where it was written (R-10).
  if (rendered == null) rendered = nullSlot();
  // A vnode this output MOVES while it is still mounted where the old output
  // put it gets a fresh copy first — see vdom-reuse.ts.
  rendered = _detachReused(rendered, ov._rendered);
  nv._rendered = rendered;
  try {
    ctx.hooks?.afterComponent(nv, rendered, hookState);
    let dom: Node | null;
    try {
      // A component that renders a bare string owns a TEXT node, which
      // `getDom(rendered)` can never see — `nv._dom` was therefore dropped on
      // the first diff and the next one had no position at all, so the
      // component wrote into whichever sibling happened to hold equal text.
      // The reconciler hands the node back instead.
      dom = _diff(
        parent,
        rendered ?? null,
        ov._rendered ?? null,
        ctx,
        isSvg,
        // The LIVE first node, not this vnode's copy of it: a component below
        // that re-rendered on its own swapped the node without telling any
        // ancestor's copy, so the old position handed to the diff was a
        // detached node and a pass that moved nodes walked from the wrong
        // place.
        _liveFirstDom(ov) ?? oldDom,
      );
    } catch (e) {
      // A child's render failed — record this component on the chain.
      if (e !== _LAZY_PENDING) _tagComponentError(e, nv.tag);
      throw e;
    }
    nv._dom = dom ?? undefined;
    return dom;
  } finally {
    ctx.hooks?.afterSubtree?.(nv);
  }
}

/** Mount a portal's children into `target`, opening its region with the
 *  anchor comment every portal gets (see `VNode._anchor`). */
function _mountPortalContent(target: Node, vnode: VNode, ctx: RenderCtx): void {
  const anchor = ctx.doc.createComment("");
  target.appendChild(anchor);
  vnode._anchor = anchor;
  // Built in front of an END marker so a nested same-target Portal's region
  // lands after this one, never inside it — see the Portal branch of
  // `createDom`.
  const end = ctx.doc.createComment("");
  target.appendChild(end);
  try {
    for (const child of vnode.children) {
      const dom = createDom(child, ctx, false, target);
      if (dom) target.insertBefore(dom, end);
    }
  } finally {
    if (end.parentNode === target) target.removeChild(end);
  }
}

function _diffPortal(nv: VNode, ov: VNode, ctx: RenderCtx): void {
  // A vnode object handed back into the tree (a cached element) is live again.
  _supersededPortals.delete(nv);
  const target = nv.props.target as Node;
  const oldTarget = ov.props.target as Node | undefined;
  if (!target) {
    // `<Portal target={cond ? el : null}>`: the portal's content used to be
    // left mounted in the OLD target forever — the returned-early diff removed
    // nothing, transferred no `_dom`, and said nothing. Worse, when the target
    // came back the vnode↔DOM link was broken and the reconciler's own
    // corruption tripwire fired ("has no DOM node to diff against… this is an
    // aio bug"). No target means no content: tear the old children down and
    // carry the link over so the node stays diffable.
    // `removeDom` is the ONE teardown of a portal (its Portal branch): this
    // file had a walk of its own, which took a portal that never mounted —
    // one behind a sibling that threw — for the owner of `target.firstChild`.
    if (oldTarget) removeDom(oldTarget, ov, ctx);
    nv._dom = ov._dom;
    return;
  }
  // AIO-184: try-finally ensures delegation root is restored on error
  const prevDelegation = _getActiveDelegationRoot();
  if ((target as Node).nodeType === 1) {
    _setDelegationRoot(target as Element);
  }
  try {
    if (!oldTarget) {
      // The previous render had NO target, so nothing of this portal is
      // mounted anywhere — the branch above tore it down. Create; diffing here
      // would patch vnodes whose `_dom` is already detached and append
      // nothing, leaving the region permanently empty once a target came back.
      _mountPortalContent(target, nv, ctx);
    } else if (oldTarget !== target) {
      removeDom(oldTarget, ov, ctx);
      _mountPortalContent(target, nv, ctx);
    } else {
      // The portal's region begins after its anchor (see `_anchor`), not at
      // `target.firstChild` — which is another portal's content whenever two
      // portals share a target.
      nv._anchor = ov._anchor;
      const anchor = nv._anchor && isChildOf(nv._anchor, target)
        ? nv._anchor
        : null;
      // Close the region with a temporary END marker for the length of the
      // diff: a nested same-target Portal this diff creates appends to the
      // target, and without the marker a child this diff adds AFTER it (the
      // region's end is "the end of the target") landed behind the nested
      // region — the interleave the Portal branch of `createDom` describes.
      let end: Comment | null = null;
      if (anchor) {
        let total = 0;
        for (const c of ov.children) total += _domNodeCount(c);
        const last = _advance(anchor, total);
        end = ctx.doc.createComment("");
        target.insertBefore(end, last ? last.nextSibling : null);
      }
      try {
        _diffChildren(target, nv.children, ov.children, ctx, false, anchor);
      } finally {
        if (end && end.parentNode === target) target.removeChild(end);
      }
      // The region is the NEW vnode's now; the old one's children describe
      // nodes the diff replaced (see `_supersededPortals`).
      if (ov !== nv) _supersededPortals.add(ov);
    }
  } finally {
    _setDelegationRoot(prevDelegation);
  }
}

function _diffElement(
  _parent: Node,
  nv: VNode,
  ov: VNode,
  ctx: RenderCtx,
  isSvg: boolean,
): void {
  const dom = ov._dom as HTMLElement;
  if (!dom) {
    // A previously-rendered element always has a `_dom`. Without one there is
    // nothing to patch, so this returned quietly — and the element then sat
    // there frozen: `nv._dom` unset, props never applied, children never
    // diffed, no error anywhere to explain why one part of the page had
    // stopped updating. It cannot be repaired from here, but it must not
    // be silent.
    _wrong(
      `diff-no-dom-${String(nv.tag)}`,
      `<${String(nv.tag)}> has no DOM node to diff against — it will stop ` +
        `updating.${_BUG}`,
      _NO_DOM,
    );
    return;
  }
  nv._dom = dom;

  const tag = nv.tag as string;
  const nowSvg = isSvg || SVG_TAGS.has(tag);

  applyProps(dom, nv.props, ov.props);

  if (_hasSignalPropChange(nv.props, ov.props)) {
    bindSignalProps(dom as HTMLElement, nv.props, ov.props);
  }

  if (nv.props.ref !== ov.props.ref) {
    if (ov.props.ref) _detachRef(ov.props.ref, null, _componentName(ov.tag));
    if (nv.props.ref) _attachRef(nv.props.ref, dom, _componentName(nv.tag));
  }

  // By content, not identity: `use={[fn]}` is a new array every render, and
  // identity re-ran (and tore down) the actions on every re-render of the
  // component that wrote them. See `_actionsChanged`.
  if (_actionsChanged(nv.props.use, ov.props.use)) {
    _cleanupActions(dom);
    if (nv.props.use) _applyActions(dom, nv.props.use);
  }

  // Raw html owns the content (see _hasRawHtml). `applyProps` has already
  // written the new html — or cleared it — so the children are reconciled
  // against what the element ACTUALLY holds: nothing, when it held html.
  // Diffing `[]` against the old children here used to walk the freshly
  // injected html nodes as if they were the old children and delete them out
  // of it (children → dih left `<u>a</u><u>b</u><u>c</u>` as `<u>c</u>`).
  const rawNow = _hasRawHtml(nv.props);
  const rawWas = _hasRawHtml(ov.props);
  if (rawNow) {
    // The old children's instances, effects and refs still need retiring —
    // their nodes are already gone with the innerHTML write.
    if (!rawWas) {
      for (const c of ov.children) {
        if (typeof c === "object") _removeDomCleanup(c, ctx);
      }
    }
  } else {
    _diffChildren(
      dom,
      nv.children,
      rawWas ? [] : ov.children,
      ctx,
      childSvgMode(tag, nowSvg),
    );
  }

  // Props that only take effect once the children exist (`<select value>`) —
  // after the child diff, so options created in THIS pass are selectable.
  applyChildDependentProps(dom, nv.props, ov.props);

  // `_firstLive`, not `firstChild`: a node kept in the DOM for its exit
  // animation belongs to no vnode, so counting it made this tripwire cry
  // "this is an aio bug; please report" at a perfectly legitimate <Transition>.
  if (isDevMode()) devHooks.assertAligned?.(nv, _firstLive(dom), true);
}
