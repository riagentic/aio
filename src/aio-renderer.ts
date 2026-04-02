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
  _effectCollectEnd,
  _effectCollectStart,
  _effectDisposeAll,
  _trackEnd,
  _trackStart,
  batch,
  type Computed as _Computed,
  computed,
  type Disposable,
  type Signal,
  signal,
} from "./signal.ts";
import { bindSignalProps, cleanupSignalBindings } from "./signal-binding.ts";
import type { ComponentFn, RenderCtx, VDomHooks, VNode } from "./vdom.ts";
import {
  _applyActions,
  _bindSignalTextChildren,
  _callRef,
  _cleanupSignalTextChildren,
  _diff,
  _ensureDelegation,
  _isDelegated,
  _mapEventName,
  _render,
  _setDelegationRoot,
  _setDevA11yCheck,
  _setSsrStartHook,
  _setWrapped,
  _teardownDelegation,
  Fragment,
  getDom,
  h,
  setDevMode as _setDevModeVdom,
  SVG_TAGS,
} from "./vdom.ts";
import { _isDevToolsConnected, _recordRender } from "./devtools.ts";
import { _getExitHandler, _setLifecycleHooks } from "./transition-component.ts";
import {
  _getGroupExitHandler,
  _setGroupAfterRender,
} from "./transition-group.ts";

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
  effectDisposes: (() => void)[];
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
  /** Cleanup callbacks to run on unmount or before re-render (body-level). */
  cleanupCallbacks: (() => void)[];
  /** Cleanup callbacks registered inside onMount — run ONLY on unmount. */
  mountCleanupCallbacks: (() => void)[];
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
  /** Dev mode: name of the signal that triggered the last re-render. */
  _triggerSignals?: Set<string>;
  /** Parent component instance — used to rebuild ancestor stack for signal re-renders (AIO-249). */
  parent: ComponentInstance | null;
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
  /** Per-root afterRender callback queue. */
  afterRenderQueue: (() => void)[];
  /** Per-root counter for useId() — deterministic across renders. */
  _idCounter: number;
  /** AIO-209: cycle detection counts — persists across yield boundaries. */
  _renderCounts: Map<ComponentInstance, number>;
}

interface HookState {
  skip: boolean;
  // deno-lint-ignore no-explicit-any
  deps: Set<any> | null;
  collected: Disposable[] | null;
  effectCollected: (() => void)[] | null;
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
let _insideMount = false;
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
 * Register a cleanup callback.
 * - Called in component body: runs on unmount AND before each re-render.
 * - Called inside onMount(): runs ONLY on unmount (AIO-76 fix).
 * Must be called inside a component function body or onMount callback.
 */
export function onCleanup(fn: () => void): void {
  if (!_currentCollector) return;
  if (_insideMount && "mountCleanupCallbacks" in _currentCollector) {
    (_currentCollector as ComponentInstance).mountCleanupCallbacks.push(fn);
  } else {
    _currentCollector.cleanupCallbacks.push(fn);
  }
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

/**
 * Create a component-scoped signal that persists across re-renders.
 * Like signal() but tied to the component lifecycle — auto-GC'd on unmount.
 * Must be called inside a component function body during render.
 */
export function useSignal<T>(initial: T): Signal<T> {
  if (!_currentCollector) {
    if (_devMode) {
      console.warn(
        "[aio-dev] useSignal() called outside a component render. The signal will not persist across re-renders.",
      );
    }
    return signal(initial);
  }
  const collector = _currentCollector;
  if (!collector.refs) collector.refs = [];
  if (collector.refIndex === undefined) collector.refIndex = 0;
  const idx = collector.refIndex++;
  if (idx >= collector.refs.length) {
    // First render — create signal and store in ref slot
    const sig = signal(initial);
    collector.refs.push(sig as unknown as { current: unknown });
    return sig;
  }
  return collector.refs[idx] as unknown as Signal<T>;
}

// ── useId — SSR-safe unique ID ─────────────────────────────────────

/** SSR counter — used by renderToString when no RootState exists. */
let _ssrIdCounter = 0;

/** Reset SSR ID counter. Called at the start of each renderToString. */
export function _resetSsrIdCounter(): void {
  _ssrIdCounter = 0;
}

/**
 * Generate a unique, SSR-stable ID. Persists across re-renders.
 * Format: `:r{N}:` — deterministic per render tree traversal order.
 * Must be called inside a component function body during render.
 */
export function useId(): string {
  if (!_currentCollector) {
    // SSR path — no collector, use global SSR counter
    return `:r${_ssrIdCounter++}:`;
  }
  const collector = _currentCollector;
  if (!collector.refs) collector.refs = [];
  if (collector.refIndex === undefined) collector.refIndex = 0;
  const idx = collector.refIndex++;
  if (idx >= collector.refs.length) {
    // First render — allocate ID from root counter
    const root = _activeRoot;
    const n = root ? root._idCounter++ : _ssrIdCounter++;
    const ref = { current: `:r${n}:` };
    collector.refs.push(ref);
    return ref.current;
  }
  return (collector.refs[idx] as { current: string }).current;
}

// ── useOptimistic — optimistic UI during async operations ──────────

/**
 * Optimistic UI hook. Shows an immediate update while an async action runs,
 * then reverts to the real state when it completes (success or failure).
 *
 * @param passthrough - Current confirmed state (usually from server/feature).
 * @param updateFn - Pure function: (current, optimisticValue) => newState.
 * @returns [displayState, addOptimistic] — display reflects optimistic overlay
 *   when pending, otherwise passthrough. addOptimistic(value) applies the overlay.
 */
export function useOptimistic<T, A = T>(
  passthrough: T,
  updateFn: (current: T, optimistic: A) => T,
): [T, (action: A) => void] {
  // Pending actions in a ref (no reactivity on mutation).
  // A version signal triggers re-render when addOptimistic is called.
  const pendingRef = useRef<A[]>([]);
  const version = useSignal(0);

  // When passthrough changes (server confirmed), clear all pending actions.
  const prevRef = useRef<T>(passthrough);
  if (passthrough !== prevRef.current) {
    prevRef.current = passthrough;
    pendingRef.current = [];
  }

  // Track version signal so component re-renders on addOptimistic.
  // Read is the tracking mechanism — value itself is unused.
  void version.value;

  // Display state: apply all pending optimistic actions on top of passthrough.
  let display = passthrough;
  for (const action of pendingRef.current) {
    display = updateFn(display, action);
  }

  function addOptimistic(action: A): void {
    pendingRef.current = [...pendingRef.current, action];
    version.set(version.peek() + 1);
  }

  return [display, addOptimistic];
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

/**
 * Select a slice of context. Component only re-renders when the selected value changes.
 * Uses a computed signal so only the selected slice is tracked as a dependency.
 * Must be called inside a component function body during render.
 */
export function useContextSelector<T, R>(
  ctx: Context<T>,
  selector: (value: T) => R,
): R {
  // Walk the instance stack to find the context signal directly (without tracking)
  let contextSignal: Signal<T> | null = null;
  for (let i = _instanceStack.length - 1; i >= 0; i--) {
    const inst = _instanceStack[i]!;
    if (inst.contexts?.has(ctx._id)) {
      const entry = inst.contexts.get(ctx._id);
      if (entry && typeof entry === "object" && "value" in entry) {
        contextSignal = entry as Signal<T>;
      }
      break;
    }
  }

  if (!contextSignal) {
    // No provider — apply selector to default
    return selector(ctx._default);
  }

  // Read the context signal and apply selector — the computed tracks the context signal,
  // but the component only tracks the computed's output value.
  // The computed memo ensures the component only re-renders when the selected slice changes.
  // NOTE: This creates a new computed on every render. The computed is lightweight
  // and automatically disposed when the component re-renders (collected via _computedCollector).
  const sig = contextSignal;
  const selected = computed(() => selector(sig.value));
  return selected.value;
}

// ── afterRender queue (per-root isolated) ───────────────────────────

/** Currently active root during render — used by afterRender() to find the right queue. */
let _activeRoot: RootState | null = null;

/**
 * Register a callback to run after the current render cycle commits to the DOM.
 * Works for both initial mount and signal-triggered re-renders.
 * Use for DOM measurement, scroll restoration, imperative DOM API calls, etc.
 */
export function afterRender(fn: () => void): void {
  if (_activeRoot) {
    _activeRoot.afterRenderQueue.push(fn);
  }
}

function _flushAfterRender(root: RootState): void {
  const cbs = root.afterRenderQueue;
  if (cbs.length === 0) return;
  root.afterRenderQueue = [];
  for (const cb of cbs) {
    try {
      cb();
    } catch (e) {
      console.error("[aio-renderer] afterRender callback error:", e);
    }
  }
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

/** @internal Dev-mode a11y checks on element creation. */
function _devA11yCheck(tag: string, props: Record<string, unknown>): void {
  // img without alt
  if (tag === "img" && !("alt" in props)) {
    console.warn(
      `[aio-dev] <img> missing "alt" attribute. Add alt="" for decorative images or descriptive text for meaningful ones.`,
    );
  }

  // onClick without keyboard handler (on non-interactive elements)
  if (
    props.onClick &&
    !props.onKeyDown &&
    !props.onKeyUp &&
    !props.onKeyPress &&
    tag !== "button" &&
    tag !== "a" &&
    tag !== "input" &&
    tag !== "select" &&
    tag !== "textarea"
  ) {
    console.warn(
      `[aio-dev] <${tag}> has onClick but no keyboard handler. Add onKeyDown for keyboard accessibility.`,
    );
  }

  // form input without label association
  if (
    (tag === "input" || tag === "textarea" || tag === "select") &&
    !props["aria-label"] &&
    !props["aria-labelledby"] &&
    !props.id
  ) {
    console.warn(
      `[aio-dev] <${tag}> has no label association. Add id (for <label htmlFor>), aria-label, or aria-labelledby.`,
    );
  }
}

/** Enable dev-mode warnings (excessive re-renders, also enables VDOM key warnings). */
export function setDevMode(enabled: boolean): void {
  _devMode = enabled;
  _setDevModeVdom(enabled);
  _setDevA11yCheck(enabled ? _devA11yCheck : null);
}

// Wire lifecycle hooks to <Transition> and <TransitionGroup> (avoids circular import)
_setLifecycleHooks(onMount, onCleanup, afterRender);
_setGroupAfterRender(afterRender, useRef);

// Wire SSR ID counter reset into renderToString
_setSsrStartHook(_resetSsrIdCounter);

// ── Shallow props comparison (auto-memo) ────────────────────────────

function _shallowEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.hasOwn(b, k) || !Object.is(a[k], b[k])) return false; // AIO-237: key-existence check
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

  _stateMap.set(handle, state);

  // Create hooks and attach to context
  state.ctx.hooks = _createHooks(state);

  // Wire lazy resolve: re-render the root when any lazy component resolves
  state.ctx.onLazyResolve = () => {
    if (state.disposed) return;
    _rerenderRoot(state);
  };

  // Wire deferred removal for <Transition> / <TransitionGroup> exit animations
  state.ctx.onBeforeRemove = (el) => {
    const inner = _getExitHandler(el);
    const outer = _getGroupExitHandler(el);
    if (inner && outer) {
      return Promise.all([inner(el), outer(el)]).then(() => {});
    }
    const handler = inner ?? outer;
    return handler ? handler(el) : undefined;
  };

  // Initial render — set active root so afterRender() finds the right queue
  _activeRoot = state;
  _setDelegationRoot(root);
  try {
    const vnode = h(App, null);
    _render(state.root, vnode, null, state.ctx);
    state.vnode = vnode;
    _flushAfterRender(state);
  } finally {
    _activeRoot = null;
    _setDelegationRoot(null);
  }

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

  _stateMap.set(handle, state);
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

  // Execute component tree to build VNode structure
  _activeRoot = state;
  _setDelegationRoot(root);
  try {
    const vnode = h(App, null);
    const consumed = _hydrateNode(root, vnode, state.ctx, false, 0);
    if (consumed < 0) {
      root.innerHTML = "";
      _render(root, vnode, null, state.ctx);
    }
    state.vnode = vnode;
    _flushAfterRender(state);
  } finally {
    _activeRoot = null;
    _setDelegationRoot(null);
  }

  return handle;
}

/**
 * Hydrate a single VNode against existing DOM.
 * Returns the number of DOM nodes consumed (>= 0) on success, or -1 on failure.
 * AIO-92: Fragments/components can consume N DOM nodes, not always 1.
 */
function _hydrateNode(
  parent: Node,
  vnode: VNode | string | number,
  ctx: RenderCtx,
  isSvg: boolean,
  childIndex: number,
): number {
  // Text nodes — consume exactly 1 DOM node
  if (typeof vnode === "string" || typeof vnode === "number") {
    const domNode = parent.childNodes[childIndex];
    if (!domNode) return -1;
    if (domNode.nodeType !== 3) return -1;
    if (domNode.textContent !== String(vnode)) {
      domNode.textContent = String(vnode);
    }
    return 1;
  }

  // Null placeholder — consume 1 comment node (AIO-107)
  if (vnode.tag === Symbol.for("aio.Null") as typeof vnode.tag) {
    const domNode = parent.childNodes[childIndex];
    if (domNode && domNode.nodeType === 8) { // Comment node
      vnode._dom = domNode;
      return 1;
    }
    // No comment found (SSR mismatch) — create one
    const comment = (parent.ownerDocument ?? document).createComment("");
    const anchor = parent.childNodes[childIndex];
    if (anchor) parent.insertBefore(comment, anchor);
    else parent.appendChild(comment);
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
    vnode._rendered = rendered;
    ctx.hooks?.afterComponent(vnode, rendered, hookState);
    if (rendered == null) {
      ctx.hooks?.afterSubtree?.(vnode);
      return 0; // null render = 0 DOM nodes
    }
    const count = _hydrateNode(parent, rendered, ctx, isSvg, childIndex);
    if (count >= 0) vnode._dom = getDom(rendered) ?? undefined;
    ctx.hooks?.afterSubtree?.(vnode);
    return count;
  }

  // Portal — consumes 0 DOM nodes (renders elsewhere)
  if (vnode.tag === Symbol.for("aio.Portal") as typeof vnode.tag) {
    return 0;
  }

  // ErrorBoundary / Suspense / Fragment — children are inline in parent DOM
  if (
    vnode.tag === (Symbol.for("aio.Fragment") as typeof vnode.tag) ||
    vnode.tag === (Symbol.for("aio.ErrorBoundary") as typeof vnode.tag) ||
    vnode.tag === (Symbol.for("aio.Suspense") as typeof vnode.tag)
  ) {
    let idx = childIndex;
    for (const child of vnode.children) {
      const consumed = _hydrateNode(parent, child, ctx, isSvg, idx);
      if (consumed < 0) return -1;
      idx += consumed;
    }
    // AIO-256: loop to find first DOM-bearing child (matches diff path in vdom.ts)
    for (const child of vnode.children) {
      const d = getDom(child);
      if (d) {
        vnode._dom = d;
        break;
      }
    }
    return idx - childIndex; // total DOM nodes consumed
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

  // AIO-249: bind signal text children during hydration (matches createDom path in vdom.ts)
  if (vnode._signalChildren) {
    _bindSignalTextChildren(el, vnode._signalChildren);
  }

  return 1; // element itself is 1 DOM node in parent
}

/** Apply event listeners, signal bindings, and refs during hydration (attributes are already set). */
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
      // Wrap in batch() — same as applyProps in vdom.ts — so multiple signal
      // writes in a single event handler coalesce into one re-render.
      const handler = v as EventListener;
      const wrapped = ((e: Event) => batch(() => handler(e))) as EventListener;
      if (_isDelegated(evt) && _activeRoot) {
        // Delegated: store in lookup map, ensure root listener exists
        _ensureDelegation(_activeRoot.root, evt);
        _setWrapped(el, evt, wrapped);
      } else {
        // Non-delegated: per-element listener
        el.addEventListener(evt, wrapped);
        _setWrapped(el, evt, wrapped);
      }
    }
  }
  // Bind signal props — create direct signal→DOM effects (same as createDom path)
  bindSignalProps(el, props);
  // Handle ref
  if (props.ref) _callRef(props.ref, el);
  // Apply action directives (AIO-89: `use` was skipped during hydration)
  if (props.use) _applyActions(el, props.use);
}

// ── Unmount ─────────────────────────────────────────────────────────

export function _unmount(handle: MountHandle): void {
  const state = _stateMap.get(handle);
  if (!state) return;

  state.disposed = true;
  state.pendingComponents.clear();
  state._renderCounts.clear(); // AIO-278: clear renderCounts on unmount

  // Recursively unmount all component instances in the tree
  if (state.vnode && typeof state.vnode === "object") {
    _unmountTree(state.vnode, state.ctx);
  }

  // Clean up event delegation root listeners
  if (state.root && typeof state.root.addEventListener === "function") {
    _teardownDelegation(state.root);
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
    // Dispose signal binding effects on this element (AIO-78)
    if (vnode._dom && typeof (vnode._dom as Element).tagName === "string") {
      cleanupSignalBindings(vnode._dom as Element);
      _cleanupSignalTextChildren(vnode._dom as Element);
    }
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

// "Kis's Concurrency" — lightweight yield mechanism during batch flush.
// Budget per flush cycle: yield to browser after 12ms so input stays responsive.
// Leaves ~4ms for browser work within a 16ms frame budget. Unlike React's 10K-line
// priority scheduler, this is a simple time-slice that handles 95% of cases where
// many components update from a single signal change.
const _FLUSH_BUDGET_MS = 12;

function _flushPending(root: RootState): void {
  root.flushScheduled = false;
  if (root.disposed) return; // AIO-243: guard against flush on disposed root after yield
  const prevRoot = _activeRoot;
  _activeRoot = root;
  _setDelegationRoot(root.root);
  const _now = typeof performance !== "undefined"
    ? () => performance.now()
    : Date.now;
  try {
    const deadline = _now() + _FLUSH_BUDGET_MS;
    // AIO-167: Cycle detection — track per-component render count within a single
    // flush. An individual component re-rendering >25 times in one flush is a signal
    // write during render (A triggers B triggers A). A raw iteration cap is wrong
    // because (a) long cascades of DIFFERENT components are legitimate and (b)
    // clearing pendingComponents without resetting pendingRender creates zombies.
    // AIO-209: use root-scoped map that persists across yield boundaries
    // AIO-288: increased from 10 to 25 to avoid false positives in complex reactive graphs
    const _renderCounts = root._renderCounts;
    const _CYCLE_LIMIT = 25;
    while (root.pendingComponents.size > 0) {
      const batch = [...root.pendingComponents];
      root.pendingComponents.clear();
      for (const inst of batch) {
        if (inst.disposed || !inst.pendingRender) continue;
        // Check for render cycle before processing
        const count = (_renderCounts.get(inst) ?? 0) + 1;
        _renderCounts.set(inst, count);
        if (count > _CYCLE_LIMIT) {
          const name = typeof inst.vnode.tag === "function"
            ? (inst.vnode.tag.name || "Anonymous")
            : "Component";
          console.error(
            `[aio-renderer] ${name} re-rendered ${_CYCLE_LIMIT} times in a single flush — ` +
              `likely signal write during render. Breaking cycle for this component.`,
          );
          // Reset pendingRender so the component isn't permanently frozen —
          // it can still respond to future signal changes from user interaction.
          inst.pendingRender = false;
          continue;
        }
        inst.pendingRender = false;
        _rerenderComponent(inst);
        // Yield to browser if over budget — schedule continuation
        if (_now() > deadline && root.pendingComponents.size > 0) {
          _activeRoot = prevRoot;
          _setDelegationRoot(null);
          root.flushScheduled = true;
          queueMicrotask(() => _flushPending(root));
          return; // afterRender fires when continuation completes
        }
      }
    }
    root._renderCounts.clear(); // AIO-209: reset after full flush completes
    _flushAfterRender(root);
  } finally {
    _activeRoot = prevRoot;
    _setDelegationRoot(null);
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
  const prevRoot = _activeRoot;
  _activeRoot = state;
  _setDelegationRoot(state.root);
  try {
    const vnode = h(state.App, null);
    _diff(state.root, vnode, oldVnode, state.ctx);
    state.vnode = vnode;
    _flushAfterRender(state);
  } finally {
    _activeRoot = prevRoot;
    _setDelegationRoot(null);
  }
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
  inst.mountCallbacks = []; // AIO-161: prevent accumulation on re-render

  // Unsubscribe old deps and dispose old computeds/effects
  for (const unsub of inst.unsubs) unsub();
  inst.unsubs = [];
  _computedDisposeAll(inst.computeds);
  _effectDisposeAll(inst.effectDisposes);

  // AIO-249: Build ancestor chain so useContext() can walk _instanceStack
  // during signal-triggered re-renders (stack is otherwise empty).
  const ancestors: ComponentInstance[] = [];
  let ancestor = inst.parent;
  while (ancestor) {
    ancestors.push(ancestor);
    ancestor = ancestor.parent;
  }
  // Push ancestors root-first so the stack order matches normal rendering
  for (let i = ancestors.length - 1; i >= 0; i--) {
    _instanceStack.push(ancestors[i]!);
  }

  // Re-execute component with tracking
  const collected = _computedCollectStart();
  const effectCollected = _effectCollectStart();
  const deps = _trackStart();
  inst.refIndex = 0;
  _currentCollector = inst;
  let rendered: VNode | string | number | null;
  try {
    rendered = (vnode.tag as ComponentFn)({
      ...vnode.props,
      children: vnode.children.length > 0
        ? vnode.children
        : (vnode.props.children ?? vnode.children),
    });
  } catch (error) {
    // Error during signal-triggered re-render — keep old output, log error (AIO-138)
    _currentCollector = null;
    _trackEnd(deps);
    _computedCollectEnd(collected);
    _effectCollectEnd(effectCollected);
    // Dispose orphaned computeds/effects from the failed render (AIO-160)
    _computedDisposeAll(collected);
    _effectDisposeAll(effectCollected);
    console.error("[aio-renderer] Component render error:", error);
    // Subscribe to the NEW deps tracked during the (partial) failed render.
    // Using inst.deps would subscribe to disposed computeds → zombie component.
    _subscribeComponentDeps(inst, deps);
    inst.deps = deps;
    return;
  } finally {
    // AIO-249: Pop ancestor chain (both success and error paths)
    for (let _a = 0; _a < ancestors.length; _a++) {
      _instanceStack.pop();
    }
  }
  _currentCollector = null;
  _trackEnd(deps);
  _computedCollectEnd(collected);
  _effectCollectEnd(effectCollected);

  vnode._rendered = rendered;

  // Push onto instance stack so children can find context (Provider support)
  _instanceStack.push(inst);

  // Diff only this subtree — try-finally guarantees stack pop AND state update
  // even if _diff throws (AIO-180: prevents zombie component on diff exception)
  const ctx = inst._ctx;
  try {
    _diff(
      inst.parentDom,
      rendered ?? null,
      oldRendered ?? null,
      ctx,
      inst.isSvg,
    );
    vnode._dom = rendered ? (getDom(rendered) ?? undefined) : undefined;

    // Record render event for DevTools (only on successful diff)
    if (_devStart) {
      const name = typeof vnode.tag === "function"
        ? (vnode.tag.name || "Anonymous")
        : "Component";
      _recordRender({
        component: name,
        timestamp: Date.now(),
        durationMs: performance.now() - _devStart,
        trigger: "signal",
        signalNames: inst._triggerSignals?.size
          ? [...inst._triggerSignals]
          : undefined,
      });
      inst._triggerSignals = undefined;
    }
  } finally {
    _instanceStack.pop();

    // Update instance state regardless of _diff success (AIO-180).
    // Without this, a _diff throw leaves inst with disposed deps/computeds
    // and no signal subscriptions → zombie component that never re-renders.
    inst.oldRendered = rendered;
    inst.deps = deps;
    inst.computeds = collected;
    inst.effectDisposes = effectCollected;
    inst.selfTriggered = false;
    _subscribeComponentDeps(inst, deps);
  }

  // AIO-167 diagnostic: warn if component has no signal deps after re-render
  if (_devMode && deps.size === 0 && inst.unsubs.length === 0) {
    const name = typeof vnode.tag === "function"
      ? (vnode.tag.name || "Anonymous")
      : "Component";
    console.warn(
      `[aio-dev] ${name} re-rendered with 0 signal deps — component will not respond to future signal changes.`,
    );
  }
}

// ── Subscribe component instance to its deps ────────────────────────

function _subscribeComponentDeps(
  inst: ComponentInstance,
  // deno-lint-ignore no-explicit-any
  deps: Set<any>,
): void {
  for (const dep of deps) {
    const subscriber = {
      execute: () => {
        if (!inst._triggerSignals) inst._triggerSignals = new Set();
        inst._triggerSignals.add(dep._name ?? "anonymous");
        _scheduleComponentRender(inst);
      },
    };
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
          return {
            skip: true,
            deps: null,
            collected: null,
            effectCollected: null,
            parentDom,
            isSvg,
          };
        }
      }

      // Prepare tracking for this component
      if (inst) {
        // Run cleanup callbacks before re-render (exception-safe)
        _runCleanups(inst.cleanupCallbacks);
        inst.cleanupCallbacks = [];
        inst.mountCallbacks = []; // AIO-161: prevent accumulation on re-render
        // Clean up old tracking before re-render
        for (const unsub of inst.unsubs) unsub();
        inst.unsubs = [];
        _computedDisposeAll(inst.computeds);
        _effectDisposeAll(inst.effectDisposes);
      }

      const collected = _computedCollectStart();
      const effectCollected = _effectCollectStart();
      const deps = _trackStart();

      // Set collector for onMount/onCleanup/useRef registration during component execution
      const collector: LifecycleCollector = inst ??
        { mountCallbacks: [], cleanupCallbacks: [] };
      collector.refIndex = 0; // Reset ref index for this render pass
      _currentCollector = collector;

      return {
        skip: false,
        deps,
        collected,
        effectCollected,
        parentDom,
        isSvg,
      };
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
      _effectCollectEnd(hs.effectCollected!);

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
          effectDisposes: hs.effectCollected!,
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
          mountCleanupCallbacks: [],
          mounted: false,
          contexts: collector.contexts,
          refs: collector.refs,
          refIndex: collector.refIndex,
          // AIO-249: capture parent so signal re-renders can rebuild ancestor stack
          parent: _instanceStack.length > 0
            ? _instanceStack[_instanceStack.length - 1]!
            : null,
        };
        vnode._instance = inst;
      } else {
        // Update existing instance
        inst.deps = hs.deps!;
        inst.computeds = hs.collected!;
        inst.effectDisposes = hs.effectCollected!;
        inst.vnode = vnode;
        inst.oldRendered = rendered;
        inst.parentDom = hs.parentDom;
        inst.isSvg = hs.isSvg;
        inst.prevProps = { ...vnode.props };
        inst.prevChildren = vnode.children;
        inst.selfTriggered = false;
        // AIO-249: update parent in case component moved in tree
        inst.parent = _instanceStack.length > 0
          ? _instanceStack[_instanceStack.length - 1]!
          : null;
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
        // Restore collector so onCleanup() inside onMount() can register (AIO-74)
        // Set _insideMount so onCleanup() pushes to mountCleanupCallbacks (AIO-76)
        _currentCollector = inst as unknown as LifecycleCollector;
        _insideMount = true;
        try {
          for (const cb of cbs) cb();
        } finally {
          _insideMount = false;
          _currentCollector = null;
        }
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
        _effectCollectEnd(hs.effectCollected!);
        // AIO-205: dispose orphaned computeds/effects from partial render
        _computedDisposeAll(hs.collected!);
        _effectDisposeAll(hs.effectCollected!);
      }
      _currentCollector = null;
    },

    unmountComponent(vnode: VNode): void {
      const inst = vnode._instance as ComponentInstance | undefined;
      if (!inst) return;
      // Run both body-level and mount-level cleanups on unmount (exception-safe)
      _runCleanups(inst.cleanupCallbacks);
      inst.cleanupCallbacks = [];
      _runCleanups(inst.mountCleanupCallbacks);
      inst.mountCleanupCallbacks = [];
      inst.disposed = true;
      inst.pendingRender = false;
      inst._root.pendingComponents.delete(inst);
      for (const unsub of inst.unsubs) unsub();
      inst.unsubs = [];
      _computedDisposeAll(inst.computeds);
      _effectDisposeAll(inst.effectDisposes);
      vnode._instance = undefined;
    },
  };
}
