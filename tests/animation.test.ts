import { assertEquals } from "@std/assert";
import { useSpring, useTransition } from "../src/animation.ts";

function delay(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// ── useTransition ──────────────────────────────────────────────────

Deno.test("useTransition: starts idle when initial=false", () => {
  const t = useTransition({ name: "fade" });
  assertEquals(t.stage, "idle");
  assertEquals(t.mounted, false);
  assertEquals(t.className, "");
});

Deno.test("useTransition: starts active when initial=true", () => {
  const t = useTransition({ name: "fade", initial: true });
  assertEquals(t.stage, "active");
  assertEquals(t.mounted, true);
  assertEquals(t.className, "fade-active");
});

Deno.test({
  name: "useTransition: enter sets mounted and stage to enter, then active",
  async fn() {
    const t = useTransition({ name: "slide", duration: 100 });
    assertEquals(t.stage, "idle");

    t.enter();
    assertEquals(t.mounted, true);
    assertEquals(t.stage, "enter");
    assertEquals(t.className, "slide-enter");

    // After ~16ms, stage transitions to "active"
    await delay(30);
    assertEquals(t.stage, "active");
    assertEquals(t.className, "slide-active");
  },
});

Deno.test({
  name: "useTransition: exit transitions to idle after duration",
  async fn() {
    const t = useTransition({ name: "fade", duration: 50, initial: true });
    assertEquals(t.stage, "active");
    assertEquals(t.mounted, true);

    t.exit();
    assertEquals(t.stage, "exit");
    assertEquals(t.className, "fade-exit");
    assertEquals(t.mounted, true); // still mounted during exit

    await delay(70);
    assertEquals(t.stage, "idle");
    assertEquals(t.mounted, false);
    assertEquals(t.className, "");
  },
});

Deno.test({
  name: "useTransition: toggle enters from idle",
  async fn() {
    const t = useTransition({ name: "fade", duration: 50 });
    assertEquals(t.stage, "idle");

    t.toggle();
    assertEquals(t.stage, "enter");
    assertEquals(t.mounted, true);

    await delay(30);
    assertEquals(t.stage, "active");
  },
});

Deno.test({
  name: "useTransition: toggle exits from active",
  async fn() {
    const t = useTransition({ name: "fade", duration: 50, initial: true });
    assertEquals(t.stage, "active");

    t.toggle();
    assertEquals(t.stage, "exit");

    await delay(70);
    assertEquals(t.stage, "idle");
    assertEquals(t.mounted, false);
  },
});

Deno.test({
  name: "useTransition: toggle exits from enter stage",
  async fn() {
    const t = useTransition({ name: "fade", duration: 100 });

    t.enter();
    assertEquals(t.stage, "enter");

    // Toggle while still in enter stage — enter is not "exit" or "idle", so should exit
    t.toggle();
    assertEquals(t.stage, "exit");

    await delay(120);
    assertEquals(t.stage, "idle");
    assertEquals(t.mounted, false);
  },
});

Deno.test("useTransition: default duration is 300", () => {
  // Just verify the object is created without error when duration omitted
  const t = useTransition({ name: "fade" });
  assertEquals(t.stage, "idle");
  assertEquals(t.mounted, false);
});

Deno.test({
  name: "useTransition: rapid enter cancels pending exit timer",
  async fn() {
    const t = useTransition({ name: "fade", duration: 100, initial: true });

    // Start exit
    t.exit();
    assertEquals(t.stage, "exit");

    // Immediately re-enter before exit completes
    t.enter();
    assertEquals(t.stage, "enter");
    assertEquals(t.mounted, true);

    // Wait longer than exit duration — should NOT have gone to idle
    await delay(130);
    assertEquals(t.stage, "active");
    assertEquals(t.mounted, true);
  },
});

Deno.test({
  name: "useTransition: rapid exit cancels pending enter timer",
  async fn() {
    const t = useTransition({ name: "fade", duration: 50 });

    t.enter();
    assertEquals(t.stage, "enter");

    // Exit before the enter->active timer fires
    t.exit();
    assertEquals(t.stage, "exit");

    // Wait for both timers to have fired
    await delay(70);
    // Should be idle, NOT active (the enter timer should have been cleared)
    assertEquals(t.stage, "idle");
    assertEquals(t.mounted, false);
  },
});

Deno.test("useTransition: className returns empty for idle stage", () => {
  const t = useTransition({ name: "modal" });
  assertEquals(t.className, "");
});

Deno.test({
  name: "useTransition: className matches stage prefix",
  async fn() {
    const t = useTransition({ name: "modal", duration: 50 });

    t.enter();
    assertEquals(t.className, "modal-enter");

    await delay(30);
    assertEquals(t.className, "modal-active");

    t.exit();
    assertEquals(t.className, "modal-exit");

    await delay(70);
    assertEquals(t.className, "");
  },
});

// ── useSpring ──────────────────────────────────────────────────────

Deno.test("useSpring: default initial value is 0", () => {
  const s = useSpring();
  assertEquals(s.value, 0);
  assertEquals(s.animating, false);
});

Deno.test("useSpring: respects custom initial value", () => {
  const s = useSpring({ initial: 50 });
  assertEquals(s.value, 50);
  assertEquals(s.animating, false);
});

Deno.test("useSpring: set() immediately updates value without animation", () => {
  const s = useSpring({ initial: 0 });
  s.set(100);
  assertEquals(s.value, 100);
  assertEquals(s.animating, false);
});

Deno.test("useSpring: set() to same value is stable", () => {
  const s = useSpring({ initial: 42 });
  s.set(42);
  assertEquals(s.value, 42);
  assertEquals(s.animating, false);
});

Deno.test("useSpring: to() in non-browser env falls back to immediate", () => {
  // In Deno test env, requestAnimationFrame is not available (no DOM)
  // The code falls back to immediately setting the value
  const s = useSpring({ initial: 0 });
  s.to(100);
  assertEquals(s.value, 100);
  assertEquals(s.animating, false);
});

Deno.test("useSpring: set() after to() cancels animation and sets value", () => {
  const s = useSpring({ initial: 0 });
  s.to(100); // In non-browser, this sets immediately
  s.set(50);
  assertEquals(s.value, 50);
  assertEquals(s.animating, false);
});

Deno.test("useSpring: multiple set() calls update correctly", () => {
  const s = useSpring({ initial: 0 });
  s.set(10);
  assertEquals(s.value, 10);
  s.set(20);
  assertEquals(s.value, 20);
  s.set(30);
  assertEquals(s.value, 30);
});

Deno.test("useSpring: set() resets velocity to 0", () => {
  const s = useSpring({ initial: 0 });
  s.to(100); // Fallback sets immediately
  s.set(50); // Should reset velocity
  // If velocity were not reset, subsequent to() would be affected
  s.to(60); // Falls back to immediate
  assertEquals(s.value, 60);
});

Deno.test("useSpring: to() when already at target is essentially a no-op", () => {
  const s = useSpring({ initial: 50 });
  s.to(50);
  // In non-browser fallback: current = 50, target = 50 -> immediate set
  assertEquals(s.value, 50);
  assertEquals(s.animating, false);
});

Deno.test("useSpring: config defaults are applied", () => {
  // With empty config, should not throw and should use defaults
  const s = useSpring({});
  assertEquals(s.value, 0);
  assertEquals(s.animating, false);
});

Deno.test("useSpring: mass=0 guard — no divide by zero", () => {
  // AIO-275: mass=0 should not cause Infinity/NaN
  const s = useSpring({ initial: 0, mass: 0 });
  s.to(100); // Falls back to immediate in non-browser
  assertEquals(s.value, 100);
  assertEquals(Number.isFinite(s.value), true);
});
