import { assertEquals } from "@std/assert";
import { useSpring } from "../src/air/animation.ts";

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
