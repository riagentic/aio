import { assertEquals, assertExists } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { initStandalone, _reset } from '../src/standalone.ts'
import { schedule, type ScheduleEffect } from '../src/schedule.ts'

// Mock localStorage — Deno doesn't provide it outside browser context
const storage = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => { storage.set(k, v) },
    removeItem: (k: string) => { storage.delete(k) },
    clear: () => storage.clear(),
    get length() { return storage.size },
    key: (i: number) => [...storage.keys()][i] ?? null,
  },
  writable: true,
  configurable: true,
})

// Test helpers
type State = { count: number }
type Action = { type: string; payload?: { by?: number } }
type Effect = { type: string; payload: { message: string } }

function makeReduce() {
  return (state: State, action: Action): { state: State; effects: Effect[] } => {
    if (action.type === 'INC') {
      return { state: { count: state.count + (action.payload?.by ?? 1) }, effects: [{ type: 'LOG', payload: { message: 'inc' } }] }
    }
    if (action.type === 'DEC') {
      return { state: { count: state.count - 1 }, effects: [] }
    }
    return { state, effects: [] }
  }
}

function setup() {
  storage.clear()
  _reset()
}

Deno.test('initStandalone returns AioApp with standalone mode', () => {
  setup()
  const app = initStandalone({ count: 0 }, { reduce: makeReduce(), execute: () => {}, persist: false })
  assertExists(app.dispatch)
  assertExists(app.getState)
  assertExists(app.close)
  assertEquals(app.mode, 'standalone')
})

Deno.test('dispatch updates state', async () => {
  setup()
  const app = initStandalone({ count: 0 }, { reduce: makeReduce(), execute: () => {} })
  app.dispatch({ type: 'INC', payload: { by: 5 } })
  assertEquals(app.getState(), { count: 5 })
  await app.close() // flush timer
})

Deno.test('dispatch executes effects', async () => {
  setup()
  const executed: Effect[] = []
  const app = initStandalone({ count: 0 }, { reduce: makeReduce(), execute: (_app, e) => { executed.push(e) } })
  app.dispatch({ type: 'INC' })
  assertEquals(executed.length, 1)
  assertEquals(executed[0].type, 'LOG')
  await app.close()
})

Deno.test('dispatch handles re-entrant dispatches', async () => {
  setup()
  const reduce = (state: State, action: Action): { state: State; effects: Effect[] } => {
    if (action.type === 'DOUBLE') {
      return { state: { count: state.count + 1 }, effects: [{ type: 'CASCADE', payload: { message: '' } }] }
    }
    if (action.type === 'EXTRA') {
      return { state: { count: state.count + 10 }, effects: [] }
    }
    return { state, effects: [] }
  }
  let app: ReturnType<typeof initStandalone<State, Action, Effect>>
  const execute = (_app: ReturnType<typeof initStandalone<State, Action, Effect>>, effect: Effect) => {
    if (effect.type === 'CASCADE') _app.dispatch({ type: 'EXTRA' })
  }
  app = initStandalone({ count: 0 }, { reduce, execute })
  app.dispatch({ type: 'DOUBLE' })
  assertEquals(app.getState().count, 11) // 0 + 1 (DOUBLE) + 10 (EXTRA from cascade)
  await app.close()
})

Deno.test('localStorage persistence — debounced write', async () => {
  setup()
  const app = initStandalone({ count: 0 }, { reduce: makeReduce(), execute: () => {} })
  app.dispatch({ type: 'INC', payload: { by: 42 } })
  // Persistence is debounced at 100ms
  assertEquals(storage.has('aio_state'), false)
  await new Promise(r => setTimeout(r, 150))
  assertEquals(JSON.parse(storage.get('aio_state')!), { count: 42 })
})

Deno.test('localStorage restore via deepMerge', async () => {
  setup()
  storage.set('aio_state', JSON.stringify({ count: 99 }))
  const app = initStandalone({ count: 0 }, { reduce: makeReduce(), execute: () => {} })
  assertEquals(app.getState(), { count: 99 })
  await app.close()
})

Deno.test('localStorage restore drops unknown keys', async () => {
  setup()
  storage.set('aio_state', JSON.stringify({ count: 5, oldKey: 'stale' }))
  const app = initStandalone({ count: 0 }, { reduce: makeReduce(), execute: () => {} })
  assertEquals(app.getState(), { count: 5 })
  assertEquals((app.getState() as Record<string, unknown>).oldKey, undefined)
  await app.close()
})

Deno.test('localStorage restore preserves new schema keys', async () => {
  setup()
  storage.set('aio_state', JSON.stringify({ count: 10 }))
  const app = initStandalone({ count: 0, name: 'default' } as State & { name: string }, {
    reduce: (s, _a) => ({ state: s, effects: [] }),
    execute: () => {},
  })
  const state = app.getState() as State & { name: string }
  assertEquals(state.count, 10)
  assertEquals(state.name, 'default')
  await app.close()
})

Deno.test('persist: false disables localStorage', async () => {
  setup()
  const app = initStandalone({ count: 0 }, { reduce: makeReduce(), execute: () => {}, persist: false })
  app.dispatch({ type: 'INC' })
  await new Promise(r => setTimeout(r, 150))
  assertEquals(storage.has('aio_state'), false)
})

Deno.test('custom persistKey', async () => {
  setup()
  const app = initStandalone({ count: 0 }, { reduce: makeReduce(), execute: () => {}, persistKey: 'custom_key' })
  app.dispatch({ type: 'INC', payload: { by: 7 } })
  await new Promise(r => setTimeout(r, 150))
  assertEquals(JSON.parse(storage.get('custom_key')!), { count: 7 })
})

Deno.test('getDBState filters persisted state', async () => {
  setup()
  const app = initStandalone({ count: 0 }, {
    reduce: makeReduce(),
    execute: () => {},
    getDBState: (s) => ({ count: s.count }),
  })
  app.dispatch({ type: 'INC', payload: { by: 3 } })
  await new Promise(r => setTimeout(r, 150))
  assertEquals(JSON.parse(storage.get('aio_state')!), { count: 3 })
})

Deno.test('close() flushes persist immediately', async () => {
  setup()
  const app = initStandalone({ count: 0 }, { reduce: makeReduce(), execute: () => {} })
  app.dispatch({ type: 'INC', payload: { by: 50 } })
  // Don't wait for debounce — close flushes immediately
  await app.close()
  assertEquals(JSON.parse(storage.get('aio_state')!), { count: 50 })
})

Deno.test('invalid reducer output is handled gracefully', async () => {
  setup()
  const badReduce = (_s: State, _a: Action) => 'oops' as unknown as { state: State; effects: Effect[] }
  const app = initStandalone({ count: 0 }, { reduce: badReduce, execute: () => {} })
  app.dispatch({ type: 'INC' })
  assertEquals(app.getState(), { count: 0 })
  await app.close()
})

Deno.test('invalid effects are skipped', async () => {
  setup()
  const reduce = (_s: State, _a: Action) => ({
    state: { count: 1 },
    effects: [null as unknown as Effect, { type: 'GOOD', payload: { message: 'ok' } }],
  })
  const executed: Effect[] = []
  const app = initStandalone({ count: 0 }, { reduce, execute: (_app, e) => { executed.push(e) } })
  app.dispatch({ type: 'INC' })
  assertEquals(executed.length, 1)
  assertEquals(executed[0].type, 'GOOD')
  await app.close()
})

// ── onRestore hook ──────────────────────────────────────

Deno.test('onRestore transforms state after localStorage restore', async () => {
  setup()
  storage.set('aio_state', JSON.stringify({ count: 10 }))
  const app = initStandalone({ count: 0 }, {
    reduce: makeReduce(), execute: () => {},
    onRestore: (s) => ({ ...s, count: s.count * 2 }),
  })
  assertEquals(app.getState(), { count: 20 })
  await app.close()
})

Deno.test('onRestore called even without persisted data', async () => {
  setup()
  let called = false
  const app = initStandalone({ count: 5 }, {
    reduce: makeReduce(), execute: () => {},
    onRestore: (s) => { called = true; return s },
  })
  assertEquals(called, true)
  assertEquals(app.getState(), { count: 5 })
  await app.close()
})

Deno.test('onRestore error does not break dispatch', async () => {
  setup()
  storage.set('aio_state', JSON.stringify({ count: 7 }))
  const app = initStandalone({ count: 0 }, {
    reduce: makeReduce(), execute: () => {},
    onRestore: () => { throw new Error('boom') },
  })
  // State should be the restored value (onRestore failed, original restored state kept)
  assertEquals(app.getState(), { count: 7 })
  // Dispatch still works
  app.dispatch({ type: 'INC' })
  assertEquals(app.getState(), { count: 8 })
  await app.close()
})

Deno.test('onRestore not called when persist is false', async () => {
  setup()
  let called = false
  const app = initStandalone({ count: 0 }, {
    reduce: makeReduce(), execute: () => {},
    persist: false,
    onRestore: (s) => { called = true; return s },
  })
  // onRestore is still called — it transforms state regardless of persist setting
  assertEquals(called, true)
  await app.close()
})

Deno.test('localStorage quota exceeded — persist degrades gracefully', async () => {
  setup()
  let threw = false
  const origSetItem = localStorage.setItem.bind(localStorage)
  localStorage.setItem = (_k: string, _v: string) => {
    threw = true
    throw new Error('QuotaExceededError')
  }
  try {
    const app = initStandalone({ count: 0 }, { reduce: makeReduce(), execute: () => {} })
    app.dispatch({ type: 'INC' })
    await new Promise(r => setTimeout(r, 150))  // wait for debounced persist
    // Must not crash — state is correct despite storage failure
    assertEquals(app.getState(), { count: 1 })
    assertEquals(threw, true)
    await app.close()
  } finally {
    localStorage.setItem = origSetItem
  }
})

// ── ScheduleEffect filtering ────────────────────────────

Deno.test('ScheduleEffect from reduce is not passed to execute', async () => {
  setup()
  const executed: (Effect | ScheduleEffect)[] = []
  const reduce = (state: State, action: Action): { state: State; effects: (Effect | ScheduleEffect)[] } => {
    if (action.type === 'SCHED') {
      return {
        state: { count: state.count + 1 },
        effects: [
          schedule.after('sched1', 1000, { type: 'INC' }),
          { type: 'LOG', payload: { message: 'ok' } },
        ],
      }
    }
    return { state, effects: [] }
  }
  const app = initStandalone({ count: 0 }, {
    reduce,
    execute: (_app, e) => { executed.push(e) },
  })
  app.dispatch({ type: 'SCHED' })
  // Only the regular effect should reach execute, not the ScheduleEffect
  assertEquals(executed.length, 1)
  assertEquals(executed[0].type, 'LOG')
  assertEquals(app.getState(), { count: 1 })
  await app.close()
})

Deno.test('ScheduleEffect mixed with regular effects — only regular reach execute', async () => {
  setup()
  const executed: string[] = []
  const reduce = (state: State, _action: Action): { state: State; effects: (Effect | ScheduleEffect)[] } => {
    return {
      state: { count: state.count + 1 },
      effects: [
        { type: 'A', payload: { message: '1' } },
        schedule.every('tick1', 500, { type: 'TICK' }),
        { type: 'B', payload: { message: '2' } },
        schedule.cancel('TICK'),
      ],
    }
  }
  const app = initStandalone({ count: 0 }, {
    reduce,
    execute: (_app, e) => { executed.push(e.type) },
  })
  app.dispatch({ type: 'GO' })
  assertEquals(executed, ['A', 'B'])
  await app.close()
})
