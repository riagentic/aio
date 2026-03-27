// AIO VDOM Engine — h(), diff, patch, keyed reconciliation, SSR
// Zero dependencies on signal.ts or any other AIO code.

const SVG_NS = "http://www.w3.org/2000/svg";

// ── Dev mode ────────────────────────────────────────────────────────

let _devMode = false;
const _devWarned = new Set<string>();

/** Enable/disable dev-mode warnings (missing keys, duplicate keys, excessive re-renders). */
export function setDevMode(enabled: boolean): void {
  _devMode = enabled;
  if (!enabled) _devWarned.clear();
}

function _devWarn(id: string, msg: string): void {
  if (!_devMode || _devWarned.has(id)) return;
  _devWarned.add(id);
  console.warn(`[aio-dev] ${msg}`);
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
const SVG_TAGS = new Set([
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
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

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
}

/** Ref type — callback or object. */
export type Ref<T = Node> = ((value: T | null) => void) | { current: T | null };

// ── Types ───────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
export type ComponentFn = (props: any) => VNode | null;

export type VChild =
  | VNode
  | string
  | number
  | null
  | undefined
  | boolean
  | VChild[];

export interface VNode {
  tag:
    | string
    | typeof Fragment
    | typeof ErrorBoundary
    | typeof Portal
    | typeof Suspense
    | ComponentFn;
  props: Record<string, unknown>;
  children: (VNode | string | number)[];
  key: string | number | undefined;
  _dom?: Node;
  _rendered?: VNode | string | number | null;
  /** Opaque per-component instance — managed by VDomHooks, never read by VDOM. */
  _instance?: unknown;
}

export const Fragment = Symbol.for("aio.Fragment");

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
    if (error) throw error;
    if (!loading) {
      loading = true;
      loader().then((mod) => {
        resolved = mod.default;
        // Notify all registered Suspense boundaries to re-render
        for (const fn of _listeners) fn();
        _listeners.clear();
      }).catch((e) => {
        error = e;
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
  flattenChildren(rawChildren, children);

  return { tag, props: p, children, key };
}

function flattenChildren(
  raw: VChild[],
  out: (VNode | string | number)[],
): void {
  for (const c of raw) {
    if (c == null || typeof c === "boolean") continue;
    if (Array.isArray(c)) {
      flattenChildren(c, out);
    } else {
      out.push(c as VNode | string | number);
    }
  }
}

// ── className resolution (array/object/string) ──────────────────────

function _resolveClassName(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.filter(Boolean).join(" ");
  if (typeof v === "object" && v !== null) {
    return Object.entries(v as Record<string, unknown>)
      .filter(([_, val]) => val)
      .map(([key]) => key)
      .join(" ");
  }
  return "";
}

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

export function createDom(
  vnode: VNode | string | number,
  ctx: RenderCtx,
  isSvg: boolean,
  parentDom?: Node,
): Node | null {
  if (typeof vnode === "string" || typeof vnode === "number") {
    return ctx.doc.createTextNode(String(vnode));
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
        children: vnode.children,
      });
    } catch (e) {
      ctx.hooks?.abortComponent?.(vnode, hookState);
      throw e;
    }
    vnode._rendered = rendered;
    ctx.hooks?.afterComponent(vnode, rendered, hookState);
    if (rendered == null) {
      ctx.hooks?.afterSubtree?.(vnode);
      return null;
    }
    const dom = createDom(rendered, ctx, isSvg, parentDom);
    vnode._dom = dom ?? undefined;
    ctx.hooks?.afterSubtree?.(vnode);
    return dom;
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
    for (const child of vnode.children) {
      const childDom = createDom(child, ctx, false, target);
      if (childDom) target.appendChild(childDom);
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
    if (firstDom) vnode._dom = firstDom;
    return frag;
  }

  // Element
  const tag = vnode.tag as string;
  const nowSvg = isSvg || SVG_TAGS.has(tag);
  const el = nowSvg
    ? ctx.doc.createElementNS(SVG_NS, tag)
    : ctx.doc.createElement(tag);

  applyProps(el as HTMLElement, vnode.props, {});

  for (const child of vnode.children) {
    const childDom = createDom(child, ctx, nowSvg, el);
    if (childDom) el.appendChild(childDom);
  }

  // Call ref after element + children are fully built
  if (vnode.props.ref) _callRef(vnode.props.ref, el);

  vnode._dom = el;
  return el;
}

function _camelToKebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
}

function applyProps(
  el: HTMLElement,
  next: Record<string, unknown>,
  prev: Record<string, unknown>,
): void {
  // Remove old props not in next
  for (const k of Object.keys(prev)) {
    if (k === "key" || k === "children" || k === "ref") continue;
    if (!(k in next)) {
      if (k.startsWith("on")) {
        const evt = k.slice(2).toLowerCase();
        el.removeEventListener(evt, prev[k] as EventListener);
      } else if (k === "className") {
        el.removeAttribute("class");
      } else if (k === "style") {
        el.removeAttribute("style");
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
    if (k === "key" || k === "children" || k === "ref") continue;
    if (prev[k] === v) continue;

    if (k.startsWith("on")) {
      const evt = k.slice(2).toLowerCase();
      if (prev[k]) el.removeEventListener(evt, prev[k] as EventListener);
      el.addEventListener(evt, v as EventListener);
    } else if (k === "className") {
      const cls = _resolveClassName(v);
      if (cls) el.setAttribute("class", cls);
      else el.removeAttribute("class");
    } else if (k === "style" && typeof v === "object" && v !== null) {
      const style = el.style;
      const newStyle = v as Record<string, string>;
      const oldStyle = (prev[k] as Record<string, string>) ?? {};
      // Remove stale style properties not in new style
      for (const sk of Object.keys(oldStyle)) {
        if (!(sk in newStyle)) {
          style.removeProperty(_camelToKebab(sk));
        }
      }
      // Set new/changed style properties
      for (const [sk, sv] of Object.entries(newStyle)) {
        if (oldStyle[sk] !== sv) {
          style.setProperty(_camelToKebab(sk), sv);
        }
      }
    } else if (k === "dangerouslySetInnerHTML" && v && typeof v === "object") {
      el.innerHTML = (v as { __html: string }).__html ?? "";
    } else if (k in el && _DOM_PROPS.has(k)) {
      // DOM properties (form elements): assign directly instead of setAttribute
      // deno-lint-ignore no-explicit-any
      (el as any)[k] = v ?? "";
    } else if (v === false || v == null) {
      el.removeAttribute(k);
    } else {
      el.setAttribute(k, String(v));
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
    const dom = getDom(old);
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
    const oldDom = getDom(old);
    const newDom = createDom(next, ctx, isSvg, parent);
    if (oldDom && newDom) {
      parent.replaceChild(newDom, oldDom);
    }
    // Clean up old component instances
    if (typeof old === "object") removeDomCleanup(old, ctx);
    return;
  }

  // Same tag VNodes — patch in place
  const nv = next as VNode;
  const ov = old as VNode;

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
        children: nv.children,
      });
    } catch (e) {
      ctx.hooks?.abortComponent?.(nv, hookState);
      throw e;
    }
    nv._rendered = rendered;
    ctx.hooks?.afterComponent(nv, rendered, hookState);
    _diff(parent, rendered ?? null, ov._rendered ?? null, ctx, isSvg);
    nv._dom = rendered ? (getDom(rendered) ?? undefined) : undefined;
    ctx.hooks?.afterSubtree?.(nv);
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
        if (firstDom) nv._dom = firstDom;
      } else {
        // Normal diff children
        diffChildren(parent, nv.children, ov.children, ctx, isSvg);
        for (const child of nv.children) {
          const d = getDom(child);
          if (d) {
            nv._dom = d;
            break;
          }
        }
      }
      nv._rendered = undefined; // Clear error state
    } catch (error) {
      if (!fallback) throw error;
      // Remove whatever was rendered
      if (!wasError) {
        for (const child of ov.children) removeDom(parent, child, ctx);
      } else if (ov._rendered != null) {
        removeDom(parent, ov._rendered, ctx);
      }
      const fallbackVnode = fallback(error as Error);
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
        for (const child of nv.children) {
          const childDom = createDom(child, ctx, isSvg, parent);
          if (childDom) {
            if (!firstDom) firstDom = childDom;
            frag.appendChild(childDom);
          }
        }
        parent.appendChild(frag);
        if (firstDom) nv._dom = firstDom;
      } else {
        diffChildren(parent, nv.children, ov.children, ctx, isSvg);
        for (const child of nv.children) {
          const d = getDom(child);
          if (d) {
            nv._dom = d;
            break;
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
    if (target) {
      diffChildren(target, nv.children, ov.children, ctx, false);
    }
    return;
  }

  // Fragment — diff children, update _dom to first child
  if (nv.tag === Fragment) {
    diffChildren(parent, nv.children, ov.children, ctx, isSvg);
    // Track first child DOM for getDom() lookups
    for (const child of nv.children) {
      const d = getDom(child);
      if (d) {
        nv._dom = d;
        break;
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

  // Handle ref update
  if (nv.props.ref !== ov.props.ref) {
    if (ov.props.ref) _callRef(ov.props.ref, null);
    if (nv.props.ref) _callRef(nv.props.ref, dom);
  }

  diffChildren(dom, nv.children, ov.children, ctx, nowSvg);
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

function diffUnkeyed(
  parent: Node,
  nextChildren: (VNode | string | number)[],
  oldChildren: (VNode | string | number)[],
  ctx: RenderCtx,
  isSvg: boolean,
): void {
  // Snapshot DOM nodes for old children BEFORE mutations shift indices
  const oldDoms: (Node | null)[] = [];
  for (let i = 0; i < oldChildren.length; i++) {
    oldDoms.push(getDom(oldChildren[i]!) ?? parent.childNodes[i] ?? null);
  }

  const max = Math.max(nextChildren.length, oldChildren.length);
  for (let i = 0; i < max; i++) {
    const nc = i < nextChildren.length ? nextChildren[i]! : null;
    const oc = i < oldChildren.length ? oldChildren[i]! : null;

    if (nc == null && oc != null) {
      // Remove — use removeDom for recursive Fragment/Component cleanup
      removeDom(parent, oc, ctx);
    } else if (nc != null && oc == null) {
      // Append new child
      const newDom = createDom(nc, ctx, isSvg, parent);
      if (newDom) parent.appendChild(newDom);
    } else if (
      (typeof nc === "string" || typeof nc === "number") &&
      (typeof oc === "string" || typeof oc === "number")
    ) {
      // Text update in place
      const textNode = oldDoms[i];
      if (textNode && String(nc) !== String(oc)) {
        textNode.textContent = String(nc);
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
  // Build map of old keys → old VNode
  const oldMap = new Map<string | number, VNode>();
  for (const oc of oldChildren) {
    if (oc.key !== undefined) oldMap.set(oc.key, oc);
  }

  const usedKeys = new Set<string | number>();
  let lastPlaced: Node | null = null;

  for (const nc of nextChildren) {
    const key = nc.key!;
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
        if (dom !== anchor) {
          parent.insertBefore(dom, anchor);
        }
        lastPlaced = dom;
      }
    } else {
      // New node — create and insert at correct position
      const newDom = createDom(nc, ctx, isSvg, parent);
      if (newDom) {
        const anchor2: Node | null = lastPlaced
          ? lastPlaced.nextSibling
          : parent.firstChild;
        parent.insertBefore(newDom, anchor2);
        lastPlaced = newDom;
      }
    }
  }

  // Remove old nodes not in next
  for (const oc of oldChildren) {
    if (oc.key !== undefined && !usedKeys.has(oc.key)) {
      removeDom(parent, oc, ctx);
    }
  }
}

export function getDom(vnode: VNode | string | number): Node | null {
  if (typeof vnode === "object" && vnode !== null) {
    return vnode._dom ?? null;
  }
  return null;
}

/** Cleanup component instances without removing DOM (for type-mismatch replacement). */
function removeDomCleanup(
  vnode: VNode | string | number,
  ctx: RenderCtx,
): void {
  if (typeof vnode !== "object") return;
  if (typeof vnode.tag === "function") {
    ctx.hooks?.unmountComponent(vnode);
    if (vnode._rendered != null) removeDomCleanup(vnode._rendered, ctx);
  }
  if (
    vnode.tag === Fragment || vnode.tag === ErrorBoundary ||
    vnode.tag === Suspense || vnode.tag === Portal ||
    typeof vnode.tag === "string"
  ) {
    for (const child of vnode.children) {
      if (typeof child === "object") removeDomCleanup(child, ctx);
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
    parent.removeChild(dom);
  }
}

// ── SSR: renderToString ─────────────────────────────────────────────

function _escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function _escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** Render a VNode tree to an HTML string (no DOM required). */
export function renderToString(vnode: VNode | string | number | null): string {
  if (vnode == null) return "";
  if (typeof vnode === "string") return _escapeHtml(vnode);
  if (typeof vnode === "number") return String(vnode);

  // Component — execute and render output
  if (typeof vnode.tag === "function") {
    const rendered = (vnode.tag as ComponentFn)({
      ...vnode.props,
      children: vnode.children,
    });
    return renderToString(rendered);
  }

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

  for (const [k, v] of Object.entries(vnode.props)) {
    if (
      k === "key" || k === "children" || k === "ref" ||
      k === "dangerouslySetInnerHTML"
    ) continue;
    if (k.startsWith("on")) continue; // Skip event handlers in SSR

    if (k === "className") {
      const cls = _resolveClassName(v);
      if (cls) html += ` class="${_escapeAttr(cls)}"`;
    } else if (k === "style" && typeof v === "object" && v !== null) {
      const pairs = Object.entries(v as Record<string, string>)
        .map(([sk, sv]) => `${_camelToKebab(sk)}:${sv}`)
        .join(";");
      if (pairs) html += ` style="${_escapeAttr(pairs)}"`;
    } else if (
      k === "checked" || k === "selected" || k === "disabled" ||
      k === "readOnly" || k === "multiple"
    ) {
      if (v) html += ` ${k}`;
    } else if (v === true) {
      html += ` ${k}`;
    } else if (v !== false && v != null) {
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
}
