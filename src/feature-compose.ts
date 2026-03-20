// feature-compose.ts — composeFeatures + resolve + registry

import { produce, type Draft } from 'immer'
import type { ScheduleEffect } from './schedule.ts'
import type { FlowDef } from './flow.ts'
import { createFlowReducer, cancelFeatureFlows, runFlow, notifyFlowListeners } from './flow.ts'
import { resolveCall } from './feature-impl.ts'
import type {
  Msg, ScopedApp,
  FeatureDef, FeatureEntry,
} from './feature-types.ts'
import { tagSource } from './feature-types.ts'

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
    const f = '__aio' in entry ? entry as FeatureDef : (entry as { feature: FeatureDef }).feature
    if (seen.has(f.__aio.id)) throw new Error(`duplicate feature name: '${f.__aio.id}'`)
    seen.add(f.__aio.id)
    features.push(f)
    if ('__aio' in entry) {
      deps.set(f.__aio.id, [])
    } else {
      deps.set(f.__aio.id, (entry as { dependsOn?: string[] }).dependsOn ?? [])
    }
  }

  // Validate dependencies exist
  const names = new Set(features.map(f => f.__aio.id))
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
    sorted.push(features.find(f => f.__aio.id === name)!)
  }
  for (const f of features) place(f.__aio.id)

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
    if (f.__aio.state._status !== undefined) {
      console.warn(`[${f.__aio.id}] state._status is reserved for machine status — rename it to avoid conflicts`)
    }
    if (f.__aio.actionKeys.length === 0) {
      console.warn(`[${f.__aio.id}] has no actions — is this intentional?`)
    }
  }

  // ── Initial state ──
  const initialState: Record<string, unknown> = {}
  for (const f of features) {
    const machine = f.__aio.machine
    const status = machine === false ? undefined : machine.initial
    initialState[f.__aio.id] = status != null
      ? { ...f.__aio.state, _status: status }
      : { ...f.__aio.state }
  }

  // ── Action routing ──
  const ownByPrefix = new Map<string, FeatureDef>()
  const listenersByType = new Map<string, FeatureDef[]>()

  for (const f of features) {
    ownByPrefix.set(f.__aio.id, f)
    // Foreign action listeners (detected from machine)
    for (const foreignType of f.__aio.foreignActions) {
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
    const { machine, reduce, actionTypeToKey, flowTriggers } = f.__aio
    const featureName = f.__aio.id
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
        const allowed = Object.keys(transitions).join(', ')
        const msg = `[aio:${featureName}] '${action.type}' blocked — machine is in '${currentStatus}' state (allowed: ${allowed || 'none'})`
        if ((globalThis as Record<string, unknown>).__aioDev) console.warn(msg)
        else console.debug(msg)  // prod: logged (visible with --verbose or in debug.log)
        return { state: fullState, effects: [] } // invalid transition → drop
      }

      // Run reduce with Immer (feature's slice only)
      let effects: (Msg | ScheduleEffect)[] = []
      const nextSlice = produce(featureState, (draft: Draft<Record<string, unknown>>) => {
        const result = reduce(draft, action, { A: f.__aio.actions, E: f.__aio.effects })
        if (Array.isArray(result)) effects = result
      })

      // Clone effects to detach from Immer draft
      if (effects.length) {
        try { effects = structuredClone(effects) } catch { console.warn(`[feature] effects not cloneable — may hold draft refs`) }
      }

      // Inject flow trigger effect if this action starts a flow
      if (flowName) {
        effects.push({
          type: `${f.__aio.id}:__flow`,
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
      const result = reduce(draft, action, { A: f.__aio.actions, E: f.__aio.effects })
      if (Array.isArray(result)) effects = result
    })

    if (effects.length) {
      try { effects = structuredClone(effects) } catch { console.warn(`[feature] effects not cloneable — may hold draft refs`) }
    }

    // Inject flow trigger effect if this action starts a flow
    if (flowName) {
      effects.push({
        type: `${f.__aio.id}:__flow`,
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
    if (f.__aio.flows && Object.keys(f.__aio.flows).length > 0) {
      flowReducers.set(f.__aio.id, createFlowReducer(f.__aio.id))
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
      if (action.type === f.__aio.initType) {
        const machine = f.__aio.machine
        const status = machine === false ? undefined : machine.initial
        // Merge: initial defaults ← existing (KV-restored) data ← _status
        const existing = currentState[f.__aio.id] as Record<string, unknown> | undefined
        const base = { ...f.__aio.state, ...existing }
        currentState = {
          ...currentState,
          [f.__aio.id]: status != null
            ? { ...base, _status: status }
            : base,
        }
        isLifecycle = true
        break
      }
      if (action.type === f.__aio.destroyType) {
        const machine = f.__aio.machine
        currentState = {
          ...currentState,
          [f.__aio.id]: machine === false
            ? { ...f.__aio.state }
            : { ...f.__aio.state, _status: machine.initial },
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
        if (owner && !disabledFeatures.has(owner.__aio.id)) {
          const result = reduceFeature(owner, currentState, action)
          currentState = result.state
          allEffects.push(...result.effects)
          featureLastAction.set(owner.__aio.id, { type: action.type, at: Date.now() })
        }
      }
    }

    // Route to foreign action listeners
    const listeners = listenersByType.get(action.type)
    if (listeners) {
      for (const listener of listeners) {
        if (disabledFeatures.has(listener.__aio.id)) continue
        const result = reduceFeature(listener, currentState, action)
        currentState = result.state
        allEffects.push(...result.effects)
        featureLastAction.set(listener.__aio.id, { type: action.type, at: Date.now() })
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
    if (f.__aio.flows && f.__aio.flowTriggers && Object.keys(f.__aio.flows).length > 0) {
      flowsByPrefix.set(f.__aio.id, {
        featureName: f.__aio.id,
        flows: f.__aio.flows,
        triggers: f.__aio.flowTriggers,
      })
    }
  }

  // ── Root executor ──
  const executorByPrefix = new Map<string, FeatureDef>()
  for (const f of features) {
    if (f.__aio.execute) {
      executorByPrefix.set(f.__aio.id, f)
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
    if (!f || !f.__aio.execute) return
    if (disabledFeatures.has(f.__aio.id)) return

    // Scoped dispatch — runtime guard: own actions + dispatchTo allowlist
    const ownPrefix = f.__aio.id + ':'
    const crossPrefixes = f.__aio.crossDispatchPrefixes
    const featureName = f.__aio.id
    const scopedApp: ScopedApp & { _isDisabled?: () => boolean } = {
      _isDisabled: () => disabledFeatures.has(featureName),
      dispatch: (a: Msg) => {
        if (typeof a?.type !== 'string') return
        if (!a.type.startsWith(ownPrefix)) {
          // Check dispatchTo allowlist
          const colonIdx = a.type.indexOf(':')
          const targetPrefix = colonIdx !== -1 ? a.type.slice(0, colonIdx) : ''
          if (!crossPrefixes.has(targetPrefix)) {
            const msg = `[${f.__aio.id}] cross-dispatch blocked → '${targetPrefix}'. Fix: add dispatchTo: [${targetPrefix}] to ${f.__aio.id}'s feature config. See docs/features.md#cross-feature`
            featureErrors.set(f.__aio.id, (featureErrors.get(f.__aio.id) ?? 0) + 1)
            if ((globalThis as Record<string, unknown>).__aioDev) throw new Error(msg)
            console.error(msg)
            return
          }
        }
        app.dispatch(tagSource(a, 'Effect'))
      },
      getState: () => (app.getState() as Record<string, unknown>)[f.__aio.id] as unknown,
      getFullState: () => app.getState() as Record<string, unknown>,
    }

    try {
      f.__aio.execute(scopedApp, effect, { E: f.__aio.effects, A: f.__aio.actions })
    } catch (e) {
      console.error(`[${f.__aio.id}] executor threw: ${e}`)
      featureErrors.set(f.__aio.id, (featureErrors.get(f.__aio.id) ?? 0) + 1)
    }
  }

  // ── Lifecycle ──
  const initAll = (app: { dispatch: (a: Msg) => void; getState: () => unknown }): void => {
    for (const f of features) {
      app.dispatch(tagSource({ type: f.__aio.initType, payload: {} }, 'System'))
      if (f.__aio.onInit) {
        const scopedApp: ScopedApp = {
          dispatch: (a: Msg) => app.dispatch(tagSource(a, 'System')),
          getState: () => (app.getState() as Record<string, unknown>)[f.__aio.id] as unknown,
          getFullState: () => app.getState() as Record<string, unknown>,
        }
        try { f.__aio.onInit(scopedApp) } catch (e) {
          console.error(`[${f.__aio.id}] init: ${e}`)
          featureErrors.set(f.__aio.id, (featureErrors.get(f.__aio.id) ?? 0) + 1)
        }
      }
    }
  }

  const destroyAll = (app: { dispatch: (a: Msg) => void; getState: () => unknown }): void => {
    for (let i = features.length - 1; i >= 0; i--) {
      const f = features[i]!
      // Cancel any running flows for this feature
      cancelFeatureFlows(f.__aio.id)
      if (f.__aio.onDestroy) {
        const scopedApp: ScopedApp = {
          dispatch: (a: Msg) => app.dispatch(tagSource(a, 'System')),
          getState: () => (app.getState() as Record<string, unknown>)[f.__aio.id] as unknown,
          getFullState: () => app.getState() as Record<string, unknown>,
        }
        try { f.__aio.onDestroy(scopedApp) } catch (e) {
          console.error(`[${f.__aio.id}] destroy: ${e}`)
          featureErrors.set(f.__aio.id, (featureErrors.get(f.__aio.id) ?? 0) + 1)
        }
      }
      app.dispatch(tagSource({ type: f.__aio.destroyType, payload: {} }, 'System'))
    }
  }

  // ── Registry ──
  const registry = {
    enable: (name: string, app: { dispatch: (a: Msg) => void; getState: () => unknown }) => {
      disabledFeatures.delete(name)
      featureErrors.delete(name) // reset error counter on re-enable
      const f = features.find(f => f.__aio.id === name)
      if (f) app.dispatch(tagSource({ type: f.__aio.initType, payload: {} }, 'System'))
    },
    disable: (name: string, dispatch: ((a: Msg) => void) | { dispatch: (a: Msg) => void }) => {
      disabledFeatures.add(name)
      const f = features.find(f => f.__aio.id === name)
      const doDispatch = typeof dispatch === 'function' ? dispatch : dispatch.dispatch
      if (f) {
        cancelFeatureFlows(f.__aio.id)
        doDispatch(tagSource({ type: f.__aio.destroyType, payload: {} }, 'System'))
        // Notify host to cancel schedules for this feature
        if (onFeatureDisable) onFeatureDisable(f.__aio.id)
      }
    },
    isEnabled: (name: string) => !disabledFeatures.has(name),
    status: (name: string, state: Record<string, unknown>): string | undefined => {
      const fs = state[name] as Record<string, unknown> | undefined
      return fs?._status as string | undefined
    },
    health: (state: Record<string, unknown>): FeatureStatus[] => {
      return features.map(f => {
        const fs = state[f.__aio.id] as Record<string, unknown> | undefined
        const last = featureLastAction.get(f.__aio.id)
        return {
          name: f.__aio.id,
          status: fs?._status as string | undefined,
          enabled: !disabledFeatures.has(f.__aio.id),
          errors: featureErrors.get(f.__aio.id) ?? 0,
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
    featureNames: features.map(f => f.__aio.id),
    initAll,
    destroyAll,
    registry,
  }
}
