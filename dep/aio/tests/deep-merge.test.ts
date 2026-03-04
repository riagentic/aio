import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { deepMerge } from '../src/deep-merge.ts'

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

Deno.test('deepMerge: persisted null cannot wipe schema object', () => {
  const initial = { config: { theme: 'light', size: 14 } }
  const persisted = { config: null }
  assertEquals(deepMerge(initial, persisted), { config: { theme: 'light', size: 14 } })
})

Deno.test('deepMerge: null initial accepts persisted value', () => {
  const initial = { data: null }
  const persisted = { data: { loaded: true } }
  assertEquals(deepMerge(initial, persisted), { data: { loaded: true } })
})

Deno.test('deepMerge: empty persisted returns initial', () => {
  const initial = { a: 1, b: 'hello' }
  assertEquals(deepMerge(initial, {}), { a: 1, b: 'hello' })
})

Deno.test('deepMerge: blocks __proto__ pollution', () => {
  const initial = { safe: 'yes' }
  const persisted = JSON.parse('{"safe": "yes", "__proto__": {"polluted": true}}')
  const result = deepMerge(initial, persisted)
  assertEquals(result, { safe: 'yes' })
  assertEquals(({} as Record<string, unknown>).polluted, undefined)
})

Deno.test('deepMerge: blocks constructor/prototype keys', () => {
  const initial = { a: 1 }
  const persisted = { a: 2, constructor: 'evil', prototype: 'bad' }
  assertEquals(deepMerge(initial, persisted), { a: 2 })
})

Deno.test('deepMerge: depth limit prevents stack overflow', () => {
  // Build a deeply nested structure (40 levels, limit is 32)
  let initial: Record<string, unknown> = { value: 'init' }
  let persisted: Record<string, unknown> = { value: 'saved' }
  for (let i = 0; i < 40; i++) {
    initial = { nested: initial }
    persisted = { nested: persisted }
  }
  // Should not throw — returns initial at depth limit
  const result = deepMerge(initial, persisted)
  assertEquals(typeof result, 'object')
  // At depth 32, merging stops and initial is returned — so deep values stay as initial
  let node: Record<string, unknown> = result
  for (let i = 0; i < 32; i++) node = node.nested as Record<string, unknown>
  assertEquals(node.nested !== undefined, true) // still has nested structure (initial returned)
})
