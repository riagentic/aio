// AIO Renderer — mount, per-component reactive re-render, unmount, hydrate.
// Connects signal.ts (reactive tracking) + vdom.ts (h/diff/render) into a component renderer.
//
// Architecture (Phase 2+3): per-component signal tracking, per-mount isolation.
// Each component function executes inside its own tracking scope.
// When a tracked signal changes, only that component re-renders its subtree.
// Auto-memo: if a parent re-renders but a child's props haven't changed
// (and none of its signals fired), the child is skipped entirely.
// Each mount() creates an isolated render root with its own pending queue.

import {
  _computedCollectEnd,
  _computedCollectStart,
  _computedDisposeAll,
  _trackEnd,
  _trackStart,
  type Disposable,
  type Signal,
  signal,
} from "./signal.ts";
import type { ComponentFn, RenderCtx, VDomHooks, VNode } from "./vdom.ts";
import {
  _callRef,
  _diff,
  _render,
  Fragment,
  getDom,
  h,
  setDevMode as _setDevModeVdom,
} from "./vdom.ts";
import { _isDevToolsConnected, _recordRender } from "./devtools.ts";

// ── Helpers ─────────────────────────────────────────────────────────

/** Run cleanup callbacks safely — a throwing cleanup doesn't kill subsequent ones. */
function _runCleanups(cbs: (() => void)[]): void {
  for (const cb of cbs) {
    try {
      cb();
    } catch (e) {
      console.error("[aio-renderer] Cleanup callback error:", e);
    }
  }
}

// ── Types ───────────────────────────────────────────────────────────

export interface MountHandle {
  /** Synchronously execute any pending re-render (for testing). */
  _flush(): void;
}

// deno-lint-ignore no-explicit-any
type AnyDoc = any;

interface ComponentInstance {
  // deno-lint-ignore no-explicit-any
  deps: Set<any>;
  unsubs: (() => void)[];
  computeds: Disposable[];
  parentDom: Node;
  vnode: VNode;
  oldRendered: VNode | string | number | null;
  isSvg: boolean;
  pendingRender: boolean;
  disposed: boolean;
  prevProps: Record<string, unknown>;
  prevChildren: (VNode | string | number)[];
  /** Set to true when this component's own signal triggered the re-render. */
  selfTriggered: boolean;
  /** Render context reference for independent re-rendering. */
  _ctx: RenderCtx;
  /** Root state reference for per-mount pending queue isolation. */
  _root: RootState;
  /** Callbacks to run after first mount. */
  mountCallbacks: (() => void)[];
  /** Cleanup callbacks to run on unmount or before re-render. */
  cleanupCallbacks: (() => void)[];
  /** Whether the component has been mounted (first render complete). */
  mounted: boolean;
  /** Context values provided by this component (if it's a Provider). */
  // deno-lint-ignore no-explicit-any
  contexts?: Map<symbol, any>;
  /** Persisted refs (useRef). */
  // deno-lint-ignore no-explicit-any
  refs?: { current: any }[];
  /** Current ref index counter (reset each render). */
  refIndex?: number;
  /** Dev mode: render count for excessive re-render detection. */
  _devRenderCount?: number;
  _devRenderResetTimer?: ReturnType<typeof setTimeout>;
}

interface RootState {
  // deno-lint-ignore no-explicit-any
  root: any;
  vnode: VNode | string | number | null;
  disposed: boolean;
  ctx: RenderCtx;
  /** Per-mount pending component re-render queue (isolated from other mounts). */
  pendingComponents: Set<ComponentInstance>;
  flushScheduled: boolean;
  /** Root App component for full re-render (lazy resolve). */
  App: ComponentFn;
}

interface HookState {
  skip: boolean;
  // deno-lint-ignore no-explicit-any
  deps: Set<any> | null;
  collected: Disposable[] | null;
  parentDom: Node;
  isSvg: boolean;
}

// ── Component instance stack (for onMount/onCleanup registration) ───
// ARCH NOTE: _instanceStack is a global shared across all mount() roots.
// Safe today because rendering is fully synchronous (push→children→pop within
// a single call stack). If we ever introduce concurrent/async rendering, this
// must become per-root or fiber-local to prevent cross-root corruption.

interface LifecycleCollector {
  mountCallbacks: (() => void)[];
  cleanupCallbacks: (() => void)[];
  // deno-lint-ignore no-explicit-any
  contexts?: Map<symbol, any>;
  // deno-lint-ignore no-explicit-any
  refs?: { current: any }[];
  refIndex?: number;
}

let _currentCollector: LifecycleCollector | null = null;
const _instanceStack: ComponentInstance[] = [];

/**
 * Register a callback to run after the component's first render.
 * Must be called inside a component function body during render.
 */
export function onMount(fn: () => void): void {
  if (!_currentCollector) return;
  _currentCollector.mountCallbacks.push(fn);
}

/**
 * Register a cleanup callback that runs on unmount and before each re-render.
 * Must be called inside a component function body during render.
 */
export function onCleanup(fn: () => void): void {
  if (!_currentCollector) return;
  _currentCollector.cleanupCallbacks.push(fn);
}

/**
 * Persist a mutable ref across renders. Does not trigger re-render on mutation.
 * Must be called inside a component function body during render.
 */
export function useRef<T>(initial: T): { current: T } {
  if (!_currentCollector) {
    if (_devMode) {
      console.warn(
        "[aio-dev] useRef() called outside a component render. The ref will not persist across re-renders.",
      );
    }
    return { current: initial };
  }
  const collector = _currentCollector;
  if (!collector.refs) collector.refs = [];
  if (collector.refIndex === undefined) collector.refIndex = 0;
  const idx = collector.refIndex++;
  if (idx >= collector.refs.length) {
    // First render — create ref
    const ref = { current: initial };
    collector.refs.push(ref);
    return ref;
  }
  return collector.refs[idx] as { current: T };
}

// ── Context / Provider ──────────────────────────────────────────────

/** Context object created by createContext(). */
export interface Context<T> {
  readonly _id: symbol;
  readonly _default: T;
  readonly Provider: ComponentFn;
}

/** Create a context with a default value. */
export function createContext<T>(defaultValue: T): Context<T> {
  const id = Symbol();

  // Provider component — sets context value for its subtree using a signal for reactivity
  const Provider: ComponentFn = (
    props: { value: T; children: (VNode | string | number)[] },
  ) => {
    if (_currentCollector) {
      if (!_currentCollector.contexts) _currentCollector.contexts = new Map();
      const existing = _currentCollector.contexts.get(id) as
        | Signal<T>
        | undefined;
      if (existing && typeof existing === "object" && "set" in existing) {
        // Re-render — update existing signal
        existing.set(props.value);
      } else {
        // First render — create signal
        _currentCollector.contexts.set(id, signal(props.value));
      }
    }
    return h(Fragment, null, ...props.children);
  };

  return { _id: id, _default: defaultValue, Provider };
}

/** Read the current value of a context. Must be called inside a component. */
export function useContext<T>(ctx: Context<T>): T {
  // Walk the instance stack (ancestors currently rendering) to find nearest Provider
  for (let i = _instanceStack.length - 1; i >= 0; i--) {
    const inst = _instanceStack[i]!;
    if (inst.contexts?.has(ctx._id)) {
      const entry = inst.contexts.get(ctx._id);
      // Read signal .value to auto-track for reactivity
      if (entry && typeof entry === "object" && "value" in entry) {
        return (entry as Signal<T>).value;
      }
      return entry as T;
    }
  }
  return ctx._default;
}

// ── State ───────────────────────────────────────────────────────────

const _stateMap = new WeakMap<MountHandle, RootState>();

// deno-lint-ignore no-explicit-any
let _doc: any = typeof globalThis !== "undefined" && "document" in globalThis
  // deno-lint-ignore no-explicit-any
  ? (globalThis as any).document
  : null;

/** Set document reference (for happy-dom testing). */
export function _setDocument(doc: AnyDoc): void {
  _doc = doc;
}

let _devMode = false;
const DEV_RENDER_LIMIT = 50;

/** Enable dev-mode warnings (excessive re-renders, also enables VDOM key warnings). */
export function setDevMode(enabled: boolean): void {
  _devMode = enabled;
  _setDevModeVdom(enabled);
}

// ── Shallow props comparison (auto-memo) ────────────────────────────

function _shallowEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.is(a[k], b[k])) return false;
  }
  return true;
}

function _childrenEqual(
  a: (VNode | string | number)[],
  b: (VNode | string | number)[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ── Mount ───────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
export function mount(root: any, App: ComponentFn): MountHandle {
  root.innerHTML = "";

  const state: RootState = {
    root,
    vnode: null,
    disposed: false,
    ctx: { doc: _doc },
    pendingComponents: new Set(),
    flushScheduled: false,
    App,
  };

  const handle: MountHandle = {
    _flush() {
      if (state.disposed) return;
      _flushPending(state);
    },
  };

  _stateMap.set(handle, state);

  // Create hooks and attach to context
  state.ctx.hooks = _createHooks(state);

  // Wire lazy resolve: re-render the root when any lazy component resolves
  state.ctx.onLazyResolve = () => {
    if (state.disposed) return;
    _rerenderRoot(state);
  };

  // Initial render
  const vnode = h(App, null);
  _render(state.root, vnode, null, state.ctx);
  state.vnode = vnode;

  return handle;
}

// ── Hydrate ─────────────────────────────────────────────────────────

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
  };

  const handle: MountHandle = {
    _flush() {
      if (state.disposed) return;
      _flushPending(state);
    },
  };

  _stateMap.set(handle, state);
  state.ctx.hooks = _createHooks(state);
  state.ctx.onLazyResolve = () => {
    if (state.disposed) return;
    _rerenderRoot(state);
  };

  // Execute component tree to build VNode structure
  const vnode = h(App, null);

  // Walk existing DOM and attach references
  const success = _hydrateNode(root, vnode, state.ctx, false, 0);
  if (!success) {
    // Mismatch — fall back to full render
    root.innerHTML = "";
    _render(root, vnode, null, state.ctx);
  }
  state.vnode = vnode;

  return handle;
}

/** Hydrate a single VNode against existing DOM. Returns true on success. */
function _hydrateNode(
  parent: Node,
  vnode: VNode | string | number,
  ctx: RenderCtx,
  isSvg: boolean,
  childIndex: number,
): boolean {
  const domNode = parent.childNodes[childIndex];
  if (!domNode) return false;

  // Text nodes
  if (typeof vnode === "string" || typeof vnode === "number") {
    if (domNode.nodeType !== 3) return false; // Not a text node
    if (domNode.textContent !== String(vnode)) {
      domNode.textContent = String(vnode); // Fix mismatch
    }
    return true;
  }

  // Component — execute and hydrate rendered output
  if (typeof vnode.tag === "function") {
    const hookState = ctx.hooks?.beforeComponent(vnode, null, parent, isSvg);
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
      return true;
    }
    const ok = _hydrateNode(parent, rendered, ctx, isSvg, childIndex);
    if (ok) vnode._dom = getDom(rendered) ?? undefined;
    ctx.hooks?.afterSubtree?.(vnode);
    return ok;
  }

  // Portal — skip during hydration (portal content was not in SSR output)
  if (vnode.tag === Symbol.for("aio.Portal") as typeof vnode.tag) {
    return true; // Nothing to hydrate — portal renders elsewhere
  }

  // ErrorBoundary / Suspense / Fragment — hydrate children sequentially
  if (
    vnode.tag === (Symbol.for("aio.Fragment") as typeof vnode.tag) ||
    vnode.tag === (Symbol.for("aio.ErrorBoundary") as typeof vnode.tag) ||
    vnode.tag === (Symbol.for("aio.Suspense") as typeof vnode.tag)
  ) {
    let idx = childIndex;
    for (const child of vnode.children) {
      if (!_hydrateNode(parent, child, ctx, isSvg, idx)) return false;
      idx++;
    }
    const firstDom = vnode.children.length > 0
      ? getDom(vnode.children[0]!)
      : null;
    if (firstDom) vnode._dom = firstDom;
    return true;
  }

  // Element
  if (domNode.nodeType !== 1) return false;
  const el = domNode as HTMLElement;
  if (el.tagName.toLowerCase() !== (vnode.tag as string).toLowerCase()) {
    return false;
  }

  // Attach _dom reference
  vnode._dom = el;

  // Apply props (event listeners, refs — attributes already in DOM from SSR)
  _hydrateProps(el, vnode.props);

  // Hydrate children
  const nowSvg = isSvg || el.tagName === "svg";
  for (let i = 0; i < vnode.children.length; i++) {
    if (!_hydrateNode(el, vnode.children[i]!, ctx, nowSvg, i)) return false;
  }

  return true;
}

/** Apply event listeners and refs during hydration (attributes are already set). */
function _hydrateProps(el: HTMLElement, props: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(props)) {
    if (k === "key" || k === "children" || k === "ref") continue;
    if (k.startsWith("on") && typeof v === "function") {
      const evt = k.slice(2).toLowerCase();
      el.addEventListener(evt, v as EventListener);
    }
  }
  // Handle ref
  if (props.ref) _callRef(props.ref, el);
}

// ── Unmount ─────────────────────────────────────────────────────────

export function _unmount(handle: MountHandle): void {
  const state = _stateMap.get(handle);
  if (!state) return;

  state.disposed = true;
  state.pendingComponents.clear();

  // Recursively unmount all component instances in the tree
  if (state.vnode && typeof state.vnode === "object") {
    _unmountTree(state.vnode, state.ctx);
  }

  state.root.innerHTML = "";
}

function _unmountTree(
  vnode: VNode | string | number | null,
  ctx: RenderCtx,
): void {
  if (vnode == null || typeof vnode !== "object") return;
  if (typeof vnode.tag === "function") {
    ctx.hooks?.unmountComponent(vnode);
    _unmountTree(vnode._rendered ?? null, ctx);
  } else {
    for (const child of vnode.children) {
      _unmountTree(child, ctx);
    }
  }
}

// ── Pending component re-renders (per-mount isolated) ────────────────

function _scheduleComponentRender(inst: ComponentInstance): void {
  if (inst.disposed || inst.pendingRender) return;
  inst.pendingRender = true;
  inst.selfTriggered = true;
  const root = inst._root;
  root.pendingComponents.add(inst);
  if (!root.flushScheduled) {
    root.flushScheduled = true;
    queueMicrotask(() => _flushPending(root));
  }
}

function _flushPending(root: RootState): void {
  root.flushScheduled = false;
  while (root.pendingComponents.size > 0) {
    const batch = [...root.pendingComponents];
    root.pendingComponents.clear();
    for (const inst of batch) {
      if (inst.disposed || !inst.pendingRender) continue;
      inst.pendingRender = false;
      _rerenderComponent(inst);
    }
  }
}

/** Full root-level re-render (used when lazy components resolve). */
function _rerenderRoot(state: RootState): void {
  if (state.disposed) return;
  const oldVnode = state.vnode;
  // Mark root instance as self-triggered to bypass auto-memo
  if (oldVnode && typeof oldVnode === "object") {
    const inst = (oldVnode as VNode)._instance as ComponentInstance | undefined;
    if (inst) inst.selfTriggered = true;
  }
  const vnode = h(state.App, null);
  _diff(state.root, vnode, oldVnode, state.ctx);
  state.vnode = vnode;
}

// ── Per-component re-render ─────────────────────────────────────────

function _rerenderComponent(inst: ComponentInstance): void {
  if (inst.disposed) return;

  // Dev mode: track excessive re-renders
  if (_devMode) {
    inst._devRenderCount = (inst._devRenderCount ?? 0) + 1;
    if (inst._devRenderCount === DEV_RENDER_LIMIT) {
      const name = typeof inst.vnode.tag === "function"
        ? (inst.vnode.tag.name || "Anonymous")
        : "Component";
      console.warn(
        `[aio-dev] ${name} re-rendered ${DEV_RENDER_LIMIT} times in rapid succession. Possible infinite loop.`,
      );
    }
    if (!inst._devRenderResetTimer) {
      inst._devRenderResetTimer = setTimeout(() => {
        inst._devRenderCount = 0;
        inst._devRenderResetTimer = undefined;
      }, 1000);
    }
  }

  const _devStart = _isDevToolsConnected() ? performance.now() : 0;

  const vnode = inst.vnode;
  const oldRendered = inst.oldRendered;

  // Run cleanup callbacks before re-render (exception-safe)
  _runCleanups(inst.cleanupCallbacks);
  inst.cleanupCallbacks = [];

  // Unsubscribe old deps and dispose old computeds
  for (const unsub of inst.unsubs) unsub();
  inst.unsubs = [];
  _computedDisposeAll(inst.computeds);

  // Re-execute component with tracking
  const collected = _computedCollectStart();
  const deps = _trackStart();
  inst.refIndex = 0;
  _currentCollector = inst;
  let rendered: VNode | string | number | null;
  try {
    rendered = (vnode.tag as ComponentFn)({
      ...vnode.props,
      children: vnode.children,
    });
  } catch (error) {
    // Error during signal-triggered re-render — keep old output, log error
    _currentCollector = null;
    _trackEnd(deps);
    _computedCollectEnd(collected);
    console.error("[aio-renderer] Component render error:", error);
    // Re-subscribe to deps so future updates still work
    _subscribeComponentDeps(inst, inst.deps);
    return;
  }
  _currentCollector = null;
  _trackEnd(deps);
  _computedCollectEnd(collected);

  vnode._rendered = rendered;

  // Push onto instance stack so children can find context (Provider support)
  _instanceStack.push(inst);

  // Diff only this subtree
  const ctx = inst._ctx;
  _diff(inst.parentDom, rendered ?? null, oldRendered ?? null, ctx, inst.isSvg);
  vnode._dom = rendered ? (getDom(rendered) ?? undefined) : undefined;

  _instanceStack.pop();

  // Record render event for DevTools
  if (_devStart) {
    const name = typeof vnode.tag === "function"
      ? (vnode.tag.name || "Anonymous")
      : "Component";
    _recordRender({
      component: name,
      timestamp: Date.now(),
      durationMs: performance.now() - _devStart,
      trigger: "signal",
    });
  }

  // Update instance
  inst.oldRendered = rendered;
  inst.deps = deps;
  inst.computeds = collected;
  inst.selfTriggered = false;
  _subscribeComponentDeps(inst, deps);
}

// ── Subscribe component instance to its deps ────────────────────────

function _subscribeComponentDeps(
  inst: ComponentInstance,
  // deno-lint-ignore no-explicit-any
  deps: Set<any>,
): void {
  const subscriber = {
    execute: () => _scheduleComponentRender(inst),
  };

  for (const dep of deps) {
    dep._subscribers.add(subscriber);
    inst.unsubs.push(() => dep._subscribers.delete(subscriber));
  }
}

// ── Hooks factory ───────────────────────────────────────────────────

function _createHooks(rootState: RootState): VDomHooks {
  return {
    beforeComponent(
      vnode: VNode,
      oldVnode: VNode | null,
      parentDom: Node,
      isSvg: boolean,
    ): HookState {
      const inst = vnode._instance as ComponentInstance | undefined;

      // Auto-memo: if instance exists and wasn't self-triggered,
      // check if props/children are the same — if so, skip re-execution
      if (inst && oldVnode && !inst.selfTriggered) {
        if (
          _shallowEqual(vnode.props, inst.prevProps) &&
          _childrenEqual(vnode.children, inst.prevChildren)
        ) {
          return { skip: true, deps: null, collected: null, parentDom, isSvg };
        }
      }

      // Prepare tracking for this component
      if (inst) {
        // Run cleanup callbacks before re-render (exception-safe)
        _runCleanups(inst.cleanupCallbacks);
        inst.cleanupCallbacks = [];
        // Clean up old tracking before re-render
        for (const unsub of inst.unsubs) unsub();
        inst.unsubs = [];
        _computedDisposeAll(inst.computeds);
      }

      const collected = _computedCollectStart();
      const deps = _trackStart();

      // Set collector for onMount/onCleanup/useRef registration during component execution
      const collector: LifecycleCollector = inst ??
        { mountCallbacks: [], cleanupCallbacks: [] };
      collector.refIndex = 0; // Reset ref index for this render pass
      _currentCollector = collector;

      return { skip: false, deps, collected, parentDom, isSvg };
    },

    afterComponent(
      vnode: VNode,
      rendered: VNode | string | number | null,
      state: unknown,
    ): void {
      const hs = state as HookState;
      if (hs.skip) {
        _currentCollector = null;
        return;
      }

      _trackEnd(hs.deps!);
      _computedCollectEnd(hs.collected!);

      const collector = _currentCollector!;
      _currentCollector = null;

      let inst = vnode._instance as ComponentInstance | undefined;
      const isFirstRender = !inst;
      if (!inst) {
        // First render — create instance with collected callbacks
        inst = {
          deps: hs.deps!,
          unsubs: [],
          computeds: hs.collected!,
          parentDom: hs.parentDom,
          vnode,
          oldRendered: rendered,
          isSvg: hs.isSvg,
          pendingRender: false,
          disposed: false,
          prevProps: { ...vnode.props },
          prevChildren: vnode.children,
          selfTriggered: false,
          _ctx: rootState.ctx,
          _root: rootState,
          mountCallbacks: collector.mountCallbacks,
          cleanupCallbacks: collector.cleanupCallbacks,
          mounted: false,
          contexts: collector.contexts,
          refs: collector.refs,
          refIndex: collector.refIndex,
        };
        vnode._instance = inst;
      } else {
        // Update existing instance
        inst.deps = hs.deps!;
        inst.computeds = hs.collected!;
        inst.vnode = vnode;
        inst.oldRendered = rendered;
        inst.parentDom = hs.parentDom;
        inst.isSvg = hs.isSvg;
        inst.prevProps = { ...vnode.props };
        inst.prevChildren = vnode.children;
        inst.selfTriggered = false;
        // Clear pending render — this component is being rendered in the current diff pass,
        // so it must not be re-rendered again by _flushPending (which lacks ancestor context).
        if (inst.pendingRender) {
          inst.pendingRender = false;
          inst._root.pendingComponents.delete(inst);
        }
      }

      // Subscribe to deps
      _subscribeComponentDeps(inst, hs.deps!);

      // Push onto instance stack so children can find context
      _instanceStack.push(inst);

      // Run mount callbacks after first render
      if (isFirstRender && inst.mountCallbacks.length > 0) {
        const cbs = inst.mountCallbacks;
        inst.mountCallbacks = [];
        inst.mounted = true;
        for (const cb of cbs) cb();
      } else if (isFirstRender) {
        inst.mounted = true;
      }
    },

    afterSubtree(_vnode: VNode): void {
      _instanceStack.pop();
    },

    abortComponent(_vnode: VNode, state: unknown): void {
      // Clean up dangling tracking state when a component throws (e.g., lazy pending)
      const hs = state as HookState | undefined;
      if (hs && !hs.skip && hs.deps) {
        _trackEnd(hs.deps);
        _computedCollectEnd(hs.collected!);
      }
      _currentCollector = null;
    },

    unmountComponent(vnode: VNode): void {
      const inst = vnode._instance as ComponentInstance | undefined;
      if (!inst) return;
      // Run cleanup callbacks on unmount (exception-safe)
      _runCleanups(inst.cleanupCallbacks);
      inst.cleanupCallbacks = [];
      inst.disposed = true;
      inst.pendingRender = false;
      inst._root.pendingComponents.delete(inst);
      for (const unsub of inst.unsubs) unsub();
      inst.unsubs = [];
      _computedDisposeAll(inst.computeds);
      vnode._instance = undefined;
    },
  };
}
