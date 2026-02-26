// Public API — everything users import from 'aio'
import { produce, type Draft } from 'immer'

export { aio } from './src/aio.ts'
export type { AioApp, AioConfig, UiConfig } from './src/aio.ts'

// Extracts return types of all function members into a union: UnionOf<typeof A>
// deno-lint-ignore no-explicit-any
export type UnionOf<T> = { [K in keyof T]: T[K] extends (...args: any[]) => infer R ? R : never }[keyof T]

export { msg } from './src/msg.ts'

// Immutable state update — mutate the draft, return effects
export function draft<S, E>(state: S, fn: (d: Draft<S>) => E[]): { state: S; effects: E[] } {
  let effects: E[] = []
  const next = produce(state, (d) => {
    effects = fn(d)
  })
  return { state: next, effects }
}

// Browser-only — real implementations in browser.ts, typed here for editor support
export declare function useAio<T = unknown>(): {
  state: T | null
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
