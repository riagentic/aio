// AIO VDOM removal — getDom, cleanup, and DOM removal.
// Depends on vdom-helpers (leaf). No deps on vdom-render or vdom-diff.

import { cleanupSignalBindings } from "./signal-binding.ts";
import { _cleanupActions, _unbindSignalText } from "./vdom-helpers.ts";
import { _detachRef } from "./vdom-create.ts";
import { _componentName, _reportHookError } from "./hook-error.ts";
import {
  _devWarn,
  _domNodeCount,
  _hasRawHtml,
  _SignalText,
  ErrorBoundary,
  Fragment,
  Portal,
  Suspense,
} from "./vdom-types.ts";
import type { RenderCtx, VNode } from "./vdom-types.ts";

/** Get the real DOM node associated with a VNode, or null if not mounted. */
export function getDom(vnode: VNode | string | number): Node | null {
  if (typeof vnode === "object" && vnode !== null) {
    return vnode._dom ?? null;
  }
  return null;
}

/** Where a vnode's realized nodes ACTUALLY start — asked of the OUTPUT rather
 *  than of the vnode's own copy of it.
 *
 *  A component, a boundary and a fragment have no DOM of their own: `_dom` is a
 *  COPY of the output's first node, and it is refreshed only when THAT vnode is
 *  diffed. A component nested below re-renders on its own signal and swaps its
 *  root element — one dialog giving way to the next, `<p>` becoming
 *  `<section>` — and the node under every ancestor vnode changes while none of
 *  their copies hears about it. The next parent diff then reads a detached node
 *  as "where child i is": the dev alignment tripwire called a perfectly correct
 *  render a desync ("holds the wrong node at child 6", a field report), and a
 *  pass that DID move nodes would have walked from the wrong place.
 *
 *  The output always knows — an element's `_dom` is the node itself, and a
 *  component's output is kept current by its own re-render. `_dom` stays the
 *  answer wherever there is no realized output to ask: a component that renders
 *  a bare string owns a text node no vnode carries, and an empty fragment owns
 *  only its anchor comment.
 *
 *  The structure mirrors {@linkcode _domNodeCount}, which decides the SPAN the
 *  same cases occupy — the two are read together at every call site, so they
 *  answer from one shape. */
export function _liveFirstDom(child: VNode | string | number): Node | null {
  if (typeof child !== "object" || child === null) return null;
  const tag = child.tag;
  if (typeof tag === "function") {
    const r = child._rendered;
    return (r != null ? _liveFirstDom(r) : null) ?? child._dom ?? null;
  }
  if (tag === Fragment || tag === ErrorBoundary || tag === Suspense) {
    // A boundary showing its FALLBACK sets `_rendered`; on the happy path it
    // (and every Fragment) leaves it undefined and splats its children inline.
    if (child._rendered !== undefined) {
      return (child._rendered !== null
        ? _liveFirstDom(child._rendered)
        : null) ?? child._dom ?? null;
    }
    for (const c of child.children) {
      if (_domNodeCount(c) === 0) continue; // occupies nothing: not the start
      return _liveFirstDom(c) ?? child._dom ?? null;
    }
    return child._dom ?? null;
  }
  return child._dom ?? null;
}

/** True when `node` is a live child of `parent`. A plain `.parentNode ===
 *  parent` identity check breaks under happy-dom, which wraps <form> in a
 *  Proxy (named-element access): a child's .parentNode may be the raw node or
 *  the proxy depending on how it was inserted, while the reconciler holds the
 *  proxy — identity fails even though the child IS inside the parent, so
 *  conditional bindings froze inside <form> under testUI.
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

// ── Exiting nodes ─────────────────────────────────────────────────────

/** A node kept in the DOM only to finish an exit animation.
 *
 *  Deferred removal (see {@link removeDom}) leaves the node in the document
 *  while its vnode leaves the tree — and nothing marked it, so the reconciler's
 *  positional model went out of step with the DOM for the whole animation. Four
 *  measured symptoms, one cause: a keyed `["a","b","c"] → ["a","c"]` rendered
 *  `a,c,b` (the dying row teleported to the bottom for the whole fade); an
 *  unkeyed list clobbered the exiting node and left stale text on the page
 *  forever; the dev child-desync tripwire cried "this is an aio bug" at a
 *  perfectly legitimate exit; and re-adding a key mid-exit showed a duplicate
 *  row. Flagged, every positional walk can step over them and the model is
 *  true again. */
interface ExitState {
  __aioExiting?: true;
  __aioExitKey?: string | number;
  __aioExitCancel?: () => void;
}

/** How many nodes are mid-exit anywhere in the process. Exit animations are
 *  rare and short-lived, while `_nextLive`/`_firstLive` sit on the hot path of
 *  every diff — so when it is zero (the overwhelmingly common case) the walks
 *  are exactly the plain `nextSibling`/`firstChild` they were before. */
let _exiting = 0;

/** True for a node the reconciler no longer owns — it is only finishing its
 *  exit animation. @internal */
export function _isExiting(node: Node | null | undefined): boolean {
  return _exiting > 0 && !!node &&
    (node as unknown as ExitState).__aioExiting === true;
}

/** The next sibling the reconciler can SEE (exiting nodes stepped over). */
export function _nextLive(node: Node | null | undefined): Node | null {
  let n: Node | null = node?.nextSibling ?? null;
  if (_exiting === 0) return n;
  while (n && (n as unknown as ExitState).__aioExiting === true) {
    n = n.nextSibling;
  }
  return n;
}

/** The parent's first reconciler-visible child. */
export function _firstLive(parent: Node): Node | null {
  let n: Node | null = parent.firstChild;
  if (_exiting === 0) return n;
  while (n && (n as unknown as ExitState).__aioExiting === true) {
    n = n.nextSibling;
  }
  return n;
}

/** Flag a node as exiting and record how to end the exit early. @internal */
function _markExiting(dom: Node, cancel: () => void): void {
  const s = dom as unknown as ExitState;
  if (s.__aioExiting !== true) _exiting++;
  s.__aioExiting = true;
  s.__aioExitCancel = cancel;
}

function _clearExiting(dom: Node): void {
  const s = dom as unknown as ExitState;
  if (s.__aioExiting === true) _exiting--;
  delete s.__aioExiting;
  delete s.__aioExitKey;
  delete s.__aioExitCancel;
}

/** Record which KEY an exiting node used to hold, so re-adding that key can
 *  cancel the exit instead of rendering the row twice. @internal */
export function _markExitKey(
  dom: Node | null,
  key: string | number,
): void {
  if (dom && _isExiting(dom)) {
    (dom as unknown as ExitState).__aioExitKey = key;
  }
}

/** End an in-flight exit for `key` under `parent`, if one is running.
 *  Re-adding a key while its exit animates must REPLACE the dying row, not
 *  stack a second one next to it. @internal */
export function _cancelExitFor(parent: Node, key: string | number): void {
  if (_exiting === 0) return; // nothing is exiting — never scan the children
  const kids = parent.childNodes;
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i] as unknown as ExitState;
    if (n.__aioExiting && n.__aioExitKey === key) {
      n.__aioExitCancel?.();
      return;
    }
  }
}

/** Step a positional cursor forward over a child's realized DOM span.
 *  Exiting nodes are not part of any child's span — they belong to no vnode. */
export function _advance(node: Node | null, count: number): Node | null {
  let n = node;
  for (let i = 0; i < count; i++) n = _nextLive(n);
  return n;
}

/** What lives UNDER a vnode — the ONE answer every teardown walk uses.
 *
 *  It is not always `vnode.children`: a component's real subtree is its
 *  `_rendered` output, and an ErrorBoundary/Suspense showing a FALLBACK has its
 *  children unmounted and the fallback in their place. `removeDom` knew that
 *  rule; `_removeDomCleanup` and the root `_unmount` walk did not, so a root
 *  unmount left every fallback subtree mounted — `onCleanup` never fired and a
 *  signal subscription SURVIVED the unmount, while the conditional-removal path
 *  through `removeDom` correctly reached zero. `testUI` teardown uses `_unmount`,
 *  so that was cross-test pollution. Three walkers, one rule. */
export function _cleanupChildren(
  vnode: VNode,
): readonly (VNode | string | number)[] {
  if (typeof vnode.tag === "function") {
    return vnode._rendered != null ? [vnode._rendered] : [];
  }
  if (
    (vnode.tag === ErrorBoundary || vnode.tag === Suspense) &&
    vnode._rendered != null
  ) {
    return [vnode._rendered];
  }
  // …and an element with `dangerouslySetInnerHTML` has NO vnode subtree: the
  // raw html owns its content, so `createDom` and both SSR writers skip the
  // children entirely and they were never realized. Walking them on teardown
  // asked never-mounted vnodes to give up DOM they never had — a bare text
  // child warned "it will stay on the page forever. This is an aio bug", and a
  // `<Portal>` sitting under one had `removeDom` run against its target for
  // content that was never put there. One rule, all three teardown walkers.
  if (typeof vnode.tag === "string" && _hasRawHtml(vnode.props)) return [];
  return vnode.children;
}

/** Cleanup component instances without removing DOM (for type-mismatch replacement). */
export function _removeDomCleanup(
  vnode: VNode | string | number,
  ctx: RenderCtx,
): void {
  if (typeof vnode !== "object") return;
  // A signal child owns an effect, nothing else.
  if (vnode.tag === _SignalText) {
    _unbindSignalText(vnode);
    return;
  }
  // A Portal's content does not live under the ancestor being torn down — it
  // lives in the TARGET, where "cleanup without removing DOM" leaves it on
  // screen. Removing `<div>{open && <Portal>…</Portal>}</div>` by its `div`
  // (or retagging an ancestor, or an exit animation finishing) went through
  // here and the modal stayed in `document.body` forever, and the next open
  // stacked a second copy next to it. The Portal branch of `removeDom` is the
  // ONE teardown for portal content; it needs no parent (the target is the
  // parent) — so this is that, not a copy of it.
  if (vnode.tag === Portal) {
    removeDom(vnode.props.target as Node, vnode, ctx);
    return;
  }
  if (typeof vnode.tag === "function") {
    ctx.hooks?.unmountComponent(vnode);
  }
  // Cleanup actions before nulling refs
  if (typeof vnode.tag === "string" && vnode._dom) {
    cleanupSignalBindings(vnode._dom as Element);
    _cleanupActions(vnode._dom as HTMLElement);
  }
  // AIO-58: Null element refs on cleanup (was missing — ref callbacks never got
  // null on replace/unmount, leaking event listeners and DOM references)
  if (typeof vnode.tag === "string" && vnode.props.ref) {
    _detachRef(vnode.props.ref, vnode._dom, _componentName(vnode.tag));
  }
  for (const child of _cleanupChildren(vnode)) {
    if (typeof child === "object") _removeDomCleanup(child, ctx);
  }
}

/** Remove a vnode's DOM.
 *
 *  `posDom` is the node this vnode POSITIONALLY occupies — the caller's cursor.
 *  A bare string/number child carries no `_dom` (a primitive has nowhere to
 *  hold one), so without it `getDom` returned null and the removal was a silent
 *  no-op: text accumulated forever (`<>{"aaa"}</>` replaced by `<i/>` left
 *  `aaa` behind, and every toggle added another copy). It is used ONLY for bare
 *  text — every other vnode kind either owns a `_dom` or occupies no node at
 *  all, and for those `posDom` is the FOLLOWING node, which must never be
 *  removed. */
export function removeDom(
  parent: Node,
  vnode: VNode | string | number,
  ctx: RenderCtx,
  posDom: Node | null = null,
): void {
  // Portal: remove children from target DOM
  if (typeof vnode === "object" && vnode.tag === Portal) {
    const target = vnode.props.target as Node;
    // Every MOUNTED portal has an `_anchor` (see the Portal branch of
    // `createDom`); one without it never put anything in its target. Walking
    // it from `target.firstChild` treated the target's own content as this
    // portal's: a hydration mismatch tears down the whole unmounted tree, and
    // a `<Portal target={document.body}>Saved</Portal>` in it deleted the
    // page's first body node (a site header outside the app) as its "text".
    if (target && vnode._anchor) {
      // Walk from the portal's own region anchor, not `target.firstChild` —
      // that is the OTHER portal's content when two share a target, and
      // removing this portal by it deleted their nodes instead of its own.
      let cursor: Node | null = _advance(vnode._anchor, 1);
      for (const child of vnode.children) {
        const at = _liveFirstDom(child) ?? cursor;
        cursor = _advance(at, _domNodeCount(child));
        removeDom(target, child, ctx, at);
      }
      if (vnode._anchor && isChildOf(vnode._anchor, target)) {
        target.removeChild(vnode._anchor);
      }
      vnode._anchor = undefined;
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
      removeDom(parent, vnode._rendered, ctx, _liveFirstDom(vnode) ?? posDom);
      return;
    }
    // Walk the region positionally so bare-text children — which have no `_dom`
    // — are located by POSITION, the only thing that identifies them. The
    // positions are the LIVE ones (`_liveFirstDom`): a fragment's and a
    // component's `_dom` are copies that go stale when a component below
    // re-renders on its own and swaps its root, and a walk started from a
    // detached copy ran off the end — the bare text after it was never
    // found, and stayed on the page after its whole region was removed.
    let cursor: Node | null = _liveFirstDom(vnode) ?? posDom;
    for (const child of vnode.children) {
      const at = _liveFirstDom(child) ?? cursor;
      cursor = _advance(at, _domNodeCount(child));
      removeDom(parent, child, ctx, at);
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
      removeDom(parent, vnode._rendered, ctx, _liveFirstDom(vnode) ?? posDom);
    }
    return;
  }
  // Element: null ref before removing
  if (
    typeof vnode === "object" && typeof vnode.tag === "string" &&
    vnode.props.ref
  ) {
    _detachRef(vnode.props.ref, vnode._dom, _componentName(vnode.tag));
  }
  // Bare text is the ONE vnode kind with no `_dom` and exactly one node — its
  // position is its identity. Anything else that reaches here owns a `_dom`.
  const dom = getDom(vnode) ?? (typeof vnode !== "object" ? posDom : null);
  if (typeof vnode !== "object" && !dom) {
    _devWarn(
      "remove-text-no-position",
      `A text child (${
        JSON.stringify(String(vnode))
      }) is being removed without its DOM position, so it will stay on the ` +
        `page forever. The caller lost the positional cursor. This is an aio ` +
        `bug; please report the component's child shape.`,
    );
  }
  if (dom && isChildOf(dom, parent)) {
    // Deferred removal for exit animations — cleanup AFTER animation completes
    const HtmlEl = ctx.doc?.defaultView?.HTMLElement ?? globalThis.HTMLElement;
    if (
      ctx.onBeforeRemove && typeof vnode === "object" && HtmlEl &&
      dom instanceof HtmlEl
    ) {
      // The exit handler is user code (a <Transition> / exit directive) running
      // INSIDE the commit: an unguarded throw here aborted removeDom, and with
      // it the whole diff that was removing the node — a half-applied commit,
      // the same class as a throwing callback ref. Contained: report it and
      // fall through to the immediate removal below.
      let result: ReturnType<NonNullable<RenderCtx["onBeforeRemove"]>>;
      try {
        result = ctx.onBeforeRemove(dom, vnode);
      } catch (e) {
        _reportHookError("exit-transition", e, _componentName(vnode.tag));
        result = undefined;
      }
      if (result && typeof result.then === "function") {
        const SAFETY_TIMEOUT = 5000;
        // AIO-210: guard against double-cleanup when timeout fires before promise
        let removed = false;
        const _cleanup = () => {
          cleanupSignalBindings(dom as Element);
          _cleanupActions(dom as HTMLElement);
          // AIO-204: recurse into children for cleanup
          if (typeof vnode === "object") {
            for (const child of _cleanupChildren(vnode)) {
              if (typeof child === "object") _removeDomCleanup(child, ctx);
            }
          }
          _clearExiting(dom);
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
        // The node stays in the DOM but leaves the vnode tree: flag it so every
        // positional walk steps over it (see _isExiting) instead of mistaking
        // it for a node some vnode still owns.
        _markExiting(dom, _doRemove);
        result.then(_doRemove, (e) => {
          console.error("[aio:vdom] onBeforeRemove rejected:", e);
          _doRemove();
        });
        return;
      }
    }
    // Immediate removal — cleanup first
    if (typeof vnode === "object" && vnode.tag === _SignalText) {
      _unbindSignalText(vnode);
    }
    if (
      typeof vnode === "object" && typeof vnode.tag === "string" && vnode._dom
    ) {
      cleanupSignalBindings(vnode._dom as Element);
      _cleanupActions(vnode._dom as HTMLElement);
      // AIO-204: recurse into children for cleanup
      for (const child of _cleanupChildren(vnode)) {
        if (typeof child === "object") _removeDomCleanup(child, ctx);
      }
    }
    // The same guard as the deferred path above: an action's cleanup may have
    // MOVED its element already, and `removeChild` of a node that is no
    // longer this parent's child throws — which failed the whole re-render of
    // the component that unmounted it.
    if (isChildOf(dom, parent)) parent.removeChild(dom);
  } else if (
    typeof vnode === "object" && typeof vnode.tag === "string" && vnode._dom
  ) {
    // Not in `parent` any more — something outside the renderer took it out
    // (an action that moved or replaced its element). There is nothing to
    // REMOVE, but the vnode is still leaving
    // the tree, so it is still UNMOUNTED: skipping this left its actions'
    // teardown unrun and its signal bindings live, for good.
    cleanupSignalBindings(vnode._dom as Element);
    _cleanupActions(vnode._dom as HTMLElement);
    for (const child of _cleanupChildren(vnode)) {
      if (typeof child === "object") _removeDomCleanup(child, ctx);
    }
  }
}
