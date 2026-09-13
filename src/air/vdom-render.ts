// AIO VDOM render — createDom and _render.
// Creates real DOM from VNode trees. Depends on helpers + remove (getDom).

import { bindSignalProps } from "./signal-binding.ts";
import { _applyActions, _bindSignalText } from "./vdom-helpers.ts";
import {
  _attachRef,
  _enterCommit,
  _leaveCommit,
  _notANode,
  _registerLazyListeners,
  _tagComponentError,
  nullSlot,
} from "./vdom-create.ts";
import { _componentName } from "./hook-error.ts";
import { applyChildDependentProps, applyProps } from "./vdom-props.ts";
import { _removeDomCleanup, getDom } from "./vdom-remove.ts";
import { _getActiveDelegationRoot, _setDelegationRoot } from "./vdom-events.ts";
import {
  _devA11yCheckFn,
  _hasRawHtml,
  _LAZY_PENDING,
  _Null,
  _SignalText,
  childSvgMode,
  ErrorBoundary,
  Fragment,
  Portal,
  Suspense,
  SVG_TAGS,
} from "./vdom-types.ts";
import type { ComponentFn, RenderCtx, VNode } from "./vdom-types.ts";
import { _boundaryStack, _noteDiscard } from "./renderer-state.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

/** The node a just-created child actually OCCUPIES once appended.
 *
 *  `createDom` returns a DocumentFragment for a Fragment/boundary child — a
 *  carrier that `appendChild` empties and leaves detached. Recording it as the
 *  container's first node (`_dom`) therefore anchored the container to a node
 *  that is not in the document: every later diff found `isChildOf` false, fell
 *  back to "the region starts at parent.firstChild", and reconciled the
 *  fragment's children against its EARLIER SIBLINGS' nodes. The component
 *  branch already unwrapped this (AIO-167); the Fragment/EB/Suspense child
 *  loops did not. */
export function _occupied(
  child: VNode | string | number,
  childDom: Node,
): Node | null {
  return childDom.nodeType === 11 ? getDom(child) : childDom;
}

/** What a boundary that is SHOWING its fallback holds as `_rendered`: the
 *  fallback, or a `nullSlot()` when the fallback renders nothing.
 *
 *  `_rendered != null` is how every walker asks "is this boundary in its
 *  fallback?" — the diff (retry vs. patch the children), the teardown walks,
 *  the discarded-subtree sweep. A fallback of `null` (`fallback={() => null}`,
 *  or a `<Suspense>` with no fallback) stored `null` there and so answered
 *  "no": the next diff patched the DISCARDED children as if they were on
 *  screen, so the boundary never came back once the error cleared, and a
 *  later fall-back retired a region it did not own — measured, the sibling
 *  after the boundary was deleted. A fallback of nothing is a POSITION, like a
 *  component that renders nothing, and holds it with the same placeholder;
 *  both SSR writers emit its comment. @internal */
export function _fallbackSlot(
  fallback: VNode | string | number | null | undefined,
): VNode | string | number {
  return fallback ?? nullSlot();
}

/** The slot of a NEW component whose throw was contained (see the component
 *  branch of `createDom`): the enclosing boundary's fallback, or an empty
 *  placeholder. A fallback that itself fails to build is reported and the slot
 *  stays empty — it must not unwind the pass the containment protects. */
function _containedSlot(
  vnode: VNode,
  error: unknown,
  ctx: RenderCtx,
  isSvg: boolean,
  parentDom: Node | undefined,
): Node | null {
  let shown: VNode | string | number | undefined;
  try {
    const found = ctx.hooks?.containedFallback?.(error) ?? null;
    if (found) {
      shown = _fallbackSlot(found.fallback);
      const dom = createDom(shown, ctx, isSvg, parentDom);
      vnode._rendered = shown;
      vnode._dom = (dom ? _occupied(shown, dom) : null) ?? undefined;
      return dom;
    }
  } catch (fallbackError) {
    console.error("[aio:vdom] ErrorBoundary fallback threw:", fallbackError);
    // Whatever the fallback built before it threw goes with it.
    if (shown !== undefined && typeof shown === "object") {
      try {
        _removeDomCleanup(shown, ctx);
      } catch { /* a malformed fallback node: nothing below it was built */ }
    }
  }
  const slot = nullSlot();
  const comment = ctx.doc.createComment("");
  slot._dom = comment;
  vnode._rendered = slot;
  vnode._dom = comment;
  return comment;
}

/** An empty container holds its SLOT with a comment anchor (AIO-195).
 *
 *  Without one it has no `_dom`, so the next diff cannot tell where its region
 *  begins and falls back to "the parent's first child" — a list that starts
 *  empty and then fills renders ABOVE its header. That was fixed for `Fragment`
 *  and left unfixed for `ErrorBoundary` and `Suspense`, which are the same kind
 *  of thing: a region of the parent shared with siblings. `_domNodeCount` and
 *  `_updateContainerDom` already counted the anchor for all three — only the
 *  three CREATION paths (mount, SSR, hydrate) disagreed, so `<ErrorBoundary>`
 *  around a list that starts empty put its rows in the wrong place on mount and
 *  grew a stray comment on the first re-render. */
function _anchorEmpty(ctx: RenderCtx, frag: Node, vnode: VNode): void {
  const anchor = ctx.doc.createComment("");
  frag.appendChild(anchor);
  vnode._dom = anchor;
}

/** Mount a vnode under `parent`.
 *
 *  One of the THREE reconciler entry points (`_render`, `_diff`, `_hydrateNode`)
 *  that open a COMMIT — see `_enterCommit`. Everything below them nests, so a
 *  ref sees its node once the whole commit is in the document and a ref that
 *  moves between elements is never left holding `null`. */
export function _render(
  parent: Node,
  vnode: VNode | string | number | null,
  _oldVnode: VNode | string | number | null,
  ctx: RenderCtx,
  isSvg = false,
): void {
  if (vnode == null) return;
  _enterCommit();
  try {
    const dom = createDom(vnode, ctx, isSvg, parent);
    if (dom) parent.appendChild(dom);
  } finally {
    _leaveCommit();
  }
}

/** Create real DOM nodes from a VNode tree — handles elements, text, fragments, and components. */
export function createDom(
  vnode: VNode | string | number,
  ctx: RenderCtx,
  isSvg: boolean,
  parentDom?: Node,
): Node | null {
  if (typeof vnode === "string" || typeof vnode === "number") {
    return ctx.doc.createTextNode(String(vnode));
  }

  // Not a VNode at all — an array, a boolean, a promise, a plain object. The
  // most common cause is a component returning a LIST (`return items.map(…)`),
  // which React allows and AIR does not. It used to die eleven frames deeper on
  // `Cannot use 'in' operator to search for 'onInput' in undefined`, naming
  // nothing; `_tagComponentError` adds the component to this one.
  const bad = _notANode(vnode);
  if (bad) throw new Error(bad);

  // Null placeholder — comment node preserving child position (AIO-107)
  if (vnode.tag === _Null) {
    const comment = ctx.doc.createComment("");
    vnode._dom = comment;
    return comment;
  }

  // Signal child — one text node that follows the signal (see _SignalText)
  if (vnode.tag === _SignalText) {
    const text = ctx.doc.createTextNode("");
    _bindSignalText(vnode, text);
    vnode._dom = text;
    return text;
  }

  // Component — call hooks, invoke function, recurse on output
  if (typeof vnode.tag === "function") {
    const hookState = ctx.hooks?.beforeComponent(
      vnode,
      null,
      parentDom ?? ctx.doc.body,
      isSvg,
    );
    let rendered: VNode | string | number | null;
    try {
      rendered = (vnode.tag as ComponentFn)({
        ...vnode.props,
        children: vnode.children.length > 0
          ? vnode.children
          : (vnode.props.children ?? vnode.children),
      });
    } catch (e) {
      ctx.hooks?.abortComponent?.(vnode, hookState);
      if (e !== _LAZY_PENDING) {
        _tagComponentError(e, vnode.tag);
        // Contained during a re-render pass: a NEW component has no last good
        // output, so its slot shows what an existing component that throws
        // there shows — the enclosing `<ErrorBoundary>`'s fallback, in its
        // place — or, outside any boundary, an empty slot (the same thing a
        // component that rendered `null` leaves). Either way it is retried
        // when a signal its failed render read changes.
        //
        // The fallback used to be skipped: an `<ErrorBoundary>` ABOVE the
        // component that re-rendered is not on the boundary stack during that
        // pass, so a child mounted by the pass (`{open && <Panel/>}`) that
        // threw left a blank where its boundary promised a fallback.
        if (ctx.hooks?.isolateComponentError?.(vnode, null, e, hookState)) {
          return _containedSlot(vnode, e, ctx, isSvg, parentDom);
        }
      }
      throw e;
    }
    // A component that renders nothing still OCCUPIES its written position —
    // the placeholder is what the next diff inserts before. See nullSlot().
    if (rendered == null) rendered = nullSlot();
    vnode._rendered = rendered;
    try {
      ctx.hooks?.afterComponent(vnode, rendered, hookState);
      let dom: Node | null;
      try {
        dom = createDom(rendered, ctx, isSvg, parentDom);
      } catch (e) {
        // A child's render failed — record this component on the error's
        // component chain (the innermost already stamped the message).
        if (e !== _LAZY_PENDING) _tagComponentError(e, vnode.tag);
        throw e;
      }
      // AIO-167: if rendered is a Fragment, dom is a DocumentFragment that becomes
      // empty after insertion. Store the first child DOM instead (via getDom on the
      // rendered VNode) so the component has a valid position anchor for future diffs.
      vnode._dom = (dom && dom.nodeType === 11)
        ? (getDom(rendered) ?? undefined)
        : (dom ?? undefined);
      return dom;
    } finally {
      ctx.hooks?.afterSubtree?.(vnode);
    }
  }

  // ErrorBoundary — render children with error catching
  if (vnode.tag === ErrorBoundary) {
    const fallback = vnode.props.fallback as
      | ((e: Error) => VNode | string | number | null)
      | undefined;
    // Recorded for the RE-RENDER path. A throw at mount unwinds to the catch
    // below; a throw on a later re-render happens long after this stack is
    // gone, so each component mounted in here remembers the boundary it is
    // inside (see `_currentBoundary`). Without it a component that starts
    // throwing mid-session keeps its last good output forever — the subtree
    // silently stops updating, which for the wallet in report 1 §22.1 is a panel
    // that quietly stops being true.
    _boundaryStack.push(vnode);
    try {
      const frag = ctx.doc.createDocumentFragment();
      let firstDom: Node | null = null;
      for (const child of vnode.children) {
        const childDom = createDom(child, ctx, isSvg, parentDom);
        if (childDom) {
          if (!firstDom) firstDom = _occupied(child, childDom);
          frag.appendChild(childDom);
        }
      }
      if (firstDom) vnode._dom = firstDom;
      else _anchorEmpty(ctx, frag, vnode);
      return frag;
    } catch (error) {
      // What the children built before the throw is discarded here or by the
      // boundary above — retired by the region's owner (`_sweepDiscarded`). A
      // throw that was not a component body's (a malformed child) passes no
      // `abortComponent`, so the boundary records it itself — the same rule
      // as `_diffErrorBoundary`; without it a boundary MOUNTED over a malformed
      // child kept one discarded wrapper per mount, past unmount.
      _noteDiscard();
      // AIO-178: re-throw _LAZY_PENDING so Suspense can handle it
      if (error === _LAZY_PENDING) throw error;
      if (!fallback) throw error;
      // A fallback that renders nothing is still SHOWING the fallback — see
      // `_fallbackSlot`.
      const fallbackVnode = _fallbackSlot(fallback(error as Error));
      vnode._rendered = fallbackVnode;
      const dom = createDom(fallbackVnode, ctx, isSvg, parentDom);
      // The node the fallback OCCUPIES — never the DocumentFragment a Fragment
      // fallback returns, which insertion empties and leaves detached (AIO-167
      // for the happy path; the fallback branch had the same hole, so a
      // boundary showing a multi-node fallback had no position at all).
      vnode._dom = (dom ? _occupied(fallbackVnode, dom) : null) ?? undefined;
      return dom;
    } finally {
      _boundaryStack.pop();
    }
  }

  // Suspense — render children, catch lazy pending and show fallback
  if (vnode.tag === Suspense) {
    const fallback = vnode.props.fallback as
      | VNode
      | string
      | number
      | null
      | undefined;
    try {
      const frag = ctx.doc.createDocumentFragment();
      let firstDom: Node | null = null;
      for (const child of vnode.children) {
        const childDom = createDom(child, ctx, isSvg, parentDom);
        if (childDom) {
          if (!firstDom) firstDom = _occupied(child, childDom);
          frag.appendChild(childDom);
        }
      }
      if (firstDom) vnode._dom = firstDom;
      else _anchorEmpty(ctx, frag, vnode);
      return frag;
    } catch (thrown) {
      // Same as the ErrorBoundary catch above: this build is discarded.
      _noteDiscard();
      if (thrown !== _LAZY_PENDING) throw thrown;
      // Register for lazy resolution notifications
      _registerLazyListeners(vnode.children, ctx);
      // Lazy child not ready — render fallback (none is a placeholder, see
      // `_fallbackSlot`)
      const shown = _fallbackSlot(fallback);
      vnode._rendered = shown;
      const dom = createDom(shown, ctx, isSvg, parentDom);
      vnode._dom = (dom ? _occupied(shown, dom) : null) ?? undefined;
      return dom;
    }
  }

  // Portal — render children into target DOM node
  if (vnode.tag === Portal) {
    const target = vnode.props.target as Node;
    if (!target) return null;
    // AIO-184: try-finally ensures delegation root is restored on error
    const prevDelegation = _getActiveDelegationRoot();
    if ((target as Node).nodeType === 1) {
      _setDelegationRoot(target as Element);
    }
    try {
      // A portal's content is a REGION of the target, not the whole of it.
      // When the target already holds something — another portal (a modal and
      // a toast both into `document.body`), or static markup — this region
      // does not begin at `target.firstChild`, and every positional walk that
      // assumed it did rewrote the OTHER content: a keyed reorder inside the
      // second portal dragged its nodes to the FRONT of the target, over the
      // first portal's, and the first portal's growth landed past them.
      // `_anchor` is the comment this region begins after. It is written for
      // EVERY portal, not only the ones that currently need it: a marker that
      // appears only when a neighbour happens to be there is a marker whose
      // presence depends on mount ORDER, so the same model reaches two
      // different documents (mount one portal, mount a second, unmount the
      // first — the survivor keeps an anchor a fresh render never writes).
      // One comment per mounted portal, always.
      const anchor = ctx.doc.createComment("");
      target.appendChild(anchor);
      vnode._anchor = anchor;
      for (const child of vnode.children) {
        const childDom = createDom(child, ctx, false, target);
        if (childDom) target.appendChild(childDom);
      }
    } finally {
      _setDelegationRoot(prevDelegation);
    }
    // Portal has no DOM in its parent — it renders elsewhere
    return null;
  }

  // Fragment — track first child DOM for getDom() lookups
  if (vnode.tag === Fragment) {
    const frag = ctx.doc.createDocumentFragment();
    let firstDom: Node | null = null;
    for (const child of vnode.children) {
      const childDom = createDom(child, ctx, isSvg, parentDom);
      if (childDom) {
        if (!firstDom) firstDom = _occupied(child, childDom);
        frag.appendChild(childDom);
      }
    }
    if (firstDom) vnode._dom = firstDom;
    else _anchorEmpty(ctx, frag, vnode);
    return frag;
  }

  // Element
  const tag = vnode.tag as string;
  const nowSvg = isSvg || SVG_TAGS.has(tag);
  const childSvg = childSvgMode(tag, nowSvg);
  const el = nowSvg
    ? ctx.doc.createElementNS(SVG_NS, tag)
    : ctx.doc.createElement(tag);

  applyProps(el as HTMLElement, vnode.props, {});
  bindSignalProps(el as HTMLElement, vnode.props);
  if (_devA11yCheckFn) _devA11yCheckFn(tag, vnode.props);

  // Raw html owns the content (see _hasRawHtml) — `applyProps` wrote it, and
  // children are not appended after it (SSR never emitted them either).
  if (!_hasRawHtml(vnode.props)) {
    for (let i = 0; i < vnode.children.length; i++) {
      const childDom = createDom(vnode.children[i]!, ctx, childSvg, el);
      if (childDom) el.appendChild(childDom);
    }
  }

  // Props that only take effect once the children exist (`<select value>`).
  applyChildDependentProps(el as HTMLElement, vnode.props, {});

  // Call ref after element + children are fully built
  if (vnode.props.ref) {
    _attachRef(vnode.props.ref, el, _componentName(vnode.tag));
  }
  if (vnode.props.use) _applyActions(el as HTMLElement, vnode.props.use);

  vnode._dom = el;
  return el;
}
