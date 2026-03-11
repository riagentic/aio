import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { draft } from '../mod.ts'

Deno.test('draft() produces new state via immer', () => {
  const state = { count: 0, name: 'test' }
  const result = draft(state, d => {
    d.count = 5
    return []
  })
  assertEquals(result.state.count, 5)
  assertEquals(result.state.name, 'test')
  assertEquals(state.count, 0) // original unchanged
})

Deno.test('draft() returns effects from callback', () => {
  const state = { x: 1 }
  const result = draft(state, d => {
    d.x = 2
    return ['log:changed', 'notify:done']
  })
  assertEquals(result.effects, ['log:changed', 'notify:done'])
  assertEquals(result.state.x, 2)
})

Deno.test('draft() with no mutations returns same reference', () => {
  const state = { a: 1, b: 2 }
  const result = draft(state, () => [])
  assertEquals(result.state, state) // immer returns same ref when no changes
  assertEquals(result.effects, [])
})

Deno.test('draft() handles nested objects', () => {
  const state = { user: { name: 'alice', scores: [1, 2, 3] } }
  const result = draft(state, d => {
    d.user.scores.push(4)
    return []
  })
  assertEquals(result.state.user.scores, [1, 2, 3, 4])
  assertEquals(state.user.scores, [1, 2, 3]) // original unchanged
})
