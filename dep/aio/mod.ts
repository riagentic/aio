// Public API — everything users import from 'aio'
import { produce, type Draft } from 'immer'

export { aio, VERSION, parseCli, lint } from './src/aio.ts'
import type { AioApp } from './src/aio.ts'
export type { AioApp }
export type { AioConfig, UiConfig, Lint, CliFlags, AioUser, AioError } from './src/aio.ts'
export type { AioMeta } from './src/electron.ts'
export { connectCli } from './src/cli-client.ts'
export type { CliApp } from './src/cli-client.ts'

/** Extracts return types of all function members into a union: UnionOf<typeof A> */
// deno-lint-ignore no-explicit-any
export type UnionOf<T> = { [K in keyof T]: T[K] extends (...args: any[]) => infer R ? R : never }[keyof T]

export { msg } from './src/msg.ts'
export { actions, effects } from './src/factory.ts'
export { schedule } from './src/schedule.ts'
import type { ScheduleEffect } from './src/schedule.ts'
export type { ScheduleEffect, ScheduleDef } from './src/schedule.ts'
export { table, pk, text, integer, real, ref } from './src/sql.ts'
export type { AioDB, AioTable, ColumnDef, ColumnOpts, TableDef, WhereClause, WhereOp } from './src/sql.ts'

/** Immutable state update — mutate the draft, return effects */
export function draft<S, E>(state: S, fn: (d: Draft<S>) => E[]): { state: S; effects: E[] } {
  let effects: E[] = []
  const next = produce(state, (d) => {
    effects = fn(d)
  })
  // Clone effects to detach from revoked Immer draft references.
  // Effects built inside produce() may hold draft refs that crash after finalization.
  if (effects.length) effects = structuredClone(effects)
  return { state: next, effects }
}

/** Typed effect handler dispatch — alternative to switch/case in execute() */
// deno-lint-ignore no-explicit-any
export function matchEffect<E extends { type: string; payload?: any }>(
  effect: E,
  // deno-lint-ignore no-explicit-any
  handlers: Partial<{ [K in E['type']]: (payload: any) => void }>,
  fallback?: (effect: E) => void,
): void {
  const handler = handlers[effect.type as E['type']]
  if (handler) handler((effect as { payload?: unknown }).payload)
  else if (fallback) fallback(effect)
}

// Browser-only — real implementations in browser.ts, typed here for editor support
export declare function useAio<S = unknown>(): {
  state: S | null
  send: (action: { type: string; payload?: unknown }) => void
}

// Client-only state — not synced, not persisted
export declare function useLocal<T>(initial: T): {
  local: T
  set: (next: T | ((prev: T) => T)) => void
}

// Renders the component matching the current page key
import type { ComponentType, ReactElement } from 'react'
export declare function page<K extends string>(current: K, routes: Record<K, ComponentType>): ReactElement | null

// Time-travel debugger — returns null in prod mode
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

// Standalone runtime — real implementation in standalone.ts, typed here for editor support
export declare function initStandalone<S, A, E>(initialState: S, config: {
  reduce: (state: S, action: A) => { state: S; effects: (E | ScheduleEffect)[] }
  execute: (app: AioApp<S, A>, effect: E) => void
  persist?: boolean
  getDBState?: (state: S) => Partial<S>
  getUIState?: (state: S) => unknown
  persistKey?: string
  persistDebounce?: number
  onRestore?: (state: S) => S
}): AioApp<S, A>
