// flow.ts — generator-based sequential workflows for features
//
// Write top-to-bottom async code. Each yield point is observable:
// dispatches an action, transitions the machine, appears in time-travel.
//
// flow()     — define a sequential workflow triggered by an action
// FlowCtx   — context passed to generator (call, step, done, fail, put, all, race, sleep)
// runFlow() — internal: advances generator, dispatches actions, mutates state

import { produce, type Draft } from 'immer'

// ── Types ────────────────────────────────────────────────────────────

type Msg = { type: string; payload: unknown; _source?: 'UI' | 'Effect' | 'System' | 'Test' }

type FlowApp = {
  dispatch: (action: Msg) => void
  getState: () => Record<string, unknown>
}

/** Yielded descriptor — internal protocol between generator and runner */
export type FlowStep =
  | { kind: 'call'; name: string; fn: () => unknown | Promise<unknown> }
  | { kind: 'step'; name: string; mutate: (draft: Record<string, unknown>) => void }
  | { kind: 'done'; mutate?: (draft: Record<string, unknown>) => void }
  | { kind: 'fail'; reason: string }
  | { kind: 'put'; action: Msg }
  | { kind: 'all'; entries: FlowStep[] }
  | { kind: 'race'; entries: Record<string, FlowStep> }
  | { kind: 'sleep'; name: string; ms: number }

/** Generator return type for flows */
export type Gen<T = void> = Generator<FlowStep, T, unknown>

/** Context object passed to flow generators */
export type FlowCtx = {
  /** Async call — dispatches action, executes fn, returns result */
  call: <T>(name: string, fn: () => T | Promise<T>) => Gen<Awaited<T>>
  /** State mutation — dispatches action, applies Immer draft update */
  step: (name: string, mutate: (draft: Record<string, unknown>) => void) => Gen<void>
  /** Terminal success — dispatches done action, optional final state update */
  done: (mutate?: (draft: Record<string, unknown>) => void) => Gen<void>
  /** Terminal failure — dispatches fail action with reason */
  fail: (reason: string) => Gen<never>
  /** Dispatch an action (other features can react to it) */
  put: (action: Msg) => Gen<void>
  /** Run multiple calls in parallel, wait for all */
  all: <T extends readonly Gen<unknown>[]>(...gens: T) => Gen<{ [K in keyof T]: T[K] extends Gen<infer R> ? R : never }>
  /** Race multiple calls — first to complete wins, rest are conceptually cancelled */
  race: <T extends Record<string, Gen<unknown>>>(entries: T) => Gen<{ [K in keyof T]?: T[K] extends Gen<infer R> ? R : never }>
  /** Sleep for N ms — dispatches a named action for visibility */
  sleep: (name: string, ms: number) => Gen<void>
}

/** Flow definition — returned by flow(), consumed by feature() */
export type FlowDef = {
  trigger: string
  generator: (ctx: FlowCtx, action: Msg) => Gen<unknown>
  /** Auto-generated action types from yield point names */
  _stepNames: string[]
}

// ── ctx generators (yield descriptors) ───────────────────────────────

function* callGen<T>(name: string, fn: () => T | Promise<T>): Gen<Awaited<T>> {
  return (yield { kind: 'call', name, fn } as FlowStep) as Awaited<T>
}

function* stepGen(name: string, mutate: (draft: Record<string, unknown>) => void): Gen<void> {
  yield { kind: 'step', name, mutate } as FlowStep
}

function* doneGen(mutate?: (draft: Record<string, unknown>) => void): Gen<void> {
  yield { kind: 'done', mutate } as FlowStep
}

function* failGen(reason: string): Gen<never> {
  yield { kind: 'fail', reason } as FlowStep
  // unreachable — runner throws after fail
  throw new Error('flow failed: ' + reason)
}

function* putGen(action: Msg): Gen<void> {
  yield { kind: 'put', action } as FlowStep
}

function* allGen<T extends readonly Gen<unknown>[]>(...gens: T): Gen<{ [K in keyof T]: T[K] extends Gen<infer R> ? R : never }> {
  // Collect all steps from each generator into entries
  const entries: FlowStep[] = []
  for (const g of gens) {
    const first = g.next()
    if (!first.done && first.value) {
      entries.push(first.value)
    }
  }
  return (yield { kind: 'all', entries } as FlowStep) as { [K in keyof T]: T[K] extends Gen<infer R> ? R : never }
}

function* raceGen<T extends Record<string, Gen<unknown>>>(entries: T): Gen<{ [K in keyof T]?: T[K] extends Gen<infer R> ? R : never }> {
  // Extract first step from each generator
  const stepEntries: Record<string, FlowStep> = {}
  for (const [key, gen] of Object.entries(entries)) {
    const first = gen.next()
    if (!first.done && first.value) {
      stepEntries[key] = first.value
    }
  }
  return (yield { kind: 'race', entries: stepEntries } as FlowStep) as { [K in keyof T]?: T[K] extends Gen<infer R> ? R : never }
}

function* sleepGen(name: string, ms: number): Gen<void> {
  yield { kind: 'sleep', name, ms } as FlowStep
}

/** Build a FlowCtx — the context object passed to flow generators */
function buildCtx(): FlowCtx {
  return {
    call: callGen,
    step: stepGen,
    done: doneGen,
    fail: failGen,
    put: putGen,
    all: allGen,
    race: raceGen,
    sleep: sleepGen,
  }
}

// ── flow() — define a flow ───────────────────────────────────────────

/** Define a sequential workflow triggered by an action key */
export function flow(
  trigger: string,
  generator: (ctx: FlowCtx, action: Msg) => Gen<unknown>,
): FlowDef {
  return {
    trigger,
    generator,
    _stepNames: [], // populated at compose time by scanning
  }
}

// ── capitalize helper ────────────────────────────────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ── Flow runner ──────────────────────────────────────────────────────

/** Internal: status for a running flow instance */
type FlowInstance = {
  generator: Gen<unknown>
  featureName: string
  flowName: string
  prefix: string
  aborted: boolean
}

/** Active flow instances per feature — keyed by featureName:flowName */
const activeFlows = new Map<string, FlowInstance>()

/** Cancel a running flow (if any) */
export function cancelFlow(featureName: string, flowName: string): void {
  const key = `${featureName}:${flowName}`
  const instance = activeFlows.get(key)
  if (instance) {
    instance.aborted = true
    try { instance.generator.return(undefined) } catch { /* ignore */ }
    activeFlows.delete(key)
  }
}

/** Cancel all flows for a feature (on disable/destroy) */
export function cancelFeatureFlows(featureName: string): void {
  for (const [key, instance] of activeFlows) {
    if (instance.featureName === featureName) {
      instance.aborted = true
      try { instance.generator.return(undefined) } catch { /* ignore */ }
      activeFlows.delete(key)
    }
  }
}

/** Run a flow — advances generator, dispatches actions at each yield point */
export async function runFlow(
  flowDef: FlowDef,
  flowName: string,
  featureName: string,
  action: Msg,
  app: FlowApp,
): Promise<void> {
  const prefix = capitalize(featureName)
  const flowKey = `${featureName}:${flowName}`

  // Cancel any existing instance of this flow
  cancelFlow(featureName, flowName)

  const ctx = buildCtx()
  const gen = flowDef.generator(ctx, action)

  const instance: FlowInstance = {
    generator: gen,
    featureName,
    flowName,
    prefix,
    aborted: false,
  }
  activeFlows.set(flowKey, instance)

  try {
    let result = gen.next()

    while (!result.done) {
      if (instance.aborted) return

      const step = result.value as FlowStep
      const stepResult = await executeStep(step, instance, app)

      if (instance.aborted) return
      result = gen.next(stepResult)
    }
  } catch (e) {
    if (!instance.aborted) {
      // Dispatch error action
      const errorType = `${prefix}:Flow:Error`
      app.dispatch({
        type: errorType,
        payload: { flow: flowName, error: String(e) },
        _source: 'Effect',
      })
      console.error(`[${featureName}] flow '${flowName}' threw: ${e}`)
    }
  } finally {
    activeFlows.delete(flowKey)
  }
}

/** Execute a single flow step — returns the value to feed back into the generator */
async function executeStep(
  step: FlowStep,
  instance: FlowInstance,
  app: FlowApp,
): Promise<unknown> {
  const { prefix, featureName } = instance
  const flowPrefix = `${prefix}:Flow:`

  switch (step.kind) {
    case 'call': {
      // Dispatch start action
      app.dispatch({
        type: `${flowPrefix}${capitalize(step.name)}`,
        payload: { _flow: instance.flowName, _step: step.name },
        _source: 'Effect',
      })

      // Execute the actual async work
      const result = await step.fn()
      return result
    }

    case 'step': {
      // Dispatch step action
      app.dispatch({
        type: `${flowPrefix}${capitalize(step.name)}`,
        payload: { _flow: instance.flowName, _step: step.name },
        _source: 'Effect',
      })

      // Apply state mutation via Immer
      const fullState = app.getState()
      const featureState = fullState[featureName] as Record<string, unknown>
      const nextSlice = produce(featureState, (draft) => {
        step.mutate(draft as Record<string, unknown>)
      })

      // Dispatch internal state update
      app.dispatch({
        type: `${prefix}:__FlowState`,
        payload: { _slice: nextSlice },
        _source: 'Effect',
      })

      return undefined
    }

    case 'done': {
      // Apply optional final mutation
      if (step.mutate) {
        const fullState = app.getState()
        const featureState = fullState[featureName] as Record<string, unknown>
        const nextSlice = produce(featureState, (draft) => {
          step.mutate!(draft as Record<string, unknown>)
        })

        app.dispatch({
          type: `${prefix}:__FlowState`,
          payload: { _slice: nextSlice },
          _source: 'Effect',
        })
      }

      // Dispatch done action
      app.dispatch({
        type: `${flowPrefix}Done`,
        payload: { _flow: instance.flowName },
        _source: 'Effect',
      })

      return undefined
    }

    case 'fail': {
      // Dispatch fail action
      app.dispatch({
        type: `${flowPrefix}Failed`,
        payload: { _flow: instance.flowName, reason: step.reason },
        _source: 'Effect',
      })

      // Stop the generator
      instance.aborted = true
      return undefined
    }

    case 'put': {
      app.dispatch({ ...step.action, _source: 'Effect' })
      return undefined
    }

    case 'all': {
      // Execute all entries in parallel
      const promises = step.entries.map(entry =>
        executeStep(entry, instance, app)
      )
      return Promise.all(promises)
    }

    case 'race': {
      // Race all entries — first to resolve wins
      const entries = Object.entries(step.entries)
      const result = await Promise.race(
        entries.map(async ([key, entry]) => {
          const value = await executeStep(entry, instance, app)
          return { key, value }
        })
      )
      return { [result.key]: result.value }
    }

    case 'sleep': {
      // Dispatch sleep action for visibility
      app.dispatch({
        type: `${flowPrefix}${capitalize(step.name)}`,
        payload: { _flow: instance.flowName, _step: step.name, ms: step.ms },
        _source: 'Effect',
      })

      await new Promise(resolve => setTimeout(resolve, step.ms))
      return undefined
    }
  }
}

// ── Integration helpers (used by feature.ts) ─────────────────────────

/** Wire flows into a feature's executor — called by composeFeatures */
export function createFlowExecutor(
  featureName: string,
  flows: Record<string, FlowDef>,
  triggerToFlow: Map<string, string>,
): (app: FlowApp, action: Msg) => boolean {
  return (app: FlowApp, action: Msg): boolean => {
    const prefix = capitalize(featureName)

    // Check if this action triggers a flow
    const actionSuffix = action.type.startsWith(prefix + ':')
      ? action.type.slice(prefix.length + 1)
      : null

    if (!actionSuffix) return false

    // camelCase version of the action suffix
    const camelKey = actionSuffix.charAt(0).toLowerCase() + actionSuffix.slice(1)
    const flowName = triggerToFlow.get(camelKey)

    if (!flowName) return false

    const flowDef = flows[flowName]
    if (!flowDef) return false

    // Run flow async — don't block the dispatch loop
    runFlow(flowDef, flowName, featureName, action, app)
      .catch(e => console.error(`[${featureName}] flow '${flowName}' error: ${e}`))

    return true
  }
}

/** Build the __FlowState reducer — handles internal state updates from flows */
export function createFlowReducer(featureName: string) {
  const prefix = capitalize(featureName)
  const flowStateType = `${prefix}:__FlowState`

  return (state: Record<string, unknown>, action: Msg): Record<string, unknown> | null => {
    if (action.type !== flowStateType) return null

    const payload = action.payload as { _slice: Record<string, unknown> }
    return { ...state, [featureName]: payload._slice }
  }
}
