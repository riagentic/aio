/**
 * @module
 * Full-stack Deno framework — one state, propagated everywhere.
 *
 * v0.9: async Worker-based SQLite, `log` public singleton, scaffolder via JSR.
 * v0.8: unified feature API, typed generators, no raw strings anywhere.
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
import { produce, type Draft } from 'immer'
import type { PerfMode, PerfBudget } from './src/dispatch.ts'

/** Framework version string */
export { aio, VERSION, parseCli, lint } from './src/aio.ts'
import type { AioApp } from './src/aio.ts'
export type { AioApp }
export type { FeaturesConfig, UiConfig, Lint, CliFlags, AioUser, AioError, PerfMode, PerfBudget } from './src/aio.ts'
export { log } from './src/logger.ts'
export type { Log, LogConfig, LogLevel } from './src/logger.ts'
export type { AioMeta } from './src/electron.ts'
export type { LockData, InstanceInfo, SingletonMode } from './src/single-instance-lock.ts'
export { instances, resolveAppId, slugify } from './src/single-instance-lock.ts'

/**
 * v0.8 unified feature API.
 * feature({ methods })           — default reactive style (sync/async, Immer proxy, direct calling)
 * feature({ methods, generators }) — reactive + sequential workflows in one feature
 * feature({ actions, reduce })   — explicit style for full control (advanced)
 */
export { feature, composeFeatures, testFeature, tagSource, bindFeature } from './src/feature.ts'
export type { FeatureDef, FeatureEntry, MachineConfig, Catalog, ActionUnion, TestContext, FeatureStatus, ActionSource, ScopedApp, DirectCalling } from './src/feature.ts'

/**
 * Inter-feature coordination — async methods return Promises with the correct type.
 * Everything goes through the store (observable, time-travelable).
 *
 * Simple — preferred for most cases:
 * ```ts
 * import { inventory } from '../inventory'
 * const reserved = await inventory.reserve(items)  // ← typed Promise<ReserveResult>
 * ```
 *
 * With timeout/retry:
 * ```ts
 * const result = await call({ timeout: 5000, retries: 2 }, () => inventory.reserve(items))
 * ```
 *
 * `markAsync` — rare: explicitly mark a method as async when minification strips constructor names.
 */
export { call, markAsync } from './src/feature-impl.ts'
export type { CallOptions } from './src/feature-impl.ts'

/**
 * Generator-based sequential workflows.
 * Write top-to-bottom async code; each yield point is observable.
 * Use cancelOn config key in feature() to declare cancellation triggers.
 */
export type { GenCtx, Gen, TypedCreator } from './src/flow.ts'

/** 
 * Connect to a remote aio server from a CLI app.
 * Returns a CliApp with state, send, subscribe, close, connected, and ready.
 * @param url - WebSocket URL of the aio server (e.g., 'ws://localhost:8000/ws')
 * @param opts - Optional { token?: string } for auth
 */
export { connectCli, connectCliUDS } from './src/cli-client.ts'
export type { CliApp } from './src/cli-client.ts'

/**
 * Low-level message constructor. Use action creators (A.increment()) instead.
 * @param type - Action/effect type string
 * @param payload - Optional payload object
 */
export { msg } from './src/msg.ts'

/**
 * Action/effect catalog factory — creates typed creators from a descriptor object.
 * @example
 * ```ts
 * const A = actions({ increment: (by = 1) => ({ by }), reset: () => ({}) })
 * A.increment(5) // → { type: 'increment', payload: { by: 5 } }
 * ```
 */
export { actions, effects } from './src/factory.ts'

/**
 * Declarative schedules — timers, intervals, cron jobs as effects.
 * @see {@link https://aio.dev/manual#scheduled-effects}
 */
export { schedule } from './src/schedule.ts'
import type { ScheduleEffect } from './src/schedule.ts'
export type { ScheduleEffect, ScheduleDef } from './src/schedule.ts'

/**
 * SQLite column helpers for defining table schemas.
 * @see {@link https://aio.dev/manual#sqlite-persistence}
 */
export { table, pk, text, integer, real, ref } from './src/sql.ts'
export type { ColumnDef, ColumnOpts, QueryOpts, TableDef, WhereClause, WhereOp } from './src/sql.ts'

/**
 * Async SQLite — Worker-backed, non-blocking.
 * `createDB` is for direct use; `app.db` is the instance managed by the framework.
 */
export { createDB, DEFAULT_PRAGMAS } from './src/db/mod.ts'
export type { DB, QueryResult, DBOpts } from './src/db/mod.ts'

/**
 * Memoized selectors for expensive state derivations.
 * Caches results until input selectors return new values.
 */
export { createSelector, createSliceSelector } from './src/selector.ts'

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
export { composeMiddleware } from './src/aio.ts'

/**
 * Deep freeze for dev-mode immutability checking.
 */
export { deepFreeze } from './src/dispatch.ts'

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
 *   return [E.log('incremented')]
 * })
 * ```
 */
export function draft<S, E>(state: S, fn: (d: Draft<S>) => E[]): { state: S; effects: E[] } {
  let effects: E[] = []
  const next = produce(state, (d) => {
    effects = fn(d)
  })
  // Clone effects to detach from revoked Immer draft references.
  // Effects built inside produce() may hold draft refs that crash after finalization.
  // Guard against undefined in case the reducer forgot a return statement.
  if (!effects) {
    if (typeof globalThis !== 'undefined' && (globalThis as Record<string, unknown>).__aioDev) {
      console.warn('draft(): reducer callback did not return an effects array — defaulting to []. Add "return []" to your reducer.')
    }
    effects = []
  }
  if (effects.length) effects = structuredClone(effects)
  return { state: next, effects }
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
  handlers: Partial<{ [K in E['type']]: (payload: Extract<E, { type: K }> extends { payload: infer P } ? P : undefined) => void }>,
  fallback?: (effect: E) => void,
): void {
  const handler = handlers[effect.type as E['type']]
  if (handler) handler((effect as { payload?: unknown }).payload as never)
  else if (fallback) fallback(effect)
}

/**
 * React hook for connecting to the aio server via WebSocket.
 * Returns current state and send function for dispatching actions.
 *
 * @typeParam S - Your AppState type
 * @returns { state: S | null, send: (action) => void }
 *
 * @example
 * ```tsx
 * const { state, send } = useAio<AppState>()
 * if (!state) return <div>Connecting...</div>
 * return <button onClick={() => send(A.increment())}>+</button>
 * ```
 */
export declare function useAio<S = unknown>(): {
  state: S | null
  send: (action: { type: string; payload?: unknown }) => void
}

/** Proxy type for send — each action key becomes a dispatch method with typed args */
// deno-lint-ignore no-explicit-any
export type SendProxy<A extends Record<string, any>> = {
  // deno-lint-ignore no-explicit-any
  [K in keyof A]: A[K] extends (...args: infer P) => any ? (...args: P) => void : never
}

/**
 * v0.5 React hook — connects UI to a specific feature.
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
// deno-lint-ignore no-explicit-any
export declare function useFeature<S, A extends Record<string, any> = Record<string, (...args: unknown[]) => void>>(ref: any, options: { fallback: S }): {
  state: S
  // deno-lint-ignore no-explicit-any
  send: Record<string, (...args: any[]) => void>
  status: string | undefined
}
// deno-lint-ignore no-explicit-any
export declare function useFeature<S = unknown, A extends Record<string, any> = Record<string, (...args: unknown[]) => void>>(ref: {
  name: string
  A: A
  _config: { actionKeys: string[] }
}, options?: { fallback?: never }): {
  state: S | null
  send: SendProxy<A>
  status: string | undefined
}

/**
 * React hook for client-only state (not synced to server).
 * Useful for ephemeral UI state like form inputs, dropdowns, editing flags.
 * 
 * @typeParam T - The state type
 * @param initial - Initial value
 * @returns { local: T, set: (next) => void }
 */
export declare function useLocal<T>(initial: T): {
  local: T
  set: (next: T | ((prev: T) => T)) => void
}

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
import type { ComponentType, ReactElement } from 'react'
export declare function page<K extends string>(current: K, routes: Record<K, ComponentType>): ReactElement | null

/**
 * React hook for time-travel debugging in dev mode.
 * Returns null in production.
 * 
 * @returns Object with entries, controls for undo/redo/goto/pause/resume, or null
 */
export declare function useTimeTravel(): {
  entries: { id: number; type: string; ts: number }[]
  index: number
  paused: boolean
  undo: () => void
  redo: () => void
  goto: (id: number) => void
  pause: () => void
  resume: () => void
} | null

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
export declare function connectDevTools(): void

/**
 * Disconnect from Redux DevTools.
 */
export declare function disconnectDevTools(): void

/**
 * Utility type: extracts the union of all payload types from an actions/effects catalog.
 * Useful for discriminated union switch/case in reducers.
 */
export type { UnionOf } from './src/standalone.ts'

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
  reduce: (state: S, action: A) => { state: S; effects: (E | ScheduleEffect)[] }
  execute: (app: AioApp<S, A>, effect: E) => void
  persist?: boolean
  stateForDB?: (state: S) => Partial<S>
  stateForUI?: (state: S) => unknown
  persistKey?: string
  persistDebounce?: number
  perfMode?: PerfMode
  perfBudget?: PerfBudget
  onRestore?: (state: S) => S
}): AioApp<S, A>
