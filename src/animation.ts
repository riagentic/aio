// AIO Animation Hooks — useTransition, useSpring for CSS animation orchestration.
// Signal-based, works with the AIO renderer's tracking system.

import { type Signal, signal } from "./signal.ts";

// ── Types ───────────────────────────────────────────────────────────

export interface TransitionState {
  /** Current stage: "enter" | "active" | "exit" | "idle". */
  readonly stage: "enter" | "active" | "exit" | "idle";
  /** Whether the element should be in the DOM. */
  readonly mounted: boolean;
  /** CSS class string for the current stage. */
  readonly className: string;
  /** Trigger enter transition. */
  enter(): void;
  /** Trigger exit transition. */
  exit(): void;
  /** Toggle between enter and exit. */
  toggle(): void;
}

export interface SpringValue {
  /** Current animated value (signal-tracked). */
  readonly value: number;
  /** Whether animation is in progress. */
  readonly animating: boolean;
  /** Animate to target value. */
  to(target: number): void;
  /** Immediately set value (no animation). */
  set(value: number): void;
}

export interface TransitionConfig {
  /** Base CSS class name (e.g., "fade"). Produces "fade-enter", "fade-active", "fade-exit". */
  name: string;
  /** Duration in ms. Default 300. */
  duration?: number;
  /** Whether to start entered. Default false. */
  initial?: boolean;
}

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

// ── useTransition ───────────────────────────────────────────────────

/** @deprecated Use `<Transition>` component with transition functions (fade, slide, scale) instead. */
export function useTransition(config: TransitionConfig): TransitionState {
  const duration = config.duration ?? 300;
  const stageSig: Signal<"enter" | "active" | "exit" | "idle"> = signal<
    "enter" | "active" | "exit" | "idle"
  >(
    config.initial ? "active" : "idle",
  );
  const mountedSig: Signal<boolean> = signal(!!config.initial);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return {
    get stage() {
      return stageSig.value;
    },
    get mounted() {
      return mountedSig.value;
    },
    get className() {
      const s = stageSig.value;
      if (s === "idle") return "";
      return `${config.name}-${s}`;
    },
    enter() {
      clear();
      mountedSig.set(true);
      stageSig.set("enter");
      // Transition to active after a frame (allows browser to apply enter styles)
      timer = setTimeout(() => stageSig.set("active"), 16);
    },
    exit() {
      clear();
      stageSig.set("exit");
      timer = setTimeout(() => {
        mountedSig.set(false);
        stageSig.set("idle");
      }, duration);
    },
    toggle() {
      const s = stageSig.peek();
      if (s === "idle" || s === "exit") this.enter();
      else this.exit();
    },
  };
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
  };
}
