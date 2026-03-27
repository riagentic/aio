# State Core Unification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract framework-agnostic state core from browser.ts, create adapter pattern so AIR and React both consume AIO server state through `useFeature`/`useAio` with zero migration cost.

**Architecture:** Single `state-core.ts` owns signals, delta pipeline, connection transport, subscription tracking. Thin adapters (`adapters/air.ts`, `adapters/react.ts`) bridge state-core signals to framework-specific reactivity. `browser.ts` becomes a slim unified browser client that handles environment concerns (WS/IPC init, hot reload, IndexedDB, DOM status) and delegates to state-core + the configured adapter.

**Tech Stack:** TypeScript, Deno 2.6+, AIO signals (`signal.ts`), esbuild (transpile/bundle)

**Spec:** `docs/superpowers/specs/2026-03-27-state-core-unification-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/state-core.ts` | **CREATE** | Canonical signal store: delta pipeline, feature signals, subscription tracking, send, transport abstraction |
| `src/adapters/air.ts` | **CREATE** | useFeature/useAio/useLocal/useConnected via direct signal reads |
| `src/adapters/react.ts` | **CREATE** | useFeature/useAio/useLocal via useSyncExternalStore bridge |
| `src/time-travel.ts` | **CREATE** | TT panel extracted from browser.ts (pure DOM) |
| `src/browser.ts` | **REFACTOR** | Slim: WS/IPC init, hot reload, IndexedDB, DOM status, feature() stub, re-exports from adapter |
| `src/signal.ts` | **MODIFY** | Add `subscribe()` method to Signal for React bridge |
| `src/aio-hooks.ts` | **DELETE** | Replaced by state-core + adapters/air.ts |
| `src/listeners.ts` | **KEEP** | Still used by time-travel.ts for TT state notifications |
| `tests/state-core.test.ts` | **CREATE** | Delta, signals, subscription tracking tests |
| `tests/adapters-air.test.ts` | **CREATE** | AIR adapter hook tests |
| `docs/renderer.md` | **MODIFY** | Add AIO state connection section |

---

## Task 1: Add `subscribe()` to Signal

React's `useSyncExternalStore` needs `subscribe(callback) → unsubscribe`. Signals don't have this. Add it.

**Files:**
- Modify: `src/signal.ts`
- Test: `tests/signal.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/signal.test.ts`:

```ts
Deno.test("signal: subscribe fires on change", () => {
  const s = signal(0);
  const calls: number[] = [];
  const unsub = s.subscribe(() => calls.push(s.peek()));
  assertEquals(calls, []);  // does NOT fire immediately (unlike effect)
  s.set(1);
  assertEquals(calls, [1]);
  s.set(2);
  assertEquals(calls, [1, 2]);
  s.set(2);  // no-op, same value
  assertEquals(calls, [1, 2]);
  unsub();
  s.set(3);
  assertEquals(calls, [1, 2]);  // unsubscribed
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
  assertEquals(callCount, 2);  // both fire once after batch
  unsub1();
  unsub2();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test tests/signal.test.ts --filter "subscribe" --no-check`
Expected: FAIL — `s.subscribe is not a function`

- [ ] **Step 3: Add subscribe to Signal interface and implementation**

In `src/signal.ts`, add `subscribe` to the `Signal` interface:

```ts
export interface Signal<T> {
  /** Current value (tracked read). */
  readonly value: T;
  /** Read without tracking. */
  peek(): T;
  /** Update value. No-op if Object.is(old, next). */
  set(next: T): void;
  /** Subscribe to changes. Returns unsubscribe. Does NOT fire immediately. */
  subscribe(fn: () => void): () => void;
}
```

In the `SignalImpl` class, add the method:

```ts
subscribe(fn: () => void): () => void {
  this._subscribers.add(fn as unknown as Subscriber);
  return () => { this._subscribers.delete(fn as unknown as Subscriber); };
}
```

Note: `_subscribers` is `Set<Subscriber>` where `Subscriber` has a `_notify()` method. For plain callbacks, we need a wrapper. Create a simple adapter:

```ts
/** Wraps a plain callback as a Subscriber for signal.subscribe(). */
class _CallbackSubscriber implements Subscriber {
  constructor(private _fn: () => void) {}
  _notify(): void { this._fn(); }
  _disposed = false;
}
```

Then in `SignalImpl.subscribe()`:

```ts
subscribe(fn: () => void): () => void {
  const sub = new _CallbackSubscriber(fn);
  this._subscribers.add(sub);
  return () => { this._subscribers.delete(sub); };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test tests/signal.test.ts --no-check`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/signal.ts tests/signal.test.ts
git commit -m "feat(signal): add subscribe() method for external listeners"
```

---

## Task 2: Create `state-core.ts` — Delta Pipeline

Extract the delta handling, identity array tracking, and structural sharing from `browser.ts` into a framework-agnostic module.

**Files:**
- Create: `src/state-core.ts`
- Test: `tests/state-core.test.ts`

- [ ] **Step 1: Write failing tests for state-core delta operations**

Create `tests/state-core.test.ts`:

```ts
import { assertEquals } from "jsr:@std/assert";
import {
  _injectState,
  _injectDelta,
  _getState,
  _reset,
  getFeatureSignal,
  getStateSignal,
} from "../src/state-core.ts";

Deno.test("state-core: _injectState sets full state and feature signals", () => {
  _reset();
  _injectState({ counter: { count: 5 }, todo: { items: [] } });
  assertEquals(_getState().counter.count, 5);
  assertEquals(getFeatureSignal("counter").peek().count, 5);
  assertEquals(getFeatureSignal("todo").peek().items, []);
  _reset();
});

Deno.test("state-core: _injectDelta applies $p patch", () => {
  _reset();
  _injectState({ counter: { count: 0 } });
  _injectDelta({ $p: { counter: { count: 1 } } });
  assertEquals(_getState().counter.count, 1);
  assertEquals(getFeatureSignal("counter").peek().count, 1);
  _reset();
});

Deno.test("state-core: _injectDelta applies $d deletion", () => {
  _reset();
  _injectState({ counter: { count: 0 }, extra: { val: 1 } });
  _injectDelta({ $d: ["extra"] });
  assertEquals(_getState().extra, undefined);
  _reset();
});

Deno.test("state-core: identity array patch ($arr)", () => {
  _reset();
  _injectState({ fleet: { members: [{ id: "a", name: "Alice" }] } });
  _injectDelta({ $p: { fleet: { members: { $arr: true, "$id:a": { name: "Alicia" }, "$id:b": { id: "b", name: "Bob" } } } } });
  const members = _getState().fleet.members;
  assertEquals(members.length, 2);
  assertEquals(members[0].name, "Alicia");
  assertEquals(members[1].name, "Bob");
  _reset();
});

Deno.test("state-core: filtered state merge ($f)", () => {
  _reset();
  _injectState({ counter: { count: 0, extra: "keep" }, todo: { items: [] } });
  _injectDelta({ $f: 1, $p: { counter: { count: 5 } } });
  assertEquals(_getState().counter.count, 5);
  assertEquals(_getState().counter.extra, "keep");  // not overwritten
  assertEquals(_getState().todo.items.length, 0);    // untouched
  _reset();
});

Deno.test("state-core: blocked keys rejected", () => {
  _reset();
  _injectState({});
  _injectDelta({ $p: { __proto__: { bad: true }, counter: { count: 1 } } });
  assertEquals(_getState().counter.count, 1);
  assertEquals((_getState() as any).__proto__?.bad, undefined);
  _reset();
});

Deno.test("state-core: _reset clears all state", () => {
  _reset();
  _injectState({ counter: { count: 5 } });
  _reset();
  assertEquals(_getState(), {});
  _reset();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test tests/state-core.test.ts --no-check`
Expected: FAIL — module `../src/state-core.ts` not found

- [ ] **Step 3: Create state-core.ts with delta pipeline**

Create `src/state-core.ts`. Extract from `browser.ts` lines 72-363 (array refs, _shallowEqual, _applyArrPatch, _applyPatch) and from `aio-hooks.ts` (signal-based state management). The unified version:

```ts
// AIO State Core — framework-agnostic canonical store.
// Owns: state signals, delta pipeline, subscription tracking, send, transport.
// Does NOT own: React, DOM, browser detection, vitals, devtools.

import { signal, batch, type Signal } from "./signal.ts";

// ── Types ───────────────────────────────────────────────────────────

export interface AioIPC {
  send: (json: string) => void;
  ready: () => void;
  onMessage: (fn: (line: string) => void) => void;
  onOpen: (fn: () => void) => void;
  onClose: (fn: () => void) => void;
}

export interface FeatureRef {
  __aio: {
    id: string;
    actionKeys?: string[];
    actions?: Record<string, (...args: unknown[]) => { type: string; payload?: unknown }>;
    state?: unknown;
  };
}

export interface Transport {
  send(data: string): void;
  close(): void;
}

// ── Constants ───────────────────────────────────────────────────────

const _BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const OFFLINE_MAX_QUEUE = 100;

// ── State signals ───────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
let _stateSignal: Signal<Record<string, any>> = signal({});
// deno-lint-ignore no-explicit-any
const _featureSignals = new Map<string, Signal<any>>();
const _connected: Signal<boolean> = signal(false);
let _initialStateReceived = false;

// deno-lint-ignore no-explicit-any
let _readyResolve: ((state: any) => void) | null = null;
// deno-lint-ignore no-explicit-any
const _readyPromise = new Promise<any>((resolve) => { _readyResolve = resolve; });

// ── Transport ───────────────────────────────────────────────────────

let _transport: Transport | null = null;

export function setTransport(transport: Transport | null): void {
  _transport = transport;
}

export function getConnected(): Signal<boolean> { return _connected; }
export function setConnected(v: boolean): void { _connected.set(v); }

// ── Identity-keyed arrays ───────────────────────────────────────────

const _idMaps = new Map<string, { ids: Map<string, unknown>; order: string[] }>();

// Copy _rebuildIdMaps, _applyArrPatch from browser.ts lines 171-256
// Copy _shallowEqual from browser.ts lines 147-161
// Copy _preserveArrayRefs from browser.ts lines 105-141
// Copy _applyPatch from browser.ts lines 260-363
// (Full implementations — extracted verbatim with _BLOCKED_KEYS checks)

// ── State access ────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
export function getStateSignal(): Signal<Record<string, any>> { return _stateSignal; }

// deno-lint-ignore no-explicit-any
export function getFeatureSignal(name: string, fallback?: any): Signal<any> {
  let sig = _featureSignals.get(name);
  if (!sig) {
    sig = signal(fallback);
    _featureSignals.set(name, sig);
  }
  return sig;
}

export function getConnectedSignal(): Signal<boolean> { return _connected; }

// ── Subscription tracking ───────────────────────────────────────────

export const _accessedPaths = new Set<string>();
let _subsTimer: ReturnType<typeof setTimeout> | null = null;
let _currentSubs: string[] = [];

export function trackPath(path: string): void {
  _accessedPaths.add(path);
  _scheduleSyncSubs();
}

export function collapsePaths(paths: Set<string> | string[]): string[] {
  const sorted = [...paths].sort();
  const result: string[] = [];
  for (const path of sorted) {
    if (result.length > 0) {
      const last = result[result.length - 1];
      if (path.startsWith(last + ".")) continue;
    }
    result.push(path);
  }
  return result;
}

export function cancelSubsTimer(): void {
  if (_subsTimer !== null) {
    clearTimeout(_subsTimer);
    _subsTimer = null;
  }
}

function _scheduleSyncSubs(): void {
  if (_subsTimer !== null) return;
  _subsTimer = setTimeout(() => {
    _subsTimer = null;
    if (_accessedPaths.size === 0) return;
    const collapsed = collapsePaths(_accessedPaths);
    if (
      collapsed.length !== _currentSubs.length ||
      collapsed.some((s, i) => s !== _currentSubs[i])
    ) {
      _currentSubs = collapsed;
      _sendSubs(collapsed);
    }
  }, 16);
}

function _sendSubs(subs: string[]): void {
  const msg = "__subs:" + JSON.stringify(subs);
  if (_transport) _transport.send(msg);
}

// ── Message handling ────────────────────────────────────────────────

/** Process a state message from the server. Returns true if handled. */
// deno-lint-ignore no-explicit-any
export function handleMessage(data: any): boolean {
  // First message = full state
  if (!_initialStateReceived) {
    _initialStateReceived = true;
    _applyFullState(data);
    if (_readyResolve) { _readyResolve(data); _readyResolve = null; }
    return true;
  }

  // Delta
  if (data.$p || data.$d) {
    _applyDelta(data);
    return true;
  }

  // Filtered state ($f marker)
  if (data.$f) {
    _applyFiltered(data);
    return true;
  }

  // Full state replacement (no markers, not first)
  _applyFullState(data);
  return true;
}

// deno-lint-ignore no-explicit-any
function _applyFullState(state: Record<string, any>): void {
  batch(() => {
    _stateSignal.set(state);
    _idMaps.clear();
    for (const [key, value] of Object.entries(state)) {
      getFeatureSignal(key, value).set(value);
      _buildIdMaps(key, value);
    }
  });
  // Clear accessed paths on full state — components re-render and re-populate
  _accessedPaths.clear();
  cancelSubsTimer();
}

// (Include _applyDelta, _applyFiltered, _applyPatch, _applyArrPatch,
//  _buildIdMaps, _shallowEqual, _preserveArrayRefs, _deepMerge —
//  all extracted from browser.ts with signal updates added)

// ── Send ────────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
const _offlineQueue: any[] = [];

// deno-lint-ignore no-explicit-any
export function send(action: { type: string; payload?: any }): void {
  const tagged = { ...action, _source: "UI" };
  const json = JSON.stringify(tagged);
  if (_transport) {
    _transport.send(json);
  } else if (_offlineQueue.length < OFFLINE_MAX_QUEUE) {
    _offlineQueue.push(tagged);
  }
}

export function flushOfflineQueue(): void {
  if (!_transport) return;
  for (const action of _offlineQueue) {
    _transport.send(JSON.stringify(action));
  }
  _offlineQueue.length = 0;
}

export function createSendProxy(featureName: string, ref: FeatureRef): Record<string, (...args: unknown[]) => void> {
  if (ref.__aio.actions && ref.__aio.actionKeys) {
    const obj: Record<string, (...args: unknown[]) => void> = {};
    for (const key of ref.__aio.actionKeys) {
      const creator = ref.__aio.actions[key];
      if (typeof creator === "function") {
        obj[key] = (...args: unknown[]) => {
          const action = creator(...args);
          send({ ...action, _source: "UI" } as { type: string; payload?: unknown });
        };
      }
    }
    return obj;
  }
  // Fallback: dynamic proxy
  return new Proxy({} as Record<string, (...args: unknown[]) => void>, {
    get(_target, methodName: string) {
      return (...args: unknown[]) => {
        send({ type: `${featureName}:${methodName}`, payload: { args } });
      };
    },
  });
}

// ── Lifecycle ───────────────────────────────────────────────────────

export function ready(): Promise<unknown> { return _readyPromise; }

export function isInitialStateReceived(): boolean { return _initialStateReceived; }

// ── Reset / Testing ─────────────────────────────────────────────────

export function _reset(): void {
  _stateSignal = signal({});
  _featureSignals.clear();
  _connected.set(false);
  _initialStateReceived = false;
  _idMaps.clear();
  _accessedPaths.clear();
  cancelSubsTimer();
  _currentSubs = [];
  _offlineQueue.length = 0;
  _transport = null;
  _readyResolve = null;
}

// deno-lint-ignore no-explicit-any
export function _injectState(state: Record<string, any>): void {
  _applyFullState(state);
  _initialStateReceived = true;
}

// deno-lint-ignore no-explicit-any
export function _injectDelta(delta: { $p?: any; $d?: string[]; $f?: number }): void {
  if (delta.$f) {
    _applyFiltered(delta);
  } else {
    _applyDelta(delta);
  }
}

// deno-lint-ignore no-explicit-any
export function _getState(): Record<string, any> {
  return _stateSignal.peek();
}
```

Note: The actual implementation must include the full bodies of `_applyPatch`, `_applyArrPatch`, `_shallowEqual`, `_preserveArrayRefs`, `_deepMerge`, `_buildIdMaps`, `_applyDelta`, `_applyFiltered` extracted from `browser.ts` lines 72-363, adapted to update `_featureSignals` on every patch (similar to how `aio-hooks.ts` does it with `batch()`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test tests/state-core.test.ts --no-check`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/state-core.ts tests/state-core.test.ts
git commit -m "feat: create state-core.ts — framework-agnostic canonical store"
```

---

## Task 3: Create `adapters/air.ts`

AIR adapter — `useFeature`/`useAio`/`useLocal`/`useConnected` via direct signal reads.

**Files:**
- Create: `src/adapters/air.ts`
- Test: `tests/adapters-air.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/adapters-air.test.ts`:

```ts
import { assertEquals } from "jsr:@std/assert";
import { signal } from "../src/signal.ts";
import { _injectState, _injectDelta, _reset, getFeatureSignal } from "../src/state-core.ts";
import { useFeature, useAio, useLocal, useConnected } from "../src/adapters/air.ts";

const fakeRef = {
  __aio: {
    id: "counter",
    actionKeys: ["increment"],
    actions: { increment: () => ({ type: "counter:increment" }) },
    state: { count: 0 },
  },
};

Deno.test("air adapter: useFeature reads feature state", () => {
  _reset();
  _injectState({ counter: { count: 42 } });
  const { state } = useFeature(fakeRef);
  assertEquals(state.count, 42);
  _reset();
});

Deno.test("air adapter: useFeature falls back to ref default", () => {
  _reset();
  // No state injected — falls back to ref.__aio.state
  const { state } = useFeature(fakeRef);
  assertEquals(state.count, 0);
  _reset();
});

Deno.test("air adapter: useFeature send returns typed proxy", () => {
  _reset();
  _injectState({ counter: { count: 0 } });
  const { send } = useFeature(fakeRef);
  assertEquals(typeof send.increment, "function");
  _reset();
});

Deno.test("air adapter: useAio reads full state", () => {
  _reset();
  _injectState({ counter: { count: 1 }, todo: { items: [] } });
  const { state } = useAio();
  assertEquals((state as any).counter.count, 1);
  assertEquals((state as any).todo.items.length, 0);
  _reset();
});

Deno.test("air adapter: useLocal holds local state", () => {
  const local = useLocal(false);
  assertEquals(local.local, false);
  local.set(true);
  assertEquals(local.local, true);
});

Deno.test("air adapter: useConnected reads connection signal", () => {
  _reset();
  assertEquals(useConnected(), false);
  _reset();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test tests/adapters-air.test.ts --no-check`
Expected: FAIL — module not found

- [ ] **Step 3: Create adapters/air.ts**

```bash
mkdir -p src/adapters
```

Create `src/adapters/air.ts`:

```ts
// AIR Adapter — signal-based hooks for AIO native renderer.
// useFeature/useAio read from state-core signals directly.
// Signal reads auto-track in AIR's per-component scope.

import { signal } from "../signal.ts";
import {
  getFeatureSignal,
  getStateSignal,
  getConnectedSignal,
  trackPath,
  createSendProxy,
  send,
  type FeatureRef,
} from "../state-core.ts";

/**
 * Subscribe to a feature's server state. Same API as React's useFeature.
 * Reading properties on `state` auto-tracks in the component's signal scope.
 */
export function useFeature<S extends Record<string, unknown> = Record<string, unknown>>(
  ref: FeatureRef,
): { state: S; send: Record<string, (...args: unknown[]) => void> } {
  const name = ref.__aio.id;
  const sig = getFeatureSignal(name, ref.__aio.state);
  trackPath(name);

  const state = new Proxy({} as S, {
    get(_target, prop: string | symbol): unknown {
      if (typeof prop === "symbol") return undefined;
      const s = sig.value; // tracked read
      if (s == null) {
        const fallback = ref.__aio.state as Record<string, unknown> | undefined;
        return fallback ? fallback[prop] : undefined;
      }
      return (s as Record<string, unknown>)[prop];
    },
    ownKeys(): string[] {
      const s = sig.value;
      return s ? Object.keys(s as Record<string, unknown>) : [];
    },
    has(_target, prop: string | symbol): boolean {
      if (typeof prop === "symbol") return false;
      const s = sig.value;
      return s ? prop in (s as Record<string, unknown>) : false;
    },
    getOwnPropertyDescriptor(_target, prop: string | symbol): PropertyDescriptor | undefined {
      if (typeof prop === "symbol") return undefined;
      const s = sig.value;
      if (!s || !(prop in (s as Record<string, unknown>))) return undefined;
      return { configurable: true, enumerable: true, value: (s as Record<string, unknown>)[prop as string] };
    },
  });

  return { state, send: createSendProxy(name, ref) };
}

/**
 * Subscribe to the entire app state. Re-renders when any feature changes.
 * Prefer useFeature() for scoped re-renders.
 */
export function useAio<S extends Record<string, unknown> = Record<string, unknown>>(): {
  // deno-lint-ignore no-explicit-any
  state: S; send: (action: { type: string; payload?: any }) => void;
} {
  trackPath("*");
  const sig = getStateSignal();

  const state = new Proxy({} as S, {
    get(_target, prop: string | symbol): unknown {
      if (typeof prop === "symbol") return undefined;
      return (sig.value as Record<string, unknown>)[prop as string];
    },
    ownKeys(): string[] { return Object.keys(sig.value); },
    has(_target, prop: string | symbol): boolean {
      if (typeof prop === "symbol") return false;
      return prop in sig.value;
    },
    getOwnPropertyDescriptor(_target, prop: string | symbol): PropertyDescriptor | undefined {
      if (typeof prop === "symbol") return undefined;
      const s = sig.value;
      if (!(prop in s)) return undefined;
      return { configurable: true, enumerable: true, value: s[prop as string] };
    },
  });

  return { state, send };
}

/** Client-only local state (not synced to server). */
export function useLocal<T>(initial: T): { readonly local: T; set: (next: T) => void } {
  const sig = signal(initial);
  return {
    get local(): T { return sig.value; },
    set: (next: T) => sig.set(next),
  };
}

/** Connection status (signal-tracked). */
export function useConnected(): boolean {
  return getConnectedSignal().value;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test tests/adapters-air.test.ts --no-check`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/adapters/air.ts tests/adapters-air.test.ts
git commit -m "feat: create adapters/air.ts — AIR signal-based hooks"
```

---

## Task 4: Create `adapters/react.ts`

React adapter — bridges state-core signals to `useSyncExternalStore`.

**Files:**
- Create: `src/adapters/react.ts`

- [ ] **Step 1: Create adapters/react.ts**

```ts
// React Adapter — bridges state-core signals to React via useSyncExternalStore.
// Same useFeature/useAio API as AIR adapter — different reactivity mechanism.

// deno-lint-ignore-file
import {
  useCallback,
  useMemo,
  useSyncExternalStore,
} from "react";
import {
  getFeatureSignal,
  getStateSignal,
  trackPath,
  createSendProxy,
  send,
  type FeatureRef,
} from "../state-core.ts";

// ── Tracking proxy (from browser.ts) ────────────────────────────────
// Deep proxy that records accessed paths for server subscription filtering.

const _BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function _trackingProxy(obj: unknown, parentPath = ""): unknown {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  return new Proxy(obj as Record<string, unknown>, {
    get(target, prop: string | symbol) {
      if (typeof prop === "string" && !_BLOCKED_KEYS.has(prop)) {
        const fullPath = parentPath ? `${parentPath}.${prop}` : prop;
        const value = Reflect.get(target, prop);
        if (value && typeof value === "object" && !Array.isArray(value)) {
          return _trackingProxy(value, fullPath);
        }
        trackPath(fullPath);
        return value;
      }
      return Reflect.get(target, prop);
    },
    ownKeys(target) {
      if (parentPath) trackPath(parentPath);
      return Reflect.ownKeys(target);
    },
  });
}

// ── Feature send cache ──────────────────────────────────────────────

const _featureSendCache = new WeakMap<FeatureRef, Record<string, (...args: unknown[]) => void>>();

function _getCachedSend(ref: FeatureRef): Record<string, (...args: unknown[]) => void> {
  let obj = _featureSendCache.get(ref);
  if (!obj) {
    obj = createSendProxy(ref.__aio.id, ref);
    _featureSendCache.set(ref, obj);
  }
  return obj;
}

// ── Hooks ───────────────────────────────────────────────────────────

/**
 * Subscribe to a feature's server state via React.
 * Same { state, send } contract as AIR adapter.
 */
export function useFeature<S = unknown>(
  ref: FeatureRef,
  options?: { fallback?: S },
): { state: S; send: Record<string, (...args: unknown[]) => void>; status?: string } {
  const name = ref.__aio.id;
  trackPath(name);

  const sig = getFeatureSignal(name, ref.__aio.state);

  const subscribe = useCallback(
    (cb: () => void) => sig.subscribe(cb),
    [name],
  );
  const getSnapshot = useCallback(
    () => sig.peek(),
    [name],
  );

  const featureState = useSyncExternalStore(subscribe, getSnapshot, () => null);

  // Merge with fallback/defaults (AIO-29 defense)
  const defaults = options?.fallback ?? (ref.__aio.state as S | undefined);
  let resolved: S;
  if (featureState == null) {
    resolved = (defaults !== undefined ? defaults : featureState) as S;
  } else if (
    defaults !== undefined &&
    typeof featureState === "object" && !Array.isArray(featureState) &&
    typeof defaults === "object" && !Array.isArray(defaults) && defaults !== null
  ) {
    resolved = { ...(defaults as Record<string, unknown>), ...(featureState as Record<string, unknown>) } as S;
  } else {
    resolved = featureState as S;
  }

  const status = resolved ? (resolved as Record<string, unknown>)._status as string | undefined : undefined;
  return { state: _trackingProxy(resolved, name) as S, send: _getCachedSend(ref), status };
}

/**
 * Subscribe to the entire app state via React.
 * Re-renders on every state change — prefer useFeature for scoped updates.
 */
export function useAio<S = unknown>(): {
  state: S;
  // deno-lint-ignore no-explicit-any
  send: (action: { type: string; payload?: any }) => void;
} {
  trackPath("*");
  const sig = getStateSignal();

  const subscribe = useCallback(
    (cb: () => void) => sig.subscribe(cb),
    [],
  );
  const getSnapshot = useCallback(
    () => sig.peek(),
    [],
  );

  const state = useSyncExternalStore(subscribe, getSnapshot, () => null);
  return { state: _trackingProxy(state) as S, send };
}
```

Note: No unit test for React adapter here — it requires a React DOM environment. The existing `tests/browser-subscribe.test.ts` and other browser tests validate the full stack after wiring in Task 6.

- [ ] **Step 2: Verify types compile**

Run: `deno check src/adapters/react.ts`
Expected: No type errors (may warn about React — that's fine, it's browser-only)

- [ ] **Step 3: Commit**

```bash
git add src/adapters/react.ts
git commit -m "feat: create adapters/react.ts — useSyncExternalStore bridge"
```

---

## Task 5: Extract `time-travel.ts`

Move TT panel from browser.ts into its own file.

**Files:**
- Create: `src/time-travel.ts`
- Modify: `src/browser.ts` (remove TT section, import from time-travel.ts)

- [ ] **Step 1: Create time-travel.ts**

Extract from `browser.ts` lines 754-934 (`_renderTTPanel`, `_bindTTKey`) and TT state variables (lines 669-676: `_ttState`, `_ttListeners`, `_ttPanel`, `_ttPanelVisible`, `_ttKeyBound`).

The new file imports `Listeners` from `./listeners.ts` and state access from `./state-core.ts`.

```ts
// Time-Travel Panel — pure DOM, framework-agnostic, browser-only.
// Extracted from browser.ts. Subscribes to state-core for snapshots.

import { Listeners } from "./listeners.ts";
import { getStateSignal } from "./state-core.ts";

export interface TTMeta { label: string; ts: number }

// ... (full extraction of TT code from browser.ts)
// Export: renderTTPanel, bindTTKey, ttListeners, ttState getter/setter
```

- [ ] **Step 2: Verify it compiles**

Run: `deno check src/time-travel.ts`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/time-travel.ts
git commit -m "refactor: extract time-travel panel to time-travel.ts"
```

---

## Task 6: Refactor `browser.ts` — Slim Unified Client

The big task. Remove delta pipeline, React hooks, TT panel from browser.ts. Wire to state-core and adapters.

**Files:**
- Modify: `src/browser.ts`

- [ ] **Step 1: Add state-core imports to browser.ts**

At the top of `browser.ts`, add:

```ts
import {
  handleMessage,
  setTransport,
  setConnected,
  send as _coreSend,
  flushOfflineQueue,
  _reset as _coreReset,
  getStateSignal,
  getFeatureSignal,
  getConnectedSignal,
  _accessedPaths,
  cancelSubsTimer,
  trackPath,
  collapsePaths,
  type FeatureRef,
  type Transport,
} from "./state-core.ts";
```

- [ ] **Step 2: Remove delta pipeline from browser.ts**

Delete the following sections (now in state-core.ts):
- Lines 72-143: Array ref stats, _preserveArrayRefs (move to state-core)
- Lines 147-161: _shallowEqual (move to state-core)
- Lines 165-363: _idMaps, _rebuildIdMaps, _applyArrPatch, _applyPatch (move to state-core)
- Lines 554-564: State variables (_state, _listeners, etc.) — replaced by state-core signals
- Lines 572-647: _trackingProxy, _collapsePaths, _scheduleSyncSubs (state-core + react adapter)

Replace all `_state` reads with `getStateSignal().peek()`.
Replace all `_listeners.notify(...)` with signal `.set()` calls (handled by state-core).

- [ ] **Step 3: Replace React hooks with adapter re-exports**

Delete:
- Lines 1709-1719: `useAio` implementation
- Lines 1967-2059: `useFeature` implementation
- Lines 977-984: `_useAioSubscribe`
- Lines 1069-1074: `_getSnapshot`, `_getServerSnapshot`

Replace with re-exports:

```ts
// Re-export hooks from configured adapter.
// Build/serve resolves to adapters/react.ts or adapters/air.ts based on renderer config.
export { useFeature, useAio } from "./adapters/react.ts";
```

- [ ] **Step 4: Wire WS/IPC onmessage to state-core.handleMessage**

In `_connect()` (WS) and `_connectIPC()`:

Replace the state-handling portion of `ws.onmessage` with:

```ts
ws.onmessage = (e) => {
  const raw = typeof e.data === "string" ? e.data : "";

  // Browser-only signals — handle locally
  if (raw === "__reload") { location.reload(); return; }
  if (raw.startsWith("__css:")) { _handleCssReload(raw); return; }
  if (raw.startsWith("__boot:")) { _handleBoot(raw); return; }
  if (raw.startsWith("__tt:")) { _handleTT(raw); return; }
  if (raw.startsWith("__vitals:")) { _handleVitals(raw); return; }
  if (raw.startsWith("__diag:")) { _handleDiag(raw); return; }
  if (raw.startsWith("__click:")) { _handleClick(raw); return; }

  // State message — delegate to state-core
  const data = JSON.parse(raw);
  handleMessage(data);
};
```

And register the WS as transport:

```ts
ws.onopen = () => {
  setTransport({ send: (d) => ws.send(d), close: () => ws.close() });
  setConnected(true);
  flushOfflineQueue();
  // ... rest of onopen
};

ws.onclose = () => {
  setTransport(null);
  setConnected(false);
  // ... reconnect logic
};
```

- [ ] **Step 5: Remove TT panel code**

Delete lines 669-676 (TT variables) and 754-934 (_renderTTPanel, _bindTTKey).
Replace with import from `./time-travel.ts`.

- [ ] **Step 6: Slim _reset()**

Replace `_reset()` body: call `_coreReset()` for state cleanup, keep only browser-specific cleanup (DOM, IndexedDB, timers, devtools, TT):

```ts
export function _reset(): void {
  _coreReset();
  _ws?.close();
  _ws = null;
  // ... browser-only cleanup (DOM status, TT panel, devtools, IPC ping timer, IndexedDB)
}
```

- [ ] **Step 7: Run ALL existing tests**

Run: `deno test --no-check`
Expected: ALL 167 tests pass

This is the critical regression gate. If any test fails, the delta pipeline extraction has a bug — fix before continuing.

- [ ] **Step 8: Run lint and type check**

Run: `deno lint src/state-core.ts src/adapters/air.ts src/adapters/react.ts src/browser.ts src/time-travel.ts`
Run: `deno check src/state-core.ts src/adapters/air.ts`

Fix any issues.

- [ ] **Step 9: Commit**

```bash
git add src/browser.ts src/time-travel.ts
git commit -m "refactor: slim browser.ts — delegate state to state-core, hooks to adapters"
```

---

## Task 7: Delete `aio-hooks.ts`

Now replaced by state-core + adapters/air.ts.

**Files:**
- Delete: `src/aio-hooks.ts`
- Modify: `tests/phase3.test.ts` (update imports)

- [ ] **Step 1: Update phase3.test.ts imports**

Replace any `from "../src/aio-hooks.ts"` with equivalent imports from `../src/state-core.ts` and `../src/adapters/air.ts`.

- [ ] **Step 2: Delete aio-hooks.ts**

```bash
git rm src/aio-hooks.ts
```

- [ ] **Step 3: Run tests**

Run: `deno test --no-check`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add tests/phase3.test.ts
git commit -m "refactor: delete aio-hooks.ts — replaced by state-core + adapters/air.ts"
```

---

## Task 8: Update existing test imports

10 test files import from `browser.ts`. Functions that moved to `state-core.ts` need updated imports.

**Files:**
- Modify: `tests/delta.test.ts`
- Modify: `tests/array-delta.test.ts`
- Modify: `tests/aio29-filtered-marker.test.ts`
- Modify: `tests/aio33-state-integrity.test.ts`
- Modify: `tests/hook-proxy-tracking.test.ts`
- Modify: `tests/tracking-proxy.test.ts`
- Modify: `tests/browser-subscribe.test.ts`
- Modify: `tests/projection.test.ts`
- Modify: `tests/sync.test.ts`
- Modify: `tests/router.test.ts`

- [ ] **Step 1: Update delta test imports**

For each test file, check what it imports from `browser.ts`. Functions that moved:
- `_applyPatch` → `state-core.ts`
- `_applyArrPatch` → `state-core.ts`
- `_shallowEqual` → `state-core.ts`
- `_preserveArrayRefs` → `state-core.ts`
- `_trackingProxy` → `adapters/react.ts`
- `_collapsePaths` → `state-core.ts` (as `collapsePaths`)
- `_accessedPaths` → `state-core.ts`
- `_reset` → `state-core.ts`

Update each file's imports accordingly. If a test imports both state-core functions and browser-only functions, it needs imports from both files.

- [ ] **Step 2: Run all tests**

Run: `deno test --no-check`
Expected: ALL 167+ PASS

- [ ] **Step 3: Commit**

```bash
git add tests/
git commit -m "refactor: update test imports for state-core extraction"
```

---

## Task 9: Update server.ts / build.ts for multi-file resolution

The server transpiles `browser.ts` as a single entry. After splitting, esbuild needs to resolve imports to `state-core.ts`, `adapters/*.ts`, `time-travel.ts`.

**Files:**
- Modify: `src/server.ts` (transpile pipeline)
- Modify: `src/build.ts` (prod bundle)

- [ ] **Step 1: Check if esbuild already resolves relative imports**

The `transpile()` function in `server.ts` uses esbuild's `transform` API (single-file, no bundling). Relative imports in `browser.ts` (like `./state-core.ts`) won't be resolved — they'll stay as-is in the output.

For dev mode, the generic `/__aio/*.ts` handler (server.ts:871-895) already serves any `.ts` file from the AIO src/ directory. So `import "./state-core.ts"` in the browser bundle will trigger a separate fetch for `/__aio/state-core.ts`. This works but creates multiple HTTP requests.

For prod mode, `build.ts` uses esbuild's `build` API with `bundle: true`, which resolves all imports. No changes needed.

- [ ] **Step 2: Verify dev mode serves new files**

Check that `/__aio/state-core.ts`, `/__aio/adapters/air.ts`, `/__aio/adapters/react.ts` are all resolvable via the generic handler.

If the handler doesn't support subdirectories (`adapters/`), add support:

In `server.ts` generic `/__aio/` handler, ensure the path resolution handles nested directories safely (no `..` traversal).

- [ ] **Step 3: Add adapter selection to transpile pipeline**

In `server.ts`, when transpiling `browser.ts`, the adapter import needs to resolve to the correct file based on `renderer` config:

```ts
// In transpile() or the /__aio/ui.js handler:
const adapterImport = renderer === "aio"
  ? './adapters/air.ts'
  : './adapters/react.ts';
// Replace the import in browser.ts source before transpiling
source = source.replace(
  /from\s+["']\.\/adapters\/react\.ts["']/,
  `from "${adapterImport}"`,
);
```

- [ ] **Step 4: Run dev server, verify everything loads**

Start dev server and check browser console for import errors. All modules should load.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/build.ts
git commit -m "feat: adapter selection in transpile pipeline based on renderer config"
```

---

## Task 10: Update `docs/renderer.md` — AIO State Connection

Add the missing section showing how to connect AIR to AIO server state.

**Files:**
- Modify: `docs/renderer.md`

- [ ] **Step 1: Add "Connecting to AIO State" section**

After the "Setup" section in renderer.md, add:

```markdown
## Connecting to AIO Server State

AIO's renderer connects to the server's state pipeline with the same hooks React apps use.

### useFeature — Subscribe to a feature

```tsx
import { useFeature, mount } from "aio";
import { counter } from "./features/counter.ts";

const App = () => {
  const { state, send } = useFeature(counter);
  return (
    <div>
      <span>Count: {state.count}</span>
      <button onClick={() => send.increment()}>+</button>
    </div>
  );
};

mount(document.getElementById("root")!, App);
```

`state` is reactive — reading `state.count` in JSX auto-tracks the dependency.
When the server updates the counter feature, only this component re-renders.

`send` has typed methods matching the feature's actions. `send.increment()` dispatches to the server.

### useAio — Subscribe to all state

```tsx
import { useAio } from "aio";

const Dashboard = () => {
  const { state, send } = useAio();
  return (
    <div>
      <span>Counter: {state.counter?.count}</span>
      <span>Todos: {state.todo?.items.length}</span>
    </div>
  );
};
```

Re-renders on any state change. Prefer `useFeature` for scoped updates.

### useLocal — Client-only state

```tsx
import { useLocal } from "aio";

const editing = useLocal(false);

const EditToggle = () => (
  <button onClick={() => editing.set(!editing.local)}>
    {editing.local ? "Cancel" : "Edit"}
  </button>
);
```

Not synced to server. For UI-only state like modals, tabs, form visibility.

### useConnected — Connection status

```tsx
import { useConnected } from "aio";

const StatusBar = () => {
  const connected = useConnected();
  return <div className={connected ? "online" : "offline"}>
    {connected ? "Connected" : "Reconnecting..."}
  </div>;
};
```
```

- [ ] **Step 2: Commit**

```bash
git add docs/renderer.md
git commit -m "docs: add AIO state connection section to renderer.md"
```

---

## Task 11: Final Validation

Full regression pass.

**Files:** None (validation only)

- [ ] **Step 1: Run all tests**

Run: `deno test --no-check`
Expected: ALL tests pass (167 existing + new state-core + adapter tests)

- [ ] **Step 2: Run linter**

Run: `deno lint`
Expected: Clean

- [ ] **Step 3: Run type check**

Run: `deno check src/state-core.ts src/adapters/air.ts`
Expected: Clean

- [ ] **Step 4: Verify file structure**

```bash
ls -la src/state-core.ts src/adapters/air.ts src/adapters/react.ts src/time-travel.ts
# All exist

ls src/aio-hooks.ts 2>/dev/null
# Should not exist (deleted)
```

- [ ] **Step 5: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "chore: final validation — state-core unification complete"
```

---

## Summary — Commit Sequence

| # | Commit | What |
|---|--------|------|
| 1 | `feat(signal): add subscribe()` | Signal subscribe bridge for React |
| 2 | `feat: create state-core.ts` | Canonical store with delta pipeline |
| 3 | `feat: create adapters/air.ts` | AIR signal-based hooks |
| 4 | `feat: create adapters/react.ts` | React useSyncExternalStore bridge |
| 5 | `refactor: extract time-travel.ts` | TT panel in own file |
| 6 | `refactor: slim browser.ts` | Wire to state-core + adapters |
| 7 | `refactor: delete aio-hooks.ts` | Remove duplicate |
| 8 | `refactor: update test imports` | Point tests to new modules |
| 9 | `feat: adapter selection in transpile` | Server picks react/air adapter |
| 10 | `docs: AIO state connection` | renderer.md update |
| 11 | `chore: final validation` | All green |
