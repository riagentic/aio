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

let warnedNoRO = false;

/**
 * Track an element's dimensions reactively via ResizeObserver.
 * Must be called inside a component function body during render.
 */
// The `let` above used to sit BETWEEN this block and the function, so the
// doc documented the flag: `useDimensions` was public and undocumented, and
// the coverage gate said so the moment it was asked.
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

  // A computed length that is missing or unparseable is ZERO, never NaN. An
  // environment that reports padding as "" (happy-dom, jsdom, a detached
  // element) turned `clientWidth - parseFloat("")` into NaN, and NaN then
  // propagates through every layout comparison as `false` — a width that is
  // neither < 600 nor >= 600.
  const px = (v: string | undefined): number => {
    const n = parseFloat(v ?? "");
    return Number.isFinite(n) ? n : 0;
  };

  const measure = (el: HTMLElement) => {
    // contentRect-equivalent, for consistency with ResizeObserver
    const cs = el.ownerDocument?.defaultView?.getComputedStyle(el);
    const box = el.clientWidth - px(cs?.paddingLeft) - px(cs?.paddingRight);
    const high = el.clientHeight - px(cs?.paddingTop) - px(cs?.paddingBottom);
    w.set(Number.isFinite(box) ? box : 0);
    h.set(Number.isFinite(high) ? high : 0);
  };

  const sync = () => {
    const el = elRef.current;
    if (el === observed.current) return; // same element — nothing to do
    if (typeof ResizeObserver === "undefined") {
      // No observer: take the one-shot measurement anyway and SAY that live
      // updates are off. Returning here left width/height at their initial 0
      // for the component's whole life, so a layout branching on
      // `width.value < 600` silently took the narrow path forever, with
      // nothing logged — including in the test harness, which is the shape
      // that manufactures a green test over a broken page.
      observed.current = el;
      if (el) measure(el);
      if (!warnedNoRO) {
        warnedNoRO = true;
        console.warn(
          "[aio:useDimensions] ResizeObserver is unavailable — measured once " +
            "at mount; width/height will NOT track later resizes.",
        );
      }
      return;
    }
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
