# Subscription Stability & Silent Failure Prevention

**Date:** 2026-03-25 **Status:** Draft **Severity:** P0 — complete UI blocker
(constant loading loop) **Component:** `src/browser.ts` — `useAio()`,
`_subscribe`, nuclear cleanup

## Problem

Two related bugs cause a silent, unrecoverable UI failure:

### AIO-4: useAio() unstable subscribe reference (HIGH)

`useAio()` creates a new `_useAioSubscribe` closure on every render (line 1198).
`useSyncExternalStore` detects the changed reference and re-subscribes: calls
old cleanup, then new subscribe. During a page switch:

1. Old page unmounts → `useFeature()` listeners removed from `_listeners`
2. `useAio()` old cleanup runs → removes listener → `_listeners.size === 0`
3. **Nuclear cleanup fires** (line 627-648): `_state = null`,
   `_ipcConnected = false`, IPC/WS closed
4. `useAio()` new subscribe runs → reconnects from scratch (async)
5. App sees `_state === null` → renders `<LoadingScreen />` "Connecting..."
6. Connection re-establishes → next broadcast repeats the cycle

### AIO-3: useFeature() returns null after extended runtime (MEDIUM)

Secondary symptom of AIO-4. The periodic `_state = null` windows caused by
nuclear cleanups are captured by React concurrent reconciliation in
`useFeature()`'s `getSliceSnapshot`. Once captured, the component shows
"Loading..." and never recovers.

### The worst part: total silence

The nuclear cleanup — the most destructive event in the entire system — emits
zero diagnostics. No `console.warn`, no `_diagEmit()`, no errors. The app breaks
and the developer stares at a clean console. The diagnostic bus, vitals, render
storm detection all exist — but the one event that matters most is completely
invisible.

## Design

Three-layer fix: stabilize the reference, harden cleanup, make failures loud.

### Layer 1: Stabilize `_useAioSubscribe` at Module Scope

Move `_useAioSubscribe` from inside `useAio()` body to module scope, matching
the pattern already used by `useFeature()` (which passes `_subscribe` directly).

**Before** (inside function — new closure every render):

```typescript
export function useAio<S = unknown>() {
  const _useAioSubscribe = (onStoreChange: () => void): (() => void) => {
    _useAioActiveCount++;
    const unsub = _subscribe(onStoreChange);
    return () => { _useAioActiveCount--; unsub(); };
  };
  const state = useSyncExternalStore(_useAioSubscribe, ...);
}
```

**After** (module scope — stable reference):

```typescript
/** Stable subscribe for useAio() — wraps _subscribe with active-count tracking */
const _useAioSubscribe = (onStoreChange: () => void): () => void => {
  _useAioActiveCount++;
  const unsub = _subscribe(onStoreChange);
  return () => {
    _useAioActiveCount--;
    unsub();
  };
};

export function useAio<S = unknown>() {
  // ... warning logic unchanged ...
  const state = useSyncExternalStore(
    _useAioSubscribe,
    _getSnapshot,
    _getServerSnapshot,
  );
  return { state: state as S, send: _send };
}
```

**Why:** `useSyncExternalStore` compares subscribe function by reference. Stable
reference = no re-subscription = no transient listener gap = no nuclear cleanup
trigger.

### Layer 2: 300ms Grace Period on Nuclear Cleanup

Replace the instant nuclear cleanup with a debounced version. When
`_listeners.size` hits 0, start a 300ms timer. If listeners re-attach before it
fires, cancel. If not, execute full teardown.

**New module-level state:**

```typescript
let _cleanupTimer: ReturnType<typeof setTimeout> | null = null;
let _listenerHighWater = 0; // peak listener count since last teardown
```

**Subscribe entry — track high-water mark:**

```typescript
function _subscribe(onStoreChange: () => void): () => void {
  const unsub = _listeners.add(() => { ... });
  // Track peak listener count for diagnostics
  if (_listeners.size > _listenerHighWater) _listenerHighWater = _listeners.size;
  // ... rest unchanged
}
```

**Note:** We do NOT cancel the cleanup timer on new subscribe. The timer runs
and checks `_listeners.size` when it fires — if listeners recovered, it emits
"teardown averted"; if still zero, it executes full teardown. The `clearTimeout`
in the unsubscribe path handles rapid unsub cycles (resets timer on each new
zero-listener event).

**Unsubscribe path — debounced cleanup:**

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
          `[aio] teardown — no listeners for 300ms (peak was ${peakCount}). ` +
            `Closing connection, clearing state.`,
        );
        _diagEmit({
          type: "teardown",
          severity: "warning",
          source: "browser",
          message: "Full teardown — no listeners remained after grace period",
          detail: { graceMs: 300, peakListenerCount: peakCount },
        });
        // Execute nuclear cleanup — all existing logic preserved verbatim:
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
        // Event listener cleanup (lines 639-647 preserved verbatim)
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
        // Transient gap — listeners recovered
        console.warn(
          `[aio] teardown averted — listeners dropped to 0 but recovered ` +
            `to ${_listeners.size} within 300ms`,
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

**Why 300ms:** React concurrent reconciliation + page switch typically resolves
in ~16ms but can stretch under load. `syncIntervalMs: 250` means 4
broadcasts/sec. 300ms is conservative enough for worst-case heavy Electron apps
(14 features, 189 members) while still being imperceptible for legitimate
teardown (tab close).

**Semantic distinction:** The timer inherently disambiguates "transient gap"
(React re-subscription, hot reload, concurrent mode) from "real teardown" (app
unmount, tab close). If listeners come back within 300ms → transient. If not →
real.

### Layer 3: Dual-Channel Diagnostics

Three critical events, each emitting both `console.warn` (visible in
browser/Electron devtools without AIO tooling) and `_diagEmit` (structured,
feeds vitals/devtools/overlay):

| Event            | console.warn                                           | _diagEmit type           | When                                    |
| ---------------- | ------------------------------------------------------ | ------------------------ | --------------------------------------- |
| Full teardown    | `[aio] teardown — no listeners for 300ms (peak was N)` | `teardown`               | Grace period expired, executing cleanup |
| Teardown averted | `[aio] teardown averted — recovered to N within 300ms` | `teardown-averted`       | Listeners dropped to 0 but re-attached  |
| State nullified  | (part of teardown message)                             | (part of teardown event) | `_state` set to null during teardown    |

**Design principle:** If the client has issues, you see them in the browser
console. Period. No opt-in, no flags, no tooling required.

## Test Plan

Nine test cases covering correctness, edge cases, regression, and observability:

### Stable reference

1. **Module-scoped reference:** `_useAioSubscribe` is the same reference across
   multiple accesses — no re-creation per render
2. **No re-subscription on re-render:** calling `useAio()` multiple times uses
   the same stable subscribe function

### Grace period — cancellation

3. **Transient gap recovery:** listeners drop to 0, new listener attaches within
   300ms → cleanup does NOT fire, `_state` intact, connection alive
4. **Timer reset on rapid cycles:** two rapid unsubscribe/resubscribe cycles
   back-to-back — timer resets, doesn't stack
5. **`teardown-averted` fires:** diagnostic emits on cancellation path

### Grace period — full teardown

6. **Legitimate teardown after 300ms:** listeners at 0, no re-attachment, after
   300ms: `_state = null`, connection closed, `teardown` diagnostic emits
7. **Post-teardown reconnection:** after teardown completes, new `_subscribe`
   call cleanly reconnects — verify `_closed` is reset to `false` (no half-dead
   state)

### Regression

8. **No instant nuclear cleanup:** unsubscribe all listeners, immediately verify
   `_state` is still non-null (must wait for timer)

### Observability

9. **`console.warn` fires:** spy on `console.warn`, assert messages fire with
   expected substrings for both teardown and teardown-averted paths

### What we don't test

- Browser/Electron E2E — these are unit tests with fake timers and the existing
  `Listeners` class
- `useFeature()` — already uses stable `_subscribe`, unaffected by this change

## Files Modified

| File                              | Change                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| `src/browser.ts`                  | Move `_useAioSubscribe` to module scope, debounce nuclear cleanup, add diagnostics |
| `tests/browser-subscribe.test.ts` | New — 9 test cases per test plan                                                   |

## Risk Assessment

| Risk                                    | Mitigation                                                                               |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| Grace period delays legitimate teardown | 300ms is imperceptible for tab close / app unmount                                       |
| Timer leak if cleanup never fires       | Timer cleared on new subscribe; cleared on teardown execution                            |
| `_useAioActiveCount` desync             | Counter logic unchanged — only moved to module scope, same increment/decrement semantics |
| Existing tests break                    | No API changes — `useAio()` and `useFeature()` signatures identical                      |
