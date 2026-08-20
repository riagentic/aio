// VDOM node creation — h() JSX factory, child flattening, static optimization.
// Imports from vdom-types.ts and vdom-lazy.ts only — no circular deps with vdom.ts.

import type { Signal } from "../state/signal.ts";
import { isSignal } from "./signal-binding.ts";
import type { ComponentFn, RenderCtx, VChild, VNode } from "./vdom-types.ts";
import { _Null } from "./vdom-types.ts";
// Symbols imported as types — used only in typeof expressions for h() tag union.
import type {
  ErrorBoundary,
  Fragment,
  Portal,
  Suspense,
} from "./vdom-types.ts";
import { _getLazyListeners, _takePendingLazyListeners } from "./vdom-lazy.ts";
import { _reportHookError } from "./hook-error.ts";

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
  const p = props ?? {};
  const key = p.key as string | number | undefined;
  if (key !== undefined) delete p.key;

  const children: (VNode | string | number)[] = [];
  const signalMap = new Map<number, Signal<unknown>>();
  flattenChildren(rawChildren, children, signalMap);

  const vnode: VNode = { tag, props: p, children, key };
  if (signalMap.size > 0) vnode._signalChildren = signalMap;

  // Detect fully-static VNodes for diff short-circuit
  if (
    !vnode._signalChildren &&
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
 *  window (rimote R-10). Every `x ? <El/> : null` component has that shape —
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

export function flattenChildren(
  raw: VChild[],
  out: (VNode | string | number)[],
  signalMap?: Map<number, Signal<unknown>>,
): void {
  for (const c of raw) {
    if (c == null || typeof c === "boolean") {
      // AIO-107: preserve null slots as comment-node placeholders for
      // positional stability.
      out.push(nullSlot());
      continue;
    }
    if (Array.isArray(c)) {
      flattenChildren(c, out, signalMap);
    } else if (isSignal(c)) {
      // Signal as child: resolve to current value for initial render,
      // store reference for direct text-node binding in createDom.
      const sig = c as Signal<unknown>;
      const idx = out.length;
      const val = sig.peek();
      out.push(val == null ? "" : String(val));
      if (signalMap) signalMap.set(idx, sig);
    } else {
      out.push(c as VNode | string | number);
    }
  }
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
 *  component body and carries no signal binding (`_signalChildren`) to mark it
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
  // …plus any lazy sitting directly in the boundary's children. A sibling
  // lazy that has not rendered yet never threw, so it is not in the pending
  // slot; registering it here keeps one resolution waking the boundary once.
  for (const child of children) {
    if (typeof child === "object" && typeof child.tag === "function") {
      const listeners = _getLazyListeners(child.tag);
      if (listeners) listeners.add(cb);
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
