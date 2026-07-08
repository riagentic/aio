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
export function _registerRoot(handle: MountHandle, state: RootState): void {
  _rootStateMap.set(handle, state);
}
