import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
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
