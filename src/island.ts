// Island — mount external framework components (React, Vue, Solid, etc.) into AIR pages.
// AIR owns the page; external components mount into managed DOM containers.
//
// ARCH: The container div's children are managed by the external framework,
// NOT by AIR's VDOM. We must never trigger an AIR re-render of the island
// component itself, as the diff would wipe externally-injected DOM.

import { h } from "./vdom.ts";
import type { ComponentFn, VChild, VNode } from "./vdom.ts";
import { effect, untrack } from "./signal.ts";
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
}

/**
 * Mount external framework components into AIR pages.
 * Returns an AIR component function that handles lazy loading,
 * signal-to-props bridging, and cleanup on unmount.
 */
export function island<M = unknown>(config: IslandConfig<M>): ComponentFn {
  let moduleCache: M | null = null;
  let modulePromise: Promise<M> | null = null;

  function loadModule(): Promise<M> {
    if (moduleCache) return Promise.resolve(moduleCache);
    if (!modulePromise) {
      modulePromise = config.load().then((mod) => {
        moduleCache = mod;
        return mod;
      }).catch((err) => {
        modulePromise = null; // Allow retry on next mount
        throw err;
      });
    }
    return modulePromise;
  }

  return function IslandComponent(
    _props: Record<string, unknown>,
  ): VNode | null {
    const containerRef = useRef<HTMLElement | null>(null);
    const handleRef = useRef<IslandHandle | null>(null);
    const disposeRef = useRef<(() => void) | null>(null);

    onMount(() => {
      loadModule().then((mod) => {
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
        console.error("[aio:island] Failed to load module:", err);
      });
    });

    onCleanup(() => {
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
