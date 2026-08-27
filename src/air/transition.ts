// Transition functions — CSS-first animation primitives.
// Each function receives a DOM element and options, returns a TransitionResult
// describing how to animate. The `css` callback generates keyframe strings;
// `tick` is the JS fallback for effects CSS can't express.

/** Result returned by a transition function. */
export interface TransitionResult {
  /** Duration in ms. */
  duration: number;
  /** Optional delay in ms before the transition starts. */
  delay?: number;
  /** Optional easing (CSS easing string). Default "ease". */
  easing?: string;
  /** CSS keyframe generator. `t` goes 0→1 on enter, 1→0 on exit.
   *  Return a CSS string (e.g., `opacity: ${t}; transform: scale(${t})`). */
  css?: (t: number, u: number) => string;
  /** JS per-frame callback (fallback when CSS can't express the effect).
   *  `t` goes 0→1 on enter, 1→0 on exit. */
  tick?: (t: number, u: number) => void;
}

/** Options passed to transition functions. */
export interface TransitionOptions {
  duration?: number;
  delay?: number;
  easing?: string;
}

/** A transition function signature. */
export type TransitionFn = (
  node: HTMLElement,
  opts: TransitionOptions,
) => TransitionResult;

// ── Built-in presets ────────────────────────────────────────────────

/** Fade opacity 0↔1. */
export const fade: TransitionFn = (_node, opts) => ({
  duration: opts.duration ?? 300,
  delay: opts.delay,
  easing: opts.easing,
  css: (t) => `opacity: ${t}`,
});

/** Slide vertically via translateY. */
export const slide: TransitionFn = (_node, opts) => ({
  duration: opts.duration ?? 300,
  delay: opts.delay,
  easing: opts.easing,
  css: (t) => `transform: translateY(${(1 - t) * 100}%); opacity: ${t}`,
});

/** Scale from 0 to 1. */
export const scale: TransitionFn = (_node, opts) => ({
  duration: opts.duration ?? 300,
  delay: opts.delay,
  easing: opts.easing,
  css: (t) => `transform: scale(${t}); opacity: ${t}`,
});

// ── Keyframe generation ─────────────────────────────────────────────

let _counter = 0;
const KEYFRAME_STEPS = 20;

/** Generate a unique @keyframes rule from a css() function.
 *  @internal */
export function _generateKeyframes(
  cssFn: (t: number, u: number) => string,
  steps = KEYFRAME_STEPS,
): { name: string; rule: string } {
  const name = `__aio_t_${++_counter}`;
  const frames: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const pct = (t * 100).toFixed(1);
    frames.push(`${pct}% { ${cssFn(t, 1 - t)} }`);
  }
  return { name, rule: `@keyframes ${name} { ${frames.join(" ")} }` };
}

/** Active transition handle for cleanup. */
export interface TransitionHandle {
  name: string;
  styleEl: HTMLStyleElement;
  el: HTMLElement;
  prevAnimation: string;
}

/** Apply a CSS transition to an element.
 *  @param direction "in" = t goes 0→1, "out" = t goes 1→0
 *  @internal */
export function _applyTransition(
  el: HTMLElement,
  result: TransitionResult,
  direction: "in" | "out",
  doc: Document,
): TransitionHandle {
  const cssFn = result.css!;
  const fn = direction === "in"
    ? cssFn
    : (t: number, u: number) => cssFn(1 - t, 1 - u);
  const { name, rule } = _generateKeyframes(fn);
  const styleEl = doc.createElement("style") as unknown as HTMLStyleElement;
  styleEl.textContent = rule;
  doc.head.appendChild(styleEl);

  const prevAnimation = el.style.animation;
  const easing = result.easing ?? "ease";
  const delay = result.delay ?? 0;
  el.style.animation = `${name} ${result.duration}ms ${easing} ${delay}ms both`;

  return { name, styleEl, el, prevAnimation };
}

/** Remove a CSS transition and clean up injected styles.
 *  @internal */
export function _removeTransition(handle: TransitionHandle): void {
  handle.el.style.animation = handle.prevAnimation;
  handle.styleEl.remove();
}

// ── In-flight enter animations ──────────────────────────────────────
//
// ONE decider for "this element is animating IN", shared by <Transition> and
// <TransitionGroup>. They each had their own copy and the copies disagreed:
//
//  * <TransitionGroup> armed an UNTRACKED `setTimeout(() => _removeTransition)`.
//    An item that entered and left within the enter duration had that orphan
//    fire mid-exit, restoring `style.animation` and WIPING the exit animation
//    in flight.
//  * <Transition> tracked the timer and CLEARED it on exit — which fixed the
//    wipe and created a leak: the cleared timer was the only thing that would
//    ever have removed the injected `<style>`. Measured 1 → 5 `<style>` nodes
//    in `<head>` over 5 toggles, unbounded for any toggled modal or toast.
//
// Both are the same question — "leaving cancels arriving" — so both call these.

const _enterCleanups = new WeakMap<HTMLElement, {
  timer: ReturnType<typeof setTimeout>;
  handle: TransitionHandle;
}>();

/** Arm the cleanup of an enter animation on `el`, `ms` from now. Replaces any
 *  enter already in flight on the same element. @internal */
export function _trackEnter(
  el: HTMLElement,
  handle: TransitionHandle,
  ms: number,
): void {
  _cancelEnter(el);
  const timer = setTimeout(() => {
    _enterCleanups.delete(el);
    _removeTransition(handle);
  }, ms);
  _enterCleanups.set(el, { timer, handle });
}

/** End an in-flight enter animation NOW — clears its pending cleanup AND
 *  removes the keyframes it injected, so neither the timer nor the `<style>`
 *  outlives the element's arrival. @internal */
export function _cancelEnter(el: HTMLElement): void {
  const pending = _enterCleanups.get(el);
  if (!pending) return;
  clearTimeout(pending.timer);
  _enterCleanups.delete(el);
  _removeTransition(pending.handle);
}

/** Check if a node is an HTMLElement (Deno/happy-dom compat). @internal */
export function _isHTMLElement(node: Node): node is HTMLElement {
  const HtmlEl = node.ownerDocument?.defaultView?.HTMLElement ??
    globalThis.HTMLElement;
  return HtmlEl ? node instanceof HtmlEl : false;
}

/** Schedule a paint-adjacent callback for THIS node's window.
 *
 *  A bare `requestAnimationFrame` is a global that a render document does not
 *  have to provide: outside a browser tab (a test document, an embedder, an
 *  Electron preload context) the call THREW from inside an afterRender
 *  callback, and the renderer's contained-failure guard then swallowed it —
 *  killing the rest of that pass, so the items after the first one silently
 *  got no animation at all. Same function in a real browser (it is that
 *  window's own rAF); a timer everywhere else, so the callback still runs.
 *  @internal */
export function _raf(node: Node, cb: () => void): void {
  const view = node.ownerDocument?.defaultView as
    | { requestAnimationFrame?: (cb: FrameRequestCallback) => number }
    | null
    | undefined;
  const raf = view?.requestAnimationFrame ??
    (typeof requestAnimationFrame !== "undefined"
      ? requestAnimationFrame
      : undefined);
  if (raf) raf.call(view ?? globalThis, () => cb());
  else setTimeout(cb, 16);
}
