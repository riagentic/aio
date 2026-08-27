// renderer-types.ts — shared interfaces and helper for the AIO renderer.
// No imports from other renderer-* modules (this is the base layer; hook-error.ts
// is dependency-free and importable from anywhere).

import type { ComponentFn, RenderCtx, VNode } from "./vdom.ts";
import type { Disposable } from "../state/signal.ts";
import { _reportHookError } from "./hook-error.ts";

/** Handle returned by {@linkcode mount} / {@linkcode hydrate}. */
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
  /** Dev mode: how many state hooks (useRef/useSignal/useId) the PREVIOUS
   *  render called — a change means the call order moved (see the hook-order
   *  tripwire in renderer-rerender.ts). */
  _hookCount?: number;
  /** Dev mode: rolling window of render timestamps for burst detection. */
  _devRenderTimestamps?: number[];
  /** Dev mode: name of the signal that triggered the last re-render. */
  _triggerSignals?: Set<string>;
  /** Parent component instance — used to rebuild ancestor stack (AIO-249). */
  parent: ComponentInstance | null;
  /** Display name of this component — stamped on every render so a contained
   *  hook error (afterRender/onMount/onCleanup) can name where it came from. */
  _component?: string;
  /** DevTools only: renders of THIS instance, and how long the last one took.
   *  Maintained solely while a DevTools handle is connected
   *  (`_isDevToolsConnected()`), so an app that never opens one pays nothing —
   *  and read on demand by `src/air/devtools-tree.ts`, never pushed. */
  _dtRenders?: number;
  _dtLastMs?: number;
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
  /** True only while _flushPending is actively draining (not merely queued).
   *  Lets the scheduler tell an in-flight batch item (legitimately flagged
   *  pending but momentarily out of the live queue) apart from a component
   *  stranded across flushes — the latter is a bug to surface + self-heal. */
  flushing?: boolean;
  /** Root App component for full re-render (lazy resolve). */
  App: ComponentFn;
  /** Per-root afterRender callback queue. */
  afterRenderQueue: AfterRenderEntry[];
  /** Instances whose collected `onMount` callbacks are waiting for the DOM
   *  commit. `createDom` builds into a DocumentFragment and the `appendChild`
   *  that puts it in the document happens AFTER the subtree hook fires, so
   *  firing onMount there ran it on a DETACHED tree: `ref.current.isConnected`
   *  was false, `focus()` was a no-op and `getBoundingClientRect()` returned
   *  zeros — while docs/ui/air-lifecycle.md promises exactly those work.
   *  Drained by `_flushAfterRender`, which every commit path already calls and
   *  which `afterRender` was already correct on. */
  pendingMounts?: PendingMount[];
  /** Per-root counter for useId() — deterministic across renders. */
  _idCounter: number;
  /** AIO-209: cycle detection counts — persists across yield boundaries. */
  _renderCounts: Map<ComponentInstance, number>;
}

/** A queued `afterRender` callback plus the component that registered it — the
 *  name is captured at registration because the flush runs after that
 *  component's frame is gone, and a contained hook error has to say WHERE. */
export interface AfterRenderEntry {
  fn: () => void;
  component?: string;
}

/** An instance's `onMount` callbacks, waiting for the DOM commit. */
export interface PendingMount {
  inst: ComponentInstance;
  cbs: (() => void)[];
  component?: string;
}

export interface HookState {
  skip: boolean;
  /** DevTools only: when this render started. Set only while connected. */
  dtStart?: number;
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
  /** Name of the component currently collecting into this — stamped by the
   *  renderer so a contained hook error can name it. */
  _component?: string;
}

// ── Helper ────────────────────────────────────────────────────────────

/** Run cleanup callbacks safely — a throwing cleanup doesn't kill subsequent
 *  ones, and never the re-render/unmount that is running them. */
export function _runCleanups(cbs: (() => void)[], component?: string): void {
  for (const cb of cbs) {
    try {
      cb();
    } catch (e) {
      _reportHookError("onCleanup", e, component);
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
