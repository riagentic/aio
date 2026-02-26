import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { deepMerge } from '../src/aio.ts'

Deno.test('deepMerge: persisted overrides matching types', () => {
  const initial = { count: 0, name: 'default' }
  const persisted = { count: 42, name: 'saved' }
  assertEquals(deepMerge(initial, persisted), { count: 42, name: 'saved' })
})

Deno.test('deepMerge: drops keys removed from schema', () => {
  const initial = { count: 0 }
  const persisted = { count: 5, oldKey: 'stale' }
  assertEquals(deepMerge(initial, persisted), { count: 5 })
})

Deno.test('deepMerge: preserves new schema keys', () => {
  const initial = { count: 0, newField: 'default' }
  const persisted = { count: 5 }
  assertEquals(deepMerge(initial, persisted), { count: 5, newField: 'default' })
})

Deno.test('deepMerge: rejects type mismatch (schema wins)', () => {
  const initial = { count: 0 }
  const persisted = { count: 'not a number' }
  assertEquals(deepMerge(initial, persisted), { count: 0 })
})

Deno.test('deepMerge: merges nested objects recursively', () => {
  const initial = { settings: { theme: 'light', fontSize: 14, newOpt: true } }
  const persisted = { settings: { theme: 'dark', fontSize: 16 } }
  assertEquals(deepMerge(initial, persisted), {
    settings: { theme: 'dark', fontSize: 16, newOpt: true },
  })
})

Deno.test('deepMerge: replaces arrays wholesale', () => {
  const initial = { items: [1, 2, 3] }
  const persisted = { items: [4, 5] }
  assertEquals(deepMerge(initial, persisted), { items: [4, 5] })
})

Deno.test('deepMerge: handles null persisted values with same type', () => {
  const initial = { data: null }
  const persisted = { data: null }
  assertEquals(deepMerge(initial, persisted), { data: null })
})

Deno.test('deepMerge: object→primitive type mismatch keeps initial', () => {
  const initial = { config: { a: 1 } }
  const persisted = { config: 'broken' }
  const result = deepMerge(initial, persisted)
  assertEquals(result, { config: { a: 1 } })
})

Deno.test('deepMerge: empty persisted returns initial', () => {
  const initial = { a: 1, b: 'hello' }
  assertEquals(deepMerge(initial, {}), { a: 1, b: 'hello' })
})
