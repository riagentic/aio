import { Fragment, h } from "./vdom.ts";
import type { ComponentFn, VChild, VNode } from "./vdom.ts";
import { signal } from "../state/signal.ts";
import { onCleanup, onMount, useRef } from "./aio-renderer.ts";

/** When {@linkcode Defer} starts loading — a named trigger or a timer in ms. */
export type DeferTrigger =
  | "viewport"
  | "idle"
  | "hover"
  | "interaction"
  | "immediate"
  | number; // timer in ms

/** Props for {@linkcode Defer}. */
export interface DeferProps {
  /** When to start loading. Number = timer in ms. */
  trigger: DeferTrigger;
  /** Lazy-load function — returns module with default export component.
   *  Read when the trigger fires; a change after that is ignored (see
   *  {@linkcode Defer} — use a changing `key` to reload). */
  load: () => Promise<{ default: ComponentFn }>;
  /** Shown before trigger fires. */
  placeholder?: VChild;
  /** Shown while loading (after trigger fires). */
  loading?: VChild;
  /** Shown on load error. */
  error?: VChild;
  /** Minimum time to show loading state (ms). */
  loadingMinMs?: number;
  /** Props to pass to the loaded component. */
  componentProps?: Record<string, unknown>;
}

type DeferState = "idle" | "loading" | "loaded" | "error";

/**
 * Trigger-based lazy loading — renders a placeholder until the trigger fires
 * (viewport visibility, idle, hover, interaction, or a timer), then loads and
 * mounts the component.
 *
 * ONE-SHOT per mount: the trigger fires once and the loaded component then
 * stays. A `load` prop that CHANGES after the load has happened is not picked
 * up — deliberately, because the documented spelling is an inline arrow
 * (`load={() => import("./Chart.tsx")}`) whose identity changes on every
 * render, so reacting to it would reload the region forever. For a
 * router-driven region, give the `<Defer>` a `key` that changes with the route
 * (`<Defer key={route} load={loaders[route]} … />`): a new key is a new mount,
 * which is exactly the intent. Until the trigger fires, the LATEST `load` is
 * the one that runs.
 *
 * @example
 * ```tsx
 * <Defer trigger="viewport" load={() => import("../Chart.tsx")} placeholder={<Spinner />} />
 * ```
 */
export function Defer(props: DeferProps): VNode | null {
  const {
    trigger,
    load,
    placeholder,
    loading,
    error: errorFallback,
    loadingMinMs,
    componentProps,
  } = props;

  const stateRef = useRef<{ state: DeferState; Component: ComponentFn | null }>(
    {
      state: "idle",
      Component: null,
    },
  );
  const renderSig = useRef(signal(0)).current;
  const containerRef = useRef<HTMLElement | null>(null);
  const minWaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The LATEST `load`/`componentProps`, not the ones render 1 happened to have.
  // `triggerLoad` is reached from an `onMount` closure that is created exactly
  // once, so reading the destructured props directly meant a trigger that fires
  // later (viewport, hover, a timer) called render 1's loader forever.
  const loadRef = useRef(load);
  loadRef.current = load;
  // Set by the unmount cleanup. The `state !== "loading"` guards below are not
  // enough on their own: nothing moves the state off "loading" at unmount, so a
  // load that resolved afterwards armed a FRESH `loadingMinMs` timer — one the
  // cleanup that already ran can never clear.
  const disposedRef = useRef(false);

  function triggerLoad() {
    if (stateRef.current.state !== "idle") return;
    stateRef.current.state = "loading";
    renderSig.set(renderSig.peek() + 1);

    const loadStart = Date.now();
    loadRef.current().then(
      (mod) => {
        // unmounted, or already resolved
        if (disposedRef.current || stateRef.current.state !== "loading") return;
        const minWait = loadingMinMs
          ? loadingMinMs - (Date.now() - loadStart)
          : 0;
        const finish = () => {
          if (disposedRef.current || stateRef.current.state !== "loading") {
            return;
          }
          stateRef.current.state = "loaded";
          stateRef.current.Component = mod.default;
          renderSig.set(renderSig.peek() + 1);
        };
        if (minWait > 0) {
          minWaitTimerRef.current = setTimeout(finish, minWait);
        } else {
          finish();
        }
      },
      (err: unknown) => {
        if (disposedRef.current || stateRef.current.state !== "loading") return;
        stateRef.current.state = "error";
        // The reason was discarded entirely: a 404, a syntax error or a dead
        // network rendered `null` (no `error`/`placeholder` prop) with an
        // empty console — a blank region and nothing anywhere in the app to
        // say why. `island.ts` reports its failures; so does this.
        console.error(
          `[aio:Defer] load() failed — this region will render its \`error\` ` +
            `prop, or nothing at all if it has none:`,
          err,
        );
        renderSig.set(renderSig.peek() + 1);
      },
    );
  }

  onMount(() => {
    const el = containerRef.current;

    // Cleanup: mark disposed FIRST (so a late load cannot arm a new timer
    // behind us), then clear the loadingMinMs timer.
    onCleanup(() => {
      disposedRef.current = true;
      if (minWaitTimerRef.current) {
        clearTimeout(minWaitTimerRef.current);
        minWaitTimerRef.current = null;
      }
    });

    if (trigger === "immediate") {
      triggerLoad();
      return;
    }

    if (typeof trigger === "number") {
      const timer = setTimeout(triggerLoad, trigger);
      onCleanup(() => clearTimeout(timer));
      return;
    }

    if (!el) return;

    if (trigger === "viewport") {
      if (typeof IntersectionObserver === "undefined") {
        triggerLoad();
        return;
      }
      const io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              io.disconnect();
              triggerLoad();
              return;
            }
          }
        },
        { threshold: 0 },
      );
      io.observe(el);
      onCleanup(() => io.disconnect());
      return;
    }

    if (trigger === "idle") {
      const hasIdleCb = typeof requestIdleCallback !== "undefined";
      const id = hasIdleCb
        ? requestIdleCallback(() => triggerLoad())
        : setTimeout(() => triggerLoad(), 200);
      onCleanup(() => {
        if (hasIdleCb) {
          cancelIdleCallback(id as number);
        } else {
          clearTimeout(id as number);
        }
      });
      return;
    }

    if (trigger === "hover") {
      const handler = () => triggerLoad();
      el.addEventListener("mouseenter", handler, { once: true });
      onCleanup(() => el.removeEventListener("mouseenter", handler));
      return;
    }

    if (trigger === "interaction") {
      const handler = () => triggerLoad();
      el.addEventListener("click", handler, { once: true });
      el.addEventListener("keydown", handler, { once: true });
      onCleanup(() => {
        el.removeEventListener("click", handler);
        el.removeEventListener("keydown", handler);
      });
    }
  });

  // Read signal to subscribe component for re-renders
  renderSig.value;

  const { state, Component } = stateRef.current;

  if (state === "loaded" && Component) {
    return h(Component, componentProps ?? {});
  }

  if (state === "error") {
    if (errorFallback != null) {
      if (
        typeof errorFallback === "object" && "tag" in (errorFallback as VNode)
      ) {
        return errorFallback as VNode;
      }
      return h(Fragment, null, errorFallback as VChild);
    }
    // Fall back to placeholder on error when no error fallback
    if (placeholder != null) {
      if (typeof placeholder === "object" && "tag" in (placeholder as VNode)) {
        return placeholder as VNode;
      }
      return h(Fragment, null, placeholder as VChild);
    }
    return null;
  }

  // "loading" state — show loading indicator (wrapped in container for ref)
  if (state === "loading" && loading != null) {
    return h("div", { ref: containerRef }, loading);
  }

  // "idle" state or "loading" without loading prop — show placeholder
  if (placeholder != null) {
    return h("div", { ref: containerRef }, placeholder);
  }

  return h("div", { ref: containerRef });
}
