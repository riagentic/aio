// VDOM type definitions, constants, symbols, and dev-mode utilities.
// Zero-dependency module — no runtime imports, pure type/constant definitions.

import type { Signal } from "./signal.ts";

// ── SVG tag set ────────────────────────────────────────────────────
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

// ── DOM property set ───────────────────────────────────────────────
// Props that must be set as DOM properties (not attributes) for correct behavior
export const _DOM_PROPS = new Set([
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

// ── Symbols ────────────────────────────────────────────────────────

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
export const _LAZY_PENDING = Symbol.for("aio.LazyPending");

// ── Types ──────────────────────────────────────────────────────────

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

/** Action function signature for `use` prop. */
export type Action = (node: HTMLElement) => { cleanup?(): void } | void;

// ── Dev mode ───────────────────────────────────────────────────────

export let _devMode = false;
const _devWarned = new Set<string>();

/** Enable/disable dev-mode warnings (missing keys, duplicate keys, excessive re-renders). */
export function setDevMode(enabled: boolean): void {
  _devMode = enabled;
  if (!enabled) _devWarned.clear();
}

export let _devA11yCheckFn:
  | ((tag: string, props: Record<string, unknown>) => void)
  | null = null;

export function _setDevA11yCheck(
  fn: ((tag: string, props: Record<string, unknown>) => void) | null,
): void {
  _devA11yCheckFn = fn;
}

export function _devWarn(id: string, msg: string): void {
  if (!_devMode || _devWarned.has(id)) return;
  _devWarned.add(id);
  console.warn(`[aio-dev] ${msg}`);
}
