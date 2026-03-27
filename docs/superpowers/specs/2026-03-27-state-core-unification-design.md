# State Core Unification — Design Spec

**Date:** 2026-03-27
**Status:** Approved
**Scope:** Extract framework-agnostic state core from browser.ts, create adapter pattern for AIR + React

---

## Problem

`browser.ts` (2400 lines) is the React adapter with state management, connection logic, delta handling, vitals, devtools, and time-travel all in one file. `aio-hooks.ts` (613 lines) duplicates the delta pipeline with signal-based hooks for the AIO native renderer (AIR). Two delta pipelines = two places state can diverge, two places bugs hide.

The AIR renderer cannot use `useFeature`/`useAio` from `browser.ts` because they depend on React's `useSyncExternalStore`. The signal-based versions in `aio-hooks.ts` aren't exported. Users literally cannot connect AIR to AIO server state.

Additionally, any future framework (Vue, Svelte) would need yet another copy of the delta pipeline.

## Goal

One state management core. Two adapter layers (AIR, React). Any framework can consume AIO state by writing a thin adapter. Zero migration cost for existing React apps.

## Architecture

```
state-core.ts              ← framework-agnostic, environment-agnostic
                              signals, delta, connection, subs, send

browser.ts                 ← unified browser client (slim, no React)
                              WS/IPC init, hot reload, IndexedDB offline,
                              DOM status, feature() stub
                              re-exports useFeature/useAio from configured adapter

adapters/
  air.ts                   ← useFeature/useAio via direct signal reads (~50 lines)
  react.ts                 ← useFeature/useAio via useSyncExternalStore (~150 lines)

time-travel.ts             ← extracted from browser.ts, pure DOM, browser-only

# Unchanged:
signal.ts                  ← reactivity primitives (signal, computed, effect, batch)
aio-renderer.ts            ← AIR renderer (mount, hydrate, per-component tracking)
vdom.ts                    ← virtual DOM engine
vitals/                    ← observability (already framework-agnostic)
devtools.ts                ← already framework-agnostic
```

### Deleted Files

- `aio-hooks.ts` — replaced by `state-core.ts` + `adapters/air.ts`
- `listeners.ts` — replaced by signal subscriptions in state-core

---

## Layer 1: `state-core.ts`

Framework-agnostic canonical store. No React imports. No DOM imports. Pure TypeScript + signals.

### Owns

- `_stateSignal: Signal<Record<string, any>>` — full app state
- `_featureSignals: Map<string, Signal<any>>` — per-feature state signals
- `_connected: Signal<boolean>` — connection status
- `_idMaps: Map<string, { ids, order }>` — identity-keyed array tracking
- Delta pipeline: `_applyPatch`, `_applyArrPatch`, `_deepMerge`, `_applyDelete`, `_buildIdMaps`
- Subscription tracking: `_accessedPaths`, `_collapsePaths`, `_scheduleSyncSubs`
- Send logic: `_send`, offline queue (in-memory), action tagging
- `_BLOCKED_KEYS` sanitization (proto poisoning defense)
- `_preserveArrayRefs` (structural sharing for non-identity arrays)
- Filtered state merging (`$f` marker handling)

### Public API

```ts
// ── Connection lifecycle ─────────────────────────────────
export interface ConnectionConfig {
  url?: string;
  ipc?: AioIPC;
  token?: string;
}

export function initConnection(config: ConnectionConfig): void
export function destroyConnection(): void
export function ready(): Promise<void>

// ── State access (signal-based) ──────────────────────────
export function getStateSignal(): Signal<Record<string, any>>
export function getFeatureSignal(name: string, fallback?: any): Signal<any>
export function getConnectedSignal(): Signal<boolean>

// ── Actions ──────────────────────────────────────────────
export function send(action: { type: string; payload?: unknown }): void
export function createSendProxy(featureName: string, ref: FeatureRef): Record<string, (...args: unknown[]) => void>

// ── Subscription tracking ────────────────────────────────
export function trackPath(path: string): void

// ── Signal subscription bridge (for React adapter) ───────
export function subscribeToState(callback: () => void): () => void
export function subscribeToFeature(name: string, callback: () => void): () => void

// ── Testing ──────────────────────────────────────────────
export function _injectState(state: Record<string, any>): void
export function _injectDelta(delta: { $p?: any; $d?: string[]; $f?: number }): void
export function _getState(): Record<string, any>
export function _reset(): void
```

### Does NOT own

- React imports
- DOM manipulation
- Browser detection / `window` access
- Vitals / devtools / time-travel
- Hot reload signals (`__reload`, `__css`)
- IndexedDB persistence

### Message handling

`state-core.ts` exposes a `handleMessage(data: unknown): void` function. The browser layer (WS `onmessage` / IPC `onMessage`) calls it. State-core processes:

- Full state (first message, or no `$p`/`$f` marker)
- Delta patches (`$p` + optional `$d`)
- Filtered state (`$f: 1`)

It does NOT process browser signals (`__reload`, `__css`, `__boot`, `__click`, `__tt:`, `__diag:`, `__vitals:`). The browser layer handles those before passing to state-core.

### Connection management

State-core owns the abstract connection lifecycle but NOT the transport. It exposes:

```ts
export function setTransport(transport: Transport): void

export interface Transport {
  send(data: string): void;
  close(): void;
  readonly connected: boolean;
}
```

`browser.ts` creates the WebSocket/IPC transport and registers it. State-core uses it for `send()` and subscription messages. This keeps WS/IPC browser-specific code out of state-core.

---

## Layer 2: `browser.ts` — Unified Browser Client

Slim. ~400 lines. No React. No AIR. Browser-environment integration.

### Keeps (from current browser.ts)

- WS connection setup (URL construction, exponential backoff with jitter, reconnect)
- IPC connection setup (Electron bridge)
- Browser signal handling (`__reload` → page reload, `__css` → stylesheet swap, `__boot` → boot ID detection)
- DOM status overlay (`_showStatus`, `_hideStatus`)
- IndexedDB offline queue persistence (`_openIDB`, `_loadOfflineQueue`, `_saveOfflineAction`)
- `feature()` browser stub (builds action/state catalogs for `useFeature`)
- Hot-module coordination

### New responsibility

- Creates WS/IPC `Transport` and registers with state-core via `setTransport()`
- Filters incoming messages: browser signals handled locally, state messages forwarded to `state-core.handleMessage()`
- Re-exports `useFeature`/`useAio` from the configured adapter

### Adapter selection

The AIO dev server already knows the renderer config. When transpiling/bundling, it resolves the adapter import:

```ts
// browser.ts — the re-export line
// In the built bundle, this resolves to adapters/react.ts or adapters/air.ts
// based on the renderer config in aio.run({ ui: { renderer: "aio" | "react" } })
export { useFeature, useAio } from "./adapters/react.ts";  // or air.ts
```

The server's transpiler rewrites this import at serve/build time. The mechanism: `server.ts` already switches `jsxImportSource` based on `renderer` config (line 226-228). The same conditional extends to adapter resolution — when `renderer === "aio"`, the browser bundle imports from `adapters/air.ts`; when `renderer === "react"` (default), from `adapters/react.ts`. This is a build-time decision, not runtime — the unused adapter is never bundled.

---

## Layer 3: Adapters

### `adapters/air.ts` (~50 lines)

Direct signal reads. Nearly zero code — signals auto-track in AIR's per-component scope.

```ts
import { getFeatureSignal, getStateSignal, getConnectedSignal, trackPath, createSendProxy, send } from "../state-core.ts";
import type { FeatureRef } from "../state-core.ts";

export function useFeature<S = unknown>(ref: FeatureRef): { state: S; send: Record<string, (...args: unknown[]) => void> } {
  const name = ref.__aio.id;
  const sig = getFeatureSignal(name, ref.__aio.state);
  trackPath(name);

  // Proxy reads sig.value → auto-tracked by AIR renderer's component scope
  const state = new Proxy({} as S, {
    get(_, prop: string | symbol) {
      if (typeof prop === "symbol") return undefined;
      const s = sig.value;  // tracked read
      if (s == null) return ref.__aio.state?.[prop];
      return (s as Record<string, unknown>)[prop];
    },
    ownKeys() { return Object.keys(sig.value ?? {}); },
    has(_, prop) { return typeof prop === "string" && prop in (sig.value ?? {}); },
    getOwnPropertyDescriptor(_, prop) {
      if (typeof prop === "symbol") return undefined;
      const s = sig.value;
      if (!s || !(prop in s)) return undefined;
      return { configurable: true, enumerable: true, value: s[prop as string] };
    },
  });

  return { state, send: createSendProxy(name, ref) };
}

export function useAio<S = unknown>(): { state: S; send: typeof send } {
  trackPath("*");
  const sig = getStateSignal();
  const state = new Proxy({} as S, {
    get(_, prop: string | symbol) {
      if (typeof prop === "symbol") return undefined;
      return (sig.value as Record<string, unknown>)[prop as string];
    },
    ownKeys() { return Object.keys(sig.value); },
    has(_, prop) { return typeof prop === "string" && prop in sig.value; },
    getOwnPropertyDescriptor(_, prop) {
      if (typeof prop === "symbol") return undefined;
      const s = sig.value;
      if (!(prop in s)) return undefined;
      return { configurable: true, enumerable: true, value: s[prop as string] };
    },
  });
  return { state, send };
}

export function useLocal<T>(initial: T): { readonly local: T; set: (next: T) => void } { ... }
export function useConnected(): boolean { return getConnectedSignal().value; }
```

### `adapters/react.ts` (~150 lines)

Bridges signals to React via `useSyncExternalStore`.

```ts
import { useSyncExternalStore, useCallback } from "react";
import { getFeatureSignal, getStateSignal, subscribeToState, subscribeToFeature, trackPath, createSendProxy, send } from "../state-core.ts";
import type { FeatureRef } from "../state-core.ts";

export function useFeature<S = unknown>(
  ref: FeatureRef,
  options?: { fallback?: S },
): { state: S; send: Record<string, (...args: unknown[]) => void>; status?: string } {
  const name = ref.__aio.id;
  trackPath(name);

  const subscribe = useCallback(
    (cb: () => void) => subscribeToFeature(name, cb),
    [name],
  );
  const getSnapshot = useCallback(
    () => getFeatureSignal(name).peek(),
    [name],
  );

  const featureState = useSyncExternalStore(subscribe, getSnapshot, () => null);

  // Merge with fallback/defaults (AIO-29 defense)
  const defaults = options?.fallback ?? ref.__aio.state;
  let resolved: S;
  if (featureState == null) {
    resolved = (defaults ?? featureState) as S;
  } else if (defaults && typeof featureState === "object" && typeof defaults === "object") {
    resolved = { ...defaults, ...featureState } as S;
  } else {
    resolved = featureState as S;
  }

  const status = resolved ? (resolved as any)._status : undefined;
  return { state: resolved, send: createSendProxy(name, ref), status };
}

export function useAio<S = unknown>(): { state: S; send: typeof send } {
  trackPath("*");
  const state = useSyncExternalStore(subscribeToState, () => getStateSignal().peek(), () => null);
  return { state: state as S, send };
}
```

### Adapter contract

Both adapters export the same API surface:

```ts
export function useFeature<S>(ref: FeatureRef, options?): { state: S; send: ... }
export function useAio<S>(): { state: S; send: ... }
export function useLocal<T>(initial: T): { local: T; set: ... }
export function useConnected(): boolean
```

Any future adapter (Vue, Svelte) implements the same exports.

---

## Layer 4: Extracted Modules

### `time-travel.ts`

Extracted from browser.ts. Pure DOM manipulation. No React, no AIR. Subscribes to state-core signals for state snapshots. Browser-only (checks `typeof window`).

### `vitals/`

Already framework-agnostic. No changes needed. Adapters or browser.ts can wire render meters.

### `devtools.ts`

Already framework-agnostic. No changes needed.

---

## Signal Subscribe Bridge

React's `useSyncExternalStore` needs `subscribe(callback) → unsubscribe`. AIO signals don't have this natively. State-core adds:

```ts
// Subscribe to any state change (for useAio)
export function subscribeToState(callback: () => void): () => void {
  // Internally: effect(() => { _stateSignal.value; callback(); })
  // Returns dispose function
}

// Subscribe to a specific feature (for useFeature)
export function subscribeToFeature(name: string, callback: () => void): () => void {
  // Internally: effect(() => { getFeatureSignal(name).value; callback(); })
  // Returns dispose function
}
```

This is the only new primitive. Everything else composes from existing signals.

---

## Migration Path

### For existing React apps

Zero changes. `import { useFeature } from "aio"` continues to work. `mod.ts` → `browser.ts` → `adapters/react.ts`. Same API, same behavior.

### For new AIR apps

```tsx
import { initAio, useFeature, mount } from "aio";
import { counter } from "./features/counter.ts";

initAio({ url: "http://localhost:3000" });

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

Same `useFeature`. Same `{ state, send }`. Same TSX. Just works.

### For future framework adapters (not shipped, but possible)

```ts
// adapters/vue.ts (hypothetical, ~50 lines)
import { ref, watchEffect } from "vue";
import { getFeatureSignal, trackPath, createSendProxy } from "../state-core.ts";

export function useFeature(featureRef) {
  const sig = getFeatureSignal(featureRef.__aio.id);
  trackPath(featureRef.__aio.id);
  const state = ref(sig.peek());
  watchEffect(() => { state.value = sig.value; });
  return { state, send: createSendProxy(...) };
}
```

---

## What Moves Where

| Current location | Content | New location |
|-----------------|---------|-------------|
| `browser.ts:260-363` | `_applyPatch` | `state-core.ts` |
| `browser.ts:201-262` | `_applyArrPatch` | `state-core.ts` |
| `browser.ts:554-575` | State variables | `state-core.ts` (as signals) |
| `browser.ts:577-647` | Subscription tracking | `state-core.ts` |
| `browser.ts:1387-1536` | WS `onmessage` state handling | `state-core.ts` (handleMessage) |
| `browser.ts:1709-1719` | `useAio` | `adapters/react.ts` |
| `browser.ts:1983-2059` | `useFeature` | `adapters/react.ts` |
| `browser.ts:1262-1559` | WS connection setup | `browser.ts` (stays, calls state-core) |
| `browser.ts:1083-1245` | IPC connection setup | `browser.ts` (stays, calls state-core) |
| `browser.ts:2412-2468` | `_reset` | Split: state → `state-core._reset`, browser → `browser.ts` |
| `browser.ts` TT panel | Time-travel DOM | `time-travel.ts` |
| `aio-hooks.ts` | Everything | Deleted (replaced by state-core + adapters/air.ts) |
| `listeners.ts` | Listeners class | Deleted (signals replace it) |

---

## Testing Strategy

### Gate

All 167 existing tests must pass. Lint clean. Type check clean.

### New tests

| Module | Tests | Coverage |
|--------|-------|----------|
| `state-core.ts` | Delta application, signal updates, connection lifecycle, subscription tracking, _idMaps, filtered merging, blocked keys, _preserveArrayRefs | Core correctness |
| `adapters/air.ts` | useFeature returns tracked state, useAio tracks all, send dispatches, useLocal works, useConnected tracks | AIR integration |
| `adapters/react.ts` | useSyncExternalStore bridge, subscribe/unsubscribe lifecycle, snapshot consistency, fallback merging | React integration |
| `browser.ts` | Transport registration, message routing (browser signals vs state), hot reload, adapter re-export | Browser integration |

### Regression defense

Existing test files (`tests/browser-subscribe.test.ts`, `tests/delta.test.ts`, etc.) exercise the delta pipeline and subscription behavior. After refactor, they import from new locations but test the same behavior.

---

## Future: Reactive Proxy Syntax

Not in this scope. After unification lands, a `reactive()` convenience wrapper can be added on top of signals:

```tsx
// Future enhancement — sugar over signal()
const state = reactive({ count: 0 });
state.count++;  // instead of signal.set()
```

This would be additive — signals continue to work, `reactive()` is optional sugar.

---

## Success Criteria

1. `useFeature`/`useAio` work in both AIR and React from the same `"aio"` import
2. Single delta pipeline (no duplication)
3. Single connection per app (no dual connections)
4. All 167 tests pass
5. Zero changes to existing React app code
6. `docs/renderer.md` updated with connection pattern
7. Lint + type check clean
