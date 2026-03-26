/**
 * @module
 * Full-stack Deno framework — one state, propagated everywhere.
 *
 * v1.0: clean API, framework-agnostic client, feature.ts split, perf.log, am client inspection.
 * v0.9: async Worker-based SQLite, `log` public singleton, scaffolder via JSR.
 * Use `feature({ methods })` for reactive style (default),
 * `feature({ generators })` for sequential workflows,
 * `feature({ actions, reduce })` for explicit control (advanced).
 *
 * ```ts
 * import { feature, call, aio } from 'aio'
 *
 * // Reactive style — default
 * const counter = feature('counter', {
 *   state: { count: 0 },
 *   methods: {
 *     increment(s, by = 1) { s.count += by },
 *     async save(s) { await call({ timeout: 3000 }, () => persist(s.count)) },
 *   },
 * })
 *
 * // Sequential workflow — generator with typed state
 * const checkout = feature('checkout', {
 *   state: { orderId: null as string | null },
 *   methods: { reset(s) { s.orderId = null } },
 *   generators: {
 *     *place(ctx, item: string) {        // ctx is GenCtx<{ orderId: string | null }>
 *       const id = yield* ctx.call('submit', () => submitOrder(item))
 *       yield* ctx.done(s => { s.orderId = id })  // s typed — no cast needed
 *     },
 *   },
 * })
 *
 * await aio.run({ features: [counter, checkout] })
 * counter.increment(5)       // direct call — dispatches through store
 * checkout.place('widget')   // starts generator
 * ```
 */
import { type Draft, produce } from "immer";
import type { PerfBudget, PerfCheck } from "./src/dispatch.ts";
import type { ComponentType, ReactElement } from "react";

/** Framework core — `aio.run()` starts the app, `lint` validates features, `parseCli` reads CLI flags */
export { aio, lint, parseCli, VERSION } from "./src/aio.ts";
import type { AioApp } from "./src/aio.ts";
/** The running app instance returned by `aio.run()` — provides state access, dispatch, db, and lifecycle */
export type { AioApp };
/** Core configuration, error, and middleware types for `aio.run()` */
export type {
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
} from "./src/aio.ts";
/** Structured error types — error codes, context, source tracking, and flow step records */
export type {
  AioErrorCode,
  AioErrorContext,
  AioErrorSource,
  FlowStepRecord,
} from "./src/error.ts";
/** Memory monitor configuration and heap usage report types */
export type {
  FeatureStateSize,
  MemoryConfig,
  MemoryReport,
} from "./src/memory-monitor.ts";
/** Client-side render budget thresholds — staleness and pending patch count */
export type { RenderBudget } from "./src/vitals/types.ts";
/** Phase-level timing breakdown inside a single reduce cycle */
export type { ReduceBreakdown } from "./src/time-travel.ts";
/** Diagnostics configuration and checkpoint recovery types */
export type {
  CheckpointData,
  DiagnosticsConfig,
  DiagnosticsOptions,
} from "./src/diagnostics/types.ts";
/** Structured diagnostic event and detail types from the vitals system */
export type { DiagEvent, DiagEventDetail } from "./src/vitals/types.ts";
/** Vitals types — configuration, alerts, thresholds, hints, status */
export type {
  LayerThreshold,
  VitalAlert,
  VitalHint,
  VitalLayer,
  VitalsConfig,
  VitalStatus,
  VitalThresholds,
} from "./src/vitals/types.ts";
/** Structured logger — `log.info()`, `log.warn()`, `log.error()`, `log.debug()` */
export { log } from "./src/logger.ts";
/** Logger configuration and level types */
export type { Log, LogConfig, LogLevel } from "./src/logger.ts";
/** Electron app metadata injected into the renderer process */
export type { AioMeta } from "./src/electron.ts";
/** Single-instance lock types — instance info, lock data, singleton mode */
export type {
  InstanceInfo,
  LockData,
  SingletonMode,
} from "./src/single-instance-lock.ts";
/** Single-instance lock — `instances()` lists running apps, `resolveAppId` normalizes IDs */
export { instances, resolveAppId } from "./src/single-instance-lock.ts";
// slugify — internal (used by build.ts, not app code)

/**
 * v0.8 unified feature API.
 * feature({ methods })           — default reactive style (sync/async, Immer proxy, direct calling)
 * feature({ methods, generators }) — reactive + sequential workflows in one feature
 * feature({ actions, reduce })   — explicit style for full control (advanced)
 */
export { bindFeature, testFeature } from "./src/feature.ts";
/** Define a feature — methods, generators, actions/reduce, or mixed. The atomic unit of aio. */
export { feature } from "./src/feature.ts";
/** Compose features into a single dispatch/reduce/execute pipeline with dependency resolution. */
export { composeFeatures } from "./src/feature.ts";
/** Feature definition types — actions, catalogs, machine config, compose, test context */
export type {
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
} from "./src/feature.ts";

/**
 * Inter-feature coordination — async methods return Promises with the correct type.
 * Everything goes through the store (observable, time-travelable).
 *
 * Simple — preferred for most cases:
 * ```ts
 * const reserved = await inventory.reserve(items)  // direct calling
 * ```
 *
 * With timeout/retry:
 * ```ts
 * const result = await call({ timeout: 5000, retries: 2 }, () => inventory.reserve(items))
 * ```
 *
 * `markAsync` — rare: explicitly mark a method as async when minification strips constructor names.
 */
/** Wrap an inter-feature call with timeout and/or retry — `call({ timeout: 5000 }, () => f.method())`. */
export { call } from "./src/feature-impl.ts";
export { markAsync } from "./src/feature-impl.ts";
/** Method types for feature definitions — sync, async, call options */
export type {
  AsyncMethod,
  CallOptions,
  FeatureMethods,
  Method,
  SyncMethod,
} from "./src/feature-impl.ts";

/**
 * Generator-based sequential workflows.
 * Write top-to-bottom async code; each yield point is observable.
 * Use cancelOn config key in feature() to declare cancellation triggers.
 */
/** Generator workflow types — flow definitions, steps, context, and typed creators */
export type {
  FlowDef,
  FlowStep,
  Gen,
  GenCtx,
  TypedCreator,
} from "./src/flow.ts";

/**
 * Connect to a remote aio server from a CLI app.
 * Returns a CliApp with state, send, subscribe, close, connected, and ready.
 * @param url - WebSocket URL of the aio server (e.g., 'ws://localhost:8000/ws')
 * @param opts - Optional { token?: string } for auth
 */
export { connectCli, connectCliUDS } from "./src/cli-client.ts";
/** CLI client connection type — state, send, subscribe, close, ready */
export type { CliApp } from "./src/cli-client.ts";

/**
 * Action/effect catalog factory — creates typed creators for explicit-style features.
 * Used inside `feature({ actions, effects })` config or for standalone catalogs.
 */
/** Create typed action creators — PascalCase labels + camelCase dispatch helpers. */
export { actions } from "./src/factory.ts";
/** Create typed effect creators — same API as `actions()` but for side-effect declarations. */
export { effects } from "./src/factory.ts";
/** Factory result and creator types for explicit-style action/effect catalogs */
export type {
  Creators as FactoryCreators,
  FactoryResult,
  LowerFirst,
  Prefixed,
} from "./src/factory.ts";

/**
 * Declarative schedules — timers, intervals, cron jobs as effects.
 * @see {@link https://aio.dev/manual#scheduled-effects}
 */
export { schedule } from "./src/schedule.ts";
import type { ScheduleEffect } from "./src/schedule.ts";
/** Schedule definition and effect types for timers, intervals, and cron */
export type { ScheduleDef, ScheduleEffect } from "./src/schedule.ts";

/**
 * SQLite column helpers for defining table schemas.
 * @see {@link https://aio.dev/manual#sqlite-persistence}
 */
export { integer, pk, real, ref, table, text } from "./src/sql.ts";
/** SQL schema and query types — column definitions, table schemas, where clauses */
export type {
  ColumnDef,
  ColumnOpts,
  QueryOpts,
  TableDef,
  WhereClause,
  WhereOp,
} from "./src/sql.ts";

/**
 * Async SQLite — Worker-backed, non-blocking.
 * `createDB` is for direct use; `app.db` is the instance managed by the framework.
 */
export { createDB, DEFAULT_PRAGMAS } from "./src/db/mod.ts";
/** Database types — DB instance, options, query results, transaction handle */
export type { DB, DBOpts, QueryResult, Tx } from "./src/db/mod.ts";

/**
 * Memoized selectors for expensive state derivations.
 * Caches results until input selectors return new values.
 */
/** Memoized selector — recomputes only when input selectors return new values. */
export { createSelector } from "./src/selector.ts";
export { createSliceSelector } from "./src/selector.ts";
export type { Selector } from "./src/selector.ts";

/**
 * Composes multiple beforeReduce functions into one.
 * Functions run in order, passing the action through. Return null to drop.
 *
 * @param fns - beforeReduce functions to compose
 * @returns Composed beforeReduce function
 *
 * @example
 * ```ts
 * const validate = (action, state) => action.type === 'Bad' ? null : action
 * const enrich = (action, state) => ({ ...action, timestamp: Date.now() })
 *
 * aio.run(state, {
 *   beforeReduce: composeMiddleware(validate, enrich),
 *   // ...
 * })
 * ```
 */
export { composeMiddleware } from "./src/aio.ts";

/**
 * Deep freeze for dev-mode immutability checking.
 */
export { deepFreeze } from "./src/dispatch.ts";

/**
 * Immer-powered immutable state update.
 * Mutate the draft inside the callback, return effects array.
 *
 * @param state - Current immutable state
 * @param fn - Callback that receives a draft to mutate; must return effects array
 * @returns New immutable state + effects
 *
 * @example
 * ```ts
 * return draft(state, d => {
 *   d.counter += 1
 *   return [{ type: 'counter:log', payload: { message: 'incremented' } }]
 * })
 * ```
 */
export function draft<S, E>(
  state: S,
  fn: (d: Draft<S>) => E[],
): { state: S; effects: E[] } {
  let effects: E[] = [];
  const next = produce(state, (d) => {
    effects = fn(d);
  });
  // Clone effects to detach from revoked Immer draft references.
  // Effects built inside produce() may hold draft refs that crash after finalization.
  // Guard against undefined in case the reducer forgot a return statement.
  if (!effects) {
    if (
      typeof globalThis !== "undefined" &&
      (globalThis as Record<string, unknown>).__aioDev
    ) {
      console.warn(
        'draft(): reducer callback did not return an effects array — defaulting to []. Add "return []" to your reducer.',
      );
    }
    effects = [];
  }
  if (effects.length) effects = structuredClone(effects);
  return { state: next, effects };
}

/**
 * Typed effect handler dispatch — alternative to switch/case in execute().
 * Scales better for apps with many effect types.
 *
 * @param effect - The effect to handle
 * @param handlers - Object mapping effect types to handler functions
 * @param fallback - Optional handler for unhandled effects
 *
 * @example
 * ```ts
 * matchEffect(effect, {
 *   Log: (p) => console.log(p.message),
 *   FetchUser: (p) => fetch(`/api/${p.id}`).then(...),
 * }, (e) => console.warn('unhandled:', e.type))
 * ```
 */
// deno-lint-ignore no-explicit-any
export function matchEffect<E extends { type: string; payload?: any }>(
  effect: E,
  handlers: Partial<
    {
      [K in E["type"]]: (
        payload: Extract<E, { type: K }> extends { payload: infer P } ? P
          : undefined,
      ) => void;
    }
  >,
  fallback?: (effect: E) => void,
): void {
  const handler = handlers[effect.type as E["type"]];
  if (handler) handler((effect as { payload?: unknown }).payload as never);
  else if (fallback) fallback(effect);
}

/**
 * React hook for connecting to the aio server via WebSocket.
 * Returns current state and send function for dispatching actions.
 *
 * @typeParam S - Your AppState type
 * @returns { state: S | null, send: (action) => void }
 *
 * @example
 * **Prefer `useFeature(ref)` for feature components** — scoped state, typed send, selective re-renders.
 * `useAio` re-renders on every state change. Use it only for root layout or cross-feature views.
 *
 * ```tsx
 * const { state, send } = useAio<AppState>()
 * if (!state) return <div>Connecting...</div>
 * ```
 */
export declare function useAio<S = unknown>(): {
  state: S | null;
  send: (action: { type: string; payload?: unknown }) => void;
};

/**
 * React hook — connects UI to a specific feature.
 * Returns scoped state, typed send proxy, and machine status.
 *
 * @param ref - Feature definition from feature()
 * @returns { state, send, status }
 *
 * @example
 * ```tsx
 * const { state, send, status } = useFeature(counter)
 * send.increment(5)   // dispatches { type: 'counter:increment', payload: { n: 5 } }
 * send.reset()
 * ```
 */
/** Keys built into FeatureDef — excluded from send proxy */
export type _FeatureBuiltins = "__aio";
/** Extract state type from feature def's phantom _stateType, fallback to unknown */
export type _InferState<F> = F extends { __aio: { stateType?: infer S } }
  // deno-lint-ignore no-explicit-any
  ? S extends Record<string, any> ? S : Record<string, unknown>
  : Record<string, unknown>;
/** Extract send proxy type from feature's callable methods */
export type _InferSend<F> = {
  [K in Exclude<keyof F, _FeatureBuiltins>]: F[K] extends // deno-lint-ignore no-explicit-any
  (...args: infer P) => any ? (...args: P) => void
    : never;
};

/** useFeature with fallback — state is never null */
// deno-lint-ignore no-explicit-any
export declare function useFeature<F extends Record<string, any>>(
  ref: F,
  options: { fallback: _InferState<F> },
): {
  state: _InferState<F>;
  send: _InferSend<F>;
  status: string | undefined;
};
/** useFeature without fallback — state may be null before connection */
// deno-lint-ignore no-explicit-any
export declare function useFeature<F extends Record<string, any>>(
  ref: F,
  options?: { fallback?: never },
): {
  state: _InferState<F> | null;
  send: _InferSend<F>;
  status: string | undefined;
};

/**
 * React hook for client-only state (not synced to server).
 * Useful for ephemeral UI state like form inputs, dropdowns, editing flags.
 *
 * @typeParam T - The state type
 * @param initial - Initial value
 * @returns { local: T, set: (next) => void }
 */
export declare function useLocal<T>(initial: T): {
  local: T;
  set: (next: T | ((prev: T) => T)) => void;
};

/**
 * Derives state from a transformation, preserving element-level references.
 *
 * Like `useMemo`, but applies `_preserveArrayRefs` to the output — unchanged
 * elements keep their previous object reference, enabling `memo()` to skip
 * re-renders for unchanged list items.
 *
 * @typeParam T - Return type of the transform function
 * @param fn - Transform function that derives state
 * @param deps - Dependency array (same semantics as `useMemo`)
 * @returns Transformed value with preserved references
 *
 * @example
 * ```tsx
 * const groups = useProjection(() => buildGroups(state.members), [state.members]);
 * ```
 */
export declare function useProjection<T>(fn: () => T, deps: unknown[]): T;

/**
 * Drop-in replacement for `React.memo` with smarter default comparison.
 *
 * Uses `_shallowEqual` on each prop (one level deeper than React.memo's `===`).
 * Catches the case where a parent creates new container objects that are
 * structurally identical to the previous props.
 *
 * @typeParam P - Props type
 * @param Component - React component to memoize
 * @param compare - Optional custom comparison function (defaults to per-prop _shallowEqual)
 * @returns Memoized component
 *
 * @example
 * ```tsx
 * import { memo } from "aio";  // NOT from "react"
 * export default memo(MemberCard);
 * ```
 */
export declare function memo<P extends Record<string, unknown>>(
  Component: ComponentType<P>,
  compare?: (prev: P, next: P) => boolean,
): ComponentType<P>;

/**
 * State-based routing. Renders the component matching a page key.
 *
 * @typeParam K - Union of page keys
 * @param current - Current page key from state
 * @param routes - Object mapping page keys to React components
 * @returns JSX element or null if no match
 *
 * @example
 * ```tsx
 * {page(state.page, { home: Home, settings: Settings })}
 * ```
 */
/** State-based page router — renders the component matching the current page key */
export declare function page<K extends string>(
  current: K,
  routes: Record<K, ComponentType>,
): ReactElement | null;

// ── URL-based routing ────────────────────────────────────────────────────────

/**
 * Current route state. Subscribe to URL changes.
 * With a pattern, extracts named params and signals whether the current path matched.
 *
 * @example
 * ```tsx
 * // No pattern — just track current path
 * const { path, search } = useRoute()
 *
 * // With pattern — extract params
 * const { params, matched } = useRoute('/users/:id')
 * if (!matched) return <NotFound />
 * return <User id={params.id} />
 * ```
 */
export declare function useRoute(pattern?: string): {
  path: string;
  params: Record<string, string>;
  search: URLSearchParams;
  matched: boolean;
};

/**
 * Returns the `navigate` function. Prefer `<Link>` for user-initiated navigation;
 * use `useNavigate` for programmatic navigation (e.g. after form submit).
 *
 * @example
 * ```tsx
 * const nav = useNavigate()
 * async function onSubmit() {
 *   await save()
 *   nav('/dashboard')
 * }
 * ```
 */
export declare function useNavigate(): (
  to: string | number,
  opts?: { replace?: boolean },
) => void;

/**
 * Navigate programmatically. Pass a string path or a history delta (number).
 * Uses `history.pushState` by default; pass `{ replace: true }` for `replaceState`.
 * Relative paths resolve against `location.href`.
 *
 * @example
 * ```ts
 * navigate('/users/42')
 * navigate(-1)          // browser back
 * navigate('/login', { replace: true })
 * ```
 */
export declare function navigate(
  to: string | number,
  opts?: { replace?: boolean },
): void;

/**
 * Renders `element` when the current URL matches `path`.
 * Nesting Routes creates a layout tree — the parent renders a layout component
 * that contains an `<Outlet />` where matched children appear.
 *
 * `index` renders the element when the parent path matches exactly (the default child).
 *
 * @example
 * ```tsx
 * // Flat routes
 * <Route path="/users" element={<UserList />} />
 * <Route path="/users/:id" element={<UserDetail />} />
 *
 * // Nested layout
 * <Route path="/dashboard" element={<DashboardLayout />}>
 *   <Route index element={<Overview />} />
 *   <Route path="settings" element={<Settings />} />
 * </Route>
 * ```
 */
export declare function Route(props: {
  path?: string;
  index?: boolean;
  element?: unknown;
  children?: unknown;
}): unknown;

/**
 * Renders the matched child route inside a parent `<Route>` layout.
 * Place inside the layout component returned by the parent Route's `element`.
 *
 * @example
 * ```tsx
 * function DashboardLayout() {
 *   return <div><Sidebar /><main><Outlet /></main></div>
 * }
 * ```
 */
export declare function Outlet(): unknown;

/**
 * Anchor that navigates without page reload. Adds `activeClass` when the path matches.
 * Exact match for `/` and when `exact={true}`; prefix match otherwise.
 *
 * @example
 * ```tsx
 * <Link to="/users">Users</Link>
 * <Link to="/users" exact activeClass="active" activeStyle={{ fontWeight: 'bold' }}>
 *   Users
 * </Link>
 * ```
 */
export declare function Link(props: {
  to: string;
  replace?: boolean;
  exact?: boolean;
  activeClass?: string;
  activeStyle?: Record<string, unknown>;
  children?: unknown;
  className?: string;
  style?: Record<string, unknown>;
  [k: string]: unknown;
}): unknown;

/**
 * Like `<Link>` but applies `activeClass` (default: `'active'`) automatically.
 * Drop-in for navigation menus.
 *
 * @example
 * ```tsx
 * <NavLink to="/dashboard">Dashboard</NavLink>
 * <NavLink to="/settings" activeClass="selected">Settings</NavLink>
 * ```
 */
export declare function NavLink(props: {
  to: string;
  activeClass?: string;
  [k: string]: unknown;
}): unknown;

/**
 * Navigates to `to` on mount. `replace` defaults to `true` (no history entry).
 * Use for auth guards and conditional redirects.
 *
 * @example
 * ```tsx
 * function ProtectedRoute({ children }) {
 *   const { state } = useAio()
 *   if (!state?.user) return <Redirect to="/login" />
 *   return children
 * }
 * ```
 */
export declare function Redirect(
  props: { to: string; replace?: boolean },
): null;

/**
 * Match a path pattern against a URL path. Returns extracted params or null.
 * Supports `:param` segments, `*` wildcard, and prefix matching.
 * Exported for custom routing logic.
 *
 * @example
 * ```ts
 * matchPath('/users/:id', '/users/42')          // { id: '42' }
 * matchPath('/users/:id', '/users/')            // null
 * matchPath('/dashboard', '/dashboard/x', false) // {} (prefix)
 * matchPath('*', '/any/path')                   // { '*': '/any/path' }
 * ```
 */
export declare function matchPath(
  pattern: string,
  path: string,
  exact?: boolean,
): Record<string, string> | null;

/** Router component prop types and route state */
export type { LinkProps, RouteProps, RouteState } from "./src/browser.ts";

/**
 * React hook for time-travel debugging in dev mode.
 * Returns null in production.
 *
 * @returns Object with entries, controls for undo/redo/goto/pause/resume, or null
 */
export declare function useTimeTravel(): {
  entries: { id: number; type: string; ts: number }[];
  index: number;
  paused: boolean;
  undo: () => void;
  redo: () => void;
  goto: (id: number) => void;
  pause: () => void;
  resume: () => void;
} | null;

// ── Framework-agnostic client ─────────────────────────────────────────────

/**
 * Framework-agnostic client for wiring aio into non-React frameworks.
 * Exposes the same singleton connection used by `useAio`/`useFeature`.
 * Subscribe to state, send actions, and access routing — no React required.
 *
 * @example
 * ```ts
 * import { client } from 'aio'
 *
 * // Subscribe to state changes
 * const unsub = client.subscribe((state) => {
 *   console.log('new state:', state)
 * })
 *
 * // Send actions
 * client.send({ type: 'counter:increment', payload: { by: 1 } })
 *
 * // Get current state
 * const state = client.getState()
 *
 * // Feature slice
 * const counterState = client.getFeatureState('counter')
 *
 * // Routing
 * client.route.subscribe(() => console.log('path:', client.route.getPath()))
 * client.route.navigate('/users/42')
 * ```
 */
export declare const client: {
  subscribe(fn: (state: unknown) => void): () => void;
  getState(): unknown;
  getFeatureState(name: string): unknown;
  send(action: { type: string; payload?: unknown }): void;
  route: {
    subscribe(fn: () => void): () => void;
    getPath(): string;
    getSearch(): URLSearchParams;
    navigate(to: string | number, opts?: { replace?: boolean }): void;
  };
};

/**
 * Connect to Redux DevTools browser extension for state inspection.
 * Call after useAio() in development mode.
 *
 * @example
 * ```ts
 * // In App.tsx
 * const { state, send } = useAio<AppState>()
 * useEffect(() => { connectDevTools() }, [])
 * ```
 */
export declare function connectDevTools(): void;

/**
 * Disconnect from Redux DevTools.
 */
export declare function disconnectDevTools(): void;

/**
 * Utility type: extracts the union of all payload types from an actions/effects catalog.
 * Useful for discriminated union switch/case in reducers.
 */
export type { UnionOf } from "./src/standalone.ts";

/**
 * Standalone runtime for Android WebView (no Deno required).
 * Real implementation in standalone.ts, interface declared here for editor support.
 *
 * @typeParam S - AppState type
 * @typeParam A - Action union type
 * @typeParam E - Effect union type
 * @returns AioApp instance with state access
 */
export declare function initStandalone<S, A, E>(initialState: S, config: {
  reduce: (
    state: S,
    action: A,
  ) => { state: S; effects: (E | ScheduleEffect)[] };
  execute: (app: AioApp<S, A>, effect: E) => void;
  persist?: boolean;
  stateForDB?: (state: S) => Partial<S>;
  stateForUI?: (state: S) => unknown;
  persistKey?: string;
  persistDebounceMs?: number;
  perfCheck?: PerfCheck;
  perfBudget?: PerfBudget;
  onRestore?: (state: S) => S;
}): AioApp<S, A>;
