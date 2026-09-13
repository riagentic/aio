// renderer-state.ts — global mutable renderer state shared across all modules.
// All renderer modules read/write through this module to avoid circular deps.
//
// ARCH NOTE: _instanceStack is global across all mount() roots.
// Safe because rendering is fully synchronous (push→children→pop within one call stack).
// If concurrent/async rendering is ever introduced, this must become per-root or fiber-local.

import type {
  ComponentInstance,
  LifecycleCollector,
  RootState,
} from "./renderer-types.ts";

/** Collector currently active inside a component render (for onMount/onCleanup/useRef). */
export let _currentCollector: LifecycleCollector | null = null;
export function _setCurrentCollector(c: LifecycleCollector | null): void {
  _currentCollector = c;
}

/** True when executing inside an onMount callback (so onCleanup routes to mountCleanupCallbacks). */
export let _insideMount = false;
export function _setInsideMount(v: boolean): void {
  _insideMount = v;
}

/** Component instance stack — ancestors currently rendering, used by useContext. */
export const _instanceStack: ComponentInstance[] = [];

/** Currently active root during render — used by afterRender() to find the right queue. */
export let _activeRoot: RootState | null = null;
export function _setActiveRoot(r: RootState | null): void {
  _activeRoot = r;
}

// ── Shared mount/hydrate handle registry ─────────────────────────────
// Both mount() and hydrate() register handles here so _unmount() can find any handle.

import type { MountHandle } from "./renderer-types.ts";

export const _rootStateMap = new WeakMap<MountHandle, RootState>();

/** Live (mounted, not disposed) roots — enumerable for the UI surface
 *  (`testUI` / `am surface`). Entries are removed on unmount. */
export const _liveRoots = new Set<RootState>();

export function _registerRoot(handle: MountHandle, state: RootState): void {
  _rootStateMap.set(handle, state);
  _liveRoots.add(state);
}

/** The `<ErrorBoundary>` vnodes currently being rendered through, innermost
 *  last.
 *
 *  A boundary is a SYMBOL tag, not a component, so it has no
 *  `ComponentInstance` and cannot be found by walking `inst.parent`. Each
 *  instance therefore records the boundary that was active when it MOUNTED —
 *  which is the only moment the answer is knowable, because a re-render
 *  happens long after this stack has unwound. @internal */
export const _boundaryStack: unknown[] = [];

/** The innermost boundary vnode being rendered through, or null. @internal */
export function _currentBoundary(): unknown {
  return _boundaryStack[_boundaryStack.length - 1] ?? null;
}

/** `_boundaryStack.length` at the start of each RE-RENDER diff pass (a signal
 *  re-render of one component, or a root re-render), innermost last.
 *
 *  A component render that throws during such a pass is contained where it
 *  happened when no `<ErrorBoundary>` was entered DURING the pass (the stack is
 *  still at its base): the component keeps its last committed output and the
 *  rest of the pass completes. Letting the throw unwind the pass instead left
 *  the DOM half-patched while the tree recorded the NEW vnodes, so the next
 *  render mounted a second copy beside the stale one. Empty outside a pass —
 *  a throw on MOUNT still propagates out of `mount()`. @internal */
export const _isolationBases: number[] = [];

/** One entry per `<Suspense>` retry in progress (innermost last): the
 *  `_instanceStack` and `_boundaryStack` depths when the retry began.
 *
 *  A retry builds its children off-document and all-or-nothing, so every
 *  instance created inside it is discarded when one child throws. The signals
 *  the failed render read must therefore be subscribed on the instance that
 *  OWNS the boundary — the one committed before the retry began — or nothing
 *  would ever ask for the retry again: the fallback stayed on screen after the
 *  signal that made the child throw had changed. @internal */
export const _suspenseRetries: { instances: number; boundaries: number }[] = [];

/** Bumped whenever a render may have THROWN WORK AWAY: a component body that
 *  threw or suspended (`abortComponent`), or a boundary that caught during a
 *  re-render pass (`_diffErrorBoundary` / `_diffSuspense`).
 *
 *  A boundary that swaps in its fallback discards every instance, signal child
 *  and ref the failed attempt had already built under it — none of them are in
 *  the tree any more, and nothing else will ever tear them down. The component
 *  whose output holds the boundary retires them once its subtree is done
 *  (`_sweepDiscarded`), and compares this number against the one it saw when
 *  its subtree began, so a render in which nothing threw pays one comparison
 *  and walks nothing. @internal */
let _discardEpoch = 0;

/** Record that a render may have discarded a subtree. @internal */
export function _noteDiscard(): void {
  _discardEpoch++;
}

/** The current discard epoch (see `_noteDiscard`). @internal */
export function _discardEpochNow(): number {
  return _discardEpoch;
}
