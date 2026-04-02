import { assertEquals } from "@std/assert";
import {
  _trackEnd,
  _trackStart,
  batch,
  type Computed,
  computed,
  effect,
  type Signal,
  signal,
  untrack,
} from "../src/signal.ts";

Deno.test("signal: read and write", () => {
  const s = signal(0);
  assertEquals(s.value, 0);
  s.set(1);
  assertEquals(s.value, 1);
});

Deno.test("signal: peek reads without tracking", () => {
  const s = signal(42);
  const deps = _trackStart();
  const v = s.peek();
  const tracked = _trackEnd(deps);
  assertEquals(v, 42);
  assertEquals(tracked.size, 0);
});

Deno.test("signal: set with same value is no-op", () => {
  const s = signal(5);
  let calls = 0;
  effect(() => {
    s.value;
    calls++;
  });
  assertEquals(calls, 1);
  s.set(5);
  assertEquals(calls, 1);
});

Deno.test("signal: tracks reads in tracking context", () => {
  const a = signal(1);
  const b = signal(2);
  const deps = _trackStart();
  void a.value;
  void b.value;
  const tracked = _trackEnd(deps);
  assertEquals(tracked.size, 2);
});

Deno.test("computed: derives from signals", () => {
  const a = signal(2);
  const b = signal(3);
  const sum = computed(() => a.value + b.value);
  assertEquals(sum.value, 5);
});

Deno.test("computed: recomputes when source changes", () => {
  const a = signal(1);
  const double = computed(() => a.value * 2);
  assertEquals(double.value, 2);
  a.set(5);
  assertEquals(double.value, 10);
});

Deno.test("computed: lazy — doesn't compute until read", () => {
  let runs = 0;
  const a = signal(1);
  const c = computed(() => {
    runs++;
    return a.value;
  });
  assertEquals(runs, 0);
  void c.value;
  assertEquals(runs, 1);
});

Deno.test("computed: caches when deps unchanged", () => {
  let runs = 0;
  const a = signal(1);
  const c = computed(() => {
    runs++;
    return a.value;
  });
  void c.value;
  void c.value;
  assertEquals(runs, 1);
});

Deno.test("computed: diamond dependency", () => {
  const a = signal(1);
  const b = computed(() => a.value + 1);
  const c = computed(() => a.value + 2);
  const d = computed(() => b.value + c.value);
  assertEquals(d.value, 5);
  a.set(2);
  assertEquals(d.value, 7);
});

Deno.test("computed: peek reads without tracking", () => {
  const a = signal(10);
  const c = computed(() => a.value * 2);
  const deps = _trackStart();
  const v = c.peek();
  const tracked = _trackEnd(deps);
  assertEquals(v, 20);
  assertEquals(tracked.size, 0);
});

Deno.test("effect: runs immediately", () => {
  const a = signal(0);
  let seen = -1;
  effect(() => {
    seen = a.value;
  });
  assertEquals(seen, 0);
});

Deno.test("effect: re-runs on signal change", () => {
  const a = signal(0);
  const log: number[] = [];
  effect(() => {
    log.push(a.value);
  });
  assertEquals(log, [0]);
  a.set(1);
  assertEquals(log, [0, 1]);
  a.set(2);
  assertEquals(log, [0, 1, 2]);
});

Deno.test("effect: cleanup called before re-run", () => {
  const a = signal(0);
  const log: string[] = [];
  effect(() => {
    log.push(`run:${a.value}`);
    return () => {
      // After AIO-50 (implicit batching), cleanup sees the NEW value because
      // set() updates value before _flush() runs prepare. This is correct —
      // cleanup should tear down based on current state, not stale state.
      log.push(`cleanup:${a.value}`);
    };
  });
  assertEquals(log, ["run:0"]);
  a.set(1);
  assertEquals(log, ["run:0", "cleanup:1", "run:1"]);
});

Deno.test("effect: dispose stops tracking", () => {
  const a = signal(0);
  let calls = 0;
  const dispose = effect(() => {
    a.value;
    calls++;
  });
  assertEquals(calls, 1);
  dispose();
  a.set(1);
  assertEquals(calls, 1);
});

Deno.test("effect: dynamic dependency tracking", () => {
  const cond = signal(true);
  const a = signal("A");
  const b = signal("B");
  const log: string[] = [];
  effect(() => {
    log.push(cond.value ? a.value : b.value);
  });
  assertEquals(log, ["A"]);
  b.set("B2");
  assertEquals(log, ["A"]);
  cond.set(false);
  assertEquals(log, ["A", "B2"]);
  a.set("A2");
  assertEquals(log, ["A", "B2"]);
  b.set("B3");
  assertEquals(log, ["A", "B2", "B3"]);
});

Deno.test("signal: subscribe fires on change", () => {
  const s = signal(0);
  const calls: number[] = [];
  const unsub = s.subscribe(() => calls.push(s.peek()));
  assertEquals(calls, []); // does NOT fire immediately (unlike effect)
  s.set(1);
  assertEquals(calls, [1]);
  s.set(2);
  assertEquals(calls, [1, 2]);
  s.set(2); // no-op, same value
  assertEquals(calls, [1, 2]);
  unsub();
  s.set(3);
  assertEquals(calls, [1, 2]); // unsubscribed
});

Deno.test("signal: subscribe works with batch", () => {
  const a = signal(0);
  const b = signal(0);
  let callCount = 0;
  const unsub1 = a.subscribe(() => callCount++);
  const unsub2 = b.subscribe(() => callCount++);
  batch(() => {
    a.set(1);
    b.set(1);
  });
  assertEquals(callCount, 2); // both fire once after batch
  unsub1();
  unsub2();
});

Deno.test("batch: coalesces notifications", () => {
  const a = signal(0);
  const b = signal(0);
  let calls = 0;
  effect(() => {
    a.value;
    b.value;
    calls++;
  });
  assertEquals(calls, 1);
  batch(() => {
    a.set(1);
    b.set(2);
  });
  assertEquals(calls, 2);
});

// ── Cycle detection ─────────────────────────────────────────────────

import { assertThrows } from "@std/assert";

Deno.test("computed: circular dependency throws instead of stack overflow", () => {
  // deno-lint-ignore no-explicit-any
  let b: any;
  const a = computed(() => (b as Computed<number>).value + 1);
  b = computed(() => a.value + 1);
  assertThrows(
    () => a.value,
    Error,
    "Circular dependency",
  );
});

// ── Flush max-iteration guard ────────────────��────────────────────

Deno.test("signal: _flush stops after max iterations (no infinite loop)", () => {
  // Two signals that ping-pong: a triggers effect that sets b, b triggers
  // effect that sets a. Both effects are subscribed before the trigger.
  const a = signal(0);
  const b = signal(0);
  let count = 0;
  const disposeA = effect(() => {
    const v = a.value;
    if (v > 0 && count < 2000) {
      count++;
      b.set(v + 1);
    }
  });
  const disposeB = effect(() => {
    const v = b.value;
    if (v > 0 && count < 2000) {
      count++;
      a.set(v + 1);
    }
  });
  count = 0;
  // Kick off the ping-pong from outside both effects
  a.set(1);
  // The guard caps at 1000 flush iterations. count should be bounded.
  assertEquals(count > 1, true);
  assertEquals(count < 1500, true); // AIO-288: updated for 1000 limit (was < 200)
  disposeA();
  disposeB();
});

// ── AIO-59: Shallow equality for objects/arrays ────────────────────

Deno.test("signal: set with shallow-equal object is no-op", () => {
  const s = signal({ a: 1, b: "hello" });
  let calls = 0;
  effect(() => {
    s.value;
    calls++;
  });
  assertEquals(calls, 1);
  // New object reference, same values — should NOT trigger
  s.set({ a: 1, b: "hello" });
  assertEquals(calls, 1);
  // Different value — SHOULD trigger
  s.set({ a: 2, b: "hello" });
  assertEquals(calls, 2);
});

Deno.test("signal: set with shallow-equal array is no-op", () => {
  const s = signal([1, 2, 3]);
  let calls = 0;
  effect(() => {
    s.value;
    calls++;
  });
  assertEquals(calls, 1);
  s.set([1, 2, 3]);
  assertEquals(calls, 1);
  s.set([1, 2, 4]);
  assertEquals(calls, 2);
});

Deno.test("signal: shallow equality does not deep-compare nested objects", () => {
  const inner = { x: 1 };
  const s = signal({ nested: inner });
  let calls = 0;
  effect(() => {
    s.value;
    calls++;
  });
  assertEquals(calls, 1);
  // Same nested reference — no-op
  s.set({ nested: inner });
  assertEquals(calls, 1);
  // Different nested reference (even if deep-equal) — SHOULD trigger
  s.set({ nested: { x: 1 } });
  assertEquals(calls, 2);
});

Deno.test("signal: set with different key count triggers update", () => {
  const s = signal<Record<string, number>>({ a: 1 });
  let calls = 0;
  effect(() => {
    s.value;
    calls++;
  });
  assertEquals(calls, 1);
  s.set({ a: 1, b: 2 });
  assertEquals(calls, 2);
});

Deno.test("signal: rAF-style repeated set with same values is no-op", () => {
  // Simulates the AIO-59 infinite loop scenario:
  // rAF callback sets signal with {matchCount: 0, currentMatch: -1} every frame
  const s = signal({ matchCount: 0, currentMatch: -1 });
  let renderCount = 0;
  effect(() => {
    s.value;
    renderCount++;
  });
  assertEquals(renderCount, 1);
  // Simulate 10 rAF callbacks all setting the same values
  for (let i = 0; i < 10; i++) {
    s.set({ matchCount: 0, currentMatch: -1 });
  }
  assertEquals(renderCount, 1); // no re-renders
});

// ── Updater function on signal.update() ──────────────────────────────

Deno.test("signal: update with updater function", () => {
  const s = signal(10);
  s.update((prev) => prev + 5);
  assertEquals(s.value, 15);
});

Deno.test("signal: update receives current value", () => {
  const s = signal("hello");
  s.update((prev) => prev + " world");
  assertEquals(s.value, "hello world");
});

Deno.test("signal: update triggers subscribers", () => {
  const s = signal(0);
  let calls = 0;
  effect(() => {
    s.value;
    calls++;
  });
  assertEquals(calls, 1);
  s.update((prev) => prev + 1);
  assertEquals(calls, 2);
  assertEquals(s.value, 1);
});

Deno.test("signal: update no-op when result is same value", () => {
  const s = signal(5);
  let calls = 0;
  effect(() => {
    s.value;
    calls++;
  });
  assertEquals(calls, 1);
  s.update((_prev) => 5); // same value
  assertEquals(calls, 1); // no re-trigger
});

// ── AIO-50: Glitch-free outside batch ──────────────────────────────

Deno.test("signal: no glitch when set() outside batch triggers cascading updates", () => {
  const a = signal(1);
  const b = signal(10);
  const log: number[] = [];
  // Effect depends on both a and b
  const dispose = effect(() => {
    log.push(a.value + b.value);
  });
  assertEquals(log, [11]); // initial run: 1 + 10
  // Setting a outside batch — with implicit batching, b's value is consistent
  // throughout the notification cycle (no intermediate stale read)
  a.set(2);
  assertEquals(log, [11, 12]); // 2 + 10
  // Setting both — should produce single consistent update
  batch(() => {
    a.set(3);
    b.set(20);
  });
  assertEquals(log, [11, 12, 23]); // 3 + 20 (not 13 then 23)
  dispose();
});

// ── untrack() ─────────────────────────────────────────────────────────

Deno.test("untrack: reads inside untrack are not tracked", () => {
  const a = signal(1);
  const b = signal(2);
  const deps = _trackStart();
  const va = a.value; // tracked
  const vb = untrack(() => b.value); // NOT tracked
  const tracked = _trackEnd(deps);
  assertEquals(va, 1);
  assertEquals(vb, 2);
  assertEquals(tracked.size, 1); // only 'a' tracked
});

Deno.test("untrack: effect does not re-run for untracked signals", () => {
  const tracked = signal(0);
  const untracked_ = signal(0);
  let runs = 0;
  effect(() => {
    tracked.value;
    untrack(() => untracked_.value);
    runs++;
  });
  assertEquals(runs, 1);
  untracked_.set(1); // should NOT re-trigger
  assertEquals(runs, 1);
  tracked.set(1); // SHOULD re-trigger
  assertEquals(runs, 2);
});

Deno.test("untrack: returns the value of the function", () => {
  const s = signal(42);
  const result = untrack(() => s.value * 2);
  assertEquals(result, 84);
});

Deno.test("untrack: restores tracking stack when fn throws", () => {
  const a = signal(0);
  let runs = 0;
  effect(() => {
    a.value; // track a
    runs++;
    try {
      untrack(() => {
        throw new Error("boom");
      });
    } catch { /* expected */ }
  });
  assertEquals(runs, 1);
  // After the throw, tracking should still work — a is still tracked
  a.set(1);
  assertEquals(runs, 2);
});

Deno.test("untrack: restores tracking context after call", () => {
  const a = signal(1);
  const b = signal(2);
  const c = signal(3);
  const deps = _trackStart();
  void a.value; // tracked
  untrack(() => void b.value); // not tracked
  void c.value; // tracked
  const tracked = _trackEnd(deps);
  assertEquals(tracked.size, 2); // a and c
});

// ── AIO-120: Disposed computed must not recompute ────────────────────

Deno.test("computed: disposed computed returns cached value and does not re-subscribe", () => {
  const s = signal(1);
  let computeCount = 0;
  const c = computed(() => {
    computeCount++;
    return s.value * 10;
  });

  // Force initial computation
  assertEquals(c.value, 10);
  assertEquals(computeCount, 1);

  // Signal should have a subscriber from the computed
  const subsBefore =
    (s as unknown as { _subscribers: Set<unknown> })._subscribers.size;
  assertEquals(subsBefore > 0, true);

  // Mark the computed dirty by changing its dependency BEFORE disposing
  s.set(99);

  // Now dispose — the computed is dirty (dep changed) but not yet recomputed
  (c as unknown as { dispose(): void }).dispose();

  // After dispose, signal should have no subscribers from this computed
  const subsAfterDispose =
    (s as unknown as { _subscribers: Set<unknown> })._subscribers.size;
  assertEquals(subsAfterDispose, 0);

  // Access disposed computed — must return last cached value (10), NOT recompute
  // This is the bug: without the fix, _recompute() runs, re-establishing subscriptions
  assertEquals(c.value, 10);
  assertEquals(c.peek(), 10);
  assertEquals(computeCount, 1); // must NOT have recomputed

  // Must NOT have re-subscribed to the signal
  const subsAfterAccess =
    (s as unknown as { _subscribers: Set<unknown> })._subscribers.size;
  assertEquals(subsAfterAccess, 0);
});
