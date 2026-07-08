import { assertEquals } from "@std/assert";
import { computed, effect, signal } from "../src/state/signal.ts";
import { on, watch } from "../src/state/watch.ts";

Deno.test("watch: calls callback with new and old values", () => {
  const s = signal(1);
  const log: [number, number][] = [];
  const stop = watch(s, (next, prev) => {
    log.push([next, prev!]);
  });
  s.set(2);
  assertEquals(log, [[2, 1]]);
  s.set(3);
  assertEquals(log, [[2, 1], [3, 2]]);
  stop();
});

Deno.test("watch: does not fire on creation by default", () => {
  const s = signal(1);
  let called = false;
  const stop = watch(s, () => {
    called = true;
  });
  assertEquals(called, false);
  stop();
});

Deno.test("watch: fires on creation when immediate: true", () => {
  const s = signal(1);
  const log: [number, number | undefined][] = [];
  const stop = watch(s, (next, prev) => {
    log.push([next, prev]);
  }, { immediate: true });
  assertEquals(log, [[1, undefined]]);
  stop();
});

Deno.test("watch: stop prevents future calls", () => {
  const s = signal(0);
  let calls = 0;
  const stop = watch(s, () => {
    calls++;
  });
  s.set(1);
  assertEquals(calls, 1);
  stop();
  s.set(2);
  assertEquals(calls, 1);
});

Deno.test("watch: works with computed signals", () => {
  const a = signal(1);
  const doubled = computed(() => a.value * 2);
  const log: [number, number][] = [];
  const stop = watch(doubled, (next, prev) => {
    log.push([next, prev!]);
  });
  a.set(2);
  assertEquals(log, [[4, 2]]);
  stop();
});

Deno.test("on: effect only tracks explicit source", () => {
  const a = signal(0);
  const b = signal(0);
  const log: [number, number][] = [];

  const dispose = effect(on(a, (next, prev) => {
    log.push([next, prev]);
    void b.value; // read b but should NOT track it
  }));

  a.set(1);
  assertEquals(log, [[1, 0]]);

  b.set(1); // should NOT re-trigger
  assertEquals(log, [[1, 0]]);

  a.set(2);
  assertEquals(log, [[1, 0], [2, 1]]);

  dispose();
});

Deno.test("watch: immediate followed by subsequent changes", () => {
  const s = signal(10);
  const log: [number, number | undefined][] = [];
  const stop = watch(s, (next, prev) => {
    log.push([next, prev]);
  }, { immediate: true });
  assertEquals(log, [[10, undefined]]);
  s.set(20);
  assertEquals(log, [[10, undefined], [20, 10]]);
  s.set(30);
  assertEquals(log, [[10, undefined], [20, 10], [30, 20]]);
  stop();
});

Deno.test("watch: prev advances correctly through multiple changes", () => {
  const s = signal(1);
  const log: [number, number | undefined][] = [];
  const stop = watch(s, (next, prev) => {
    log.push([next, prev]);
  });
  s.set(2);
  s.set(3);
  s.set(4);
  // prev should advance through each change: 1→2→3
  assertEquals(log, [[2, 1], [3, 2], [4, 3]]);
  stop();
});

Deno.test("on: works with computed source", () => {
  const a = signal(1);
  const doubled = computed(() => a.value * 2);
  const log: [number, number][] = [];
  const dispose = effect(on(doubled, (next, prev) => {
    log.push([next, prev]);
  }));
  a.set(2);
  assertEquals(log, [[4, 2]]);
  a.set(3);
  assertEquals(log, [[4, 2], [6, 4]]);
  dispose();
});

Deno.test("on: deferred by default (skips first run)", () => {
  const s = signal(0);
  let called = false;
  const dispose = effect(on(s, () => {
    called = true;
  }));
  assertEquals(called, false); // deferred — first run skipped
  s.set(1);
  assertEquals(called, true);
  dispose();
});
