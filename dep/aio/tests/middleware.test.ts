import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { composeMiddleware } from '../mod.ts'

type Action = { type: string; payload?: unknown }
type State = { count: number }

Deno.test('composeMiddleware: passes action through single function', () => {
  const state: State = { count: 0 }
  const enrich = (a: Action, _s: State): Action => ({ ...a, payload: { enriched: true } })
  const composed = composeMiddleware(enrich)
  
  const result = composed({ type: 'Test' }, state)
  assertEquals(result, { type: 'Test', payload: { enriched: true } })
})

Deno.test('composeMiddleware: composes multiple functions in order', () => {
  const state: State = { count: 0 }
  const addTimestamp = (a: Action, _s: State): Action => ({ ...a, payload: { ts: 123 } })
  const addVersion = (a: Action, _s: State): Action => ({ ...a, payload: { ...a.payload as Record<string, unknown>, version: 1 } })
  const composed = composeMiddleware(addTimestamp, addVersion)
  
  const result = composed({ type: 'Test' }, state)
  assertEquals(result, { type: 'Test', payload: { ts: 123, version: 1 } })
})

Deno.test('composeMiddleware: returns null if any function returns null', () => {
  const state: State = { count: 0 }
  const allow = (a: Action, _s: State): Action => a
  const block = (_a: Action, _s: State): null => null
  const neverCalled = (a: Action, _s: State): Action => {
    throw new Error('should not be called')
  }
  
  const composed = composeMiddleware(allow, block, neverCalled)
  const result = composed({ type: 'Test' }, state)
  assertEquals(result, null)
})

Deno.test('composeMiddleware: early return on null', () => {
  const state: State = { count: 0 }
  let called = false
  const block = (_a: Action, _s: State): null => {
    called = true
    return null
  }
  const neverCalled = (_a: Action, _s: State): Action => {
    throw new Error('should not be called')
  }
  
  const composed = composeMiddleware(block, neverCalled)
  const result = composed({ type: 'Test' }, state)
  assertEquals(result, null)
  assertEquals(called, true)
})

Deno.test('composeMiddleware: can read state for validation', () => {
  const state: State = { count: 10 }
  const validate = (a: Action, s: State): Action | null => {
    if (a.type === 'Increment' && s.count >= 100) return null  // block at limit
    return a
  }
  
  const composed = composeMiddleware(validate)
  assertEquals(composed({ type: 'Increment' }, state), { type: 'Increment' })
  assertEquals(composed({ type: 'Increment' }, { count: 100 }), null)
})

Deno.test('composeMiddleware: empty list returns action unchanged', () => {
  const state: State = { count: 0 }
  const composed = composeMiddleware<State, Action>()
  
  const result = composed({ type: 'Test', payload: { x: 1 } }, state)
  assertEquals(result, { type: 'Test', payload: { x: 1 } })
})