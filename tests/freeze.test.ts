import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { deepFreeze } from '../src/dispatch.ts'

Deno.test('deepFreeze: freezes object and nested objects', () => {
  const obj = { a: 1, b: { c: 2 } }
  deepFreeze(obj)
  assertThrows(() => { (obj as { a: number }).a = 2 }, TypeError)
  assertThrows(() => { (obj as { b: { c: number } }).b.c = 3 }, TypeError)
  assertEquals(obj.a, 1)
  assertEquals(obj.b.c, 2)
})

Deno.test('deepFreeze: freezes arrays', () => {
  const obj = { items: [{ id: 1 }, { id: 2 }] }
  deepFreeze(obj)
  assertThrows(() => { (obj.items as unknown[]).push({ id: 3 }) }, TypeError)
  assertThrows(() => { (obj.items[0] as { id: number }).id = 99 }, TypeError)
  assertEquals(obj.items.length, 2)
  assertEquals((obj.items[0] as { id: number }).id, 1)
})

Deno.test('deepFreeze: skips null and primitives', () => {
  const obj = { a: null, b: 'string', c: 123, d: undefined }
  deepFreeze(obj)
  assertEquals(obj.a, null)
  assertEquals(obj.b, 'string')
  assertEquals(obj.c, 123)
  assertEquals(obj.d, undefined)
})

Deno.test('deepFreeze: returns same object', () => {
  const obj = { a: 1 }
  const frozen = deepFreeze(obj)
  assertEquals(frozen, obj)
  assertEquals(Object.isFrozen(frozen), true)
})

Deno.test('deepFreeze: skips already frozen objects', () => {
  const obj = { a: { b: 1 } }
  Object.freeze(obj.a)
  deepFreeze(obj)
  assertEquals(Object.isFrozen(obj), true)
  assertEquals(Object.isFrozen(obj.a), true)
})