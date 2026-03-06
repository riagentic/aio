// Shared dispatch loop — used by both aio.ts (server) and standalone.ts (Android)
// Re-entrant-safe: effects can call dispatch(), actions are queued and drained in order
import type { ScheduleEffect } from './schedule.ts'

/** Performance mode — strict reports errors, soft only warns */
export type PerfMode = 'strict' | 'soft'

/** Performance budgets in milliseconds */
export type PerfBudget = {
  reduce?: number    // default: 100 — "feels instant" threshold
  effect?: number    // default: 5 — sync portion only, async by definition doesn't block
}

/** Per-action performance timing */
export type PerfTiming = {
  actionType: string
  reduce: number
  effects: number
  budget: { reduce: number; effect: number }
}

/** Default budgets */
const DEFAULT_REDUCE_BUDGET = 100
const DEFAULT_EFFECT_BUDGET = 5

/** Deep freeze for dev mode immutability checking */
export function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj
  if (Object.isFrozen(obj)) return obj
  Object.freeze(obj)
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    const val = (obj as Record<string, unknown>)[key]
    if (val !== null && typeof val === 'object') deepFreeze(val)
  }
  return obj
}

/** Error info passed to onError hook */
export type AioError = {
  source: 'reduce' | 'effect' | 'performance'
  error?: unknown
  actionType?: string   // action that caused the reduce/perf error
  effectType?: string   // effect type that threw or was slow
  duration?: number     // actual duration in ms (performance errors)
  budget?: number       // budget violated in ms (performance errors)
  message?: string      // human-readable message
}

/** Safety limit — prevents infinite effect→dispatch loops */
const DISPATCH_MAX = 1000

/** Dependencies injected into the dispatch loop by the host runtime */
export type DispatchDeps<S, A, E> = {
  reduce: (state: S, action: A) => { state: S; effects: (E | ScheduleEffect)[] }
  execute: (effect: E | ScheduleEffect) => void | Promise<void>
  getState: () => S
  setState: (s: S) => void
  onDone: () => void  // called once after queue fully drains (persist + broadcast)
  log: {
    debug: (msg: string) => void
    warn: (msg: string) => void
    error: (msg: string) => void
  }
  debug: boolean
  onError?: (err: AioError) => void
  onPerf?: (timing: PerfTiming) => void  // called after each action with timing
  perfMode?: PerfMode
  perfBudget?: PerfBudget
  freezeState?: boolean  // deep freeze state after reduce in dev mode
  effectTimeout?: number  // ms before warning on a slow async effect (default: 30000, 0 = disabled)
}

/** Dispatch function with close() to reject further actions */
type DispatchFn<A> = ((action: A) => void) & { close: () => void; errorCount: () => number }

/** Creates a re-entrant-safe dispatch loop that drains queued actions in order */
export function createDispatch<S, A, E>(deps: DispatchDeps<S, A, E>): DispatchFn<A> {
  const { reduce, execute, getState, setState, onDone, log, onError, onPerf, perfMode, perfBudget, freezeState } = deps
  const effectTimeout = deps.effectTimeout ?? 30_000  // 0 = disabled
  const strictPerf = perfMode !== 'soft'  // default: strict
  const reduceBudget = perfBudget?.reduce ?? DEFAULT_REDUCE_BUDGET
  const effectBudget = perfBudget?.effect ?? DEFAULT_EFFECT_BUDGET
  let dispatching = false
  let closed = false
  let errors = 0
  const queue: A[] = []

  function tag(v: unknown): string {
    const o = v as Record<string, unknown>
    return `${o?.type ?? '?'} ${JSON.stringify(o?.payload ?? {})}`
  }

  function reportError(err: AioError): void {
    errors++
    if (onError) try { onError(err) } catch (e) { log.error(`onError hook threw: ${e}`) }
  }

  function reportPerf(source: 'reduce' | 'effect', duration: number, budget: number, type?: string): void {
    const typeLabel = type ? ` (${type})` : ''
    const msg = `${source} exceeded budget: ${duration}ms > ${budget}ms${typeLabel}`
    
    if (strictPerf) {
      log.error(msg)
      reportError({ source: 'performance', duration, budget, actionType: source === 'reduce' ? type : undefined, effectType: source === 'effect' ? type : undefined, message: msg })
    } else {
      log.warn(msg)
    }
  }

  function dispatch(action: A): void {
    if (closed) { log.warn('dispatch after close() — ignored'); return }
    queue.push(action)
    if (dispatching) return
    dispatching = true

    let iterations = 0
    let overflowed = false
    while (queue.length > 0) {
      if (++iterations > DISPATCH_MAX) {
        log.error(`dispatch queue overflow (${DISPATCH_MAX} iterations) — possible infinite loop (next: ${tag(queue[0])}), flushing queue`)
        queue.length = 0
        overflowed = true
        break
      }
      const current = queue.shift()!
      if (deps.debug) log.debug(`action → reduce: ${tag(current)}`)

      let reduced: { state: S; effects: (E | ScheduleEffect)[] }
      const actionType = (current as Record<string, unknown>)?.type as string | undefined
      
      // Measure reduce time
      const reduceStart = performance.now()
      try {
        reduced = reduce(getState(), current)
      } catch (e) {
        log.error(`reduce error on ${tag(current)}: ${e}`)
        reportError({ source: 'reduce', error: e, actionType })
        continue
      }
      const reduceDuration = performance.now() - reduceStart
      
      // Track total effect time for this action
      let totalEffectDuration = 0
      
      // Check reduce performance budget
      if (reduceDuration > reduceBudget) {
        reportPerf('reduce', reduceDuration, reduceBudget, actionType)
      }

      if (!reduced || typeof reduced !== 'object' || !('state' in reduced) || !Array.isArray(reduced.effects)) {
        log.error(`reduce() must return { state, effects[] } — got ${JSON.stringify(reduced)} for action ${tag(current)}`)
        continue
      }

      // Deep-clone effects to detach from Immer draft references.
      // Without this, effects created inside produce() hold revoked draft refs
      // that crash on JSON.stringify or property access after produce() finalizes.
      if (reduced.effects.length) {
        try { reduced = { ...reduced, effects: structuredClone(reduced.effects) } }
        catch { /* effects not cloneable — use originals */ }
      }

      const prev = getState()
      const nextState = freezeState ? deepFreeze(reduced.state) : reduced.state
      setState(nextState)
      if (deps.debug && prev !== reduced.state && typeof reduced.state === 'object' && reduced.state && typeof prev === 'object' && prev) {
        const changed = Object.keys(reduced.state as Record<string, unknown>).filter(k =>
          (reduced.state as Record<string, unknown>)[k] !== (prev as Record<string, unknown>)[k]
        )
        if (changed.length) log.debug(`state: changed [${changed.join(', ')}]`)
      }

      for (const effect of reduced.effects) {
        if (!effect || typeof (effect as Record<string, unknown>).type !== 'string') {
          log.warn(`reducer returned invalid effect (missing .type string) — skipping. Action was: ${tag(current)}`)
          continue
        }
        if (deps.debug) log.debug(`effect → execute: ${tag(effect)}`)
        
        const effectType = (effect as Record<string, unknown>)?.type as string | undefined
        const effectStart = performance.now()
        
        try {
          const r = execute(effect)
          const effectDuration = performance.now() - effectStart
          totalEffectDuration += effectDuration
          
          // Check effect performance budget (sync portion only)
          // Async effects return promises immediately — we measure sync time
          if (effectDuration > effectBudget) {
            reportPerf('effect', effectDuration, effectBudget, effectType)
          }
          
          // catch rejected promises from async effects + optional timeout warning
          if (r && typeof (r as Promise<void>).catch === 'function') {
            const promise = r as Promise<void>
            // Timeout: warn if async effect takes longer than effectTimeout ms
            const tid = effectTimeout > 0
              ? setTimeout(() => {
                  const msg = `async effect timeout: ${effectType ?? '?'} took >${effectTimeout}ms`
                  log.warn(msg)
                  reportError({ source: 'effect', effectType, message: msg })
                }, effectTimeout)
              : null
            promise
              .then(() => { if (tid !== null) clearTimeout(tid) })
              .catch(e => {
                if (tid !== null) clearTimeout(tid)
                log.error(`async effect error on ${tag(effect)}: ${e}`)
                reportError({ source: 'effect', error: e, effectType })
              })
          }
        } catch (e) {
          log.error(`effect error on ${tag(effect)}: ${e}`)
          reportError({ source: 'effect', error: e, effectType })
        }
      }
      
      // Report per-action performance timing
      if (onPerf && actionType) {
        onPerf({
          actionType,
          reduce: reduceDuration,
          effects: totalEffectDuration,
          budget: { reduce: reduceBudget, effect: effectBudget },
        })
      }
    }

    dispatching = false
    if (!overflowed) onDone()
  }

  dispatch.close = () => { closed = true }
  dispatch.errorCount = () => errors
  return dispatch as DispatchFn<A>
}
