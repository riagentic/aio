// B-2 regression: an effect that reads a signal *and* a computed derived from
// another signal must observe the computed's fresh value when both signals are
// written in the same batch(). Before the eager-invalidation fix, the effect
// ran while the computed was still stale-clean and the re-queue was dropped,
// leaving the effect permanently stale. These cover the original repro plus a
// permutation matrix (write orders, chained computeds, outside-batch).
import { assertEquals } from "@std/assert";
import { batch, computed, effect, signal } from "../src/state/signal.ts";

Deno.test("B-2: effect sees fresh computed after batched writes (original repro)", () => {
  const a = signal(0);
  const b = signal(0);
  const c = computed(() => b.value * 10);
  const seen: number[] = [];
  effect(() => {
    seen.push(a.value + c.value);
  });
  batch(() => {
    a.set(1);
    b.set(1);
  });
  assertEquals(seen.at(-1), 11); // final value must reflect c's new value
  assertEquals(seen.includes(1), false); // glitch-free: no stale-c intermediate
});

Deno.test("B-2: holds for both write orders inside batch", () => {
  for (const order of ["a-first", "b-first"] as const) {
    const a = signal(0);
    const b = signal(0);
    const c = computed(() => b.value * 10);
    const seen: number[] = [];
    effect(() => {
      seen.push(a.value + c.value);
    });
    batch(() => {
      if (order === "a-first") {
        a.set(1);
        b.set(1);
      } else {
        b.set(1);
        a.set(1);
      }
    });
    assertEquals(seen.at(-1), 11, `order=${order}`);
  }
});

Deno.test("B-2: only the computed's source written in batch", () => {
  const b = signal(0);
  const c = computed(() => b.value * 10);
  const seen: number[] = [];
  effect(() => {
    seen.push(c.value);
  });
  batch(() => {
    b.set(1);
    b.set(2);
  });
  assertEquals(seen.at(-1), 20);
});

Deno.test("B-2: chained computeds invalidate transitively in one batch", () => {
  const a = signal(1);
  const b = signal(1);
  const c = computed(() => b.value * 10); // depends on b
  const d = computed(() => c.value + 1); // depends on c (chain)
  const seen: number[] = [];
  effect(() => {
    seen.push(a.value + d.value);
  });
  assertEquals(seen.at(-1), 1 + (10 + 1)); // 12
  batch(() => {
    a.set(2);
    b.set(3);
  });
  assertEquals(seen.at(-1), 2 + (30 + 1)); // 33, fresh through the whole chain
  assertEquals(seen.includes(12 + 1), false); // no half-updated intermediate
});

Deno.test("B-2: same staleness path outside batch (implicit flush)", () => {
  const a = signal(0);
  const b = signal(0);
  const c = computed(() => b.value * 10);
  const seen: number[] = [];
  effect(() => {
    seen.push(a.value + c.value);
  });
  a.set(1);
  b.set(1);
  assertEquals(seen.at(-1), 11);
});

Deno.test("B-2: effect reading two computeds off the same source", () => {
  const b = signal(1);
  const c1 = computed(() => b.value * 10);
  const c2 = computed(() => b.value * 100);
  const seen: number[] = [];
  effect(() => {
    seen.push(c1.value + c2.value);
  });
  assertEquals(seen.at(-1), 110);
  batch(() => {
    b.set(2);
  });
  assertEquals(seen.at(-1), 220); // both computeds fresh, single consistent run
});
