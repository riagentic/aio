# AIR Import Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the monolith `mod.ts` into three clean subpaths (`aio`, `aio/air`, `aio/react`) with React migration compat hooks in `aio/air`.

**Architecture:** New barrel files `src/air.ts` and `src/react.ts` re-export from existing `browser-air.ts` and `browser.ts` respectively, plus base `mod.ts`. A new `src/compat.ts` provides `useState`, `useEffect`, `useCallback`, `useMemo` as signal-backed shims with dev-mode hints. `mod.ts` gets trimmed to server/protocol only.

**Tech Stack:** Deno 2.6+, TypeScript, signals, AIR renderer

---

## File Map

| File | Role | Action |
|------|------|--------|
| `src/compat.ts` | React migration compat hooks | **Create** (~80 lines) |
| `src/air.ts` | AIR entry point barrel | **Create** (~80 lines) |
| `src/react.ts` | React entry point barrel | **Create** (~40 lines) |
| `mod.ts` | Base entry — server/protocol only | **Modify** (strip renderer exports) |
| `deno.json` | Package exports | **Modify** (add `./air`, `./react`) |
| `tests/compat.test.ts` | Compat hook tests | **Create** |
| `tests/air-entry.test.ts` | AIR barrel export verification | **Create** |
| `tests/headless-import.test.ts` | Headless base import test | **Create** |

---

### Task 1: Create `src/compat.ts` — React migration compat hooks

**Files:**
- Create: `src/compat.ts`
- Test: `tests/compat.test.ts`

- [ ] **Step 1: Write failing tests for compat hooks**

Create `tests/compat.test.ts`:

```ts
// deno-lint-ignore-file
import { assertEquals, assertExists } from "@std/assert";
import { _setDocument, _unmount, mount } from "../src/aio-renderer.ts";
import { h } from "../src/vdom.ts";

// Import compat hooks
import { useState, useEffect, useCallback, useMemo } from "../src/compat.ts";

// Minimal DOM shim
function createDoc() {
  const els: Record<string, any> = {};
  return {
    createElement(tag: string) {
      const el: any = {
        tagName: tag.toUpperCase(),
        childNodes: [],
        style: {},
        _attrs: {} as Record<string, string>,
        _listeners: {} as Record<string, Function>,
        appendChild(c: any) { el.childNodes.push(c); c.parentNode = el; return c; },
        removeChild(c: any) {
          const i = el.childNodes.indexOf(c);
          if (i >= 0) el.childNodes.splice(i, 1);
          c.parentNode = null;
          return c;
        },
        insertBefore(c: any, ref: any) {
          const i = ref ? el.childNodes.indexOf(ref) : el.childNodes.length;
          el.childNodes.splice(i, 0, c);
          c.parentNode = el;
          return c;
        },
        replaceChild(newC: any, oldC: any) {
          const i = el.childNodes.indexOf(oldC);
          if (i >= 0) { el.childNodes[i] = newC; newC.parentNode = el; oldC.parentNode = null; }
          return oldC;
        },
        setAttribute(k: string, v: string) { el._attrs[k] = v; },
        removeAttribute(k: string) { delete el._attrs[k]; },
        addEventListener(ev: string, fn: Function) { el._listeners[ev] = fn; },
        removeEventListener(ev: string, _fn: Function) { delete el._listeners[ev]; },
        contains(c: any) { return el.childNodes.includes(c); },
        get firstChild() { return el.childNodes[0] || null; },
        get nextSibling() { return null; },
        get textContent() { return el.childNodes.map((c: any) => c.textContent ?? c.nodeValue ?? "").join(""); },
        set textContent(v: string) { el.childNodes = []; },
        nodeType: 1,
        parentNode: null as any,
        ownerDocument: null as any,
      };
      el.ownerDocument = { createElement: createDoc().createElement, createTextNode: createDoc().createTextNode };
      return el;
    },
    createTextNode(text: string) {
      return { nodeType: 3, nodeValue: text, textContent: text, parentNode: null as any, nextSibling: null };
    },
  };
}

Deno.test("compat: useState returns [value, setter] tuple", () => {
  const doc = createDoc();
  _setDocument(doc as any);
  const root = doc.createElement("div");

  let captured: any;
  function App() {
    const [count, setCount] = useState(42);
    captured = { count, setCount };
    return h("span", null, String(count));
  }

  const handle = mount(root, App);
  assertEquals(captured.count, 42);
  assertEquals(typeof captured.setCount, "function");
  _unmount(handle);
});

Deno.test("compat: useState setter triggers re-render", () => {
  const doc = createDoc();
  _setDocument(doc as any);
  const root = doc.createElement("div");

  let setter: any;
  let renderCount = 0;
  function App() {
    renderCount++;
    const [count, setCount] = useState(0);
    setter = setCount;
    return h("span", null, String(count));
  }

  const handle = mount(root, App);
  assertEquals(renderCount, 1);
  setter(5);
  handle._flush();
  assertEquals(renderCount, 2);
  _unmount(handle);
});

Deno.test("compat: useState setter accepts updater function", () => {
  const doc = createDoc();
  _setDocument(doc as any);
  const root = doc.createElement("div");

  let setter: any;
  let lastValue: number = -1;
  function App() {
    const [count, setCount] = useState(10);
    setter = setCount;
    lastValue = count;
    return h("span", null, String(count));
  }

  const handle = mount(root, App);
  assertEquals(lastValue, 10);
  setter((prev: number) => prev + 5);
  handle._flush();
  assertEquals(lastValue, 15);
  _unmount(handle);
});

Deno.test("compat: useEffect with empty deps runs on mount", () => {
  const doc = createDoc();
  _setDocument(doc as any);
  const root = doc.createElement("div");

  let mounted = false;
  function App() {
    useEffect(() => { mounted = true; }, []);
    return h("span", null, "hello");
  }

  const handle = mount(root, App);
  handle._flush();
  assertEquals(mounted, true);
  _unmount(handle);
});

Deno.test("compat: useEffect cleanup runs on unmount", () => {
  const doc = createDoc();
  _setDocument(doc as any);
  const root = doc.createElement("div");

  let cleanedUp = false;
  function App() {
    useEffect(() => {
      return () => { cleanedUp = false; };
    }, []);
    // Also test cleanup via onCleanup path
    useEffect(() => {
      return () => { cleanedUp = true; };
    }, []);
    return h("span", null, "hello");
  }

  const handle = mount(root, App);
  handle._flush();
  _unmount(handle);
  assertEquals(cleanedUp, true);
});

Deno.test("compat: useCallback returns function as-is", () => {
  const fn = () => 42;
  const doc = createDoc();
  _setDocument(doc as any);
  const root = doc.createElement("div");

  let result: any;
  function App() {
    result = useCallback(fn, []);
    return h("span", null, "test");
  }

  const handle = mount(root, App);
  assertEquals(result, fn);
  _unmount(handle);
});

Deno.test("compat: useMemo calls fn and returns result", () => {
  const doc = createDoc();
  _setDocument(doc as any);
  const root = doc.createElement("div");

  let result: any;
  function App() {
    result = useMemo(() => 21 * 2, []);
    return h("span", null, String(result));
  }

  const handle = mount(root, App);
  assertEquals(result, 42);
  _unmount(handle);
});

Deno.test("compat: dev hints fire once per name", () => {
  // Reset hint state
  const { _resetHints } = await import("../src/compat.ts");
  _resetHints();

  const logs: string[] = [];
  const origInfo = console.info;
  console.info = (...args: any[]) => { logs.push(args.join(" ")); };

  // Enable dev mode
  (globalThis as any).__aioDev = true;

  const doc = createDoc();
  _setDocument(doc as any);
  const root = doc.createElement("div");

  function App() {
    useCallback(() => {}, []);
    useCallback(() => {}, []);  // second call — should NOT log again
    useMemo(() => 1, []);
    return h("span", null, "test");
  }

  const handle = mount(root, App);
  handle._flush();

  // Should have exactly 2 hints: one for useCallback, one for useMemo
  const aioHints = logs.filter(l => l.includes("[aio]"));
  assertEquals(aioHints.length, 2);

  console.info = origInfo;
  delete (globalThis as any).__aioDev;
  _unmount(handle);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test -A tests/compat.test.ts`
Expected: FAIL — `src/compat.ts` does not exist

- [ ] **Step 3: Implement `src/compat.ts`**

Create `src/compat.ts`:

```ts
// React migration compat hooks for AIR.
// These allow React code to compile and run when imported from 'aio/air'.
// Dev-mode hints guide developers toward AIR-native alternatives.
// Isolated in this file — deletable when no longer needed.

import { signal, type Signal } from "./signal.ts";
import { useRef } from "./aio-renderer.ts";
import { onMount, onCleanup } from "./aio-renderer.ts";
import { effect } from "./signal.ts";

// ── Dev-mode hints (once per name per session) ────────────────────────

const _hinted = new Set<string>();

function _hint(name: string, msg: string): void {
  if (!(globalThis as Record<string, unknown>).__aioDev) return;
  if (_hinted.has(name)) return;
  _hinted.add(name);
  console.info(`[aio] ${name}() ${msg}`);
}

/** Reset hint state — for testing only. */
export function _resetHints(): void {
  _hinted.clear();
}

// ── useState ──────────────────────────────────────────────────────────

/**
 * React-compatible useState — signal-backed in AIR.
 * Returns [value, setter] tuple. Value auto-tracks in render scope.
 * Setter accepts a value or updater function (prev => next).
 */
export function useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] {
  _hint("useState", "is signal-backed in AIR. Recommended: useLocal() for object state, signal() for module-scoped.");
  const ref = useRef<Signal<T> | null>(null);
  if (!ref.current) {
    const init = typeof initial === "function" ? (initial as () => T)() : initial;
    ref.current = signal(init);
  }
  const sig = ref.current;
  const setter = (next: T | ((prev: T) => T)): void => {
    if (typeof next === "function") {
      sig.set((next as (prev: T) => T)(sig.peek()));
    } else {
      sig.set(next);
    }
  };
  return [sig.value, setter];
}

// ── useEffect ─────────────────────────────────────────────────────────

type CleanupFn = void | (() => void);

/**
 * React-compatible useEffect — mapped to AIR primitives.
 * Empty deps [] → onMount + cleanup via onCleanup.
 * No deps or non-empty deps → effect() (auto-tracked, deps ignored).
 */
export function useEffect(fn: () => CleanupFn, deps?: unknown[]): void {
  _hint("useEffect", "mapped to AIR primitives. Deps ignored (auto-tracked). Recommended: onMount() for setup, effect() for reactive.");
  if (deps && deps.length === 0) {
    // useEffect(fn, []) — mount-only pattern
    onMount(() => {
      const cleanup = fn();
      if (typeof cleanup === "function") onCleanup(cleanup);
    });
  } else {
    // useEffect(fn) or useEffect(fn, [deps]) — reactive
    const ref = useRef<boolean>(false);
    if (!ref.current) {
      ref.current = true;
      const dispose = effect(() => {
        const cleanup = fn();
        // effect() handles its own cleanup via return value
        if (typeof cleanup === "function") return cleanup;
      });
      onCleanup(dispose);
    }
  }
}

// ── useCallback ───────────────────────────────────────────────────────

/**
 * React-compatible useCallback — no-op in AIR (auto-optimized).
 * Returns the function as-is. Deps ignored.
 */
export function useCallback<T>(fn: T, _deps?: unknown[]): T {
  _hint("useCallback", "is unnecessary in AIR — components are auto-optimized. Safe to remove.");
  return fn;
}

// ── useMemo ───────────────────────────────────────────────────────────

/**
 * React-compatible useMemo — no-op in AIR.
 * Calls fn() and returns the result. No caching (AIR re-renders are signal-scoped).
 * For cached derivations, use computed() instead.
 */
export function useMemo<T>(fn: () => T, _deps?: unknown[]): T {
  _hint("useMemo", "is unnecessary in AIR — use computed() for cached derivations. Safe to remove.");
  return fn();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test -A tests/compat.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 5: Lint and type-check**

Run: `deno lint src/compat.ts && deno check src/compat.ts`
Expected: Clean

- [ ] **Step 6: Commit**

```bash
git add src/compat.ts tests/compat.test.ts
git commit -m "feat: add React migration compat hooks (useState, useEffect, useCallback, useMemo)"
```

---

### Task 2: Create `src/air.ts` — AIR entry point barrel

**Files:**
- Create: `src/air.ts`
- Test: `tests/air-entry.test.ts`

- [ ] **Step 1: Write failing test for AIR entry exports**

Create `tests/air-entry.test.ts`:

```ts
import { assertExists } from "@std/assert";

Deno.test("air entry: exports all AIR-native hooks", async () => {
  const air = await import("../src/air.ts");

  // AIR-native hooks
  assertExists(air.useFeature, "useFeature");
  assertExists(air.useAio, "useAio");
  assertExists(air.useLocal, "useLocal");
  assertExists(air.useConnected, "useConnected");
  assertExists(air.useProjection, "useProjection");
  assertExists(air.useTimeTravel, "useTimeTravel");

  // Lifecycle
  assertExists(air.onMount, "onMount");
  assertExists(air.onCleanup, "onCleanup");

  // Signal primitives
  assertExists(air.signal, "signal");
  assertExists(air.computed, "computed");
  assertExists(air.effect, "effect");
  assertExists(air.batch, "batch");

  // Rendering
  assertExists(air.h, "h");
  assertExists(air.mount, "mount");
  assertExists(air.hydrate, "hydrate");

  // Context
  assertExists(air.createContext, "createContext");
  assertExists(air.useContext, "useContext");
  assertExists(air.useRef, "useRef");

  // Routing
  assertExists(air.useRoute, "useRoute");
  assertExists(air.useNavigate, "useNavigate");
  assertExists(air.Route, "Route");
  assertExists(air.Link, "Link");
  assertExists(air.navigate, "navigate");
  assertExists(air.matchPath, "matchPath");
});

Deno.test("air entry: exports React compat hooks", async () => {
  const air = await import("../src/air.ts");

  // Migration compat
  assertExists(air.useState, "useState");
  assertExists(air.useEffect, "useEffect");
  assertExists(air.useCallback, "useCallback");
  assertExists(air.useMemo, "useMemo");
  assertExists(air.memo, "memo");
});

Deno.test("air entry: exports base aio symbols", async () => {
  const air = await import("../src/air.ts");

  // Server/protocol (re-exported from base)
  assertExists(air.feature, "feature");
  assertExists(air.aio, "aio");
  assertExists(air.log, "log");
  assertExists(air.client, "client");
  assertExists(air.msg, "msg");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test -A tests/air-entry.test.ts`
Expected: FAIL — `src/air.ts` does not exist

- [ ] **Step 3: Implement `src/air.ts`**

Create `src/air.ts`:

```ts
// deno-lint-ignore-file
// AIR entry point — import everything a component needs from 'aio/air'.
// Re-exports: base (server/protocol) + browser-air (AIR hooks/routing/rendering) + compat (React migration).

// ── Base re-exports (server, protocol, types) ─────────────────────────
// Feature definitions, factories, logging, client, etc.
export {
  aio,
  feature,
  composeFeatures,
  bindFeature,
  testFeature,
  call,
  markAsync,
  actions,
  effects,
  schedule,
  log,
  createDB,
  DEFAULT_PRAGMAS,
  createSelector,
  createSliceSelector,
  composeMiddleware,
  deepFreeze,
  draft,
  matchEffect,
  lint,
  parseCli,
  VERSION,
  instances,
  resolveAppId,
  connectCli,
  connectCliUDS,
  integer, pk, real, ref, table, text,
} from "../mod.ts";

// Base types
export type {
  AioApp,
  AioConfig,
  AioError,
  AioUser,
  CliFlags,
  FeaturesConfig,
  Lint,
  MiddlewareFn,
  PerfBudget,
  PerfCheck,
  UiConfig,
  AioErrorCode,
  AioErrorContext,
  AioErrorSource,
  FlowStepRecord,
  FeatureStateSize,
  MemoryConfig,
  MemoryReport,
  RenderBudget,
  ReduceBreakdown,
  CheckpointData,
  DiagnosticsConfig,
  DiagnosticsOptions,
  DiagEvent,
  DiagEventDetail,
  LayerThreshold,
  VitalAlert,
  VitalHint,
  VitalLayer,
  VitalsConfig,
  VitalStatus,
  VitalThresholds,
  Log,
  LogConfig,
  LogLevel,
  AioMeta,
  InstanceInfo,
  LockData,
  SingletonMode,
  ActionsFeatureConfig,
  ActionSource,
  ActionUnion,
  Catalog,
  CircuitBreakerConfig,
  ComposedFeatures,
  Creators,
  DirectCalling,
  ExecuteHandlers,
  FeatureAio,
  FeatureDef,
  FeatureEntry,
  FeatureExecuteFn,
  FeatureReduceFn,
  FeatureStatus,
  FlatActions,
  MachineConfig,
  MethodsFeatureConfig,
  Msg,
  ReduceHandlers,
  ScopedApp,
  TestContext,
  AsyncMethod,
  CallOptions,
  FeatureMethods,
  Method,
  SyncMethod,
  FlowDef,
  FlowStep,
  Gen,
  GenCtx,
  TypedCreator,
  CliApp,
  FactoryResult,
  LowerFirst,
  Prefixed,
  ScheduleDef,
  ScheduleEffect,
  ColumnDef,
  ColumnOpts,
  QueryOpts,
  TableDef,
  WhereClause,
  WhereOp,
  DB,
  DBOpts,
  QueryResult,
  Tx,
  Selector,
  UnionOf,
} from "../mod.ts";

// ── AIR renderer + hooks + routing ────────────────────────────────────
// Everything from browser-air.ts (AIR-native API)
export {
  // AIR hooks
  useFeature,
  useAio,
  useLocal,
  useConnected,
  useProjection,
  useTimeTravel,

  // Lifecycle & context (identical to React API)
  useRef,
  createContext,
  useContext,
  onMount,
  onCleanup,

  // Signal primitives
  signal,
  computed,
  effect,
  batch,

  // Rendering
  h,
  mount,
  hydrate,
  memo,
  page,

  // Routing
  useRoute,
  useNavigate,
  Route,
  Outlet,
  Link,
  NavLink,
  Redirect,
  navigate,
  matchPath,
  ensureConnected,
  routePath,
  routeSearch,

  // Shared utilities
  msg,
  actions as actionCreators,
  effects as effectCreators,

  // Protocol re-exports
  feature,
  bridge,
  aio,
  log,
  client,
  connectDevTools,
  disconnectDevTools,
} from "./browser-air.ts";

// AIR types
export type {
  Signal,
  Computed,
  Context,
  MountHandle,
  VNode,
  VChild,
  ComponentFn,
  RouteState,
  RouteProps,
  LinkProps,
} from "./browser-air.ts";

// AIR extras (form, animation, virtual-list, devtools)
export { useForm, useFieldArray } from "./form.ts";
export type { FormState, FieldState, FieldArrayState, ValidationRule } from "./form.ts";
export { useSpring, useTransition } from "./animation.ts";
export type { SpringConfig, SpringValue, TransitionConfig, TransitionState } from "./animation.ts";
export { useVirtualList } from "./virtual-list.ts";
export type { VirtualListConfig, VirtualListState } from "./virtual-list.ts";
export { connectAioDevTools } from "./devtools.ts";
export type { ComponentTreeNode, DevToolsHandle, RenderEvent } from "./devtools.ts";

// VDOM extras
export { Fragment, ErrorBoundary, Portal, Suspense, lazy, renderToString } from "./vdom.ts";
export type { Ref } from "./vdom.ts";

// ── React migration compat ────────────────────────────────────────────
export { useState, useEffect, useCallback, useMemo } from "./compat.ts";
```

**Note:** This file will have some duplicate export names between `mod.ts` and `browser-air.ts` (e.g. `feature`, `aio`, `log`, `msg`). We need to handle that — the barrel should re-export from `browser-air.ts` which already re-exports those from `browser-protocol.ts`. Let me simplify: re-export EVERYTHING from `browser-air.ts` first (it has the full runtime surface), then add base-only symbols from `mod.ts` that `browser-air.ts` doesn't have (server-side like `aio.run`, `lint`, `feature`, DB, etc.).

Actually, the cleaner approach: `browser-air.ts` already exports the browser-side symbols. `mod.ts` has the server-side symbols. `air.ts` re-exports from both, and for any conflicts, `browser-air.ts` wins (it has the real runtime implementations, not the `declare` stubs).

Let me revise. The actual `src/air.ts` should be:

```ts
// deno-lint-ignore-file
// AIR entry point — 'aio/air'
// Re-exports: browser-air (full AIR runtime) + compat (React migration) + server extras from mod.

// ── Full AIR runtime (hooks, routing, rendering, signals, protocol) ───
export * from "./browser-air.ts";

// ── VDOM extras not in browser-air ────────────────────────────────────
export { Fragment, ErrorBoundary, Portal, Suspense, lazy, renderToString } from "./vdom.ts";
export type { Ref, VNode } from "./vdom.ts";

// ── AIR component utilities ───────────────────────────────────────────
export { useForm, useFieldArray } from "./form.ts";
export type { FormState, FieldState, FieldArrayState, ValidationRule } from "./form.ts";
export { useSpring, useTransition } from "./animation.ts";
export type { SpringConfig, SpringValue, TransitionConfig, TransitionState } from "./animation.ts";
export { useVirtualList } from "./virtual-list.ts";
export type { VirtualListConfig, VirtualListState } from "./virtual-list.ts";
export { connectAioDevTools } from "./devtools.ts";
export type { ComponentTreeNode, DevToolsHandle, RenderEvent } from "./devtools.ts";

// ── React migration compat hooks ─────────────────────────────────────
export { useState, useEffect, useCallback, useMemo } from "./compat.ts";

// ── Server/framework re-exports (feature defs, factories, DB, etc.) ──
// These are from mod.ts — available so 'aio/air' is a complete import.
export {
  aio, lint, parseCli, VERSION,
  feature, composeFeatures, bindFeature, testFeature,
  call, markAsync,
  actions, effects, schedule,
  log,
  createDB, DEFAULT_PRAGMAS,
  integer, pk, real, ref, table, text,
  createSelector, createSliceSelector,
  composeMiddleware,
  deepFreeze, draft, matchEffect,
  instances, resolveAppId,
  connectCli, connectCliUDS,
} from "../mod.ts";

// Server/framework types
export type {
  AioApp, AioConfig, AioError, AioUser, CliFlags, FeaturesConfig,
  Lint, MiddlewareFn, PerfBudget, PerfCheck, UiConfig,
  AioErrorCode, AioErrorContext, AioErrorSource, FlowStepRecord,
  FeatureStateSize, MemoryConfig, MemoryReport, RenderBudget, ReduceBreakdown,
  CheckpointData, DiagnosticsConfig, DiagnosticsOptions,
  DiagEvent, DiagEventDetail,
  LayerThreshold, VitalAlert, VitalHint, VitalLayer, VitalsConfig, VitalStatus, VitalThresholds,
  Log, LogConfig, LogLevel, AioMeta, InstanceInfo, LockData, SingletonMode,
  ActionsFeatureConfig, ActionSource, ActionUnion, Catalog, CircuitBreakerConfig,
  ComposedFeatures, Creators, DirectCalling, ExecuteHandlers,
  FeatureAio, FeatureDef, FeatureEntry, FeatureExecuteFn, FeatureReduceFn,
  FeatureStatus, FlatActions, MachineConfig, MethodsFeatureConfig, Msg,
  ReduceHandlers, ScopedApp, TestContext,
  AsyncMethod, CallOptions, FeatureMethods, Method, SyncMethod,
  FlowDef, FlowStep, Gen, GenCtx, TypedCreator,
  CliApp, FactoryResult, LowerFirst, Prefixed,
  ScheduleDef, ScheduleEffect,
  ColumnDef, ColumnOpts, QueryOpts, TableDef, WhereClause, WhereOp,
  DB, DBOpts, QueryResult, Tx, Selector, UnionOf,
} from "../mod.ts";
```

This WILL have conflicts for names exported by both `browser-air.ts` and `mod.ts` (like `feature`, `aio`, `log`, `msg`, `actions`, `effects`, `schedule`). The `export *` from `browser-air.ts` provides the runtime versions, and the explicit re-exports from `mod.ts` will conflict. Solution: DON'T re-export conflicting names from `mod.ts` — only re-export what `browser-air.ts` doesn't already provide.

We need to check exactly which names overlap. Known overlaps from browser-air.ts: `feature`, `bridge`, `aio`, `log`, `client`, `msg`, `actions`, `effects`, `schedule`, `connectDevTools`, `disconnectDevTools`, `matchPath`, `navigate`, `ensureConnected`, `routePath`, `routeSearch`.

The final `src/air.ts` must exclude those from the mod.ts re-export. Here is the corrected version:

```ts
// deno-lint-ignore-file
// AIR entry point — 'aio/air'
// Complete import surface for AIR components and feature definitions.
// Re-exports: browser-air (full AIR runtime) + compat (React migration) + server extras.

// ── Full AIR runtime (hooks, routing, rendering, signals, protocol) ───
export * from "./browser-air.ts";

// ── VDOM extras not in browser-air ────────────────────────────────────
export { Fragment, ErrorBoundary, Portal, Suspense, lazy, renderToString } from "./vdom.ts";
export type { Ref } from "./vdom.ts";

// ── AIR component utilities ───────────────────────────────────────────
export { useForm, useFieldArray } from "./form.ts";
export type { FormState, FieldState, FieldArrayState, ValidationRule } from "./form.ts";
export { useSpring, useTransition } from "./animation.ts";
export type { SpringConfig, SpringValue, TransitionConfig, TransitionState } from "./animation.ts";
export { useVirtualList } from "./virtual-list.ts";
export type { VirtualListConfig, VirtualListState } from "./virtual-list.ts";
export { connectAioDevTools } from "./devtools.ts";
export type { ComponentTreeNode, DevToolsHandle, RenderEvent } from "./devtools.ts";

// ── React migration compat hooks ─────────────────────────────────────
export { useState, useEffect, useCallback, useMemo } from "./compat.ts";

// ── Server/framework symbols NOT already in browser-air.ts ────────────
// browser-air.ts already re-exports: feature, bridge, aio, log, client,
// msg, actions, effects, schedule, connectDevTools, disconnectDevTools,
// matchPath, navigate, ensureConnected, routePath, routeSearch
export {
  lint, parseCli, VERSION,
  composeFeatures, bindFeature, testFeature,
  call, markAsync,
  createDB, DEFAULT_PRAGMAS,
  integer, pk, real, ref, table, text,
  createSelector, createSliceSelector,
  composeMiddleware,
  deepFreeze, draft, matchEffect,
  instances, resolveAppId,
  connectCli, connectCliUDS,
} from "../mod.ts";

// Server/framework types
export type {
  AioApp, AioConfig, AioError, AioUser, CliFlags, FeaturesConfig,
  Lint, MiddlewareFn, PerfBudget, PerfCheck, UiConfig,
  AioErrorCode, AioErrorContext, AioErrorSource, FlowStepRecord,
  FeatureStateSize, MemoryConfig, MemoryReport, RenderBudget, ReduceBreakdown,
  CheckpointData, DiagnosticsConfig, DiagnosticsOptions,
  DiagEvent, DiagEventDetail,
  LayerThreshold, VitalAlert, VitalHint, VitalLayer, VitalsConfig, VitalStatus, VitalThresholds,
  Log, LogConfig, LogLevel, AioMeta, InstanceInfo, LockData, SingletonMode,
  ActionsFeatureConfig, ActionSource, ActionUnion, Catalog, CircuitBreakerConfig,
  ComposedFeatures, Creators, DirectCalling, ExecuteHandlers,
  FeatureAio, FeatureDef, FeatureEntry, FeatureExecuteFn, FeatureReduceFn,
  FeatureStatus, FlatActions, MachineConfig, MethodsFeatureConfig, Msg,
  ReduceHandlers, ScopedApp, TestContext,
  AsyncMethod, CallOptions, FeatureMethods, Method, SyncMethod,
  FlowDef, FlowStep, Gen, GenCtx, TypedCreator,
  CliApp, FactoryResult, LowerFirst, Prefixed,
  ScheduleDef, ScheduleEffect,
  ColumnDef, ColumnOpts, QueryOpts, TableDef, WhereClause, WhereOp,
  DB, DBOpts, QueryResult, Tx, Selector, UnionOf,
} from "../mod.ts";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test -A tests/air-entry.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 5: Lint and type-check**

Run: `deno lint src/air.ts && deno check src/air.ts`
Expected: Clean

- [ ] **Step 6: Commit**

```bash
git add src/air.ts tests/air-entry.test.ts
git commit -m "feat: add src/air.ts — AIR entry point barrel (aio/air)"
```

---

### Task 3: Create `src/react.ts` — React entry point barrel

**Files:**
- Create: `src/react.ts`

- [ ] **Step 1: Implement `src/react.ts`**

Create `src/react.ts`:

```ts
// deno-lint-ignore-file
// React entry point — 'aio/react'
// Re-exports: browser.ts (React hooks/routing) + server extras from mod.ts.

// ── Full React runtime (hooks, routing, protocol) ─────────────────────
export * from "./browser.ts";

// ── Server/framework symbols NOT already in browser.ts ���───────────────
// browser.ts already re-exports: feature, bridge, aio, log, client,
// msg, actions, effects, schedule, connectDevTools, disconnectDevTools,
// matchPath, navigate, ensureConnected, routePath, routeSearch
export {
  lint, parseCli, VERSION,
  composeFeatures, bindFeature, testFeature,
  call, markAsync,
  createDB, DEFAULT_PRAGMAS,
  integer, pk, real, ref, table, text,
  createSelector, createSliceSelector,
  composeMiddleware,
  deepFreeze, draft, matchEffect,
  instances, resolveAppId,
  connectCli, connectCliUDS,
} from "../mod.ts";

// Server/framework types
export type {
  AioApp, AioConfig, AioError, AioUser, CliFlags, FeaturesConfig,
  Lint, MiddlewareFn, PerfBudget, PerfCheck, UiConfig,
  AioErrorCode, AioErrorContext, AioErrorSource, FlowStepRecord,
  FeatureStateSize, MemoryConfig, MemoryReport, RenderBudget, ReduceBreakdown,
  CheckpointData, DiagnosticsConfig, DiagnosticsOptions,
  DiagEvent, DiagEventDetail,
  LayerThreshold, VitalAlert, VitalHint, VitalLayer, VitalsConfig, VitalStatus, VitalThresholds,
  Log, LogConfig, LogLevel, AioMeta, InstanceInfo, LockData, SingletonMode,
  ActionsFeatureConfig, ActionSource, ActionUnion, Catalog, CircuitBreakerConfig,
  ComposedFeatures, Creators, DirectCalling, ExecuteHandlers,
  FeatureAio, FeatureDef, FeatureEntry, FeatureExecuteFn, FeatureReduceFn,
  FeatureStatus, FlatActions, MachineConfig, MethodsFeatureConfig, Msg,
  ReduceHandlers, ScopedApp, TestContext,
  AsyncMethod, CallOptions, FeatureMethods, Method, SyncMethod,
  FlowDef, FlowStep, Gen, GenCtx, TypedCreator,
  CliApp, FactoryResult, LowerFirst, Prefixed,
  ScheduleDef, ScheduleEffect,
  ColumnDef, ColumnOpts, QueryOpts, TableDef, WhereClause, WhereOp,
  DB, DBOpts, QueryResult, Tx, Selector, UnionOf,
} from "../mod.ts";
```

- [ ] **Step 2: Type-check**

Run: `deno check src/react.ts`
Expected: Clean

- [ ] **Step 3: Commit**

```bash
git add src/react.ts
git commit -m "feat: add src/react.ts — React entry point barrel (aio/react)"
```

---

### Task 4: Update `deno.json` — add subpath exports

**Files:**
- Modify: `deno.json`

- [ ] **Step 1: Add export entries**

In `deno.json`, add `"./air"` and `"./react"` to the `exports` object:

```json
{
  "exports": {
    ".": "./mod.ts",
    "./air": "./src/air.ts",
    "./react": "./src/react.ts",
    "./jsx-runtime": "./src/jsx-runtime.ts",
    "./adapters/react": "./src/adapters/react.ts",
    "./adapters/air": "./src/adapters/air.ts",
    "./state-core": "./src/state-core.ts",
    "./src/build": "./src/build.ts",
    "./src/am": "./src/am.ts",
    "./aiol": "./aiol/mod.ts"
  }
}
```

Also add import map aliases so internal code can use `aio/air` and `aio/react`:

In the `"imports"` section, add:

```json
{
  "imports": {
    "aio": "./mod.ts",
    "aio/air": "./src/air.ts",
    "aio/react": "./src/react.ts",
    ...existing
  }
}
```

- [ ] **Step 2: Verify all three entry points type-check**

Run: `deno check mod.ts src/air.ts src/react.ts`
Expected: All clean

- [ ] **Step 3: Commit**

```bash
git add deno.json
git commit -m "feat: add aio/air and aio/react subpath exports to deno.json"
```

---

### Task 5: Trim `mod.ts` — remove renderer-specific exports

**Files:**
- Modify: `mod.ts`
- Test: `tests/headless-import.test.ts`

This is the highest-risk task. `mod.ts` must become renderer-agnostic.

- [ ] **Step 1: Write headless import test**

Create `tests/headless-import.test.ts`:

```ts
import { assertExists, assertEquals } from "@std/assert";

Deno.test("headless: base aio import provides server symbols", async () => {
  const base = await import("../mod.ts");

  // Server essentials must exist
  assertExists(base.aio, "aio");
  assertExists(base.feature, "feature");
  assertExists(base.log, "log");
  assertExists(base.lint, "lint");
  assertExists(base.parseCli, "parseCli");
  assertExists(base.actions, "actions");
  assertExists(base.effects, "effects");
  assertExists(base.schedule, "schedule");
  assertExists(base.createDB, "createDB");
  assertExists(base.call, "call");
  assertExists(base.draft, "draft");
  assertExists(base.matchEffect, "matchEffect");
  assertExists(base.composeMiddleware, "composeMiddleware");
  assertExists(base.deepFreeze, "deepFreeze");
  assertExists(base.createSelector, "createSelector");
});

Deno.test("headless: base aio import does NOT provide renderer symbols", async () => {
  const base = await import("../mod.ts");

  // Renderer symbols must NOT be in base
  assertEquals((base as any).h, undefined, "h should not be in base");
  assertEquals((base as any).mount, undefined, "mount should not be in base");
  assertEquals((base as any).signal, undefined, "signal should not be in base");
  assertEquals((base as any).effect, undefined, "effect should not be in base");
  assertEquals((base as any).onMount, undefined, "onMount should not be in base");
  assertEquals((base as any).useRef, undefined, "useRef should not be in base");
  assertEquals((base as any).useState, undefined, "useState should not be in base");
  assertEquals((base as any).useFeature, undefined, "useFeature should not be in base");
  assertEquals((base as any).useAio, undefined, "useAio should not be in base");
});
```

- [ ] **Step 2: Run test to see current state (second test should fail)**

Run: `deno test -A tests/headless-import.test.ts`
Expected: First test PASS, second test FAIL (mod.ts currently exports renderer symbols)

- [ ] **Step 3: Strip renderer exports from `mod.ts`**

Remove these sections from `mod.ts` (lines 378-878, approximately):

1. Remove `useAio` declare (lines ~380-383)
2. Remove `useFeature` declares (lines ~414-432)
3. Remove `useLocal` declare (lines ~442-445)
4. Remove `useConnected` declare (lines ~455)
5. Remove `useProjection` declare (lines ~474)
6. Remove `memo` declare (lines ~494-497)
7. Remove `page` declare (lines ~513-516)
8. Remove `useRoute` declare (lines ~535-540)
9. Remove `useNavigate` declare (lines ~555-558)
10. Remove `navigate` declare (lines ~572-575)
11. Remove `Route` declare (lines ~597-602)
12. Remove `Outlet` declare (lines ~615)
13. Remove `Link` declare (lines ~629-639)
14. Remove `NavLink` declare (lines ~651-655)
15. Remove `Redirect` declare (lines ~670-672)
16. Remove `matchPath` declare (lines ~687-691)
17. Remove `useTimeTravel` declare (lines ~702-711)
18. Remove `client` declare (lines ~743-754)
19. Remove `connectDevTools` / `disconnectDevTools` declares (lines ~767-772)
20. Remove `initStandalone` declare (lines ~792-806)
21. Remove signal exports (line ~813): `export { batch, computed, effect, signal }`
22. Remove signal types (line ~815): `export type { Computed, Signal }`
23. Remove vdom exports (lines ~817-825)
24. Remove vdom types (line ~827)
25. Remove aio-renderer exports (lines ~829-840)
26. Remove aio-renderer types (lines ~842-844)
27. Remove form exports (lines ~846-853)
28. Remove animation exports (lines ~855-862)
29. Remove virtual-list exports (lines ~864-869)
30. Remove devtools exports (lines ~871-877)
31. Remove `RouteProps`, `RouteState`, `LinkProps` type re-export (line ~694)
32. Remove `_FeatureBuiltins`, `_InferState`, `_InferSend` type exports (lines ~400-411) — keep these, they're type utilities used by feature definitions
33. Remove the `ComponentFn` type alias at top (line ~43) — only needed by renderer declares
34. Remove `import type { PerfBudget, PerfCheck }` if no longer used (line ~41) — keep, still exported as types

Keep everything else: `aio`, `feature`, `log`, `lint`, `parseCli`, factories, DB, selectors, middleware, error types, diagnostic types, vitals types, `draft`, `matchEffect`, `deepFreeze`, `call`, `markAsync`, electron utils, CLI client, all type exports for server-side use.

Also keep `_FeatureBuiltins`, `_InferState`, `_InferSend` — they're generic type utilities.

Also keep `UnionOf` type — it's generic.

- [ ] **Step 4: Run headless test**

Run: `deno test -A tests/headless-import.test.ts`
Expected: Both tests PASS

- [ ] **Step 5: Run FULL test suite**

Run: `deno task test`
Expected: All 1620+ tests pass. If any fail due to missing imports from `'aio'`, note them for Task 6.

- [ ] **Step 6: Type-check and lint**

Run: `deno check mod.ts && deno lint src/`
Expected: Clean

- [ ] **Step 7: Commit**

```bash
git add mod.ts tests/headless-import.test.ts
git commit -m "refactor: strip renderer exports from mod.ts — base is now server/protocol only"
```

---

### Task 6: Fix broken test imports

**Files:**
- Modify: any test files that import renderer symbols from `'aio'`

Known affected files (from grep):
- `tests/aiol-browser-checks.test.ts:169` — imports `useFeature` from `'aio'`
- `tests/electron-ipc.test.ts:27` — imports `useAio` from `'aio'`
- `tests/aiol-memo-checks.test.ts:67,88` — imports `memo`, `useProjection` from `'aio'`

These are string literals INSIDE test code (linter test fixtures), not actual imports. Check each:

- [ ] **Step 1: Verify which tests actually break**

Run: `deno task test`
Identify any actual failures from the mod.ts trim.

- [ ] **Step 2: Fix failing imports**

For each broken test file, change the import path:
- If importing renderer hooks → change `'aio'` to `'aio/air'` or the direct source path
- If it's a string literal in a test fixture (linter test) → update the fixture string but keep testing the same behavior

- [ ] **Step 3: Run full test suite again**

Run: `deno task test`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add tests/
git commit -m "fix: update test imports after mod.ts trim"
```

---

### Task 7: Full verification

**Files:** None (verification only)

- [ ] **Step 1: Type-check all three entry points**

Run: `deno check mod.ts src/air.ts src/react.ts`
Expected: All clean

- [ ] **Step 2: Lint entire source**

Run: `deno lint`
Expected: Clean (101+ files)

- [ ] **Step 3: Run full test suite**

Run: `deno task test`
Expected: All tests pass (1620+)

- [ ] **Step 4: Verify headless import**

Run: `deno test -A tests/headless-import.test.ts`
Expected: PASS — mod.ts has no renderer symbols

- [ ] **Step 5: Verify AIR entry has everything**

Run: `deno test -A tests/air-entry.test.ts`
Expected: PASS — aio/air has all hooks, compat, and base symbols

- [ ] **Step 6: Verify compat hooks work**

Run: `deno test -A tests/compat.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 7: Commit if any fixes were needed**

Only commit if fixes were made in this task.
