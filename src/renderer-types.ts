// renderer-types.ts — shared interfaces and helper for the AIO renderer.
// No imports from other renderer-* modules (this is the base layer).

import type { ComponentFn, RenderCtx, VNode } from "./vdom.ts";
import type { Disposable } from "./signal.ts";

export interface MountHandle {
  /** Synchronously execute any pending re-render (for testing). */
  _flush(): void;
}

// deno-lint-ignore no-explicit-any
export type AnyDoc = any;

export interface ComponentInstance {
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
  /** Parent component instance — used to rebuild ancestor stack (AIO-249). */
  parent: ComponentInstance | null;
}

export interface RootState {
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

export interface HookState {
  skip: boolean;
  // deno-lint-ignore no-explicit-any
  deps: Set<any> | null;
  collected: Disposable[] | null;
  effectCollected: (() => void)[] | null;
  parentDom: Node;
  isSvg: boolean;
}

export interface LifecycleCollector {
  mountCallbacks: (() => void)[];
  cleanupCallbacks: (() => void)[];
  // deno-lint-ignore no-explicit-any
  contexts?: Map<symbol, any>;
  // deno-lint-ignore no-explicit-any
  refs?: { current: any }[];
  refIndex?: number;
}

// ── Helper ────────────────────────────────────────────────────────────

/** Run cleanup callbacks safely — a throwing cleanup doesn't kill subsequent ones. */
export function _runCleanups(cbs: (() => void)[]): void {
  for (const cb of cbs) {
    try {
      cb();
    } catch (e) {
      console.error("[aio-renderer] Cleanup callback error:", e);
    }
  }
}

// ── Shallow comparison helpers (auto-memo) ────────────────────────────

export function _shallowEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.hasOwn(b, k) || !Object.is(a[k], b[k])) return false; // AIO-237
  }
  return true;
}

export function _childrenEqual(
  a: (VNode | string | number)[],
  b: (VNode | string | number)[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
