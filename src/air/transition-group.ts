// <TransitionGroup> — animate list enter/exit/reorder with optional FLIP.
// Wraps keyed children. New items get enter transitions, removed items get
// exit transitions (deferred DOM removal), reordered items get FLIP animation.

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
import { _runTickTransition } from "./transition-component.ts";

// AIO-192: Track FLIP cleanup timers per element to cancel on re-animation
const _flipTimers = new WeakMap<HTMLElement, number>();

// ── Exit handler registry (shared with <Transition>) ────────────────

const _groupExitHandlers = new WeakMap<
  HTMLElement,
  (el: HTMLElement) => Promise<void>
>();

/** Look up a group exit handler. @internal */
export function _getGroupExitHandler(
  el: HTMLElement,
): ((el: HTMLElement) => Promise<void>) | undefined {
  return _groupExitHandlers.get(el);
}

// ── Types ───────────────────────────────────────────────────────────

/** Props for {@linkcode TransitionGroup}. */
export interface TransitionGroupProps {
  /** Transition function for entering items. */
  enter?: TransitionFn;
  /** Transition function for exiting items. */
  exit?: TransitionFn;
  /** Transition options. */
  options?: TransitionOptions;
  /** Enable FLIP animation for reordering. Default false. */
  flip?: boolean;
  /** FLIP transition duration in ms. Default 300. */
  flipDuration?: number;
  /** Children — must be keyed VNodes. */
  children: (VNode | string | number)[];
}

// ── Lifecycle hooks (injected by aio-renderer via transition-component) ──

let _afterRender: ((fn: () => void) => void) | null = null;
let _useRef: (<T>(initial: T) => { current: T }) | null = null;

/** Set afterRender and useRef hooks (injected by aio-renderer to avoid circular import). @internal */
export function _setGroupAfterRender(
  fn: (cb: () => void) => void,
  // deno-lint-ignore no-explicit-any
  refFn?: <T>(initial: T) => { current: T } | any,
): void {
  _afterRender = fn;
  if (refFn) _useRef = refFn;
}

// ── Component ───────────────────────────────────────────────────────

/**
 * Animate list additions, removals, and reordering.
 *
 * ```tsx
 * <TransitionGroup enter={fade} exit={fade} flip>
 *   {items.value.map(item => <div key={item.id}>{item.text}</div>)}
 * </TransitionGroup>
 * ```
 */
export function TransitionGroup(props: TransitionGroupProps): VNode {
  const { enter, exit, options = {}, flip, flipDuration = 300, children } =
    props;

  // Filter to VNode children only (skip text/number)
  const vnodeChildren = children.filter(
    (c): c is VNode => typeof c === "object" && c !== null,
  );

  // AIO-250: Read previous keys/rects from ref (captured in _afterRender of the
  // PREVIOUS render, when _dom was available). Fresh VNodes from h() have no _dom.
  const prevRef = _useRef
    ? _useRef<{
      keys: Set<string | number>;
      rects: Map<string | number, DOMRect>;
    }>({ keys: new Set(), rects: new Map() })
    : { current: { keys: new Set<string | number>(), rects: new Map() } };

  const savedExistingKeys = prevRef.current.keys;
  const savedPrevRects = prevRef.current.rects;

  // Register afterRender to handle enter animations and exit handler setup
  if (_afterRender) {
    const enterFn = enter;
    const exitFn = exit;
    const opts = options;
    const doFlip = flip;
    const flipDur = flipDuration;

    _afterRender(() => {
      // Measure BEFORE animating. `getBoundingClientRect()` includes
      // transforms, so once this pass starts writing FLIP translations every
      // later read is of a visually-offset element, not of the new layout.
      // One pass of measurements serves both the dx/dy below and the reference
      // rects saved for the next render.
      const layoutRects = new Map<string | number, DOMRect>();
      if (doFlip) {
        for (const child of vnodeChildren) {
          const d = child._dom;
          if (child.key !== undefined && d && _isHTMLElement(d)) {
            layoutRects.set(child.key, d.getBoundingClientRect());
          }
        }
      }
      for (const child of vnodeChildren) {
        const dom = child._dom;
        if (!dom || !_isHTMLElement(dom)) continue;

        // Enter animation for new items
        if (
          enterFn && child.key !== undefined &&
          !savedExistingKeys.has(child.key)
        ) {
          const result = enterFn(dom, opts);
          if (result.css) {
            const handle = _applyTransition(
              dom,
              result,
              "in",
              dom.ownerDocument,
            );
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
        }

        // Register exit handler for all items
        if (exitFn) {
          _groupExitHandlers.set(dom, (el: HTMLElement) => {
            const result = exitFn(el, opts);
            if (result.css) {
              const handle = _applyTransition(
                el,
                result,
                "out",
                el.ownerDocument,
              );
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
        }

        // FLIP animation for moved items
        if (
          doFlip && child.key !== undefined && savedPrevRects.has(child.key)
        ) {
          const oldRect = savedPrevRects.get(child.key)!;
          // The layout position measured BEFORE this pass applied any FLIP
          // transform — see the measure loop above.
          const newRect = layoutRects.get(child.key) ??
            dom.getBoundingClientRect();
          const dx = oldRect.left - newRect.left;
          const dy = oldRect.top - newRect.top;

          if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
            // AIO-192: cancel any pending FLIP cleanup before starting new animation
            const oldTimer = _flipTimers.get(dom);
            if (oldTimer !== undefined) clearTimeout(oldTimer);

            // AIO-287: preserve pre-existing transforms (scale, rotate, etc.)
            // Compose FLIP translation on top of existing transform
            const existingTransform = dom.style.transform;
            const flipTransform = `translate(${dx}px, ${dy}px)`;
            dom.style.transform = existingTransform
              ? `${existingTransform} ${flipTransform}`
              : flipTransform;
            dom.style.transition = "none";

            // Play: remove flip transform, restore original transform
            _raf(dom, () => {
              dom.style.transition = `transform ${flipDur}ms ease`;
              dom.style.transform = existingTransform || "";

              // Clean up after transition
              const cleanup = () => {
                dom.style.transition = "";
                dom.removeEventListener("transitionend", onEnd);
                // Clear the safety timer, don't just forget it. Deleting the
                // map entry alone left an armed timeout holding THIS closure:
                // a second reorder within the flip window found nothing to
                // cancel (AIO-192's guard reads the same map), and the orphan
                // then fired mid-animation, wiping the new transition and
                // dropping the new entry — every reorder after that was
                // uncancellable too.
                const t = _flipTimers.get(dom);
                if (t !== undefined) clearTimeout(t);
                _flipTimers.delete(dom);
              };
              // `transitionend` BUBBLES. Unfiltered, any transition on a
              // descendant — a button's hover colour inside a moving row —
              // ended the row's FLIP early and snapped it to its final
              // position. Only this element's own transform counts.
              const onEnd = (e: Event) => {
                const te = e as TransitionEvent;
                if (te.target !== dom) return;
                if (te.propertyName && te.propertyName !== "transform") return;
                cleanup();
              };
              dom.addEventListener("transitionend", onEnd);
              // Safety timeout — tracked per element (AIO-192)
              _flipTimers.set(
                dom,
                setTimeout(cleanup, flipDur + 50) as unknown as number,
              );
            });
          }
        }
      }

      // AIO-250: keys + rects for the NEXT render cycle.
      //
      // The rects are the ones measured BEFORE this pass applied its FLIP
      // transforms (`layoutRects`). They used to be re-measured here, after —
      // and `getBoundingClientRect()` includes transforms, so a moved element
      // recorded its pre-move visual position instead of its new layout
      // position. Every reorder after the first then animated from a stale
      // origin: the item visibly jumped back to where it had been two renders
      // ago before sliding to the new slot.
      const nextKeys = new Set<string | number>();
      const nextRects = new Map<string | number, DOMRect>();
      for (const child of vnodeChildren) {
        if (child.key !== undefined && child._dom) {
          nextKeys.add(child.key);
          const r = layoutRects.get(child.key);
          if (doFlip && r) nextRects.set(child.key, r);
        }
      }
      prevRef.current = { keys: nextKeys, rects: nextRects };
    });
  }

  // Return children wrapped in a fragment-like structure
  // The children are passed through directly — the keyed reconciler handles reordering
  return h("span", { style: "display:contents" }, ...vnodeChildren);
}
