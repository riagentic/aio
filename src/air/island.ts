// Island — mount external framework components (React, Vue, Solid, etc.) into AIR pages.
// AIR owns the page; external components mount into managed DOM containers.
//
// ARCH: The container div's children are managed by the external framework,
// NOT by AIR's VDOM. We must never trigger an AIR re-render of the island
// component itself, as the diff would wipe externally-injected DOM.

import { h } from "./vdom.ts";
import type { ComponentFn, VChild, VNode } from "./vdom.ts";
import { effect, untrack } from "../state/signal.ts";
import { onCleanup, onMount, useRef } from "./aio-renderer.ts";

/** Handle returned by the mount function — allows update and unmount. */
export interface IslandHandle {
  update(props: Record<string, unknown>): void;
  unmount(): void;
}

/** Configuration for island(). */
export interface IslandConfig<M = unknown> {
  /** Lazy-load the external module. */
  load: () => Promise<M>;
  /** Mount the external component into a container. Called once after load. */
  mount: (
    container: HTMLElement,
    component: M extends { default: infer C } ? C : M,
    props: Record<string, unknown>,
  ) => IslandHandle;
  /** Reactive props function — re-evaluated when signals change. */
  props: () => Record<string, unknown>;
  /** Optional loading placeholder component. */
  loading?: () => VChild;
  /** Optional cache key — change to force reload of the module (e.g., version hash). */
  cacheKey?: string | number;
}

// Cache for islands WITH explicit cacheKey. Islands without cacheKey use
// per-closure caching (the original behavior - load once per island() call).
const _moduleCache = new Map<
  string | number,
  { module: unknown; promise: Promise<unknown> | null }
>();

/**
 * Clear the island module cache for a specific key, or all cached islands.
 * Only affects islands with explicit cacheKey configured.
 */
export function clearIslandCache(cacheKey?: string | number): void {
  if (cacheKey !== undefined) {
    _moduleCache.delete(cacheKey);
  } else {
    _moduleCache.clear();
  }
}

/**
 * Mount external framework components into AIR pages.
 * Returns an AIR component function that handles lazy loading,
 * signal-to-props bridging, and cleanup on unmount.
 */
export function island<M = unknown>(config: IslandConfig<M>): ComponentFn {
  // Islands WITH cacheKey: use global cache (shared across instances)
  // Islands WITHOUT cacheKey: use local closure cache (original behavior)
  const cacheKey = config.cacheKey;

  let localModuleCache: M | null = null;
  let localModulePromise: Promise<M> | null = null;

  function loadModule(): Promise<M> {
    // With cacheKey: use global cache
    if (cacheKey !== undefined) {
      const cached = _moduleCache.get(cacheKey);
      if (cached?.module) return Promise.resolve(cached.module as M);
      if (cached?.promise) return cached.promise as Promise<M>;

      const promise = config.load().then((mod) => {
        _moduleCache.set(cacheKey, { module: mod, promise: null });
        return mod;
      }).catch((err) => {
        _moduleCache.set(cacheKey, { module: null, promise: null });
        throw err;
      });

      _moduleCache.set(cacheKey, { module: null, promise });
      return promise as Promise<M>;
    }

    // Without cacheKey: use local closure cache (original behavior)
    if (localModuleCache) return Promise.resolve(localModuleCache);
    if (!localModulePromise) {
      localModulePromise = config.load().then((mod) => {
        localModuleCache = mod;
        return mod;
      }).catch((err) => {
        localModulePromise = null;
        throw err;
      });
    }
    return localModulePromise;
  }

  return function IslandComponent(
    _props: Record<string, unknown>,
  ): VNode | null {
    const containerRef = useRef<HTMLElement | null>(null);
    const handleRef = useRef<IslandHandle | null>(null);
    const disposeRef = useRef<(() => void) | null>(null);
    // Guard against unmount landing between loadModule() resolve and mount().
    // Without this, a late-arriving load calls config.mount() on a detached
    // container and assigns handleRef/disposeRef AFTER onCleanup already ran
    // — leaking the external framework's mount (no unmount() ever fires).
    const disposedRef = useRef(false);

    // Did the LOAD succeed? Without this, a `config.mount()` throw was reported
    // as "Failed to load module" — the real error wearing the wrong label,
    // pointing at the wrong half of the feature.
    const loadedRef = useRef(false);

    onMount(() => {
      loadModule().then((mod) => {
        loadedRef.current = true;
        if (disposedRef.current) return; // unmounted while loading — bail
        const container = containerRef.current;
        if (!container) return;

        const component = (mod && typeof mod === "object" && "default" in mod)
          ? (mod as { default: unknown }).default
          : mod;

        const initialProps = untrack(config.props);
        handleRef.current = config.mount(
          container,
          // deno-lint-ignore no-explicit-any
          component as any,
          initialProps,
        );

        // Set up reactive props watcher — skip first run (mount already applied initial props).
        // Effect runs outside AIR tracking, so signal changes call handle.update() directly.
        let firstRun = true;
        disposeRef.current = effect(() => {
          const nextProps = config.props();
          if (firstRun) {
            firstRun = false;
            return;
          }
          if (handleRef.current) {
            untrack(() => handleRef.current!.update(nextProps));
          }
        });
      }).catch((err) => {
        // "Failed to load module" was printed for a module that loaded fine and
        // a `config.mount()` that threw — the real error wearing the wrong
        // label, with the island left as a permanent placeholder and no
        // handle/dispose ever set. Name which half failed.
        const mounted = handleRef.current !== null;
        console.error(
          mounted
            ? "[aio:island] mounted module threw while updating props:"
            : loadedRef.current
            ? "[aio:island] module loaded but mount() threw — the island stays empty:"
            : "[aio:island] Failed to load module:",
          err,
        );
      });
    });

    onCleanup(() => {
      disposedRef.current = true;
      if (disposeRef.current) disposeRef.current();
      if (handleRef.current) handleRef.current.unmount();
      handleRef.current = null;
      disposeRef.current = null;
    });

    // Loading placeholder is rendered as initial children of the container div.
    // The external mount() will replace the container contents when ready.
    if (config.loading) {
      return h("div", { ref: containerRef }, config.loading());
    }

    return h("div", { ref: containerRef });
  };
}
