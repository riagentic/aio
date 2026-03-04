// Shared dispatch loop — used by both aio.ts (server) and standalone.ts (Android)
// Re-entrant-safe: effects can call dispatch(), actions are queued and drained in order
import type { ScheduleEffect } from './schedule.ts'

/** Error info passed to onError hook */
export type AioError = {
  source: 'reduce' | 'effect'
  error: unknown
  actionType?: string   // action that caused the reduce error
  effectType?: string   // effect type that threw
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
}

/** Dispatch function with close() to reject further actions */
type DispatchFn<A> = ((action: A) => void) & { close: () => void; errorCount: () => number }

/** Creates a re-entrant-safe dispatch loop that drains queued actions in order */
export function createDispatch<S, A, E>(deps: DispatchDeps<S, A, E>): DispatchFn<A> {
  const { reduce, execute, getState, setState, onDone, log, onError } = deps
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
      try {
        reduced = reduce(getState(), current)
      } catch (e) {
        log.error(`reduce error on ${tag(current)}: ${e}`)
        reportError({ source: 'reduce', error: e, actionType: (current as Record<string, unknown>)?.type as string })
        continue
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
      setState(reduced.state)
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
        try {
          const r = execute(effect)
          // catch rejected promises from async effects
          if (r && typeof (r as Promise<void>).catch === 'function') {
            (r as Promise<void>).catch(e => {
              log.error(`async effect error on ${tag(effect)}: ${e}`)
              reportError({ source: 'effect', error: e, effectType: (effect as Record<string, unknown>)?.type as string })
            })
          }
        } catch (e) {
          log.error(`effect error on ${tag(effect)}: ${e}`)
          reportError({ source: 'effect', error: e, effectType: (effect as Record<string, unknown>)?.type as string })
        }
      }
    }

    dispatching = false
    if (!overflowed) onDone()
  }

  dispatch.close = () => { closed = true }
  dispatch.errorCount = () => errors
  return dispatch as DispatchFn<A>
}
