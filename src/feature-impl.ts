// feature-impl.ts — Implementation shared by feature() and reactive()
//
// This module contains the shared logic for:
// - Method classification (sync/async)
// - Live proxy for async methods
// - Mutation batching
// - Machine auto-generation
// - Inter-feature call() — callback form only (typed, no raw strings)


/** Raw action/effect message — prefer typed action creators (feature.A.xxx) over constructing directly */
export type Msg = { type: string; payload: unknown; _source?: 'UI' | 'Effect' | 'System' | 'Test' }
export type ScheduleEffect = import('./schedule.ts').ScheduleEffect

// Internal method types — `any` at spread args/return is unavoidable when
// mapping over heterogeneous method signatures at the type-system boundary.
// deno-lint-ignore no-explicit-any
export type SyncMethod<S> = (s: S, ...args: any[]) => void | ScheduleEffect | ScheduleEffect[]
// deno-lint-ignore no-explicit-any
export type AsyncMethod<S> = (s: S, ...args: any[]) => Promise<any>
export type Method<S> = SyncMethod<S> | AsyncMethod<S>

export type FeatureMethods<S extends Record<string, unknown>> = Record<string, Method<S>>

// ── Pending async call registry ────────────────────────────────────
// Tracks in-flight async method calls keyed by UUID.
// Used by direct calling (bindFeature) and resolveCall (executor completion).

const _pending = new Map<string, { resolve: (value: unknown) => void; reject: (e: Error) => void }>()

/** Options for call() — timeout in ms, retries on failure */
export type CallOptions = { timeout?: number; retries?: number }

/**
 * Wrap an inter-feature async call with timeout and/or retry.
 * Use direct calling for the simple case — `await feature.method(args)`.
 * Use `call()` when you need timeout or retry semantics.
 *
 * @example
 * // Simple — preferred
 * const reserved = await inventory.reserve(items)
 *
 * // With timeout/retry
 * const reserved = await call({ timeout: 5000, retries: 2 }, () => inventory.reserve(items))
 */
export function call<T>(fn: () => Promise<T>): Promise<T>
export function call<T>(opts: CallOptions, fn: () => Promise<T>): Promise<T>
export function call(
  fnOrOpts: CallOptions | (() => Promise<unknown>),
  fn?: () => Promise<unknown>,
): Promise<unknown> {
  if (typeof fnOrOpts === 'function') return fnOrOpts()
  return _callWithCallback(fn!, fnOrOpts)
}

function _callWithCallback(fn: () => Promise<unknown>, opts: CallOptions): Promise<unknown> {
  const attempt = (): Promise<unknown> => {
    if (!opts.timeout) return fn()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`call(): timeout after ${opts.timeout}ms`)), opts.timeout)
      fn().then((v) => { clearTimeout(timer); resolve(v) }, (e) => { clearTimeout(timer); reject(e) })
    })
  }
  if (!opts.retries) return attempt()
  let remaining = opts.retries
  const retry = (): Promise<unknown> => attempt().catch(e => {
    if (remaining-- > 0) return retry()
    throw e
  })
  return retry()
}

/** Register a pending call — returns Promise that resolves when resolveCall() is called */
export function registerCall(callId: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    _pending.set(callId, { resolve, reject })
  })
}

/** Resolve a pending call() — invoked by executor on async method completion */
export function resolveCall(callId: string | undefined, value?: unknown, error?: Error): void {
  if (!callId) return
  const pending = _pending.get(callId)
  if (!pending) return
  _pending.delete(callId)
  if (error) pending.reject(error)
  else pending.resolve(value)
}

/** Clear all pending async call registrations — for test isolation between runs */
export function resetPending(): void {
  _pending.clear()
}

/** Batched mutation — multiple property writes grouped into one action */
export type Mutation = { path: string[]; value?: unknown; op?: string; args?: unknown[] }

// ── Helpers ────────────────────────────────────────────────────────

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// Symbol marker for minification-safe async detection.
// `.constructor.name` is the primary detection path; `_asyncMark` is a fallback
// for cases where minification strips constructor names (rare in Deno, common in bundled JS).
const _asyncMark = Symbol('aio.async')

/** Explicitly mark a method as async when minification would strip constructor names.
 *  Rarely needed — standard `async function` syntax is auto-detected. */
export function markAsync<T extends (...args: unknown[]) => Promise<unknown>>(fn: T): T {
  (fn as unknown as Record<symbol, boolean>)[_asyncMark] = true
  return fn
}

// deno-lint-ignore ban-types
export function isAsyncFunction(fn: Function): boolean {
  return (fn as unknown as Record<symbol, boolean>)[_asyncMark] === true || fn.constructor.name === 'AsyncFunction'
}

/** Internal set action key for an async method: __setMethodName */
export function setKey(method: string): string {
  return `__set${capitalize(method)}`
}

// ── Mutation helpers ───────────────────────────────────────────────

function getNestedValue(obj: unknown, path: string[]): unknown {
  let current = obj
  for (const key of path) {
    if (current === null || current === undefined) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function setNestedValue(obj: Record<string, unknown>, path: string[], value: unknown): void {
  if (path.length === 0) return
  let current: unknown = obj
  for (let i = 0; i < path.length - 1; i++) {
    current = (current as Record<string, unknown>)[path[i]]
  }
  ;(current as Record<string, unknown>)[path[path.length - 1]] = value
}

function applyArrayOp(obj: Record<string, unknown>, path: string[], op: string, args: unknown[]): void {
  const arr = path.length === 0 ? obj : getNestedValue(obj, path)
  if (!Array.isArray(arr)) return
  // deno-lint-ignore no-explicit-any
  ;(arr as any)[op](...args)
}

export function applyMutations(s: Record<string, unknown>, mutations: Mutation[]): void {
  for (const m of mutations) {
    if (m.op) applyArrayOp(s, m.path, m.op, m.args ?? [])
    else setNestedValue(s, m.path, m.value)
  }
}

// ── Microtask batcher ──────────────────────────────────────────────
//
// Async method mutations are batched and flushed via queueMicrotask.
// This means `s.count++` inside an async method does NOT dispatch immediately —
// it dispatches at the next microtask boundary AFTER the async call resolves.
//
// Implication: concurrent async methods each see the state snapshot from when
// they were called, not the latest state. To read fresh state mid-method,
// call getState()[featureName] directly instead of using the `s` proxy.
//
// This is intentional: all mutations stay observable (dispatched as actions)
// and partial-state visibility during async gaps is prevented.

type BatchState = {
  mutations: Mutation[]
  scheduled: boolean
  method: string
}

export function createBatcher(prefix: string, dispatch: (action: Msg) => void) {
  const batch: BatchState = { mutations: [], scheduled: false, method: '' }

  function add(method: string, mutation: Mutation): void {
    batch.mutations.push(mutation)
    batch.method = method
    if (!batch.scheduled) {
      batch.scheduled = true
      queueMicrotask(flush)
    }
  }

  function flush(): void {
    if (batch.mutations.length === 0) { batch.scheduled = false; return }
    const mutations = batch.mutations
    const method = batch.method
    batch.mutations = []
    batch.scheduled = false
    batch.method = ''
    dispatch({
      type: `${prefix}:${setKey(method)}`,
      payload: { mutations, _origin: method },
    })
  }

  return { add }
}

// ── Live Proxy for async methods ───────────────────────────────────

const ARRAY_MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin'])

export function createLiveProxy<S extends Record<string, unknown>>(
  featureName: string,
  prefix: string,
  methodName: string,
  getState: () => S,
  batcher: ReturnType<typeof createBatcher>,
  path: string[] = [],
): S {
  const handler: ProxyHandler<S> = {
    get(_target, prop, _receiver) {
      if (typeof prop === 'symbol') return undefined
      const key = prop as string
      const fresh = path.length === 0
        ? getState()
        : getNestedValue(getState(), path)
      const value = (fresh as Record<string, unknown>)[key]

      // Array method interception
      if (Array.isArray(fresh) && ARRAY_MUTATORS.has(key) && typeof value === 'function') {
        return (...args: unknown[]) => {
          batcher.add(methodName, { path: [...path], op: key, args })
        }
      }

      // Nested object/array — return nested proxy
      if (value !== null && typeof value === 'object') {
        return createLiveProxy(featureName, prefix, methodName, getState, batcher, [...path, key])
      }

      return value
    },

    set(_target, prop, value) {
      if (typeof prop === 'symbol') return false
      batcher.add(methodName, { path: [...path, prop as string], value })
      return true
    },
  }

  return new Proxy({} as S, handler)
}

// ── Method classification ──────────────────────────────────────────

export function classifyMethods<S extends Record<string, unknown>>(methods: FeatureMethods<S>): {
  syncMethods: Set<string>
  asyncMethods: Set<string>
} {
  const syncMethods = new Set<string>()
  const asyncMethods = new Set<string>()
  for (const key of Object.keys(methods)) {
    if (isAsyncFunction(methods[key])) asyncMethods.add(key)
    else syncMethods.add(key)
  }
  return { syncMethods, asyncMethods }
}

