import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { createDispatch, deepFreeze } from '../src/dispatch.ts'

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

Deno.test('dispatch: effectTimeout warns if async effect takes too long', async () => {
  let warnMsg = ''
  let state = { n: 0 }
  const dispatch = createDispatch<typeof state, { type: string }, { type: string }>({
    reduce: (s) => ({ state: { n: s.n + 1 }, effects: [{ type: 'SLOW' }] }),
    execute: (e) => { if (e.type === 'SLOW') return new Promise(r => setTimeout(r, 200)) },
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => {},
    log: { debug: () => {}, warn: (m) => { warnMsg = m }, error: () => {} },
    debug: false,
    effectTimeout: 50,
  })
  dispatch({ type: 'A' })
  await new Promise(r => setTimeout(r, 300))
  assertEquals(warnMsg.includes('async effect timeout'), true)
  assertEquals(warnMsg.includes('SLOW'), true)
})

Deno.test('dispatch: effectTimeout cleared when async effect completes quickly', async () => {
  let warnMsg = ''
  let state = { n: 0 }
  const dispatch = createDispatch<typeof state, { type: string }, { type: string }>({
    reduce: (s) => ({ state: { n: s.n + 1 }, effects: [{ type: 'FAST' }] }),
    execute: (e) => { if (e.type === 'FAST') return new Promise(r => setTimeout(r, 10)) },
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => {},
    log: { debug: () => {}, warn: (m) => { warnMsg = m }, error: () => {} },
    debug: false,
    effectTimeout: 200,
  })
  dispatch({ type: 'A' })
  await new Promise(r => setTimeout(r, 300))
  assertEquals(warnMsg, '') // no warning — effect completed before timeout
})

Deno.test('dispatch: effectTimeout=0 disables timeout', async () => {
  let warnMsg = ''
  let state = { n: 0 }
  const dispatch = createDispatch<typeof state, { type: string }, { type: string }>({
    reduce: (s) => ({ state: { n: s.n + 1 }, effects: [{ type: 'SLOW' }] }),
    execute: (e) => { if (e.type === 'SLOW') return new Promise(r => setTimeout(r, 100)) },
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => {},
    log: { debug: () => {}, warn: (m) => { warnMsg = m }, error: () => {} },
    debug: false,
    effectTimeout: 0,
  })
  dispatch({ type: 'A' })
  await new Promise(r => setTimeout(r, 200))
  assertEquals(warnMsg, '') // disabled — no warning
})

// ── Additional dispatch coverage ──

Deno.test('dispatch: deepFreeze state when freezeState=true', () => {
  let state = { count: 0 }
  const dispatch = createDispatch<typeof state, { type: string }, never>({
    reduce: (s) => ({ state: { count: s.count + 1 }, effects: [] }),
    execute: () => {},
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => {},
    log: noop, debug: false,
    freezeState: true,
  })
  dispatch({ type: 'A' })
  assertEquals(state.count, 1)
  assertEquals(Object.isFrozen(state), true)
})

Deno.test('dispatch: onError callback receives reduce errors', () => {
  let state = { n: 0 }
  // deno-lint-ignore no-explicit-any
  let gotError: any = null
  const dispatch = createDispatch<typeof state, { type: string }, never>({
    reduce: () => { throw new Error('boom') },
    execute: () => {},
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => {},
    log: noop, debug: false,
    onError: (err) => { gotError = err },
  })
  dispatch({ type: 'X' })
  assertEquals(gotError?.source, 'reduce')
})

Deno.test('dispatch: onPerf callback receives timing info', () => {
  let state = { n: 0 }
  // deno-lint-ignore no-explicit-any
  let perfInfo: any = null
  const dispatch = createDispatch<typeof state, { type: string }, never>({
    reduce: (s) => ({ state: { n: s.n + 1 }, effects: [] }),
    execute: () => {},
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => {},
    log: noop, debug: false,
    onPerf: (t) => { perfInfo = t as { actionType: string; reduce: number } },
  })
  dispatch({ type: 'Test' })
  assertEquals(perfInfo?.actionType, 'Test')
  assertEquals(typeof perfInfo?.reduce, 'number')
})

Deno.test('dispatch: errorCount tracks accumulated errors', () => {
  let state = { n: 0 }
  const dispatch = createDispatch<typeof state, { type: string }, never>({
    reduce: (_, a) => {
      if (a.type === 'BAD') throw new Error('x')
      return { state: { n: 0 }, effects: [] }
    },
    execute: () => {},
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => {},
    log: noop, debug: false,
  })
  dispatch({ type: 'BAD' })
  dispatch({ type: 'BAD' })
  dispatch({ type: 'OK' })
  assertEquals(dispatch.errorCount(), 2)
})

Deno.test('dispatch: perfMode soft only warns, does not error', () => {
  let state = { n: 0 }
  let warned = false
  let errored = false
  const dispatch = createDispatch<typeof state, { type: string }, never>({
    reduce: (s) => {
      // Burn some time
      const end = performance.now() + 2
      while (performance.now() < end) { /* spin */ }
      return { state: { n: s.n + 1 }, effects: [] }
    },
    execute: () => {},
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => {},
    log: { debug: () => {}, warn: () => { warned = true }, error: () => { errored = true } },
    debug: false,
    perfMode: 'soft',
    perfBudget: { reduce: 0.01 }, // tiny budget to trigger
  })
  dispatch({ type: 'SLOW' })
  assertEquals(warned, true)
  assertEquals(errored, false)
})

Deno.test('dispatch: debug mode logs action and state changes', () => {
  let state = { count: 0 }
  const debugLogs: string[] = []
  const dispatch = createDispatch<typeof state, { type: string; payload: { by: number } }, never>({
    reduce: (s, a) => ({ state: { count: s.count + a.payload.by }, effects: [] }),
    execute: () => {},
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => {},
    log: { debug: (m) => debugLogs.push(m), warn: () => {}, error: () => {} },
    debug: true,
  })
  dispatch({ type: 'INC', payload: { by: 1 } })
  assertEquals(debugLogs.some(l => l.includes('action → reduce')), true)
  assertEquals(debugLogs.some(l => l.includes('state: changed')), true)
})

Deno.test('dispatch: multiple actions queued are all processed', () => {
  let state = { n: 0 }
  let doneCalls = 0
  const dispatch = createDispatch<typeof state, { type: string }, never>({
    reduce: (s) => ({ state: { n: s.n + 1 }, effects: [] }),
    execute: () => {},
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => { doneCalls++ },
    log: noop, debug: false,
  })
  dispatch({ type: 'A' })
  dispatch({ type: 'B' })
  dispatch({ type: 'C' })
  assertEquals(state.n, 3)
  assertEquals(doneCalls, 3) // each dispatch drains independently
})

Deno.test('deepFreeze: handles nested objects', () => {
  const obj = { a: { b: { c: 1 } }, d: [1, 2] }
  deepFreeze(obj)
  assertEquals(Object.isFrozen(obj), true)
  assertEquals(Object.isFrozen(obj.a), true)
  assertEquals(Object.isFrozen(obj.a.b), true)
})

Deno.test('deepFreeze: handles null and primitives', () => {
  assertEquals(deepFreeze(null), null)
  assertEquals(deepFreeze(42), 42)
  assertEquals(deepFreeze('str'), 'str')
})

Deno.test('deepFreeze: skips already frozen', () => {
  const obj = Object.freeze({ x: 1 })
  const result = deepFreeze(obj)
  assertEquals(result, obj)
  assertEquals(Object.isFrozen(result), true)
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

Deno.test('dispatch: queue depth limit drops actions beyond QUEUE_MAX', () => {
  let state = { n: 0 }
  const errMsgs: string[] = []
  let dispatchRef: ((a: { type: string }) => void) | null = null

  // Use a reducer that queues a burst of re-entrant dispatches via onDone
  // The key is to fill the queue while dispatch is processing (dispatching=true)
  // so re-entrant calls go to queue without draining
  let floodOnDone = false

  const dispatch = createDispatch<typeof state, { type: string }, never>({
    reduce: (s) => ({ state: { n: s.n + 1 }, effects: [] }),
    execute: () => {},
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => {
      if (floodOnDone) {
        floodOnDone = false
        // While inside onDone, dispatching=true, so these all queue
        for (let i = 0; i < 10_001; i++) {
          dispatchRef!({ type: 'QUEUED' })
        }
      }
    },
    log: { ...noop, error: (m) => { errMsgs.push(m) } },
    debug: false,
  })

  dispatchRef = dispatch
  floodOnDone = true
  dispatch({ type: 'TRIGGER' })
  // Queue depth exceeded error should fire for the action beyond 10_000
  assertEquals(errMsgs.some(m => m.includes('queue depth exceeded')), true)
})

Deno.test('dispatch: onDone throw does not wedge dispatch loop', () => {
  let state = { n: 0 }
  let errMsg = ''

  const dispatch = createDispatch<typeof state, { type: string }, never>({
    reduce: (s) => ({ state: { n: s.n + 1 }, effects: [] }),
    execute: () => {},
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => { throw new Error('onDone crash') },
    log: { ...noop, error: (m) => { errMsg = m } },
    debug: false,
  })

  dispatch({ type: 'A' })
  assertEquals(state.n, 1)
  assertEquals(errMsg.includes('onDone threw'), true)

  // Dispatch still works after onDone crash
  dispatch({ type: 'B' })
  assertEquals(state.n, 2)
})
