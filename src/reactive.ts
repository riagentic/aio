// reactive.ts — v0.7 reactive features
//
// reactive()  — define a feature with plain methods instead of reduce/execute
// Sync methods mutate state inside Immer draft (batched, one action per call).
// Async methods get a live Proxy — reads are always fresh, writes auto-dispatch.
// Microtask batching groups consecutive sync-frame writes into one action.
// Machine guards apply to async writes via method-tagged __set actions.
// Compiles to a standard FeatureInternals — same dispatch loop, persistence, sync, time-travel.

import type { ScheduleEffect } from './schedule.ts'
import { validateMachine } from './feature.ts'

// ── Types ──────────────────────────────────────────────────────────

type Msg = { type: string; payload: unknown; _source?: 'UI' | 'Effect' | 'System' | 'Test' }

// deno-lint-ignore no-explicit-any
type SyncMethod<S> = (s: S, ...args: any[]) => void | ScheduleEffect | ScheduleEffect[]

// deno-lint-ignore no-explicit-any
type AsyncMethod<S> = (s: S, ...args: any[]) => Promise<void>

type Method<S> = SyncMethod<S> | AsyncMethod<S>

/** Batched mutation — multiple property writes grouped into one action */
type Mutation = { path: string[]; value?: unknown; op?: string; args?: unknown[] }

/** Configuration for reactive() */
export type ReactiveConfig<S extends Record<string, unknown>> = {
  state: S
  methods: Record<string, Method<S>>
  selectors?: Record<string, (s: S) => unknown>
  machine?: import('./feature.ts').MachineConfig | 'simple' | false
  /** Listen to foreign actions without a full machine — auto-generates self-loop transitions */
  listensTo?: string[]
  crossDispatch?: string[]
  init?: (app: ScopedApp) => void
  destroy?: (app: ScopedApp) => void
}

type FeatureInternals = import('./feature.ts').FeatureInternals
// Re-export with generics — Creators constraint satisfied via any defaults on the source type
// deno-lint-ignore no-explicit-any
type Creators = Record<string, (...args: any[]) => any>
// deno-lint-ignore no-explicit-any
type FeatureDef<N extends string = string, A extends Creators = any, E extends Creators = any, S extends Record<string, unknown> = Record<string, unknown>> = import('./feature.ts').FeatureDef<N, A, E, S>
type ScopedApp = import('./feature.ts').ScopedApp

/** Strip the first parameter (state `s`) from a method's parameter list */
// deno-lint-ignore no-explicit-any
type DropFirst<T extends any[]> = T extends [any, ...infer R] ? R : []

/** Typed method senders — callable directly on the feature after binding */
type FlatMethods<M> = {
  // deno-lint-ignore no-explicit-any
  [K in keyof M & string]: M[K] extends (...args: any[]) => any
    ? (...args: DropFirst<Parameters<M[K]>>) => void
    : never
}

/** Typed bound selectors — callable with no args after binding */
type FlatSelectors<Sel> = {
  // deno-lint-ignore no-explicit-any
  [K in keyof Sel & string]: Sel[K] extends (s: any) => infer R
    ? () => R
    : never
}

// ── Helpers ────────────────────────────────────────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// deno-lint-ignore ban-types
function isAsyncFunction(fn: Function): boolean {
  return fn.constructor.name === 'AsyncFunction'
}

/** Internal set action key for an async method: __setMethodName (no colon — avoids foreign action detection) */
function setKey(method: string): string {
  return `__set${capitalize(method)}`
}

function buildCatalog(
  prefix: string,
  // deno-lint-ignore no-explicit-any
  creators: Record<string, (...args: any[]) => Record<string, unknown>>,
): { catalog: Record<string, unknown>; typeToKey: Map<string, string> } {
  const catalog: Record<string, unknown> = {}
  const typeToKey = new Map<string, string>()
  for (const key of Object.keys(creators)) {
    const label = `${prefix}:${capitalize(key)}`
    catalog[capitalize(key)] = label
    catalog[key] = (...args: unknown[]) => ({
      type: label,
      payload: creators[key](...args) ?? {},
    })
    typeToKey.set(label, key)
  }
  return { catalog, typeToKey }
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

function applyMutations(s: Record<string, unknown>, mutations: Mutation[]): void {
  for (const m of mutations) {
    if (m.op) applyArrayOp(s, m.path, m.op, m.args ?? [])
    else setNestedValue(s, m.path, m.value)
  }
}

// ── Microtask batcher ──────────────────────────────────────────────
// Collects Proxy writes within one sync frame, flushes as single action via queueMicrotask

type BatchState = {
  mutations: Mutation[]
  scheduled: boolean
  method: string
}

function createBatcher(prefix: string, dispatch: (action: Msg) => void) {
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
      type: `${prefix}:${capitalize(setKey(method))}`,
      payload: { mutations, _origin: method },
    })
  }

  return { add }
}

// ── Live Proxy for async methods ───────────────────────────────────

const ARRAY_MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin'])

function createLiveProxy<S extends Record<string, unknown>>(
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

// ── reactive() ─────────────────────────────────────────────────────

export function reactive<
  N extends string,
  S extends Record<string, unknown>,
  M extends Record<string, Method<S>> = Record<string, Method<S>>,
  // deno-lint-ignore ban-types
  Sel extends Record<string, (s: S) => unknown> = {},
>(name: N, config: Omit<ReactiveConfig<S>, 'methods' | 'selectors'> & {
  methods: M
  selectors?: Sel & Record<string, (s: S) => unknown>
// deno-lint-ignore no-explicit-any
}): FeatureDef<N, any, any, S> & FlatMethods<M> & FlatSelectors<Sel> {
  const prefix = capitalize(name)
  const methods = config.methods
  const methodNames = Object.keys(methods)

  // Classify methods
  const syncMethods = new Set<string>()
  const asyncMethods = new Set<string>()
  for (const key of methodNames) {
    if (isAsyncFunction(methods[key])) asyncMethods.add(key)
    else syncMethods.add(key)
  }

  // ── Action creators ──
  // deno-lint-ignore no-explicit-any
  const actionCreators: Record<string, (...args: any[]) => Record<string, unknown>> = {}
  for (const key of methodNames) {
    actionCreators[key] = (...args: unknown[]) => ({ args })
  }
  // Method-tagged set actions: __setMethodName (no colon — safe for feature.ts routing)
  for (const key of asyncMethods) {
    actionCreators[setKey(key)] = (mutations: Mutation[], _origin: string) => ({ mutations, _origin })
  }
  // Error action for async method failures (visible in time-travel, middleware, foreign listeners)
  if (asyncMethods.size > 0) {
    actionCreators['__error'] = (_method: string, error: string) => ({ _method, error })
  }

  const { catalog: _aCatalog, typeToKey: actionTypeToKey } = buildCatalog(prefix, actionCreators)
  const eCatalog: Record<string, unknown> = {}

  // ── Machine / foreign actions ──
  let machine: import('./feature.ts').MachineConfig | 'simple' =
    (config.machine === false ? 'simple' : config.machine) ?? 'simple'

  // listensTo: auto-generate minimal machine with self-loop transitions for foreign actions
  if (config.listensTo?.length && machine === 'simple') {
    const on: Record<string, string> = {}
    for (const key of methodNames) on[key] = 'active'
    for (const key of asyncMethods) on[setKey(key)] = 'active'
    if (asyncMethods.size > 0) on['__error'] = 'active'
    for (const actionType of config.listensTo) on[actionType] = 'active'
    machine = { initial: 'active', states: { active: { on } } }
  }

  const foreignSet = new Set<string>()
  if (machine !== 'simple') {
    // Auto-inject __setMethod self-loop transitions in TARGET states
    // If 'load' transitions idle→loading, then __setLoad is a self-loop in 'loading'
    // (async writes happen AFTER the method triggers its transition)
    for (const stateConfig of Object.values(machine.states)) {
      for (const [key, target] of Object.entries(stateConfig.on)) {
        if (!key.includes(':') && asyncMethods.has(key) && machine.states[target]) {
          machine.states[target].on[setKey(key)] = target // self-loop in target
        }
      }
    }

    for (const sc of Object.values(machine.states)) {
      for (const key of Object.keys(sc.on)) {
        if (key.includes(':') && !key.startsWith(prefix + ':')) {
          foreignSet.add(key)
        }
      }
    }
    // Auto-inject __error self-loop in all states (async errors can happen in any state)
    if (asyncMethods.size > 0) {
      for (const [stateName, stateConfig] of Object.entries(machine.states)) {
        stateConfig.on['__error'] = stateName
      }
    }

    const actionKeySet = new Set(methodNames)
    for (const key of asyncMethods) actionKeySet.add(setKey(key))
    if (asyncMethods.size > 0) actionKeySet.add('__error')
    validateMachine(name, machine, actionKeySet)
  }

  // ── Reducer ──
  const reduce = (
    state: unknown,
    action: Msg,
    _ctx: { A: unknown; E: unknown },
  ): (Msg | ScheduleEffect)[] | void => {
    const s = state as S
    const ownKey = actionTypeToKey.get(action.type)
    if (!ownKey) return

    // Handle batched mutations from live Proxy
    if (ownKey.startsWith('__set')) {
      const payload = action.payload as { mutations: Mutation[] }
      applyMutations(s as Record<string, unknown>, payload.mutations)
      return
    }

    // Error action — no state change, exists for visibility (time-travel, middleware, onError)
    if (ownKey === '__error') return

    const method = methods[ownKey]
    if (!method) return

    if (syncMethods.has(ownKey)) {
      const { args } = action.payload as { args: unknown[] }
      const result = (method as SyncMethod<S>)(s, ...args)
      // Sync methods can return schedule effects
      if (result) {
        return Array.isArray(result) ? result : [result]
      }
      return
    }

    if (asyncMethods.has(ownKey)) {
      return [{
        type: `${prefix}:__exec`,
        payload: { _method: ownKey, _args: (action.payload as { args: unknown[] }).args },
      }]
    }
  }

  // ── Executor ──
  const execute = (
    app: ScopedApp,
    effect: Msg,
    _ctx: { E: unknown; A: unknown },
  ): void => {
    if (effect.type !== `${prefix}:__exec`) return

    const { _method, _args } = effect.payload as { _method: string; _args: unknown[] }
    const method = methods[_method]
    if (!method || !asyncMethods.has(_method)) return

    const batcher = createBatcher(prefix, (a) => app.dispatch(a))
    const proxy = createLiveProxy<S>(name, prefix, _method, () => app.getState() as S, batcher)

    ;(method as AsyncMethod<S>)(proxy, ..._args)
      .catch(e => {
        console.error(`[${name}] ${_method}() threw: ${e}`)
        app.dispatch({
          type: `${prefix}:__error`,
          payload: { _method, error: String(e) },
          _source: 'Effect',
        } as Msg)
      })
  }

  // ── Assemble ──
  const allActionKeys = [...methodNames]
  for (const key of asyncMethods) allActionKeys.push(setKey(key))
  if (asyncMethods.size > 0) allActionKeys.push('__error')

  const internals: FeatureInternals = {
    state: config.state as Record<string, unknown>,
    machine,
    reduce,
    execute,
    actionKeys: allActionKeys,
    effectKeys: [],
    prefix,
    actionTypeToKey,
    foreignActions: [...foreignSet],
    initType: `${prefix}:Init`,
    destroyType: `${prefix}:Destroy`,
    crossDispatchPrefixes: new Set((config.crossDispatch ?? []).map(capitalize)),
    onInit: config.init
      ? ((app: ScopedApp) => config.init!(app))
      : undefined,
    onDestroy: config.destroy
      ? ((app: ScopedApp) => config.destroy!(app))
      : undefined,
  }

  // ── Selectors ──
  const selectors: Record<string, (state: unknown) => unknown> = {}
  if (config.selectors) {
    for (const [key, fn] of Object.entries(config.selectors)) {
      selectors[key] = (fullState: unknown) =>
        fn((fullState as Record<string, unknown>)[name] as S)
    }
  }

  // ── Public catalog ──
  const publicCatalog: Record<string, unknown> = {}
  for (const key of methodNames) {
    const label = `${prefix}:${capitalize(key)}`
    publicCatalog[capitalize(key)] = label
    publicCatalog[key] = (...args: unknown[]) => ({
      type: label,
      payload: { args },
    })
  }

  // Validate selector names don't collide with method names or reserved keys
  const RESERVED = new Set(['name', 'A', 'E', 'selectors', '_config', 'implement', 'request', '_bound'])
  const selectorKeys = new Set(Object.keys(config.selectors ?? {}))
  for (const key of selectorKeys) {
    if (RESERVED.has(key))
      throw new Error(`[${name}] selector '${key}' collides with reserved property`)
    if (publicCatalog[key] !== undefined)
      throw new Error(`[${name}] selector '${key}' collides with method of same name`)
  }

  const def: Record<string, unknown> = {
    name,
    A: publicCatalog,
    E: eCatalog,
    selectors,
    _config: internals,
    implement(fn: FeatureInternals['execute']) { internals.execute = fn },
  }

  // Flatten action creators + string constants directly onto the feature def
  for (const [key, value] of Object.entries(publicCatalog)) {
    if (RESERVED.has(key)) continue
    if (selectorKeys.has(key))
      throw new Error(`[${name}] method '${key}' collides with selector of same name`)
    // Wrap function entries with pre-bind dev warning
    if (typeof value === 'function') {
      const original = value as (...args: unknown[]) => unknown
      def[key] = (...args: unknown[]) => {
        if (!def._bound) console.warn(`[${name}] ${key}() called before aio.run() — returns action object, not dispatching`)
        return original(...args)
      }
    } else {
      def[key] = value
    }
  }

  // deno-lint-ignore no-explicit-any
  return def as unknown as FeatureDef<N, any, any, S> & FlatMethods<M> & FlatSelectors<Sel>
}

// Machine validation — uses shared validateMachine from feature.ts
// (includes reachability and dead-end checks)
