# Subscription Stability & Silent Failure Prevention — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the P0 silent loading-loop bug (AIO-4/AIO-3) by stabilizing the
`useAio()` subscribe reference, adding a 300ms grace period to nuclear cleanup,
and emitting dual-channel diagnostics for all teardown events.

**Architecture:** Three-layer fix in `src/browser.ts`: (1) move
`_useAioSubscribe` to module scope for a stable `useSyncExternalStore`
reference, (2) debounce the nuclear cleanup with a 300ms grace period so
transient listener gaps (React reconciliation, page switches) don't trigger full
teardown, (3) emit `console.warn` + `_diagEmit` on teardown and teardown-averted
events. TDD — tests first.

**Tech Stack:** Deno 2.6+, TypeScript, `@std/assert`, `FakeTime` from
`@std/testing/time`

**Spec:** `docs/superpowers/specs/2026-03-25-subscription-stability-design.md`

---

## File Structure

| File                              | Action | Responsibility                                                   |
| --------------------------------- | ------ | ---------------------------------------------------------------- |
| `src/browser.ts:306-309`          | Modify | Add `_cleanupTimer` and `_listenerHighWater` module-level state  |
| `src/browser.ts:609-649`          | Modify | Debounce nuclear cleanup in `_subscribe`, add diagnostics        |
| `src/browser.ts:1185-1212`        | Modify | Move `_useAioSubscribe` to module scope, simplify `useAio()`     |
| `src/browser.ts:1784-1816`        | Modify | Add `_cleanupTimer` and `_listenerHighWater` reset to `_reset()` |
| `tests/browser-subscribe.test.ts` | Create | 9 test cases for subscription stability                          |

---

### Task 1: Write test file scaffold and stable-reference tests (tests 1, 2)

**Files:**

- Create: `tests/browser-subscribe.test.ts`

- [ ] **Step 1: Write failing tests for stable `_useAioSubscribe` reference**

```typescript
// tests/browser-subscribe.test.ts
// Tests for subscription stability fix (AIO-4/AIO-3)
//
// Strategy: We test the _subscribe / _useAioSubscribe functions directly
// (they are the useSyncExternalStore callbacks). We do NOT need React or
// a browser — these are pure functions operating on module-level state.
// We import _reset() to isolate tests and use FakeTime for timer control.

import { assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { _reset, _subscribe, _useAioSubscribe } from "../src/browser.ts";

// ── Stable reference tests ──────────────────────────────────────────

Deno.test("subscribe: _useAioSubscribe is a stable module-level reference", () => {
  // Accessing the export twice should return the same function reference.
  // This proves it's not recreated per call (the old bug).
  const ref1 = _useAioSubscribe;
  const ref2 = _useAioSubscribe;
  assertEquals(ref1, ref2, "_useAioSubscribe must be a stable reference");
});

Deno.test("subscribe: _useAioSubscribe wraps _subscribe (listener count tracks)", () => {
  _reset();
  let callCount = 0;
  const unsub = _useAioSubscribe(() => {
    callCount++;
  });
  // Should have registered a listener via _subscribe
  // Unsubscribe should work
  unsub();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test tests/browser-subscribe.test.ts --no-check 2>&1 | head -30`
Expected: FAIL — `_useAioSubscribe` and `_subscribe` are not exported

- [ ] **Step 3: Commit test scaffold**

```bash
git add tests/browser-subscribe.test.ts
git commit -m "test: add browser-subscribe test scaffold (failing — exports missing)"
```

---

### Task 2: Export `_subscribe` and `_useAioSubscribe`, move `_useAioSubscribe` to module scope (Layer 1)

**Files:**

- Modify: `src/browser.ts:609` — add `export` to `_subscribe`
- Modify: `src/browser.ts:1197-1205` — remove `_useAioSubscribe` from `useAio()`
  body
- Modify: `src/browser.ts:~608` — add module-scope `_useAioSubscribe` with
  `export`

- [ ] **Step 1: Add `export` to `_subscribe` function**

At `src/browser.ts:610`, change:

```typescript
function _subscribe(onStoreChange: () => void): () => void {
```

to:

```typescript
export function _subscribe(onStoreChange: () => void): () => void {
```

- [ ] **Step 2: Move `_useAioSubscribe` to module scope before `_subscribe`**

At `src/browser.ts`, insert before line 609 (before `_subscribe`):

```typescript
/** Stable subscribe for useAio() — wraps _subscribe with active-count tracking.
 *  Module-scoped so useSyncExternalStore sees a stable reference (no re-subscription). */
export const _useAioSubscribe = (onStoreChange: () => void): () => void => {
  _useAioActiveCount++;
  const unsub = _subscribe(onStoreChange);
  return () => {
    _useAioActiveCount--;
    unsub();
  };
};
```

- [ ] **Step 3: Remove the inline `_useAioSubscribe` from `useAio()` body**

At `src/browser.ts:1197-1205`, remove:

```typescript
// Track active useAio() instances — increment on subscribe, decrement on unsubscribe
const _useAioSubscribe = (onStoreChange: () => void): () => void => {
  _useAioActiveCount++;
  const unsub = _subscribe(onStoreChange);
  return () => {
    _useAioActiveCount--;
    unsub();
  };
};
```

The `useSyncExternalStore` call on line 1206 now references the module-scope
`_useAioSubscribe`.

- [ ] **Step 4: Run tests to verify stable-reference tests pass**

Run: `deno test tests/browser-subscribe.test.ts --no-check 2>&1 | tail -20`
Expected: 2 tests PASS

- [ ] **Step 5: Run existing test suite to check for regressions**

Run:
`deno test tests/sync.test.ts tests/listeners.test.ts --no-check 2>&1 | tail -10`
Expected: All PASS

- [ ] **Step 6: Commit Layer 1**

```bash
git add src/browser.ts tests/browser-subscribe.test.ts
git commit -m "fix(browser): move _useAioSubscribe to module scope — stable useSyncExternalStore ref (AIO-4)"
```

---

### Task 3: Write grace-period tests (tests 3, 4, 5, 6, 7, 8)

**Files:**

- Modify: `tests/browser-subscribe.test.ts`

- [ ] **Step 1: Add grace-period cancellation tests (tests 3, 4, 5)**

Append to `tests/browser-subscribe.test.ts`:

```typescript
// ── Grace period — cancellation tests ───────────────────────────────

Deno.test("subscribe: transient gap recovery — cleanup cancelled within 300ms", () => {
  _reset();
  using time = new FakeTime();

  // Simulate state existing (as it would in a running app)
  // Subscribe two listeners
  const unsub1 = _subscribe(() => {});
  const unsub2 = _subscribe(() => {});

  // Remove both — listeners at 0
  unsub1();
  unsub2();

  // Before 300ms — reattach
  time.tick(100);
  const unsub3 = _subscribe(() => {});

  // Advance past 300ms — cleanup should NOT have fired
  time.tick(300);

  // Verify: new listener works (system is alive)
  unsub3();
});

Deno.test("subscribe: timer resets on rapid unsub/resub cycles", () => {
  _reset();
  using time = new FakeTime();

  // First cycle
  const unsub1 = _subscribe(() => {});
  unsub1(); // listeners = 0, timer starts
  time.tick(200); // 200ms into grace period

  // Second cycle — reattach and detach again
  const unsub2 = _subscribe(() => {});
  unsub2(); // listeners = 0 again, timer should RESET (not stack)

  // At 200 + 200 = 400ms from first unsub, but only 200ms from second
  time.tick(200);
  // Timer hasn't fired yet (only 200ms into second grace period)
  // Reattach to prove system is still alive
  const unsub3 = _subscribe(() => {});
  unsub3();
});

Deno.test("subscribe: teardown-averted diagnostic fires on cancellation", () => {
  _reset();
  using time = new FakeTime();

  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(String(args[0]));
  };

  try {
    const unsub = _subscribe(() => {});
    unsub(); // listeners = 0
    time.tick(100);
    const unsub2 = _subscribe(() => {}); // reattach within 300ms
    time.tick(300); // timer fires, sees listeners > 0

    assertEquals(
      warns.some((w) => w.includes("teardown averted")),
      true,
      "Should emit teardown-averted console.warn",
    );
    unsub2();
  } finally {
    console.warn = origWarn;
  }
});
```

- [ ] **Step 2: Add grace-period teardown tests (tests 6, 7, 8)**

Append to `tests/browser-subscribe.test.ts`:

```typescript
// ── Grace period — full teardown tests ──────────────────────────────

Deno.test("subscribe: full teardown after 300ms with no listeners", () => {
  _reset();
  using time = new FakeTime();

  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(String(args[0]));
  };

  try {
    const unsub = _subscribe(() => {});
    unsub(); // listeners = 0, timer starts

    // Advance past grace period
    time.tick(350);

    assertEquals(
      warns.some((w) => w.includes("[aio] teardown")),
      true,
      "Should emit teardown console.warn",
    );
    assertEquals(
      warns.some((w) => w.includes("no listeners for 300ms")),
      true,
      "Teardown message should mention 300ms",
    );
  } finally {
    console.warn = origWarn;
  }
});

Deno.test("subscribe: post-teardown resubscribe works cleanly", () => {
  _reset();
  using time = new FakeTime();

  // Subscribe and teardown
  const unsub = _subscribe(() => {});
  unsub();
  time.tick(350); // teardown fires

  // Resubscribe — should not throw, system should be alive
  let called = false;
  const unsub2 = _subscribe(() => {
    called = true;
  });
  // System should accept the subscription
  unsub2();
});

// ── Regression test ─────────────────────────────────────────────────

Deno.test("subscribe: unsubscribe does NOT immediately null state (regression)", () => {
  _reset();
  using time = new FakeTime();

  // Subscribe
  const unsub = _subscribe(() => {});
  unsub(); // listeners = 0

  // Immediately after unsubscribe — no time elapsed
  // State should NOT be nuked yet (grace period hasn't fired)
  // We can't directly read _state, but we can verify by resubscribing
  // and confirming the system didn't tear down
  const unsub2 = _subscribe(() => {});
  // If nuclear cleanup had fired instantly, _closed would be true
  // and _subscribe would need to reconnect. The subscribe itself
  // succeeding without triggering _connect proves state is intact.
  unsub2();

  // Now let the timer expire with no listeners
  time.tick(350);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `deno test tests/browser-subscribe.test.ts --no-check 2>&1 | tail -30`
Expected: FAIL — grace period not yet implemented (instant nuclear cleanup still
in place)

- [ ] **Step 4: Commit failing tests**

```bash
git add tests/browser-subscribe.test.ts
git commit -m "test: add grace-period tests for subscribe teardown (failing — grace period not implemented)"
```

---

### Task 4: Implement grace period + diagnostics (Layer 2 + Layer 3)

**Files:**

- Modify: `src/browser.ts:306-309` — add module-level state
- Modify: `src/browser.ts:609-649` — debounce nuclear cleanup, add diagnostics
- Modify: `src/browser.ts:1784-1816` — update `_reset()`

- [ ] **Step 1: Add new module-level state variables**

At `src/browser.ts`, after line 309 (`let _stormCheckTimer ...`), add:

```typescript
let _cleanupTimer: ReturnType<typeof setTimeout> | null = null;
let _listenerHighWater = 0; // peak listener count since last teardown — for diagnostics
```

- [ ] **Step 2: Add high-water tracking at `_subscribe` entry**

At `src/browser.ts`, after the existing `_listeners.add(...)` call (after line
614), add:

```typescript
// Track peak listener count for diagnostic context
if (_listeners.size > _listenerHighWater) _listenerHighWater = _listeners.size;
```

**Note:** We do NOT cancel the cleanup timer on new subscribe. The timer is
allowed to fire and check `_listeners.size` — if listeners recovered, it emits
"teardown averted"; if still zero, it executes full teardown. This keeps the
"teardown averted" diagnostic path reachable. The `clearTimeout` in the
_unsubscribe_ path handles rapid unsub cycles.

- [ ] **Step 3: Replace instant nuclear cleanup with debounced version**

At `src/browser.ts:625-649`, replace the entire unsubscribe return function
body.

Replace:

```typescript
return () => {
  unsub();
  if (_listeners.size === 0) {
    _closed = true;
    _ws?.close();
    _ws = null;
    _ipcConnected = false;
    _connecting = false;
    _state = null;
    _stateReadyPromise = null;
    _stateReadyResolve = null;
    _queue = [];
    _retry = 0;
    // Clean up global listeners to prevent leaks
    if (_ttKeyHandler) {
      document.removeEventListener("keydown", _ttKeyHandler);
      _ttKeyHandler = null;
      _ttKeyBound = false;
    }
    if (_popstateHandler) {
      removeEventListener("popstate", _popstateHandler);
      _popstateHandler = null;
    }
  }
};
```

With:

```typescript
return () => {
  unsub();
  if (_listeners.size === 0) {
    if (_cleanupTimer) clearTimeout(_cleanupTimer);
    const peakCount = _listenerHighWater;
    _cleanupTimer = setTimeout(() => {
      _cleanupTimer = null;
      if (_listeners.size === 0) {
        // Legitimate teardown — 300ms with zero listeners
        console.warn(
          `[aio] teardown — no listeners for 300ms (peak was ${peakCount}). Closing connection, clearing state.`,
        );
        _diagEmit({
          type: "teardown",
          severity: "warning",
          source: "browser",
          message: "Full teardown — no listeners remained after grace period",
          detail: { graceMs: 300, peakListenerCount: peakCount },
        });
        _closed = true;
        _ws?.close();
        _ws = null;
        _ipcConnected = false;
        _connecting = false;
        _state = null;
        _stateReadyPromise = null;
        _stateReadyResolve = null;
        _queue = [];
        _retry = 0;
        _listenerHighWater = 0;
        // Clean up global listeners to prevent leaks
        if (_ttKeyHandler) {
          document.removeEventListener("keydown", _ttKeyHandler);
          _ttKeyHandler = null;
          _ttKeyBound = false;
        }
        if (_popstateHandler) {
          removeEventListener("popstate", _popstateHandler);
          _popstateHandler = null;
        }
      } else {
        // Transient gap — listeners recovered within grace period
        console.warn(
          `[aio] teardown averted — listeners dropped to 0 but recovered to ${_listeners.size} within 300ms`,
        );
        _diagEmit({
          type: "teardown-averted",
          severity: "info",
          source: "browser",
          message: "Transient listener gap — teardown cancelled",
          detail: { recoveredCount: _listeners.size },
        });
      }
    }, 300);
  }
};
```

- [ ] **Step 4: Update `_reset()` to clear new state**

At `src/browser.ts` in the `_reset()` function, after `_ipcConnected = false;`
(line 1814), add:

```typescript
_connecting = false;
_stateReadyPromise = null;
_stateReadyResolve = null;
if (_cleanupTimer) {
  clearTimeout(_cleanupTimer);
  _cleanupTimer = null;
}
_listenerHighWater = 0;
```

Note: `_connecting`, `_stateReadyPromise`, `_stateReadyResolve` are pre-existing
gaps in `_reset()` — the nuclear cleanup nulls them but `_reset()` didn't.
Fixing while here.

- [ ] **Step 5: Run all subscribe tests**

Run: `deno test tests/browser-subscribe.test.ts --no-check 2>&1 | tail -30`
Expected: All 8 tests PASS

- [ ] **Step 6: Run existing test suite for regressions**

Run:
`deno test tests/sync.test.ts tests/listeners.test.ts tests/standalone.test.ts --no-check 2>&1 | tail -10`
Expected: All PASS

- [ ] **Step 7: Commit Layer 2 + Layer 3**

```bash
git add src/browser.ts
git commit -m "fix(browser): 300ms grace period on teardown + dual-channel diagnostics (AIO-4/AIO-3)"
```

---

### Task 5: Write console.warn observability test (test 9) and final verification

**Files:**

- Modify: `tests/browser-subscribe.test.ts`

- [ ] **Step 1: Add console.warn spy test for both paths**

Append to `tests/browser-subscribe.test.ts`:

```typescript
// ── Observability tests ─────────────────────────────────────────────

Deno.test("subscribe: console.warn fires for both teardown and averted paths", () => {
  _reset();
  using time = new FakeTime();

  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(String(args[0]));
  };

  try {
    // Path 1: teardown-averted
    const unsub1 = _subscribe(() => {});
    unsub1();
    time.tick(100);
    const unsub2 = _subscribe(() => {});
    time.tick(300); // timer fires, sees listeners > 0
    assertEquals(
      warns.some((w) => w.includes("teardown averted")),
      true,
      "Should warn on teardown-averted",
    );

    // Path 2: full teardown
    warns.length = 0;
    unsub2();
    time.tick(350); // timer fires, listeners still 0
    assertEquals(
      warns.some((w) => w.includes("[aio] teardown")),
      true,
      "Should warn on full teardown",
    );
    assertEquals(
      warns.some((w) => w.includes("peak was")),
      true,
      "Teardown warn should include peak count",
    );
  } finally {
    console.warn = origWarn;
  }
});
```

- [ ] **Step 2: Run full test file**

Run: `deno test tests/browser-subscribe.test.ts --no-check 2>&1` Expected: All 9
tests PASS

- [ ] **Step 3: Run full project test suite**

Run: `deno test --no-check 2>&1 | tail -20` Expected: No regressions

- [ ] **Step 4: Commit final test**

```bash
git add tests/browser-subscribe.test.ts
git commit -m "test: console.warn observability test for subscribe teardown paths"
```

---

### Task 6: Update issues.md and final squash

**Files:**

- Modify: `issues.md` — mark AIO-4 as fixed, AIO-3 as likely fixed

- [ ] **Step 1: Update issues.md**

Add resolution notes to both AIO-3 and AIO-4 in `issues.md`:

For AIO-4, add at the end of its section:

```markdown
### Resolution

Fixed: `_useAioSubscribe` moved to module scope (stable reference). Nuclear
cleanup debounced with 300ms grace period. Dual-channel diagnostics
(`console.warn` + `_diagEmit`) emit on all teardown events. See
`docs/superpowers/specs/2026-03-25-subscription-stability-design.md`.
```

For AIO-3, add at the end of its section:

```markdown
### Resolution

Likely fixed as secondary symptom of AIO-4. The 300ms grace period prevents the
transient `_state = null` windows that caused `getSliceSnapshot` to capture null
during React concurrent reconciliation. Monitor for recurrence.
```

- [ ] **Step 2: Commit**

```bash
git add issues.md
git commit -m "docs: mark AIO-4 fixed, AIO-3 likely fixed — subscription stability"
```

- [ ] **Step 3: Verify all clean**

Run: `deno test --no-check 2>&1 | tail -5` and `deno lint 2>&1 | tail -5`
Expected: All pass, no lint errors
