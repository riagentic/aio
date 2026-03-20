import { assertEquals } from '@std/assert'
import { skv } from '../src/skv.ts'

Deno.test('skv: set, get, del cycle', async () => {
  const kv = await Deno.openKv(':memory:')
  const db = skv(kv)

  await db.set('test-key', { hello: 'world' })
  const val = await db.get<{ hello: string }>('test-key')
  assertEquals(val, { hello: 'world' })

  await db.del('test-key')
  const gone = await db.get('test-key')
  assertEquals(gone, null)

  db.close()
})

Deno.test('skv: get returns null for missing key', async () => {
  const kv = await Deno.openKv(':memory:')
  const db = skv(kv)

  const val = await db.get('nonexistent')
  assertEquals(val, null)

  db.close()
})

Deno.test('skv: overwrite existing key', async () => {
  const kv = await Deno.openKv(':memory:')
  const db = skv(kv)

  await db.set('k', 1)
  await db.set('k', 2)
  assertEquals(await db.get<number>('k'), 2)

  db.close()
})

Deno.test('skv: stores complex objects', async () => {
  const kv = await Deno.openKv(':memory:')
  const db = skv(kv)

  const data = { users: [{ name: 'alice' }], count: 99, nested: { deep: true } }
  await db.set('state', data)
  assertEquals(await db.get('state'), data)

  db.close()
})

Deno.test('skv: setMulti stores each key under prefix', async () => {
  const kv = await Deno.openKv(':memory:')
  const db = skv(kv)
  await db.setMulti('state', { count: 42, name: 'alice' })
  const result = await db.getMulti<{ count: number; name: string }>('state')
  assertEquals(result, { count: 42, name: 'alice' })
  db.close()
})

Deno.test('skv: getMulti returns null when nothing stored', async () => {
  const kv = await Deno.openKv(':memory:')
  const db = skv(kv)
  const result = await db.getMulti('missing')
  assertEquals(result, null)
  db.close()
})

Deno.test('skv: setMulti overwrites previous values', async () => {
  const kv = await Deno.openKv(':memory:')
  const db = skv(kv)
  await db.setMulti('s', { a: 1, b: 2 })
  await db.setMulti('s', { a: 10, b: 20 })
  const result = await db.getMulti<{ a: number; b: number }>('s')
  assertEquals(result, { a: 10, b: 20 })
  db.close()
})

Deno.test('skv: setMulti deletes removed keys from prevKeys', async () => {
  const kv = await Deno.openKv(':memory:')
  const db = skv(kv)
  await db.setMulti('s', { a: 1, b: 2, c: 3 })
  // Now set with only a,b — c should be deleted
  await db.setMulti('s', { a: 1, b: 2 }, ['a', 'b', 'c'])
  const result = await db.getMulti<Record<string, number>>('s')
  assertEquals(result, { a: 1, b: 2 })
  db.close()
})

Deno.test('skv: setMulti with empty prevKeys is no-op for deletes', async () => {
  const kv = await Deno.openKv(':memory:')
  const db = skv(kv)
  await db.setMulti('s', { x: 99 })
  assertEquals(await db.getMulti('s'), { x: 99 })
  db.close()
})

Deno.test('skv: stores null and boolean values', async () => {
  const kv = await Deno.openKv(':memory:')
  const db = skv(kv)
  await db.set('n', null)
  assertEquals(await db.get('n'), null)
  await db.set('b', false)
  assertEquals(await db.get<boolean>('b'), false)
  db.close()
})

Deno.test('skv: stores arrays', async () => {
  const kv = await Deno.openKv(':memory:')
  const db = skv(kv)
  await db.set('arr', [1, 2, 3])
  assertEquals(await db.get('arr'), [1, 2, 3])
  db.close()
})

Deno.test('skv: del on missing key is no-op', async () => {
  const kv = await Deno.openKv(':memory:')
  const db = skv(kv)
  await db.del('nonexistent') // should not throw
  db.close()
})
