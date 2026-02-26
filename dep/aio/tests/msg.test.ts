import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { msg } from '../mod.ts'

Deno.test('msg() without payload creates empty payload', () => {
  const m = msg('CLICK')
  assertEquals(m, { type: 'CLICK', payload: {} })
})

Deno.test('msg() with payload passes it through', () => {
  const m = msg('SET', { value: 42 })
  assertEquals(m, { type: 'SET', payload: { value: 42 } })
})

Deno.test('msg() preserves literal type', () => {
  const m = msg('HELLO' as const)
  const _check: 'HELLO' = m.type  // compile-time check
  assertEquals(m.type, 'HELLO')
})
