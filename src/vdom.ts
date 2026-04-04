// AIO VDOM Engine — h(), diff, patch, keyed reconciliation, SSR
// Minimal dependency on signal.ts: imports only `batch` to coalesce
// multiple signal writes in a single event handler into one re-render.

import { batch, effect } from "./signal.ts";
import type { Signal } from "./signal.ts";
import {
  bindSignalProps,
  cleanupSignalBindings,
  isSignal,
  resolveSignalProp,
} from "./signal-binding.ts";
import {
  camelToKebab as _camelToKebab,
  escapeAttr as _escapeAttr,
  escapeHtml as _escapeHtml,
  resolveClassName as _resolveClassName,
  styleValue as _styleValue,
  VOID_ELEMENTS,
} from "./ssr-utils.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

// ── Event delegation ──────────────────────────────────────────────────
// Common bubbling events use a single root listener instead of per-element
// addEventListener. This reduces listener count from O(elements) to O(event types).
// Non-bubbling events (focus, blur, scroll, etc.) remain per-element.
const _DELEGATED_EVENTS = new Set([
  "click",
  "dblclick",
  "mousedown",
  "mouseup",
  "mousemove",
  "contextmenu",
  "keydown",
  "keyup",
  "keypress",
  "input",
  "change",
  "submit",
  "reset",
  "pointerdown",
  "pointerup",
  "pointermove",
  "touchstart",
  "touchend",
  "touchmove",
  "touchcancel",
  "dragstart",
  "dragend",
  "dragenter",
  "dragleave",
  "dragover",
  "drop",
  "drag",
  "copy",
  "cut",
  "paste",
]);

// Per-element map of { eventName -> handler } for delegated event dispatch.
const _wrappedListeners = new WeakMap<Element, Map<string, EventListener>>();

// Tracks which delegation roots have listeners registered per event type,
// and the actual listener references for proper cleanup (AIO-197).
const _delegationRoots = new WeakMap<Element, Map<string, EventListener>>();

/** Register a delegated event listener on the root element. */
export function _ensureDelegation(root: Element, evt: string): void {
  if (!_DELEGATED_EVENTS.has(evt)) return;
  let registered = _delegationRoots.get(root);
  if (!registered) {
    registered = new Map();
    _delegationRoots.set(root, registered);
  }
  if (registered.has(evt)) return;
  const listener = (e: Event) => {
    // Walk composedPath to handle shadow DOM correctly. For each element in the
    // path (target→root), check if it has a handler for this event type.
    const path = e.composedPath();
    for (const node of path) {
      if (node === root) break; // Don't go above mount root
      // Duck-type Element check (nodeType 1) — avoid instanceof which fails
      // in test environments (happy-dom) where global Element is undefined.
      if ((node as Node).nodeType !== 1) continue;
      const handler = _wrappedListeners.get(node as Element)?.get(evt);
      if (handler) {
        // AIO-281: catch handler errors to prevent parent handlers from being skipped
        try {
          handler(e);
        } catch (err) {
          console.error("[aio] event handler error:", err);
        }
        // Respect stopPropagation — check if propagation was stopped
        if (e.cancelBubble) break;
      }
    }
  };
  registered.set(evt, listener);
  root.addEventListener(evt, listener);
}

/** Remove all delegated listeners from a root element. AIO-197: properly
 *  calls removeEventListener to prevent listener accumulation on root reuse. */
export function _teardownDelegation(root: Element): void {
  const registered = _delegationRoots.get(root);
  if (registered) {
    for (const [evt, listener] of registered) {
      root.removeEventListener(evt, listener);
    }
  }
  _delegationRoots.delete(root);
}

// Active delegation root — set by renderer during mount/hydrate/rerender.
// applyProps reads this to lazily register root listeners for delegated events.
let _activeDelegationRoot: Element | null = null;

/** Set the active delegation root (called by renderer before render cycles). */
export function _setDelegationRoot(root: Element | null): void {
  _activeDelegationRoot = root;
}

/** Check if an event type is delegated. */
export function _isDelegated(evt: string): boolean {
  return _DELEGATED_EVENTS.has(evt);
}

// ── Signal text-node bindings ─────────────────────────────────────────
// When a Signal is passed as a child (e.g., h("span", null, countSignal)),
// an effect updates the text node directly without re-rendering the component.
const _signalTextCleanups = new WeakMap<Element, (() => void)[]>();

export function _bindSignalTextChildren(
  el: Element,
  signalMap: Map<number, Signal<unknown>>,
): void {
  const cleanups: (() => void)[] = [];
  for (const [idx, sig] of signalMap) {
    const textNode = el.childNodes[idx];
    if (!textNode || textNode.nodeType !== 3) continue; // safety: must be text node
    const dispose = effect(() => {
      const val = sig.value;
      textNode.textContent = val == null ? "" : String(val);
    });
    cleanups.push(dispose);
  }
  if (cleanups.length > 0) _signalTextCleanups.set(el, cleanups);
}

export function _cleanupSignalTextChildren(el: Element): void {
  const cleanups = _signalTextCleanups.get(el);
  if (cleanups) {
    for (const fn of cleanups) fn();
    _signalTextCleanups.delete(el);
  }
}

// ── Action cleanup handles per element ──────────────────────────────
const _actionCleanups = new WeakMap<HTMLElement, (() => void)[]>();

/** Action function signature for `use` prop. */
export type Action = (node: HTMLElement) => { cleanup?(): void } | void;

/** Run action functions and store cleanup handles. */
export function _applyActions(el: HTMLElement, actions: unknown): void {
  if (!Array.isArray(actions)) return;
  const cleanups: (() => void)[] = [];
  for (const action of actions) {
    if (typeof action !== "function") continue;
    try {
      const result =
        (action as (node: HTMLElement) => { cleanup?(): void } | void)(el);
      if (result && typeof result.cleanup === "function") {
        cleanups.push(result.cleanup);
      }
    } catch (e) {
      console.error("[aio:vdom] action execution error:", e);
    }
  }
  if (cleanups.length > 0) {
    _actionCleanups.set(el, cleanups);
  }
}

/** Run stored cleanup functions for an element's actions. */
function _cleanupActions(el: HTMLElement): void {
  const cleanups = _actionCleanups.get(el);
  if (cleanups) {
    try {
      for (const fn of cleanups) {
        try {
          fn();
        } catch (e) {
          console.error("[aio:vdom] action cleanup error:", e);
        }
      }
    } finally {
      _actionCleanups.delete(el);
    }
  }
}

function _getWrapped(el: Element, evt: string): EventListener | undefined {
  return _wrappedListeners.get(el)?.get(evt);
}

export function _setWrapped(el: Element, evt: string, fn: EventListener): void {
  let map = _wrappedListeners.get(el);
  if (!map) {
    map = new Map();
    _wrappedListeners.set(el, map);
  }
  map.set(evt, fn);
}

function _deleteWrapped(el: Element, evt: string): void {
  _wrappedListeners.get(el)?.delete(evt);
}

// ── Dev mode ────────────────────────────────────────────────────────

let _devMode = false;
const _devWarned = new Set<string>();

/** Enable/disable dev-mode warnings (missing keys, duplicate keys, excessive re-renders). */
export function setDevMode(enabled: boolean): void {
  _devMode = enabled;
  if (!enabled) _devWarned.clear();
}

let _devA11yCheckFn:
  | ((tag: string, props: Record<string, unknown>) => void)
  | null = null;

export function _setDevA11yCheck(
  fn: ((tag: string, props: Record<string, unknown>) => void) | null,
): void {
  _devA11yCheckFn = fn;
}

function _devWarn(id: string, msg: string): void {
  if (!_devMode || _devWarned.has(id)) return;
  _devWarned.add(id);
  console.warn(`[aio-dev] ${msg}`);
}

// ── onChange → onInput mapping (AIO-72: React compat) ─────────────────
// React's onChange fires on every keystroke (it's actually onInput under the hood).
// Native DOM onChange fires on blur. Map onChange→input for form elements so
// React migrants get expected behavior. Applied in applyProps + _hydrateProps.
const _CHANGE_TARGETS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** Map React-style event names to native DOM equivalents.
 *  @param hasOnInput — pass true when both onChange and onInput are on the same element
 *  to avoid collision (AIO-166). When true, onChange keeps native "change" semantics. */
export function _mapEventName(
  evt: string,
  el: Element,
  hasOnInput?: boolean,
): string {
  if (evt === "change" && _CHANGE_TARGETS.has(el.tagName) && !hasOnInput) {
    return "input";
  }
  if (evt === "doubleclick") return "dblclick"; // AIO-165
  return evt;
}

// Props that must be set as DOM properties (not attributes) for correct behavior
const _DOM_PROPS = new Set([
  "value",
  "checked",
  "selected",
  "disabled",
  "readOnly",
  "multiple",
  "indeterminate",
  "defaultChecked",
  "defaultValue",
]);
export const SVG_TAGS = new Set([
  "svg",
  "circle",
  "ellipse",
  "line",
  "path",
  "polygon",
  "polyline",
  "rect",
  "g",
  "defs",
  "symbol",
  "use",
  "text",
  "tspan",
  "textPath",
  "image",
  "clipPath",
  "mask",
  "pattern",
  "marker",
  "linearGradient",
  "radialGradient",
  "stop",
  "filter",
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feConvolveMatrix",
  "feDiffuseLighting",
  "feDisplacementMap",
  "feFlood",
  "feGaussianBlur",
  "feImage",
  "feMerge",
  "feMergeNode",
  "feMorphology",
  "feOffset",
  "feSpecularLighting",
  "feTile",
  "feTurbulence",
  "foreignObject",
  "animate",
  "animateTransform",
  "set",
]);
// VOID_ELEMENTS imported from ssr-utils.ts

// ── Lifecycle hooks (signal-agnostic) ───────────────────────────────

/** Hooks for per-component lifecycle — injected by the renderer, opaque to VDOM. */
export interface VDomHooks {
  /** Called before a component function is invoked. Returns opaque state. */
  beforeComponent(
    vnode: VNode,
    oldVnode: VNode | null,
    parentDom: Node,
    isSvg: boolean,
  ): unknown;
  /** Called after a component function returns. Receives state from before. */
  afterComponent(
    vnode: VNode,
    rendered: VNode | string | number | null,
    state: unknown,
  ): void;
  /** Called after a component's rendered subtree has been created/diffed (optional). */
  afterSubtree?(vnode: VNode): void;
  /** Called when a component function throws during execution (e.g., lazy pending). */
  abortComponent?(vnode: VNode, state: unknown): void;
  /** Called when a component VNode is removed from the tree. */
  unmountComponent(vnode: VNode): void;
}

/** Render context threaded through all VDOM operations. */
export interface RenderCtx {
  doc: Document;
  hooks?: VDomHooks;
  /** Called by Suspense when a lazy child resolves — renderer schedules a re-render. */
  onLazyResolve?: () => void;
  /** Called before a DOM element is removed. Return a Promise to defer removal
   *  (e.g., for exit animations). The element stays in DOM until the promise resolves.
   *  A safety timeout (5s) removes the element if the promise stalls. */
  onBeforeRemove?: (el: HTMLElement, vnode: VNode) => Promise<void> | void;
}

/** Ref type — callback or object. */
export type Ref<T = Node> = ((value: T | null) => void) | { current: T | null };

// ── Types ───────────────────────────────────────────────────────────

/** A component function that receives props and returns a VNode tree or null. */
// deno-lint-ignore no-explicit-any
export type ComponentFn = (props: any) => VNode | null;

/** Valid child types for h() — VNodes, primitives, null/undefined/boolean, or nested arrays. */
export type VChild =
  | VNode
  | string
  | number
  | null
  | undefined
  | boolean
  | VChild[];

/** Virtual DOM node — describes a tag, its props, and children for diffing and patching. */
export interface VNode {
  tag:
    | string
    | typeof Fragment
    | typeof ErrorBoundary
    | typeof Portal
    | typeof Suspense
    | typeof _Null
    | ComponentFn;
  props: Record<string, unknown>;
  children: (VNode | string | number)[];
  key: string | number | undefined;
  _dom?: Node;
  _rendered?: VNode | string | number | null;
  /** Opaque per-component instance — managed by VDomHooks, never read by VDOM. */
  _instance?: unknown;
  /** True when the VNode is fully static (no event handlers, refs, keys, or component children). */
  _static?: true;
  /** Signal text children: maps child index → Signal for direct text-node binding. */
  _signalChildren?: Map<number, Signal<unknown>>;
}

/** Fragment sentinel — groups children without adding a wrapper DOM element. */
export const Fragment = Symbol.for("aio.Fragment");
/** Null placeholder — preserves positional stability in unkeyed children (AIO-107). */
export const _Null = Symbol.for("aio.Null");

/** Error boundary — catches render errors in children, renders fallback. */
export const ErrorBoundary = Symbol.for("aio.ErrorBoundary");

/** Portal — renders children into a target DOM node outside the component hierarchy. */
export const Portal = Symbol.for("aio.Portal");

/** Suspense — shows fallback while lazy children are loading. */
export const Suspense = Symbol.for("aio.Suspense");

/** Sentinel thrown by lazy components to signal "still loading" to Suspense. */
const _LAZY_PENDING = Symbol.for("aio.LazyPending");

/**
 * Lazy-load a component. Use with Suspense for fallback UI.
 * ```ts
 * const LazyComp = lazy(() => import("./HeavyComponent.ts"));
 * // h(Suspense, { fallback: h("span", null, "Loading...") }, h(LazyComp, null))
 * ```
 */
export function lazy<P extends Record<string, unknown>>(
  loader: () => Promise<{ default: ComponentFn }>,
): ComponentFn {
  let resolved: ComponentFn | null = null;
  let loading = false;
  let error: Error | null = null;
  /** Listeners notified when lazy resolves — Suspense boundaries register here. */
  const _listeners = new Set<() => void>();

  const LazyWrapper: ComponentFn = (props: P) => {
    if (resolved) return resolved({ ...props });
    if (error) {
      // Allow retry: clear state so next render re-attempts the import (AIO-129)
      const cached = error;
      error = null;
      loading = false;
      throw cached;
    }
    if (!loading) {
      loading = true;
      loader().then((mod) => {
        resolved = mod.default;
        // Notify all registered Suspense boundaries to re-render
        for (const fn of _listeners) fn();
        _listeners.clear();
      }).catch((e) => {
        error = e;
        loading = false;
        for (const fn of _listeners) fn();
        _listeners.clear();
      });
    }
    // Signal to Suspense that we're still loading
    throw _LAZY_PENDING;
  };

  // Attach listener registry for Suspense boundaries
  (LazyWrapper as unknown as { _lazyListeners: Set<() => void> })
    ._lazyListeners = _listeners;

  return LazyWrapper;
}

/** Check if a ComponentFn is a lazy wrapper with listener support. */
export function _getLazyListeners(fn: ComponentFn): Set<() => void> | null {
  return (fn as unknown as { _lazyListeners?: Set<() => void> })
    ._lazyListeners ?? null;
}

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

/** Returns true if all prop values are primitives (or style objects with only primitive values).
 *  Object props (dangerouslySetInnerHTML, className arrays/objects) are rejected — only style allowed. */
function _isStaticProps(props: Record<string, unknown>): boolean {
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

/** Returns true if all children are primitives or _static VNodes. */
function _isStaticChildren(children: (VNode | string | number)[]): boolean {
  for (const c of children) {
    if (typeof c === "object") {
      if (!c._static) return false;
    }
  }
  return true;
}

/**
 * Deep equality check for two static VNodes.
 * Both are guaranteed to have only primitive props and static-or-primitive children.
 */
const _STATIC_EQ_MAX_DEPTH = 6;

function _staticEqual(a: VNode, b: VNode, depth = 0): boolean {
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

function flattenChildren(
  raw: VChild[],
  out: (VNode | string | number)[],
  signalMap?: Map<number, Signal<unknown>>,
): void {
  for (const c of raw) {
    if (c == null || typeof c === "boolean") {
      // AIO-107: preserve null slots as comment-node placeholders for positional stability
      out.push(
        {
          tag: _Null,
          props: {},
          children: [],
          _static: true,
        } as unknown as VNode,
      );
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

// ── className resolution (array/object/string) ──────────────────────

// _resolveClassName imported from ssr-utils.ts

// ── Lazy listener registration ───────────────────────────────────────

/** Walk Suspense children and register onLazyResolve callback on any lazy wrappers. */
function _registerLazyListeners(
  children: (VNode | string | number)[],
  ctx: RenderCtx,
): void {
  if (!ctx.onLazyResolve) return;
  const cb = ctx.onLazyResolve;
  for (const child of children) {
    if (typeof child === "object" && typeof child.tag === "function") {
      const listeners = _getLazyListeners(child.tag);
      if (listeners) listeners.add(cb);
    }
  }
}

// ── Ref helpers ─────────────────────────────────────────────────────

export function _callRef(ref: unknown, value: Node | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref && typeof ref === "object" && "current" in ref) {
    (ref as { current: Node | null }).current = value;
  }
}

// --- Render ---

export function _render(
  parent: Node,
  vnode: VNode | string | number | null,
  _oldVnode: VNode | string | number | null,
  ctx: RenderCtx,
  isSvg = false,
): void {
  if (vnode == null) return;
  const dom = createDom(vnode, ctx, isSvg, parent);
  if (dom) parent.appendChild(dom);
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

  // Null placeholder — comment node preserving child position (AIO-107)
  if (vnode.tag === _Null) {
    const comment = ctx.doc.createComment("");
    vnode._dom = comment;
    return comment;
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
      throw e;
    }
    vnode._rendered = rendered;
    try {
      ctx.hooks?.afterComponent(vnode, rendered, hookState);
      if (rendered == null) return null;
      const dom = createDom(rendered, ctx, isSvg, parentDom);
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
    try {
      const frag = ctx.doc.createDocumentFragment();
      let firstDom: Node | null = null;
      for (const child of vnode.children) {
        const childDom = createDom(child, ctx, isSvg, parentDom);
        if (childDom) {
          if (!firstDom) firstDom = childDom;
          frag.appendChild(childDom);
        }
      }
      if (firstDom) vnode._dom = firstDom;
      return frag;
    } catch (error) {
      // AIO-178: re-throw _LAZY_PENDING so Suspense can handle it
      if (error === _LAZY_PENDING) throw error;
      if (!fallback) throw error;
      const fallbackVnode = fallback(error as Error);
      vnode._rendered = fallbackVnode;
      if (fallbackVnode == null) return null;
      const dom = createDom(fallbackVnode, ctx, isSvg, parentDom);
      vnode._dom = dom ?? undefined;
      return dom;
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
          if (!firstDom) firstDom = childDom;
          frag.appendChild(childDom);
        }
      }
      if (firstDom) vnode._dom = firstDom;
      return frag;
    } catch (thrown) {
      if (thrown !== _LAZY_PENDING) throw thrown;
      // Register for lazy resolution notifications
      _registerLazyListeners(vnode.children, ctx);
      // Lazy child not ready — render fallback
      vnode._rendered = fallback ?? null;
      if (fallback == null) return null;
      const dom = createDom(fallback, ctx, isSvg, parentDom);
      vnode._dom = dom ?? undefined;
      return dom;
    }
  }

  // Portal — render children into target DOM node
  if (vnode.tag === Portal) {
    const target = vnode.props.target as Node;
    if (!target) return null;
    // AIO-184: try-finally ensures delegation root is restored on error
    const prevDelegation = _activeDelegationRoot;
    if ((target as Node).nodeType === 1) {
      _activeDelegationRoot = target as Element;
    }
    try {
      for (const child of vnode.children) {
        const childDom = createDom(child, ctx, false, target);
        if (childDom) target.appendChild(childDom);
      }
    } finally {
      _activeDelegationRoot = prevDelegation;
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
        if (!firstDom) firstDom = childDom;
        frag.appendChild(childDom);
      }
    }
    if (firstDom) {
      vnode._dom = firstDom;
    } else {
      // AIO-195: empty Fragment gets comment anchor for correct positioning.
      // Without this, later diffs that add children use appendChild (wrong
      // position when Fragment has siblings after it).
      const anchor = ctx.doc.createComment("");
      frag.appendChild(anchor);
      vnode._dom = anchor;
    }
    return frag;
  }

  // Element
  const tag = vnode.tag as string;
  const nowSvg = isSvg || SVG_TAGS.has(tag);
  const el = nowSvg
    ? ctx.doc.createElementNS(SVG_NS, tag)
    : ctx.doc.createElement(tag);

  applyProps(el as HTMLElement, vnode.props, {});
  bindSignalProps(el as HTMLElement, vnode.props);
  if (_devA11yCheckFn) _devA11yCheckFn(tag, vnode.props);

  for (let i = 0; i < vnode.children.length; i++) {
    const childDom = createDom(vnode.children[i]!, ctx, nowSvg, el);
    if (childDom) el.appendChild(childDom);
  }

  // Bind signal text children — direct text-node effects bypassing VDOM diff
  if (vnode._signalChildren) {
    _bindSignalTextChildren(el, vnode._signalChildren);
  }

  // Call ref after element + children are fully built
  if (vnode.props.ref) _callRef(vnode.props.ref, el);
  if (vnode.props.use) _applyActions(el as HTMLElement, vnode.props.use);

  vnode._dom = el;
  return el;
}

// _camelToKebab imported from ssr-utils.ts

/** Check if any signal prop identity changed between old and new props. */
function _hasSignalPropChange(
  next: Record<string, unknown>,
  prev: Record<string, unknown>,
): boolean {
  for (const [k, v] of Object.entries(next)) {
    if (isSignal(v) && v !== prev[k]) return true;
  }
  for (const [k, v] of Object.entries(prev)) {
    if (isSignal(v) && !isSignal(next[k])) return true;
  }
  return false;
}

function applyProps(
  el: HTMLElement,
  next: Record<string, unknown>,
  prev: Record<string, unknown>,
): void {
  // AIO-166: detect onChange+onInput collision on form elements
  const _hasOnInput = "onInput" in next && _CHANGE_TARGETS.has(el.tagName);

  // Remove old props not in next
  for (const k of Object.keys(prev)) {
    if (k === "key" || k === "children" || k === "ref" || k === "use") continue;
    if (!(k in next)) {
      if (k.startsWith("on")) {
        const evt = _mapEventName(
          k.slice(2).toLowerCase(),
          el,
          k === "onChange" ? _hasOnInput : undefined,
        );
        if (_DELEGATED_EVENTS.has(evt)) {
          // Also removeEventListener in case it was per-element fallback (AIO-154)
          const wrapped = _getWrapped(el, evt);
          if (wrapped) el.removeEventListener(evt, wrapped);
          _deleteWrapped(el, evt);
        } else {
          const wrapped = _getWrapped(el, evt);
          el.removeEventListener(evt, wrapped ?? prev[k] as EventListener);
          _deleteWrapped(el, evt);
        }
      } else if (k === "className") {
        el.removeAttribute("class");
      } else if (k === "style") {
        el.removeAttribute("style");
      } else if (k === "dangerouslySetInnerHTML") {
        el.innerHTML = ""; // AIO-80: clear stale innerHTML
      } else if (k in el && _DOM_PROPS.has(k)) {
        // deno-lint-ignore no-explicit-any
        (el as any)[k] = typeof (el as any)[k] === "boolean" ? false : "";
      } else {
        el.removeAttribute(k);
      }
    }
  }

  // Set new/changed props
  for (const [k, v] of Object.entries(next)) {
    if (k === "key" || k === "children" || k === "ref" || k === "use") continue;
    const rv = resolveSignalProp(v);
    if (isSignal(v)) continue; // Signal binding handles ongoing updates via effect
    if (prev[k] === rv) continue;

    if (k.startsWith("on")) {
      const evt = _mapEventName(
        k.slice(2).toLowerCase(),
        el,
        k === "onChange" ? _hasOnInput : undefined,
      );
      // AIO-106: null/false handler = removal only, don't wrap non-function
      if (rv == null || rv === false) {
        if (!_DELEGATED_EVENTS.has(evt)) {
          const oldWrapped = _getWrapped(el, evt);
          if (oldWrapped) el.removeEventListener(evt, oldWrapped);
          else if (prev[k]) {
            el.removeEventListener(evt, prev[k] as EventListener);
          }
        }
        _deleteWrapped(el, evt);
        continue;
      }
      // Wrap handler in batch() to coalesce multiple signal writes into one render
      const handler = rv as EventListener;
      const wrapped = (e: Event) => batch(() => handler(e));
      if (_DELEGATED_EVENTS.has(evt) && _activeDelegationRoot) {
        // Delegated: store in lookup map — root listener dispatches via composedPath
        _ensureDelegation(_activeDelegationRoot, evt);
        _setWrapped(el, evt, wrapped);
      } else {
        // Non-delegated (focus, blur, scroll, etc.): per-element listener
        const oldWrapped = _getWrapped(el, evt);
        if (oldWrapped) el.removeEventListener(evt, oldWrapped);
        else if (prev[k]) el.removeEventListener(evt, prev[k] as EventListener);
        el.addEventListener(evt, wrapped);
        _setWrapped(el, evt, wrapped);
      }
    } else if (k === "className") {
      const cls = _resolveClassName(rv);
      if (cls) el.setAttribute("class", cls);
      else el.removeAttribute("class");
    } else if (k === "style" && typeof rv === "string") {
      el.style.cssText = rv;
    } else if (k === "style" && typeof rv === "object" && rv !== null) {
      const style = el.style;
      const newStyle = rv as Record<string, unknown>;
      const prevIsString = typeof prev[k] === "string";
      const oldStyle: Record<string, unknown> = prevIsString
        ? {}
        : ((prev[k] as Record<string, unknown>) ?? {});
      // AIO-163: if old style was a string, clear all before applying object
      if (prevIsString) {
        style.cssText = "";
      } else {
        // Remove stale style properties not in new style
        for (const sk of Object.keys(oldStyle)) {
          if (!(sk in newStyle)) {
            style.removeProperty(_camelToKebab(sk));
          }
        }
      }
      // Set new/changed style properties (resolve any signal values within style obj)
      for (const [sk, sv] of Object.entries(newStyle)) {
        const rsv = resolveSignalProp(sv);
        if (isSignal(sv)) continue; // style-level signal binding handles via effect
        const oldRsv = resolveSignalProp(oldStyle[sk]);
        if (oldRsv !== rsv) {
          style.setProperty(_camelToKebab(sk), _styleValue(sk, rsv));
        }
      }
    } else if (k === "dangerouslySetInnerHTML") {
      // AIO-200: handle both truthy object and null/false transition
      if (rv && typeof rv === "object") {
        el.innerHTML = (rv as { __html: string }).__html ?? "";
      } else {
        el.innerHTML = "";
      }
    } else if (k in el && _DOM_PROPS.has(k)) {
      // DOM properties (form elements): assign directly instead of setAttribute
      // deno-lint-ignore no-explicit-any
      (el as any)[k] = rv ?? "";
    } else if (rv === false || rv == null) {
      el.removeAttribute(k);
    } else {
      el.setAttribute(k, String(rv));
    }
  }
}

// --- Diff ---

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
    // Anchor for insertion: first DOM node of old, then insert new before removing old.
    // removeDom handles Fragment/Component children recursively (AIO-105).
    const anchor = getDom(old);
    const newDom = createDom(next, ctx, isSvg, parent);
    if (newDom && anchor) {
      parent.insertBefore(newDom, anchor);
    } else if (newDom) {
      parent.appendChild(newDom);
    }
    removeDom(parent, old, ctx);
    return;
  }

  // Same tag VNodes — patch in place
  const nv = next as VNode;
  const ov = old as VNode;

  // Static VNode short-circuit: reuse DOM without patching when content is identical
  if (nv._static && ov._static && nv.tag === ov.tag && _staticEqual(nv, ov)) {
    nv._dom = ov._dom;
    // Transfer children _dom references
    for (let i = 0; i < nv.children.length && i < ov.children.length; i++) {
      const nc = nv.children[i];
      const oc = ov.children[i];
      if (typeof nc === "object" && typeof oc === "object") {
        nc._dom = oc._dom;
      }
    }
    return;
  }

  // Null placeholder — transfer DOM reference (AIO-107)
  if (nv.tag === _Null) {
    nv._dom = ov._dom;
    return;
  }

  // Components — call hooks, re-execute, diff output
  if (typeof nv.tag === "function") {
    // Transfer instance from old to new VNode
    nv._instance = ov._instance;

    const hookState = ctx.hooks?.beforeComponent(nv, ov, parent, isSvg);

    // Check if hook says skip (auto-memo)
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
      throw e;
    }
    nv._rendered = rendered;
    try {
      ctx.hooks?.afterComponent(nv, rendered, hookState);
      _diff(parent, rendered ?? null, ov._rendered ?? null, ctx, isSvg);
      nv._dom = rendered ? (getDom(rendered) ?? undefined) : undefined;
    } finally {
      ctx.hooks?.afterSubtree?.(nv);
    }
    return;
  }

  // ErrorBoundary — diff children with error catching
  if (nv.tag === ErrorBoundary) {
    const fallback = nv.props.fallback as
      | ((e: Error) => VNode | string | number | null)
      | undefined;
    const wasError = ov._rendered != null; // Previous render was in error state

    try {
      if (wasError) {
        // Recovering from error: remove old fallback, render children fresh
        removeDom(parent, ov._rendered!, ctx);
        const frag = ctx.doc.createDocumentFragment();
        let firstDom: Node | null = null;
        for (const child of nv.children) {
          const childDom = createDom(child, ctx, isSvg, parent);
          if (childDom) {
            if (!firstDom) firstDom = childDom;
            frag.appendChild(childDom);
          }
        }
        parent.appendChild(frag);
        // Clear stale _dom if no children produced DOM (AIO-143)
        nv._dom = firstDom ?? undefined;
      } else {
        // Normal diff children
        diffChildren(parent, nv.children, ov.children, ctx, isSvg);
        let foundDom = false;
        for (const child of nv.children) {
          const d = getDom(child);
          if (d) {
            nv._dom = d;
            foundDom = true;
            break;
          }
        }
        if (foundDom) {
          // AIO-168: remove old comment anchor when content returns
          const ovDom = ov._dom;
          if (ovDom && ovDom.nodeType === 8 && ovDom.parentNode === parent) {
            parent.removeChild(ovDom);
          }
        } else {
          // Empty ErrorBoundary — comment anchor for positioning (AIO-162)
          const ovDom = ov._dom;
          if (ovDom && ovDom.nodeType === 8) {
            nv._dom = ovDom;
          } else {
            const anchor = ctx.doc.createComment("");
            if (ovDom && ovDom.parentNode === parent) {
              parent.insertBefore(anchor, ovDom);
            } else {
              parent.appendChild(anchor);
            }
            nv._dom = anchor;
          }
        }
      }
      nv._rendered = undefined; // Clear error state
    } catch (error) {
      // AIO-178: re-throw _LAZY_PENDING so Suspense can handle it
      if (error === _LAZY_PENDING) throw error;
      if (!fallback) throw error;
      // AIO-190: call fallback BEFORE removing old DOM — if fallback throws,
      // old content remains visible (better than empty container)
      let fallbackVnode: VNode | string | number | null;
      try {
        fallbackVnode = fallback(error as Error);
      } catch (fallbackError) {
        console.error(
          "[aio:vdom] ErrorBoundary fallback threw:",
          fallbackError,
        );
        throw fallbackError; // re-throw, old DOM stays
      }
      // Fallback succeeded — safe to remove old DOM and render fallback
      if (!wasError) {
        for (const child of ov.children) removeDom(parent, child, ctx);
      } else if (ov._rendered != null) {
        removeDom(parent, ov._rendered, ctx);
      }
      nv._rendered = fallbackVnode;
      if (fallbackVnode != null) {
        _render(parent, fallbackVnode, null, ctx, isSvg);
        nv._dom = getDom(fallbackVnode) ?? undefined;
      }
    }
    return;
  }

  // Suspense — diff children, catch lazy pending
  if (nv.tag === Suspense) {
    const fallback = nv.props.fallback as
      | VNode
      | string
      | number
      | null
      | undefined;
    const wasPending = ov._rendered != null;
    try {
      if (wasPending) {
        // Was showing fallback, try rendering children again
        removeDom(parent, ov._rendered!, ctx);
        const frag = ctx.doc.createDocumentFragment();
        let firstDom: Node | null = null;
        // AIO-201: track created children so we can clean up on partial failure
        const created: (VNode | string | number)[] = [];
        try {
          for (const child of nv.children) {
            const childDom = createDom(child, ctx, isSvg, parent);
            if (childDom) {
              if (!firstDom) firstDom = childDom;
              frag.appendChild(childDom);
            }
            created.push(child);
          }
        } catch (innerThrown) {
          // AIO-201: clean up partially-created children (unmount components,
          // dispose signal bindings, null refs) before re-throwing
          for (const child of created) {
            if (typeof child === "object") _removeDomCleanup(child, ctx);
          }
          throw innerThrown;
        }
        parent.appendChild(frag);
        // Clear stale _dom if no children produced DOM (AIO-143)
        nv._dom = firstDom ?? undefined;
      } else {
        diffChildren(parent, nv.children, ov.children, ctx, isSvg);
        let foundDom = false;
        for (const child of nv.children) {
          const d = getDom(child);
          if (d) {
            nv._dom = d;
            foundDom = true;
            break;
          }
        }
        if (foundDom) {
          // AIO-168: remove old comment anchor when content returns
          const ovDom = ov._dom;
          if (ovDom && ovDom.nodeType === 8 && ovDom.parentNode === parent) {
            parent.removeChild(ovDom);
          }
        } else {
          // Empty Suspense — comment anchor for positioning (AIO-162)
          const ovDom = ov._dom;
          if (ovDom && ovDom.nodeType === 8) {
            nv._dom = ovDom;
          } else {
            const anchor = ctx.doc.createComment("");
            if (ovDom && ovDom.parentNode === parent) {
              parent.insertBefore(anchor, ovDom);
            } else {
              parent.appendChild(anchor);
            }
            nv._dom = anchor;
          }
        }
      }
      nv._rendered = undefined;
    } catch (thrown) {
      if (thrown !== _LAZY_PENDING) throw thrown;
      // Register for lazy resolution notifications
      _registerLazyListeners(nv.children, ctx);
      if (!wasPending) {
        for (const child of ov.children) removeDom(parent, child, ctx);
      } else if (ov._rendered != null) {
        removeDom(parent, ov._rendered, ctx);
      }
      nv._rendered = fallback ?? null;
      if (fallback != null) {
        _render(parent, fallback, null, ctx, isSvg);
        nv._dom = getDom(fallback) ?? undefined;
      }
    }
    return;
  }

  // Portal — diff children inside target DOM node
  if (nv.tag === Portal) {
    const target = nv.props.target as Node;
    const oldTarget = ov.props.target as Node | undefined;
    if (target) {
      // AIO-184: try-finally ensures delegation root is restored on error
      const prevDelegation = _activeDelegationRoot;
      if ((target as Node).nodeType === 1) {
        _activeDelegationRoot = target as Element;
      }
      try {
        // AIO-179: if target changed, remove old children from old target and create fresh
        if (oldTarget && oldTarget !== target) {
          for (const child of ov.children) removeDom(oldTarget, child, ctx);
          for (const child of nv.children) {
            const dom = createDom(child, ctx, false, target);
            if (dom) target.appendChild(dom);
          }
        } else {
          diffChildren(target, nv.children, ov.children, ctx, false);
        }
      } finally {
        _activeDelegationRoot = prevDelegation;
      }
    }
    return;
  }

  // Fragment — diff children, update _dom to first child
  if (nv.tag === Fragment) {
    diffChildren(parent, nv.children, ov.children, ctx, isSvg);
    // Track first child DOM for getDom() lookups
    let foundDom = false;
    for (const child of nv.children) {
      const d = getDom(child);
      if (d) {
        nv._dom = d;
        foundDom = true;
        break;
      }
    }
    if (foundDom) {
      // AIO-168: Fragment went from empty (comment anchor) to non-empty — remove
      // the old comment anchor so it doesn't leak into the DOM.
      const ovDom = ov._dom;
      if (ovDom && ovDom.nodeType === 8 && ovDom.parentNode === parent) {
        parent.removeChild(ovDom);
      }
    } else {
      // Empty Fragment — insert comment anchor for correct positioning (AIO-128)
      const ovDom = ov._dom;
      if (ovDom && ovDom.nodeType === 8) {
        // Reuse existing comment anchor
        nv._dom = ovDom;
      } else {
        const anchor = ctx.doc.createComment("");
        if (ovDom && ovDom.parentNode === parent) {
          parent.insertBefore(anchor, ovDom);
        } else {
          parent.appendChild(anchor);
        }
        nv._dom = anchor;
      }
    }
    return;
  }

  // Element
  const dom = ov._dom as HTMLElement;
  if (!dom) return;
  nv._dom = dom;

  const tag = nv.tag as string;
  const nowSvg = isSvg || SVG_TAGS.has(tag);

  applyProps(dom, nv.props, ov.props);

  // Re-bind signal props if any signal identity changed
  if (_hasSignalPropChange(nv.props, ov.props)) {
    bindSignalProps(dom as HTMLElement, nv.props);
  }

  // Handle ref update
  if (nv.props.ref !== ov.props.ref) {
    if (ov.props.ref) _callRef(ov.props.ref, null);
    if (nv.props.ref) _callRef(nv.props.ref, dom);
  }

  // Handle action update — cleanup old, apply new
  if (nv.props.use !== ov.props.use) {
    _cleanupActions(dom);
    if (nv.props.use) _applyActions(dom, nv.props.use);
  }

  diffChildren(dom, nv.children, ov.children, ctx, nowSvg);

  // Re-bind signal text children if they changed
  if (nv._signalChildren || ov._signalChildren) {
    _cleanupSignalTextChildren(dom);
    if (nv._signalChildren) {
      _bindSignalTextChildren(dom, nv._signalChildren);
    }
  }
}

function diffChildren(
  parent: Node,
  nextChildren: (VNode | string | number)[],
  oldChildren: (VNode | string | number)[],
  ctx: RenderCtx,
  isSvg: boolean,
): void {
  const hasKeys = nextChildren.some(
    (c) => typeof c === "object" && c.key !== undefined,
  );

  if (_devMode && nextChildren.length > 1) {
    const someKeyed = hasKeys;
    const someUnkeyed = nextChildren.some(
      (c) => typeof c === "object" && c.key === undefined,
    );
    // AIO-69: Warn when multiple element children have no keys at all
    if (!someKeyed && someUnkeyed && nextChildren.length > 2) {
      const vnodeChildren = nextChildren.filter(
        (c) => typeof c === "object" && typeof c.tag !== "undefined",
      );
      // Only warn for lists of same-tag elements (likely a .map() result)
      if (vnodeChildren.length > 2) {
        const tags = new Set(vnodeChildren.map((c) => (c as VNode).tag));
        if (tags.size === 1) {
          _devWarn(
            "missing-keys",
            `${vnodeChildren.length} <${
              String([...tags][0])
            }> children without keys. Add key props for correct reconciliation.`,
          );
        }
      }
    }
    // Mixed keyed/unkeyed children
    if (someKeyed && someUnkeyed) {
      _devWarn(
        "mixed-keys",
        "Mixed keyed and unkeyed children — all siblings should have keys or none.",
      );
    }
    // Duplicate keys
    if (hasKeys) {
      const keys = new Set<string | number>();
      for (const c of nextChildren) {
        if (typeof c === "object" && c.key !== undefined) {
          if (keys.has(c.key)) {
            _devWarn(
              `dup-key-${String(c.key)}`,
              `Duplicate key "${String(c.key)}" in children list.`,
            );
          }
          keys.add(c.key);
        }
      }
    }
  }

  if (hasKeys) {
    diffKeyed(
      parent,
      nextChildren as VNode[],
      oldChildren as VNode[],
      ctx,
      isSvg,
    );
  } else {
    diffUnkeyed(parent, nextChildren, oldChildren, ctx, isSvg);
  }
}

/** Count the number of direct DOM nodes a vnode occupies (Fragments expand). */
function _domNodeCount(child: VNode | string | number): number {
  if (typeof child !== "object") return 1; // text node
  if (child.tag === Fragment) {
    let n = 0;
    for (const c of child.children) n += _domNodeCount(c);
    // AIO-169: empty Fragment with comment anchor occupies 1 DOM node.
    // Without this, cursor misaligns in diffUnkeyed/diffKeyed.
    return n || (child._dom ? 1 : 0);
  }
  return 1; // element, component, _Null placeholder
}

function diffUnkeyed(
  parent: Node,
  nextChildren: (VNode | string | number)[],
  oldChildren: (VNode | string | number)[],
  ctx: RenderCtx,
  isSvg: boolean,
): void {
  // Snapshot DOM nodes for old children BEFORE mutations.
  // Walk parent.childNodes sequentially — index-based lookup is wrong when
  // Fragments expand into multiple DOM nodes, shifting subsequent indices.
  const oldDoms: (Node | null)[] = [];
  let cursor: ChildNode | null = parent.firstChild;
  for (let i = 0; i < oldChildren.length; i++) {
    const child = oldChildren[i]!;
    const dom = getDom(child);
    if (dom) {
      oldDoms.push(dom);
      // Advance cursor past this child's DOM footprint
      const count = _domNodeCount(child);
      for (let j = 0; j < count; j++) {
        cursor = cursor?.nextSibling ?? null;
      }
    } else {
      // string/number — text node at current cursor position
      // Push cursor as-is (even if not text node) for position reference.
      // nodeType is checked later before setting textContent.
      oldDoms.push(cursor);
      cursor = cursor?.nextSibling ?? null;
    }
  }

  const max = Math.max(nextChildren.length, oldChildren.length);
  for (let i = 0; i < max; i++) {
    const nc = i < nextChildren.length ? nextChildren[i]! : null;
    const oc = i < oldChildren.length ? oldChildren[i]! : null;

    if (nc == null && oc != null) {
      // Remove — for text nodes, remove directly since removeDom can't find them
      if (typeof oc === "string" || typeof oc === "number") {
        const textNode = oldDoms[i];
        if (textNode?.parentNode === parent) parent.removeChild(textNode);
      } else {
        removeDom(parent, oc, ctx);
      }
    } else if (nc != null && oc == null) {
      // Append new child
      const newDom = createDom(nc, ctx, isSvg, parent);
      if (newDom) parent.appendChild(newDom);
    } else if (
      (typeof nc === "string" || typeof nc === "number") &&
      (typeof oc === "string" || typeof oc === "number")
    ) {
      // Text update in place
      const oldDom = oldDoms[i];
      if (oldDom && oldDom.nodeType === 3) {
        // Cursor is a text node — patch in place
        if (String(nc) !== String(oc)) oldDom.textContent = String(nc);
      } else {
        // Missing or nodeType mismatch — create fresh text node at correct position (AIO-137)
        const newText = ctx.doc.createTextNode(String(nc));
        if (oldDom) {
          parent.insertBefore(newText, oldDom);
          parent.removeChild(oldDom); // remove mismatched node
        } else {
          parent.appendChild(newText);
        }
      }
    } else {
      // Diff vnodes
      _diff(parent, nc!, oc!, ctx, isSvg);
    }
  }
}

function diffKeyed(
  parent: Node,
  nextChildren: VNode[],
  oldChildren: VNode[],
  ctx: RenderCtx,
  isSvg: boolean,
): void {
  // Build map of old keys → old VNode, collect old non-keyed for positional matching (AIO-114)
  const oldMap = new Map<string | number, VNode>();
  const oldNonKeyed: (VNode | string | number)[] = [];
  const oldNonKeyedDoms: (Node | null)[] = [];

  // Walk parent.childNodes to map old non-keyed children to DOM nodes
  let cursor: ChildNode | null = parent.firstChild;
  for (const oc of (oldChildren as (VNode | string | number)[])) {
    if (
      typeof oc === "object" && oc !== null && (oc as VNode).key !== undefined
    ) {
      oldMap.set((oc as VNode).key!, oc as VNode);
      // Advance cursor past this keyed node's entire DOM footprint (Fragments expand)
      const count = _domNodeCount(oc);
      for (let j = 0; j < count; j++) {
        cursor = cursor?.nextSibling ?? null;
      }
    } else {
      oldNonKeyed.push(oc);
      const dom = getDom(oc);
      if (dom) {
        oldNonKeyedDoms.push(dom);
        // Advance past this non-keyed node's DOM footprint
        const count = _domNodeCount(oc);
        for (let j = 0; j < count; j++) {
          cursor = cursor?.nextSibling ?? null;
        }
      } else {
        // string/number — text node at cursor
        // Push cursor as-is for position reference; nodeType checked at usage
        oldNonKeyedDoms.push(cursor);
        cursor = cursor?.nextSibling ?? null;
      }
    }
  }

  const usedKeys = new Set<string | number>();
  let lastPlaced: Node | null = null;
  let nkIdx = 0;

  for (const nc of (nextChildren as (VNode | string | number)[])) {
    // Non-keyed child: positionally match against old non-keyed (AIO-114)
    if (
      typeof nc !== "object" || nc === null || (nc as VNode).key === undefined
    ) {
      const onk = nkIdx < oldNonKeyed.length ? oldNonKeyed[nkIdx] : null;
      const onkDom = nkIdx < oldNonKeyedDoms.length
        ? oldNonKeyedDoms[nkIdx]
        : null;
      nkIdx++;

      if (
        onk != null && typeof nc !== "string" && typeof nc !== "number" &&
        typeof onk !== "string" && typeof onk !== "number"
      ) {
        // Both are VNodes — diff in place
        _diff(parent, nc, onk as VNode, ctx, isSvg);
        const dom = (nc as VNode)._dom ?? (onk as VNode)._dom;
        if (dom) {
          const a: Node | null = lastPlaced
            ? lastPlaced.nextSibling
            : parent.firstChild;
          if (dom !== a) parent.insertBefore(dom, a);
          lastPlaced = dom;
        }
      } else if (
        onk != null && (typeof nc === "string" || typeof nc === "number") &&
        (typeof onk === "string" || typeof onk === "number")
      ) {
        // Both text — update in place
        let textDom: Node | null = onkDom && onkDom.nodeType === 3
          ? onkDom
          : null;
        if (textDom) {
          if (String(nc) !== String(onk)) textDom.textContent = String(nc);
        } else {
          // Missing or nodeType mismatch — create fresh text node (AIO-137)
          textDom = ctx.doc.createTextNode(String(nc));
          // Remove mismatched DOM node to prevent orphan
          if (onkDom?.parentNode === parent) parent.removeChild(onkDom);
        }
        if (textDom) {
          const a: Node | null = lastPlaced
            ? lastPlaced.nextSibling
            : parent.firstChild;
          if (textDom !== a) parent.insertBefore(textDom, a);
          lastPlaced = textDom;
        }
      } else {
        // Type mismatch or no old match — remove old, create new
        // AIO-181: use removeDom for VNodes (handles Fragments with multiple children)
        // instead of removeChild(getDom()) which only removes the first DOM node.
        if (onk != null) {
          if (typeof onk === "object") {
            removeDom(parent, onk as VNode, ctx);
          } else if (onkDom?.parentNode === parent) {
            parent.removeChild(onkDom);
          }
        }
        const newDom = createDom(
          nc as VNode | string | number,
          ctx,
          isSvg,
          parent,
        );
        if (newDom) {
          const anchor = lastPlaced
            ? lastPlaced.nextSibling
            : parent.firstChild;
          parent.insertBefore(newDom, anchor);
          lastPlaced = newDom;
        }
      }
      continue;
    }
    const key = (nc as VNode).key!;
    usedKeys.add(key);
    const oc = oldMap.get(key);

    if (oc) {
      // Existing node — diff in place
      _diff(parent, nc, oc, ctx, isSvg);
      const dom = nc._dom ?? oc._dom;
      if (dom) {
        // Move to correct position: after lastPlaced (or at start if null)
        const anchor: Node | null = lastPlaced
          ? lastPlaced.nextSibling
          : parent.firstChild;
        // AIO-177: For Fragments, move ALL children (not just first)
        if (typeof nc === "object" && (nc as VNode).tag === Fragment) {
          for (const child of (nc as VNode).children) {
            const childDom = getDom(child);
            if (childDom && childDom.parentNode === parent) {
              const a: Node | null = lastPlaced
                ? lastPlaced.nextSibling
                : parent.firstChild;
              if (childDom !== a) parent.insertBefore(childDom, a);
              lastPlaced = childDom;
            }
          }
          // Handle empty Fragment comment anchor
          if (dom.nodeType === 8 && dom.parentNode === parent) {
            const a: Node | null = lastPlaced
              ? lastPlaced.nextSibling
              : parent.firstChild;
            if (dom !== a) parent.insertBefore(dom, a);
            lastPlaced = dom;
          }
        } else {
          if (dom !== anchor) {
            parent.insertBefore(dom, anchor);
          }
          lastPlaced = dom;
        }
      }
    } else {
      // New node — create and insert at correct position
      const newDom = createDom(nc, ctx, isSvg, parent);
      if (newDom) {
        const anchor2: Node | null = lastPlaced
          ? lastPlaced.nextSibling
          : parent.firstChild;
        parent.insertBefore(newDom, anchor2);
        // AIO-177/AIO-248: For new Fragments, advance lastPlaced to the LAST child DOM.
        // After insertBefore, walk from the first inserted child (not lastPlaced itself).
        if (typeof nc === "object" && (nc as VNode).tag === Fragment) {
          const count = _domNodeCount(nc as VNode);
          const firstInserted = lastPlaced
            ? lastPlaced.nextSibling
            : parent.firstChild;
          let node: Node | null = firstInserted;
          for (let i = 1; i < count && node; i++) {
            node = node.nextSibling;
          }
          if (node) lastPlaced = node;
        } else {
          lastPlaced = newDom;
        }
      }
    }
  }

  // Remove old keyed nodes not in next
  for (const oc of oldChildren) {
    if (oc.key !== undefined && !usedKeys.has(oc.key)) {
      removeDom(parent, oc, ctx);
    }
  }
  // Remove excess old non-keyed children not matched above (AIO-114)
  for (let i = nkIdx; i < oldNonKeyed.length; i++) {
    const onk = oldNonKeyed[i]!;
    const dom = oldNonKeyedDoms[i];
    if (typeof onk === "object") {
      removeDom(parent, onk as VNode, ctx);
    } else if (dom?.parentNode === parent) {
      parent.removeChild(dom);
    }
  }
}

/** Get the real DOM node associated with a VNode, or null if not mounted. */
export function getDom(vnode: VNode | string | number): Node | null {
  if (typeof vnode === "object" && vnode !== null) {
    return vnode._dom ?? null;
  }
  return null;
}

/** Cleanup component instances without removing DOM (for type-mismatch replacement). */
function _removeDomCleanup(
  vnode: VNode | string | number,
  ctx: RenderCtx,
): void {
  if (typeof vnode !== "object") return;
  if (typeof vnode.tag === "function") {
    ctx.hooks?.unmountComponent(vnode);
    if (vnode._rendered != null) _removeDomCleanup(vnode._rendered, ctx);
  }
  // Cleanup actions before nulling refs
  if (typeof vnode.tag === "string" && vnode._dom) {
    cleanupSignalBindings(vnode._dom as Element);
    _cleanupSignalTextChildren(vnode._dom as Element);
    _cleanupActions(vnode._dom as HTMLElement);
  }
  // AIO-58: Null element refs on cleanup (was missing — ref callbacks never got
  // null on replace/unmount, leaking event listeners and DOM references)
  if (typeof vnode.tag === "string" && vnode.props.ref) {
    _callRef(vnode.props.ref, null);
  }
  if (
    vnode.tag === Fragment || vnode.tag === ErrorBoundary ||
    vnode.tag === Suspense || vnode.tag === Portal ||
    typeof vnode.tag === "string"
  ) {
    for (const child of vnode.children) {
      if (typeof child === "object") _removeDomCleanup(child, ctx);
    }
  }
}

function removeDom(
  parent: Node,
  vnode: VNode | string | number,
  ctx: RenderCtx,
): void {
  // Portal: remove children from target DOM
  if (typeof vnode === "object" && vnode.tag === Portal) {
    const target = vnode.props.target as Node;
    if (target) {
      for (const child of vnode.children) removeDom(target, child, ctx);
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
      removeDom(parent, vnode._rendered, ctx);
      return;
    }
    for (const child of vnode.children) {
      removeDom(parent, child, ctx);
    }
    // AIO-168: remove empty Fragment/EB/Suspense comment anchor — children loop
    // doesn't touch it because children is [] for empty containers.
    if (
      vnode._dom && vnode._dom.nodeType === 8 &&
      vnode._dom.parentNode === parent
    ) {
      parent.removeChild(vnode._dom);
    }
    return;
  }
  // Component: unmount instance, remove the rendered output
  if (typeof vnode === "object" && typeof vnode.tag === "function") {
    ctx.hooks?.unmountComponent(vnode);
    if (vnode._rendered != null) {
      removeDom(parent, vnode._rendered, ctx);
    }
    return;
  }
  // Element: null ref before removing
  if (
    typeof vnode === "object" && typeof vnode.tag === "string" &&
    vnode.props.ref
  ) {
    _callRef(vnode.props.ref, null);
  }
  const dom = getDom(vnode);
  if (dom && dom.parentNode === parent) {
    // Deferred removal for exit animations — cleanup AFTER animation completes
    const HtmlEl = ctx.doc?.defaultView?.HTMLElement ?? globalThis.HTMLElement;
    if (
      ctx.onBeforeRemove && typeof vnode === "object" && HtmlEl &&
      dom instanceof HtmlEl
    ) {
      const result = ctx.onBeforeRemove(dom, vnode);
      if (result && typeof result.then === "function") {
        const SAFETY_TIMEOUT = 5000;
        // AIO-210: guard against double-cleanup when timeout fires before promise
        let removed = false;
        const _cleanup = () => {
          cleanupSignalBindings(dom as Element);
          _cleanupSignalTextChildren(dom as Element);
          _cleanupActions(dom as HTMLElement);
          // AIO-204: recurse into children for cleanup
          if (typeof vnode === "object") {
            for (const child of vnode.children) {
              if (typeof child === "object") _removeDomCleanup(child, ctx);
            }
          }
          if (dom.parentNode === parent) parent.removeChild(dom);
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
        result.then(_doRemove, (e) => {
          console.error("[aio:vdom] onBeforeRemove rejected:", e);
          _doRemove();
        });
        return;
      }
    }
    // Immediate removal — cleanup first
    if (
      typeof vnode === "object" && typeof vnode.tag === "string" && vnode._dom
    ) {
      cleanupSignalBindings(vnode._dom as Element);
      _cleanupSignalTextChildren(vnode._dom as Element);
      _cleanupActions(vnode._dom as HTMLElement);
      // AIO-204: recurse into children for cleanup
      for (const child of vnode.children) {
        if (typeof child === "object") _removeDomCleanup(child, ctx);
      }
    }
    parent.removeChild(dom);
  }
}

// ── SSR: renderToString ─────────────────────────────────────────────
// _escapeHtml, _escapeAttr imported from ssr-utils.ts

/** Hook called at the start of top-level renderToString/renderToStream (for resetting useId counter etc). */
let _onSsrStart: (() => void) | null = null;
export function _setSsrStartHook(fn: (() => void) | null): void {
  _onSsrStart = fn;
}
/** Invoke the SSR start hook (AIO-191: used by renderToStream). */
export function _invokeSsrStartHook(): void {
  if (_onSsrStart) _onSsrStart();
}

let _ssrDepth = 0;

/** Render a VNode tree to an HTML string (no DOM required). */
export function renderToString(vnode: VNode | string | number | null): string {
  // Reset SSR counters at the top-level call (not recursive calls)
  if (_ssrDepth === 0 && _onSsrStart) _onSsrStart();
  _ssrDepth++;
  try {
    if (vnode == null) return "";
    if (typeof vnode === "string") return _escapeHtml(vnode);
    if (typeof vnode === "number") return String(vnode);

    // Component — execute and render output
    if (typeof vnode.tag === "function") {
      const rendered = (vnode.tag as ComponentFn)({
        ...vnode.props,
        children: vnode.children.length > 0
          ? vnode.children
          : (vnode.props.children ?? vnode.children),
      });
      return renderToString(rendered);
    }

    // Null placeholder — comment node in HTML (AIO-107)
    if (vnode.tag === _Null) return "<!---->";

    // Portal — skip in SSR (no target DOM available)
    if (vnode.tag === Portal) return "";

    // Suspense — try to render children, show fallback if lazy throws
    if (vnode.tag === Suspense) {
      const fallback = vnode.props.fallback as
        | VNode
        | string
        | number
        | null
        | undefined;
      try {
        return vnode.children.map((c) => renderToString(c)).join("");
      } catch (thrown) {
        if (thrown !== _LAZY_PENDING) throw thrown;
        return renderToString(fallback ?? null);
      }
    }

    // Fragment — render children
    if (vnode.tag === Fragment) {
      return vnode.children.map((c) => renderToString(c)).join("");
    }

    // ErrorBoundary — render children with error catching
    if (vnode.tag === ErrorBoundary) {
      const fallback = vnode.props.fallback as
        | ((e: Error) => VNode | string | number | null)
        | undefined;
      try {
        return vnode.children.map((c) => renderToString(c)).join("");
      } catch (error) {
        if (!fallback) throw error;
        return renderToString(fallback(error as Error));
      }
    }

    // Element
    const tag = vnode.tag as string;
    const selfClosing = VOID_ELEMENTS.has(tag);
    let html = `<${tag}`;

    for (const [k, rawV] of Object.entries(vnode.props)) {
      if (
        k === "key" || k === "children" || k === "ref" ||
        k === "dangerouslySetInnerHTML" || k === "use"
      ) continue;
      if (k.startsWith("on")) continue; // Skip event handlers in SSR
      // AIO-109: resolve signals to current value for SSR
      const v = resolveSignalProp(rawV);

      if (k === "className") {
        const cls = _resolveClassName(v);
        if (cls) html += ` class="${_escapeAttr(cls)}"`;
      } else if (k === "style" && typeof v === "string") {
        if (v) html += ` style="${_escapeAttr(v)}"`;
      } else if (k === "style" && typeof v === "object" && v !== null) {
        const pairs = Object.entries(v as Record<string, string>)
          .filter(([_, sv]) => sv != null) // AIO-164: skip null/undefined values
          .map(([sk, sv]) =>
            `${_camelToKebab(sk)}:${_styleValue(sk, resolveSignalProp(sv))}`
          )
          .join(";");
        if (pairs) html += ` style="${_escapeAttr(pairs)}"`;
      } else if (
        k === "checked" || k === "selected" || k === "disabled" ||
        k === "readOnly" || k === "multiple"
      ) {
        if (v) html += ` ${k}`;
      } else if (v !== false && v != null) {
        // AIO-187: render all non-boolean attrs with explicit value
        // (known boolean attrs like checked/disabled handled above)
        html += ` ${k}="${_escapeAttr(String(v))}"`;
      }
    }

    html += ">";
    if (selfClosing) return html;

    // dangerouslySetInnerHTML
    const dih = vnode.props.dangerouslySetInnerHTML as
      | { __html: string }
      | undefined;
    if (dih) {
      html += dih.__html;
    } else {
      for (const child of vnode.children) {
        html += renderToString(child);
      }
    }

    html += `</${tag}>`;
    return html;
  } finally {
    _ssrDepth--;
  }
}
