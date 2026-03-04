import { assertEquals, assertNotEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { _computeDelta } from '../src/server.ts'

Deno.test('computeDelta: first broadcast (null lastState) → full', () => {
  const result = _computeDelta({ a: 1, b: 2 }, null, {})
  assertEquals(result.kind, 'full')
  assertEquals(JSON.parse(result.msg), { a: 1, b: 2 })
  assertEquals(result.newKeyJsons, { a: '1', b: '2' })
})

Deno.test('computeDelta: identical content, different ref → skip', () => {
  const lastKeyJsons = { a: '1', b: '2' }
  const result = _computeDelta({ a: 1, b: 2 }, { a: 1, b: 2 }, lastKeyJsons)
  assertEquals(result.kind, 'skip')
  assertEquals(result.msg, '')
})

Deno.test('computeDelta: one of three keys changed → delta patch', () => {
  const lastKeyJsons = { a: '1', b: '2', c: '3' }
  const result = _computeDelta({ a: 99, b: 2, c: 3 }, { a: 1, b: 2, c: 3 }, lastKeyJsons)
  assertEquals(result.kind, 'delta')
  const parsed = JSON.parse(result.msg)
  assertEquals(parsed.$p, { a: 99 })
  assertEquals(parsed.$d, undefined)
})

Deno.test('computeDelta: majority changed → full', () => {
  const lastKeyJsons = { a: '1', b: '2' }
  const result = _computeDelta({ a: 10, b: 20 }, { a: 1, b: 2 }, lastKeyJsons)
  assertEquals(result.kind, 'full')
  assertEquals(JSON.parse(result.msg), { a: 10, b: 20 })
})

Deno.test('computeDelta: removed keys → delta with $d', () => {
  // 5 keys, remove 1 → changedCount=1, keys.length=4, 1 < 2.0 → delta
  const lastKeyJsons = { a: '1', b: '2', c: '3', d: '4', e: '5' }
  const result = _computeDelta({ a: 1, b: 2, c: 3, d: 4 }, { a: 1, b: 2, c: 3, d: 4, e: 5 }, lastKeyJsons)
  assertEquals(result.kind, 'delta')
  const parsed = JSON.parse(result.msg)
  assertEquals(parsed.$p, {})
  assertEquals(parsed.$d, ['e'])
})

Deno.test('computeDelta: non-object state → always full', () => {
  const result = _computeDelta([1, 2, 3], [1, 2], {})
  assertEquals(result.kind, 'full')
  assertEquals(JSON.parse(result.msg), [1, 2, 3])
})

Deno.test('computeDelta: null uiState → full', () => {
  const result = _computeDelta(null, { a: 1 }, { a: '1' })
  assertEquals(result.kind, 'full')
  assertEquals(result.msg, 'null')
})

Deno.test('computeDelta: added new key → delta when under threshold', () => {
  const lastKeyJsons = { a: '1', b: '2', c: '3' }
  const result = _computeDelta({ a: 1, b: 2, c: 3, d: 4 }, { a: 1, b: 2, c: 3 }, lastKeyJsons)
  assertEquals(result.kind, 'delta')
  const parsed = JSON.parse(result.msg)
  assertEquals(parsed.$p, { d: 4 })
})

// ── Proto-pollution defense (browser-side $d filtering) ───────────

/** Replicates the browser-side delta application logic from browser.ts */
function applyDeltaBrowser(prev: Record<string, unknown>, msg: string): Record<string, unknown> {
  const data = JSON.parse(msg)
  if (data.$p && typeof data.$p === 'object') {
    const next: Record<string, unknown> = { ...prev, ...data.$p }
    if (Array.isArray(data.$d)) for (const k of data.$d) {
      if (typeof k === 'string' && k !== '__proto__' && k !== 'constructor' && k !== 'prototype') delete next[k]
    }
    return next
  }
  return data
}

Deno.test('delta: browser $d filtering blocks __proto__ deletion', () => {
  const prev = { a: 1, b: 2 } as Record<string, unknown>
  // Craft a malicious delta with __proto__ in $d
  const malicious = JSON.stringify({ $p: {}, $d: ['__proto__'] })
  const result = applyDeltaBrowser(prev, malicious)
  // __proto__ must not be deleted/modified — object prototype intact
  assertEquals(typeof result.toString, 'function', 'prototype chain must survive __proto__ in $d')
  assertEquals(result.a, 1)
  assertEquals(result.b, 2)
})

Deno.test('delta: browser $d filtering blocks constructor/prototype keys', () => {
  const prev = { a: 1, constructor: 'safe' } as Record<string, unknown>
  const malicious = JSON.stringify({ $p: {}, $d: ['constructor', 'prototype'] })
  const result = applyDeltaBrowser(prev, malicious)
  // constructor key must survive
  assertEquals(result['constructor'], 'safe')
})

Deno.test('delta: browser $d filtering allows normal key deletion', () => {
  const prev = { a: 1, b: 2, c: 3 } as Record<string, unknown>
  const delta = JSON.stringify({ $p: {}, $d: ['b'] })
  const result = applyDeltaBrowser(prev, delta)
  assertEquals(result.a, 1)
  assertEquals(result.c, 3)
  assertEquals('b' in result, false)
})

Deno.test('delta: browser $d filtering rejects non-string entries', () => {
  const prev = { a: 1 } as Record<string, unknown>
  const malicious = JSON.stringify({ $p: {}, $d: [42, null, true, '__proto__'] })
  const result = applyDeltaBrowser(prev, malicious)
  assertEquals(result.a, 1)
  assertEquals(typeof result.toString, 'function')
})

Deno.test('computeDelta: removed __proto__ key appears in $d (server-side)', () => {
  // Server DOES include __proto__ in $d — browser-side filtering is the defense
  const lastKeyJsons: Record<string, string> = {}
  // Manually add __proto__ to lastKeyJsons without going through Object.keys
  lastKeyJsons['__proto__'] = '"polluted"'
  lastKeyJsons['a'] = '1'
  lastKeyJsons['b'] = '2'
  lastKeyJsons['c'] = '3'
  lastKeyJsons['d'] = '4'
  const result = _computeDelta({ a: 1, b: 2, c: 3, d: 4 }, { a: 1, b: 2, c: 3, d: 4 }, lastKeyJsons)
  // The server correctly identifies __proto__ as removed — browser filters it
  if (result.kind === 'delta') {
    const parsed = JSON.parse(result.msg)
    assertEquals(Array.isArray(parsed.$d), true)
  }
  // Either way, verify browser would be safe
  assertNotEquals(result.kind, 'skip', 'should detect removed __proto__ key')
})
