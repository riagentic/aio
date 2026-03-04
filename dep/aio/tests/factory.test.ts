import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { actions, effects } from '../src/factory.ts'
import type { UnionOf } from '../mod.ts'

const A = actions({
  Increment: (by = 1) => ({ by }),
  SetName: (name: string) => ({ name }),
  FetchUser: (id: number) => ({ id }),
  Reset: () => ({}),
})

type Action = UnionOf<typeof A>

Deno.test('PascalCase labels map to type strings', () => {
  assertEquals(A.Increment, 'Increment')
  assertEquals(A.SetName, 'SetName')
  assertEquals(A.FetchUser, 'FetchUser')
  assertEquals(A.Reset, 'Reset')
})

Deno.test('camelCase creators produce { type, payload }', () => {
  assertEquals(A.increment(5), { type: 'Increment', payload: { by: 5 } })
  assertEquals(A.setName('Ada'), { type: 'SetName', payload: { name: 'Ada' } })
  assertEquals(A.fetchUser(42), { type: 'FetchUser', payload: { id: 42 } })
})

Deno.test('empty payload returns {}', () => {
  assertEquals(A.reset(), { type: 'Reset', payload: {} })
})

Deno.test('default params preserved', () => {
  assertEquals(A.increment(), { type: 'Increment', payload: { by: 1 } })
})

Deno.test('effects() identical to actions()', () => {
  const E = effects({
    Log: (message: string) => ({ message }),
    Notify: () => ({}),
  })
  assertEquals(E.Log, 'Log')
  assertEquals(E.Notify, 'Notify')
  assertEquals(E.log('hello'), { type: 'Log', payload: { message: 'hello' } })
  assertEquals(E.notify(), { type: 'Notify', payload: {} })
})

Deno.test('UnionOf extracts discriminated union with switch narrowing', () => {
  function handle(action: Action): string {
    switch (action.type) {
      case A.Increment: {
        const _by: number = action.payload.by
        return `inc ${_by}`
      }
      case A.SetName: {
        const _name: string = action.payload.name
        return `name ${_name}`
      }
      case A.FetchUser: {
        const _id: number = action.payload.id
        return `user ${_id}`
      }
      case A.Reset:
        return 'reset'
    }
  }
  assertEquals(handle(A.increment(3)), 'inc 3')
  assertEquals(handle(A.setName('Bob')), 'name Bob')
  assertEquals(handle(A.fetchUser(7)), 'user 7')
  assertEquals(handle(A.reset()), 'reset')
})

Deno.test('labels have literal types', () => {
  const _inc: 'Increment' = A.Increment
  const _sn: 'SetName' = A.SetName
  const _fu: 'FetchUser' = A.FetchUser
  const _r: 'Reset' = A.Reset
  assertEquals(_inc, 'Increment')
  assertEquals(_sn, 'SetName')
  assertEquals(_fu, 'FetchUser')
  assertEquals(_r, 'Reset')
})
