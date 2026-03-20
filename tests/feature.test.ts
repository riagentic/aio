import { assertEquals, assertThrows } from '@std/assert'
import { feature, composeFeatures, testFeature, tagSource } from '../src/feature.ts'
import { schedule } from '../src/schedule.ts'
import { aio } from '../src/aio.ts'

// ── feature() — catalog generation ─────────────────────────────────

const counter = feature('counter', {
  state: { count: 0, lastUpdatedAt: 0, error: null as string | null },
  actions: {
    increment: (by = 1) => ({ by }),
    decrement: (by = 1) => ({ by }),
    reset: () => ({}),
    save: () => ({}),
    saved: () => ({}),
    saveFailed: (error: string) => ({ error }),
    retry: () => ({}),
    dismiss: () => ({}),
  },
  effects: {
    persist: (value: number) => ({ value }),
    log: (message: string) => ({ message }),
  },
  machine: {
    initial: 'idle',
    states: {
      idle:   { increment: 'idle', decrement: 'idle', reset: 'idle', save: 'saving' },
      saving: { saved: 'idle', saveFailed: 'error' },
      error:  { retry: 'saving', dismiss: 'idle' },
    },
  },
  reduce: {
    increment(state, payload) {
      state.count += payload.by
      state.lastUpdatedAt = Date.now()
      return [counter.__aio.effects.log(`incremented to ${state.count}`)]
    },
    decrement(state, payload) {
      state.count -= payload.by
      state.lastUpdatedAt = Date.now()
    },
    reset(state)   { state.count = 0 },
    save(state)    { return [counter.__aio.effects.persist(state.count)] },
    saved()        {},
    saveFailed(state, payload) { state.error = payload.error },
    retry(state)   { state.error = null; return [counter.__aio.effects.persist(state.count)] },
    dismiss(state) { state.error = null },
  },
  execute: {
    persist(app) { app.dispatch(counter.saved()) },
    log()        { /* noop in tests */ },
  },
  selectors: {
    getCount: (s) => s.count,
    isIdle: (s) => (s as unknown as { _status: string })._status === 'idle',
  },
})

// ── A catalog ──

Deno.test('feature: action labels are featureName:actionKey format', () => {
  assertEquals(counter.increment.type, 'counter:increment')
  assertEquals(counter.decrement.type, 'counter:decrement')
  assertEquals(counter.reset.type, 'counter:reset')
  assertEquals(counter.save.type, 'counter:save')
  assertEquals(counter.saved.type, 'counter:saved')
  assertEquals(counter.saveFailed.type, 'counter:saveFailed')
})

Deno.test('feature: action creators produce { type, payload }', () => {
  assertEquals(counter.increment(5), { type: 'counter:increment', payload: { by: 5 } })
  assertEquals(counter.decrement(3), { type: 'counter:decrement', payload: { by: 3 } })
  assertEquals(counter.reset(), { type: 'counter:reset', payload: {} })
  assertEquals(counter.save(), { type: 'counter:save', payload: {} })
})

Deno.test('feature: default params preserved', () => {
  assertEquals(counter.increment(), { type: 'counter:increment', payload: { by: 1 } })
})

Deno.test('feature: effect labels and creators', () => {
  assertEquals(counter.__aio.effects.persist.type, 'counter:persist')
  assertEquals(counter.__aio.effects.log.type, 'counter:log')
  assertEquals(counter.__aio.effects.persist(42), { type: 'counter:persist', payload: { value: 42 } })
  assertEquals(counter.__aio.effects.log('hi'), { type: 'counter:log', payload: { message: 'hi' } })
})

Deno.test('feature: name and prefix', () => {
  assertEquals(counter.__aio.id, 'counter')
  assertEquals(counter.__aio.id, 'counter')
})

Deno.test('feature: selectors', () => {
  // selectors receive feature's own slice — auto-scoped
  const state = { counter: { count: 42, _status: 'idle' } }
  assertEquals(counter.__aio.selectors.getCount!(state), 42)
  assertEquals(counter.__aio.selectors.isIdle!(state), true)
})

// ── Machine validation ──

Deno.test('feature: machine validates action keys', () => {
  assertThrows(
    () => feature('bad', {
      state: {},
      actions: { go: () => ({}) },
      machine: { initial: 'a', states: { a: { typo: 'a' } } },
      reduce() {},
    }),
    Error,
    'unknown action',
  )
})

Deno.test('feature: machine validates target states', () => {
  assertThrows(
    () => feature('bad', {
      state: {},
      actions: { go: () => ({}) },
      machine: { initial: 'a', states: { a: { go: 'nonexistent' } } },
      reduce() {},
    }),
    Error,
    'unknown target',
  )
})

Deno.test('feature: machine validates initial state exists', () => {
  assertThrows(
    () => feature('bad', {
      state: {},
      actions: { go: () => ({}) },
      machine: { initial: 'nope', states: { a: { go: 'a' } } },
      reduce() {},
    }),
    Error,
    'not in declared states',
  )
})

Deno.test('feature: machine validates reachability', () => {
  assertThrows(
    () => feature('bad', {
      state: {},
      actions: { go: () => ({}) },
      machine: { initial: 'a', states: { a: { go: 'a' }, orphan: { go: 'a' } } },
      reduce() {},
    }),
    Error,
    'unreachable',
  )
})

Deno.test('feature: simple machine accepted', () => {
  const f = feature('simple', {
    state: { x: 0 },
    actions: { set: (x: number) => ({ x }) },
    machine: false,
    reduce: {
      set(state, payload) { state.x = payload.x },
    },
  })
  assertEquals(f.__aio.id, 'simple')
  assertEquals(f.set.type, 'simple:set')
})

Deno.test('feature: foreign actions in machine allowed', () => {
  // Should not throw — foreign actions have ':' and are allowed
  const dc = feature('dc', {
    state: {},
    actions: { priceUpdated: (price: number) => ({ price }) },
    machine: { initial: 'idle', states: { idle: { priceUpdated: 'idle' } } },
    reduce() {},
  })

  const te = feature('te', {
    state: { price: 0 },
    actions: { placeOrder: () => ({}) },
    machine: {
      initial: 'idle',
      states: {
        idle: { placeOrder: 'waiting', [dc.priceUpdated.type]: 'idle' },
        waiting: { [dc.priceUpdated.type]: 'idle' },
      },
    },
    reduce: {
      ['dc:priceUpdated'](state, payload) { state.price = payload.price },
    },
  })

  assertEquals(te.__aio.foreignActions, ['dc:priceUpdated'])
})

// ── composeFeatures() ──

Deno.test('compose: initialState includes _status', () => {
  const composed = composeFeatures([counter])
  const state = composed.initialState as Record<string, Record<string, unknown>>
  assertEquals(state.counter!._status, 'idle')
  assertEquals(state.counter!.count, 0)
})

Deno.test('compose: simple machine has no _status', () => {
  const f = feature('noop', {
    state: { x: 1 },
    actions: { set: () => ({}) },
    machine: false,
    reduce() {},
  })
  const composed = composeFeatures([f])
  assertEquals((composed.initialState.noop as Record<string, unknown>)._status, undefined)
})

Deno.test('compose: reduce routes action to correct feature', () => {
  const composed = composeFeatures([counter])
  const result = composed.reduce(composed.initialState, counter.increment(5))
  const s = result.state.counter as Record<string, unknown>
  assertEquals(s.count, 5)
  assertEquals(s._status, 'idle')
  assertEquals(result.effects.length, 1)
  assertEquals(result.effects[0]!.type, 'counter:log')
})

Deno.test('compose: machine guard blocks invalid transitions', () => {
  const composed = composeFeatures([counter])
  // Can't 'saved' from idle — only valid in 'saving'
  const result = composed.reduce(composed.initialState, counter.saved())
  assertEquals(result.effects.length, 0)
  assertEquals((result.state.counter as Record<string, unknown>).count, 0) // unchanged
})

Deno.test('compose: state machine transitions correctly', () => {
  const composed = composeFeatures([counter])

  // idle → save → saving
  const r1 = composed.reduce(composed.initialState, counter.save())
  assertEquals((r1.state.counter as Record<string, unknown>)._status, 'saving')
  assertEquals(r1.effects.length, 1) // persist effect

  // saving → saved → idle
  const r2 = composed.reduce(r1.state, counter.saved())
  assertEquals((r2.state.counter as Record<string, unknown>)._status, 'idle')

  // saving → saveFailed → error
  const r3 = composed.reduce(r1.state, counter.saveFailed('disk full'))
  assertEquals((r3.state.counter as Record<string, unknown>)._status, 'error')
  assertEquals((r3.state.counter as Record<string, unknown>).error, 'disk full')

  // error → retry → saving
  const r4 = composed.reduce(r3.state, counter.retry())
  assertEquals((r4.state.counter as Record<string, unknown>)._status, 'saving')
  assertEquals((r4.state.counter as Record<string, unknown>).error, null) // cleared

  // error → dismiss → idle
  const r5 = composed.reduce(r3.state, counter.dismiss())
  assertEquals((r5.state.counter as Record<string, unknown>)._status, 'idle')
})

Deno.test('compose: multiple features isolated', () => {
  const a = feature('alpha', {
    state: { x: 0 },
    actions: { inc: () => ({}) },
    machine: false,
    reduce(state) { state.x += 1 },
  })
  const b = feature('beta', {
    state: { y: 0 },
    actions: { inc: () => ({}) },
    machine: false,
    reduce(state) { state.y += 1 },
  })

  const composed = composeFeatures([a, b])
  const r = composed.reduce(composed.initialState, a.inc())
  assertEquals((r.state.alpha as Record<string, number>).x, 1)
  assertEquals((r.state.beta as Record<string, number>).y, 0)
})

Deno.test('compose: foreign action routing', () => {
  const dc = feature('dc', {
    state: { price: 0 },
    actions: { priceUpdated: (price: number) => ({ price }) },
    machine: { initial: 'idle', states: { idle: { priceUpdated: 'idle' } } },
    reduce: {
      priceUpdated(state, payload) { state.price = payload.price },
    },
  })

  const te = feature('te', {
    state: { lastPrice: 0 },
    actions: { noop: () => ({}) },
    machine: {
      initial: 'idle',
      states: { idle: { noop: 'idle', [dc.priceUpdated.type]: 'idle' } },
    },
    reduce: {
      ['dc:priceUpdated'](state, payload) { state.lastPrice = payload.price },
    },
  })

  const composed = composeFeatures([dc, te])
  const r = composed.reduce(composed.initialState, dc.priceUpdated(42000))

  // DC updates its own state
  assertEquals((r.state.dc as Record<string, unknown>).price, 42000)
  // TE listens and updates too
  assertEquals((r.state.te as Record<string, unknown>).lastPrice, 42000)
})

Deno.test('compose: executor scoped dispatch blocks foreign actions', () => {
  const logs: string[] = []
  const origError = console.error
  console.error = (msg: string) => logs.push(msg)

  const a = feature('alpha', {
    state: {},
    actions: { go: () => ({}) },
    effects: { run: () => ({}) },
    machine: false,
    reduce: { go(_s) { return [a.__aio.effects.run()] } },
    execute: {
      run(app) {
        // Try to dispatch foreign action
        app.dispatch({ type: 'beta:go', payload: {} })
      },
    },
  })

  const composed = composeFeatures([a])
  const app = { dispatch: () => {}, getState: () => composed.initialState }
  composed.execute(app, { type: 'alpha:run', payload: {} })

  console.error = origError
  assertEquals(logs.some(l => l.includes('blocked')), true)
})

// ── Dependency resolution ──

Deno.test('compose: dependency order respected', () => {
  const order: string[] = []
  const a = feature('a', {
    state: { v: 'a' },
    actions: { ping: () => ({}) },
    machine: false,
    reduce(state) { order.push('a'); state.v = 'a-done' },
  })
  const b = feature('b', {
    state: { v: 'b' },
    actions: { ping: () => ({}) },
    machine: false,
    reduce(state) { order.push('b'); state.v = 'b-done' },
  })

  // b depends on a — a should be before b in features list
  const composed = composeFeatures([
    { feature: b, dependsOn: ['a'] },
    a,
  ])
  assertEquals(composed.featureNames, ['a', 'b'])
})

Deno.test('compose: cycle detection', () => {
  const a = feature('a', { state: {}, actions: { x: () => ({}) }, machine: false, reduce() {} })
  const b = feature('b', { state: {}, actions: { x: () => ({}) }, machine: false, reduce() {} })

  assertThrows(
    () => composeFeatures([
      { feature: a, dependsOn: ['b'] },
      { feature: b, dependsOn: ['a'] },
    ]),
    Error,
    'cycle',
  )
})

Deno.test('compose: unknown dependency', () => {
  const a = feature('a', { state: {}, actions: { x: () => ({}) }, machine: false, reduce() {} })

  assertThrows(
    () => composeFeatures([{ feature: a, dependsOn: ['nonexistent'] }]),
    Error,
    'unknown feature',
  )
})

Deno.test('compose: duplicate feature name', () => {
  const a1 = feature('dup', { state: {}, actions: { x: () => ({}) }, machine: false, reduce() {} })
  const a2 = feature('dup', { state: {}, actions: { y: () => ({}) }, machine: false, reduce() {} })

  assertThrows(
    () => composeFeatures([a1, a2]),
    Error,
    'duplicate',
  )
})

// ── testFeature() harness ──

testFeature<{ count: number; lastUpdatedAt: number; error: string | null }>(
  counter,
  'increment from idle',
  (t) => {
    t.init()
    t.send.increment!(5)
    t.expect.state(s => s.count === 5)
    t.expect.effects(['counter:log'])
    t.expect.status('idle')
  },
)

testFeature<{ count: number; lastUpdatedAt: number; error: string | null }>(
  counter,
  'save triggers persist effect',
  (t) => {
    t.init()
    t.send.save!()
    t.expect.status('saving')
    t.expect.effects(['counter:persist'])
    t.expect.effectCount(1)
  },
)

testFeature<{ count: number; lastUpdatedAt: number; error: string | null }>(
  counter,
  'machine blocks invalid transition',
  (t) => {
    t.init()
    // Can't save twice — first save goes to 'saving', second is blocked
    t.send.save!()
    t.expect.status('saving')
    t.send.save!() // blocked by machine
    t.expect.effectCount(0) // no new effects
    t.expect.status('saving') // still saving
  },
)

testFeature<{ count: number; lastUpdatedAt: number; error: string | null }>(
  counter,
  'count is always a number (property-based)',
  (t) => {
    t.init()
    t.randomActions(200)
    t.expect.invariant(s => typeof s.count === 'number')
    t.expect.invariant(s => !isNaN(s.count))
  },
)

testFeature<{ count: number; lastUpdatedAt: number; error: string | null }>(
  counter,
  'full lifecycle',
  (t) => {
    t.init()
    t.send.increment!(10)
    t.expect.state(s => s.count === 10)
    t.expect.status('idle')

    t.destroy()
    t.expect.state(s => s.count === 0)

    t.init()
    t.expect.state(s => s.count === 0)
    t.expect.status('idle')
  },
)

// middleware: freeze returns action (passthrough)

Deno.test('aio.middleware.freeze: passthrough', () => {
  const mw = aio.middleware.freeze()
  const result = mw({ type: 'Test', payload: {} }, {})
  assertEquals(result !== null, true)
})

// middleware: devtools returns action (passthrough)

Deno.test('aio.middleware.devtools: passthrough', () => {
  const mw = aio.middleware.devtools()
  const result = mw({ type: 'Test', payload: {} }, {})
  assertEquals(result !== null, true)
})

// middleware: perfBudget stores start time

Deno.test('aio.middleware.perfBudget: stores perf start on globalThis', () => {
  const mw = aio.middleware.perfBudget({ reduce: 10 })
  mw({ type: 'Test', payload: {} }, {})
  assertEquals(typeof (globalThis as Record<string, unknown>).__aioMiddlewarePerfStart, 'number')
  // cleanup
  delete (globalThis as Record<string, unknown>).__aioMiddlewarePerfStart
  delete (globalThis as Record<string, unknown>).__aioMiddlewarePerfBudget
})

// middleware: validate warns on array payload

Deno.test('aio.middleware.validate: warns on array payload', () => {
  const warnings: string[] = []
  const origWarn = console.warn
  console.warn = (msg: string) => warnings.push(msg)
  const mw = aio.middleware.validate()
  const result = mw({ type: 'Test', payload: [1, 2, 3] }, {})
  console.warn = origWarn
  assertEquals(result !== null, true) // not dropped, just warned
  assertEquals(warnings.some(w => w.includes('plain object')), true)
})

// middleware: validate allows undefined payload

Deno.test('aio.middleware.validate: allows undefined payload', () => {
  const mw = aio.middleware.validate()
  const result = mw({ type: 'Test' }, {})
  assertEquals(result !== null, true)
})

// middleware: metrics tracks multiple features

Deno.test('aio.middleware.metrics: tracks errors field initialized to 0', () => {
  const mw = aio.middleware.metrics()
  mw({ type: 'Foo:Bar', payload: {} }, {})
  const counters = (globalThis as Record<string, unknown>).__aioMetrics as Map<string, { count: number; errors: number }>
  assertEquals(counters.get('Foo')?.errors, 0)
  delete (globalThis as Record<string, unknown>).__aioMetrics
})

// ── Fix A: ScheduleEffect in reduce return ──

Deno.test('reduce: accepts ScheduleEffect in effects array', () => {
  const f = feature('sched', {
    state: { count: 0 },
    actions: { tick: () => ({}) },
    effects: { log: (msg: string) => ({ msg }) },
    machine: false,
    reduce: {
      tick() {
        return [
          f.__aio.effects.log('hello'),
          schedule.after('sched:retry', 1000, { type: 'sched:tick', payload: {} }),
        ]
      },
    },
  })
  const composed = composeFeatures([f])
  const result = composed.reduce(composed.initialState, f.tick())
  assertEquals(result.effects.length, 2)
  assertEquals(result.effects[0]!.type, 'sched:log')
  assertEquals(result.effects[1]!.type, '__schedule')
})

// ── Fix C: dispatchTo allowlist ──

Deno.test('compose: dispatchTo allows dispatching to allowlisted features', () => {
  const dispatched: string[] = []
  const alpha = feature('alpha', {
    state: {},
    actions: { go: () => ({}) },
    effects: { sync: () => ({}) },
    machine: false,
    dispatchTo: ['beta'],
    reduce: { go() { return [alpha.__aio.effects.sync()] } },
    execute: {
      sync(app) { app.dispatch({ type: 'beta:update', payload: {} }) },
    },
  })
  const beta = feature('beta', {
    state: { updated: false },
    actions: { update: () => ({}) },
    machine: false,
    reduce: { update(state) { state.updated = true } },
  })
  const composed = composeFeatures([alpha, beta])
  composed.execute(
    { dispatch: (a) => dispatched.push(a.type), getState: () => composed.initialState },
    { type: 'alpha:sync', payload: {} },
  )
  assertEquals(dispatched.includes('beta:update'), true)
})

Deno.test('compose: dispatchTo blocks non-allowlisted features', () => {
  let errorLogged = false
  const origError = console.error
  console.error = (msg: string) => { if (String(msg).includes('blocked')) errorLogged = true }

  const alpha = feature('alpha', {
    state: {},
    actions: { go: () => ({}) },
    effects: { bad: () => ({}) },
    machine: false,
    dispatchTo: ['gamma'],  // beta NOT in allowlist
    reduce: { go() { return [alpha.__aio.effects.bad()] } },
    execute: {
      bad(app) { app.dispatch({ type: 'beta:update', payload: {} }) },
    },
  })
  const beta = feature('beta', {
    state: {},
    actions: { update: () => ({}) },
    machine: false,
    reduce() {},
  })
  const dispatched: string[] = []
  const composed = composeFeatures([alpha, beta])
  composed.execute(
    { dispatch: (a) => dispatched.push(a.type), getState: () => composed.initialState },
    { type: 'alpha:bad', payload: {} },
  )
  assertEquals(dispatched.includes('beta:update'), false)
  assertEquals(errorLogged, true)
  console.error = origError
})

Deno.test('compose: dispatch without dispatchTo blocks all foreign actions', () => {
  let errorLogged = false
  const origError = console.error
  console.error = (msg: string) => { if (String(msg).includes('blocked')) errorLogged = true }

  const alpha = feature('alpha', {
    state: {},
    actions: { go: () => ({}) },
    effects: { bad: () => ({}) },
    machine: false,
    // no dispatchTo
    reduce: { go() { return [alpha.__aio.effects.bad()] } },
    execute: {
      bad(app) { app.dispatch({ type: 'beta:update', payload: {} }) },
    },
  })
  const beta = feature('beta', {
    state: {},
    actions: { update: () => ({}) },
    machine: false,
    reduce() {},
  })
  const dispatched: string[] = []
  const composed = composeFeatures([alpha, beta])
  composed.execute(
    { dispatch: (a) => dispatched.push(a.type), getState: () => composed.initialState },
    { type: 'alpha:bad', payload: {} },
  )
  assertEquals(dispatched.includes('beta:update'), false)
  assertEquals(errorLogged, true)
  console.error = origError
})

// ── Verify: machine: false does NOT receive foreign actions ──

Deno.test('compose: machine: false does not receive foreign actions', () => {
  let betaReduced = false
  const alpha = feature('alpha', {
    state: {},
    actions: { fire: () => ({}) },
    machine: false,
    reduce() {},
  })
  const beta = feature('beta', {
    state: { heard: false },
    actions: { update: () => ({}) },
    machine: false,
    reduce(state, action) {
      // foreign action — cast to Msg for cross-feature access
      const msg = action as { type: string }
      if (msg.type === 'alpha:fire') {
        betaReduced = true
        state.heard = true
      }
    },
  })
  const composed = composeFeatures([alpha, beta])
  const result = composed.reduce(composed.initialState, alpha.fire())
  // beta should NOT have received the action — machine: false can't declare foreign listeners
  assertEquals(betaReduced, false)
  assertEquals((result.state.beta as Record<string, unknown>).heard, false)
})

Deno.test('compose: machine with foreign action declaration DOES receive foreign actions', () => {
  let betaReduced = false
  const alpha = feature('alpha', {
    state: {},
    actions: { fire: () => ({}) },
    machine: false,
    reduce() {},
  })
  const beta = feature('beta', {
    state: { heard: false },
    actions: { update: () => ({}) },
    machine: {
      initial: 'idle',
      states: {
        idle: { update: 'idle', [alpha.fire.type]: 'idle' },
      },
    },
    reduce: {
      update() {},
      ['alpha:fire'](state) { betaReduced = true; state.heard = true },
    },
  })
  const composed = composeFeatures([alpha, beta])
  const result = composed.reduce(composed.initialState, alpha.fire())
  assertEquals(betaReduced, true)
  assertEquals((result.state.beta as Record<string, unknown>).heard, true)
})

// ── ScopedApp.getFullState ──────────────────────────────────────────

Deno.test('onInit: getFullState returns full app state', () => {
  let fullStateInInit: unknown = null

  const a = feature('alpha', {
    state: { x: 1 },
    actions: { noop: () => ({}) },
    machine: false,
    onInit(app) {
      fullStateInInit = app.getFullState?.() ?? null
    },
  })

  const b = feature('beta', {
    state: { y: 2 },
    actions: { noop: () => ({}) },
    machine: false,
  })

  const composed = composeFeatures([a, b])

  // Simulate initAll
  const state = composed.initialState
  composed.initAll({ dispatch: () => {}, getState: () => state })

  assertEquals(fullStateInInit !== null, true)
  assertEquals(typeof (fullStateInInit as Record<string, unknown>).alpha, 'object')
  assertEquals(typeof (fullStateInInit as Record<string, unknown>).beta, 'object')
  assertEquals(((fullStateInInit as Record<string, unknown>).alpha as Record<string, unknown>).x, 1)
  assertEquals(((fullStateInInit as Record<string, unknown>).beta as Record<string, unknown>).y, 2)
})

Deno.test('onInit: getState still returns own slice only', () => {
  let ownState: unknown = null

  const f = feature('myf', {
    state: { val: 42 },
    actions: { noop: () => ({}) },
    machine: false,
    onInit(app) {
      ownState = app.getState()
    },
  })

  const composed = composeFeatures([f])
  composed.initAll({ dispatch: () => {}, getState: () => composed.initialState })

  assertEquals((ownState as Record<string, unknown>).val, 42)
  // own slice is { val: 42 }, not { myf: { val: 42 } }
  assertEquals((ownState as Record<string, unknown>).myf, undefined)
})

// ── feature persist: { exclude } ──────────────────────────────────

Deno.test('feature persist.exclude: sets persistExclude on internals', () => {
  const f = feature('rich', {
    state: { name: '', htmlCache: '' },
    actions: { noop: () => ({}) },
    machine: false,
    persist: { exclude: ['htmlCache'] },
  })

  assertEquals(f.__aio.persistExclude, ['htmlCache'])
})

Deno.test('feature persist.exclude: multiple fields', () => {
  const f = feature('doc', {
    state: { title: '', body: '', rendered: '', thumbnail: '' },
    methods: {
      setTitle(s, t: string) { s.title = t },
    },
    persist: { exclude: ['rendered', 'thumbnail'] },
  })

  assertEquals(f.__aio.persistExclude, ['rendered', 'thumbnail'])
})

Deno.test('feature persist.exclude: absent by default', () => {
  const f = feature('plain', {
    state: { x: 0 },
    actions: { inc: () => ({}) },
    machine: false,
  })

  assertEquals(f.__aio.persistExclude, undefined)
})

// ── Mixed mode: methods + actions + effects in one feature ──

Deno.test('mixed: methods + actions coexist in one feature', () => {
  const f = feature('mixed', {
    state: { count: 0, label: '' },
    methods: {
      increment(s: { count: number }, by = 1) { s.count += by },
    },
    actions: {
      SetLabel: (label: string) => ({ label }),
    },
    reduce: {
      SetLabel(state: { label: string }, payload: { label: string }) { state.label = payload.label },
    },
  })

  // Method works
  assertEquals(f.increment(), { type: 'mixed:increment', payload: { args: [] } })
  assertEquals(f.increment(5), { type: 'mixed:increment', payload: { args: [5] } })

  // Action works (explicit actions are flattened at runtime)
  assertEquals((f as unknown as Record<string, CallableFunction>).SetLabel!('hello'), { type: 'mixed:SetLabel', payload: { label: 'hello' } })
})

Deno.test('mixed: methods + actions + effects compose correctly', () => {
  const effectsRun: string[] = []
  const f = feature('shop', {
    state: { items: [] as string[], synced: false },
    methods: {
      add(s: { items: string[] }, item: string) { s.items.push(item) },
      clear(s: { items: string[] }) { s.items = [] },
    },
    actions: {
      MarkSynced: () => ({}),
    },
    effects: {
      SyncToServer: (items: string[]) => ({ items }),
    },
    reduce: {
      MarkSynced(state: { synced: boolean }) { state.synced = true },
    },
    execute: {
      SyncToServer(_app: unknown, payload: { items: string[] }) { effectsRun.push(`sync:${payload.items.join(',')}`) },
    },
  })

  const composed = composeFeatures([f])
  let state = composed.initialState

  // Method dispatch works
  state = composed.reduce(state, f.add!('apple')).state
  assertEquals((state.shop as { items: string[] }).items, ['apple'])

  // Action dispatch works (explicit actions flattened at runtime)
  const markSynced = (f as unknown as Record<string, CallableFunction>).MarkSynced as () => { type: string; payload: unknown }
  state = composed.reduce(state, markSynced()).state
  assertEquals((state.shop as { synced: boolean }).synced, true)

  // Effect from reduce works
  assertEquals((f.__aio.effects as unknown as Record<string, { type: string }>).SyncToServer!.type, 'shop:SyncToServer')
})

Deno.test('mixed: name collision between method and action throws', () => {
  assertThrows(
    () => feature('bad', {
      state: {},
      methods: { save(s: Record<string, unknown>) { s.saved = true } },
      actions: { save: () => ({}) },
    }),
    Error,
    'collides with method',
  )
})

Deno.test('mixed: name collision between method and effect throws', () => {
  assertThrows(
    () => feature('bad', {
      state: {},
      methods: { sync(s: Record<string, unknown>) { s.synced = true } },
      effects: { sync: () => ({}) },
    }),
    Error,
    'collides with method',
  )
})

Deno.test('mixed: name collision between generator and action throws', () => {
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => feature('bad' as any, {
      state: {},
      methods: { noop() {} },
      // deno-lint-ignore no-explicit-any
      generators: { *process(_ctx: any): any { yield 1 } },
      actions: { process: () => ({}) },
    } as any),
    Error,
    'collides with generator',
  )
})
