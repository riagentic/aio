/// <reference lib="dom" />
// Standalone runtime — full client-side dispatch loop for Android WebView builds
// Replaces browser.ts when building with --android. Same API, no server.
import { useState, useEffect, createElement, type ComponentType } from 'react'
import { produce, type Draft } from 'immer'
import { msg } from './msg.ts'
import { actions, effects } from './factory.ts'
import { deepMerge } from './deep-merge.ts'
import { createDispatch, type PerfMode, type PerfBudget } from './dispatch.ts'
import type { AioApp } from './aio.ts'
import { isScheduleEffect, type ScheduleEffect } from './schedule.ts'

// Re-exports for user code — reduce.ts imports { draft } from 'aio', etc.
export { msg, actions, effects }

/** Extracts return types of all function members into a union */
// deno-lint-ignore no-explicit-any
export type UnionOf<T> = { [K in keyof T]: T[K] extends (...args: any[]) => infer R ? R : never }[keyof T]

// WHY DUPLICATED: draft() is a copy of mod.ts draft(). standalone.ts can't import mod.ts
// because it IS the aio entrypoint for Android builds (replaces browser.ts + mod.ts).
/** Immutable state update — mutate the draft, return effects */
export function draft<S, E>(state: S, fn: (d: Draft<S>) => E[]): { state: S; effects: E[] } {
  let effects: E[] = []
  const next = produce(state, (d) => { effects = fn(d) })
  if (effects.length) effects = structuredClone(effects)
  return { state: next, effects }
}

// ── Internal state (singleton, same pattern as browser.ts) ──

type StateListener = (state: unknown) => void
const _listeners = new Set<StateListener>()
let _state: unknown = null
let _app: AioApp | null = null

/** Notifies all React subscribers of state change */
function _notify(): void { for (const fn of _listeners) fn(_state) }

// ── Standalone config ──

type StandaloneConfig<S, A, E> = {
  reduce: (state: S, action: A) => { state: S; effects: (E | ScheduleEffect)[] }
  execute: (app: AioApp<S, A>, effect: E) => void
  persist?: boolean
  getDBState?: (state: S) => unknown
  getUIState?: (state: S) => unknown
  persistKey?: string
  persistDebounce?: number       // ms between localStorage writes (default: 100)
  perfMode?: PerfMode           // 'strict' or 'soft' — performance violation handling
  perfBudget?: PerfBudget       // override default budgets
  freezeState?: boolean         // deep freeze state after reduce to catch mutations (default: true)
  onRestore?: (state: S) => S    // transform state after restore, before UI renders
}

const STORAGE_KEY = 'aio_state'

/** Initializes standalone runtime — call before React mounts */
export function initStandalone<S, A, E>(initialState: S, config: StandaloneConfig<S, A, E>): AioApp<S, A> {
  const { reduce, execute } = config
  const shouldPersist = config.persist !== false
  const getDBState = config.getDBState ?? ((s: S) => s)
  const getUIState = config.getUIState ?? ((s: S) => s)
  const persistKey = config.persistKey ?? STORAGE_KEY

  // Restore from localStorage
  let state = initialState
  if (shouldPersist) {
    try {
      const raw = localStorage.getItem(persistKey)
      if (raw) {
        const persisted = JSON.parse(raw)
        state = deepMerge(initialState as Record<string, unknown>, persisted as Record<string, unknown>) as S
      }
    } catch (e) {
      console.warn('[aio] localStorage restore failed:', e)
    }
  }

  // onRestore — let user transform/validate restored state before UI renders
  if (config.onRestore) {
    try { state = config.onRestore(state) }
    catch (e) { console.error('[aio] hook onRestore:', e) }
  }

  _state = getUIState(state)

  // Debounced localStorage persistence (matches KV debounce pattern)
  const persistMs = config.persistDebounce ?? 100
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  function schedulePersist(): void {
    if (!shouldPersist || persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      try { localStorage.setItem(persistKey, JSON.stringify(getDBState(state))) }
      catch (e) { console.warn('[aio] persist failed:', e) }
    }, persistMs)
  }

  function flushPersist(): void {
    if (!shouldPersist) return
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null }
    try { localStorage.setItem(persistKey, JSON.stringify(getDBState(state))) }
    catch (e) { console.warn('[aio] flush failed:', e) }
  }

  // Shared dispatch loop — same implementation as aio.ts
  const standaloneLog = {
    debug: (_: string) => {},
    warn: (msg: string) => console.warn(`[aio] ${msg}`),
    error: (msg: string) => console.error(`[aio] ${msg}`),
  }

  const dispatch = createDispatch<S, A, E>({
    reduce,
    execute: (effect) => {
      if (isScheduleEffect(effect)) {
        console.warn('[aio] scheduled effects are not supported in standalone mode — ignoring', effect)
        return
      }
      execute(app, effect as E)
    },
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => { _state = getUIState(state); _notify(); schedulePersist() },
    log: standaloneLog, debug: false,
    perfMode: config.perfMode,
    perfBudget: config.perfBudget,
    freezeState: config.freezeState ?? true,  // default: true for standalone
  })

  const app: AioApp<S, A> = {
    dispatch,
    getState: () => state,
    close: () => { dispatch.close(); flushPersist(); return Promise.resolve() },
    mode: 'standalone',
  }

  _app = app as AioApp
  return app
}

// ── React hooks ──

/** Connects to standalone dispatch loop. Same API as browser.ts useAio(). */
export function useAio<S = unknown>(): { state: S | null; send: (action: { type: string; payload?: unknown }) => void } {
  const [state, setState] = useState<S | null>(_state as S | null)

  useEffect(() => {
    const listener: StateListener = (s) => setState(s as S | null)
    _listeners.add(listener)
    if (_state !== null) setState(_state as S | null)
    return () => { _listeners.delete(listener) }
  }, [])

  const send = (action: { type: string; payload?: unknown }) => {
    if (_app) _app.dispatch(action)
    else console.warn('[aio] not initialized — call initStandalone() before rendering')
  }

  return { state, send }
}

/** Client-only state — not synced, not persisted */
export function useLocal<T>(initial: T): { local: T; set: (next: T | ((prev: T) => T)) => void } {
  const [local, setLocal] = useState<T>(initial)
  return { local, set: setLocal }
}

/** Renders the component matching the current page key */
export function page<K extends string>(current: K, routes: Record<K, ComponentType>): ReturnType<typeof createElement> | null {
  const Component = routes[current]
  return Component ? createElement(Component) : null
}

/** Resets module state — for testing only */
export function _reset(): void {
  _state = null
  _app = null
  _listeners.clear()
}
