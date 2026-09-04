// VDOM node creation — h() JSX factory, child flattening, static optimization.
// Imports from vdom-types.ts and vdom-lazy.ts only — no circular deps with vdom.ts.

import type { Signal } from "../state/signal.ts";
import { isSignal } from "./signal-binding.ts";
import type { ComponentFn, RenderCtx, VChild, VNode } from "./vdom-types.ts";
import { _devWarn, _hasRawHtml, _Null, _SignalText } from "./vdom-types.ts";
// Symbols imported as types — used only in typeof expressions for h() tag union.
import type {
  ErrorBoundary,
  Fragment,
  Portal,
  Suspense,
} from "./vdom-types.ts";
import {
  _getLazyListeners,
  _preloadLazy,
  _takePendingLazyListeners,
} from "./vdom-lazy.ts";
import { _reportHookError } from "./hook-error.ts";

/** Props signatures already reported for an invalid tag — a bad component sits
 *  in a render path that runs on every update, and one report is the useful
 *  one. Keyed by prop names, so a SECOND broken component still reports. */
const _badTagsReported = new Set<string>();

/** The message for a tag that is neither an element name, a component, nor a
 *  framework symbol. Exported for the test that pins the wording. @internal */
export function _badTagMessage(tag: unknown, props: unknown): string {
  const names = Object.keys((props ?? {}) as Record<string, unknown>)
    .filter((k) => k !== "children");
  return `[air] JSX tag is ${
    tag === null ? "null" : typeof tag
  }, not a component or an element name. The usual cause is a typo'd import, ` +
    `a missing export, or a circular import (the binding is still undefined ` +
    `while the module is evaluating).` +
    (names.length ? ` Props at this call site: ${names.join(", ")}.` : "");
}

// ── h() — JSX factory ────────────────────────────────────────────────

/** Create a virtual DOM node — the JSX factory function for AIO components. */
export function h(
  tag:
    | string
    | typeof Fragment
    | typeof ErrorBoundary
    | typeof Portal
    | typeof Suspense
    | ComponentFn,
  props: Record<string, unknown> | null,
  ...rawChildren: VChild[]
): VNode {
  // A valid tag is a string (intrinsic), a function (component) or a framework
  // symbol (Fragment/Portal/Suspense/ErrorBoundary/_Null). Anything else is a
  // mistake, and `undefined` is the one that actually happens: a typo'd
  // import, a missing export, or — the case no type-checker can catch — a
  // circular import whose binding is still undefined while the module
  // evaluates. Without this, `<Card />` rendered `<undefined></undefined>`:
  // invalid markup, no error, nothing to search for.
  //
  // Dev throws (the blank-screen guard in server-html-gen.ts turns a render
  // throw into an in-page overlay AND a terminal report); prod reports once
  // and renders NOTHING instead. That split is the documented category (b) —
  // dev stricter, prod degrades — and it is deliberate here: one component
  // broken by a circular import must not take a whole production page down
  // when the old behaviour merely rendered it invisibly.
  //
  // One `typeof` on the hot path; the common (string) case exits on the first
  // comparison.
  const tagType = typeof tag;
  if (tagType !== "string" && tagType !== "function" && tagType !== "symbol") {
    const msg = _badTagMessage(tag, props);
    if ((globalThis as Record<string, unknown>).__aioDev === true) {
      throw new Error(msg);
    }
    const sig = Object.keys((props ?? {}) as Record<string, unknown>).join(",");
    if (!_badTagsReported.has(sig)) {
      _badTagsReported.add(sig);
      console.error(msg);
    }
    return nullSlot();
  }

  const p = props ?? {};
  const key = p.key as string | number | undefined;
  if (key !== undefined) delete p.key;

  const children: (VNode | string | number)[] = [];
  flattenChildren(rawChildren, children);

  // Raw html and children are two owners for one element's content, and the
  // client and the server used to pick DIFFERENT ones (mount appended the
  // children after the html, SSR dropped them). `_hasRawHtml` is the rule —
  // raw html wins everywhere — and this is the one place to say so.
  if (children.length > 0 && _hasRawHtml(p)) {
    _devWarn(
      `dih-children-${String(tag)}`,
      `<${
        String(tag)
      }> has both dangerouslySetInnerHTML and children — the raw html wins ` +
        `and the children are ignored (on the server and the client alike). ` +
        `Use one or the other.`,
    );
  }

  const vnode: VNode = { tag, props: p, children, key };

  // Detect fully-static VNodes for diff short-circuit
  if (
    typeof tag === "string" &&
    key === undefined &&
    !p.ref &&
    !p.use &&
    _isStaticProps(p) &&
    _isStaticChildren(children)
  ) {
    vnode._static = true;
  }

  return vnode;
}

// ── Child flattening ──────────────────────────────────────────────────

/** The positional placeholder for "nothing here" — a comment node in the DOM,
 *  `<!---->` in SSR.
 *
 *  ONE constructor, because two would drift: a null CHILD has used one since
 *  AIO-107, and a component that renders `null` now uses the same one. It used
 *  to create no node at all, which meant no `vnode._dom` — and `_dom` is the
 *  anchor the next diff inserts before. So the component that came back was
 *  APPENDED instead: an approval prompt written as the first child of a panel
 *  rendered last, below a screenful of settings and off the bottom of the
 *  window (R-10). Every `x ? <El/> : null` component has that shape —
 *  banners, toasts, modals, validation messages — and those are exactly the
 *  ones whose position carries meaning. It also made SSR disagree with the
 *  client: `vdom-ssr.ts` emits `<!---->` for a null slot, so a null-first
 *  component hydrated in the right place and then MOVED on first re-render. */
export function nullSlot(): VNode {
  return {
    tag: _Null,
    props: {},
    children: [],
    _static: true,
  } as unknown as VNode;
}

/** Vnodes that reached their parent through a NESTED array — a `.map` result,
 *  or any array the runtime flattens out of `children` — and vnodes first seen
 *  as LITERAL siblings. Two sets, because the same vnode can be both, and the
 *  order decides:
 *
 *  The "missing keys" warning (vdom-diff-children.ts) is only meaningful for
 *  a list that came from an expression: keys are how the reconciler follows
 *  rows that move, and rows written out by hand never move. Warned for every
 *  parent with three same-tag children, it fired on every boot of the visual
 *  app manager — a sidebar of four `<div>` panes written literally in the TSX
 *  — pointing at a "fix" (keys on static siblings) that changes nothing. A
 *  warning that is wrong the first time it is read is one that will not be
 *  read the second time.
 *
 *  So a child is an "array child" when the runtime flattened it out of a
 *  nested array. A vnode ALREADY seen as a literal sibling stays literal when
 *  it is later handed on through an expression — `<Panel><a/><b/><c/></Panel>`
 *  becomes `<section>{children}</section>` inside `Panel`, and those are still
 *  the author's hand-written siblings (React: an element validated once as a
 *  static child is never warned for). A vnode first seen inside a nested
 *  array stays an array child even when a wrapper spreads it later.
 *
 *  Kept OFF the vnode — a WeakSet, not a field — so the mark is internal:
 *  nothing on the `VNode` type, nothing enumerable, nothing on the wire. */
const _fromArray = new WeakSet<object>();
const _literal = new WeakSet<object>();

/** True when `v` was flattened out of a nested child array (see `_fromArray`).
 *  @internal */
export function _isFromArray(v: VNode | string | number): boolean {
  return typeof v === "object" && v !== null && _fromArray.has(v);
}

export function flattenChildren(
  raw: VChild[],
  out: (VNode | string | number)[],
  /** True while inside a nested array — every vnode pushed from here on came
   *  out of an expression, not out of the JSX's own child list. */
  nested = false,
): void {
  for (const c of raw) {
    if (c == null || typeof c === "boolean") {
      // AIO-107: preserve null slots as comment-node placeholders for
      // positional stability.
      out.push(nullSlot());
      continue;
    }
    if (Array.isArray(c)) {
      flattenChildren(c, out, true);
    } else if (isSignal(c)) {
      // A signal child is a node of its own (see `_SignalText`): one text node
      // that follows the signal, wherever in the tree it sits.
      out.push(signalText(c as Signal<unknown>));
    } else {
      if (typeof c === "object") {
        if (nested) {
          if (!_literal.has(c)) _fromArray.add(c);
        } else {
          _literal.add(c);
        }
      }
      out.push(c as VNode | string | number);
    }
  }
}

/** The vnode for a signal passed as a child. */
export function signalText(sig: Signal<unknown>): VNode {
  return {
    tag: _SignalText,
    props: {},
    children: [],
    key: undefined,
    _sig: sig,
  };
}

/** Why `v` is not something a component may return — or null when it is.
 *
 *  ONE message for every commit path. `createDom` had a good one ("returned an
 *  array of 3 … wrap the list in a fragment") while `renderToString` fell into
 *  the element branch and died on `Object.entries(undefined)` — a bare
 *  `TypeError: Cannot convert undefined or null to object` naming nothing —
 *  and the client's hint said "wrap the list in a fragment" for a boolean too.
 *  The hint now matches the type. */
export function _notANode(v: unknown): string | null {
  if (v == null || typeof v === "string" || typeof v === "number") return null;
  if (typeof v === "object" && (v as VNode).tag !== undefined) return null;
  const lead = "A component returned ";
  const tail = " where AIR expects a single node. ";
  if (Array.isArray(v)) {
    return `${lead}an array of ${v.length}${tail}Wrap the list in a fragment: ` +
      `<>{items.map(…)}</> (or h(Fragment, null, ...items)).`;
  }
  if (typeof v === "boolean") {
    return `${lead}${v}${tail}Return null to render nothing — \`cond && <X/>\` ` +
      `is fine as a CHILD, but a component's return value must be a node or null.`;
  }
  if (isSignal(v)) {
    return `${lead}a signal${tail}Render its value instead: return <>{sig}</> ` +
      `to bind it as text, or read sig.value inside the component.`;
  }
  if (typeof v === "function") {
    return `${lead}a function${tail}Did you return the component itself ` +
      `instead of rendering it (<Comp/> or h(Comp, null))?`;
  }
  const kind = typeof (v as { then?: unknown }).then === "function"
    ? "a promise (async components are not supported — use lazy() or a resource)"
    : `a ${typeof v}`;
  return `${lead}${kind}${tail}`;
}

// ── Static optimization helpers ───────────────────────────────────────

/** Returns true if all prop values are primitives (or style objects with only primitive values).
 *  Object props (dangerouslySetInnerHTML, className arrays/objects) are rejected — only style allowed. */
export function _isStaticProps(props: Record<string, unknown>): boolean {
  for (const k of Object.keys(props)) {
    const v = props[k];
    if (typeof v === "function") return false;
    if (v !== null && typeof v === "object") {
      // Only style objects with primitive values are considered static
      if (k === "style") {
        for (const sv of Object.values(v as Record<string, unknown>)) {
          if (sv !== null && typeof sv === "object") return false;
          if (typeof sv === "function") return false;
        }
      } else {
        return false;
      }
    }
  }
  return true;
}

/** Returns true if every child is a _static VNode.
 *
 *  A bare string/number child does NOT qualify. In AIR's direct-cell-access
 *  model a text child like `{sol.toFixed(9)}` is produced by evaluating the
 *  component body and carries no signal binding (`_SignalText`) to mark it
 *  reactive — it is indistinguishable from a literal. Treating such text as
 *  static let the `_static` diff short-circuit (vdom-diff.ts) skip real updates:
 *  when a component re-rendered with a changed value, the whole subtree was
 *  reconciled against a stale/emptied `_dom`, freezing the rendered text at its
 *  mount-time value (the a field report "balance number never updates" bug — only
 *  reproduced in a real browser under concurrent parent+child re-renders).
 *  Elements whose children are all real static VNodes (icons, static markup
 *  with no text) still qualify, preserving the optimization where it is sound. */
export function _isStaticChildren(
  children: (VNode | string | number)[],
): boolean {
  if (children.length === 0) return true;
  for (const c of children) {
    if (typeof c === "object") {
      if (!c._static) return false;
    } else {
      // Bare string/number — may be a dynamic value; never static.
      return false;
    }
  }
  return true;
}

/**
 * Deep equality check for two static VNodes.
 * Both are guaranteed to have only primitive props and static-or-primitive children.
 */
const _STATIC_EQ_MAX_DEPTH = 6;

export function _staticEqual(a: VNode, b: VNode, depth = 0): boolean {
  if (depth >= _STATIC_EQ_MAX_DEPTH) return false;
  // Compare props
  const ak = Object.keys(a.props);
  const bk = Object.keys(b.props);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    // Same COUNT is not same KEYS: `{style:"…"}` vs `{"data-n":undefined}`
    // compared equal (one key each, `undefined === undefined` on a's lookup
    // of a key b never had) and the static short-circuit then kept the old
    // element's attributes on screen forever.
    if (!(k in b.props)) return false;
    const av = a.props[k];
    const bv = b.props[k];
    if (av !== bv) {
      // Allow style object comparison
      if (
        k === "style" &&
        av !== null && bv !== null &&
        typeof av === "object" && typeof bv === "object"
      ) {
        const asvk = Object.keys(av as Record<string, unknown>);
        const bsvk = Object.keys(bv as Record<string, unknown>);
        if (asvk.length !== bsvk.length) return false;
        for (const sk of asvk) {
          if (
            !(sk in (bv as Record<string, unknown>)) ||
            (av as Record<string, unknown>)[sk] !==
              (bv as Record<string, unknown>)[sk]
          ) return false;
        }
      } else {
        return false;
      }
    }
  }
  // Compare children
  if (a.children.length !== b.children.length) return false;
  for (let i = 0; i < a.children.length; i++) {
    const ac = a.children[i];
    const bc = b.children[i];
    if (typeof ac !== typeof bc) return false;
    if (typeof ac === "object" && typeof bc === "object") {
      if (ac.tag !== bc.tag || !_staticEqual(ac, bc, depth + 1)) return false;
    } else if (ac !== bc) {
      return false;
    }
  }
  return true;
}

// ── Lazy listener registration ───────────────────────────────────────

/** Walk Suspense children and register onLazyResolve callback on any lazy wrappers. */
export function _registerLazyListeners(
  children: (VNode | string | number)[],
  ctx: RenderCtx,
): void {
  if (!ctx.onLazyResolve) return;
  const cb = ctx.onLazyResolve;
  // The lazy that actually threw — at any depth, including inside a wrapper
  // component whose vnode says nothing about what it renders.
  _takePendingLazyListeners()?.add(cb);
  // …plus any lazy sitting directly in the boundary's children, which is where
  // the PARALLELISM comes from. The boundary aborts its child loop at the first
  // lazy that throws, so the siblings after it were never rendered and never
  // started: they loaded one after another, each waiting for the previous one's
  // re-render, for N round trips where the network could have done them at
  // once. Registering a listener alone did nothing about that — by the time a
  // sibling started, it had already put itself in the pending slot — so this
  // loop STARTS them too.
  for (const child of children) {
    if (typeof child === "object" && typeof child.tag === "function") {
      const listeners = _getLazyListeners(child.tag);
      if (listeners) {
        listeners.add(cb);
        _preloadLazy(child.tag);
      }
    }
  }
}

// ── Ref helpers ───────────────────────────────────────────────────────

/** Deliver a committed node to a `ref` — object refs by assignment, callback
 *  refs by call.
 *
 *  A callback ref is USER CODE that runs INSIDE the commit (createDom / diff /
 *  hydrate / unmount), so an unguarded throw here does not merely fail the
 *  effect: it aborts the commit that invoked it. At mount that took the whole
 *  tree down; on a re-render it left the diff half-applied — the vnode tree said
 *  one thing, the DOM another, and elements went missing from the surface with
 *  the render frozen. Same contract as afterRender/onMount: the effect is
 *  contained and named, the commit stands.
 *
 *  `owner` is the element tag / component name used in that report. */
/** ── Ref commit ──────────────────────────────────────────────────────
 *
 *  A ref is ATTACHED at the end of the commit and DETACHED at once. Refs used
 *  to attach inline, the moment `createDom` built the element — and a commit
 *  that both builds and tears down elements sharing one ref then ended in
 *  whichever order it happened to visit them: `<p ref={r}/>` retagged to
 *  `<i ref={r}/>`, `<A ref={r}/>` swapped with a sibling, wrapped into a
 *  fragment, or its list switching to keys, all set `r` to the new node and
 *  then NULLED it when the old one left, leaving `r` empty while its element
 *  was on screen. Every reconciler that commits in two phases (detach in the
 *  mutation pass, attach in the layout pass) is immune by construction; this
 *  is that, at the granularity of one commit — the outermost `_render`,
 *  `createDom`, `_diff` or `hydrate` entered from outside the reconciler.
 *  A ref therefore also sees its node only once the whole tree is in the
 *  document, which is what a ref that measures or focuses needs anyway. */
let _commitDepth = 0;
let _pendingRefs: { ref: unknown; node: Node; owner?: string }[] = [];

/** Enter a commit. Nested entries (the reconciler recursing through its own
 *  entry points) are the same commit. @internal */
export function _enterCommit(): void {
  _commitDepth++;
}

/** Leave a commit; the OUTERMOST leave attaches the refs it queued. Refs
 *  attached from a ref callback are part of the same flush. @internal */
export function _leaveCommit(): void {
  if (--_commitDepth > 0) return;
  _commitDepth = 0;
  while (_pendingRefs.length > 0) {
    const batch = _pendingRefs;
    _pendingRefs = [];
    for (const { ref, node, owner } of batch) _callRef(ref, node, owner);
  }
}

/** Attach `ref` to `node` — at the end of the current commit, or now when no
 *  commit is open (a direct `_hydrateNode` from a test). @internal */
export function _attachRef(ref: unknown, node: Node, owner?: string): void {
  if (!ref) return;
  if (_commitDepth > 0) _pendingRefs.push({ ref, node, owner });
  else _callRef(ref, node, owner);
}

/** Detach `ref` from `node` — now. A node built and torn down inside ONE
 *  commit (a boundary child that threw, a lazy that resolved to something
 *  else) must not come back to life at the flush, so its queued attach is
 *  dropped; a queued attach to a DIFFERENT node (the same ref moving to a new
 *  element) is exactly what the queue exists to keep. @internal */
export function _detachRef(
  ref: unknown,
  node: Node | null | undefined,
  owner?: string,
): void {
  if (!ref) return;
  if (node && _pendingRefs.length > 0) {
    _pendingRefs = _pendingRefs.filter((p) => p.node !== node);
  }
  _callRef(ref, null, owner);
}

export function _callRef(
  ref: unknown,
  value: Node | null,
  owner?: string,
): void {
  if (typeof ref === "function") {
    try {
      (ref as (v: Node | null) => void)(value);
    } catch (e) {
      _reportHookError("ref", e, owner);
    }
  } else if (ref && typeof ref === "object" && "current" in ref) {
    (ref as { current: Node | null }).current = value;
  }
}

// ── Render-error component tagging ────────────────────────────────────

/** Annotate an error thrown during a component's render with the component
 *  path: innermost first on `__aioComponents`, so
 *  blank-screen overlays and logs can print "(in <NetworkPanel>)" instead of
 *  forcing a manual bisect. Metadata only — `e.message` is never mutated
 *  (ErrorBoundary fallbacks render it to users). Display sites format it via
 *  {@link _componentChainOf}. */
export function _tagComponentError(e: unknown, tag: unknown): void {
  if (!(e instanceof Error)) return;
  const name =
    (typeof tag === "function" ? (tag as { name?: string }).name : "") ||
    "Anonymous";
  const carrier = e as Error & { __aioComponents?: string[] };
  const chain = carrier.__aioComponents;
  if (chain) {
    if (chain.length < 10 && chain[chain.length - 1] !== name) {
      chain.push(name);
    }
  } else {
    carrier.__aioComponents = [name];
  }
}

/** The component path a render error escaped from, innermost first — or null
 *  when the error didn't come through a component render. */
export function _componentChainOf(e: unknown): string[] | null {
  const chain = (e as { __aioComponents?: string[] } | null)?.__aioComponents;
  return Array.isArray(chain) && chain.length > 0 ? chain : null;
}
