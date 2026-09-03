// renderer-hydrate.ts — SSR hydration: attach to existing server-rendered DOM.
// Provides: hydrate, _hydrateNode, _hydrateProps.

import {
  bindSignalProps,
  cleanupSignalBindings,
  isSignal,
} from "./signal-binding.ts";
import { _RESERVED_PROPS, _writeProp } from "./prop-write.ts";
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
import { _removeDomCleanup } from "./vdom-remove.ts";
import { _cleanupActions } from "./vdom-helpers.ts";
import { applyChildDependentProps } from "./vdom-props.ts";
import { _devWarn, _hasRawHtml } from "./vdom-types.ts";
import { isDevMode } from "../state/dev-flag.ts";
import type { Signal } from "../state/signal.ts";
import { _getExitHandler } from "./transition-component.ts";
import { _getGroupExitHandler } from "./transition-group.ts";
import type { MountHandle, RootState } from "./renderer-types.ts";
import {
  _activeRoot,
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
      _render(root, vnode, null, state.ctx);
    }
    state.vnode = vnode;
    _flushAfterRender(state);
  } finally {
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
  if (typeof vnode === "string" || typeof vnode === "number") {
    return _hydrateText(parent, String(vnode), childIndex) ? 1 : -1;
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
    if (!text) return -1;
    vnode._dom = text;
    _bindSignalText(vnode, text);
    return 1;
  }

  // Null placeholder — consume 1 comment node (AIO-107)
  if (vnode.tag === Symbol.for("aio.Null") as typeof vnode.tag) {
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
    if (domNode) return -1;
    const comment = (parent.ownerDocument ?? document).createComment("");
    parent.appendChild(comment);
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
      if (count >= 0) vnode._dom = getDom(rendered) ?? undefined;
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
    return 0;
  }

  // ErrorBoundary / Suspense / Fragment — children inline in parent DOM
  const isFragment = vnode.tag === Fragment;
  const isBoundary = vnode.tag === ErrorBoundary;
  const isSuspense = vnode.tag === Suspense;
  if (isFragment || isBoundary || isSuspense) {
    let idx = childIndex;
    try {
      for (const child of vnode.children) {
        const consumed = _hydrateNode(parent, child, ctx, isSvg, idx);
        if (consumed < 0) return -1;
        idx += consumed;
      }
    } catch (thrown) {
      // `createDom` and `renderToString` both catch here; hydrate did not, so a
      // boundary that WORKS on the server and WORKS on a client mount let the
      // error escape `hydrate()` on the one path that matters most. The server
      // had already rendered the fallback, the page looked fine — and the app
      // never booted: no handlers, no updates, a dead screenshot of itself.
      // The markup at `childIndex` IS the fallback, so it is hydrated in place.
      const claimFallback = (
        fb: VNode | string | number | null,
      ): number => {
        vnode._rendered = fb;
        if (fb == null) return 0;
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
    }
    if (idx === childIndex) {
      // An empty Fragment / ErrorBoundary / Suspense occupies a comment ANCHOR
      // (AIO-195) — createDom makes one and the SSR writers emit one, so
      // hydration must claim it. Without a `_dom` the container has no position,
      // and the next diff anchored its whole region at the parent's first child.
      const domNode = parent.childNodes[childIndex];
      if (domNode && domNode.nodeType === 8) {
        vnode._dom = domNode;
        return 1;
      }
      const comment = (parent.ownerDocument ?? document).createComment("");
      if (domNode) parent.insertBefore(comment, domNode);
      else parent.appendChild(comment);
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
  const domNode = parent.childNodes[childIndex];
  if (!domNode || domNode.nodeType !== 1) return -1;
  const el = domNode as HTMLElement;
  if (el.tagName.toLowerCase() !== (vnode.tag as string).toLowerCase()) {
    return -1;
  }

  vnode._dom = el;
  _hydrateProps(el, vnode.props);

  const nowSvg = isSvg || SVG_TAGS.has(el.tagName.toLowerCase());
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
  }

  // `<select value>` selects an <option>, so it can only be written once the
  // options are hydrated — and SSR cannot express it in markup at all (`value`
  // is not a <select> attribute). Without this a server-rendered controlled
  // select showed its FIRST option no matter what the state said.
  applyChildDependentProps(el, vnode.props, {});

  return 1;
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
    return empty;
  }
  const have = domNode.textContent ?? "";
  if (have !== want) {
    if (have.length > want.length && have.startsWith(want)) {
      (domNode as Text).splitText(want.length);
    } else {
      domNode.textContent = want;
    }
  }
  return domNode as Text;
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

/** Apply event listeners, signal bindings, and refs during hydration. */
function _hydrateProps(el: HTMLElement, props: Record<string, unknown>): void {
  // AIO-166: detect onChange+onInput collision on form elements
  const _isFormEl = el.tagName === "INPUT" || el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT";
  const _hasOnInput = "onInput" in props && _isFormEl;
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
  if (props.ref) _attachRef(props.ref, el, el.tagName?.toLowerCase());
  // AIO-89: apply action directives
  if (props.use) _applyActions(el, props.use);
}
