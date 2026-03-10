// feature.ts — v0.5 feature-based architecture
//
// feature()          — define a feature (state, actions, effects, machine, reduce, execute, selectors)
// bridge()           — define a cross-feature bridge (request/response, timeouts, retries)
// composeFeatures()  — compose features into {initialState, reduce, execute} for aio.run()
// testFeature()      — test harness for isolated feature testing

import { produce, type Draft } from 'immer'
import type { ScheduleEffect } from './schedule.ts'

// ── Helpers ────────────────────────────────────────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ── Types ──────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
type Creators = Record<string, (...args: any[]) => Record<string, unknown>>

type UpperFirst<S extends string> = S extends `${infer C}${infer Rest}` ? `${Uppercase<C>}${Rest}` : S

/** Catalog type: PascalCase string labels + camelCase action/effect creators */
export type Catalog<Prefix extends string, T extends Creators> = {
  readonly [K in keyof T & string as UpperFirst<K>]: `${Prefix}:${UpperFirst<K>}`
} & {
  readonly [K in keyof T & string]: (...args: Parameters<T[K]>) => {
    type: `${Prefix}:${UpperFirst<K>}`
    payload: ReturnType<T[K]>
  }
}

/** State machine definition */
export type MachineConfig = {
  initial: string
  states: Record<string, { on: Record<string, string> }>
}

/** Action source — auto-tagged at dispatch time for logging/debugging */
export type ActionSource = 'UI' | 'Effect' | 'System' | 'Test'

type Msg = { type: string; payload: unknown; _source?: ActionSource }

export type ScopedApp<S = unknown> = {
  dispatch: (action: Msg) => void
  getState: () => S
}

/** Tag a message with a source — non-destructive, returns new object */
export function tagSource(msg: Msg, source: ActionSource): Msg {
  return { ...msg, _source: source }
}

// Internal function signatures stored in FeatureDef
type FeatureReduceFn = (state: unknown, action: Msg, ctx: { A: unknown; E: unknown }) => (Msg | ScheduleEffect)[] | void
type FeatureExecuteFn = (app: ScopedApp, effect: Msg, ctx: { E: unknown; A: unknown }) => void

/** Internal config stored in feature definition */
export type FeatureInternals = {
  state: Record<string, unknown>
  machine: MachineConfig | 'simple'
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
}

/** Feature definition returned by feature() */
export type FeatureDef<
  Name extends string = string,
  // deno-lint-ignore no-explicit-any
  Actions extends Creators = any,
  // deno-lint-ignore no-explicit-any
  Effects extends Creators = any,
> = {
  readonly name: Name
  readonly A: Catalog<Capitalize<Name>, Actions>
  readonly E: Catalog<Capitalize<Name>, Effects>
  readonly selectors: Record<string, (state: unknown) => unknown>
  readonly _config: FeatureInternals
  /** Attach execute separately — for features with server-only imports */
  readonly implement: (fn: FeatureExecuteFn) => void
  /** Bridge-only: request effect creators per channel */
  readonly request?: Record<string, (...args: unknown[]) => Msg>
}

/** Feature entry in aio.run() features array */
export type FeatureEntry = FeatureDef | { feature: FeatureDef; dependsOn?: string[] }

// ── Catalog builder ────────────────────────────────────────────────

function buildCatalog(
  prefix: string,
  creators: Creators,
): { catalog: Record<string, unknown>; typeToKey: Map<string, string> } {
  const catalog: Record<string, unknown> = {}
  const typeToKey = new Map<string, string>()

  for (const key of Object.keys(creators)) {
    const label = `${prefix}:${capitalize(key)}`
    catalog[capitalize(key)] = label                   // A.Increment = 'Counter:Increment'
    catalog[key] = (...args: unknown[]) => ({           // A.increment(5) = { type, payload }
      type: label,
      payload: creators[key](...args) ?? {},
    })
    typeToKey.set(label, key)
  }

  return { catalog, typeToKey }
}

// ── Machine validation ─────────────────────────────────────────────

function validateMachine(
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

  // Validate transitions
  for (const [stateName, stateConfig] of Object.entries(machine.states)) {
    for (const [key, target] of Object.entries(stateConfig.on)) {
      // Target state must exist
      if (!stateNames.has(target)) {
        errors.push(`state '${stateName}' → unknown target '${target}' on '${key}'`)
      }
      // Own action key must be declared (foreign actions contain ':')
      if (!key.includes(':') && !actionKeys.has(key)) {
        errors.push(`state '${stateName}' references unknown action '${key}'`)
      }
    }
  }

  // Reachability: every state must be reachable from initial
  const reachable = new Set<string>([machine.initial])
  let changed = true
  while (changed) {
    changed = false
    for (const [sn, sc] of Object.entries(machine.states)) {
      if (!reachable.has(sn)) continue
      for (const t of Object.values(sc.on)) {
        if (!reachable.has(t)) { reachable.add(t); changed = true }
      }
    }
  }
  for (const sn of stateNames) {
    if (!reachable.has(sn)) {
      errors.push(`state '${sn}' unreachable from '${machine.initial}'`)
    }
  }

  // Dead-end detection: states with no outgoing transitions (can enter but never leave)
  const warnings: string[] = []
  for (const [sn, sc] of Object.entries(machine.states)) {
    const outgoing = Object.keys(sc.on)
    if (outgoing.length === 0) {
      warnings.push(`state '${sn}' is a dead-end (no outgoing transitions)`)
    }
  }

  if (errors.length) {
    throw new Error(`[feature:${name}] machine validation failed:\n  ${errors.join('\n  ')}`)
  }
  if (warnings.length) {
    for (const w of warnings) console.warn(`[feature:${name}] ${w}`)
  }
}

// ── feature() ──────────────────────────────────────────────────────

/** Define a feature — the single API for state, actions, effects, machine, reduce, execute, selectors */
export function feature<
  N extends string,
  S extends Record<string, unknown>,
  A extends Creators,
  E extends Creators = Record<string, never>,
>(name: N, config: {
  state: S
  actions: A
  effects?: E
  machine: MachineConfig | 'simple'
  reduce: (
    state: Draft<S>,
    action: Msg,
    ctx: { A: Catalog<Capitalize<N>, A>; E: Catalog<Capitalize<N>, E> }
  ) => (Msg | ScheduleEffect)[] | void
  execute?: (
    app: ScopedApp<S>,
    effect: Msg,
    ctx: { E: Catalog<Capitalize<N>, E>; A: Catalog<Capitalize<N>, A> }
  ) => void
  selectors?: Record<string, (state: unknown) => unknown>
  /** Allowlist of feature prefixes this executor may dispatch to (e.g. ['wallet', 'fleet']) */
  crossDispatch?: string[]
  /** Custom init handler — called after feature is composed (optional) */
  init?: (app: ScopedApp<S>) => void
  /** Custom destroy handler — called on shutdown (optional) */
  destroy?: (app: ScopedApp<S>) => void
}): FeatureDef<N, A, E> {
  const prefix = capitalize(name)
  const actionKeySet = new Set(Object.keys(config.actions))
  const effectKeyList = Object.keys(config.effects ?? {})

  // Build catalogs
  const { catalog: aCatalog, typeToKey: actionTypeToKey } = buildCatalog(prefix, config.actions)
  const { catalog: eCatalog } = buildCatalog(prefix, config.effects ?? {})

  // Validate machine
  if (config.machine !== 'simple') {
    validateMachine(name, config.machine, actionKeySet)
  }

  // Detect foreign actions from machine (types containing ':' from other features)
  const foreignSet = new Set<string>()
  if (config.machine !== 'simple') {
    for (const sc of Object.values(config.machine.states)) {
      for (const key of Object.keys(sc.on)) {
        if (key.includes(':') && !key.startsWith(prefix + ':')) {
          foreignSet.add(key)
        }
      }
    }
  }
  const foreignActions = [...foreignSet]

  const internals: FeatureInternals = {
    state: config.state,
    machine: config.machine,
    reduce: config.reduce as FeatureReduceFn,
    execute: config.execute as FeatureExecuteFn | undefined,
    actionKeys: [...actionKeySet],
    effectKeys: effectKeyList,
    prefix,
    actionTypeToKey,
    foreignActions,
    initType: `${prefix}:Init`,
    destroyType: `${prefix}:Destroy`,
    crossDispatchPrefixes: new Set((config.crossDispatch ?? []).map(capitalize)),
    onInit: config.init as ((app: ScopedApp) => void) | undefined,
    onDestroy: config.destroy as ((app: ScopedApp) => void) | undefined,
  }

  return {
    name,
    A: aCatalog as Catalog<Capitalize<N>, A>,
    E: eCatalog as Catalog<Capitalize<N>, E>,
    selectors: (config.selectors ?? {}) as Record<string, (state: unknown) => unknown>,
    _config: internals,
    implement(fn: FeatureExecuteFn) { internals.execute = fn },
  }
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
  const features = resolveFeatures(entries)
  let onFeatureDisable: ((prefix: string) => void) | undefined

  // ── Initial state ──
  const initialState: Record<string, unknown> = {}
  for (const f of features) {
    const machine = f._config.machine
    const status = machine === 'simple' ? undefined : machine.initial
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
    const { machine, reduce, actionTypeToKey } = f._config
    const featureName = f.name
    const featureState = fullState[featureName] as Record<string, unknown>

    // Machine guard
    if (machine !== 'simple') {
      const currentStatus = (featureState._status ?? machine.initial) as string
      const stateConfig = machine.states[currentStatus]
      if (!stateConfig) return { state: fullState, effects: [] }

      // Lookup: own action → camelCase key; foreign → full type string
      const ownKey = actionTypeToKey.get(action.type)
      const lookupKey = ownKey ?? action.type

      if (!(lookupKey in stateConfig.on)) {
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

      // Update _status to target state
      const target = stateConfig.on[lookupKey]
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

    return { state: { ...fullState, [featureName]: nextSlice }, effects }
  }

  // ── Feature enable/disable registry ──
  const disabledFeatures = new Set<string>()
  const featureErrors = new Map<string, number>()
  const featureLastAction = new Map<string, { type: string; at: number }>()

  // ── Root reducer ──
  const rootReduce = (state: Record<string, unknown>, action: Msg): ReduceResult => {
    let currentState = state
    const allEffects: (Msg | ScheduleEffect)[] = []

    // Handle lifecycle actions (Init/Destroy) — apply state change, then continue routing
    // so foreign action listeners can react to lifecycle events
    let isLifecycle = false
    for (const f of features) {
      if (action.type === f._config.initType) {
        const machine = f._config.machine
        const status = machine === 'simple' ? undefined : machine.initial
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
          [f.name]: machine === 'simple'
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

    return { state: currentState, effects: allEffects }
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
    const f = executorByPrefix.get(prefix)
    if (!f || !f._config.execute) return
    if (disabledFeatures.has(f.name)) return

    // Scoped dispatch — runtime guard: own actions + crossDispatch allowlist
    const ownPrefix = f._config.prefix + ':'
    const crossPrefixes = f._config.crossDispatchPrefixes
    const scopedApp: ScopedApp = {
      dispatch: (a: Msg) => {
        if (typeof a?.type !== 'string') return
        if (!a.type.startsWith(ownPrefix)) {
          // Check crossDispatch allowlist
          const colonIdx = a.type.indexOf(':')
          const targetPrefix = colonIdx !== -1 ? a.type.slice(0, colonIdx) : ''
          if (!crossPrefixes.has(targetPrefix)) {
            console.error(`[${f.name}] dispatch('${a.type}') blocked — add '${targetPrefix.toLowerCase()}' to crossDispatch`)
            featureErrors.set(f.name, (featureErrors.get(f.name) ?? 0) + 1)
            return
          }
        }
        app.dispatch(tagSource(a, 'Effect'))
      },
      getState: () => (app.getState() as Record<string, unknown>)[f.name] as unknown,
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
      if (f._config.onDestroy) {
        const scopedApp: ScopedApp = {
          dispatch: (a: Msg) => app.dispatch(tagSource(a, 'System')),
          getState: () => (app.getState() as Record<string, unknown>)[f.name] as unknown,
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

// ── bridge() ───────────────────────────────────────────────────────

type BridgeChannelConfig = {
  // deno-lint-ignore no-explicit-any
  request: (...args: any[]) => Record<string, unknown>
  // deno-lint-ignore no-explicit-any
  response: (...args: any[]) => Record<string, unknown>
  timeout?: number   // ms before timeout (default: 5000)
  retries?: number   // max retries (default: 0)
  backoff?: 'linear' | 'exponential'
}

export type BridgeConfig = {
  from: string
  to: string
  channels: Record<string, BridgeChannelConfig>
  circuitBreaker?: {
    failureThreshold: number
    resetTimeout: number
  }
}

/** Creates a bridge feature that handles request/response coordination between features */
export function bridge(name: string, config: BridgeConfig): FeatureDef {
  const channels = Object.keys(config.channels)
  for (const ch of channels) {
    if (!ch) throw new Error(`[bridge:${name}] empty channel name`)
  }

  // Generate action creators
  // deno-lint-ignore no-explicit-any
  const actionCreators: Record<string, (...args: any[]) => Record<string, unknown>> = {}

  // Generate effect creators
  // deno-lint-ignore no-explicit-any
  const effectCreators: Record<string, (...args: any[]) => Record<string, unknown>> = {}

  // Request helpers (exposed on the returned feature as .request)
  const requestCreators: Record<string, (...args: unknown[]) => Msg> = {}

  const prefix = capitalize(name)

  for (const ch of channels) {
    const chConfig = config.channels[ch]

    // Actions
    actionCreators[`${ch}Request`] = (...args: unknown[]) => ({
      ...chConfig.request(...args),
      _correlationId: crypto.randomUUID(),
      _channel: ch,
    })
    actionCreators[`${ch}Response`] = (...args: unknown[]) => ({
      ...chConfig.response(...args),
      _correlationId: '' as string,
      _channel: ch,
    })
    actionCreators[`${ch}Timeout`] = (correlationId: string) => ({
      _correlationId: correlationId,
      _channel: ch,
    })

    // Effects
    effectCreators[`${ch}StartTimer`] = (correlationId: string, timeout: number) => ({
      _correlationId: correlationId,
      _channel: ch,
      timeout,
    })
  }

  // Timer tracking — allows cancellation on feature disable/destroy
  const activeTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // State
  const state: Record<string, unknown> = {
    pending: {} as Record<string, { channel: string; requestedAt: number; retryCount: number }>,
    metrics: { totalRequests: 0, totalResponses: 0, totalTimeouts: 0, totalLatencyMs: 0 },
  }
  if (config.circuitBreaker) {
    state.circuit = { state: 'closed', failures: 0, lastFailureAt: 0 }
  }

  const featureDef = feature(name, {
    state,
    actions: actionCreators,
    effects: effectCreators,
    machine: 'simple',
    destroy() {
      // Cancel all pending timers on bridge destroy/disable
      for (const [id, tid] of activeTimers) {
        clearTimeout(tid)
        activeTimers.delete(id)
      }
    },
    reduce(st, action, { A, E }) {
      const payload = action.payload as Record<string, unknown>
      const channel = payload._channel as string | undefined
      if (!channel) return

      const actionSuffix = action.type.slice(action.type.lastIndexOf(':') + 1)
      const pending = st.pending as Record<string, Record<string, unknown>>
      const metrics = st.metrics as Record<string, number>
      const circuit = st.circuit as { state: string; failures: number; lastFailureAt: number } | undefined
      const cb = config.circuitBreaker

      if (actionSuffix.endsWith('Request')) {
        // Circuit breaker: reject if circuit is open
        if (cb && circuit && circuit.state === 'open') {
          // Check if enough time passed to try half-open
          if (Date.now() - circuit.lastFailureAt >= cb.resetTimeout) {
            circuit.state = 'half-open'
          } else {
            return // rejected by circuit breaker
          }
        }

        const id = payload._correlationId as string
        pending[id] = { channel, requestedAt: Date.now(), retryCount: 0 }
        metrics.totalRequests = (metrics.totalRequests ?? 0) + 1
        const chConfig = config.channels[channel]
        if (chConfig?.timeout) {
          return [{ type: `${prefix}:${capitalize(channel)}StartTimer`, payload: { _correlationId: id, _channel: channel, timeout: chConfig.timeout } }]
        }
      }

      if (actionSuffix.endsWith('Response')) {
        const id = payload._correlationId as string
        if (pending[id]) {
          const req = pending[id]
          const latency = Date.now() - (req.requestedAt as number)
          metrics.totalResponses = (metrics.totalResponses ?? 0) + 1
          metrics.totalLatencyMs = (metrics.totalLatencyMs ?? 0) + latency
          delete pending[id]
          // Circuit breaker: successful response resets circuit
          if (cb && circuit && (circuit.state === 'half-open' || circuit.state === 'open')) {
            circuit.state = 'closed'
            circuit.failures = 0
          }
        }
      }

      if (actionSuffix.endsWith('Timeout')) {
        const id = payload._correlationId as string
        if (pending[id]) {
          const req = pending[id]
          const retryCount = (req.retryCount as number) ?? 0
          const chConfig = config.channels[channel]
          const maxRetries = chConfig?.retries ?? 0

          metrics.totalTimeouts = (metrics.totalTimeouts ?? 0) + 1

          // Circuit breaker: count failure
          if (cb && circuit) {
            circuit.failures += 1
            circuit.lastFailureAt = Date.now()
            if (circuit.failures >= cb.failureThreshold) {
              circuit.state = 'open'
            }
          }

          // Retry logic
          if (retryCount < maxRetries) {
            req.retryCount = retryCount + 1
            req.requestedAt = Date.now()
            if (chConfig?.timeout) {
              return [{ type: `${prefix}:${capitalize(channel)}StartTimer`, payload: { _correlationId: id, _channel: channel, timeout: chConfig.timeout } }]
            }
          } else {
            delete pending[id]
          }
        }
      }
    },
    execute(app, effect) {
      const payload = effect.payload as Record<string, unknown>
      const effectSuffix = effect.type.slice(effect.type.lastIndexOf(':') + 1)

      if (effectSuffix.endsWith('StartTimer')) {
        const id = payload._correlationId as string
        const timeout = payload.timeout as number
        const channel = payload._channel as string

        // Cancel existing timer for this correlation ID (retry case)
        const prev = activeTimers.get(id)
        if (prev) clearTimeout(prev)

        const tid = setTimeout(() => {
          activeTimers.delete(id)
          // Only dispatch timeout if request is still pending (response may have cleared it)
          const bs = app.getState() as Record<string, Record<string, unknown>>
          const pending = bs.pending
          if (!pending?.[id]) return
          const timeoutType = `${prefix}:${capitalize(channel)}Timeout`
          app.dispatch({ type: timeoutType, payload: { _correlationId: id, _channel: channel } })
        }, timeout)
        activeTimers.set(id, tid)
      }

      if (effectSuffix.endsWith('CancelTimer')) {
        const id = payload._correlationId as string
        const tid = activeTimers.get(id)
        if (tid) { clearTimeout(tid); activeTimers.delete(id) }
      }
    },
    selectors: {
      getPendingCount: (s: unknown) =>
        Object.keys(((s as Record<string, Record<string, unknown>>)[name]?.pending ?? {})).length,
      getAverageLatency: (s: unknown) => {
        const m = (s as Record<string, Record<string, Record<string, number>>>)[name]?.metrics
        return m?.totalResponses ? m.totalLatencyMs / m.totalResponses : 0
      },
      isCircuitOpen: (s: unknown) => {
        const c = (s as Record<string, Record<string, { state: string }>>)[name]?.circuit
        return c?.state === 'open'
      },
    },
  })

  // Build request helpers: bridge.request.price('BTC') → effect
  for (const ch of channels) {
    const chConfig = config.channels[ch]
    requestCreators[ch] = (...args: unknown[]) => ({
      type: `${prefix}:${capitalize(ch)}Request`,
      payload: {
        ...chConfig.request(...args),
        _correlationId: crypto.randomUUID(),
        _channel: ch,
      },
    })
  }

  return Object.assign(featureDef, { request: requestCreators })
}

// ── Test harness ───────────────────────────────────────────────────

export type TestContext<S = Record<string, unknown>> = {
  /** Initialize/reset feature to initial state */
  init: () => void
  /** Destroy feature (reset to initial + 'uninitialized' status) */
  destroy: () => void
  /** Typed action senders — one per declared action */
  send: Record<string, (...args: unknown[]) => void>
  /** Assertions */
  expect: {
    /** Assert on feature state slice */
    state: (fn: (s: S) => boolean) => void
    /** Assert current machine status */
    status: (expected: string) => void
    /** Assert effect types returned by last action (short names, e.g. 'Persist') */
    effects: (types: string[]) => void
    /** Assert number of effects returned by last action */
    effectCount: (n: number) => void
    /** Assert a predicate holds for current state */
    invariant: (fn: (s: S) => boolean) => void
  }
  /** Get full feature state including _status */
  getState: () => S & { _status?: string }
  /** Get effects from last dispatched action */
  getEffects: () => (Msg | ScheduleEffect)[]
  /** Dispatch N random valid actions (for property-based testing) */
  randomActions: (n: number) => void
}

/** Test harness for isolated feature testing — wraps Deno.test with typed helpers */
export function testFeature<S extends Record<string, unknown>>(
  f: FeatureDef,
  testName: string,
  fn: (t: TestContext<S>) => void,
): void {
  Deno.test(`[${f.name}] ${testName}`, () => {
    // Compose a single-feature system
    const composed = composeFeatures([f])
    const machine = f._config.machine

    let state = { ...composed.initialState }
    let lastEffects: (Msg | ScheduleEffect)[] = []

    function dispatch(action: Msg): void {
      const result = composed.reduce(state, action)
      state = { ...result.state }
      lastEffects = result.effects
    }

    // Build send proxy from action creators
    const send: Record<string, (...args: unknown[]) => void> = {}
    for (const key of f._config.actionKeys) {
      const creator = (f.A as Record<string, unknown>)[key]
      if (typeof creator === 'function') {
        send[key] = (...args: unknown[]) => dispatch((creator as (...a: unknown[]) => Msg)(...args))
      }
    }

    const ctx: TestContext<S> = {
      init: () => {
        state = { ...composed.initialState }
        lastEffects = []
      },
      destroy: () => {
        const base = machine === 'simple'
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
          const prefix = f._config.prefix + ':'
          const actual = lastEffects.map(e => {
            const t = e.type as string
            return t.startsWith(prefix) ? t.slice(prefix.length) : t
          }).sort()
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
      getState: () => state[f.name] as S & { _status?: string },
      getEffects: () => lastEffects,
      randomActions: (n) => {
        const keys = f._config.actionKeys
        for (let i = 0; i < n; i++) {
          const key = keys[Math.floor(Math.random() * keys.length)]
          try { send[key]() } catch { /* invalid transitions are expected */ }
        }
      },
    }

    fn(ctx)
  })
}

// ── Bridge test harness ──────────────────────────────────────────────

export type BridgeTestContext = {
  /** Send a request on a channel */
  request: Record<string, (...args: unknown[]) => void>
  /** Send a response on a channel */
  respond: Record<string, (...args: unknown[]) => void>
  /** Simulate a timeout on a channel */
  timeout: (channel?: string) => void
  /** Assertions */
  expect: {
    pending: (n: number) => void
    circuitOpen: (expected: boolean) => void
    retryCount: (expected: number) => void
  }
  /** Get bridge state */
  getState: () => Record<string, unknown>
  /** Get effects from last action */
  getEffects: () => (Msg | ScheduleEffect)[]
}

/** Test harness for bridge features — wraps Deno.test with bridge-specific helpers */
export function testBridge(
  b: FeatureDef,
  testName: string,
  fn: (t: BridgeTestContext) => void,
): void {
  Deno.test(`[${b.name}] ${testName}`, () => {
    const composed = composeFeatures([b])
    let state = { ...composed.initialState }
    let lastEffects: (Msg | ScheduleEffect)[] = []
    // Track correlation IDs for timeout simulation
    let lastCorrelationId: string | undefined
    let lastChannel: string | undefined

    function dispatch(action: Msg): void {
      const result = composed.reduce(state, action)
      state = { ...result.state }
      lastEffects = result.effects
    }

    const prefix = b._config.prefix
    const channels = b._config.actionKeys
      .filter(k => k.endsWith('Request'))
      .map(k => k.replace(/Request$/, ''))

    // Build request helpers
    const request: Record<string, (...args: unknown[]) => void> = {}
    for (const ch of channels) {
      request[ch] = (...args: unknown[]) => {
        const action = b.request![ch](...args)
        lastCorrelationId = (action.payload as Record<string, string>)._correlationId
        lastChannel = ch
        dispatch(action)
      }
    }

    // Build respond helpers
    const respond: Record<string, (...args: unknown[]) => void> = {}
    for (const ch of channels) {
      const creator = (b.A as Record<string, unknown>)[`${ch}Response`]
      if (typeof creator === 'function') {
        respond[ch] = (...args: unknown[]) => {
          const action = (creator as (...a: unknown[]) => Msg)(...args)
          // Inject correlation ID from last request
          if (lastCorrelationId) {
            ;(action.payload as Record<string, unknown>)._correlationId = lastCorrelationId
          }
          dispatch(action)
        }
      }
    }

    const ctx: BridgeTestContext = {
      request,
      respond,
      timeout: (channel?: string) => {
        const ch = channel ?? lastChannel
        if (!ch || !lastCorrelationId) throw new Error('no pending request to timeout')
        const timeoutType = `${prefix}:${capitalize(ch)}Timeout`
        dispatch({ type: timeoutType, payload: { _correlationId: lastCorrelationId, _channel: ch } })
      },
      expect: {
        pending: (n: number) => {
          const bs = state[b.name] as Record<string, Record<string, unknown>>
          const count = Object.keys(bs.pending ?? {}).length
          if (count !== n) throw new Error(`expected ${n} pending, got ${count}`)
        },
        circuitOpen: (expected: boolean) => {
          const bs = state[b.name] as Record<string, { state: string }>
          const isOpen = bs.circuit?.state === 'open'
          if (isOpen !== expected) throw new Error(`expected circuit ${expected ? 'open' : 'closed'}, got ${isOpen ? 'open' : bs.circuit?.state ?? 'closed'}`)
        },
        retryCount: (expected: number) => {
          const bs = state[b.name] as Record<string, Record<string, Record<string, unknown>>>
          const pending = bs.pending ?? {}
          const entries = Object.values(pending)
          const total = entries.reduce((sum, e) => sum + ((e.retryCount as number) ?? 0), 0)
          if (total !== expected) throw new Error(`expected retryCount ${expected}, got ${total}`)
        },
      },
      getState: () => state[b.name] as Record<string, unknown>,
      getEffects: () => lastEffects,
    }

    fn(ctx)
  })
}
