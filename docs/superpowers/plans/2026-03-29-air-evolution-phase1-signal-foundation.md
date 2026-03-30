# AIR Evolution Phase 1: Signal Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade AIR's signal system with updater functions, auto-batching, auto-dispose effects, untrack, watch, on(), and afterRender — the foundation every later phase builds on.

**Architecture:** All changes are in `src/signal.ts` (core primitives) and `src/aio-renderer.ts` (component integration). Each task is independent and testable in isolation. The existing signal system is extended, not replaced.

**Tech Stack:** Deno 2.6+, TypeScript, `@std/assert` for tests

**Spec:** `docs/superpowers/specs/2026-03-29-air-evolution-design.md` — Part 1 (Signal Primitives) + Part 2 (Effect Timing)

---

### Task 1: Updater function on `signal.set()`

**Files:**
- Modify: `src/signal.ts` — `SignalImpl.set()` method (line ~154)
- Test: `tests/signal.test.ts`
- Modify: `src/signal.ts` — `Signal<T>` interface (line ~8)

- [ ] **Step 1: Write the failing test**

Add to `tests/signal.test.ts`:

```ts
Deno.test("signal: set with updater function", () => {
  const s = signal(10);
  s.set((prev) => prev + 5);
  assertEquals(s.value, 15);
});

Deno.test("signal: set updater receives current value", () => {
  const s = signal("hello");
  s.set((prev) => prev + " world");
  assertEquals(s.value, "hello world");
});

Deno.test("signal: set updater triggers subscribers", () => {
  const s = signal(0);
  let calls = 0;
  effect(() => { s.value; calls++; });
  assertEquals(calls, 1);
  s.set((prev) => prev + 1);
  assertEquals(calls, 2);
  assertEquals(s.value, 1);
});

Deno.test("signal: set updater no-op when result is same value", () => {
  const s = signal(5);
  let calls = 0;
  effect(() => { s.value; calls++; });
  assertEquals(calls, 1);
  s.set((_prev) => 5); // same value
  assertEquals(calls, 1); // no re-trigger
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test -A tests/signal.test.ts --filter "set with updater"`
Expected: FAIL — `set()` currently only accepts `T`, not `(prev: T) => T`

- [ ] **Step 3: Update Signal interface**

In `src/signal.ts`, change the `Signal<T>` interface (line ~8):

```ts
export interface Signal<T> {
  readonly value: T;
  set(next: T | ((prev: T) => T)): void;
  peek(): T;
  subscribe(fn: () => void): () => void;
  /** @internal */ readonly _subscribers: Set<Subscriber>;
  /** @internal */ readonly _version: number;
}
```

- [ ] **Step 4: Implement updater in SignalImpl.set()**

In `src/signal.ts`, replace the `set()` method in `SignalImpl` (line ~154):

```ts
  set(next: T | ((prev: T) => T)): void {
    const resolved = typeof next === "function"
      ? (next as (prev: T) => T)(this._value)
      : next;
    if (Object.is(this._value, resolved)) return;
    if (
      resolved !== null && typeof resolved === "object" &&
      _shallowEq(this._value, resolved)
    ) return;
    this._value = resolved;
    this._version++;
    for (const sub of this._subscribers) {
      _pendingSubscribers.add(sub);
    }
    if (_batchDepth === 0) _flush();
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `deno test -A tests/signal.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/signal.ts tests/signal.test.ts
git commit -m "signal: add updater function to .set(prev => next)"
```

---

### Task 2: Auto-batch event handlers in VDOM

**Files:**
- Modify: `src/vdom.ts` — event patching (line ~500-504)
- Test: `tests/renderer.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/renderer.test.ts`:

```ts
Deno.test("vdom: event handlers are auto-batched", () => {
  const { signal, effect, batch: _batch } = await import("../src/signal.ts");
  const { h, Fragment } = await import("../src/vdom.ts");
  const { mount } = await import("../src/aio-renderer.ts");

  const a = signal(0);
  const b = signal(0);
  let renderCount = 0;

  const App = () => {
    renderCount++;
    return h("button", {
      onClick: () => {
        // Two signal writes in one handler — should cause ONE re-render
        a.set(1);
        b.set(1);
      },
    }, `${a.value}+${b.value}`);
  };

  const root = document.createElement("div");
  mount(root, App);
  assertEquals(renderCount, 1);

  // Simulate click
  const btn = root.querySelector("button")!;
  btn.click();

  // Should be 2 (initial + one batched re-render), not 3
  assertEquals(renderCount, 2);
  assertEquals(a.value, 1);
  assertEquals(b.value, 1);
});
```

Note: This test requires a DOM environment. If tests run with `deno-dom` or
`linkedom`, use the existing DOM setup from renderer.test.ts. Check the existing
test file for the DOM setup pattern and match it.

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test -A tests/renderer.test.ts --filter "auto-batched"`
Expected: FAIL — renderCount is 3 (two separate flushes)

- [ ] **Step 3: Wrap event handlers in batch()**

In `src/vdom.ts`, find the event listener setup (line ~500-504). Change:

```ts
    if (k.startsWith("on")) {
      const evt = k.slice(2).toLowerCase();
      if (prev[k]) el.removeEventListener(evt, prev[k] as EventListener);
      el.addEventListener(evt, v as EventListener);
```

To:

```ts
    if (k.startsWith("on")) {
      const evt = k.slice(2).toLowerCase();
      if (prev[k]) el.removeEventListener(evt, (prev as Record<string, unknown>)[`__aio_${k}`] as EventListener ?? prev[k] as EventListener);
      const wrapped = ((handler: EventListener) => (e: Event) => batch(() => handler(e)))(v as EventListener);
      el.addEventListener(evt, wrapped);
      // Store wrapped ref for future removal
      (next as Record<string, unknown>)[`__aio_${k}`] = wrapped;
```

Note: We need to import `batch` from `signal.ts` at the top of `vdom.ts`. Check
if it's already imported — the file comment says "Zero dependencies on signal.ts
or any other AIO code" (line 2). This means we need a different approach.

**Better approach — inject batch via hooks:** The VDOM is dependency-free by
design. Instead, wrap event handlers in the renderer layer (`aio-renderer.ts`)
where `batch` is already available. In the `_createHooks()` function, modify the
`afterSubtree` or prop-patching hook to wrap `on*` handlers.

**Alternatively:** Add batch import to vdom.ts — it's already coupled via the
`VDomHooks` interface. A single import of `batch` from `signal.ts` is acceptable.

Read the existing approach in `aio-renderer.ts` hooks to determine the cleanest
integration point. The key change: any function value assigned to an `on*` prop
gets wrapped in `(e) => batch(() => handler(e))` before being passed to
`addEventListener`.

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test -A tests/renderer.test.ts --filter "auto-batched"`
Expected: PASS — renderCount is 2

- [ ] **Step 5: Run full test suite**

Run: `deno test -A tests/`
Expected: ALL PASS — no regressions

- [ ] **Step 6: Commit**

```bash
git add src/vdom.ts tests/renderer.test.ts
git commit -m "vdom: auto-batch event handlers to prevent multi-render"
```

---

### Task 3: Auto-dispose effects in component render

**Files:**
- Modify: `src/signal.ts` — add effect collector (near computed collector, line ~267)
- Modify: `src/aio-renderer.ts` — integrate effect collector in render cycle
- Test: `tests/renderer.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/renderer.test.ts`:

```ts
Deno.test("renderer: effects auto-dispose on unmount", () => {
  const { signal, effect } = await import("../src/signal.ts");
  const { h } = await import("../src/vdom.ts");
  const { mount, onCleanup } = await import("../src/aio-renderer.ts");

  const visible = signal(true);
  let effectRunCount = 0;
  let effectDisposed = false;
  const trigger = signal(0);

  const Child = () => {
    // Effect created during render — should auto-dispose when Child unmounts
    effect(() => {
      trigger.value;
      effectRunCount++;
      return () => { effectDisposed = true; };
    });
    return h("span", null, "child");
  };

  const App = () => visible.value ? h(Child, null) : h("span", null, "gone");

  const root = document.createElement("div");
  mount(root, App);
  assertEquals(effectRunCount, 1);

  // Unmount Child
  visible.set(false);
  assertEquals(effectDisposed, true);

  // Trigger signal that the effect tracked — should NOT re-run
  const countBefore = effectRunCount;
  trigger.set(1);
  assertEquals(effectRunCount, countBefore); // no re-run after dispose
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test -A tests/renderer.test.ts --filter "auto-dispose"`
Expected: FAIL — effect is NOT disposed on unmount (effectDisposed remains false)

- [ ] **Step 3: Add effect collector to signal.ts**

In `src/signal.ts`, after the computed collector section (line ~284), add:

```ts
// ── Effect collector (for renderer auto-dispose) ───────────────────

type EffectDispose = () => void;
let _effectCollector: EffectDispose[] | null = null;

/** Start collecting effect dispose functions created during a render pass. */
export function _effectCollectStart(): EffectDispose[] {
  const list: EffectDispose[] = [];
  _effectCollector = list;
  return list;
}

/** Stop collecting effect dispose functions. */
export function _effectCollectEnd(list: EffectDispose[]): void {
  if (_effectCollector === list) _effectCollector = null;
}

/** Dispose all effects in a list (cleanup on unmount/re-render). */
export function _effectDisposeAll(list: EffectDispose[]): void {
  for (const dispose of list) dispose();
  list.length = 0;
}
```

Then in the `effect()` function (line ~294), after the initial `sub.execute()`
call and before the return, add registration:

```ts
  // Initial run (no prepare needed)
  sub.execute();

  const dispose = () => {
    disposed = true;
    if (cleanup) {
      cleanup();
      cleanup = undefined;
    }
    for (const unsub of unsubs) unsub();
    unsubs = [];
  };

  // Register with effect collector if active (renderer auto-dispose)
  if (_effectCollector) _effectCollector.push(dispose);

  return dispose;
```

- [ ] **Step 4: Integrate effect collector in aio-renderer.ts**

In `src/aio-renderer.ts`, find where `_computedCollectStart()` is called during
component render. Add `_effectCollectStart()` / `_effectCollectEnd()` calls
alongside it. Store the collected effect disposes in `ComponentInstance` and
call `_effectDisposeAll()` on unmount alongside `_computedDisposeAll()`.

Add to `ComponentInstance` interface:

```ts
  effectDisposes: EffectDispose[];
```

Import the new functions:

```ts
import {
  _computedCollectEnd,
  _computedCollectStart,
  _computedDisposeAll,
  _effectCollectStart,
  _effectCollectEnd,
  _effectDisposeAll,
  // ... existing imports
} from "./signal.ts";
```

In `beforeComponent` hook: call `_effectCollectStart()` alongside
`_computedCollectStart()`.

In `afterComponent` hook: call `_effectCollectEnd()` and store result in
component instance.

In unmount/cleanup: call `_effectDisposeAll()` alongside
`_computedDisposeAll()`.

- [ ] **Step 5: Run tests**

Run: `deno test -A tests/renderer.test.ts --filter "auto-dispose"`
Expected: PASS

Run: `deno test -A tests/`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/signal.ts src/aio-renderer.ts tests/renderer.test.ts
git commit -m "renderer: auto-dispose effects created during component render"
```

---

### Task 4: `untrack()` global function

**Files:**
- Modify: `src/signal.ts` — add `untrack()` (after `_trackEnd`, line ~45)
- Modify: `src/air.ts` — export `untrack`
- Test: `tests/signal.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/signal.test.ts`:

```ts
import { untrack } from "../src/signal.ts";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test -A tests/signal.test.ts --filter "untrack"`
Expected: FAIL — `untrack` is not exported

- [ ] **Step 3: Implement untrack()**

In `src/signal.ts`, after `_trackEnd()` (line ~45), add:

```ts
/** Read signals without tracking — reads inside fn() will NOT create
 *  subscriptions in the current tracking context. */
export function untrack<T>(fn: () => T): T {
  // Remove current tracker temporarily so .value reads don't register
  const savedLen = _trackStack.length;
  // Push an empty set that we'll discard — captures reads and throws them away
  const throwaway = new Set<SignalImpl<unknown>>();
  _trackStack.push(throwaway);
  try {
    return fn();
  } finally {
    _trackStack.pop();
    // Verify we didn't corrupt the stack
    if (_trackStack.length !== savedLen) {
      throw new Error("Signal tracking stack corrupted in untrack()");
    }
  }
}
```

- [ ] **Step 4: Export from air.ts**

In `src/air.ts`, add `untrack` to the exports from browser-air or directly:

Check if `untrack` needs to be re-exported from `browser-air.ts` first. If
`browser-air.ts` re-exports from signal.ts, add it there. Otherwise, add to
`air.ts`:

```ts
export { untrack } from "./signal.ts";
```

- [ ] **Step 5: Run tests**

Run: `deno test -A tests/signal.test.ts --filter "untrack"`
Expected: ALL PASS

Run: `deno test -A tests/`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/signal.ts src/air.ts tests/signal.test.ts
git commit -m "signal: add untrack() to suppress tracking in code blocks"
```

---

### Task 5: `watch()` with old/new values

**Files:**
- Create: `src/watch.ts`
- Modify: `src/air.ts` — export `watch`
- Test: `tests/watch.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/watch.test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { signal } from "../src/signal.ts";
import { watch } from "../src/watch.ts";

Deno.test("watch: calls callback with new and old values", () => {
  const s = signal(1);
  const log: [number, number][] = [];
  const stop = watch(s, (next, prev) => {
    log.push([next, prev]);
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
  const stop = watch(s, () => { called = true; });
  assertEquals(called, false);
  stop();
});

Deno.test("watch: fires on creation when immediate: true", () => {
  const s = signal(1);
  const log: [number, number | undefined][] = [];
  const stop = watch(s, (next, prev) => {
    log.push([next, prev as number | undefined]);
  }, { immediate: true });
  assertEquals(log, [[1, undefined]]);
  stop();
});

Deno.test("watch: stop prevents future calls", () => {
  const s = signal(0);
  let calls = 0;
  const stop = watch(s, () => { calls++; });
  s.set(1);
  assertEquals(calls, 1);
  stop();
  s.set(2);
  assertEquals(calls, 1); // no more calls
});

Deno.test("watch: works with computed signals", () => {
  const { computed } = await import("../src/signal.ts");
  const a = signal(1);
  const doubled = computed(() => a.value * 2);
  const log: [number, number][] = [];
  const stop = watch(doubled, (next, prev) => {
    log.push([next, prev]);
  });
  a.set(2);
  assertEquals(log, [[4, 2]]);
  stop();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test -A tests/watch.test.ts`
Expected: FAIL — `src/watch.ts` does not exist

- [ ] **Step 3: Implement watch()**

Create `src/watch.ts`:

```ts
// watch() — observe signal changes with old/new values.
// Thin wrapper over effect() + peek(). Does NOT auto-dispose in components
// (use effect() for that). Returns a stop function.

import { type Computed, effect, type Signal } from "./signal.ts";

/** Options for watch(). */
export interface WatchOptions {
  /** If true, callback fires immediately with current value (prev = undefined). */
  immediate?: boolean;
}

/**
 * Watch a signal or computed, calling `fn(next, prev)` whenever it changes.
 * Returns a stop function.
 */
export function watch<T>(
  source: Signal<T> | Computed<T>,
  fn: (next: T, prev: T | undefined) => void,
  opts?: WatchOptions,
): () => void {
  let prev: T | undefined = source.peek();
  let first = true;

  if (opts?.immediate) {
    fn(prev as T, undefined);
  }

  const dispose = effect(() => {
    const next = source.value;
    if (first) {
      first = false;
      return;
    }
    fn(next, prev);
    prev = next;
  });

  return dispose;
}
```

- [ ] **Step 4: Export from air.ts**

In `src/air.ts`, add:

```ts
export { watch } from "./watch.ts";
export type { WatchOptions } from "./watch.ts";
```

- [ ] **Step 5: Run tests**

Run: `deno test -A tests/watch.test.ts`
Expected: ALL PASS

Run: `deno test -A tests/`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/watch.ts src/air.ts tests/watch.test.ts
git commit -m "signal: add watch() for observing signal changes with old/new values"
```

---

### Task 6: `on()` explicit dependency helper

**Files:**
- Modify: `src/watch.ts` — add `on()` function
- Modify: `src/air.ts` — export `on`
- Test: `tests/watch.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/watch.test.ts`:

```ts
import { on } from "../src/watch.ts";
import { effect } from "../src/signal.ts";

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

Deno.test("on: deferred by default (skips first run)", () => {
  const s = signal(0);
  let called = false;
  const dispose = effect(on(s, () => { called = true; }));
  assertEquals(called, false); // deferred — first run skipped
  s.set(1);
  assertEquals(called, true);
  dispose();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test -A tests/watch.test.ts --filter "on:"`
Expected: FAIL — `on` is not exported

- [ ] **Step 3: Implement on()**

Add to `src/watch.ts`:

```ts
import { untrack } from "./signal.ts";

/**
 * Explicit dependency declaration for effects. The returned function is passed
 * to effect() and only re-runs when `source` changes.
 *
 * ```ts
 * effect(on(count, (next, prev) => { ... }));
 * ```
 */
export function on<T>(
  source: Signal<T> | Computed<T>,
  fn: (next: T, prev: T) => void,
): () => void {
  let prev: T = source.peek();
  let first = true;

  return () => {
    const next = source.value; // track only this source
    if (first) {
      first = false;
      prev = next;
      return;
    }
    const p = prev;
    prev = next;
    // Run callback with all other reads untracked
    untrack(() => fn(next, p));
  };
}
```

- [ ] **Step 4: Export from air.ts**

In `src/air.ts`, update the import from watch.ts:

```ts
export { on, watch } from "./watch.ts";
export type { WatchOptions } from "./watch.ts";
```

- [ ] **Step 5: Run tests**

Run: `deno test -A tests/watch.test.ts`
Expected: ALL PASS

Run: `deno test -A tests/`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/watch.ts src/air.ts tests/watch.test.ts
git commit -m "signal: add on() helper for explicit effect dependencies"
```

---

### Task 7: `afterRender()` — post-DOM-update callback

**Files:**
- Modify: `src/aio-renderer.ts` — add afterRender registry + flush
- Modify: `src/air.ts` — export `afterRender`
- Test: `tests/renderer.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/renderer.test.ts`:

```ts
Deno.test("afterRender: callback runs after DOM update", () => {
  const { signal } = await import("../src/signal.ts");
  const { h } = await import("../src/vdom.ts");
  const { mount, afterRender } = await import("../src/aio-renderer.ts");

  const count = signal(0);
  const domTexts: string[] = [];

  const App = () => {
    afterRender(() => {
      // At this point, DOM should reflect the new value
      domTexts.push(root.textContent ?? "");
    });
    return h("div", null, `count: ${count.value}`);
  };

  const root = document.createElement("div");
  mount(root, App);

  // afterRender should have captured the DOM after first render
  assertEquals(domTexts, ["count: 0"]);

  count.set(1);
  assertEquals(domTexts, ["count: 0", "count: 1"]);
});

Deno.test("afterRender: multiple callbacks run in order", () => {
  const { h } = await import("../src/vdom.ts");
  const { mount, afterRender } = await import("../src/aio-renderer.ts");

  const order: number[] = [];

  const App = () => {
    afterRender(() => order.push(1));
    afterRender(() => order.push(2));
    return h("div", null, "test");
  };

  const root = document.createElement("div");
  mount(root, App);
  assertEquals(order, [1, 2]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test -A tests/renderer.test.ts --filter "afterRender"`
Expected: FAIL — `afterRender` is not exported

- [ ] **Step 3: Implement afterRender()**

In `src/aio-renderer.ts`:

1. Add a per-root queue for afterRender callbacks:

```ts
// After-render callback queue — flushed after VDOM commit to real DOM
let _afterRenderQueue: (() => void)[] = [];
```

2. Add the public `afterRender()` function (next to `onMount`/`onCleanup`):

```ts
/**
 * Register a callback to run after the current render cycle commits to DOM.
 * Must be called inside a component function body during render.
 * Use for DOM measurement, scroll restoration, imperative DOM APIs.
 */
export function afterRender(fn: () => void): void {
  _afterRenderQueue.push(fn);
}
```

3. Find the point in the render cycle where VDOM diff is committed to real DOM
(after `_diff` or after component re-render flush). After the DOM update is
complete, flush the queue:

```ts
function _flushAfterRender(): void {
  const cbs = _afterRenderQueue;
  _afterRenderQueue = [];
  for (const cb of cbs) {
    try { cb(); }
    catch (e) { console.error("[aio-renderer] afterRender callback error:", e); }
  }
}
```

Call `_flushAfterRender()` at the end of:
- `mount()` — after initial render
- `_flushPendingRenders()` or equivalent — after re-render cycle completes

- [ ] **Step 4: Export from air.ts**

In `src/air.ts`, add:

```ts
export { afterRender } from "./aio-renderer.ts";
```

Also export from `src/browser-air.ts` if it re-exports renderer functions.

- [ ] **Step 5: Run tests**

Run: `deno test -A tests/renderer.test.ts --filter "afterRender"`
Expected: ALL PASS

Run: `deno test -A tests/`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/aio-renderer.ts src/air.ts tests/renderer.test.ts
git commit -m "renderer: add afterRender() for post-DOM-update callbacks"
```

---

### Task 8: Export updates and integration test

**Files:**
- Modify: `src/air.ts` — verify all new exports
- Create: `tests/signal-evolution.test.ts` — integration test combining new features

- [ ] **Step 1: Write integration test**

Create `tests/signal-evolution.test.ts`:

```ts
import { assertEquals } from "@std/assert";
import {
  batch,
  computed,
  effect,
  signal,
  untrack,
} from "../src/signal.ts";
import { on, watch } from "../src/watch.ts";

Deno.test("integration: updater + batch + watch work together", () => {
  const count = signal(0);
  const log: [number, number][] = [];

  const stop = watch(count, (next, prev) => {
    log.push([next, prev]);
  });

  batch(() => {
    count.set((prev) => prev + 1);
    count.set((prev) => prev + 1);
  });

  // Batch: two updates, one notification, watch sees 0 -> 2
  assertEquals(count.value, 2);
  assertEquals(log, [[2, 0]]);

  stop();
});

Deno.test("integration: on() + untrack() in same effect", () => {
  const source = signal(0);
  const other = signal("hello");
  const log: string[] = [];

  const dispose = effect(on(source, (next, _prev) => {
    const msg = untrack(() => other.value);
    log.push(`${next}:${msg}`);
  }));

  source.set(1);
  assertEquals(log, ["1:hello"]);

  other.set("world"); // should NOT re-trigger
  assertEquals(log, ["1:hello"]);

  source.set(2); // SHOULD re-trigger, reads updated other
  assertEquals(log, ["1:hello", "2:world"]);

  dispose();
});
```

- [ ] **Step 2: Run integration tests**

Run: `deno test -A tests/signal-evolution.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Verify air.ts exports**

Read `src/air.ts` and verify these are all exported:
- `untrack` from `./signal.ts`
- `watch`, `on` from `./watch.ts`
- `afterRender` from `./aio-renderer.ts`

- [ ] **Step 4: Run full test suite**

Run: `deno test -A tests/`
Expected: ALL PASS

- [ ] **Step 5: Run type check**

Run: `deno check src/air.ts`
Expected: No type errors

- [ ] **Step 6: Commit**

```bash
git add tests/signal-evolution.test.ts src/air.ts
git commit -m "signal evolution phase 1: integration tests, export verification"
```
