import { signal } from "./signal.ts";
import type { Signal } from "./signal.ts";
import { onCleanup, onMount, useRef } from "./aio-renderer.ts";

/** Return type of useDimensions(). */
export interface DimensionsState {
  /** Attach this ref to the element you want to measure. */
  ref: { current: HTMLElement | null };
  /** Reactive width signal (px). */
  width: Signal<number>;
  /** Reactive height signal (px). */
  height: Signal<number>;
}

/**
 * Track an element's dimensions reactively via ResizeObserver.
 * Must be called inside a component function body during render.
 */
export function useDimensions(): DimensionsState {
  const elRef = useRef<HTMLElement | null>(null);
  const width = useRef<Signal<number> | null>(null);
  const height = useRef<Signal<number> | null>(null);

  // Create signals once (first render)
  if (!width.current) width.current = signal(0);
  if (!height.current) height.current = signal(0);

  const w = width.current;
  const h = height.current;

  onMount(() => {
    const el = elRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    // Read initial dimensions (contentRect-equivalent for consistency with ResizeObserver)
    const cs = el.ownerDocument?.defaultView?.getComputedStyle(el);
    const pl = parseFloat(cs?.paddingLeft ?? "0");
    const pr = parseFloat(cs?.paddingRight ?? "0");
    const pt = parseFloat(cs?.paddingTop ?? "0");
    const pb = parseFloat(cs?.paddingBottom ?? "0");
    w.set(el.clientWidth - pl - pr);
    h.set(el.clientHeight - pt - pb);

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cr = entry.contentRect;
        w.set(cr.width);
        h.set(cr.height);
      }
    });

    ro.observe(el);

    onCleanup(() => {
      ro.disconnect();
    });
  });

  return { ref: elRef, width: w, height: h };
}
