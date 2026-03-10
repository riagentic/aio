import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { feature, bridge, composeFeatures, testFeature, testBridge, tagSource } from '../src/feature.ts'
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
      idle:   { on: { increment: 'idle', decrement: 'idle', reset: 'idle', save: 'saving' } },
      saving: { on: { saved: 'idle', saveFailed: 'error' } },
      error:  { on: { retry: 'saving', dismiss: 'idle' } },
    },
  },
  reduce(state, action, { A, E }) {
    switch (action.type) {
      case A.Increment:
        state.count += action.payload.by
        state.lastUpdatedAt = Date.now()
        return [E.log(`incremented to ${state.count}`)]
      case A.Decrement:
        state.count -= action.payload.by
        state.lastUpdatedAt = Date.now()
        break
      case A.Reset:
        state.count = 0
        break
      case A.Save:
        return [E.persist(state.count)]
      case A.Saved:
        break
      case A.SaveFailed:
        state.error = action.payload.error
        break
      case A.Retry:
        state.error = null
        return [E.persist(state.count)]
      case A.Dismiss:
        state.error = null
        break
    }
  },
  execute(app, effect, { E, A }) {
    switch (effect.type) {
      case E.Persist:
        // In tests we just dispatch saved immediately
        app.dispatch(A.saved())
        break
      case E.Log:
        // noop in tests
        break
    }
  },
  selectors: {
    getCount: (s: unknown) => (s as Record<string, Record<string, number>>).counter.count,
    isIdle: (s: unknown) => (s as Record<string, Record<string, string>>).counter._status === 'idle',
  },
})

// ── A catalog ──

Deno.test('feature: A labels are PascalCase with prefix', () => {
  assertEquals(counter.A.Increment, 'Counter:Increment')
  assertEquals(counter.A.Decrement, 'Counter:Decrement')
  assertEquals(counter.A.Reset, 'Counter:Reset')
  assertEquals(counter.A.Save, 'Counter:Save')
  assertEquals(counter.A.Saved, 'Counter:Saved')
  assertEquals(counter.A.SaveFailed, 'Counter:SaveFailed')
})

Deno.test('feature: A creators produce { type, payload }', () => {
  assertEquals(counter.A.increment(5), { type: 'Counter:Increment', payload: { by: 5 } })
  assertEquals(counter.A.decrement(3), { type: 'Counter:Decrement', payload: { by: 3 } })
  assertEquals(counter.A.reset(), { type: 'Counter:Reset', payload: {} })
  assertEquals(counter.A.save(), { type: 'Counter:Save', payload: {} })
})

Deno.test('feature: default params preserved', () => {
  assertEquals(counter.A.increment(), { type: 'Counter:Increment', payload: { by: 1 } })
})

Deno.test('feature: E labels and creators', () => {
  assertEquals(counter.E.Persist, 'Counter:Persist')
  assertEquals(counter.E.Log, 'Counter:Log')
  assertEquals(counter.E.persist(42), { type: 'Counter:Persist', payload: { value: 42 } })
  assertEquals(counter.E.log('hi'), { type: 'Counter:Log', payload: { message: 'hi' } })
})

Deno.test('feature: name and prefix', () => {
  assertEquals(counter.name, 'counter')
  assertEquals(counter._config.prefix, 'Counter')
})

Deno.test('feature: selectors', () => {
  const state = { counter: { count: 42, _status: 'idle' } }
  assertEquals(counter.selectors.getCount(state), 42)
  assertEquals(counter.selectors.isIdle(state), true)
})

// ── Machine validation ──

Deno.test('feature: machine validates action keys', () => {
  assertThrows(
    () => feature('bad', {
      state: {},
      actions: { go: () => ({}) },
      machine: { initial: 'a', states: { a: { on: { typo: 'a' } } } },
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
      machine: { initial: 'a', states: { a: { on: { go: 'nonexistent' } } } },
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
      machine: { initial: 'nope', states: { a: { on: { go: 'a' } } } },
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
      machine: { initial: 'a', states: { a: { on: { go: 'a' } }, orphan: { on: { go: 'a' } } } },
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
    machine: 'simple',
    reduce(state, action, { A }) {
      if (action.type === A.Set) state.x = action.payload.x
    },
  })
  assertEquals(f.name, 'simple')
  assertEquals(f.A.Set, 'Simple:Set')
})

Deno.test('feature: foreign actions in machine allowed', () => {
  // Should not throw — foreign actions have ':' and are allowed
  const dc = feature('dc', {
    state: {},
    actions: { priceUpdated: (price: number) => ({ price }) },
    machine: { initial: 'idle', states: { idle: { on: { priceUpdated: 'idle' } } } },
    reduce() {},
  })

  const te = feature('te', {
    state: { price: 0 },
    actions: { placeOrder: () => ({}) },
    machine: {
      initial: 'idle',
      states: {
        idle: { on: { placeOrder: 'waiting', [dc.A.PriceUpdated]: 'idle' } },
        waiting: { on: { [dc.A.PriceUpdated]: 'idle' } },
      },
    },
    reduce(state, action, { A }) {
      if (action.type === dc.A.PriceUpdated) state.price = action.payload.price
    },
  })

  assertEquals(te._config.foreignActions, ['Dc:PriceUpdated'])
})

// ── composeFeatures() ──

Deno.test('compose: initialState includes _status', () => {
  const composed = composeFeatures([counter])
  const state = composed.initialState as Record<string, Record<string, unknown>>
  assertEquals(state.counter._status, 'idle')
  assertEquals(state.counter.count, 0)
})

Deno.test('compose: simple machine has no _status', () => {
  const f = feature('noop', {
    state: { x: 1 },
    actions: { set: () => ({}) },
    machine: 'simple',
    reduce() {},
  })
  const composed = composeFeatures([f])
  assertEquals((composed.initialState.noop as Record<string, unknown>)._status, undefined)
})

Deno.test('compose: reduce routes action to correct feature', () => {
  const composed = composeFeatures([counter])
  const result = composed.reduce(composed.initialState, counter.A.increment(5))
  const s = result.state.counter as Record<string, unknown>
  assertEquals(s.count, 5)
  assertEquals(s._status, 'idle')
  assertEquals(result.effects.length, 1)
  assertEquals(result.effects[0].type, 'Counter:Log')
})

Deno.test('compose: machine guard blocks invalid transitions', () => {
  const composed = composeFeatures([counter])
  // Can't 'saved' from idle — only valid in 'saving'
  const result = composed.reduce(composed.initialState, counter.A.saved())
  assertEquals(result.effects.length, 0)
  assertEquals((result.state.counter as Record<string, unknown>).count, 0) // unchanged
})

Deno.test('compose: state machine transitions correctly', () => {
  const composed = composeFeatures([counter])

  // idle → save → saving
  const r1 = composed.reduce(composed.initialState, counter.A.save())
  assertEquals((r1.state.counter as Record<string, unknown>)._status, 'saving')
  assertEquals(r1.effects.length, 1) // persist effect

  // saving → saved → idle
  const r2 = composed.reduce(r1.state, counter.A.saved())
  assertEquals((r2.state.counter as Record<string, unknown>)._status, 'idle')

  // saving → saveFailed → error
  const r3 = composed.reduce(r1.state, counter.A.saveFailed('disk full'))
  assertEquals((r3.state.counter as Record<string, unknown>)._status, 'error')
  assertEquals((r3.state.counter as Record<string, unknown>).error, 'disk full')

  // error → retry → saving
  const r4 = composed.reduce(r3.state, counter.A.retry())
  assertEquals((r4.state.counter as Record<string, unknown>)._status, 'saving')
  assertEquals((r4.state.counter as Record<string, unknown>).error, null) // cleared

  // error → dismiss → idle
  const r5 = composed.reduce(r3.state, counter.A.dismiss())
  assertEquals((r5.state.counter as Record<string, unknown>)._status, 'idle')
})

Deno.test('compose: multiple features isolated', () => {
  const a = feature('alpha', {
    state: { x: 0 },
    actions: { inc: () => ({}) },
    machine: 'simple',
    reduce(state) { state.x += 1 },
  })
  const b = feature('beta', {
    state: { y: 0 },
    actions: { inc: () => ({}) },
    machine: 'simple',
    reduce(state) { state.y += 1 },
  })

  const composed = composeFeatures([a, b])
  const r = composed.reduce(composed.initialState, a.A.inc())
  assertEquals((r.state.alpha as Record<string, number>).x, 1)
  assertEquals((r.state.beta as Record<string, number>).y, 0)
})

Deno.test('compose: foreign action routing', () => {
  const dc = feature('dc', {
    state: { price: 0 },
    actions: { priceUpdated: (price: number) => ({ price }) },
    machine: { initial: 'idle', states: { idle: { on: { priceUpdated: 'idle' } } } },
    reduce(state, action, { A }) {
      if (action.type === A.PriceUpdated) state.price = action.payload.price
    },
  })

  const te = feature('te', {
    state: { lastPrice: 0 },
    actions: { noop: () => ({}) },
    machine: {
      initial: 'idle',
      states: { idle: { on: { noop: 'idle', [dc.A.PriceUpdated]: 'idle' } } },
    },
    reduce(state, action) {
      if (action.type === 'Dc:PriceUpdated') {
        state.lastPrice = action.payload.price
      }
    },
  })

  const composed = composeFeatures([dc, te])
  const r = composed.reduce(composed.initialState, dc.A.priceUpdated(42000))

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
    machine: 'simple',
    reduce(_s, _a, { A, E }) { return [E.run()] },
    execute(app) {
      // Try to dispatch foreign action
      app.dispatch({ type: 'Beta:Go', payload: {} })
    },
  })

  const composed = composeFeatures([a])
  const app = { dispatch: () => {}, getState: () => composed.initialState }
  composed.execute(app, { type: 'Alpha:Run', payload: {} })

  console.error = origError
  assertEquals(logs.some(l => l.includes('blocked')), true)
})

// ── Dependency resolution ──

Deno.test('compose: dependency order respected', () => {
  const order: string[] = []
  const a = feature('a', {
    state: { v: 'a' },
    actions: { ping: () => ({}) },
    machine: 'simple',
    reduce(state) { order.push('a'); state.v = 'a-done' },
  })
  const b = feature('b', {
    state: { v: 'b' },
    actions: { ping: () => ({}) },
    machine: 'simple',
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
  const a = feature('a', { state: {}, actions: { x: () => ({}) }, machine: 'simple', reduce() {} })
  const b = feature('b', { state: {}, actions: { x: () => ({}) }, machine: 'simple', reduce() {} })

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
  const a = feature('a', { state: {}, actions: { x: () => ({}) }, machine: 'simple', reduce() {} })

  assertThrows(
    () => composeFeatures([{ feature: a, dependsOn: ['nonexistent'] }]),
    Error,
    'unknown feature',
  )
})

Deno.test('compose: duplicate feature name', () => {
  const a1 = feature('dup', { state: {}, actions: { x: () => ({}) }, machine: 'simple', reduce() {} })
  const a2 = feature('dup', { state: {}, actions: { y: () => ({}) }, machine: 'simple', reduce() {} })

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
    t.send.increment(5)
    t.expect.state(s => s.count === 5)
    t.expect.effects(['Log'])
    t.expect.status('idle')
  },
)

testFeature<{ count: number; lastUpdatedAt: number; error: string | null }>(
  counter,
  'save triggers persist effect',
  (t) => {
    t.init()
    t.send.save()
    t.expect.status('saving')
    t.expect.effects(['Persist'])
    t.expect.effectCount(1)
  },
)

testFeature<{ count: number; lastUpdatedAt: number; error: string | null }>(
  counter,
  'machine blocks invalid transition',
  (t) => {
    t.init()
    // Can't save twice — first save goes to 'saving', second is blocked
    t.send.save()
    t.expect.status('saving')
    t.send.save() // blocked by machine
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
    t.send.increment(10)
    t.expect.state(s => s.count === 10)
    t.expect.status('idle')

    t.destroy()
    t.expect.state(s => s.count === 0)

    t.init()
    t.expect.state(s => s.count === 0)
    t.expect.status('idle')
  },
)

// ── bridge() ──

Deno.test('bridge: generates feature with actions and effects', () => {
  const b = bridge('bridge-dc-te', {
    from: 'te',
    to: 'dc',
    channels: {
      price: {
        request: (symbol: string) => ({ symbol }),
        response: (price: number, ts: number) => ({ price, ts }),
        timeout: 5000,
      },
    },
  })

  assertEquals(b.name, 'bridge-dc-te')
  assertEquals(typeof b.A.PriceRequest, 'string')
  assertEquals(typeof b.A.PriceResponse, 'string')
  assertEquals(typeof b.A.PriceTimeout, 'string')
  assertEquals(typeof b.A.priceRequest, 'function')
  assertEquals(typeof b.request?.price, 'function')
})

Deno.test('bridge: request creates properly typed action', () => {
  const b = bridge('bridge-dc-te', {
    from: 'te',
    to: 'dc',
    channels: {
      price: {
        request: (symbol: string) => ({ symbol }),
        response: (price: number) => ({ price }),
        timeout: 5000,
      },
    },
  })

  const req = b.request!.price('BTC')
  assertEquals(req.type, 'Bridge-dc-te:PriceRequest')
  assertEquals((req.payload as Record<string, unknown>).symbol, 'BTC')
  assertEquals(typeof (req.payload as Record<string, unknown>)._correlationId, 'string')
})

Deno.test('bridge: composes into app', () => {
  const b = bridge('bridge-dc-te', {
    from: 'te',
    to: 'dc',
    channels: {
      price: {
        request: (symbol: string) => ({ symbol }),
        response: (price: number) => ({ price }),
      },
    },
  })

  const composed = composeFeatures([b])
  assertEquals(typeof composed.initialState['bridge-dc-te'], 'object')
  const bs = composed.initialState['bridge-dc-te'] as Record<string, unknown>
  assertEquals(typeof bs.pending, 'object')
  assertEquals(typeof bs.metrics, 'object')
})

// ── Source tagging ──

Deno.test('tagSource: adds _source to action', () => {
  const msg = { type: 'Counter:Increment', payload: { by: 1 } }
  const tagged = tagSource(msg, 'UI')
  assertEquals(tagged._source, 'UI')
  assertEquals(tagged.type, 'Counter:Increment')
  assertEquals(tagged.payload.by, 1)
  // Original not mutated
  assertEquals((msg as Record<string, unknown>)._source, undefined)
})

// ── Lifecycle actions ──

Deno.test('compose: init action preserves existing state and sets _status', () => {
  const composed = composeFeatures([counter])
  // Mutate state (simulates KV-restored data)
  const r1 = composed.reduce(composed.initialState, counter.A.increment(42))
  assertEquals((r1.state.counter as Record<string, unknown>).count, 42)
  // Init preserves existing data, sets _status
  const r2 = composed.reduce(r1.state, { type: 'Counter:Init', payload: {} })
  assertEquals((r2.state.counter as Record<string, unknown>).count, 42)
  assertEquals((r2.state.counter as Record<string, unknown>)._status, 'idle')
})

Deno.test('compose: destroy action resets to initial state', () => {
  const composed = composeFeatures([counter])
  const r1 = composed.reduce(composed.initialState, counter.A.increment(10))
  const r2 = composed.reduce(r1.state, { type: 'Counter:Destroy', payload: {} })
  assertEquals((r2.state.counter as Record<string, unknown>).count, 0)
  assertEquals((r2.state.counter as Record<string, unknown>)._status, 'idle')
})

Deno.test('compose: initAll dispatches init for all features in order', () => {
  const dispatched: string[] = []
  const a = feature('alpha', { state: { x: 0 }, actions: { go: () => ({}) }, machine: 'simple', reduce() {} })
  const b = feature('beta', { state: { y: 0 }, actions: { go: () => ({}) }, machine: 'simple', reduce() {} })
  const composed = composeFeatures([a, { feature: b, dependsOn: ['alpha'] }])
  composed.initAll({
    dispatch: (action) => dispatched.push(action.type),
    getState: () => composed.initialState,
  })
  assertEquals(dispatched, ['Alpha:Init', 'Beta:Init'])
})

Deno.test('compose: destroyAll dispatches destroy in reverse order', () => {
  const dispatched: string[] = []
  const a = feature('alpha', { state: { x: 0 }, actions: { go: () => ({}) }, machine: 'simple', reduce() {} })
  const b = feature('beta', { state: { y: 0 }, actions: { go: () => ({}) }, machine: 'simple', reduce() {} })
  const composed = composeFeatures([a, { feature: b, dependsOn: ['alpha'] }])
  composed.destroyAll({
    dispatch: (action) => dispatched.push(action.type),
    getState: () => composed.initialState,
  })
  assertEquals(dispatched, ['Beta:Destroy', 'Alpha:Destroy'])
})

// ── Feature registry ──

Deno.test('compose: registry.health returns status for all features', () => {
  const composed = composeFeatures([counter])
  const health = composed.registry.health(composed.initialState)
  assertEquals(health.length, 1)
  assertEquals(health[0].name, 'counter')
  assertEquals(health[0].status, 'idle')
  assertEquals(health[0].enabled, true)
  assertEquals(health[0].errors, 0)
})

Deno.test('compose: registry.disable stops routing to feature', () => {
  const composed = composeFeatures([counter])
  composed.registry.disable('counter', (a) => { composed.reduce(composed.initialState, a) })
  assertEquals(composed.registry.isEnabled('counter'), false)
  // Action should be dropped
  const r = composed.reduce(composed.initialState, counter.A.increment(5))
  assertEquals((r.state.counter as Record<string, unknown>).count, 0) // unchanged
})

Deno.test('compose: registry.enable re-enables feature', () => {
  const composed = composeFeatures([counter])
  let state = { ...composed.initialState }
  composed.registry.disable('counter', (a) => {
    const r = composed.reduce(state, a)
    state = r.state
  })
  composed.registry.enable('counter', {
    dispatch: (a) => { const r = composed.reduce(state, a); state = r.state },
    getState: () => state,
  })
  assertEquals(composed.registry.isEnabled('counter'), true)
})

// ── Dead-end detection ──

Deno.test('feature: dead-end state warns (not throws)', () => {
  const warnings: string[] = []
  const origWarn = console.warn
  console.warn = (msg: string) => warnings.push(msg)
  feature('deadend', {
    state: {},
    actions: { go: () => ({}) },
    machine: { initial: 'a', states: { a: { on: { go: 'b' } }, b: { on: {} } } },
    reduce() {},
  })
  console.warn = origWarn
  assertEquals(warnings.some(w => w.includes('dead-end')), true)
})

// ── Init/Destroy types stored correctly ──

Deno.test('feature: lifecycle types generated', () => {
  assertEquals(counter._config.initType, 'Counter:Init')
  assertEquals(counter._config.destroyType, 'Counter:Destroy')
})

// ── Circuit breaker in bridge ──

Deno.test('bridge: circuit breaker opens after failures', () => {
  const b = bridge('cb-bridge', {
    from: 'a', to: 'b',
    channels: {
      data: { request: (x: string) => ({ x }), response: (y: number) => ({ y }), timeout: 1000 },
    },
    circuitBreaker: { failureThreshold: 3, resetTimeout: 5000 },
  })
  const composed = composeFeatures([b])
  let state = { ...composed.initialState }

  // Make 3 requests and timeout each
  for (let i = 0; i < 3; i++) {
    const req = b.request!.data('test')
    const r1 = composed.reduce(state, req)
    state = r1.state
    const id = (req.payload as Record<string, string>)._correlationId
    const r2 = composed.reduce(state, { type: 'Cb-bridge:DataTimeout', payload: { _correlationId: id, _channel: 'data' } })
    state = r2.state
  }

  // Circuit should be open
  assertEquals(b.selectors.isCircuitOpen(state), true)

  // New request should be rejected (state unchanged)
  const pending1 = Object.keys((state['cb-bridge'] as Record<string, Record<string, unknown>>).pending).length
  const req = b.request!.data('blocked')
  const r3 = composed.reduce(state, req)
  const pending2 = Object.keys((r3.state['cb-bridge'] as Record<string, Record<string, unknown>>).pending).length
  assertEquals(pending2, pending1) // no new pending
})

// ── testBridge harness ──

testBridge(
  bridge('tb-test', {
    from: 'x', to: 'y',
    channels: {
      info: { request: (q: string) => ({ q }), response: (r: string) => ({ r }), timeout: 1000 },
    },
  }),
  'happy path request/response',
  (t) => {
    t.request.info('hello')
    t.expect.pending(1)
    t.respond.info('world')
    t.expect.pending(0)
  },
)

testBridge(
  bridge('tb-cb', {
    from: 'x', to: 'y',
    channels: {
      data: { request: (x: string) => ({ x }), response: (y: number) => ({ y }), timeout: 1000 },
    },
    circuitBreaker: { failureThreshold: 2, resetTimeout: 5000 },
  }),
  'circuit breaker opens on repeated timeouts',
  (t) => {
    t.request.data('a')
    t.timeout()
    t.request.data('b')
    t.timeout()
    t.expect.circuitOpen(true)
  },
)

// ── Integration: multi-feature app ──

Deno.test('integration: multi-feature app with cross-feature listening', () => {
  const dc = feature('dc', {
    state: { price: 0 },
    actions: { setPrice: (price: number) => ({ price }) },
    machine: { initial: 'ready', states: { ready: { on: { setPrice: 'ready' } } } },
    reduce(state, action, { A }) {
      if (action.type === A.SetPrice) state.price = action.payload.price
    },
    selectors: {
      getPrice: (s: unknown) => (s as Record<string, Record<string, number>>).dc.price,
    },
  })

  const te = feature('te', {
    state: { lastPrice: 0, orderCount: 0 },
    actions: {
      placeOrder: () => ({}),
    },
    machine: {
      initial: 'idle',
      states: {
        idle: { on: { placeOrder: 'idle', [dc.A.SetPrice]: 'idle' } },
      },
    },
    reduce(state, action, { A }) {
      if (action.type === A.PlaceOrder) {
        state.orderCount += 1
      }
      if (action.type === dc.A.SetPrice) {
        state.lastPrice = action.payload.price
      }
    },
  })

  const composed = composeFeatures([
    dc,
    { feature: te, dependsOn: ['dc'] },
  ])

  // DC action routes to both DC (owner) and TE (listener)
  const r = composed.reduce(composed.initialState, dc.A.setPrice(50000))
  assertEquals((r.state.dc as Record<string, unknown>).price, 50000)
  assertEquals((r.state.te as Record<string, unknown>).lastPrice, 50000)

  // TE's own action only routes to TE
  const r2 = composed.reduce(r.state, te.A.placeOrder())
  assertEquals((r2.state.te as Record<string, unknown>).orderCount, 1)
  assertEquals((r2.state.dc as Record<string, unknown>).price, 50000) // unchanged
})

// ── Middleware ──

Deno.test('aio.middleware.logger: logs actions', () => {
  const logs: string[] = []
  const origLog = console.log
  console.log = (msg: string) => logs.push(msg)
  const mw = aio.middleware.logger()
  const result = mw({ type: 'Counter:Increment', payload: {} }, {})
  console.log = origLog
  assertEquals(result !== null, true) // not dropped
  assertEquals(logs.some(l => l.includes('Counter:Increment')), true)
})

Deno.test('aio.middleware.logger: filters by feature', () => {
  const logs: string[] = []
  const origLog = console.log
  console.log = (msg: string) => logs.push(msg)
  const mw = aio.middleware.logger({ features: ['counter'] })
  mw({ type: 'Counter:Increment', payload: {} }, {})
  mw({ type: 'Other:Action', payload: {} }, {})
  console.log = origLog
  assertEquals(logs.length, 1) // only counter logged
  assertEquals(logs[0].includes('Counter:Increment'), true)
})

Deno.test('aio.middleware.validate: rejects non-string type', () => {
  const errors: string[] = []
  const origError = console.error
  console.error = (msg: string) => errors.push(msg)
  const mw = aio.middleware.validate()
  const result = mw({ type: 123, payload: {} }, {})
  console.error = origError
  assertEquals(result, null)
  assertEquals(errors.some(e => e.includes('must be a string')), true)
})

Deno.test('aio.middleware.validate: passes valid actions', () => {
  const mw = aio.middleware.validate()
  const result = mw({ type: 'Counter:Increment', payload: { by: 1 } }, {})
  assertEquals(result !== null, true)
})

Deno.test('aio.middleware.metrics: tracks action counts', () => {
  const mw = aio.middleware.metrics()
  mw({ type: 'Counter:Increment', payload: {} }, {})
  mw({ type: 'Counter:Increment', payload: {} }, {})
  mw({ type: 'Other:Action', payload: {} }, {})
  const counters = (globalThis as Record<string, unknown>).__aioMetrics as Map<string, { count: number }>
  assertEquals(counters.get('Counter')?.count, 2)
  assertEquals(counters.get('Other')?.count, 1)
  // Clean up
  delete (globalThis as Record<string, unknown>).__aioMetrics
})

Deno.test('aio.middleware.create: custom middleware', () => {
  const mw = aio.middleware.create((action, _state, next) => {
    const a = action as { type: string; timestamp?: number }
    return next({ ...a, timestamp: 42 })
  })
  const result = mw({ type: 'Test', payload: {} }, {}) as { timestamp?: number }
  assertEquals(result.timestamp, 42)
})

// ── Bridge retries ──

Deno.test('bridge: retry on timeout', () => {
  const b = bridge('retry-bridge', {
    from: 'a', to: 'b',
    channels: {
      data: { request: (x: string) => ({ x }), response: (y: number) => ({ y }), timeout: 1000, retries: 2 },
    },
  })
  const composed = composeFeatures([b])
  let state = { ...composed.initialState }

  // Send request
  const req = b.request!.data('test')
  const r1 = composed.reduce(state, req)
  state = r1.state
  const id = (req.payload as Record<string, string>)._correlationId

  // Timeout — should retry (still pending)
  const r2 = composed.reduce(state, { type: 'Retry-bridge:DataTimeout', payload: { _correlationId: id, _channel: 'data' } })
  state = r2.state
  const pending = (state['retry-bridge'] as Record<string, Record<string, Record<string, unknown>>>).pending
  assertEquals(id in pending, true) // still pending (retried)
  assertEquals(pending[id].retryCount, 1)
  assertEquals(r2.effects.length, 1) // new timer effect
})

// ── Additional coverage ──────────────────────────────────────────

// feature() edge cases

Deno.test('feature: no effects config produces empty E catalog', () => {
  const f = feature('bare', {
    state: { x: 0 },
    actions: { go: () => ({}) },
    machine: 'simple',
    reduce() {},
  })
  assertEquals(f._config.effectKeys.length, 0)
})

Deno.test('feature: multiple action creators return correct types', () => {
  const f = feature('multi', {
    state: {},
    actions: {
      alpha: (a: string) => ({ a }),
      beta: (b: number, c: boolean) => ({ b, c }),
    },
    machine: 'simple',
    reduce() {},
  })
  assertEquals(f.A.Alpha, 'Multi:Alpha')
  assertEquals(f.A.Beta, 'Multi:Beta')
  const action = f.A.beta(42, true)
  assertEquals(action.payload.b, 42)
  assertEquals(action.payload.c, true)
})

Deno.test('feature: init/destroy config stored in _config', () => {
  let initCalled = false
  let destroyCalled = false
  const f = feature('lifecycle', {
    state: {},
    actions: { go: () => ({}) },
    machine: 'simple',
    reduce() {},
    init() { initCalled = true },
    destroy() { destroyCalled = true },
  })
  assertEquals(typeof f._config.onInit, 'function')
  assertEquals(typeof f._config.onDestroy, 'function')
  f._config.onInit!({ dispatch: () => {}, getState: () => ({}) })
  f._config.onDestroy!({ dispatch: () => {}, getState: () => ({}) })
  assertEquals(initCalled, true)
  assertEquals(destroyCalled, true)
})

// compose: simple machine — no _status, all actions pass

Deno.test('compose: simple machine accepts all actions', () => {
  const f = feature('flex', {
    state: { n: 0 },
    actions: { a: () => ({}), b: () => ({}) },
    machine: 'simple',
    reduce(state, action, { A }) {
      if (action.type === A.A) state.n += 1
      if (action.type === A.B) state.n += 10
    },
  })
  const composed = composeFeatures([f])
  let state = composed.initialState
  const r1 = composed.reduce(state, f.A.a())
  state = r1.state
  const r2 = composed.reduce(state, f.A.b())
  assertEquals((r2.state.flex as Record<string, number>).n, 11)
})

// compose: disabled feature executor doesn't run

Deno.test('compose: disabled feature executor does not run', () => {
  let executed = false
  const f = feature('ex', {
    state: {},
    actions: { go: () => ({}) },
    effects: { run: () => ({}) },
    machine: 'simple',
    reduce(_s, _a, { E }) { return [E.run()] },
    execute() { executed = true },
  })
  const composed = composeFeatures([f])
  composed.registry.disable('ex', () => {})
  composed.execute({ dispatch: () => {}, getState: () => composed.initialState }, { type: 'Ex:Run', payload: {} })
  assertEquals(executed, false)
})

// compose: executor error increments error count

Deno.test('compose: executor error tracked in registry health', () => {
  const origError = console.error
  console.error = () => {} // suppress
  const f = feature('err', {
    state: {},
    actions: { go: () => ({}) },
    effects: { boom: () => ({}) },
    machine: 'simple',
    reduce(_s, _a, { E }) { return [E.boom()] },
    execute() { throw new Error('kaboom') },
  })
  const composed = composeFeatures([f])
  composed.execute({ dispatch: () => {}, getState: () => composed.initialState }, { type: 'Err:Boom', payload: {} })
  const health = composed.registry.health(composed.initialState)
  console.error = origError
  assertEquals(health[0].errors, 1)
})

// compose: registry.status reads _status from state

Deno.test('compose: registry.status reads current machine state', () => {
  const composed = composeFeatures([counter])
  const r1 = composed.reduce(composed.initialState, counter.A.save())
  assertEquals(composed.registry.status('counter', r1.state), 'saving')
})

// compose: registry.status for unknown feature

Deno.test('compose: registry.status returns undefined for unknown feature', () => {
  const composed = composeFeatures([counter])
  assertEquals(composed.registry.status('nonexistent', composed.initialState), undefined)
})

// compose: featureNames lists all features

Deno.test('compose: featureNames matches features array', () => {
  const a = feature('fa', { state: {}, actions: { x: () => ({}) }, machine: 'simple', reduce() {} })
  const b = feature('fb', { state: {}, actions: { x: () => ({}) }, machine: 'simple', reduce() {} })
  const composed = composeFeatures([a, b])
  assertEquals(composed.featureNames, ['fa', 'fb'])
  assertEquals(composed.features.length, 2)
})

// tagSource: preserves existing payload fields

Deno.test('tagSource: preserves all original fields', () => {
  const msg = { type: 'X:Y', payload: { a: 1, b: 'two' } }
  const tagged = tagSource(msg, 'Test')
  assertEquals(tagged.type, 'X:Y')
  assertEquals(tagged.payload.a, 1)
  assertEquals(tagged.payload.b, 'two')
  assertEquals(tagged._source, 'Test')
})

// tagSource: overrides existing _source

Deno.test('tagSource: overrides existing _source', () => {
  const msg = { type: 'X:Y', payload: {}, _source: 'UI' as const }
  const tagged = tagSource(msg, 'System')
  assertEquals(tagged._source, 'System')
})

// bridge: metrics track correctly

Deno.test('bridge: metrics update on request and response', () => {
  const b = bridge('m-bridge', {
    from: 'a', to: 'b',
    channels: {
      data: { request: (x: string) => ({ x }), response: (y: number) => ({ y }) },
    },
  })
  const composed = composeFeatures([b])
  let state = { ...composed.initialState }

  const req = b.request!.data('test')
  const r1 = composed.reduce(state, req)
  state = r1.state
  const metrics = (state['m-bridge'] as Record<string, Record<string, number>>).metrics
  assertEquals(metrics.totalRequests, 1)

  const id = (req.payload as Record<string, string>)._correlationId
  const r2 = composed.reduce(state, { type: 'M-bridge:DataResponse', payload: { y: 42, _correlationId: id, _channel: 'data' } })
  state = r2.state
  const m2 = (state['m-bridge'] as Record<string, Record<string, number>>).metrics
  assertEquals(m2.totalResponses, 1)
})

// bridge: getPendingCount selector

Deno.test('bridge: getPendingCount selector', () => {
  const b = bridge('sel-bridge', {
    from: 'a', to: 'b',
    channels: {
      data: { request: (x: string) => ({ x }), response: (y: number) => ({ y }) },
    },
  })
  const composed = composeFeatures([b])
  assertEquals(b.selectors.getPendingCount(composed.initialState), 0)

  const req = b.request!.data('test')
  const r1 = composed.reduce(composed.initialState, req)
  assertEquals(b.selectors.getPendingCount(r1.state), 1)
})

// bridge: getAverageLatency selector

Deno.test('bridge: getAverageLatency returns 0 with no responses', () => {
  const b = bridge('lat-bridge', {
    from: 'a', to: 'b',
    channels: {
      data: { request: (x: string) => ({ x }), response: (y: number) => ({ y }) },
    },
  })
  const composed = composeFeatures([b])
  assertEquals(b.selectors.getAverageLatency(composed.initialState), 0)
})

// bridge: retry exhaustion removes from pending

Deno.test('bridge: retries exhausted removes pending entry', () => {
  const b = bridge('exhaust-bridge', {
    from: 'a', to: 'b',
    channels: {
      data: { request: (x: string) => ({ x }), response: (y: number) => ({ y }), timeout: 100, retries: 1 },
    },
  })
  const composed = composeFeatures([b])
  let state = { ...composed.initialState }

  const req = b.request!.data('test')
  const r1 = composed.reduce(state, req)
  state = r1.state
  const id = (req.payload as Record<string, string>)._correlationId

  // First timeout — retry
  const r2 = composed.reduce(state, { type: 'Exhaust-bridge:DataTimeout', payload: { _correlationId: id, _channel: 'data' } })
  state = r2.state
  assertEquals(Object.keys((state['exhaust-bridge'] as Record<string, Record<string, unknown>>).pending).length, 1)

  // Second timeout — exhausted, removed
  const r3 = composed.reduce(state, { type: 'Exhaust-bridge:DataTimeout', payload: { _correlationId: id, _channel: 'data' } })
  state = r3.state
  assertEquals(Object.keys((state['exhaust-bridge'] as Record<string, Record<string, unknown>>).pending).length, 0)
})

// bridge: circuit breaker half-open on reset timeout

Deno.test('bridge: circuit breaker resets after successful response in half-open', () => {
  const b = bridge('reset-bridge', {
    from: 'a', to: 'b',
    channels: {
      data: { request: (x: string) => ({ x }), response: (y: number) => ({ y }), timeout: 100 },
    },
    circuitBreaker: { failureThreshold: 1, resetTimeout: 0 }, // instant reset for test
  })
  const composed = composeFeatures([b])
  let state = { ...composed.initialState }

  // Trigger open
  const req1 = b.request!.data('test')
  const r1 = composed.reduce(state, req1)
  state = r1.state
  const id1 = (req1.payload as Record<string, string>)._correlationId
  const r2 = composed.reduce(state, { type: 'Reset-bridge:DataTimeout', payload: { _correlationId: id1, _channel: 'data' } })
  state = r2.state
  assertEquals(b.selectors.isCircuitOpen(state), true)

  // resetTimeout=0: next request should succeed (half-open)
  const req2 = b.request!.data('probe')
  const r3 = composed.reduce(state, req2)
  state = r3.state
  const id2 = (req2.payload as Record<string, string>)._correlationId
  assertEquals(Object.keys((state['reset-bridge'] as Record<string, Record<string, unknown>>).pending).length, 1)

  // Successful response resets circuit to closed
  const r4 = composed.reduce(state, { type: 'Reset-bridge:DataResponse', payload: { y: 1, _correlationId: id2, _channel: 'data' } })
  state = r4.state
  assertEquals(b.selectors.isCircuitOpen(state), false)
})

// testFeature: getState returns full slice

testFeature<{ count: number; lastUpdatedAt: number; error: string | null }>(
  counter,
  'getState includes _status',
  (t) => {
    t.init()
    const s = t.getState()
    assertEquals(s._status, 'idle')
    assertEquals(s.count, 0)
  },
)

// testFeature: getEffects returns empty after init

testFeature<{ count: number; lastUpdatedAt: number; error: string | null }>(
  counter,
  'getEffects returns last effects',
  (t) => {
    t.init()
    assertEquals(t.getEffects().length, 0)
    t.send.increment(1)
    assertEquals(t.getEffects().length, 1) // Log effect
    t.send.decrement(1)
    assertEquals(t.getEffects().length, 0) // decrement has no effects
  },
)

// testBridge: multiple requests tracked separately

testBridge(
  bridge('multi-req', {
    from: 'x', to: 'y',
    channels: {
      info: { request: (q: string) => ({ q }), response: (r: string) => ({ r }) },
    },
  }),
  'multiple requests tracked',
  (t) => {
    t.request.info('a')
    t.request.info('b')
    // Note: testBridge tracks last correlation ID, so pending count includes both
    const state = t.getState()
    const pending = state.pending as Record<string, unknown>
    assertEquals(Object.keys(pending).length, 2)
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

// ── implement() — deferred executor attachment ──────────────────────

Deno.test('implement: attaches execute to feature without one', () => {
  const bare = feature('bare', {
    state: { v: 0 },
    actions: { set: (v: number) => ({ v }) },
    effects: { log: (msg: string) => ({ msg }) },
    machine: 'simple',
    reduce(state, action, { A }) {
      if (action.type === A.Set) state.v = action.payload.v
    },
  })
  assertEquals(bare._config.execute, undefined)

  let called = false
  bare.implement((_app, _effect, _ctx) => { called = true })
  assertEquals(typeof bare._config.execute, 'function')

  // Call it to verify it's wired
  const ctx = { E: bare.E, A: bare.A }
  bare._config.execute!({ dispatch: () => {}, getState: () => ({}) }, { type: 'Bare:Log', payload: { msg: 'hi' } }, ctx)
  assertEquals(called, true)
})

Deno.test('implement: overrides existing execute', () => {
  let which = ''
  const f = feature('over', {
    state: {},
    actions: { go: () => ({}) },
    machine: 'simple',
    reduce() {},
    execute() { which = 'original' },
  })
  const ctx = { E: f.E, A: f.A }
  f._config.execute!({ dispatch: () => {}, getState: () => ({}) }, { type: 'Over:Go', payload: {} }, ctx)
  assertEquals(which, 'original')

  f.implement(() => { which = 'replaced' })
  f._config.execute!({ dispatch: () => {}, getState: () => ({}) }, { type: 'Over:Go', payload: {} }, ctx)
  assertEquals(which, 'replaced')
})

// ── Fix A: ScheduleEffect in reduce return ──

Deno.test('reduce: accepts ScheduleEffect in effects array', () => {
  const f = feature('sched', {
    state: { count: 0 },
    actions: { tick: () => ({}) },
    effects: { log: (msg: string) => ({ msg }) },
    machine: 'simple',
    reduce(_state, _action, { E }) {
      return [
        E.log('hello'),
        schedule.after('sched:retry', 1000, { type: 'Sched:Tick', payload: {} }),
      ]
    },
  })
  const composed = composeFeatures([f])
  const result = composed.reduce(composed.initialState, f.A.tick())
  assertEquals(result.effects.length, 2)
  assertEquals(result.effects[0].type, 'Sched:Log')
  assertEquals(result.effects[1].type, '__schedule')
})

// ── Fix C: crossDispatch allowlist ──

Deno.test('compose: crossDispatch allows dispatching to allowlisted features', () => {
  const dispatched: string[] = []
  const alpha = feature('alpha', {
    state: {},
    actions: { go: () => ({}) },
    effects: { sync: () => ({}) },
    machine: 'simple',
    crossDispatch: ['beta'],
    reduce(_s, _a, { E }) { return [E.sync()] },
    execute(app) {
      app.dispatch({ type: 'Beta:Update', payload: {} })
    },
  })
  const beta = feature('beta', {
    state: { updated: false },
    actions: { update: () => ({}) },
    machine: 'simple',
    reduce(state) { state.updated = true },
  })
  const composed = composeFeatures([alpha, beta])
  composed.execute(
    { dispatch: (a) => dispatched.push(a.type), getState: () => composed.initialState },
    { type: 'Alpha:Sync', payload: {} },
  )
  assertEquals(dispatched.includes('Beta:Update'), true)
})

Deno.test('compose: crossDispatch blocks non-allowlisted features', () => {
  let errorLogged = false
  const origError = console.error
  console.error = (msg: string) => { if (String(msg).includes('blocked')) errorLogged = true }

  const alpha = feature('alpha', {
    state: {},
    actions: { go: () => ({}) },
    effects: { bad: () => ({}) },
    machine: 'simple',
    crossDispatch: ['gamma'],  // beta NOT in allowlist
    reduce(_s, _a, { E }) { return [E.bad()] },
    execute(app) {
      app.dispatch({ type: 'Beta:Update', payload: {} })
    },
  })
  const beta = feature('beta', {
    state: {},
    actions: { update: () => ({}) },
    machine: 'simple',
    reduce() {},
  })
  const dispatched: string[] = []
  const composed = composeFeatures([alpha, beta])
  composed.execute(
    { dispatch: (a) => dispatched.push(a.type), getState: () => composed.initialState },
    { type: 'Alpha:Bad', payload: {} },
  )
  assertEquals(dispatched.includes('Beta:Update'), false)
  assertEquals(errorLogged, true)
  console.error = origError
})

Deno.test('compose: dispatch without crossDispatch blocks all foreign actions', () => {
  let errorLogged = false
  const origError = console.error
  console.error = (msg: string) => { if (String(msg).includes('blocked')) errorLogged = true }

  const alpha = feature('alpha', {
    state: {},
    actions: { go: () => ({}) },
    effects: { bad: () => ({}) },
    machine: 'simple',
    // no crossDispatch
    reduce(_s, _a, { E }) { return [E.bad()] },
    execute(app) {
      app.dispatch({ type: 'Beta:Update', payload: {} })
    },
  })
  const beta = feature('beta', {
    state: {},
    actions: { update: () => ({}) },
    machine: 'simple',
    reduce() {},
  })
  const dispatched: string[] = []
  const composed = composeFeatures([alpha, beta])
  composed.execute(
    { dispatch: (a) => dispatched.push(a.type), getState: () => composed.initialState },
    { type: 'Alpha:Bad', payload: {} },
  )
  assertEquals(dispatched.includes('Beta:Update'), false)
  assertEquals(errorLogged, true)
  console.error = origError
})

// ── Verify: machine: 'simple' does NOT receive foreign actions ──

Deno.test('compose: machine simple does not receive foreign actions', () => {
  let betaReduced = false
  const alpha = feature('alpha', {
    state: {},
    actions: { fire: () => ({}) },
    machine: 'simple',
    reduce() {},
  })
  const beta = feature('beta', {
    state: { heard: false },
    actions: { update: () => ({}) },
    machine: 'simple',
    reduce(state, action) {
      if (action.type === 'Alpha:Fire') {
        betaReduced = true
        state.heard = true
      }
    },
  })
  const composed = composeFeatures([alpha, beta])
  const result = composed.reduce(composed.initialState, alpha.A.fire())
  // beta should NOT have received the action — machine: 'simple' can't declare foreign listeners
  assertEquals(betaReduced, false)
  assertEquals((result.state.beta as Record<string, unknown>).heard, false)
})

Deno.test('compose: machine with foreign action declaration DOES receive foreign actions', () => {
  let betaReduced = false
  const alpha = feature('alpha', {
    state: {},
    actions: { fire: () => ({}) },
    machine: 'simple',
    reduce() {},
  })
  const beta = feature('beta', {
    state: { heard: false },
    actions: { update: () => ({}) },
    machine: {
      initial: 'idle',
      states: {
        idle: { on: { update: 'idle', [alpha.A.Fire]: 'idle' } },
      },
    },
    reduce(state, action) {
      if (action.type === 'Alpha:Fire') {
        betaReduced = true
        state.heard = true
      }
    },
  })
  const composed = composeFeatures([alpha, beta])
  const result = composed.reduce(composed.initialState, alpha.A.fire())
  assertEquals(betaReduced, true)
  assertEquals((result.state.beta as Record<string, unknown>).heard, true)
})
