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
import { _hasSignalPropChange, applyProps } from "./vdom-props.ts";
import { getDom, isChildOf, removeDom } from "./vdom-remove.ts";
import { _render, createDom } from "./vdom-render.ts";
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

/** Wrapper that binds _diff into diffChildren (breaks circular dep). */
function _diffChildren(
  parent: Node,
  nextChildren: (VNode | string | number)[],
  oldChildren: (VNode | string | number)[],
  ctx: RenderCtx,
  isSvg: boolean,
  startAnchor: Node | null = null,
): void {
  _diffChildrenRaw(
    parent,
    nextChildren,
    oldChildren,
    ctx,
    isSvg,
    _diff,
    startAnchor,
  );
}

export function _diff(
  parent: Node,
  next: VNode | string | number | null,
  old: VNode | string | number | null,
  ctx: RenderCtx,
  isSvg = false,
): void {
  if (old === next) return;

  // Remove
  if (next == null) {
    if (old != null) removeDom(parent, old, ctx);
    return;
  }

  // Add
  if (old == null) {
    _render(parent, next, null, ctx, isSvg);
    return;
  }

  // Text nodes
  if (
    (typeof next === "string" || typeof next === "number") &&
    (typeof old === "string" || typeof old === "number")
  ) {
    let dom = getDom(old);
    // AIO-156: bare strings have no _dom — scan parent's childNodes as fallback
    if (!dom) {
      const oldStr = String(old);
      for (let i = 0; i < parent.childNodes.length; i++) {
        const cn = parent.childNodes[i]!;
        if (cn.nodeType === 3 && cn.textContent === oldStr) {
          dom = cn;
          break;
        }
      }
    }
    if (dom && String(next) !== String(old)) {
      dom.textContent = String(next);
    }
    return;
  }

  // Type mismatch (text vs vnode or different tags)
  if (
    typeof next !== typeof old ||
    (typeof next === "object" && typeof old === "object" &&
      (next as VNode).tag !== (old as VNode).tag)
  ) {
    let anchor = getDom(old);
    // AIO-416: bare strings/numbers carry no _dom, so getDom() misses them —
    // scan for the matching text node (same AIO-156 fallback the text→text
    // branch uses). Without this, a text→vnode transition (e.g. "mid" → null
    // placeholder) appended the replacement at the parent's END and left the
    // stale text node in place (removeDom can't locate bare text either).
    let bareTextDom: Node | null = null;
    if (!anchor && (typeof old === "string" || typeof old === "number")) {
      const oldStr = String(old);
      for (let i = 0; i < parent.childNodes.length; i++) {
        const cn = parent.childNodes[i]!;
        if (cn.nodeType === 3 && cn.textContent === oldStr) {
          bareTextDom = cn;
          break;
        }
      }
      anchor = bareTextDom;
    }
    const newDom = createDom(next, ctx, isSvg, parent);
    if (newDom && anchor && isChildOf(anchor, parent)) {
      parent.insertBefore(newDom, anchor);
    } else if (newDom) {
      parent.appendChild(newDom);
    }
    removeDom(parent, old, ctx);
    if (bareTextDom && isChildOf(bareTextDom, parent)) {
      parent.removeChild(bareTextDom);
    }
    return;
  }

  // Same tag VNodes — patch in place
  const nv = next as VNode;
  const ov = old as VNode;

  // Static VNode short-circuit
  if (nv._static && ov._static && nv.tag === ov.tag && _staticEqual(nv, ov)) {
    _copyStaticDom(nv, ov);
    return;
  }

  // Null placeholder — transfer DOM reference (AIO-107)
  if (nv.tag === _Null) {
    nv._dom = ov._dom;
    return;
  }

  // Components
  if (typeof nv.tag === "function") {
    _diffComponent(parent, nv, ov, ctx, isSvg);
    return;
  }

  // ErrorBoundary
  if (nv.tag === ErrorBoundary) {
    _diffErrorBoundary(parent, nv, ov, ctx, isSvg, _diff, _diffChildren);
    return;
  }

  // Suspense
  if (nv.tag === Suspense) {
    _diffSuspense(parent, nv, ov, ctx, isSvg, _diff, _diffChildren);
    return;
  }

  // Portal
  if (nv.tag === Portal) {
    _diffPortal(nv, ov, ctx);
    return;
  }

  // Fragment
  if (nv.tag === Fragment) {
    // AIO-395: a Fragment shares `parent` with its siblings — anchor the
    // children diff at the node preceding the fragment's current region so
    // keyed moves stay inside the region instead of jumping to parent start.
    const firstDom = getDom(ov);
    const startAnchor = firstDom && isChildOf(firstDom, parent)
      ? firstDom.previousSibling
      : null;
    _diffChildren(parent, nv.children, ov.children, ctx, isSvg, startAnchor);
    _updateContainerDom(parent, nv, ov, ctx);
    return;
  }

  // Element
  _diffElement(parent, nv, ov, ctx, isSvg);
}

function _diffComponent(
  parent: Node,
  nv: VNode,
  ov: VNode,
  ctx: RenderCtx,
  isSvg: boolean,
): void {
  nv._instance = ov._instance;
  const hookState = ctx.hooks?.beforeComponent(nv, ov, parent, isSvg);

  // deno-lint-ignore no-explicit-any
  if (hookState && (hookState as any).skip) {
    nv._rendered = ov._rendered;
    nv._dom = ov._dom;
    ctx.hooks?.afterComponent(nv, nv._rendered ?? null, hookState);
    return;
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
    try {
      _diff(parent, rendered ?? null, ov._rendered ?? null, ctx, isSvg);
    } catch (e) {
      // A child's render failed — record this component on the chain.
      if (e !== _LAZY_PENDING) _tagComponentError(e, nv.tag);
      throw e;
    }
    nv._dom = rendered ? (getDom(rendered) ?? undefined) : undefined;
  } finally {
    ctx.hooks?.afterSubtree?.(nv);
  }
}

function _diffPortal(nv: VNode, ov: VNode, ctx: RenderCtx): void {
  const target = nv.props.target as Node;
  const oldTarget = ov.props.target as Node | undefined;
  if (!target) return;
  // AIO-184: try-finally ensures delegation root is restored on error
  const prevDelegation = _getActiveDelegationRoot();
  if ((target as Node).nodeType === 1) {
    _setDelegationRoot(target as Element);
  }
  try {
    if (oldTarget && oldTarget !== target) {
      for (const child of ov.children) removeDom(oldTarget, child, ctx);
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

/** Dev-only reactivity invariant (AIO-412): an element that exclusively owns its
 *  children must, after a diff, hold exactly Σ _domNodeCount(child) DOM nodes. A
 *  mismatch means the child-reconciliation cursor desynced — nodes lost, dupli-
 *  cated, or dynamic text written to the wrong slot: the silent-corruption /
 *  frozen-node class. Catching it here surfaces the defect at its source in dev
 *  instead of via a user's "the value isn't updating" report.
 *
 *  Skipped when the element opts out of vnode-owned children — a `ref` or `use`
 *  action may mutate the DOM imperatively, and dangerouslySetInnerHTML injects
 *  untracked nodes — so the check never cries wolf on legitimate escape hatches. */
function _assertChildAlignment(dom: Node, nv: VNode): void {
  const p = nv.props;
  if (p.ref || p.use || p.dangerouslySetInnerHTML) return;
  let expected = 0;
  for (const c of nv.children) expected += _domNodeCount(c);
  const actual = dom.childNodes.length;
  if (expected !== actual) {
    _devWarn(
      `child-desync-${String(nv.tag)}`,
      `<${
        String(nv.tag)
      }> has ${actual} DOM children after diff but its vnode tree expects ` +
        `${expected} — the child reconciler desynced (nodes lost/duplicated or ` +
        `dynamic text mis-placed). This is an aio bug; please report the ` +
        `component's child shape.`,
    );
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

  if (_devMode) _assertChildAlignment(dom, nv);

  if (nv._signalChildren || ov._signalChildren) {
    _cleanupSignalTextChildren(dom);
    if (nv._signalChildren) {
      _bindSignalTextChildren(dom, nv._signalChildren, nv.children);
    }
  }
}
