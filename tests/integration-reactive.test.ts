// integration-reactive.test.ts — reactive() integration with compose pipeline
import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import { reactive } from '../src/reactive.ts'
import { feature, composeFeatures } from '../src/feature.ts'

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Full dispatch loop with init/destroy lifecycle */
function createApp(composed: ReturnType<typeof composeFeatures>) {
  let state = composed.initialState
  const history: { type: string }[] = []
  const app = {
    dispatch: (action: { type: string; payload: unknown }) => {
      history.push(action)
      const result = composed.reduce(state, action)
      state = result.state
      for (const eff of result.effects) {
        composed.execute(app, eff as { type: string; payload: unknown })
      }
    },
    getState: () => state,
    get state() { return state },
    get history() { return history },
  }
  return app
}

// ── Multi-feature reactive composition ──────────────────────────────

Deno.test('integration: two reactive features compose independently', () => {
  const counter = reactive('counter', {
    state: { count: 0 },
    methods: {
      increment(s) { s.count++ },
      decrement(s) { s.count-- },
    },
  })

  const todo = reactive('todo', {
    state: { items: [] as string[] },
    methods: {
      add(s, item: string) { s.items.push(item) },
    },
  })

  const composed = composeFeatures([counter, todo])
  const app = createApp(composed)

  app.dispatch(counter.A.increment())
  app.dispatch(counter.A.increment())
  app.dispatch(todo.A.add('buy milk'))
  app.dispatch(counter.A.decrement())

  assertEquals((app.state.counter as any).count, 1)
  assertEquals((app.state.todo as any).items, ['buy milk'])
})

// ── Reactive + event-driven cross-feature ───────────────────────────

Deno.test('integration: event-driven feature reacts to reactive feature actions', () => {
  const cart = reactive('cart', {
    state: { items: [] as string[] },
    methods: {
      addItem(s, item: string) { s.items.push(item) },
      clear(s) { s.items = [] },
    },
  })

  const stats = feature('stats', {
    state: { addCount: 0, clearCount: 0 },
    actions: { noop: () => ({}) },
    machine: {
      initial: 'active',
      states: {
        active: { on: { noop: 'active', 'Cart:AddItem': 'active', 'Cart:Clear': 'active' } },
      },
    },
    reduce(state, action) {
      if (action.type === 'Cart:AddItem') state.addCount++
      if (action.type === 'Cart:Clear') state.clearCount++
    },
  })

  const composed = composeFeatures([cart, stats])
  const app = createApp(composed)

  app.dispatch(cart.A.addItem('a'))
  app.dispatch(cart.A.addItem('b'))
  app.dispatch(cart.A.clear())
  app.dispatch(cart.A.addItem('c'))

  assertEquals((app.state.cart as any).items, ['c'])
  assertEquals((app.state.stats as any).addCount, 3)
  assertEquals((app.state.stats as any).clearCount, 1)
})

// ── Async reactive + sync reactive interaction ──────────────────────

Deno.test('integration: async reactive method with machine + sync methods', async () => {
  const workflow = reactive('workflow', {
    state: { step: 'none', data: null as string | null },
    machine: {
      initial: 'idle',
      states: {
        idle:       { on: { start: 'running' } },
        running:    { on: { complete: 'idle' } },
      },
    },
    methods: {
      async start(s) {
        s.step = 'fetching'
        const result = await Promise.resolve('fetched-data')
        s.data = result
        s.step = 'done'
      },
      complete(s) { s.step = 'completed' },
    },
  })

  const composed = composeFeatures([workflow])
  const app = createApp(composed)

  app.dispatch(workflow.A.start())
  await delay(50)

  assertEquals((app.state.workflow as any).data, 'fetched-data')
  assertEquals((app.state.workflow as any).step, 'done')
  assertEquals((app.state.workflow as any)._status, 'running')

  // Transition back to idle
  app.dispatch(workflow.A.complete())
  assertEquals((app.state.workflow as any)._status, 'idle')
})

// ── Lifecycle hooks with multiple reactive features ─────────────────

Deno.test('integration: init and destroy across multiple reactive features', () => {
  const log: string[] = []

  const a = reactive('alpha', {
    state: { ready: false },
    methods: { activate(s) { s.ready = true } },
    init: () => { log.push('alpha:init') },
    destroy: () => { log.push('alpha:destroy') },
  })

  const b = reactive('beta', {
    state: { ready: false },
    methods: { activate(s) { s.ready = true } },
    init: () => { log.push('beta:init') },
    destroy: () => { log.push('beta:destroy') },
  })

  const composed = composeFeatures([a, b])
  const app = createApp(composed)

  composed.initAll(app)
  assertEquals(log, ['alpha:init', 'beta:init'])

  composed.destroyAll(app)
  // Destroy runs in reverse order
  assertEquals(log, ['alpha:init', 'beta:init', 'beta:destroy', 'alpha:destroy'])
})

// ── Selectors across composed features ──────────────────────────────

Deno.test('integration: selectors work across composed reactive features', () => {
  const prices = reactive('prices', {
    state: { items: [{ name: 'A', price: 10 }, { name: 'B', price: 20 }] },
    methods: {
      addItem(s, name: string, price: number) { s.items.push({ name, price }) },
    },
    selectors: {
      total: (s) => s.items.reduce((sum: number, i: { price: number }) => sum + i.price, 0),
      count: (s) => s.items.length,
    },
  })

  const composed = composeFeatures([prices])
  let state = composed.initialState

  assertEquals(prices.selectors.total(state), 30)
  assertEquals(prices.selectors.count(state), 2)

  state = composed.reduce(state, prices.A.addItem('C', 15)).state
  assertEquals(prices.selectors.total(state), 45)
  assertEquals(prices.selectors.count(state), 3)
})

// ── Batching across await boundaries ────────────────────────────────

Deno.test('integration: batching produces correct action count across awaits', async () => {
  const store = reactive('store', {
    state: { a: 0, b: 0, c: 0, d: 0 },
    methods: {
      async multiStep(s) {
        // Batch 1: two writes before await
        s.a = 1
        s.b = 2
        await delay(10)
        // Batch 2: two writes after await
        s.c = 3
        s.d = 4
      },
    },
  })

  const composed = composeFeatures([store])
  const app = createApp(composed)

  app.dispatch(store.A.multiStep())
  await delay(50)

  assertEquals((app.state.store as any).a, 1)
  assertEquals((app.state.store as any).b, 2)
  assertEquals((app.state.store as any).c, 3)
  assertEquals((app.state.store as any).d, 4)

  // 1 trigger + 2 batched __set = 3 total actions
  const setActions = app.history.filter(a => a.type.includes('__set'))
  assertEquals(setActions.length, 2)
})
