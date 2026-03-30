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

/** Check if a node is an HTMLElement (Deno/happy-dom compat). @internal */
export function _isHTMLElement(node: Node): node is HTMLElement {
  const HtmlEl = node.ownerDocument?.defaultView?.HTMLElement ??
    globalThis.HTMLElement;
  return HtmlEl ? node instanceof HtmlEl : false;
}
