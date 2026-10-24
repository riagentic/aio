// `effect(fn, { rerunOnSelfWrite: true })`: an effect that changes a signal it
// read re-runs (the Preact/Solid behaviour). The default stays: such a write
// is not heard, so `log.set([...log(), x()])` cannot loop.
import { assertEquals } from "@std/assert";
import { effect, signal } from "../src/state/signal.ts";

Deno.test("default effect: its own write to a dep does not re-run it", () => {
  const n = signal(0);
  let runs = 0;
  const off = effect(() => {
    runs++;
    if (n.value < 3) n.set(n.value + 1);
  });
  assertEquals(n.peek(), 1);
  assertEquals(runs, 1);
  off();
});

Deno.test("rerunOnSelfWrite: re-runs until its own writes settle", () => {
  const n = signal(0);
  let runs = 0;
  const off = effect(() => {
    runs++;
    if (n.value < 3) n.set(n.value + 1);
  }, { rerunOnSelfWrite: true });
  assertEquals(n.peek(), 3, "clamped to 3 by its own re-runs");
  assertEquals(runs, 4);
  // Still an ordinary dependency afterwards.
  n.set(0);
  assertEquals(n.peek(), 3);
  off();
});

Deno.test("rerunOnSelfWrite: a write to a signal it did NOT read does not re-run it", () => {
  const a = signal(1);
  const b = signal(0);
  let runs = 0;
  const off = effect(() => {
    runs++;
    b.set(a.value * 2);
  }, { rerunOnSelfWrite: true });
  assertEquals([runs, b.peek()], [1, 2]);
  a.set(5);
  assertEquals([runs, b.peek()], [2, 10]);
  off();
});

Deno.test("rerunOnSelfWrite: a write that changes nothing does not re-run it", () => {
  const n = signal(7);
  let runs = 0;
  const off = effect(() => {
    runs++;
    n.set(n.value);
  }, { rerunOnSelfWrite: true });
  assertEquals(runs, 1);
  off();
});

Deno.test("rerunOnSelfWrite: also on a re-run triggered from outside", () => {
  const n = signal(10);
  let runs = 0;
  const off = effect(() => {
    runs++;
    if (n.value > 3) n.set(3);
  }, { rerunOnSelfWrite: true });
  assertEquals([n.peek(), runs], [3, 2]);
  n.set(50);
  assertEquals([n.peek(), runs], [3, 4]);
  off();
});
