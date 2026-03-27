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
      log.push(`cleanup:${a.value}`);
    };
  });
  assertEquals(log, ["run:0"]);
  a.set(1);
  assertEquals(log, ["run:0", "cleanup:0", "run:1"]);
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
