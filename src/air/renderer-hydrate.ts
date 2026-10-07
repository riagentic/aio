// renderer-hydrate.ts — SSR hydration: attach to existing server-rendered DOM.
// Provides: hydrate, _hydrateNode, _hydrateProps.

import {
  bindSignalProps,
  cleanupSignalBindings,
  isSignal,
} from "./signal-binding.ts";
import { _propAttr, _RESERVED_PROPS, _writeProp } from "./prop-write.ts";
import { attrNameOf as _attrName, TEXT_CONTENT_ELEMENTS } from "./ssr-utils.ts";
import { _DOM_PROPS } from "./vdom-types.ts";
import type { ComponentFn, RenderCtx, VNode } from "./vdom.ts";
import {
  _applyActions,
  _bindSignalText,
  _ensureDelegation,
  _isDelegated,
  _LAZY_PENDING,
  _mapEventName,
  _render,
  _setDelegationRoot,
  _setWrapped,
  _SignalText,
  _sigText,
  _wrapHandler,
  childSvgMode,
  createDom,
  ErrorBoundary,
  Fragment,
  getDom,
  h,
  Portal,
  Suspense,
  SVG_TAGS,
} from "./vdom.ts";
import {
  _attachRef,
  _enterCommit,
  _leaveCommit,
  _registerLazyListeners,
  nullSlot,
} from "./vdom-create.ts";
import { _fallbackSlot } from "./vdom-render.ts";
import { _cleanupChildren, _removeDomCleanup } from "./vdom-remove.ts";
import { _cleanupActions } from "./vdom-helpers.ts";
import { applyChildDependentProps } from "./vdom-props.ts";
import { _recordControlled } from "./control-drift.ts";
import { _devWarn, _hasRawHtml } from "./vdom-types.ts";
import { isDevMode } from "../state/dev-flag.ts";
import type { Signal } from "../state/signal.ts";
import { _getExitHandler } from "./transition-component.ts";
import { _getGroupExitHandler } from "./transition-group.ts";
import type { MountHandle, RootState } from "./renderer-types.ts";
import {
  _activeRoot,
  _boundaryStack,
  _noteDiscard,
  _registerRoot,
  _setActiveRoot,
} from "./renderer-state.ts";
import {
  _flushAfterRender,
  _flushPending,
  _rerenderRoot,
} from "./renderer-flush.ts";
import { _createHooks } from "./renderer-rerender.ts";

// deno-lint-ignore no-explicit-any
type AnyDoc = any;

// _doc is kept local to hydrate — the aio-renderer.ts orchestrator sets it via _setDocument
// which is also the setter used by mount. Both share the same _doc via aio-renderer.ts.
let _doc: AnyDoc = typeof globalThis !== "undefined" && "document" in globalThis
  // deno-lint-ignore no-explicit-any
  ? (globalThis as any).document
  : null;

export function _setHydrateDoc(doc: AnyDoc): void {
  _doc = doc;
}

// ── a boundary's children are hydrated as an ATTEMPT ─────────────────────
//
// An ErrorBoundary / Suspense whose server render fell back has its FALLBACK
// in the markup, and hydrate cannot know that until a child throws — which it
// does in its own place, after every sibling before it has already been
// hydrated against the fallback's nodes. Those siblings either mismatched
// (hydrate gave up and discarded the whole server page — a dev warning, in
// prod nothing), or matched by accident and wrote themselves into the
// fallback: a null slot appended a stray `<!---->` beside it, a text split it,
// an element's props were written over the fallback's element. Only a thrower
// that was the boundary's FIRST child ever hydrated cleanly.
//
// So a boundary's children never write the DOM until the boundary has decided:
//
//  - every WRITE to a claimed node (props, listeners, signal bindings, refs,
//    actions, a text repair, `<select value>`) is queued in `ops`, and runs
//    only once the OUTERMOST attempt succeeds — an inner boundary that
//    succeeded can still be discarded by an outer one that falls back;
//  - every STRUCTURAL change (a node inserted, a text split, a split tail
//    dropped, an implied `<tbody>` unwrapped) has to happen now, because the
//    next sibling's claim reads the result by index — so each records its
//    inverse in `undo`;
//  - a MISMATCH does not end the walk (`missed`): the throw that explains it
//    may be in a later child, or deeper in this one. From then on the rest of
//    the attempt is built exactly as `createDom` builds it — detached, every
//    component body run once and in the same order as on the server, a throw
//    caught by the same boundary that would catch it on mount.
//
// Falling back, the boundary undoes the structural changes, forgets the nodes
// its discarded children claimed (the sweep that retires them must not clean
// the fallback's bindings off those same nodes) and drops the queued writes —
// the server's fallback markup is exactly as the server wrote it, and is
// hydrated in place. No component body runs twice. A mismatch with no throw
// is a real mismatch: -1, and the page falls back to a client render as
// before.

interface _Attempt {
  ops: (() => void)[];
  undo: (() => void)[];
  missed: boolean;
}

/** The innermost boundary whose children are being hydrated, or null. */
let _attempt: _Attempt | null = null;

/** Write to a claimed node — now, or once the enclosing attempt commits. */
function _write(op: () => void): void {
  if (_attempt) _attempt.ops.push(op);
  else op();
}

/** Record the inverse of a structural change made inside an attempt. */
function _undoable(undo: () => void): void {
  _attempt?.undo.push(undo);
}

/** A mismatch. Outside an attempt it ends the hydration (-1); inside one the
 *  rest of the attempt is built detached, as `createDom` would (see above). */
function _miss(
  parent: Node,
  vnode: VNode | string | number,
  ctx: RenderCtx,
  isSvg: boolean,
): number {
  if (!_attempt) return -1;
  _attempt.missed = true;
  createDom(vnode, ctx, isSvg, parent);
  return 0;
}

/** Forget the server nodes a discarded attempt claimed. Nodes it built
 *  detached (after a miss) are kept — their bindings are live and the sweep
 *  must still release them. A Portal's content lives in its target and is the
 *  sweep's to remove. */
function _forgetClaims(
  nodes: readonly unknown[],
  parent: Node,
): void {
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const v = n as VNode;
    if (v.tag === undefined || !Array.isArray(v.children) || v.tag === Portal) {
      continue;
    }
    if (v._dom && parent.contains(v._dom as Node)) v._dom = undefined;
    _forgetClaims(_cleanupChildren(v), parent);
  }
}

/**
 * Attach to existing server-rendered DOM without re-creating elements.
 * Walks the VNode tree and existing DOM in parallel, attaching _dom
 * references and event listeners. Falls back to full render on mismatch.
 */
// deno-lint-ignore no-explicit-any
export function hydrate(root: any, App: ComponentFn): MountHandle {
  const state: RootState = {
    root,
    vnode: null,
    disposed: false,
    ctx: { doc: _doc },
    pendingComponents: new Set(),
    flushScheduled: false,
    App,
    afterRenderQueue: [],
    _idCounter: 0,
    _ssrIds: true,
    _renderCounts: new Map(),
  };

  const handle: MountHandle = {
    _flush() {
      if (state.disposed) return;
      _flushPending(state);
    },
  };

  _registerRoot(handle, state);
  state.ctx.hooks = _createHooks(state);
  state.ctx.onLazyResolve = () => {
    if (state.disposed) return;
    _rerenderRoot(state);
  };
  state.ctx.onBeforeRemove = (el) => {
    const inner = _getExitHandler(el);
    const outer = _getGroupExitHandler(el);
    if (inner && outer) {
      return Promise.all([inner(el), outer(el)]).then(() => {});
    }
    const handler = inner ?? outer;
    return handler ? handler(el) : undefined;
  };

  _setActiveRoot(state);
  _setDelegationRoot(root);
  try {
    const vnode = h(App, null);
    const consumed = _hydrateNode(root, vnode, state.ctx, false, 0);
    if (consumed < 0) {
      // Recovery is correct but INVISIBLE, and it throws away everything SSR
      // was for: the page is re-created from scratch on the client, losing the
      // server markup, the paint that was already on screen, and any DOM state
      // in it. Silently degrading a documented feature to nothing is the worst
      // outcome — say so in dev, where it can still be fixed.
      _devWarn(
        "hydrate-mismatch",
        `hydrate() found DOM that does not match the component tree and fell ` +
          `back to a full client render — the server HTML was discarded. The ` +
          `usual cause is markup that differs between server and client ` +
          `(Date/random/window in render), or two ADJACENT text children: ` +
          `HTML parsing merges them into one text node, which cannot be ` +
          `hydrated as two.`,
      );
      // Hydration mismatch — every component instance created BEFORE the
      // mismatch is about to be thrown away with the markup, and nothing was
      // unmounting them: their `onCleanup` never ran and their signal
      // subscriptions stayed live, so the full client render that follows left
      // TWO subscribers per component (measured: 2 for 1 live component, a
      // double re-render on every change, and one subscription outliving
      // `_unmount`). `_removeDomCleanup` is the same teardown `removeDom` runs.
      // It also disposes every signal child's effect and tears portal content
      // out of its target.
      _removeDomCleanup(vnode, state.ctx);
      // (Their `afterRender`s wait for a commit that never comes; the flush
      // drops a callback whose instance is gone — `_flushAfterRender`.)
      // ...then release the signal-binding effects and action cleanups for
      // elements hydrated before the mismatch. Without this, those effects
      // stay alive and keep mutating DOM nodes that innerHTML="" is about to
      // detach (leak + stale writes).
      cleanupSignalBindings(root);
      if (typeof (root as HTMLElement).setAttribute === "function") {
        _cleanupActions(root as HTMLElement);
      }
      for (const el of root.querySelectorAll("*")) {
        cleanupSignalBindings(el);
        if (typeof (el as HTMLElement).setAttribute === "function") {
          _cleanupActions(el as HTMLElement);
        }
      }
      root.innerHTML = "";
      // The server markup is gone, so there is no sequence left to match.
      state._ssrIds = false;
      _render(root, vnode, null, state.ctx);
    } else _dropSplitTail(root, consumed);
    state.vnode = vnode;
    _flushAfterRender(state);
  } finally {
    // Hydration is over: later ids (a component this root mounts on a
    // re-render) come from the client sequence, which is spelled apart from
    // the server's, so it cannot repeat one of the ids just taken.
    state._ssrIds = false;
    _setActiveRoot(null);
    _setDelegationRoot(null);
  }

  return handle;
}

/**
 * Hydrate a single VNode against existing DOM.
 * Returns the number of DOM nodes consumed (>= 0) on success, or -1 on failure.
 * AIO-92: Fragments/components can consume N DOM nodes, not always 1.
 */
export function _hydrateNode(
  parent: Node,
  vnode: VNode | string | number,
  ctx: RenderCtx,
  isSvg: boolean,
  childIndex: number,
): number {
  // The third reconciler entry point that opens a COMMIT (see `_enterCommit`);
  // its own recursion nests. Hydration adopts server markup and attaches refs
  // to it, and a hydrating boundary that falls back builds and tears down
  // elements in the same pass — same two-phase rule as mount and diff.
  _enterCommit();
  try {
    return _hydrateNodeInner(parent, vnode, ctx, isSvg, childIndex);
  } finally {
    _leaveCommit();
  }
}

function _hydrateNodeInner(
  parent: Node,
  vnode: VNode | string | number,
  ctx: RenderCtx,
  isSvg: boolean,
  childIndex: number,
): number {
  // After a miss the rest of the attempt is built, not claimed (see `_Attempt`).
  if (_attempt?.missed) {
    createDom(vnode, ctx, isSvg, parent);
    return 0;
  }

  if (typeof vnode === "string" || typeof vnode === "number") {
    return _hydrateText(parent, String(vnode), childIndex)
      ? 1
      : _miss(parent, vnode, ctx, isSvg);
  }

  // Signal child — one text node, claimed exactly like a text child (SSR
  // emitted the signal's value as plain text), then bound so it follows the
  // signal. It used to be bound by ARRAY index into the parent's childNodes,
  // which is not its DOM index whenever a sibling spans several nodes or none.
  if (vnode.tag === _SignalText) {
    const text = _hydrateText(
      parent,
      _sigText((vnode._sig as Signal<unknown>).peek()),
      childIndex,
    );
    if (!text) return _miss(parent, vnode, ctx, isSvg);
    vnode._dom = text;
    _write(() => _bindSignalText(vnode, text));
    return 1;
  }

  // Null placeholder — consume 1 comment node (AIO-107)
  if (vnode.tag === Symbol.for("aio.Null") as typeof vnode.tag) {
    // Inside a <textarea>/<title>/<script>/<style> SSR writes no marker (the
    // parser would read it as text — `TEXT_CONTENT_ELEMENTS`): the slot is
    // made here, before whatever follows, and a split-off text remainder is
    // the NEXT text child's, not stale.
    const textContent = TEXT_CONTENT_ELEMENTS.has(
      parent.nodeName.toLowerCase(),
    );
    if (!textContent) _dropSplitTail(parent, childIndex); // see `_dropSplitTail`
    const domNode = parent.childNodes[childIndex];
    if (domNode && domNode.nodeType === 8) {
      vnode._dom = domNode;
      return 1;
    }
    // SSR emits `<!---->` for a null slot, so anything else in this slot means
    // the walk is out of step with the markup. It used to INSERT a comment and
    // carry on: the foreign node stayed, owned by no vnode, and hydration
    // reported success for a document the model does not describe. Every other
    // branch answers a mismatch with -1 — one rule, and the caller's fallback
    // (wipe and client-render, with the divergence warning in dev) produces the
    // right page instead of a silently wrong one.
    // The one legitimate absence is the END of the parent: `createDom` gives a
    // null child a comment even when SSR wrote nothing after it.
    if (domNode && !textContent) return _miss(parent, vnode, ctx, isSvg);
    const comment = (parent.ownerDocument ?? document).createComment("");
    parent.insertBefore(comment, domNode ?? null);
    _undoable(() => comment.remove());
    vnode._dom = comment;
    return 1;
  }

  // Component — consume whatever the rendered output consumes
  if (typeof vnode.tag === "function") {
    const hookState = ctx.hooks?.beforeComponent(vnode, null, parent, isSvg);
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
      throw e;
    }
    // SSR already emits `<!---->` for a null slot (vdom-ssr.ts), so hydration
    // must CONSUME that comment rather than skip it — otherwise the client
    // rebuilt the tree one node out of step and a null-first component moved
    // on its first re-render (R-10).
    if (rendered == null) rendered = nullSlot();
    vnode._rendered = rendered;
    ctx.hooks?.afterComponent(vnode, rendered, hookState);
    // `finally`, like the other two commit paths (vdom-render.ts:134,
    // vdom-diff.ts:340). Without it a throw from the subtree — a lazy's
    // `_LAZY_PENDING`, or a component error the boundary below catches — skipped
    // the pop and left the module-global `_instanceStack` holding a dead
    // instance forever. That stale ancestor then won `useContext` lookups for
    // every later component without a real provider above it.
    try {
      const count = _hydrateNode(parent, rendered, ctx, isSvg, childIndex);
      // A component that returns a bare string has no vnode DOM of its own —
      // its position is the text node it claimed, as on mount (alpha47).
      // Without it the re-render appended a second text and keyed moves and
      // removals could not find the node.
      if (count >= 0) {
        vnode._dom = getDom(rendered) ??
          (count > 0 ? parent.childNodes[childIndex] : undefined) ?? undefined;
      }
      return count;
    } finally {
      ctx.hooks?.afterSubtree?.(vnode);
    }
  }

  // Portal — consumes 0 DOM nodes of `parent`; its content lives in the
  // TARGET, which the server never rendered into (`renderToString` emits
  // nothing for a Portal). So there is nothing to claim — it must be CREATED,
  // exactly as on mount. Returning 0 without creating anything left every
  // portal on a hydrated page empty forever: the modal/toast/menu of an
  // SSR'd app never appeared, and nothing said why.
  if (vnode.tag === Portal) {
    createDom(vnode, ctx, isSvg, parent);
    if (vnode._anchor) _portalAnchors.add(vnode._anchor as Node);
    return 0;
  }

  // ErrorBoundary / Suspense / Fragment — children inline in parent DOM
  const isFragment = vnode.tag === Fragment;
  const isBoundary = vnode.tag === ErrorBoundary;
  const isSuspense = vnode.tag === Suspense;
  if (isFragment || isBoundary || isSuspense) {
    let idx = childIndex;
    // A boundary's children are an ATTEMPT until it has decided (see
    // `_Attempt`): nothing they write reaches the DOM, and a mismatch does not
    // end the walk, until the boundary knows whether they threw.
    const outer = _attempt;
    const mine: _Attempt | null = isFragment
      ? null
      : { ops: [], undo: [], missed: false };
    if (mine) _attempt = mine;
    // A boundary is on `_boundaryStack` while its subtree hydrates, as it is
    // on mount (`createDom`) and diff: each component records the boundary it
    // sits in for its RE-RENDERS, and `abortComponent` keeps a thrower
    // subscribed through it. Without the push, a hydrated boundary never
    // recovered from a server-rendered fallback and never caught a throw that
    // started after hydration — the subtree silently stopped updating.
    if (isBoundary) _boundaryStack.push(vnode);
    try {
      for (const child of vnode.children) {
        const consumed = _hydrateNode(parent, child, ctx, isSvg, idx);
        if (consumed < 0) return -1;
        idx += consumed;
      }
      if (mine) {
        _attempt = outer;
        if (mine.missed) {
          // Mismatched and nothing threw: a real mismatch. An enclosing
          // attempt carries on (a later child of ITS may still throw) and
          // owns the undo; otherwise the page falls back to a client render.
          if (!outer) return -1;
          outer.missed = true;
          outer.undo.push(...mine.undo);
          return 0;
        }
        if (outer) {
          outer.ops.push(...mine.ops);
          outer.undo.push(...mine.undo);
        } else for (const op of mine.ops) op();
      }
    } catch (thrown) {
      _attempt = outer;
      // The children hydrated before the throw are discarded — retired by the
      // region's owner (`_sweepDiscarded`), exactly as on mount and diff. A
      // throw that was not a component body's passes no `abortComponent`.
      _noteDiscard();
      // …and what they claimed of the server's markup is given back untouched:
      // that markup is the FALLBACK whenever the server's render threw too,
      // and a late thrower's earlier siblings were hydrated against it (see
      // `_Attempt`). Their queued writes are dropped with them.
      if (mine) {
        _forgetClaims(vnode.children, parent);
        for (let i = mine.undo.length - 1; i >= 0; i--) mine.undo[i]!();
      }
      // `createDom` and `renderToString` both catch here; hydrate did not, so a
      // boundary that WORKS on the server and WORKS on a client mount let the
      // error escape `hydrate()` on the one path that matters most. The server
      // had already rendered the fallback, the page looked fine — and the app
      // never booted: no handlers, no updates, a dead screenshot of itself.
      // The markup at `childIndex` IS the fallback, so it is hydrated in place.
      const claimFallback = (
        shown: VNode | string | number | null,
      ): number => {
        // Nothing to show is the placeholder both SSR writers emitted a
        // comment for — see `_fallbackSlot`.
        const fb = _fallbackSlot(shown);
        vnode._rendered = fb;
        const n = _hydrateNode(parent, fb, ctx, isSvg, childIndex);
        if (n >= 0) {
          vnode._dom = getDom(fb) ?? parent.childNodes[childIndex] ?? undefined;
        }
        return n;
      };
      if (isSuspense && thrown === _LAZY_PENDING) {
        _registerLazyListeners(vnode.children, ctx);
        return claimFallback(
          (vnode.props.fallback as VNode | string | number | null) ?? null,
        );
      }
      // A lazy child inside an ErrorBoundary belongs to the enclosing Suspense.
      if (isBoundary && thrown !== _LAZY_PENDING) {
        const fallback = vnode.props.fallback as
          | ((e: Error) => VNode | string | number | null)
          | undefined;
        if (fallback) return claimFallback(fallback(thrown as Error));
      }
      throw thrown;
    } finally {
      _attempt = outer;
      if (isBoundary) _boundaryStack.pop();
    }
    // A Fragment inside an attempt that missed has no position left to claim.
    if (_attempt?.missed) return 0;
    if (idx === childIndex) {
      // An empty Fragment / ErrorBoundary / Suspense occupies a comment ANCHOR
      // (AIO-195) — createDom makes one and the SSR writers emit one, so
      // hydration must claim it. Without a `_dom` the container has no position,
      // and the next diff anchored its whole region at the parent's first child.
      // Inside a text-content element SSR wrote no anchor, so a split-off
      // remainder is the NEXT text child's — as for a null slot above.
      if (!TEXT_CONTENT_ELEMENTS.has(parent.nodeName.toLowerCase())) {
        _dropSplitTail(parent, childIndex); // see `_dropSplitTail`
      }
      const domNode = parent.childNodes[childIndex];
      if (domNode && domNode.nodeType === 8) {
        vnode._dom = domNode;
        return 1;
      }
      const comment = (parent.ownerDocument ?? document).createComment("");
      if (domNode) parent.insertBefore(comment, domNode);
      else parent.appendChild(comment);
      _undoable(() => comment.remove());
      vnode._dom = comment;
      return 1;
    }
    // The region's first node — `parent.childNodes[childIndex]` by definition.
    // Scanning children for the first one carrying a `_dom` (AIO-256) SKIPS
    // leading bare text, whose node nothing tracks, so a fragment that starts
    // with text anchored one node too late.
    if (idx > childIndex) {
      vnode._dom = parent.childNodes[childIndex] ?? undefined;
    }
    return idx - childIndex;
  }

  // Element — consume exactly 1 DOM node, hydrate children inside it
  _dropSplitTail(parent, childIndex); // see `_dropSplitTail`
  _unwrapImpliedTableSection(parent, childIndex, vnode.tag as string);
  const domNode = parent.childNodes[childIndex];
  if (!domNode || domNode.nodeType !== 1) {
    return _miss(parent, vnode, ctx, isSvg);
  }
  const el = domNode as HTMLElement;
  if (el.tagName.toLowerCase() !== (vnode.tag as string).toLowerCase()) {
    return _miss(parent, vnode, ctx, isSvg);
  }

  vnode._dom = el;
  // The server's last child, taken before anything client-side (an action,
  // a portal) can append to the element — see `_dropSurplus`.
  const serverLast = el.lastChild;
  _write(() => _hydrateProps(el, vnode.props));

  const tagName = el.tagName.toLowerCase();
  const nowSvg = childSvgMode(tagName, isSvg || SVG_TAGS.has(tagName));
  // Raw html owns the content (see _hasRawHtml): the server emitted the html
  // and no children, so there are no children to claim inside it.
  if (!_hasRawHtml(vnode.props)) {
    let childIdx = 0;
    for (let i = 0; i < vnode.children.length; i++) {
      const consumed = _hydrateNode(
        el,
        vnode.children[i]!,
        ctx,
        nowSvg,
        childIdx,
      );
      if (consumed < 0) return -1;
      childIdx += consumed;
    }
    _dropSurplus(el, childIdx, serverLast);
  }

  // `<select value>` selects an <option>, so it can only be written once the
  // options are hydrated — and SSR cannot express it in markup at all (`value`
  // is not a <select> attribute). Without this a server-rendered controlled
  // select showed its FIRST option no matter what the state said.
  _write(() => applyChildDependentProps(el, vnode.props, {}));

  return 1;
}

/** The wrapper the HTML parser INVENTS around a table child, keyed by the child
 *  it wraps: a `<tr>` written straight into `<table>` is parsed into an
 *  implied `<tbody>`, a `<col>` into an implied `<colgroup>`. */
const _IMPLIED_TABLE_SECTION: Readonly<Record<string, string>> = {
  tr: "TBODY",
  col: "COLGROUP",
};

/** Undo the parser's implied table section in front of the element being
 *  claimed, so the DOM is the one `createDom` builds.
 *
 *  `<table><tr>` is the ordinary way to write a table, and both SSR writers
 *  emit exactly that. The DOM API keeps a `<tr>` where it is put, so mount
 *  builds `table > tr`; the HTML parser does not — it wraps the rows in a
 *  `<tbody>` that no vnode describes. Hydration then met `TBODY` where the
 *  vnode said `tr`, reported a mismatch, and threw the whole server page away
 *  for a client render (a dev warning; in prod, silently): every server-
 *  rendered table cost its app its SSR.
 *
 *  Only a wrapper that is unmistakably the parser's is unwrapped: directly in a
 *  `<table>`, holding the element the vnode names, with no attributes (an
 *  authored `<tbody class>` is markup, not an implication). Its children move
 *  up into its place — they are the rows the vnodes describe, claimed one by
 *  one after it, so the walk stays in step. */
function _unwrapImpliedTableSection(
  parent: Node,
  childIndex: number,
  tag: string,
): void {
  const section = _IMPLIED_TABLE_SECTION[tag];
  if (!section || (parent as Element).tagName !== "TABLE") return;
  const node = parent.childNodes[childIndex] as Element | undefined;
  if (
    !node || node.nodeType !== 1 || node.tagName !== section ||
    node.attributes.length > 0 ||
    (node.firstChild as Element | null)?.tagName?.toLowerCase() !== tag
  ) return;
  const moved = Array.from(node.childNodes);
  while (node.firstChild) parent.insertBefore(node.firstChild, node);
  parent.removeChild(node);
  _undoable(() => {
    parent.insertBefore(node, moved[0] ?? null);
    for (const m of moved) node.appendChild(m);
  });
}

/** The remainders `_hydrateText` split off a merged text run. Each one is
 *  CLAIMED by the next text child when the merge was the parser's; one that is
 *  still unclaimed after the last child is not a sibling's text at all — it is
 *  the tail of THIS child's server text, which differs from the client's (a
 *  signal written between SSR and hydrate, or by a component later in the
 *  same render). */
const _splitTails = new WeakSet<Node>();

/** Remove a split-off remainder no child claimed. It used to stay: owned by no
 *  vnode, invisible to every diff, so the server's stale text (`s0` beside the
 *  signal's current `""`) sat on the page for its whole life — the hydrated
 *  page silently not the page the model describes.
 *
 *  Called at the END of a parent and wherever a NON-text node is claimed: SSR
 *  separates text from a following element / `null` slot / empty region by
 *  that node's own markup, so a remainder sitting in such a slot is never a
 *  sibling's text. Checked only at the end, the claim saw the remainder instead
 *  of its node — an empty region inserted a second anchor in front of it, the
 *  next text child adopted it, and the server's anchor and text stayed behind
 *  as orphans: `<p>{msg}{cond && <></>}z</p>` hydrated as `z z`. */
function _dropSplitTail(parent: Node, idx: number): void {
  const tail = parent.childNodes[idx];
  if (tail && _splitTails.has(tail)) {
    const next = tail.nextSibling;
    parent.removeChild(tail);
    _undoable(() => parent.insertBefore(tail, next));
  }
}

/** The anchors of portal regions this hydration CREATED. A target inside the
 *  page that is claimed after its portal already holds that region at its
 *  end — client content, not server surplus. */
const _portalAnchors = new WeakSet<Node>();

/** Remove what the server wrote after an element's last claimed child.
 *
 *  Every child was claimed and the markup still goes on: the server rendered
 *  more than the client does (a list that lost its tail, a text or a region
 *  the client leaves out). The walk ended at the client's last child, so the
 *  rest was owned by no vnode and invisible to every diff — the server's
 *  stale rows sat on the hydrated page for its whole life. Removed, as a
 *  diverging attribute is repaired, and said in dev. A portal region that
 *  hydration itself appended (see `_portalAnchors`) ends the surplus. A
 *  `<textarea>`'s text is its value, which SSR writes as a child. */
function _dropSurplus(
  el: Element,
  idx: number,
  serverLast: Node | null,
): void {
  _dropSplitTail(el, idx);
  if (el.tagName === "TEXTAREA") return;
  // Only up to the server's last node: past it is what an action appended
  // while the props were hydrated. A portal region ends it too.
  const surplus: Node[] = [];
  let n: Node | null = el.childNodes[idx] ?? null;
  for (; n && !_portalAnchors.has(n); n = n.nextSibling) {
    surplus.push(n);
    if (n === serverLast) break;
  }
  // Ran off the end: the server's last node was claimed, none of this is its.
  if (n === null || surplus.length === 0) return;
  // All of it goes, elements included. Inside an element the component
  // rendered, every node is aio's — the same ownership `mount()` (which
  // empties its container) and the mismatch fallback (which re-renders the
  // whole root) already take. Keeping surplus ELEMENTS in case a script or
  // extension added them left a deleted list row visible, and dead, on the
  // page for its whole life. What the page and its extensions
  // own is the ROOT container itself: nodes past the root's last child are
  // never swept (see `hydrate`).
  const next = surplus[surplus.length - 1]!.nextSibling;
  for (const n of surplus) el.removeChild(n);
  _undoable(() => {
    for (const n of surplus) el.insertBefore(n, next);
  });
  // Said once the claim commits: an attempt that falls back undoes it.
  _write(() =>
    _devWarn(
      `hydrate-surplus-${el.tagName}`,
      `hydrate() found ${surplus.length} server node(s) in <${el.tagName.toLowerCase()}> ` +
        `past the component's last child — removed. Server and client rendered ` +
        `different children (Date/random/window in render, or state that ` +
        `changed between the server render and hydrate).`,
    )
  );
}

/** Claim the text node at `childIndex` for a child whose text is `want`.
 *
 *  Two text children are two nodes in the client tree but ONE node in parsed
 *  HTML — the parser merges adjacent character data, and `renderToString` has
 *  no separator to stop it. That made `{"Hello "}{name}` — the single most
 *  ordinary thing a template does — unhydratable: the second child found no
 *  node of its own, the whole tree reported a mismatch, and `hydrate()` threw
 *  the server HTML away and re-rendered the page from scratch (a dev warning,
 *  and in prod nothing at all).
 *
 *  The merge is undone HERE, where the boundary is known exactly: the vnode
 *  says how much of the run belongs to this child, so the node is split at
 *  that offset and the remainder is left for the next child. One decider —
 *  the SSR writer keeps emitting plain text, and nothing about the wire format
 *  changes. Bare text and signal children share it: a signal child IS a text
 *  node whose content happens to follow a signal.
 *
 *  Returns the claimed node, or null on a mismatch. */
function _hydrateText(
  parent: Node,
  want: string,
  childIndex: number,
): Text | null {
  const domNode = parent.childNodes[childIndex];
  if (!domNode || domNode.nodeType !== 3) {
    // SSR emits NOTHING for an empty text child while `createDom` makes an
    // empty text node, so the client tree has a slot the markup does not.
    // Materialize it rather than failing the whole tree.
    if (want !== "") return null;
    const empty = (parent.ownerDocument ?? document).createTextNode("");
    if (domNode) parent.insertBefore(empty, domNode);
    else parent.appendChild(empty);
    _undoable(() => empty.remove());
    return empty;
  }
  const text = domNode as Text;
  const have = text.data;
  if (have !== want) {
    if (have.length > want.length && have.startsWith(want)) {
      const tail = text.splitText(want.length);
      _splitTails.add(tail);
      // Undone in reverse order, so whatever later claims did to the tail
      // (split it again, drop it) is already back when it is merged.
      _undoable(() => {
        text.appendData(tail.data);
        tail.remove();
        _splitTails.delete(tail);
      });
    } else {
      _write(() => text.textContent = want);
    }
  }
  return text;
}

/** One scratch element per document, reused by `_canonStyle`. Dev-only path. */
const _styleProbes = new WeakMap<Document, HTMLElement>();

/** A `style` attribute as the CSSOM spells it.
 *
 *  `style` is the one attribute the server and the client write the same
 *  declarations into with DIFFERENT spelling: the SSR writer joins pairs by
 *  hand (`color:red;margin-top:4px`), while `_writeProp` goes through
 *  `el.style`, and the CSSOM re-serializes (`color: red; margin-top: 4px;`).
 *  Comparing the raw strings therefore reported EVERY server-rendered `style`
 *  prop as a server/client divergence — the renderer's loudest dev warning,
 *  fired on correct code, telling the author to go looking for a
 *  `Date`/`random`/`window` that is not there. A warning that cries wolf on the
 *  most ordinary prop there is trains people to ignore the channel that
 *  reports the real ones.
 *
 *  The CSSOM is the one decider for what a style attribute MEANS, so both
 *  sides go through it before they are compared. A genuine difference
 *  (`color: red` vs `color: blue`) still survives normalization and still
 *  warns. */
function _canonStyle(el: HTMLElement, css: string): string {
  const doc = el.ownerDocument as Document | null;
  if (!doc) return css;
  let probe = _styleProbes.get(doc);
  if (!probe) {
    probe = doc.createElement("span");
    _styleProbes.set(doc, probe);
  }
  probe.style.cssText = css;
  return probe.style.cssText;
}

/** The element's attributes as a plain record — dev only, for divergence
 *  reporting. */
function _attrSnapshot(el: HTMLElement): Record<string, string> {
  const out: Record<string, string> = {};
  const attrs = el.attributes;
  if (!attrs) return out;
  for (let i = 0; i < attrs.length; i++) {
    const a = attrs[i]!;
    out[a.name] = a.name === "style" ? _canonStyle(el, a.value) : a.value;
  }
  return out;
}

function _attrDiff(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: string[] = [];
  for (const n of names) if (before[n] !== after[n]) out.push(n);
  return out.sort();
}

/** The attribute names — lowercased — that `props` DESCRIBE on `el`.
 *
 *  The exact mirror of `_renderPropsHtml` (SSR) and `_writeProp` (client),
 *  asked in reverse: not "what does this prop write" but "which attributes may
 *  legitimately be on this element". Anything else in the server markup is an
 *  attribute the component does not describe.
 *
 *  Signal-valued props count: `bindSignalProps` writes them, so their attribute
 *  is implied even though the re-apply loop skips them. */
function _impliedAttrs(
  el: HTMLElement,
  props: Record<string, unknown>,
): Set<string> {
  const tag = el.tagName.toLowerCase();
  const out = new Set<string>();
  // `selected` on an <option> is the SERVER's spelling of the parent select's
  // `value`, and it has no client spelling at all: mount sets `select.value`,
  // which flips the option's selected PROPERTY and writes no attribute. So it
  // can never be implied by the option's own props — and without this the
  // sweep below would strip the server's choice back to the first option, and
  // the divergence check would report correct markup as a server/client
  // disagreement, in the framework's loudest dev warning. Same shape as the
  // `readOnly` and `style` cases this file already carries.
  if (tag === "option") out.add("selected");
  for (const k of Object.keys(props)) {
    if (_RESERVED_PROPS.has(k) || k.startsWith("on")) continue;
    if (k === "dangerouslySetInnerHTML") continue;
    if (k === "className" || k === "class") {
      out.add("class");
      continue;
    }
    if (k === "style") {
      out.add("style");
      continue;
    }
    const mapped = _propAttr(tag, k);
    if (mapped === null) continue; // no content attribute exists for it
    out.add((mapped ?? _attrName(k)).toLowerCase());
  }
  return out;
}

/** Apply event listeners, signal bindings, and refs during hydration. */
function _hydrateProps(el: HTMLElement, props: Record<string, unknown>): void {
  // AIO-166: detect onChange+onInput collision on form elements
  const _isFormEl = el.tagName === "INPUT" || el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT";
  // A FUNCTION, not a key — the same rule as `applyProps`, so a hydrated
  // `<input onChange={f} onInput={undefined}>` listens where a mounted one does.
  const _hasOnInput = typeof props.onInput === "function" && _isFormEl;
  for (const [k, v] of Object.entries(props)) {
    if (k === "key" || k === "children" || k === "ref" || k === "use") continue;
    if (k.startsWith("on") && typeof v === "function") {
      const evt = _mapEventName(
        k.slice(2).toLowerCase(),
        el,
        k === "onChange" ? _hasOnInput : undefined,
      );
      // Same wrapper the mount path uses (vdom-events.ts) — batched writes,
      // contained throw.
      const wrapped = _wrapHandler(v as EventListener, evt);
      if (_isDelegated(evt) && _activeRoot) {
        _ensureDelegation(_activeRoot.root, evt);
        _setWrapped(el, evt, wrapped, _activeRoot.root);
      } else {
        el.addEventListener(evt, wrapped);
        _setWrapped(el, evt, wrapped);
      }
    }
  }
  // Every non-event prop is (re)applied through `_writeProp` — the SAME decider
  // the mount path uses — rather than trusted to the server's markup.
  //
  // Two things were broken by not doing this:
  //
  //  * Form state is a DOM PROPERTY and not every property has a content
  //    attribute for markup to carry (`indeterminate` has none at all), so
  //    anything markup could not express was simply never applied.
  //  * An ATTRIBUTE that differs between server and client was kept FOREVER.
  //    `class="server"` won over the client's `class="client"` with no warning
  //    and no self-heal, because no later render fixes it either: the diff
  //    compares the new props against the OLD PROPS and skips what did not
  //    change between renders. Text mismatches were already repaired;
  //    attributes were the silent half.
  //
  // Divergence is repaired in both dev and prod (prod must not render markup
  // the component does not describe); dev additionally says so.
  const _before = isDevMode() ? _attrSnapshot(el) : null;
  for (const [k, v] of Object.entries(props)) {
    if (_RESERVED_PROPS.has(k) || k.startsWith("on") || isSignal(v)) continue;
    // The server already emitted this html — rewriting innerHTML here would
    // throw the parsed nodes (and any state in them) away for nothing.
    if (k === "dangerouslySetInnerHTML") continue;
    // `<select>.value` needs its <option>s — applyChildDependentProps owns it
    // and runs after the children are hydrated.
    if (k === "value" && el.tagName === "SELECT") continue;
    if (_DOM_PROPS.has(k) && !(k in el)) continue; // not a property here
    _writeProp(el, k, v);
  }
  // The other half of the same divergence: an attribute the server markup has
  // and the component does NOT. The re-apply loop above can only fix props the
  // component names, so a server-only `disabled` / `hidden` / `class` was kept
  // FOREVER — never rewritten, never warned about, and invisible to the later
  // diff (which compares new props against old props, and it is in neither).
  // A permanently disabled button, or an invisible one, from markup the
  // component never asked for. Now it converges on what mount produces.
  const _implied = _impliedAttrs(el, props);
  for (const name of el.getAttributeNames?.() ?? []) {
    if (!_implied.has(name.toLowerCase())) el.removeAttribute(name);
  }
  if (_before) {
    const diverged = _attrDiff(_before, _attrSnapshot(el));
    if (diverged.length > 0) {
      _devWarn(
        `hydrate-attr-${el.tagName}-${diverged.join(",")}`,
        `hydrate() found <${el.tagName.toLowerCase()}> with server markup ` +
          `that disagrees with the component on ${
            diverged.join(", ")
          } — repaired to what the component says. Server and client rendered ` +
          `different props (Date/random/window in render, or an environment ` +
          `difference).`,
      );
    }
  }
  bindSignalProps(el, props);
  _recordControlled(el, props);
  if (props.ref) _attachRef(props.ref, el, el.tagName?.toLowerCase());
  // AIO-89: apply action directives
  if (props.use) _applyActions(el, props.use);
}
