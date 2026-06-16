/**
 * @module
 * Full-stack Deno framework — one state, propagated everywhere.
 *
 * v1.0: clean API, framework-agnostic client, cell.ts split, perf.log, am client inspection.
 * v0.9: async Worker-based SQLite, `log` public singleton, scaffolder via JSR.
 * Use `cell({ methods })` for reactive style (default),
 * `cell({ generators })` for sequential workflows,
 * `cell({ actions, reduce })` for explicit control (advanced).
 *
 * ```ts
 * import { cell, call, aio } from 'aio'
 *
 * // Reactive style — default
 * const counter = cell('counter', {
 *   state: { count: 0 },
 *   methods: {
 *     increment(s, by = 1) { s.count += by },
 *     async save(s) { await call({ timeout: 3000 }, () => persist(s.count)) },
 *   },
 * })
 *
 * // Sequential workflow — generator with typed state
 * const checkout = cell('checkout', {
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
 * await aio.run({ cells: [counter, checkout] })
 * counter.increment(5)       // direct call — dispatches through store
 * counter.count              // direct state read — reactive in components
 * checkout.place('widget')   // starts generator
 * ```
 */
import { type Draft, produce } from "immer";
/** Framework core — `aio.run()` starts the app, `lint` validates cells, `parseCli` reads CLI flags */
export { aio, lint, parseCli, VERSION } from "./src/aio.ts";
import type { AioApp } from "./src/aio.ts";
/** The running app instance returned by `aio.run()` — provides state access, dispatch, db, and lifecycle */
export type { AioApp };
/** Core configuration, error, and middleware types for `aio.run()` */
export type {
  AioError,
  AioUser,
  CellsConfig,
  CliFlags,
  Lint,
  MiddlewareFn,
  PerfBudget,
  PerfCheck,
  ResolveUserFn,
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
  CellStateSize,
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
 * v0.8 unified cell API.
 * cell({ methods })           — default reactive style (sync/async, Immer proxy, direct calling)
 * cell({ methods, generators }) — reactive + sequential workflows in one cell
 * cell({ actions, reduce })   — explicit style for full control (advanced)
 */
export { bindCell, testCell } from "./src/cell.ts";
/** Define a cell — methods, generators, actions/reduce, or mixed. The atomic unit of aio. */
export { cell } from "./src/cell.ts";
/** Compose cells into a single dispatch/reduce/execute pipeline with dependency resolution. */
export { composeCells } from "./src/cell.ts";
/** Cell definition types — actions, catalogs, machine config, compose, test context */
export type {
  ActionsCellConfig,
  ActionSource,
  ActionUnion,
  Catalog,
  CellAio,
  CellDef,
  CellEntry,
  CellExecuteFn,
  CellReduceFn,
  CellStatus,
  CircuitBreakerConfig,
  ComposedCells,
  Creators,
  DirectCalling,
  ExecuteHandlers,
  ExtractState,
  FlatActions,
  MachineConfig,
  MethodsCellConfig,
  Msg,
  ReduceHandlers,
  ScopedApp,
  SendOf,
  StateOf,
  TestContext,
} from "./src/cell.ts";

/**
 * Inter-cell coordination — async methods return Promises with the correct type.
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
/** Wrap an inter-cell call with timeout and/or retry — `call({ timeout: 5000 }, () => f.method())`. */
export { call } from "./src/cell-impl.ts";
/** Mark a method as async when minification strips constructor names — rare escape hatch. */
export { markAsync } from "./src/cell-impl.ts";
/** Method types for cell definitions — sync, async, call options */
export type {
  AsyncMethod,
  CallOptions,
  CellMethods,
  Method,
  SyncMethod,
} from "./src/cell-impl.ts";

/**
 * Generator-based sequential workflows.
 * Write top-to-bottom async code; each yield point is observable.
 * Use cancelOn config key in cell() to declare cancellation triggers.
 */
/** Generator workflow types — flow definitions, steps, context, and typed creators */
export type {
  FlowDef,
  FlowStep,
  Gen,
  GenCtx,
  SingleStepGen,
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
 * Action/effect catalog factory — creates typed creators for explicit-style cells.
 * Used inside `cell({ actions, effects })` config or for standalone catalogs.
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
/** Schedule definition and effect types for timers, intervals, and cron */
export type { ScheduleDef, ScheduleEffect } from "./src/schedule.ts";

/**
 * Keyed disposer slots — own native resources (watchers, sockets) from
 * reducers/methods with schedule-like replace semantics. Disposed on cell
 * disable and app shutdown.
 */
export { own } from "./src/own.ts";
/** Own effect type for keyed resource slots */
export type { OwnDisposer, OwnEffect, OwnResource } from "./src/own.ts";

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
/** Memoized selector scoped to a single cell slice — avoids full-state dependency. */
export { createSliceSelector } from "./src/selector.ts";
/** Selector type — a function from state to derived value with memoization. */
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

/** Keys built into CellDef — excluded from send proxy */
export type _CellBuiltins = "__aio";
/** Extract state type from cell def's phantom _stateType, fallback to unknown */
export type _InferState<F> = F extends { __aio: { stateType?: infer S } }
  // deno-lint-ignore no-explicit-any
  ? S extends Record<string, any> ? S : Record<string, unknown>
  : Record<string, unknown>;
/** Extract send proxy type from cell's callable methods */
export type _InferSend<F> = {
  [K in Exclude<keyof F, _CellBuiltins>]: F[K] extends // deno-lint-ignore no-explicit-any
  (...args: infer P) => any ? (...args: P) => void
    : never;
};

/**
 * Utility type: extracts the union of all payload types from an actions/effects catalog.
 * Useful for discriminated union switch/case in reducers.
 */
export type UnionOf<T> = {
  // deno-lint-ignore no-explicit-any
  [K in keyof T]: T[K] extends (...args: any[]) => infer R ? R : never;
}[keyof T];
