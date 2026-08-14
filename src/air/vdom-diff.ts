// AIO VDOM diff — core reconciliation dispatcher.
// Imports boundary logic and child diffing from sub-modules.

import { bindSignalProps } from "./signal-binding.ts";
import {
  _applyActions,
  _bindSignalTextChildren,
  _cleanupActions,
  _cleanupSignalTextChildren,
} from "./vdom-helpers.ts";
import { _callRef, _staticEqual, _tagComponentError } from "./vdom-create.ts";
import { _componentName } from "./hook-error.ts";
import {
  _hasSignalPropChange,
  applyChildDependentProps,
  applyProps,
} from "./vdom-props.ts";
import { _advance, getDom, isChildOf, removeDom } from "./vdom-remove.ts";
import { createDom } from "./vdom-render.ts";
import { _getActiveDelegationRoot, _setDelegationRoot } from "./vdom-events.ts";
import {
  _devMode,
  _devWarn,
  _domNodeCount,
  _LAZY_PENDING,
  _Null,
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
      if (oldDom && isChildOf(oldDom, parent)) {
        parent.insertBefore(fresh, oldDom);
      } else {
        parent.appendChild(fresh);
        _devWarn(
          "text-no-position",
          `A text child (${JSON.stringify(String(old))} → ${
            JSON.stringify(String(next))
          }) was diffed without its DOM position, so it was appended instead ` +
            `of updated in place. This is an aio bug; please report the ` +
            `component's child shape.`,
        );
      }
      return fresh;
    }
    if (String(next) !== String(old)) dom.textContent = String(next);
    return dom;
  }

  // Type mismatch (text vs vnode or different tags)
  if (
    typeof next !== typeof old ||
    (typeof next === "object" && typeof old === "object" &&
      (next as VNode).tag !== (old as VNode).tag)
  ) {
    const anchor = getDom(old) ?? oldDom;
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

  // Null placeholder — transfer DOM reference (AIO-107)
  if (nv.tag === _Null) {
    nv._dom = ov._dom;
    return nv._dom ?? null;
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
    const firstDom = getDom(ov) ?? oldDom;
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
    if (_devMode && nv._rendered === undefined) {
      _assertRegionAlignment(nv, nv._dom ?? null, false);
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
    nv._dom = ov._dom;
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
  } catch (e) {
    ctx.hooks?.abortComponent?.(nv, hookState);
    if (e !== _LAZY_PENDING) _tagComponentError(e, nv.tag);
    throw e;
  }
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
        ov._dom ?? oldDom,
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

function _diffPortal(nv: VNode, ov: VNode, ctx: RenderCtx): void {
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
    if (oldTarget) {
      let cursor: Node | null = oldTarget.firstChild;
      for (const child of ov.children) {
        const at = getDom(child) ?? cursor;
        cursor = _advance(at, _domNodeCount(child));
        removeDom(oldTarget, child, ctx, at);
      }
    }
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
      for (const child of nv.children) {
        const dom = createDom(child, ctx, false, target);
        if (dom) target.appendChild(dom);
      }
    } else if (oldTarget !== target) {
      let cursor: Node | null = oldTarget.firstChild;
      for (const child of ov.children) {
        const at = getDom(child) ?? cursor;
        cursor = _advance(at, _domNodeCount(child));
        removeDom(oldTarget, child, ctx, at);
      }
      for (const child of nv.children) {
        const dom = createDom(child, ctx, false, target);
        if (dom) target.appendChild(dom);
      }
    } else {
      _diffChildren(target, nv.children, ov.children, ctx, false);
    }
  } finally {
    _setDelegationRoot(prevDelegation);
  }
}

/** Dev-only reactivity invariant (AIO-412): after a diff, the region a vnode
 *  owns must hold its children's realized nodes IN ORDER — child i's node is
 *  the n-th node of the region, where n = Σ _domNodeCount(children before it).
 *
 *  The original check compared COUNTS only, and only for elements. Every defect
 *  this class produces is an order/identity error at a perfectly correct count
 *  — a text node reconciled into a sibling's slot, a fragment that adopted a
 *  detached anchor, two equal-valued strings swapped — so it fired for one
 *  reproduction in eight and the class shipped. Walking positions catches them
 *  at the source in dev, where the diff that caused it is still on the stack,
 *  instead of via a user's "the value isn't updating" report.
 *
 *  Bare text is verified by node type + content (a primitive has no identity to
 *  compare); everything that carries a `_dom` is verified by identity.
 *
 *  Skipped when the element opts out of vnode-owned children — a `ref` or `use`
 *  action may mutate the DOM imperatively, and dangerouslySetInnerHTML injects
 *  untracked nodes — so the check never cries wolf on legitimate escape hatches.
 *
 *  `exact` (elements only) additionally requires the region to END with the
 *  last child: an element owns ALL of its childNodes, a fragment does not. */
function _assertRegionAlignment(
  nv: VNode,
  first: Node | null,
  exact: boolean,
): void {
  const p = nv.props;
  if (p.ref || p.use || p.dangerouslySetInnerHTML) return;
  const label = `<${_componentName(nv.tag)}>`;
  const bad = (why: string) =>
    _devWarn(
      `child-desync-${String(nv.tag)}`,
      `${label} ${why} after diff — the child reconciler desynced (nodes ` +
        `lost/duplicated, or dynamic text written to the wrong slot). This ` +
        `is an aio bug; please report the component's child shape.`,
    );
  let cursor: Node | null = first;
  for (let i = 0; i < nv.children.length; i++) {
    const child = nv.children[i]!;
    const count = _domNodeCount(child);
    if (count === 0) continue; // Portal / component that rendered nothing
    if (!cursor) return bad(`ran out of DOM nodes at child ${i}`);
    if (typeof child === "object") {
      const d = getDom(child);
      if (d && d !== cursor) {
        return bad(`holds the wrong node at child ${i}`);
      }
    } else if (
      cursor.nodeType !== 3 || cursor.textContent !== String(child)
    ) {
      return bad(
        `holds ${
          cursor.nodeType === 3
            ? JSON.stringify(cursor.textContent)
            : `a <${(cursor as Element).nodeName?.toLowerCase()}>`
        } where the text child ${i} (${JSON.stringify(String(child))}) belongs`,
      );
    }
    cursor = _advance(cursor, count);
  }
  if (exact && cursor) bad("has leftover DOM children");
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
    _devWarn(
      `diff-no-dom-${String(nv.tag)}`,
      `<${String(nv.tag)}> has no DOM node to diff against — it will stop ` +
        `updating. The previous vnode was rendered without a _dom (partial ` +
        `hydration, or an earlier reconciler failure). This is an aio bug; ` +
        `please report the component's shape.`,
    );
    return;
  }
  nv._dom = dom;

  const tag = nv.tag as string;
  const nowSvg = isSvg || SVG_TAGS.has(tag);

  applyProps(dom, nv.props, ov.props);

  if (_hasSignalPropChange(nv.props, ov.props)) {
    bindSignalProps(dom as HTMLElement, nv.props);
  }

  if (nv.props.ref !== ov.props.ref) {
    if (ov.props.ref) _callRef(ov.props.ref, null, _componentName(ov.tag));
    if (nv.props.ref) _callRef(nv.props.ref, dom, _componentName(nv.tag));
  }

  if (nv.props.use !== ov.props.use) {
    _cleanupActions(dom);
    if (nv.props.use) _applyActions(dom, nv.props.use);
  }

  _diffChildren(dom, nv.children, ov.children, ctx, nowSvg);

  // Props that only take effect once the children exist (`<select value>`) —
  // after the child diff, so options created in THIS pass are selectable.
  applyChildDependentProps(dom, nv.props, ov.props);

  if (_devMode) _assertRegionAlignment(nv, dom.firstChild, true);

  if (nv._signalChildren || ov._signalChildren) {
    _cleanupSignalTextChildren(dom);
    if (nv._signalChildren) {
      _bindSignalTextChildren(dom, nv._signalChildren, nv.children);
    }
  }
}
