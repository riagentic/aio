// <Transition> — declarative enter/exit animations for a single child.
// Detects when child appears/disappears in the VDOM and applies transition functions.
// Uses deferred DOM removal (onBeforeRemove) for exit animations.

import type { VNode } from "./vdom.ts";
import { h } from "./vdom.ts";
import {
  _applyTransition,
  _isHTMLElement,
  _raf,
  _removeTransition,
  type TransitionFn,
  type TransitionOptions,
} from "./transition.ts";

// ── Exit handler registry ───────────────────────────────────────────
// When <Transition> wraps a child, it registers an exit handler keyed by DOM element.
// The renderer's onBeforeRemove hook looks up this registry to run exit animations.

const _exitHandlers = new WeakMap<
  HTMLElement,
  (el: HTMLElement) => Promise<void>
>();

/** Look up an exit handler for a DOM element. @internal */
export function _getExitHandler(
  el: HTMLElement,
): ((el: HTMLElement) => Promise<void>) | undefined {
  return _exitHandlers.get(el);
}

// ── <Transition> component ──────────────────────────────────────────

/** Props for the <Transition> component. */
export interface TransitionProps {
  /** Transition function for entering. */
  enter?: TransitionFn;
  /** Transition function for exiting. */
  exit?: TransitionFn;
  /** Transition options (duration, delay, easing) — applied to both enter and exit. */
  options?: TransitionOptions;
  /** Children — should be a single conditional child or null. */
  children: (VNode | string | number | null | undefined)[];
}

/**
 * Wrap a conditionally rendered child with enter/exit animations.
 *
 * ```tsx
 * <Transition enter={fade} exit={fade}>
 *   {show.value && <Modal />}
 * </Transition>
 * ```
 */
export function Transition(props: TransitionProps): VNode | null {
  const child = props.children.find((c) => c != null) ?? null;
  if (child == null || typeof child !== "object") {
    return child as VNode | null;
  }

  // Wrap child with _TransitionChild to inject animation behavior
  return h(_TransitionChild, {
    enter: props.enter,
    exit: props.exit,
    options: props.options ?? {},
    child,
  });
}

// ── Internal wrapper component ──────────────────────────────────────
// This component renders the child and registers enter/exit handlers.

// Lifecycle hooks injected by aio-renderer (avoids circular import)
let _onMount: ((fn: () => void) => void) | null = null;
let _onCleanup: ((fn: () => void) => void) | null = null;
let _afterRender: ((fn: () => void) => void) | null = null;

/** Lazily resolve lifecycle hooks from aio-renderer. @internal */
export async function _initLifecycleHooks(): Promise<void> {
  if (_onMount) return;
  const mod = await import("./aio-renderer.ts");
  _onMount = mod.onMount;
  _onCleanup = mod.onCleanup;
  _afterRender = mod.afterRender;
}

/** Synchronously set lifecycle hooks (for eager init or testing). @internal */
export function _setLifecycleHooks(
  onMount: (fn: () => void) => void,
  onCleanup: (fn: () => void) => void,
  afterRender: (fn: () => void) => void,
): void {
  _onMount = onMount;
  _onCleanup = onCleanup;
  _afterRender = afterRender;
}

interface _TransitionChildProps {
  enter?: TransitionFn;
  exit?: TransitionFn;
  options: TransitionOptions;
  child: VNode;
}

// Elements whose enter animation has already played.
//
// `_TransitionChild` re-executes on every parent re-render (its `child` prop is
// a fresh VNode each time, so auto-memo cannot skip it) and re-registered the
// enter callback each time — re-injecting the keyframes and re-assigning
// `el.style.animation`. The element visibly re-animated on every unrelated
// signal change. Keyed by the DOM node, so a genuinely new element (a
// keyed swap) still animates in.
const _entered = new WeakSet<HTMLElement>();

function _TransitionChild(props: _TransitionChildProps): VNode {
  const { enter, exit, options, child } = props;

  // Register enter animation — runs after the FIRST mount of this element
  if (_afterRender && enter) {
    _afterRender(() => {
      const dom = child._dom;
      if (!dom || !_isHTMLElement(dom)) return;
      if (_entered.has(dom)) return; // already animated in — not again
      _entered.add(dom);

      const result = enter(dom, options);
      if (result.css) {
        const handle = _applyTransition(dom, result, "in", dom.ownerDocument);
        setTimeout(
          () => _removeTransition(handle),
          result.duration + (result.delay ?? 0),
        );
      } else if (result.tick) {
        _runTickTransition(dom, {
          duration: result.duration,
          tick: result.tick,
        }, "in");
      }
    });
  }

  // Register exit handler on the DOM element (checked by onBeforeRemove)
  if (_afterRender && exit) {
    _afterRender(() => {
      const dom = child._dom;
      if (!dom || !_isHTMLElement(dom)) return;

      _exitHandlers.set(dom, (el: HTMLElement) => {
        const result = exit(el, options);
        if (result.css) {
          const handle = _applyTransition(el, result, "out", el.ownerDocument);
          return new Promise<void>((resolve) => {
            setTimeout(() => {
              _removeTransition(handle);
              resolve();
            }, result.duration + (result.delay ?? 0));
          });
        }
        if (result.tick) {
          return _runTickTransition(el, {
            duration: result.duration,
            tick: result.tick,
          }, "out");
        }
        return Promise.resolve();
      });
    });
  }

  // Note: we intentionally do NOT clean up exit handlers on unmount.
  // The handler must survive component teardown to run during deferred DOM removal.
  // WeakMap ensures no memory leak — the handler is GC'd when the element is.

  return child;
}

/** Run a JS tick-based transition. Supports cancellation via destroyed guard (AIO-145). @internal */
export function _runTickTransition(
  _el: HTMLElement,
  result: { duration: number; tick: (t: number, u: number) => void },
  direction: "in" | "out" = "out",
): Promise<void> {
  let cancelled = false;
  const promise = new Promise<void>((resolve) => {
    const start = performance.now();
    const duration = result.duration;

    function frame() {
      // AIO-194: check both cancelled flag AND element connectivity
      // to prevent rAF leak when element is removed mid-animation
      if (cancelled || !_el.isConnected) {
        resolve();
        return;
      }
      const elapsed = performance.now() - start;
      const progress = Math.min(elapsed / duration, 1);
      // enter: t 0→1, exit: t 1→0
      const t = direction === "in" ? progress : 1 - progress;
      try {
        result.tick(t, 1 - t);
      } catch {
        resolve();
        return;
      }
      if (progress < 1) {
        _raf(_el, frame);
      } else {
        resolve();
      }
    }
    // This element's own window — a bare global rAF is absent outside a
    // browser tab and threw the whole tick transition away (see _raf).
    _raf(_el, frame);
  });
  // Attach cancel for external cleanup (element removed mid-transition)
  (promise as unknown as { _cancel: () => void })._cancel = () => {
    cancelled = true;
  };
  return promise;
}
