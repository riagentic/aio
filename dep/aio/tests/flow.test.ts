import { assertEquals, assertExists } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { feature, composeFeatures } from '../src/feature.ts'
import { flow } from '../src/flow.ts'
import type { Gen, FlowCtx } from '../src/flow.ts'

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
      // Execute effects (cast to Msg — schedule effects are not used in flow tests)
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
      idle: { on: { start: 'busy' } },
      busy: { on: {} },
    },
  },
  flows: {
    main: flow('start', function* (ctx, action) {
      const n = (action.payload as { n: number }).n

      // Async call
      const doubled = yield* ctx.call('double', () => Promise.resolve(n * 2))

      // State mutation
      yield* ctx.step('setValue', (s) => { s.value = doubled as number })

      // Done
      yield* ctx.done((s) => { s.done = true })
    }),
  },
})

Deno.test('flow: basic flow dispatches step actions', async () => {
  const app = createTestApp([basic])
  app.dispatch(basic.A.start(5))
  await app.flush()

  const types = app.dispatched.map(d => d.type)
  assertEquals(types.includes('Basic:Flow:Double'), true)
  assertEquals(types.includes('Basic:Flow:SetValue'), true)
  assertEquals(types.includes('Basic:Flow:Done'), true)
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
  flows: {
    main: flow('go', function* (ctx, action) {
      const input = (action.payload as { input: string }).input
      const upper = yield* ctx.call('transform', () => Promise.resolve(input.toUpperCase()))
      yield* ctx.done((s) => { s.result = upper as string })
    }),
  },
})

Deno.test('flow: feature with only flows (no reduce)', async () => {
  const app = createTestApp([flowOnly])
  app.dispatch(flowOnly.A.go('hello'))
  await app.flush()

  const s = app.getState().flowOnly as { result: string }
  assertEquals(s.result, 'HELLO')
})

// ── Mixed feature (reduce + flow) ────────────────────────────────────

const mixed = feature('mixed', {
  state: { count: 0, synced: false },
  actions: {
    increment: (by = 1) => ({ by }),
    sync: () => ({}),
  },
  machine: {
    initial: 'idle',
    states: {
      idle: { on: { increment: 'idle', sync: 'syncing' } },
      syncing: { on: {} },
    },
  },
  reduce(state, action, { A }) {
    if (action.type === A.Increment) {
      state.count += (action.payload as { by: number }).by
    }
  },
  flows: {
    sync: flow('sync', function* (ctx) {
      yield* ctx.call('doSync', () => Promise.resolve())
      yield* ctx.done((s) => { s.synced = true })
    }),
  },
})

Deno.test('flow: mixed feature — reduce works independently', () => {
  const app = createTestApp([mixed])
  app.dispatch(mixed.A.increment(5))
  const s = app.getState().mixed as { count: number }
  assertEquals(s.count, 5)
})

Deno.test('flow: mixed feature — flow works alongside reduce', async () => {
  const app = createTestApp([mixed])
  app.dispatch(mixed.A.increment(3))
  app.dispatch(mixed.A.sync())
  await app.flush()

  const s = app.getState().mixed as { count: number; synced: boolean }
  assertEquals(s.count, 3)
  assertEquals(s.synced, true)
})

// ── Flow with ctx.put ────────────────────────────────────────────────

const putter = feature('putter', {
  state: { step: '' },
  actions: {
    start: () => ({}),
    update: (step: string) => ({ step }),
  },
  machine: {
    initial: 'idle',
    states: {
      idle: { on: { start: 'busy', update: 'idle' } },
      busy: { on: { update: 'idle' } },
    },
  },
  reduce(state, action, { A }) {
    if (action.type === A.Update) {
      state.step = (action.payload as { step: string }).step
    }
  },
  flows: {
    main: flow('start', function* (ctx) {
      yield* ctx.put({ type: 'Putter:Update', payload: { step: 'from-flow' } })
    }),
  },
})

Deno.test('flow: ctx.put dispatches regular action', async () => {
  const app = createTestApp([putter])
  app.dispatch(putter.A.start())
  await app.flush()

  const s = app.getState().putter as { step: string }
  assertEquals(s.step, 'from-flow')
})

// ── Flow with ctx.fail ───────────────────────────────────────────────

const failer = feature('failer', {
  state: { value: 0 },
  actions: {
    start: () => ({}),
  },
  machine: {
    initial: 'idle',
    states: {
      idle: { on: { start: 'busy' } },
      busy: { on: {} },
    },
  },
  flows: {
    main: flow('start', function* (ctx) {
      yield* ctx.call('check', () => Promise.resolve())
      yield* ctx.fail('something went wrong')
      // This should never execute
      yield* ctx.step('unreachable', (s) => { s.value = 999 })
    }),
  },
})

Deno.test('flow: ctx.fail stops execution and dispatches failed action', async () => {
  const app = createTestApp([failer])
  app.dispatch(failer.A.start())
  await app.flush()

  const types = app.dispatched.map(d => d.type)
  assertEquals(types.includes('Failer:Flow:Failed'), true)

  const s = app.getState().failer as { value: number }
  assertEquals(s.value, 0) // unreachable step didn't execute
})

// ── Flow with ctx.sleep ──────────────────────────────────────────────

const sleeper = feature('sleeper', {
  state: { woke: false },
  actions: {
    start: () => ({}),
  },
  flows: {
    main: flow('start', function* (ctx) {
      yield* ctx.sleep('nap', 10) // 10ms
      yield* ctx.done((s) => { s.woke = true })
    }),
  },
})

Deno.test('flow: ctx.sleep pauses then continues', async () => {
  const app = createTestApp([sleeper])
  app.dispatch(sleeper.A.start())

  // Before sleep completes
  const before = app.getState().sleeper as { woke: boolean }
  assertEquals(before.woke, false)

  // After sleep completes
  await new Promise(r => setTimeout(r, 80))

  const after = app.getState().sleeper as { woke: boolean }
  assertEquals(after.woke, true)
})

// ── Flow with ctx.all (parallel) ─────────────────────────────────────

const parallel = feature('parallel', {
  state: { a: 0, b: 0 },
  actions: {
    start: () => ({}),
  },
  flows: {
    main: flow('start', function* (ctx) {
      const [a, b] = yield* ctx.all(
        ctx.call('fetchA', () => Promise.resolve(10)),
        ctx.call('fetchB', () => Promise.resolve(20)),
      )
      yield* ctx.done((s) => {
        s.a = a as number
        s.b = b as number
      })
    }),
  },
})

Deno.test('flow: ctx.all runs calls in parallel', async () => {
  const app = createTestApp([parallel])
  app.dispatch(parallel.A.start())
  await app.flush()

  const s = app.getState().parallel as { a: number; b: number }
  assertEquals(s.a, 10)
  assertEquals(s.b, 20)
})

// ── Flow with ctx.race ───────────────────────────────────────────────

const racer = feature('racer', {
  state: { winner: '' },
  actions: {
    start: () => ({}),
  },
  flows: {
    main: flow('start', function* (ctx) {
      const result = yield* ctx.race({
        fast: ctx.call('fast', () => Promise.resolve('fast-wins')),
        slow: ctx.call('slow', () => new Promise(r => setTimeout(() => r('slow-wins'), 500))),
      })
      const winner = (result as Record<string, string>).fast ? 'fast' : 'slow'
      yield* ctx.done((s) => { s.winner = winner })
    }),
  },
})

Deno.test({ name: 'flow: ctx.race picks first to resolve', sanitizeOps: false, sanitizeResources: false }, async () => {
  const app = createTestApp([racer])
  app.dispatch(racer.A.start())
  await app.flush()

  const s = app.getState().racer as { winner: string }
  assertEquals(s.winner, 'fast')
})

// ── Flow trigger validation ──────────────────────────────────────────

Deno.test('flow: throws if trigger action not in actions', () => {
  let error: Error | null = null
  try {
    feature('bad', {
      state: {},
      actions: { go: () => ({}) },
      flows: {
        main: flow('nonexistent', function* () {}),
      },
    })
  } catch (e) {
    error = e as Error
  }
  assertExists(error)
  assertEquals(error!.message.includes('nonexistent'), true)
  assertEquals(error!.message.includes('not in actions'), true)
})

// ── Sync call in flow ────────────────────────────────────────────────

const syncFlow = feature('syncFlow', {
  state: { value: 0 },
  actions: {
    start: () => ({}),
  },
  flows: {
    main: flow('start', function* (ctx) {
      // Sync function (not async)
      const val = yield* ctx.call('compute', () => 42)
      yield* ctx.done((s) => { s.value = val as number })
    }),
  },
})

Deno.test('flow: ctx.call works with sync functions', async () => {
  const app = createTestApp([syncFlow])
  app.dispatch(syncFlow.A.start())
  await app.flush()

  const s = app.getState().syncFlow as { value: number }
  assertEquals(s.value, 42)
})

// ── Multiple steps ───────────────────────────────────────────────────

const multiStep = feature('multiStep', {
  state: { steps: [] as string[] },
  actions: {
    start: () => ({}),
  },
  flows: {
    pipeline: flow('start', function* (ctx) {
      yield* ctx.step('step1', (s) => { (s.steps as string[]).push('one') })
      yield* ctx.step('step2', (s) => { (s.steps as string[]).push('two') })
      yield* ctx.step('step3', (s) => { (s.steps as string[]).push('three') })
      yield* ctx.done()
    }),
  },
})

Deno.test('flow: multiple ctx.step calls execute in order', async () => {
  const app = createTestApp([multiStep])
  app.dispatch(multiStep.A.start())
  await app.flush()

  const s = app.getState().multiStep as { steps: string[] }
  assertEquals(s.steps, ['one', 'two', 'three'])
})

// ── Error handling in flow ───────────────────────────────────────────

const errorFlow = feature('errorFlow', {
  state: { value: 0 },
  actions: {
    start: () => ({}),
  },
  flows: {
    main: flow('start', function* (ctx) {
      yield* ctx.call('boom', () => { throw new Error('test error') })
      yield* ctx.done((s) => { s.value = 999 })
    }),
  },
})

Deno.test('flow: error in ctx.call dispatches error action', async () => {
  const app = createTestApp([errorFlow])
  app.dispatch(errorFlow.A.start())
  await app.flush()

  const types = app.dispatched.map(d => d.type)
  assertEquals(types.includes('ErrorFlow:Flow:Error'), true)

  // Done step should not have executed
  const s = app.getState().errorFlow as { value: number }
  assertEquals(s.value, 0)
})
