// Island — mount external framework components (React, Vue, Solid, etc.) into AIR pages.
// AIR owns the page; external components mount into managed DOM containers.
//
// ARCH: The container div's children are managed by the external framework,
// NOT by AIR's VDOM. We must never trigger an AIR re-render of the island
// component itself, as the diff would wipe externally-injected DOM.

import { h } from "./vdom.ts";
import type { ComponentFn, VChild, VNode } from "./vdom.ts";
import { effect, untrack } from "../state/signal.ts";
import { afterRender, onCleanup, onMount, useRef } from "./aio-renderer.ts";

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
  /** Reactive props function — re-evaluated when signals change. Props
   *  written on the island in JSX (`<Chart symbol="A"/>`) are merged OVER
   *  these, per instance. */
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

  /** `config.load()`, with a synchronous throw as a rejected load — it used
   *  to escape the island's onMount, reported as a generic effect failure
   *  instead of "Failed to load module". */
  const _load = (): Promise<M> => new Promise<M>((r) => r(config.load()));

  function loadModule(): Promise<M> {
    // With cacheKey: use global cache
    if (cacheKey !== undefined) {
      const cached = _moduleCache.get(cacheKey);
      if (cached?.module) return Promise.resolve(cached.module as M);
      if (cached?.promise) return cached.promise as Promise<M>;

      const promise = _load().then((mod) => {
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
      localModulePromise = _load().then((mod) => {
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
    props: Record<string, unknown>,
  ): VNode | null {
    const containerRef = useRef<HTMLElement | null>(null);
    const handleRef = useRef<IslandHandle | null>(null);
    const disposeRef = useRef<(() => void) | null>(null);
    // The props written on THIS instance in JSX. They were dropped: only
    // `config.props()` ever reached mount/update, so `<Chart symbol="A"/>`
    // and `<Chart symbol="B"/>` rendered the same thing, silently. Merged
    // over `config.props()` (JSX wins, as a prop written at the call site
    // does), `children` aside — the container's content is the external
    // framework's.
    const jsxRef = useRef<Record<string, unknown>>({});
    /** The JSX props the island last saw, and the props it was last given. */
    const seenJsxRef = useRef<Record<string, unknown> | null>(null);
    const appliedRef = useRef<Record<string, unknown> | null>(null);
    const { children: _children, ...jsx } = props ?? {};
    jsxRef.current = jsx;
    const merged = (): Record<string, unknown> => {
      seenJsxRef.current = jsxRef.current;
      return { ...config.props(), ...jsxRef.current };
    };
    /** Hand `next` to the mounted island. With JSX props, a value that both
     *  `props()` and the JSX read (`<W n={count.value}/>` beside
     *  `props: () => ({ n: count.value })`) arrives twice — the effect first,
     *  still masked by the old JSX, then the re-render — so an update that
     *  changes nothing is skipped. Without JSX props every effect run still
     *  updates, exactly as before (a mutated-and-forced object included). */
    const apply = (next: Record<string, unknown>): void => {
      const h = handleRef.current;
      if (!h || disposedRef.current) return;
      const prev = appliedRef.current;
      if (
        prev && Object.keys(jsxRef.current).length > 0 && _sameProps(prev, next)
      ) {
        return;
      }
      appliedRef.current = next;
      untrack(() => h.update(next));
    };
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
      // Registered INSIDE onMount ⇒ unmount-only (the AIO-76 routing). In the
      // component BODY `onCleanup` also fires before EVERY re-render, and an
      // island re-renders whenever a prop changes — so `<Chart n={count}/>`
      // mounted, then tore the external component down on the first `n` change
      // and never rebuilt it (onMount is once-per-instance): a permanently
      // empty <div>, silently. Every island test used a prop-LESS island, so
      // nothing caught it. Same rule as compat.ts's useEffect and raf.ts.
      onCleanup(() => {
        disposedRef.current = true;
        if (disposeRef.current) disposeRef.current();
        if (handleRef.current) handleRef.current.unmount();
        handleRef.current = null;
        disposeRef.current = null;
      });

      loadModule().then((mod) => {
        loadedRef.current = true;
        if (disposedRef.current) return; // unmounted while loading — bail
        const container = containerRef.current;
        if (!container) return;

        const component = (mod && typeof mod === "object" && "default" in mod)
          ? (mod as { default: unknown }).default
          : mod;

        const initialProps = untrack(merged);
        handleRef.current = config.mount(
          container,
          // deno-lint-ignore no-explicit-any
          component as any,
          initialProps,
        );
        appliedRef.current = initialProps;

        // Set up reactive props watcher — skip first run (mount already applied initial props).
        // Effect runs outside AIR tracking, so signal changes call handle.update() directly.
        let firstRun = true;
        disposeRef.current = effect(() => {
          const nextProps = merged();
          if (firstRun) {
            firstRun = false;
            return;
          }
          apply(nextProps);
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

    // A re-render with CHANGED JSX props updates the mounted island in place —
    // after the commit, never from inside this render.
    if (
      handleRef.current && seenJsxRef.current &&
      !_sameProps(seenJsxRef.current, jsx)
    ) {
      afterRender(() => apply(untrack(merged)));
    }

    // Loading placeholder is rendered as initial children of the container div.
    // The external mount() will replace the container contents when ready.
    if (config.loading) {
      return h("div", { ref: containerRef }, config.loading());
    }

    return h("div", { ref: containerRef });
  };
}

/** Same keys, each `Object.is` — the JSX props of two renders. */
function _sameProps(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && Object.is(a[k], b[k]));
}
