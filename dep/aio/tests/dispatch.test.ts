import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { createDispatch } from '../src/dispatch.ts'

const noop = { debug: () => {}, warn: () => {}, error: () => {} }

Deno.test('dispatch: basic action → reduce → effect', () => {
  let state = { count: 0 }
  const effects: string[] = []

  const dispatch = createDispatch<typeof state, { type: string; payload: { by: number } }, { type: string }>({
    reduce: (s, a) => ({ state: { count: s.count + a.payload.by }, effects: [{ type: 'LOG' }] }),
    execute: (e) => { effects.push(e.type) },
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => {},
    log: noop, debug: false,
  })

  dispatch({ type: 'INC', payload: { by: 5 } })
  assertEquals(state.count, 5)
  assertEquals(effects, ['LOG'])
})

Deno.test('dispatch: re-entrant — effects can dispatch follow-up actions', () => {
  let state = { count: 0 }
  let dispatchRef: ((a: { type: string }) => void) | null = null

  const dispatch = createDispatch<typeof state, { type: string }, { type: string }>({
    reduce: (s, a) => {
      if (a.type === 'DOUBLE') return { state: { count: s.count + 1 }, effects: [{ type: 'AGAIN' }] }
      if (a.type === 'SINGLE') return { state: { count: s.count + 10 }, effects: [] }
      return { state: s, effects: [] }
    },
    execute: (e) => {
      if (e.type === 'AGAIN') dispatchRef!({ type: 'SINGLE' })
    },
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => {},
    log: noop, debug: false,
  })

  dispatchRef = dispatch
  dispatch({ type: 'DOUBLE' })
  assertEquals(state.count, 11) // 1 from DOUBLE + 10 from SINGLE
})

Deno.test('dispatch: overflow guard prevents infinite loop', () => {
  let state = { n: 0 }
  let errMsg = ''
  let dispatchRef: ((a: { type: string }) => void) | null = null

  const dispatch = createDispatch<typeof state, { type: string }, { type: string }>({
    reduce: (s) => ({ state: { n: s.n + 1 }, effects: [{ type: 'LOOP' }] }),
    execute: () => { dispatchRef!({ type: 'LOOP' }) },
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => {},
    log: { ...noop, error: (m) => { errMsg = m } },
    debug: false,
  })

  dispatchRef = dispatch
  dispatch({ type: 'LOOP' })
  assertEquals(errMsg.includes('overflow'), true)
})

Deno.test('dispatch: close() prevents further dispatching', () => {
  let state = { n: 0 }
  let warned = false

  const dispatch = createDispatch<typeof state, { type: string }, never>({
    reduce: (s) => ({ state: { n: s.n + 1 }, effects: [] }),
    execute: () => {},
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => {},
    log: { ...noop, warn: () => { warned = true } },
    debug: false,
  })

  dispatch({ type: 'A' })
  assertEquals(state.n, 1)

  dispatch.close()
  dispatch({ type: 'B' })
  assertEquals(state.n, 1) // unchanged
  assertEquals(warned, true)
})

Deno.test('dispatch: bad reducer output is logged and skipped', () => {
  let state = { n: 0 }
  let errMsg = ''

  const dispatch = createDispatch<typeof state, { type: string }, never>({
    reduce: (s, a) => {
      if (a.type === 'BAD') return 'not an object' as unknown as { state: typeof state; effects: never[] }
      return { state: { n: s.n + 1 }, effects: [] }
    },
    execute: () => {},
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => {},
    log: { ...noop, error: (m) => { errMsg = m } },
    debug: false,
  })

  dispatch({ type: 'BAD' })
  assertEquals(state.n, 0) // state unchanged
  assertEquals(errMsg.includes('reduce() must return'), true)

  // Valid action still works after bad one
  dispatch({ type: 'GOOD' })
  assertEquals(state.n, 1)
})

Deno.test('dispatch: reducer throw is caught and skipped', () => {
  let state = { n: 0 }
  let errMsg = ''

  const dispatch = createDispatch<typeof state, { type: string }, never>({
    reduce: (s, a) => {
      if (a.type === 'THROW') throw new Error('kaboom')
      return { state: { n: s.n + 1 }, effects: [] }
    },
    execute: () => {},
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => {},
    log: { ...noop, error: (m) => { errMsg = m } },
    debug: false,
  })

  dispatch({ type: 'THROW' })
  assertEquals(state.n, 0)
  assertEquals(errMsg.includes('reduce error'), true)

  dispatch({ type: 'OK' })
  assertEquals(state.n, 1)
})

Deno.test('dispatch: invalid effects (missing .type) are skipped', () => {
  let state = { n: 0 }
  const executed: string[] = []
  let warned = false

  const dispatch = createDispatch<typeof state, { type: string }, { type: string }>({
    reduce: (s) => ({
      state: { n: s.n + 1 },
      effects: [{ type: 'VALID' }, { noType: true } as unknown as { type: string }, null as unknown as { type: string }],
    }),
    execute: (e) => { executed.push(e.type) },
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => {},
    log: { ...noop, warn: () => { warned = true } },
    debug: false,
  })

  dispatch({ type: 'X' })
  assertEquals(state.n, 1)
  assertEquals(executed, ['VALID']) // only valid effect executed
  assertEquals(warned, true)
})

Deno.test('dispatch: effect throw is caught, other effects still run', () => {
  let state = { n: 0 }
  const executed: string[] = []
  let errMsg = ''

  const dispatch = createDispatch<typeof state, { type: string }, { type: string }>({
    reduce: (s) => ({
      state: { n: s.n + 1 },
      effects: [{ type: 'FIRST' }, { type: 'BOOM' }, { type: 'THIRD' }],
    }),
    execute: (e) => {
      if (e.type === 'BOOM') throw new Error('effect error')
      executed.push(e.type)
    },
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => {},
    log: { ...noop, error: (m) => { errMsg = m } },
    debug: false,
  })

  dispatch({ type: 'X' })
  assertEquals(executed, ['FIRST', 'THIRD'])
  assertEquals(errMsg.includes('effect error'), true)
})

Deno.test('dispatch: onDone called once after queue fully drains', () => {
  let state = { n: 0 }
  let doneCalls = 0
  let dispatchRef: ((a: { type: string }) => void) | null = null

  const dispatch = createDispatch<typeof state, { type: string }, { type: string }>({
    reduce: (s, a) => {
      if (a.type === 'FIRST') return { state: { n: s.n + 1 }, effects: [{ type: 'CHAIN' }] }
      return { state: { n: s.n + 10 }, effects: [] }
    },
    execute: (e) => {
      if (e.type === 'CHAIN') dispatchRef!({ type: 'SECOND' })
    },
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => { doneCalls++ },
    log: noop, debug: false,
  })

  dispatchRef = dispatch
  dispatch({ type: 'FIRST' })
  assertEquals(state.n, 11)
  assertEquals(doneCalls, 1) // called once, not per action
})
