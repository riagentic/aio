// feature.ts — v0.5+ unified feature API
//
// feature()          — define a feature with methods OR actions/reduce (unified API)
// composeFeatures()  — compose features into {initialState, reduce, execute} for aio.run()
// testFeature()      — test harness for isolated feature testing

import { produce, type Draft } from 'immer'
import type { ScheduleEffect } from './schedule.ts'
import type { FlowDef, GenCtx, Gen } from './flow.ts'
import { createFlowReducer, cancelFeatureFlows, runFlow, notifyFlowListeners, resetFlows } from './flow.ts'
import {
  capitalize as capitalizeImpl,
  setKey,
  classifyMethods,
  createBatcher,
  createLiveProxy,
  applyMutations,
  resolveCall,
  registerCall,
  resetPending,
} from './feature-impl.ts'
import type { Mutation, FeatureMethods, SyncMethod, AsyncMethod, Method } from './feature-impl.ts'

// ── Helpers ────────────────────────────────────────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ── Types ──────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
type Creators = Record<string, (...args: any[]) => Record<string, unknown>>

/** Catalog type: string labels + camelCase action/effect creators.
 *  Labels are `featureName:actionKey` (all lowercase/camelCase).
 *  Creators have a `.type` property for use with typed `waitFor` and `cancelOn`. */
/** Typed action catalog — maps method names to prefixed type strings and creator functions */
export type Catalog<Prefix extends string, T extends Creators> = {
  readonly [K in keyof T & string]: `${Prefix}:${K}`
} & {
  readonly [K in keyof T & string]: {
    (...args: Parameters<T[K]>): { type: `${Prefix}:${K}`; payload: ReturnType<T[K]> }
    readonly type: `${Prefix}:${K}`
  }
}

/** Discriminated union of all actions — enables auto-narrowing in reduce switch/case.
 *  Foreign/internal actions (init, destroy, cross-feature): cast to Msg for raw access. */
export type ActionUnion<Prefix extends string, A extends Creators> =
  { [K in keyof A & string]: { type: `${Prefix}:${K}`; payload: ReturnType<A[K]>; _source?: ActionSource } }[keyof A & string]

/** State machine definition */
export type MachineConfig = {
  initial: string
  states: Record<string, Record<string, string>>
}

/** Action source — auto-tagged at dispatch time for logging/debugging */
export type ActionSource = 'UI' | 'Effect' | 'System' | 'Test'

type Msg<P = unknown> = { type: string; payload: P; _source?: ActionSource }

/** Scoped app handle passed to execute() — dispatch actions or read state from within a feature */
export type ScopedApp<S = unknown> = {
  dispatch: (action: Msg) => void
  /** Returns this feature's own state slice */
  getState: () => S
  /** Returns the full app state — use when init() needs to read another feature's state.
   *  Always available when called from init/destroy/execute in a running app. */
  getFullState?: () => Record<string, unknown>
}

/** Tag a message with a source — non-destructive, returns new object */
export function tagSource<P = unknown>(msg: Msg<P>, source: ActionSource): Msg<P> {
  return { ...msg, _source: source }
}

// Internal function signatures stored in FeatureDef
// deno-lint-ignore no-explicit-any
type FeatureReduceFn = (state: unknown, action: Msg, ctx?: any) => (Msg | ScheduleEffect)[] | void
// deno-lint-ignore no-explicit-any
type FeatureExecuteFn = (app: ScopedApp, effect: Msg, ctx?: any) => void

/** Internal config stored in feature definition */
export type FeatureInternals = {
  state: Record<string, unknown>
  machine: MachineConfig | false
  reduce: FeatureReduceFn
  execute?: FeatureExecuteFn
  actionKeys: string[]
  effectKeys: string[]
  prefix: string
  /** Reverse map: full action type string → camelCase key */
  actionTypeToKey: Map<string, string>
  /** Foreign action types declared in machine (keys containing ':' from other prefixes) */
  foreignActions: string[]
  /** Init type string (e.g. 'Counter:Init') — auto-generated lifecycle */
  initType: string
  /** Destroy type string (e.g. 'Counter:Destroy') — auto-generated lifecycle */
  destroyType: string
  /** Prefixes this executor is allowed to cross-dispatch to */
  crossDispatchPrefixes: Set<string>
  /** Custom init handler (optional override) */
  onInit?: (app: ScopedApp<unknown>) => void
  /** Custom destroy handler (optional override) */
  onDestroy?: (app: ScopedApp<unknown>) => void
  /** Generator-based flows (optional) */
  flows?: Record<string, FlowDef>
  /** Map: trigger action key → flow name */
  flowTriggers?: Map<string, string>
  /** Method-based mode (v0.8): sync/async methods instead of actions+reduce */
  methods?: FeatureMethods<Record<string, unknown>>
  syncMethods?: Set<string>
  asyncMethods?: Set<string>
  /** State keys to exclude from KV persistence for this feature */
  persistExclude?: string[]
}

/** Reserved property names on FeatureDef — action/selector names must not collide */
const RESERVED_KEYS = new Set(['name', 'A', 'E', 'selectors', '_config', 'implement', 'request', '_bound', '_stateType'])

/** Feature definition returned by feature() */
export type FeatureDef<
  Name extends string = string,
  // deno-lint-ignore no-explicit-any
  Actions extends Creators = any,
  // deno-lint-ignore no-explicit-any
  Effects extends Creators = any,
  State extends Record<string, unknown> = Record<string, unknown>,
> = {
  readonly name: Name
  readonly A: Catalog<Name, Actions>
  readonly E: Catalog<Name, Effects>
  readonly selectors: Record<string, (state: unknown) => unknown>
  readonly _config: FeatureInternals
  /** Attach execute separately — for features with server-only imports */
  readonly implement: (fn: FeatureExecuteFn) => void
  /** Bridge-only: request effect creators per channel */
  readonly request?: Record<string, (...args: unknown[]) => Msg>
  /** Phantom type — carries state shape for testFeature inference (never set at runtime) */
  readonly _stateType?: State
}

/** Flattened action senders — method names callable directly on the feature.
 *  Each has a `.type` property for use in waitFor/cancelOn/listensTo without raw strings. */
type FlatActions<A extends Creators> = {
  [K in keyof A & string]: ((...args: Parameters<A[K]>) => void) & { readonly type: string }
}

/** Direct calling type — maps method signatures to dispatch functions.
 *  Async methods return Promise<R>, sync methods return void.
 *  Each has a `.type` property (e.g. `counter.increment.type === 'Counter:Increment'`). */
// deno-lint-ignore no-explicit-any
export type DirectCalling<M> = {
  // deno-lint-ignore no-explicit-any
  [K in keyof M]: M[K] extends (s: any, ...args: infer P) => Promise<infer R>
    ? ((...args: P) => Promise<R>) & { readonly type: string }
    // deno-lint-ignore no-explicit-any
    : M[K] extends (s: any, ...args: infer P) => any
    ? ((...args: P) => void) & { readonly type: string }
    : never
}

/** Feature entry in aio.run() features array */
// deno-lint-ignore no-explicit-any
export type FeatureEntry = FeatureDef<any, any, any, any> | { feature: FeatureDef<any, any, any, any>; dependsOn?: string[] }

// ── Catalog builder ────────────────────────────────────────────────

function buildCatalog(
  prefix: string,
  creators: Creators,
): { catalog: Record<string, unknown>; typeToKey: Map<string, string> } {
  const catalog: Record<string, unknown> = {}
  const typeToKey = new Map<string, string>()

  for (const key of Object.keys(creators)) {
    const label = `${prefix}:${key}`
    const fn = Object.assign(                          // A.increment(5) = { type, payload }
      (...args: unknown[]) => ({ type: label, payload: creators[key](...args) ?? {} }),
      { type: label },                                 // A.increment.type = 'counter:increment'
    )
    catalog[key] = fn
    typeToKey.set(label, key)
  }

  return { catalog, typeToKey }
}

/** Flatten action creators + string constants from catalog directly onto a feature def object.
 *  Skips reserved keys silently (e.g. action 'a' → PascalCase 'A' collides with catalog).
 *  Throws if a camelCase action name collides with a selector. */
function flattenOnto(
  target: Record<string, unknown>,
  catalog: Record<string, unknown>,
  selectorKeys: Set<string>,
  featureName: string,
): void {
  for (const [key, value] of Object.entries(catalog)) {
    if (RESERVED_KEYS.has(key)) continue // skip PascalCase collisions (e.g. 'A')
    if (selectorKeys.has(key))
      throw new Error(`[${featureName}] action '${key}' collides with selector of same name`)
    // Wrap function entries with pre-bind dev warning; preserve .type for use in waitFor/cancelOn/listensTo
    if (typeof value === 'function') {
      const original = value as ((...args: unknown[]) => unknown) & { type?: string }
      const stub = (...args: unknown[]) => {
        if (!target._bound) console.warn(`[${featureName}] ${key}() called before aio.run() — returns action object, not dispatching`)
        return original(...args)
      }
      if (original.type) (stub as unknown as Record<string, unknown>).type = original.type
      target[key] = stub
    } else {
      target[key] = value
    }
  }
}

/** Bind a feature to a live app — replaces action creators with dispatch wrappers,
 *  selectors with bound state readers. Called by aio.run() after compose.
 *  Async methods return a Promise that resolves with the method's return value. */
export function bindFeature(
  f: FeatureDef,
  dispatch: (action: Msg) => void,
  getState: () => Record<string, unknown>,
): void {
  if ((f as Record<string, unknown>)._bound) throw new Error(`[${f.name}] already bound — features can only bind to one app`)

  // Bind action creators: wrap with dispatch
  for (const key of f._config.actionKeys) {
    const creator = (f.A as Record<string, unknown>)[key]
    if (typeof creator !== 'function') continue

    const isAsync = f._config.asyncMethods?.has(key)
    if (isAsync) {
      // Async methods: dispatch with _callId, return Promise that resolves with the method's return value
      const fn = (...args: unknown[]) => {
        const callId = crypto.randomUUID()
        const promise = registerCall(callId)
        const action = (creator as (...a: unknown[]) => Msg)(...args)
        dispatch({ ...action, payload: { args, _callId: callId }, _source: 'Effect' as const })
        return promise
      }
      ;(fn as unknown as Record<string, unknown>).type = (creator as unknown as { type: string }).type
      ;(f as Record<string, unknown>)[key] = fn
    } else {
      // Sync methods: dispatch and return void
      const fn = (...args: unknown[]) => {
        dispatch((creator as (...a: unknown[]) => Msg)(...args))
      }
      ;(fn as unknown as Record<string, unknown>).type = (creator as unknown as { type: string }).type
      ;(f as Record<string, unknown>)[key] = fn
    }
  }

  // Bind selectors: wrap with getState
  for (const [key, selectorFn] of Object.entries(f.selectors)) {
    ;(f as Record<string, unknown>)[key] = () => selectorFn(getState())
  }

  ;(f as Record<string, unknown>)._bound = true
}

// ── Machine validation ─────────────────────────────────────────────

export function validateMachine(
  name: string,
  machine: MachineConfig,
  actionKeys: Set<string>,
): void {
  const errors: string[] = []
  const stateNames = new Set(Object.keys(machine.states))

  // Initial state must exist
  if (!stateNames.has(machine.initial)) {
    errors.push(`machine.initial '${machine.initial}' not in declared states`)
  }

  // Validate transitions + dead-end detection in one pass
  const warnings: string[] = []
  for (const [stateName, stateConfig] of Object.entries(machine.states)) {
    const transitions = stateConfig
    if (Object.keys(transitions).length === 0) {
      warnings.push(`state '${stateName}' is a dead-end (no outgoing transitions)`)
    }
    for (const [key, target] of Object.entries(transitions)) {
      if (!stateNames.has(target)) {
        errors.push(`state '${stateName}' → unknown target '${target}' on '${key}'`)
      }
      if (!key.includes(':') && !actionKeys.has(key)) {
        errors.push(`state '${stateName}' references unknown action '${key}'`)
      }
    }
  }

  // Reachability: BFS from initial, then flag unreachable states
  const reachable = new Set<string>([machine.initial])
  let changed = true
  while (changed) {
    changed = false
    for (const [sn, sc] of Object.entries(machine.states)) {
      if (!reachable.has(sn)) continue
      for (const t of Object.values(sc)) {
        if (!reachable.has(t)) { reachable.add(t); changed = true }
      }
    }
  }
  for (const sn of stateNames) {
    if (!reachable.has(sn)) errors.push(`state '${sn}' unreachable from '${machine.initial}'`)
  }

  if (errors.length) {
    throw new Error(`[feature:${name}] machine validation failed:\n  ${errors.join('\n  ')}`)
  }
  if (warnings.length) {
    for (const w of warnings) console.warn(`[feature:${name}] ${w}`)
  }
}

// ── feature() ──────────────────────────────────────────────────────

/** Define a feature — unified API supporting methods OR actions/reduce styles.
 *
 * Style 1 (methods): Simple reactive-style mutations
 *   feature('counter', {
 *     state: { count: 0 },
 *     methods: {
 *       increment(s, by = 1) { s.count += by },
 *       async save(s) { await api.save(s.count) },
 *     },
 *   })
 *
 * Style 2 (actions + reduce): Full control over actions and effects
 *   feature('counter', {
 *     state: { count: 0 },
 *     actions: { increment: (by) => ({ by }) },
 *     reduce(state, action, { A }) { ... },
 *   })
 *
 * Both styles can be mixed in the same feature:
 *   - Use `methods` for simple sync/async operations
 *   - Use `actions` + `reduce` for fine-grained control
 *   - Use `flows` for sequential async workflows
 */

/** Generator function — pass through cancel() to attach cancelOn triggers.
 *  Uses `any` for rest args so typed signatures (e.g. `{ n: number }`) are assignable. */
// deno-lint-ignore no-explicit-any
type GeneratorEntry = ((ctx: GenCtx<any>, ...args: any[]) => Gen<unknown>) & { cancelOn?: string[] }

/** Methods-based config (reactive style) */
type MethodsFeatureConfig<
  N extends string,
  S extends Record<string, unknown>,
  M extends Record<string, Method<S>> = Record<string, Method<S>>,
> = {
  state: S
  methods: M
  /** Generator functions — sequential async workflows, auto-triggered by dispatching their action. */
  // deno-lint-ignore no-explicit-any
  generators?: Record<string, (ctx: GenCtx<S>, ...args: any[]) => Gen<unknown>>
  /** Cancellation triggers per generator — { generatorKey: [actionsOrTypes] }.
   *  Accepts bound action creators (.type) or plain strings. */
  cancelOn?: Record<string, (string | { type: string })[]>
  selectors?: Record<string, (s: S) => unknown>
  machine?: MachineConfig | false
  /** Listen to foreign actions — auto-generates machine transitions.
   *  Accept strings or bound methods/actions with .type (e.g. `inventory.reserve.type`). */
  listensTo?: (string | { type: string })[]
  effects?: Record<string, (...args: unknown[]) => Record<string, unknown>>
  /** Object form (default): named handlers per effect key.
   *  Function form (advanced): receives full effect + { emit } map of type strings. */
  execute?: ExecuteHandlers<S, Record<string, never>> | ((app: ScopedApp<S>, effect: Msg, ctx: { emit: Record<string, unknown> }) => void)
  /** Features this feature's execute() is allowed to dispatch to.
   *  Acts as an explicit dependency declaration — prevents accidental
   *  cross-feature dispatch and makes dependencies visible at a glance.
   *  @example dispatchTo: [wallet, notifications] */
  dispatchTo?: (string | { name: string })[]
  /** State keys to exclude from KV persistence — e.g. { exclude: ['htmlCache', 'largeBlob'] } */
  persist?: { exclude?: string[] }
  onInit?: (app: ScopedApp<S>) => void
  onDestroy?: (app: ScopedApp<S>) => void
}

/** Object-form reduce handlers — each key matches an action key, receives typed payload.
 *  Own-feature keys infer payload from action creator; foreign/computed keys get any (no cast needed). */
// deno-lint-ignore no-explicit-any
type ReduceHandlers<S, A extends Creators> = Partial<{
  [K in keyof A]: (state: Draft<S>, payload: ReturnType<A[K]>) => void
// deno-lint-ignore no-explicit-any
}> & Record<string, (state: Draft<S>, payload: any) => void>

/** Object-form execute handlers — each key matches an effect key, receives typed payload. */
// deno-lint-ignore no-explicit-any
type ExecuteHandlers<S, E extends Creators> = Partial<{
  [K in keyof E]: (app: ScopedApp<S>, payload: ReturnType<E[K]>) => void | Promise<void>
// deno-lint-ignore no-explicit-any
}> & Record<string, (app: ScopedApp<S>, payload: any) => void | Promise<void>>

/** Actions-based config (explicit style) */
type ActionsFeatureConfig<
  N extends string,
  S extends Record<string, unknown>,
  A extends Creators,
  E extends Creators,
> = {
  state: S
  actions: A
  effects?: E
  machine?: MachineConfig | false
  /** Object form (default): named handlers per action key — receives typed payload.
   *  Function form (advanced escape hatch): receives full action + { on } map of type strings. */
  reduce?: ReduceHandlers<S, A> | ((
    state: Draft<S>,
    action: ActionUnion<N, A>,
    ctx: { on: Record<string, string> }
  ) => (Msg | ScheduleEffect)[] | void)
  /** Object form (default): named handlers per effect key — receives typed payload.
   *  Function form (advanced escape hatch): receives full effect + { emit } map of type strings. */
  execute?: ExecuteHandlers<S, E> | ((
    app: ScopedApp<S>,
    effect: Msg,
    ctx: { emit: Record<string, string> }
  ) => void)
  selectors?: Record<string, (s: S) => unknown>
  /** Generator functions keyed by their trigger action — action key must be in `actions`. */
  // deno-lint-ignore no-explicit-any
  generators?: Record<string, (ctx: GenCtx<S>, ...args: any[]) => Gen<unknown>>
  /** Cancellation triggers per generator — { generatorKey: [actionsOrTypes] }.
   *  Accepts bound action creators (.type) or plain strings. */
  cancelOn?: Record<string, (string | { type: string })[]>
  /** Features this feature's execute() is allowed to dispatch to.
   *  Acts as an explicit dependency declaration — prevents accidental
   *  cross-feature dispatch and makes dependencies visible at a glance.
   *  @example dispatchTo: [wallet, notifications] */
  dispatchTo?: (string | { name: string })[]
  /** State keys to exclude from KV persistence — e.g. { exclude: ['htmlCache', 'largeBlob'] } */
  persist?: { exclude?: string[] }
  onInit?: (app: ScopedApp<S>) => void
  onDestroy?: (app: ScopedApp<S>) => void
}

/**
 * Define a feature — the primary building block of an aio app.
 *
 * Three styles:
 * - `{ methods }` — reactive (default): Immer proxy mutation, direct typed calling
 * - `{ generators }` — sequential workflows: yield-based async steps, cancelable
 * - `{ actions, reduce }` — explicit: full control over action/effect pipeline
 *
 * @example
 * ```ts
 * const counter = feature('counter', {
 *   state: { count: 0 },
 *   methods: {
 *     increment(s, by = 1) { s.count += by },
 *   },
 * })
 * counter.increment(5) // typed direct call
 * ```
 */
// Overloads for TypeScript inference
export function feature<
  N extends string,
  S extends Record<string, unknown>,
  M extends Record<string, Method<S>>,
>(
  name: N,
  config: MethodsFeatureConfig<N, S, M>
// deno-lint-ignore no-explicit-any
): FeatureDef<N, any, any, S> & DirectCalling<M>
export function feature<
  N extends string,
  S extends Record<string, unknown>,
  A extends Creators,
  E extends Creators = Record<string, never>,
>(
  name: N,
  config: ActionsFeatureConfig<N, S, A, E>
): FeatureDef<N, A, E, S> & FlatActions<A>
// deno-lint-ignore no-explicit-any
export function feature(name: string, config: any): any {
  const hasMethods = config.methods && Object.keys(config.methods as Record<string, unknown>).length > 0
  const hasGenerators = config.generators && Object.keys(config.generators as Record<string, unknown>).length > 0
  const hasActions = config.actions && Object.keys(config.actions as Record<string, () => unknown>).length > 0

  if (hasMethods && hasActions) {
    throw new Error(`[${name}] feature cannot have both 'methods' and 'actions' — use one or the other`)
  }

  // methods style: methods (+ optional generators) — auto-creates actions from method/generator names
  // actions style: actions (+ optional generators) — generator key must match an action key
  if (hasMethods || (hasGenerators && !hasActions)) {
    return createFeatureFromMethods(name, config as MethodsFeatureConfig<string, Record<string, unknown>>)
  }

  return createFeatureFromActions(name, config as ActionsFeatureConfig<string, Record<string, unknown>, Creators, Creators>)
}

// ── Methods-based feature (reactive style) ───────────────────────────

// deno-lint-ignore no-explicit-any
function createFeatureFromMethods<N extends string, S extends Record<string, unknown>, M extends Record<string, Method<S>> = Record<string, Method<S>>>(
  name: N,
  config: MethodsFeatureConfig<N, S, M>
// deno-lint-ignore no-explicit-any
): FeatureDef<N, Record<string, never>, Record<string, never>, S> & DirectCalling<M> {
  const prefix = name
  const methods = config.methods as Record<string, Method<S>>
  const methodNames = Object.keys(methods)
  const rawGenerators = (config.generators ?? {}) as Record<string, GeneratorEntry>
  const generatorNames = Object.keys(rawGenerators)

  // Classify methods as sync or async (uses isAsyncFunction — symbol-based, minification-safe)
  const { syncMethods, asyncMethods } = classifyMethods(methods as FeatureMethods<Record<string, unknown>>)

  // Build action creators from methods + generators
  // deno-lint-ignore no-explicit-any
  const actionCreators: Record<string, (...args: any[]) => Record<string, unknown>> = {}
  for (const key of methodNames) {
    actionCreators[key] = (...args: unknown[]) => ({ args })
  }
  // Generator actions — same payload shape as methods (args array)
  for (const key of generatorNames) {
    actionCreators[key] = (...args: unknown[]) => ({ args })
  }
  // Add __setMethod actions for async mutations
  for (const key of asyncMethods) {
    actionCreators[setKey(key)] = (mutations: Mutation[], _origin: string) => ({ mutations, _origin })
  }
  // Add __error action for async failures
  if (asyncMethods.size > 0) {
    actionCreators['__error'] = (_method: string, error: string) => ({ _method, error })
  }

  const { catalog: aCatalog, typeToKey: actionTypeToKey } = buildCatalog(prefix, actionCreators)

  // Build effect creators
  // deno-lint-ignore no-explicit-any
  const effectCreators: Record<string, (...args: any[]) => Record<string, unknown>> = {}
  const effectKeys = Object.keys(config.effects ?? {})
  for (const key of effectKeys) {
    effectCreators[key] = (config.effects as Record<string, (...args: unknown[]) => Record<string, unknown>>)[key]
  }
  const { catalog: eCatalog } = buildCatalog(prefix, effectCreators)

  // Build machine
  let machine: MachineConfig | false
  if (!config.machine) {
    machine = false
  } else {
    machine = config.machine as MachineConfig
  }

  // Auto-generate machine from listensTo
  if (config.listensTo?.length && machine === false) {
    const on: Record<string, string> = {}
    for (const key of methodNames) on[key] = 'active'
    for (const key of asyncMethods) on[setKey(key)] = 'active'
    if (asyncMethods.size > 0) on['__error'] = 'active'
    for (const entry of config.listensTo) {
      const actionType = typeof entry === 'string' ? entry : entry.type
      on[actionType] = 'active'
    }
    machine = { initial: 'active', states: { active: on } }
  }

  // Inject __setMethod and __error transitions for async methods.
  // Clone first — never mutate the user-provided config object.
  if (machine !== false) {
    const cloned: MachineConfig = {
      ...machine,
      states: Object.fromEntries(
        Object.entries(machine.states).map(([k, v]) => [k, { ...v }])
      ),
    }
    for (const stateConfig of Object.values(cloned.states)) {
      for (const [key, target] of Object.entries(stateConfig)) {
        if (!key.includes(':') && asyncMethods.has(key) && cloned.states[target]) {
          cloned.states[target][setKey(key)] = target
        }
      }
    }
    if (asyncMethods.size > 0) {
      for (const [stateName, stateConfig] of Object.entries(cloned.states)) {
        stateConfig['__error'] = stateName
      }
    }
    machine = cloned
    // Dev mode: print generated machine so auto-injected transitions are visible
    if (typeof (globalThis as Record<string, unknown>).__aioDev !== 'undefined') {
      console.debug(`[aio:${name}] machine:`, JSON.stringify(machine, null, 2))
    }
  }

  // Detect foreign actions
  const foreignSet = new Set<string>()
  if (machine !== false) {
    for (const sc of Object.values(machine.states)) {
      for (const key of Object.keys(sc)) {
        if (key.includes(':') && !key.startsWith(prefix + ':')) {
          foreignSet.add(key)
        }
      }
    }
  }

  const allActionKeys = [...methodNames, ...generatorNames, ...[...asyncMethods].map(k => setKey(k))]
  if (asyncMethods.size > 0) allActionKeys.push('__error')

  // Validate machine if provided
  if (machine !== false) {
    validateMachine(name, machine, new Set(allActionKeys))
  }

  // Build reducer
  const reduce: FeatureReduceFn = (state: unknown, action: Msg): (Msg | ScheduleEffect)[] | void => {
    const s = state as Record<string, unknown>
    const ownKey = actionTypeToKey.get(action.type)
    if (!ownKey) return

    // Handle batched mutations from async methods
    if (ownKey.startsWith('__set')) {
      const payload = action.payload as { mutations: Mutation[] }
      applyMutations(s, payload.mutations)
      return
    }

    // Error action — no state change
    if (ownKey === '__error') return

    const method = methods[ownKey]
    if (!method) return

    if (syncMethods.has(ownKey)) {
      const { args } = action.payload as { args: unknown[] }
      const result = (method as SyncMethod<S>)(s as S, ...args)
      return result ? (Array.isArray(result) ? result : [result]) : undefined
    }

    if (asyncMethods.has(ownKey)) {
      const { args, _callId } = action.payload as { args: unknown[]; _callId?: string }
      return [{
        type: `${prefix}:__exec`,
        payload: { _method: ownKey, _args: args, _callId },
      }]
    }
  }

  // Build executor for async methods
  const execute: FeatureExecuteFn | undefined = asyncMethods.size > 0 || config.effects
    ? (app: ScopedApp, effect: Msg): void => {
        // Handle async method execution
        if (effect.type === `${prefix}:__exec`) {
          const { _method, _args, _callId } = effect.payload as { _method: string; _args: unknown[]; _callId?: string }
          const method = methods[_method]
          if (!method || !asyncMethods.has(_method)) return

          const batcher = createBatcher(prefix, (a) => app.dispatch(a))
          const proxy = createLiveProxy(name, prefix, _method, () => app.getState() as Record<string, unknown>, batcher)

          ;(method as AsyncMethod<S>)(proxy as S, ..._args)
            .then((value) => resolveCall(_callId, value))
            .catch((e: Error) => {
              resolveCall(_callId, undefined, e)
              console.error(`[${name}] ${_method}() threw: ${e}`)
              app.dispatch({
                type: `${prefix}:__error`,
                payload: { _method, error: String(e) },
                _source: 'Effect',
              } as Msg)
            })
          return
        }

        // Handle explicit effects
        if (config.execute) {
          if (typeof config.execute === 'object') {
            const handlers = config.execute as Record<string, (app: ScopedApp, payload: unknown) => void | Promise<void>>
            const effectTypeToKey = new Map<string, string>()
            for (const k of effectKeys) effectTypeToKey.set(`${prefix}:${k}`, k)
            const key = effectTypeToKey.get(effect.type) ?? effect.type
            const h = handlers[key]
            if (h) { void h(app as ScopedApp<S>, (effect as { payload: unknown }).payload) }
          } else {
            const emitMap: Record<string, string> = {}
            for (const k of effectKeys) emitMap[k] = `${prefix}:${k}`
            ;(config.execute as (app: ScopedApp<S>, effect: Msg, ctx: { emit: Record<string, unknown> }) => void)(
              app as ScopedApp<S>, effect, { emit: emitMap }
            )
          }
        }
      }
    : undefined

  // Build flows from generators
  const flows: Record<string, FlowDef> = {}
  const flowTriggers = new Map<string, string>()
  for (const [key, fn] of Object.entries(rawGenerators)) {
    const triggers = config.cancelOn?.[key] ?? fn.cancelOn
    const cancelOnStrings = triggers?.map((t: string | { type: string }) =>
      typeof t === 'string' ? t : t.type
    )
    flows[key] = { trigger: key, generator: fn, _stepNames: [], cancelOn: cancelOnStrings, argsStyle: 'spread' }
    flowTriggers.set(key, key)
  }

  // Assemble internals
  const internals: FeatureInternals = {
    state: config.state as Record<string, unknown>,
    machine,
    reduce,
    execute,
    actionKeys: allActionKeys,
    effectKeys,
    prefix,
    actionTypeToKey,
    foreignActions: [...foreignSet],
    initType: `${prefix}:init`,
    destroyType: `${prefix}:destroy`,
    crossDispatchPrefixes: new Set((config.dispatchTo ?? []).map(f => typeof f === 'string' ? f : f.name)),
    onInit: config.onInit as ((app: ScopedApp) => void) | undefined,
    onDestroy: config.onDestroy as ((app: ScopedApp) => void) | undefined,
    methods: methods as FeatureMethods<Record<string, unknown>>,
    syncMethods,
    asyncMethods,
    flows: Object.keys(flows).length > 0 ? flows : undefined,
    flowTriggers: flowTriggers.size > 0 ? flowTriggers : undefined,
    persistExclude: config.persist?.exclude,
  }

  // Build selectors
  const selectors: Record<string, (state: unknown) => unknown> = {}
  if (config.selectors) {
    for (const [key, fn] of Object.entries(config.selectors)) {
      selectors[key] = (fullState: unknown) =>
        fn((fullState as Record<string, unknown>)[name] as S)
    }
  }

  // Build public catalog
  const publicCatalog: Record<string, unknown> = {}
  for (const key of [...methodNames, ...generatorNames]) {
    const label = `${prefix}:${key}`
    publicCatalog[key] = Object.assign(
      (...args: unknown[]) => ({ type: label, payload: { args } }),
      { type: label },
    )
  }

  const def: Record<string, unknown> = {
    name,
    A: publicCatalog,
    E: eCatalog,
    selectors,
    _config: internals,
    implement(fn: FeatureExecuteFn) { internals.execute = fn },
  }

  // Flatten onto feature def
  const selectorKeys = new Set(Object.keys(config.selectors ?? {}))
  for (const key of selectorKeys) {
    if (RESERVED_KEYS.has(key)) {
      throw new Error(`[${name}] selector '${key}' collides with reserved property`)
    }
  }
  for (const [key, value] of Object.entries(publicCatalog)) {
    if (RESERVED_KEYS.has(key)) continue
    if (selectorKeys.has(key)) {
      throw new Error(`[${name}] method '${key}' collides with selector of same name`)
    }
    if (typeof value === 'function') {
      const original = value as ((...args: unknown[]) => unknown) & { type?: string }
      const stub = (...args: unknown[]) => {
        if (!def._bound) {
          console.warn(`[${name}] ${key}() called before aio.run() — returns action object, not dispatching`)
        }
        return original(...args)
      }
      if (original.type) (stub as unknown as Record<string, unknown>).type = original.type
      def[key] = stub
    } else {
      def[key] = value
    }
  }

  // deno-lint-ignore no-explicit-any
  return def as unknown as FeatureDef<N, Record<string, never>, Record<string, never>, S> & DirectCalling<M>
}

// ── Actions-based feature (classic style) ─────────────────────────────

function createFeatureFromActions<
  N extends string,
  S extends Record<string, unknown>,
  A extends Creators,
  E extends Creators,
>(name: N, config: ActionsFeatureConfig<N, S, A, E>): FeatureDef<N, A, E, S> & FlatActions<A> {
  const prefix = name
  const actionKeySet = new Set(Object.keys(config.actions))
  const effectKeyList = Object.keys(config.effects ?? {})
  const machine = (config.machine === false || config.machine == null)
    ? false
    : config.machine as MachineConfig

  // Build catalogs
  const { catalog: aCatalog, typeToKey: actionTypeToKey } = buildCatalog(prefix, config.actions)
  const { catalog: eCatalog } = buildCatalog(prefix, config.effects ?? {})

  // Validate machine
  if (machine !== false) {
    validateMachine(name, machine, actionKeySet)
  }

  // Detect foreign actions from machine (types containing ':' from other features)
  const foreignSet = new Set<string>()
  if (machine !== false) {
    for (const sc of Object.values(machine.states)) {
      for (const key of Object.keys(sc)) {
        if (key.includes(':') && !key.startsWith(prefix + ':')) {
          foreignSet.add(key)
        }
      }
    }
  }
  const foreignActions = [...foreignSet]

  // Build flows from generators (keyed by trigger action key)
  const rawGenerators = (config.generators ?? {}) as Record<string, GeneratorEntry>
  const flows: Record<string, FlowDef> = {}
  const flowTriggers = new Map<string, string>()
  for (const [key, fn] of Object.entries(rawGenerators)) {
    if (!actionKeySet.has(key)) {
      throw new Error(`[feature:${name}] generator '${key}' must match an action key`)
    }
    const triggers = config.cancelOn?.[key] ?? fn.cancelOn
    const cancelOnStrings = triggers?.map((t: string | { type: string }) =>
      typeof t === 'string' ? t : t.type
    )
    flows[key] = { trigger: key, generator: fn, _stepNames: [], cancelOn: cancelOnStrings, argsStyle: 'payload' }
    flowTriggers.set(key, key)
  }

  // Default noop reducer when only generators are used
  const noopReduce: FeatureReduceFn = () => undefined

  // Build { on } map: camelCase key → full type string (for function-form reduce/execute)
  const onMap: Record<string, string> = {}
  for (const key of actionKeySet) onMap[key] = `${prefix}:${key}`
  const emitMap: Record<string, string> = {}
  for (const key of effectKeyList) emitMap[key] = `${prefix}:${key}`

  // Normalize reduce: object form → FeatureReduceFn, function form → wrap with { on }
  let reduceFn: FeatureReduceFn
  if (!config.reduce) {
    reduceFn = noopReduce
  } else if (typeof config.reduce === 'object') {
    const handlers = config.reduce as Record<string, (state: unknown, payload: unknown) => void>
    reduceFn = (state: unknown, action: Msg): (Msg | ScheduleEffect)[] | void => {
      const key = actionTypeToKey.get(action.type)
      if (!key) {
        // Foreign action key — use full type string
        const h = handlers[action.type]
        if (h) return h(state, (action as { payload: unknown }).payload) as (Msg | ScheduleEffect)[] | void
        return
      }
      const h = handlers[key]
      if (h) return h(state, (action as { payload: unknown }).payload) as (Msg | ScheduleEffect)[] | void
    }
  } else {
    // Function form: wrap to inject { on } instead of { A, E }
    const userReduceFn = config.reduce as (state: unknown, action: Msg, ctx: { on: Record<string, string> }) => (Msg | ScheduleEffect)[] | void
    reduceFn = (state: unknown, action: Msg): (Msg | ScheduleEffect)[] | void =>
      userReduceFn(state, action, { on: onMap })
  }

  // Normalize execute: object form → FeatureExecuteFn, function form → wrap with { emit }
  let executeFn: FeatureExecuteFn | undefined
  if (!config.execute) {
    executeFn = undefined
  } else if (typeof config.execute === 'object') {
    const handlers = config.execute as Record<string, (app: ScopedApp, payload: unknown) => void | Promise<void>>
    const effectTypeToKey = new Map<string, string>()
    for (const key of effectKeyList) effectTypeToKey.set(`${prefix}:${key}`, key)
    executeFn = (app: ScopedApp, effect: Msg): void => {
      const key = effectTypeToKey.get(effect.type) ?? effect.type
      const h = handlers[key]
      if (h) { void h(app, (effect as { payload: unknown }).payload) }
    }
  } else {
    // Function form: wrap to inject { emit } instead of { E, A }
    const userExecuteFn = config.execute as (app: ScopedApp, effect: Msg, ctx: { emit: Record<string, string> }) => void
    executeFn = (app: ScopedApp, effect: Msg): void =>
      userExecuteFn(app, effect, { emit: emitMap })
  }

  const internals: FeatureInternals = {
    state: config.state,
    machine,
    reduce: reduceFn,
    execute: executeFn,
    actionKeys: [...actionKeySet],
    effectKeys: effectKeyList,
    prefix,
    actionTypeToKey,
    foreignActions,
    initType: `${prefix}:init`,
    destroyType: `${prefix}:destroy`,
    crossDispatchPrefixes: new Set((config.dispatchTo ?? []).map(f => typeof f === 'string' ? f : f.name)),
    onInit: config.onInit as ((app: ScopedApp) => void) | undefined,
    onDestroy: config.onDestroy as ((app: ScopedApp) => void) | undefined,
    flows: Object.keys(flows).length > 0 ? flows : undefined,
    flowTriggers: flowTriggers.size > 0 ? flowTriggers : undefined,
    persistExclude: config.persist?.exclude,
  }

  // Validate selector names don't collide with reserved keys
  const selectorKeys = new Set(Object.keys(config.selectors ?? {}))
  for (const key of selectorKeys) {
    if (RESERVED_KEYS.has(key))
      throw new Error(`[${name}] selector '${key}' collides with reserved property`)
  }

  // Auto-scope selectors: user writes (s: S) => ..., we wrap to extract state[name]
  const scopedSelectors: Record<string, (state: unknown) => unknown> = {}
  for (const [key, fn] of Object.entries(config.selectors ?? {})) {
    scopedSelectors[key] = (fullState: unknown) =>
      fn((fullState as Record<string, unknown>)[name] as S)
  }

  const def: Record<string, unknown> = {
    name,
    A: aCatalog as Catalog<N, A>,
    E: eCatalog as Catalog<N, E>,
    selectors: scopedSelectors,
    _config: internals,
    implement(fn: FeatureExecuteFn) { internals.execute = fn },
  }

  // Flatten action creators + string constants directly onto the feature def
  flattenOnto(def, aCatalog, selectorKeys, name)

  return def as unknown as FeatureDef<N, A, E, S> & FlatActions<A>
}

// ── Feature composition (used by aio.run) ──────────────────────────

/** Feature status info for health/status reporting */
export type FeatureStatus = {
  name: string
  status: string | undefined
  enabled: boolean
  errors: number
  lastAction?: string
  lastActionAt?: number
}

/** Resolved + sorted features with dependency info */
export type ComposedFeatures = {
  initialState: Record<string, unknown>
  reduce: (state: Record<string, unknown>, action: Msg) => { state: Record<string, unknown>; effects: (Msg | ScheduleEffect)[] }
  execute: (app: { dispatch: (a: Msg) => void; getState: () => unknown }, effect: Msg) => void
  features: FeatureDef[]
  featureNames: string[]
  /** Init all features in dependency order */
  initAll: (app: { dispatch: (a: Msg) => void; getState: () => unknown }) => void
  /** Destroy all features in reverse dependency order */
  destroyAll: (app: { dispatch: (a: Msg) => void; getState: () => unknown }) => void
  /** Feature registry for enable/disable/status/health */
  registry: {
    enable: (name: string, app: { dispatch: (a: Msg) => void; getState: () => unknown }) => void
    disable: (name: string, dispatch: (a: Msg) => void) => void
    isEnabled: (name: string) => boolean
    status: (name: string, state: Record<string, unknown>) => string | undefined
    health: (state: Record<string, unknown>) => FeatureStatus[]
    /** Set callback for schedule cleanup on feature disable */
    setOnDisable: (fn: (prefix: string) => void) => void
  }
}

/** Resolve feature entries, validate dependencies, return topologically sorted list */
function resolveFeatures(entries: FeatureEntry[]): FeatureDef[] {
  const features: FeatureDef[] = []
  const deps = new Map<string, string[]>()

  const seen = new Set<string>()
  for (const entry of entries) {
    const f = '_config' in entry ? entry as FeatureDef : (entry as { feature: FeatureDef }).feature
    if (seen.has(f.name)) throw new Error(`duplicate feature name: '${f.name}'`)
    seen.add(f.name)
    features.push(f)
    if ('_config' in entry) {
      deps.set(f.name, [])
    } else {
      deps.set(f.name, (entry as { dependsOn?: string[] }).dependsOn ?? [])
    }
  }

  // Validate dependencies exist
  const names = new Set(features.map(f => f.name))
  for (const [name, depList] of deps) {
    for (const dep of depList) {
      if (!names.has(dep)) {
        throw new Error(`[feature:${name}] depends on unknown feature '${dep}'`)
      }
    }
  }

  // Cycle detection (DFS)
  const visited = new Set<string>()
  const inStack = new Set<string>()
  function visit(name: string, path: string[]): void {
    if (inStack.has(name)) {
      throw new Error(`dependency cycle: ${[...path, name].join(' → ')}`)
    }
    if (visited.has(name)) return
    inStack.add(name)
    for (const dep of deps.get(name) ?? []) {
      visit(dep, [...path, name])
    }
    inStack.delete(name)
    visited.add(name)
  }
  for (const name of names) visit(name, [])

  // Topological sort
  const sorted: FeatureDef[] = []
  const placed = new Set<string>()
  function place(name: string): void {
    if (placed.has(name)) return
    for (const dep of deps.get(name) ?? []) place(dep)
    placed.add(name)
    sorted.push(features.find(f => f.name === name)!)
  }
  for (const f of features) place(f.name)

  return sorted
}

/** Compose features into {initialState, reduce, execute} compatible with existing dispatch loop */
export function composeFeatures(entries: FeatureEntry[]): ComposedFeatures {
  if (entries.length === 0) {
    console.warn('[aio] no features provided to composeFeatures()')
  }

  const features = resolveFeatures(entries)
  let onFeatureDisable: ((prefix: string) => void) | undefined

  // ── Validation ──
  for (const f of features) {
    if (f._config.state._status !== undefined) {
      console.warn(`[${f.name}] state._status is reserved for machine status — rename it to avoid conflicts`)
    }
    if (f._config.actionKeys.length === 0) {
      console.warn(`[${f.name}] has no actions — is this intentional?`)
    }
  }

  // ── Initial state ──
  const initialState: Record<string, unknown> = {}
  for (const f of features) {
    const machine = f._config.machine
    const status = machine === false ? undefined : machine.initial
    initialState[f.name] = status != null
      ? { ...f._config.state, _status: status }
      : { ...f._config.state }
  }

  // ── Action routing ──
  const ownByPrefix = new Map<string, FeatureDef>()
  const listenersByType = new Map<string, FeatureDef[]>()

  for (const f of features) {
    ownByPrefix.set(f._config.prefix, f)
    // Foreign action listeners (detected from machine)
    for (const foreignType of f._config.foreignActions) {
      const list = listenersByType.get(foreignType) ?? []
      list.push(f)
      listenersByType.set(foreignType, list)
    }
  }

  // ── Per-feature reduce ──
  type ReduceResult = { state: Record<string, unknown>; effects: (Msg | ScheduleEffect)[] }

  function reduceFeature(
    f: FeatureDef,
    fullState: Record<string, unknown>,
    action: Msg,
  ): ReduceResult {
    const { machine, reduce, actionTypeToKey, flowTriggers } = f._config
    const featureName = f.name
    const featureState = fullState[featureName] as Record<string, unknown>

    // Check if this action triggers a flow
    const ownKey = actionTypeToKey.get(action.type)
    const flowName = ownKey && flowTriggers ? flowTriggers.get(ownKey) : undefined

    // Machine guard
    if (machine !== false) {
      const currentStatus = (featureState._status ?? machine.initial) as string
      const stateConfig = machine.states[currentStatus]
      if (!stateConfig) return { state: fullState, effects: [] }

      // Lookup: own action → camelCase key; foreign → full type string
      const lookupKey = ownKey ?? action.type
      const transitions = stateConfig

      if (!(lookupKey in transitions)) {
        console.debug(`[aio:${featureName}] blocked: '${action.type}' not allowed in state '${currentStatus}'`)
        return { state: fullState, effects: [] } // invalid transition → drop
      }

      // Run reduce with Immer (feature's slice only)
      let effects: (Msg | ScheduleEffect)[] = []
      const nextSlice = produce(featureState, (draft: Draft<Record<string, unknown>>) => {
        const result = reduce(draft, action, { A: f.A, E: f.E })
        if (Array.isArray(result)) effects = result
      })

      // Clone effects to detach from Immer draft
      if (effects.length) {
        try { effects = structuredClone(effects) } catch { console.warn(`[feature] effects not cloneable — may hold draft refs`) }
      }

      // Inject flow trigger effect if this action starts a flow
      if (flowName) {
        effects.push({
          type: `${f._config.prefix}:__flow`,
          payload: { _flowName: flowName, _triggerAction: action },
        })
      }

      // Update _status to target state
      const target = transitions[lookupKey]
      const withStatus = nextSlice._status !== target
        ? { ...nextSlice, _status: target }
        : nextSlice

      return { state: { ...fullState, [featureName]: withStatus }, effects }
    }

    // Simple machine — no guards, no _status
    let effects: (Msg | ScheduleEffect)[] = []
    const nextSlice = produce(featureState, (draft: Draft<Record<string, unknown>>) => {
      const result = reduce(draft, action, { A: f.A, E: f.E })
      if (Array.isArray(result)) effects = result
    })

    if (effects.length) {
      try { effects = structuredClone(effects) } catch { console.warn(`[feature] effects not cloneable — may hold draft refs`) }
    }

    // Inject flow trigger effect if this action starts a flow
    if (flowName) {
      effects.push({
        type: `${f._config.prefix}:__flow`,
        payload: { _flowName: flowName, _triggerAction: action },
      })
    }

    return { state: { ...fullState, [featureName]: nextSlice }, effects }
  }

  // ── Feature enable/disable registry ──
  const disabledFeatures = new Set<string>()
  const featureErrors = new Map<string, number>()
  const featureLastAction = new Map<string, { type: string; at: number }>()

  // ── Flow reducers (handle __FlowState actions) ──
  const flowReducers = new Map<string, ReturnType<typeof createFlowReducer>>()
  for (const f of features) {
    if (f._config.flows && Object.keys(f._config.flows).length > 0) {
      flowReducers.set(f._config.prefix, createFlowReducer(f.name))
    }
  }

  // ── Root reducer ──
  const rootReduce = (state: Record<string, unknown>, action: Msg): ReduceResult => {
    let currentState = state
    const allEffects: (Msg | ScheduleEffect)[] = []

    // Handle flow state updates (__FlowState) — direct state replacement from flow runner
    if (typeof action.type === 'string' && action.type.endsWith(':__FlowState')) {
      const colonIdx = action.type.indexOf(':')
      const prefix = action.type.slice(0, colonIdx)
      const flowReducer = flowReducers.get(prefix)
      if (flowReducer) {
        const result = flowReducer(currentState, action)
        if (result) return { state: result, effects: [] }
      }
      return { state: currentState, effects: [] }
    }

    // Handle lifecycle actions (Init/Destroy) — apply state change, then continue routing
    // so foreign action listeners can react to lifecycle events
    let isLifecycle = false
    for (const f of features) {
      if (action.type === f._config.initType) {
        const machine = f._config.machine
        const status = machine === false ? undefined : machine.initial
        // Merge: initial defaults ← existing (KV-restored) data ← _status
        const existing = currentState[f.name] as Record<string, unknown> | undefined
        const base = { ...f._config.state, ...existing }
        currentState = {
          ...currentState,
          [f.name]: status != null
            ? { ...base, _status: status }
            : base,
        }
        isLifecycle = true
        break
      }
      if (action.type === f._config.destroyType) {
        const machine = f._config.machine
        currentState = {
          ...currentState,
          [f.name]: machine === false
            ? { ...f._config.state }
            : { ...f._config.state, _status: machine.initial },
        }
        isLifecycle = true
        break
      }
    }

    // Route to owning feature (by prefix) — skip for lifecycle actions (state already handled)
    if (!isLifecycle) {
      const colonIdx = (action.type as string).indexOf(':')
      if (colonIdx !== -1) {
        const prefix = (action.type as string).slice(0, colonIdx)
        const owner = ownByPrefix.get(prefix)
        if (owner && !disabledFeatures.has(owner.name)) {
          const result = reduceFeature(owner, currentState, action)
          currentState = result.state
          allEffects.push(...result.effects)
          featureLastAction.set(owner.name, { type: action.type, at: Date.now() })
        }
      }
    }

    // Route to foreign action listeners
    const listeners = listenersByType.get(action.type)
    if (listeners) {
      for (const listener of listeners) {
        if (disabledFeatures.has(listener.name)) continue
        const result = reduceFeature(listener, currentState, action)
        currentState = result.state
        allEffects.push(...result.effects)
        featureLastAction.set(listener.name, { type: action.type, at: Date.now() })
      }
    }

    // Notify waiting flows (ctx.waitFor) about dispatched actions
    notifyFlowListeners(action)

    // Reject pending call() if the action was blocked (machine dropped it, feature disabled, etc.)
    const callId = (action.payload as Record<string, unknown>)?._callId as string | undefined
    if (callId) {
      const forwarded = allEffects.some(e =>
        typeof e === 'object' && 'payload' in e &&
        (e as Msg).type.endsWith(':__exec') &&
        ((e as Msg).payload as Record<string, unknown>)?._callId === callId
      )
      if (!forwarded) resolveCall(callId, undefined, new Error(`call('${action.type}'): blocked — machine guard, feature disabled, or not found`))
    }

    return { state: currentState, effects: allEffects }
  }

  // ── Flow executors ──
  // Flows are triggered by actions via internal __flow effects from the reducer
  const flowsByPrefix = new Map<string, { featureName: string; flows: Record<string, FlowDef>; triggers: Map<string, string> }>()
  for (const f of features) {
    if (f._config.flows && f._config.flowTriggers && Object.keys(f._config.flows).length > 0) {
      flowsByPrefix.set(f._config.prefix, {
        featureName: f.name,
        flows: f._config.flows,
        triggers: f._config.flowTriggers,
      })
    }
  }

  // ── Root executor ──
  const executorByPrefix = new Map<string, FeatureDef>()
  for (const f of features) {
    if (f._config.execute) {
      executorByPrefix.set(f._config.prefix, f)
    }
  }

  const rootExecute = (
    app: { dispatch: (a: Msg) => void; getState: () => unknown },
    effect: Msg,
  ): void => {
    const colonIdx = (effect.type as string).indexOf(':')
    if (colonIdx === -1) return

    const prefix = (effect.type as string).slice(0, colonIdx)

    // Handle __flow effects — start a generator flow
    if ((effect.type as string).endsWith(':__flow')) {
      const flowInfo = flowsByPrefix.get(prefix)
      if (!flowInfo) return
      const payload = effect.payload as { _flowName: string; _triggerAction: Msg }
      const flowDef = flowInfo.flows[payload._flowName]
      if (!flowDef) return

      const flowApp = {
        dispatch: (a: Msg) => app.dispatch(a),
        getState: () => app.getState() as Record<string, unknown>,
      }

      runFlow(flowDef, payload._flowName, flowInfo.featureName, payload._triggerAction, flowApp)
        .catch(e => console.error(`[${flowInfo.featureName}] flow '${payload._flowName}' error: ${e}`))
      return
    }

    // Skip internal flow state actions — handled by reducer
    if ((effect.type as string).endsWith(':__FlowState')) return

    const f = executorByPrefix.get(prefix)
    if (!f || !f._config.execute) return
    if (disabledFeatures.has(f.name)) return

    // Scoped dispatch — runtime guard: own actions + dispatchTo allowlist
    const ownPrefix = f._config.prefix + ':'
    const crossPrefixes = f._config.crossDispatchPrefixes
    const scopedApp: ScopedApp = {
      dispatch: (a: Msg) => {
        if (typeof a?.type !== 'string') return
        if (!a.type.startsWith(ownPrefix)) {
          // Check dispatchTo allowlist
          const colonIdx = a.type.indexOf(':')
          const targetPrefix = colonIdx !== -1 ? a.type.slice(0, colonIdx) : ''
          if (!crossPrefixes.has(targetPrefix)) {
            console.error(`[${f.name}] execute() blocked — tried to dispatch to '${targetPrefix}', add it to dispatchTo: [${targetPrefix}] in your feature config`)
            featureErrors.set(f.name, (featureErrors.get(f.name) ?? 0) + 1)
            return
          }
        }
        app.dispatch(tagSource(a, 'Effect'))
      },
      getState: () => (app.getState() as Record<string, unknown>)[f.name] as unknown,
      getFullState: () => app.getState() as Record<string, unknown>,
    }

    try {
      f._config.execute(scopedApp, effect, { E: f.E, A: f.A })
    } catch (e) {
      console.error(`[${f.name}] executor threw: ${e}`)
      featureErrors.set(f.name, (featureErrors.get(f.name) ?? 0) + 1)
    }
  }

  // ── Lifecycle ──
  const initAll = (app: { dispatch: (a: Msg) => void; getState: () => unknown }): void => {
    for (const f of features) {
      app.dispatch(tagSource({ type: f._config.initType, payload: {} }, 'System'))
      if (f._config.onInit) {
        const scopedApp: ScopedApp = {
          dispatch: (a: Msg) => app.dispatch(tagSource(a, 'System')),
          getState: () => (app.getState() as Record<string, unknown>)[f.name] as unknown,
          getFullState: () => app.getState() as Record<string, unknown>,
        }
        try { f._config.onInit(scopedApp) } catch (e) {
          console.error(`[${f.name}] init: ${e}`)
          featureErrors.set(f.name, (featureErrors.get(f.name) ?? 0) + 1)
        }
      }
    }
  }

  const destroyAll = (app: { dispatch: (a: Msg) => void; getState: () => unknown }): void => {
    for (let i = features.length - 1; i >= 0; i--) {
      const f = features[i]
      // Cancel any running flows for this feature
      cancelFeatureFlows(f.name)
      if (f._config.onDestroy) {
        const scopedApp: ScopedApp = {
          dispatch: (a: Msg) => app.dispatch(tagSource(a, 'System')),
          getState: () => (app.getState() as Record<string, unknown>)[f.name] as unknown,
          getFullState: () => app.getState() as Record<string, unknown>,
        }
        try { f._config.onDestroy(scopedApp) } catch (e) {
          console.error(`[${f.name}] destroy: ${e}`)
          featureErrors.set(f.name, (featureErrors.get(f.name) ?? 0) + 1)
        }
      }
      app.dispatch(tagSource({ type: f._config.destroyType, payload: {} }, 'System'))
    }
  }

  // ── Registry ──
  const registry = {
    enable: (name: string, app: { dispatch: (a: Msg) => void; getState: () => unknown }) => {
      disabledFeatures.delete(name)
      featureErrors.delete(name) // reset error counter on re-enable
      const f = features.find(f => f.name === name)
      if (f) app.dispatch(tagSource({ type: f._config.initType, payload: {} }, 'System'))
    },
    disable: (name: string, dispatch: ((a: Msg) => void) | { dispatch: (a: Msg) => void }) => {
      disabledFeatures.add(name)
      const f = features.find(f => f.name === name)
      const doDispatch = typeof dispatch === 'function' ? dispatch : dispatch.dispatch
      if (f) {
        cancelFeatureFlows(f.name)
        doDispatch(tagSource({ type: f._config.destroyType, payload: {} }, 'System'))
        // Notify host to cancel schedules for this feature
        if (onFeatureDisable) onFeatureDisable(f._config.prefix)
      }
    },
    isEnabled: (name: string) => !disabledFeatures.has(name),
    status: (name: string, state: Record<string, unknown>): string | undefined => {
      const fs = state[name] as Record<string, unknown> | undefined
      return fs?._status as string | undefined
    },
    health: (state: Record<string, unknown>): FeatureStatus[] => {
      return features.map(f => {
        const fs = state[f.name] as Record<string, unknown> | undefined
        const last = featureLastAction.get(f.name)
        return {
          name: f.name,
          status: fs?._status as string | undefined,
          enabled: !disabledFeatures.has(f.name),
          errors: featureErrors.get(f.name) ?? 0,
          lastAction: last?.type,
          lastActionAt: last?.at,
        }
      })
    },
    setOnDisable: (fn: (prefix: string) => void) => { onFeatureDisable = fn },
  }

  return {
    initialState,
    reduce: rootReduce,
    execute: rootExecute,
    features,
    featureNames: features.map(f => f.name),
    initAll,
    destroyAll,
    registry,
  }
}

// ── Test harness ───────────────────────────────────────────────────

export type TestContext<
  S = Record<string, unknown>,
  // deno-lint-ignore no-explicit-any
  A = Record<string, (...args: any[]) => any>,
> = {
  /** Initialize/reset feature to initial state */
  init: () => void
  /** Destroy feature (reset to initial + 'uninitialized' status) */
  destroy: () => void
  /** Typed action senders — one per declared action, arguments inferred from action creators */
  send: { [K in keyof A & string]: A[K] extends (...args: infer P) => unknown ? (...args: P) => void : never }
  /** Assertions */
  expect: {
    /** Assert on feature state slice */
    // deno-lint-ignore no-explicit-any
    state: (fn: (s: any, ...args: any[]) => boolean) => void
    /** Assert current machine status */
    status: (expected: string) => void
    /** Assert effect types returned by last action (full type strings, e.g. 'counter:persist') */
    effects: (types: string[]) => void
    /** Assert number of effects returned by last action */
    effectCount: (n: number) => void
    /** Assert a predicate holds for current state */
    invariant: (fn: (s: S) => boolean) => void
  }
  /** Get current feature state */
  getState: () => S
  /** Get effects from last dispatched action */
  getEffects: () => (Msg | ScheduleEffect)[]
  /** Dispatch N random valid actions (for property-based testing) */
  randomActions: (n: number) => void
  /** Run pending effects (executor). Deprecated — `settle()` now auto-runs effects. */
  runEffects: () => void
  /** Run effects + wait for async to complete. Replaces `runEffects() + settle()`.
   *  No arg: drain microtasks (fast, for in-memory async). With ms: timer-based wait. */
  settle: (ms?: number) => Promise<void>
}

/** Test harness for isolated feature testing — wraps Deno.test with typed helpers */
export function testFeature<
  S extends Record<string, unknown> = Record<string, unknown>,
  N extends string = string,
  // deno-lint-ignore no-explicit-any
  A extends Creators = any,
  // deno-lint-ignore no-explicit-any
  E extends Creators = any,
>(
  f: FeatureDef<N, A, E, S>,
  testName: string,
  fn: (t: TestContext<S, Catalog<N, A>>) => void | Promise<void>,
): void {
  Deno.test(`[${f.name}] ${testName}`, async () => {
    // Reset shared runtime state for test isolation — prevents bleed from prior runs
    resetFlows()
    resetPending()

    // Compose a single-feature system
    const composed = composeFeatures([f])
    const machine = f._config.machine

    let state = { ...composed.initialState }
    let lastEffects: (Msg | ScheduleEffect)[] = []

    const app = {
      dispatch,
      getState: () => state,
    }

    function dispatch(action: Msg): void {
      const result = composed.reduce(state, action)
      state = { ...result.state }
      lastEffects = result.effects
    }

    // Build send proxy from action creators (cast to typed form — runtime matches compile-time shape)
    // deno-lint-ignore no-explicit-any
    const send = {} as TestContext<S, Catalog<N, A>>['send']
    for (const key of f._config.actionKeys) {
      const creator = (f.A as Record<string, unknown>)[key]
      if (typeof creator === 'function') {
        // deno-lint-ignore no-explicit-any
        ;(send as Record<string, (...args: any[]) => void>)[key] = (...args: unknown[]) => dispatch((creator as (...a: unknown[]) => Msg)(...args))
      }
    }

    const ctx: TestContext<S, Catalog<N, A>> = {
      init: () => {
        state = { ...composed.initialState }
        lastEffects = []
      },
      destroy: () => {
        const base = machine === false
          ? { ...f._config.state }
          : { ...f._config.state, _status: 'uninitialized' }
        state = { [f.name]: base }
        lastEffects = []
      },
      send,
      expect: {
        state: (check) => {
          const fs = state[f.name] as S
          if (!check(fs)) {
            throw new Error(`state assertion failed: ${JSON.stringify(fs)}`)
          }
        },
        status: (expected) => {
          const fs = state[f.name] as Record<string, unknown>
          const actual = fs._status
          if (actual !== expected) {
            throw new Error(`expected status '${expected}', got '${actual}'`)
          }
        },
        effects: (types) => {
          const actual = lastEffects.map(e => e.type as string).sort()
          const expected = [...types].sort()
          if (JSON.stringify(expected) !== JSON.stringify(actual)) {
            throw new Error(`expected effects [${expected}], got [${actual}]`)
          }
        },
        effectCount: (n) => {
          if (lastEffects.length !== n) {
            throw new Error(`expected ${n} effects, got ${lastEffects.length}`)
          }
        },
        invariant: (check) => {
          const fs = state[f.name] as S
          if (!check(fs)) {
            throw new Error(`invariant violation: ${JSON.stringify(fs)}`)
          }
        },
      },
      getState: () => state[f.name] as S,
      getEffects: () => lastEffects,
      randomActions: (n) => {
        const keys = f._config.actionKeys
        for (let i = 0; i < n; i++) {
          const key = keys[Math.floor(Math.random() * keys.length)]
          try { send[key]() } catch { /* invalid transitions are expected */ }
        }
      },
      runEffects: () => {
        for (const eff of lastEffects) {
          composed.execute(app, eff as { type: string; payload: unknown })
        }
      },
      settle: async (ms?: number): Promise<void> => {
        // Auto-run pending effects first (eliminates need to call runEffects separately)
        for (const eff of lastEffects) {
          composed.execute(app, eff as { type: string; payload: unknown })
        }
        // Wait for async to complete — timer if ms given, otherwise drain microtasks
        if (ms !== undefined) {
          await new Promise(resolve => setTimeout(resolve, ms))
        } else {
          for (let i = 0; i < 10; i++) await Promise.resolve()
        }
      },
    }

    await fn(ctx)
  })
}

/** @deprecated bridge() removed in v0.8 — use call({ timeout, retries }, ...) instead */
export function testBridge(_b: FeatureDef, _testName: string, _fn: (t: never) => void): void {
  throw new Error('testBridge() removed in v0.8 — use call({ timeout, retries }) and testFeature() instead')
}
