/**
 * @module
 * Full-stack Deno framework — one state, propagated everywhere.
 *
 * ONE style: `cell({ state, methods })` — methods mutate a draft; async
 * methods do real work (await, until(), race()) and can be cancelled via
 * `cancelOn` + `s.$signal`. (aio v2 / perfect-aio D1: the legacy
 * actions/reduce/machine/generators layer was removed — see
 * docs/upgrade/to-v2.md.)
 *
 * ```ts
 * import { aio, cell, race, until } from 'aio'
 *
 * const counter = cell('counter', {
 *   state: { count: 0 },
 *   methods: {
 *     increment(s, by = 1) { s.count += by },
 *   },
 * })
 *
 * const checkout = cell('checkout', {
 *   state: { status: 'idle', orderId: null as string | null },
 *   cancelOn: { place: ['cart:clear'] },   // cart.clear aborts a running place()
 *   methods: {
 *     async place(s, item: string) {
 *       s.status = 'placing'
 *       const id = await submitOrder(item)
 *       const r = await race({ ok: until(() => s.status === 'placing'), timeout: 30_000 })
 *       s.orderId = id
 *       s.status = 'placed'
 *     },
 *   },
 * })
 *
 * await aio.run({ cells: [counter, checkout] })
 * counter.increment(5)       // direct call — dispatches through store
 * counter.count              // direct state read — reactive in components
 * await checkout.place('widget')
 * ```
 */
import { type Draft, produce } from "immer";
/** Framework core — `aio.run()` starts the app, `lint` validates cells, `parseCli` reads CLI flags */
export { aio, lint, parseCli, VERSION } from "./src/server/aio.ts";
import type { AioApp } from "./src/server/aio.ts";
/** The running app instance returned by `aio.run()` — provides state access, dispatch, db, and lifecycle */
export type { AioApp };
/** Core configuration, error, and middleware types for `aio.run()` */
export type {
  AioError,
  AioUser,
  CellsConfig,
  CliFlags,
  Lint,
  PerfBudget,
  PerfCheck,
  ResolveUserFn,
  UiConfig,
} from "./src/server/aio.ts";
/** Structured error types — error codes, context, source tracking, and flow step records */
export type {
  AioErrorCode,
  AioErrorContext,
  AioErrorSource,
  FlowStepRecord,
} from "./src/diagnostics/error.ts";
/** Memory monitor configuration and heap usage report types */
export type {
  CellStateSize,
  MemoryConfig,
  MemoryReport,
} from "./src/diagnostics/memory-monitor.ts";
/** Client-side render budget thresholds — staleness and pending patch count */
export type { RenderBudget } from "./src/vitals/types.ts";
/** Phase-level timing breakdown inside a single reduce cycle */
export type { ReduceBreakdown } from "./src/diagnostics/time-travel.ts";
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
export { log } from "./src/diagnostics/logger.ts";
/** Logger configuration and level types */
export type { Log, LogConfig, LogLevel } from "./src/diagnostics/logger.ts";
/** Electron app metadata injected into the renderer process */
export type { AioMeta } from "./src/electron/electron.ts";
/** Single-instance lock types — instance info, lock data, singleton mode */
export type {
  InstanceInfo,
  LockData,
  SingletonMode,
} from "./src/server/single-instance-lock.ts";
/** Single-instance lock — `instances()` lists running apps, `resolveAppId` normalizes IDs */
export { instances, resolveAppId } from "./src/server/single-instance-lock.ts";
// slugify — internal (used by build.ts, not app code)

/**
 * v0.8 unified cell API.
 * cell({ methods })           — default reactive style (sync/async, Immer proxy, direct calling)
 * cell({ methods, generators }) — reactive + sequential workflows in one cell
 * cell({ actions, reduce })   — explicit style for full control (advanced)
 */
export { bindCell, testCell } from "./src/state/cell.ts";
/** Define a cell — state + methods (+ selectors, sync, cancelOn). The atomic unit of aio. */
export { cell } from "./src/state/cell.ts";
/** Compose cells into a single dispatch/reduce/execute pipeline with dependency resolution. */
export { composeCells } from "./src/state/cell.ts";
/** Cell definition types — catalogs, compose, test context */
export type {
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
  ExtractState,
  MethodsCellConfig,
  Msg,
  ScopedApp,
  SendOf,
  StateOf,
  TestContext,
} from "./src/state/cell.ts";

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
export { call } from "./src/state/cell-impl.ts";
/** Mark a method as async when minification strips constructor names — rare escape hatch. */
export { markAsync } from "./src/state/cell-impl.ts";
/** Method types for cell definitions — sync, async, call options */
export type {
  AsyncMethod,
  CallOptions,
  CellMethods,
  Method,
  SyncMethod,
} from "./src/state/cell-impl.ts";
/** Draft annotation for cancellation-aware async methods —
 *  `async place(s: State & Partial<MethodDraftMeta>) { … s.$signal … }` */
export type { MethodDraftMeta } from "./src/state/cell-impl.ts";

/**
 * Connect to a remote aio server from a CLI app.
 * Returns a CliApp with state, send, subscribe, close, connected, and ready.
 * @param url - WebSocket URL of the aio server (e.g., 'ws://localhost:8000/ws')
 * @param opts - Optional { token?: string } for auth
 */
export { connectCli, connectCliUDS } from "./src/server/cli-client.ts";
/** CLI client connection type — state, send, subscribe, close, ready */
export type { CliApp } from "./src/server/cli-client.ts";

/**
 * Declarative schedules — timers, intervals, cron jobs as effects.
 * @see {@link https://aio.dev/manual#scheduled-effects}
 */
// Async-method workflow helpers (perfect-aio D1 — the method-native
// replacements for generator ctx.waitFor / ctx.race / ctx.sleep).
export {
  race,
  sleep,
  until,
  type UntilOptions,
  UntilTimeoutError,
} from "./src/state/async-helpers.ts";
export { schedule } from "./src/state/schedule.ts";
/** Schedule definition and effect types for timers, intervals, and cron */
export type { ScheduleDef, ScheduleEffect } from "./src/state/schedule.ts";

/**
 * Keyed disposer slots — own native resources (watchers, sockets) from
 * reducers/methods with schedule-like replace semantics. Disposed on cell
 * disable and app shutdown.
 */
export { own } from "./src/state/own.ts";
/** Own effect type for keyed resource slots */
export type { OwnDisposer, OwnEffect, OwnResource } from "./src/state/own.ts";
/** Union of everything a method may return as an effect — use as the return
 *  annotation when a method references its own cell (breaks TS7022/7023). */
export type { CellEffect } from "./src/state/cell-impl.ts";

/**
 * SQLite column helpers for defining table schemas.
 * @see {@link https://aio.dev/manual#sqlite-persistence}
 */
export { integer, pk, real, ref, table, text } from "./src/server/sql.ts";
/** SQL schema and query types — column definitions, table schemas, where clauses */
export type {
  ColumnDef,
  ColumnOpts,
  QueryOpts,
  TableDef,
  WhereClause,
  WhereOp,
} from "./src/server/sql.ts";

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
 * Deep freeze for dev-mode immutability checking.
 */
export { deepFreeze } from "./src/state/dispatch.ts";

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
 * Keys built into CellDef — excluded from send proxy.
 * @internal Exported for type inference only — not part of the stable API.
 */
export type _CellBuiltins = "__aio";
/**
 * Extract state type from cell def's phantom _stateType, fallback to unknown.
 * @internal Exported for type inference only — not part of the stable API.
 */
export type _InferState<F> = F extends { __aio: { stateType?: infer S } }
  // deno-lint-ignore no-explicit-any
  ? S extends Record<string, any> ? S : Record<string, unknown>
  : Record<string, unknown>;
/**
 * Extract send proxy type from cell's callable methods.
 * @internal Exported for type inference only — not part of the stable API.
 */
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
