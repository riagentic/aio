import { assertEquals, assertExists } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { feature, composeFeatures } from '../src/feature.ts'

// ── Helpers ──────────────────────────────────────────────────────────

/** Mini dispatch loop for testing — processes actions + effects synchronously where possible */
function createTestApp(entries: Parameters<typeof composeFeatures>[0]) {
  const composed = composeFeatures(entries)
  let state = { ...composed.initialState }
  const dispatched: { type: string; payload: unknown }[] = []

  const app = {
    dispatch(action: { type: string; payload: unknown }) {
      dispatched.push(action)
      const result = composed.reduce(state, action)
      state = { ...result.state }
      for (const effect of result.effects) {
        composed.execute(app, effect as { type: string; payload: unknown })
      }
    },
    getState: () => state,
    dispatched,
    /** Wait for async flows to complete */
    flush: () => new Promise<void>(resolve => setTimeout(resolve, 50)),
  }

  return app
}

// ── Basic flow ───────────────────────────────────────────────────────

const basic = feature('basic', {
  state: { value: 0, done: false },
  actions: {
    start: (n: number) => ({ n }),
  },
  machine: {
    initial: 'idle',
    states: {
      idle: { start: 'busy' },
      busy: {},
    },
  },
  generators: {
    // ctx is GenCtx<{ value: number; done: boolean }> — inferred, no annotation needed
    start: function* (ctx, { n }: { n: number }) {
      const doubled = yield* ctx.call('double', () => Promise.resolve(n * 2))
      yield* ctx.mutate('setValue', s => { s.value = doubled })  // s.value typed as number
      yield* ctx.done(s => { s.done = true })                    // s.done typed as boolean
    },
  },
})

Deno.test('flow: basic flow dispatches step actions', async () => {
  const app = createTestApp([basic])
  app.dispatch(basic.A.start(5))
  await app.flush()

  const types = app.dispatched.map(d => d.type)
  assertEquals(types.includes('basic:flow:double'), true)
  assertEquals(types.includes('basic:flow:setValue'), true)
  assertEquals(types.includes('basic:flow:done'), true)
})

Deno.test('flow: basic flow updates state', async () => {
  const app = createTestApp([basic])
  app.dispatch(basic.A.start(5))
  await app.flush()

  const s = app.getState().basic as { value: number; done: boolean }
  assertEquals(s.value, 10)
  assertEquals(s.done, true)
})

// ── Flow-only feature (no reduce) ────────────────────────────────────

const flowOnly = feature('flowOnly', {
  state: { result: '' },
  actions: {
    go: (input: string) => ({ input }),
  },
  generators: {
    go: function* (ctx, { input }: { input: string }) {
      const upper = yield* ctx.call('transform', () => Promise.resolve(input.toUpperCase()))
      yield* ctx.done(s => { s.result = upper })  // s.result typed as string, upper is string
    },
  },
})

Deno.test('flow: feature with only generators (no reduce)', async () => {
  const app = createTestApp([flowOnly])
  app.dispatch(flowOnly.A.go('hello'))
  await app.flush()

  const s = app.getState().flowOnly as { result: string }
  assertEquals(s.result, 'HELLO')
})

// ── Mixed feature (reduce + generators) ──────────────────────────────

const mixed = feature('mixed', {
  state: { count: 0, synced: false },
  actions: {
    increment: (by = 1) => ({ by }),
    sync: () => ({}),
  },
  machine: {
    initial: 'idle',
    states: {
      idle: { increment: 'idle', sync: 'syncing' },
      syncing: {},
    },
  },
  reduce: {
    increment(state, payload) { state.count += (payload as { by: number }).by },
  },
  generators: {
    sync: function* (ctx) {
      yield* ctx.call('doSync', () => Promise.resolve())
      yield* ctx.done(s => { s.synced = true })  // s.synced typed as boolean
    },
  },
})

Deno.test('flow: mixed feature — reduce works independently', () => {
  const app = createTestApp([mixed])
  app.dispatch(mixed.A.increment(5))
  const s = app.getState().mixed as { count: number }
  assertEquals(s.count, 5)
})

Deno.test('flow: mixed feature — generator works alongside reduce', async () => {
  const app = createTestApp([mixed])
  app.dispatch(mixed.A.increment(3))
  app.dispatch(mixed.A.sync())
  await app.flush()

  const s = app.getState().mixed as { count: number; synced: boolean }
  assertEquals(s.count, 3)
  assertEquals(s.synced, true)
})

// ── Generator with ctx.dispatch ───────────────────────────────────────

const putter = feature('putter', {
  state: { step: '' },
  actions: {
    start: () => ({}),
    update: (step: string) => ({ step }),
  },
  machine: {
    initial: 'idle',
    states: {
      idle: { start: 'busy', update: 'idle' },
      busy: { update: 'idle' },
    },
  },
  reduce: {
    update(state, payload) { state.step = (payload as { step: string }).step },
  },
  generators: {
    start: function* (ctx) {
      yield* ctx.dispatch({ type: 'putter:update', payload: { step: 'from-flow' } })
    },
  },
})

Deno.test('flow: ctx.dispatch dispatches regular action', async () => {
  const app = createTestApp([putter])
  app.dispatch(putter.A.start())
  await app.flush()

  const s = app.getState().putter as { step: string }
  assertEquals(s.step, 'from-flow')
})

// ── ctx.send shorthand ────────────────────────────────────────────────

const sender = feature('sender', {
  state: { step: '' },
  actions: {
    start: () => ({}),
    update: (step: string) => ({ step }),
  },
  machine: {
    initial: 'idle',
    states: {
      idle: { start: 'busy', update: 'idle' },
      busy: { update: 'idle' },
    },
  },
  reduce: {
    update(state, payload) { state.step = (payload as { step: string }).step },
  },
  generators: {
    start: function* (ctx) {
      // ctx.send — shorthand for ctx.dispatch; string form used here to avoid circular ref
      yield* ctx.send('sender:update', { step: 'via-send' })
    },
  },
})

Deno.test('flow: ctx.send dispatches via bound creator', async () => {
  const app = createTestApp([sender])
  app.dispatch(sender.A.start())
  await app.flush()

  const s = app.getState().sender as { step: string }
  assertEquals(s.step, 'via-send')
})

// ── Generator with ctx.fail ───────────────────────────────────────────

const failer = feature('failer', {
  state: { value: 0 },
  actions: {
    start: () => ({}),
  },
  machine: {
    initial: 'idle',
    states: {
      idle: { start: 'busy' },
      busy: {},
    },
  },
  generators: {
    start: function* (ctx) {
      yield* ctx.call('check', () => Promise.resolve())
      yield* ctx.fail('something went wrong')
      yield* ctx.mutate('unreachable', s => { s.value = 999 })
    },
  },
})

Deno.test('flow: ctx.fail stops execution and dispatches failed action', async () => {
  const app = createTestApp([failer])
  app.dispatch(failer.A.start())
  await app.flush()

  const types = app.dispatched.map(d => d.type)
  assertEquals(types.includes('failer:flow:failed'), true)

  const s = app.getState().failer as { value: number }
  assertEquals(s.value, 0) // unreachable step didn't execute
})

// ── Generator with ctx.sleep ──────────────────────────────────────────

const sleeper = feature('sleeper', {
  state: { woke: false },
  actions: {
    start: () => ({}),
  },
  generators: {
    start: function* (ctx) {
      yield* ctx.sleep('nap', 10) // 10ms
      yield* ctx.done(s => { s.woke = true })  // s.woke typed as boolean
    },
  },
})

Deno.test('flow: ctx.sleep pauses then continues', async () => {
  const app = createTestApp([sleeper])
  app.dispatch(sleeper.A.start())

  const before = app.getState().sleeper as { woke: boolean }
  assertEquals(before.woke, false)

  await new Promise(r => setTimeout(r, 80))

  const after = app.getState().sleeper as { woke: boolean }
  assertEquals(after.woke, true)
})

// ── Generator with ctx.all (spread form) ─────────────────────────────

const parallel = feature('parallel', {
  state: { a: 0, b: 0 },
  actions: {
    start: () => ({}),
  },
  generators: {
    start: function* (ctx) {
      const [a, b] = yield* ctx.all(
        ctx.call('fetchA', () => Promise.resolve(10)),
        ctx.call('fetchB', () => Promise.resolve(20)),
      )
      yield* ctx.done(s => {
        s.a = a  // a typed as number
        s.b = b  // b typed as number
      })
    },
  },
})

Deno.test('flow: ctx.all (spread) runs calls in parallel', async () => {
  const app = createTestApp([parallel])
  app.dispatch(parallel.A.start())
  await app.flush()

  const s = app.getState().parallel as { a: number; b: number }
  assertEquals(s.a, 10)
  assertEquals(s.b, 20)
})

// ── Generator with ctx.all (named form) ──────────────────────────────

const namedParallel = feature('namedParallel', {
  state: { x: 0, y: 0 },
  actions: {
    start: () => ({}),
  },
  generators: {
    start: function* (ctx) {
      const { x, y } = yield* ctx.all({
        x: ctx.call('fetchX', () => Promise.resolve(100)),
        y: ctx.call('fetchY', () => Promise.resolve(200)),
      })
      yield* ctx.done(s => {
        s.x = x as number
        s.y = y as number
      })
    },
  },
})

Deno.test('flow: ctx.all (named) runs calls in parallel and returns by name', async () => {
  const app = createTestApp([namedParallel])
  app.dispatch(namedParallel.A.start())
  await app.flush()

  const s = app.getState().namedParallel as { x: number; y: number }
  assertEquals(s.x, 100)
  assertEquals(s.y, 200)
})

// ── Generator with ctx.race ───────────────────────────────────────────

const racer = feature('racer', {
  state: { winner: '' },
  actions: {
    start: () => ({}),
  },
  generators: {
    start: function* (ctx) {
      const result = yield* ctx.race({
        fast: ctx.call('fast', () => Promise.resolve('fast-wins')),
        slow: ctx.call('slow', () => new Promise<string>(r => setTimeout(() => r('slow-wins'), 500))),
      })
      const winner = result.fast !== undefined ? 'fast' : 'slow'
      yield* ctx.done(s => { s.winner = winner })  // s.winner typed as string
    },
  },
})

Deno.test({ name: 'flow: ctx.race picks first to resolve', sanitizeOps: false, sanitizeResources: false }, async () => {
  const app = createTestApp([racer])
  app.dispatch(racer.A.start())
  await app.flush()

  const s = app.getState().racer as { winner: string }
  assertEquals(s.winner, 'fast')
})

// ── Generator key validation ──────────────────────────────────────────

Deno.test('flow: throws if generator key not in actions', () => {
  let error: Error | null = null
  try {
    feature('bad', {
      state: {},
      actions: { go: () => ({}) },
      generators: {
        nonexistent: function* () {},
      },
    })
  } catch (e) {
    error = e as Error
  }
  assertExists(error)
  assertEquals(error!.message.includes('nonexistent'), true)
  assertEquals(error!.message.includes('must match an action key'), true)
})

// ── Sync call in generator ────────────────────────────────────────────

const syncFlow = feature('syncFlow', {
  state: { value: 0 },
  actions: {
    start: () => ({}),
  },
  generators: {
    start: function* (ctx) {
      const val = yield* ctx.call('compute', () => 42)
      yield* ctx.done(s => { s.value = val })  // val typed as number
    },
  },
})

Deno.test('flow: ctx.call works with sync functions', async () => {
  const app = createTestApp([syncFlow])
  app.dispatch(syncFlow.A.start())
  await app.flush()

  const s = app.getState().syncFlow as { value: number }
  assertEquals(s.value, 42)
})

// ── Multiple steps ────────────────────────────────────────────────────

const multiStep = feature('multiStep', {
  state: { steps: [] as string[] },
  actions: {
    start: () => ({}),
  },
  generators: {
    start: function* (ctx) {
      yield* ctx.mutate('step1', s => { s.steps.push('one') })    // s.steps typed as string[]
      yield* ctx.mutate('step2', s => { s.steps.push('two') })
      yield* ctx.mutate('step3', s => { s.steps.push('three') })
      yield* ctx.done()
    },
  },
})

Deno.test('flow: multiple ctx.mutate calls execute in order', async () => {
  const app = createTestApp([multiStep])
  app.dispatch(multiStep.A.start())
  await app.flush()

  const s = app.getState().multiStep as { steps: string[] }
  assertEquals(s.steps, ['one', 'two', 'three'])
})

// ── Error handling in generator ───────────────────────────────────────

const errorFlow = feature('errorFlow', {
  state: { value: 0 },
  actions: {
    start: () => ({}),
  },
  generators: {
    start: function* (ctx) {
      yield* ctx.call('boom', () => { throw new Error('test error') })
      yield* ctx.done(s => { s.value = 999 })
    },
  },
})

Deno.test('flow: error in ctx.call dispatches error action', async () => {
  const app = createTestApp([errorFlow])
  app.dispatch(errorFlow.A.start())
  await app.flush()

  const types = app.dispatched.map(d => d.type)
  assertEquals(types.includes('errorFlow:flow:error'), true)

  const s = app.getState().errorFlow as { value: number }
  assertEquals(s.value, 0)
})

// ── ctx.waitFor ───────────────────────────────────────────────────────

const waiter = feature('waiter', {
  state: { received: '' },
  actions: {
    start: () => ({}),
    signal: (msg: string) => ({ msg }),
  },
  generators: {
    // String form used here — typed form (waiter.A.signal) would be circular reference
    start: function* (ctx) {
      const action = yield* ctx.waitFor('waiter:signal')
      const msg = (action.payload as { msg: string }).msg  // payload cast needed with string form
      yield* ctx.done(s => { s.received = msg })
    },
  },
})

Deno.test('flow: ctx.waitFor pauses until matching action dispatched', async () => {
  const app = createTestApp([waiter])
  app.dispatch(waiter.A.start())
  await new Promise(r => setTimeout(r, 20))

  assertEquals((app.getState().waiter as any).received, '')

  app.dispatch(waiter.A.signal('hello'))
  await new Promise(r => setTimeout(r, 50))

  assertEquals((app.getState().waiter as any).received, 'hello')
})

const timeoutWaiter = feature('timeoutWaiter', {
  state: { timedOut: false },
  actions: {
    start: () => ({}),
  },
  generators: {
    start: function* (ctx) {
      try {
        yield* ctx.waitFor('NeverHappens:Action', 50)
        yield* ctx.done()
      } catch {
        yield* ctx.mutate('timeout', s => { s.timedOut = true })  // s.timedOut typed as boolean
        yield* ctx.done()
      }
    },
  },
})

Deno.test('flow: ctx.waitFor with timeout throws on expiry', async () => {
  const app = createTestApp([timeoutWaiter])
  app.dispatch(timeoutWaiter.A.start())
  await new Promise(r => setTimeout(r, 200))

  assertEquals((app.getState().timeoutWaiter as any).timedOut, true)
})

// ── ctx.getState ──────────────────────────────────────────────────────

const stateReader = feature('stateReader', {
  state: { count: 0, doubled: 0 },
  actions: {
    start: () => ({}),
  },
  generators: {
    start: function* (ctx) {
      yield* ctx.mutate('inc', s => { s.count = 5 })
      const current = ctx.getState()           // typed as { count: number; doubled: number }
      yield* ctx.mutate('double', s => { s.doubled = current.count * 2 })  // no cast needed
      yield* ctx.done()
    },
  },
})

Deno.test({ name: 'flow: ctx.getState reads fresh state after step', sanitizeOps: false, sanitizeResources: false }, async () => {
  const app = createTestApp([stateReader])
  app.dispatch(stateReader.A.start())
  await app.flush()

  const s = app.getState().stateReader as { count: number; doubled: number }
  assertEquals(s.count, 5)
  assertEquals(s.doubled, 10)
})

// ── cancelOn ──────────────────────────────────────────────────────────

const cancellable = feature('cancellable', {
  state: { running: false, finished: false },
  actions: {
    start: () => ({}),
    stop: () => ({}),
  },
  generators: {
    start: function* (ctx) {
      yield* ctx.mutate('begin', s => { s.running = true })
      yield* ctx.sleep('work', 500)
      yield* ctx.done(s => {
        s.running = false
        s.finished = true
      })
    },
  },
  cancelOn: {
    start: ['stop'],
  },
})

Deno.test({ name: 'flow: cancelOn stops generator when matching action dispatched', sanitizeOps: false, sanitizeResources: false }, async () => {
  const app = createTestApp([cancellable])
  app.dispatch(cancellable.A.start())
  await new Promise(r => setTimeout(r, 50))

  assertEquals((app.getState().cancellable as any).running, true)

  app.dispatch(cancellable.A.stop())
  await new Promise(r => setTimeout(r, 100))

  assertEquals((app.getState().cancellable as any).finished, false)
})

// ── ctx.dispatch with payload-optional actions ────────────────────────

const putCompat = feature('putCompat', {
  state: { sent: false },
  actions: {
    start: () => ({}),
    signal: () => ({}),
  },
  generators: {
    start: function* (ctx) {
      yield* ctx.dispatch({ type: 'putCompat:signal' })
      yield* ctx.done(s => { s.sent = true })
    },
  },
})

Deno.test('flow: ctx.dispatch accepts action without payload', async () => {
  const app = createTestApp([putCompat])
  app.dispatch(putCompat.A.start())
  await app.flush()

  assertEquals((app.getState().putCompat as any).sent, true)
  const signalAction = app.dispatched.find(d => d.type === 'putCompat:signal')
  assertExists(signalAction)
})
