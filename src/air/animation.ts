// AIO Animation Hooks — useSpring for physics-based numeric interpolation.
// Signal-based, works with the AIO renderer's tracking system.

import { signal } from "../state/signal.ts";

// ── Types ───────────────────────────────────────────────────────────

/** Reactive spring-animated numeric value with physics-based interpolation. */
export interface SpringValue {
  /** Current animated value (signal-tracked). */
  readonly value: number;
  /** Whether animation is in progress. */
  readonly animating: boolean;
  /** Animate to target value. */
  to(target: number): void;
  /** Immediately set value (no animation). */
  set(value: number): void;
  /** Cancel animation and clean up. Call on component unmount or when the spring is no longer needed. */
  dispose(): void;
}

/** Configuration for spring physics animation — stiffness, damping, mass, and precision. */
export interface SpringConfig {
  /** Initial value. Default 0. */
  initial?: number;
  /** Stiffness (spring constant). Default 170. */
  stiffness?: number;
  /** Damping. Default 26. */
  damping?: number;
  /** Mass. Default 1. */
  mass?: number;
  /** Precision threshold. Default 0.01. */
  precision?: number;
}

// ── useSpring ───────────────────────────────────────────────────────

/**
 * Animate a numeric value with spring physics. Call outside the component body.
 *
 * ```ts
 * const x = useSpring({ initial: 0, stiffness: 200, damping: 20 });
 * x.to(100); // animates to 100
 * // In component: h("div", { style: { transform: `translateX(${x.value}px)` } })
 * ```
 */
export function useSpring(config: SpringConfig = {}): SpringValue {
  const stiffness = config.stiffness ?? 170;
  const damping = config.damping ?? 26;
  const mass = config.mass ?? 1;
  const precision = config.precision ?? 0.01;

  const valueSig = signal(config.initial ?? 0);
  const animatingSig = signal(false);

  let current = config.initial ?? 0;
  let velocity = 0;
  let target = current;
  let rafId: number | undefined;
  let lastTime = 0;

  function step(now?: number) {
    // Compute actual dt from RAF timestamp (clamped to avoid spiral on tab-switch)
    const dt = lastTime && now
      ? Math.min((now - lastTime) / 1000, 0.064)
      : 1 / 60;
    lastTime = now ?? 0;

    // Spring physics
    const displacement = current - target;
    const springForce = -stiffness * displacement;
    const dampingForce = -damping * velocity;
    const acceleration = mass > 0 ? (springForce + dampingForce) / mass : 0; // AIO-275: guard mass=0

    velocity += acceleration * dt;
    current += velocity * dt;

    // Check convergence
    if (
      Math.abs(velocity) < precision && Math.abs(current - target) < precision
    ) {
      current = target;
      velocity = 0;
      valueSig.set(current);
      animatingSig.set(false);
      rafId = undefined;
      return;
    }

    valueSig.set(current);

    if (typeof requestAnimationFrame !== "undefined") {
      rafId = requestAnimationFrame(step as FrameRequestCallback);
    }
  }

  return {
    get value() {
      return valueSig.value;
    },
    get animating() {
      return animatingSig.value;
    },
    to(t: number) {
      target = t;
      if (!animatingSig.peek()) {
        animatingSig.set(true);
        lastTime = 0; // reset so first frame uses default dt
        if (typeof requestAnimationFrame !== "undefined") {
          rafId = requestAnimationFrame(step as FrameRequestCallback);
        } else {
          // Fallback for non-browser (immediate)
          current = t;
          velocity = 0;
          valueSig.set(t);
          animatingSig.set(false);
        }
      }
    },
    set(v: number) {
      if (rafId !== undefined && typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(rafId);
        rafId = undefined;
      }
      current = v;
      target = v;
      velocity = 0;
      valueSig.set(v);
      animatingSig.set(false);
    },
    dispose() {
      if (rafId !== undefined && typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(rafId);
        rafId = undefined;
      }
      // The frame is cancelled, so nothing will ever clear `animating` again —
      // and `to()` starts a spring only `if (!animating)`. Left true, a
      // disposed spring reported itself as forever-animating and every later
      // `to()` was a silent no-op (a spring reused after a dispose, or a UI
      // reading `.animating` to show a "settling" state, simply stopped).
      // Disposing means "not animating".
      animatingSig.set(false);
    },
  };
}
