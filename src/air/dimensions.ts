import { signal } from "../state/signal.ts";
import type { Signal } from "../state/signal.ts";
import { afterRender, onCleanup, onMount, useRef } from "./aio-renderer.ts";

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

  // The observed element can be REPLACED across re-renders (a conditional
  // branch, a keyed swap): the ref then points at a new node while the
  // observer still watched the old, detached one — so dimensions silently
  // stopped updating, with no disclaimer saying the ref had to be stable
  //. Observation follows the ref: measure on mount, then re-check after
  // every render and re-observe when the element actually changed.
  const observed = useRef<HTMLElement | null>(null);
  const obs = useRef<ResizeObserver | null>(null);

  const measure = (el: HTMLElement) => {
    // contentRect-equivalent, for consistency with ResizeObserver
    const cs = el.ownerDocument?.defaultView?.getComputedStyle(el);
    const pl = parseFloat(cs?.paddingLeft ?? "0");
    const pr = parseFloat(cs?.paddingRight ?? "0");
    const pt = parseFloat(cs?.paddingTop ?? "0");
    const pb = parseFloat(cs?.paddingBottom ?? "0");
    w.set(el.clientWidth - pl - pr);
    h.set(el.clientHeight - pt - pb);
  };

  const sync = () => {
    const el = elRef.current;
    if (el === observed.current) return; // same element — nothing to do
    if (typeof ResizeObserver === "undefined") return;
    if (obs.current && observed.current) {
      obs.current.unobserve(observed.current);
    }
    observed.current = el;
    if (!el) return;
    measure(el);
    if (!obs.current) {
      obs.current = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const cr = entry.contentRect;
          w.set(cr.width);
          h.set(cr.height);
        }
      });
    }
    obs.current.observe(el);
  };

  afterRender(sync); // covers element swaps on this render

  onMount(() => {
    sync();
    onCleanup(() => {
      obs.current?.disconnect();
      obs.current = null;
      observed.current = null;
    });
  });

  return { ref: elRef, width: w, height: h };
}
