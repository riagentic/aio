// Public API — everything users import from 'aio'
import { produce, type Draft } from 'immer'
import type { PerfMode, PerfBudget } from './src/dispatch.ts'

/** Framework version string */
export { aio, VERSION, parseCli, lint } from './src/aio.ts'
import type { AioApp } from './src/aio.ts'
export type { AioApp }
export type { AioConfig, UiConfig, Lint, CliFlags, AioUser, AioError, PerfMode, PerfBudget, FeaturesConfig } from './src/aio.ts'
export type { AioMeta } from './src/electron.ts'

/**
 * v0.5 feature-based architecture.
 * feature() — define a feature (state, actions, effects, machine, reduce, execute, selectors)
 * bridge()  — define a cross-feature bridge (request/response, timeouts, retries)
 */
export { feature, bridge, composeFeatures, testFeature, testBridge, tagSource } from './src/feature.ts'
export type { FeatureDef, FeatureEntry, MachineConfig, Catalog, TestContext, BridgeTestContext, FeatureStatus, ActionSource, ScopedApp } from './src/feature.ts'

/**
 * Generator-based sequential workflows.
 * flow() — define a sequential workflow triggered by an action.
 * Write top-to-bottom async code; each yield point is observable.
 */
export { flow } from './src/flow.ts'
export type { FlowDef, FlowCtx, Gen } from './src/flow.ts'

/** 
 * Connect to a remote aio server from a CLI app.
 * Returns a CliApp with state, send, subscribe, close, connected, and ready.
 * @param url - WebSocket URL of the aio server (e.g., 'ws://localhost:8000/ws')
 * @param opts - Optional { token?: string } for auth
 */
export { connectCli } from './src/cli-client.ts'
export type { CliApp } from './src/cli-client.ts'

/**
 * Extracts return types of all function members into a union type.
 * Used to derive Action and Effect types from action/effect catalogs.
 * 
 * @example
 * ```ts
 * const A = actions({ Increment: (by: number) => ({ by }) })
 * type Action = UnionOf<typeof A>
 * // => { type: 'Increment'; payload: { by: number } }
 * ```
 */
// deno-lint-ignore no-explicit-any
export type UnionOf<T> = { [K in keyof T]: T[K] extends (...args: any[]) => infer R ? R : never }[keyof T]

/** 
 * Low-level message constructor. Use action creators (A.increment()) instead.
 * @param type - Action/effect type string
 * @param payload - Optional payload object
 */
export { msg } from './src/msg.ts'

/**
 * Factory for creating typed action catalogs.
 * @returns Object with PascalCase labels (A.Increment) and camelCase creators (A.increment(5))
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
 * SQLite column helpers for defining tables.
 * @see {@link https://aio.dev/manual#sqlite-persistence}
 */
export { table, pk, text, integer, real, ref } from './src/sql.ts'
export type { AioDB, AioTable, ColumnDef, ColumnOpts, QueryOpts, TableDef, WhereClause, WhereOp } from './src/sql.ts'

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

/**
 * v0.5 React hook — connects UI to a specific feature.
 * Returns scoped state, typed send, and machine status.
 *
 * @param ref - Feature definition from feature()
 * @returns { state, send, status }
 *
 * @example
 * ```tsx
 * const { state, send, status } = useFeature(counter)
 * return <button onClick={() => send.increment(5)}>+5</button>
 * ```
 */
export declare function useFeature<S = unknown>(ref: {
  name: string
  // deno-lint-ignore no-explicit-any
  A: Record<string, any>
  _config: { actionKeys: string[] }
}): {
  state: S | null
  send: Record<string, (...args: unknown[]) => void>
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
  getDBState?: (state: S) => Partial<S>
  getUIState?: (state: S) => unknown
  persistKey?: string
  persistDebounce?: number
  perfMode?: PerfMode
  perfBudget?: PerfBudget
  onRestore?: (state: S) => S
}): AioApp<S, A>
