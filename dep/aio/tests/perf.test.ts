import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { createDispatch, type AioError, type DispatchDeps } from '../src/dispatch.ts'

// ── Performance Budget Tests ─────────────────────────────────────────

type TestState = { count: number }
type TestAction = { type: 'Inc'; payload?: { by?: number } }
type TestEffect = { type: 'Log'; payload: { msg: string } }

function createTestDeps(overrides: Partial<DispatchDeps<TestState, TestAction, TestEffect>> = {}): DispatchDeps<TestState, TestAction, TestEffect> {
  return {
    reduce: (state, action) => {
      if (action.type === 'Inc') return { state: { count: state.count + (action.payload?.by ?? 1) }, effects: [] }
      return { state, effects: [] }
    },
    execute: () => {},
    getState: () => ({ count: 0 }),
    setState: () => {},
    onDone: () => {},
    log: { debug: () => {}, warn: () => {}, error: () => {} },
    debug: false,
    ...overrides,
  }
}

// ── Default mode (strict) ────────────────────────────────────────────

Deno.test('perf: strict mode - slow reduce calls onError', async () => {
  const errors: AioError[] = []
  let reduceCount = 0
  
  const deps = createTestDeps({
    reduce: () => {
      reduceCount++
      // Simulate slow reduce (>100ms)
      const start = performance.now()
      while (performance.now() - start < 150) {}
      return { state: { count: reduceCount }, effects: [] }
    },
    onError: (err) => { errors.push(err) },
    perfMode: 'strict',
  })
  
  const dispatch = createDispatch(deps)
  dispatch({ type: 'Inc' })
  
  assertEquals(errors.length, 1)
  assertEquals(errors[0].source, 'performance')
  assertEquals(errors[0].actionType, 'Inc')
  assertEquals(typeof errors[0].duration, 'number')
  assertEquals(errors[0].duration! > 100, true)
  assertEquals(errors[0].budget, 100)
  assertEquals(errors[0].message?.includes('exceeded budget'), true)
})

Deno.test('perf: strict mode - slow effect calls onError', () => {
  const errors: AioError[] = []
  
  const deps = createTestDeps({
    reduce: () => ({ state: { count: 1 }, effects: [{ type: 'Log', payload: { msg: 'test' } }] }),
    execute: () => {
      // Simulate slow sync effect (>5ms)
      const start = performance.now()
      while (performance.now() - start < 20) {}
    },
    onError: (err) => { errors.push(err) },
    perfMode: 'strict',
  })
  
  const dispatch = createDispatch(deps)
  dispatch({ type: 'Inc' })
  
  assertEquals(errors.length, 1)
  assertEquals(errors[0].source, 'performance')
  assertEquals(errors[0].effectType, 'Log')
  assertEquals(errors[0].duration! > 5, true)
  assertEquals(errors[0].budget, 5)
})

Deno.test('perf: strict mode - fast reduce does not call onError', () => {
  const errors: AioError[] = []
  
  const deps = createTestDeps({
    onError: (err) => { errors.push(err) },
    perfMode: 'strict',
  })
  
  const dispatch = createDispatch(deps)
  dispatch({ type: 'Inc' })
  dispatch({ type: 'Inc' })
  dispatch({ type: 'Inc' })
  
  assertEquals(errors.length, 0)
})

Deno.test('perf: strict mode - async effect not measured for duration', () => {
  const errors: AioError[] = []
  
  const deps = createTestDeps({
    reduce: () => ({ state: { count: 1 }, effects: [{ type: 'Log', payload: { msg: 'test' } }] }),
    execute: () => {
      // Async effect returns immediately
      return Promise.resolve()
    },
    onError: (err) => { errors.push(err) },
    perfMode: 'strict',
  })
  
  const dispatch = createDispatch(deps)
  dispatch({ type: 'Inc' })
  
  assertEquals(errors.length, 0)
})

// ── Soft mode ────────────────────────────────────────────────────────

Deno.test('perf: soft mode - slow reduce only warns', () => {
  const errors: AioError[] = []
  const warns: string[] = []
  
  const deps = createTestDeps({
    reduce: () => {
      const start = performance.now()
      while (performance.now() - start < 150) {}
      return { state: { count: 1 }, effects: [] }
    },
    onError: (err) => { errors.push(err) },
    log: { debug: () => {}, warn: (msg) => { warns.push(msg) }, error: () => {} },
    debug: false,
    perfMode: 'soft',
  })
  
  const dispatch = createDispatch(deps)
  dispatch({ type: 'Inc' })
  
  assertEquals(errors.length, 0)
  assertEquals(warns.length, 1)
  assertEquals(warns[0].includes('exceeded budget'), true)
})

Deno.test('perf: soft mode - slow effect only warns', () => {
  const errors: AioError[] = []
  const warns: string[] = []
  
  const deps = createTestDeps({
    reduce: () => ({ state: { count: 1 }, effects: [{ type: 'Log', payload: { msg: 'test' } }] }),
    execute: () => {
      const start = performance.now()
      while (performance.now() - start < 20) {}
    },
    onError: (err) => { errors.push(err) },
    log: { debug: () => {}, warn: (msg) => { warns.push(msg) }, error: () => {} },
    debug: false,
    perfMode: 'soft',
  })
  
  const dispatch = createDispatch(deps)
  dispatch({ type: 'Inc' })
  
  assertEquals(errors.length, 0)
  assertEquals(warns.length, 1)
})

// ── Custom budgets ───────────────────────────────────────────────────

Deno.test('perf: custom reduce budget', () => {
  const errors: AioError[] = []
  
  const deps = createTestDeps({
    reduce: () => {
      const start = performance.now()
      while (performance.now() - start < 30) {}
      return { state: { count: 1 }, effects: [] }
    },
    onError: (err) => { errors.push(err) },
    perfMode: 'strict',
    perfBudget: { reduce: 10 },  // Very tight budget
  })
  
  const dispatch = createDispatch(deps)
  dispatch({ type: 'Inc' })
  
  assertEquals(errors.length, 1)
  assertEquals(errors[0].budget, 10)
  assertEquals(errors[0].duration! > 10, true)
})

Deno.test('perf: custom effect budget', () => {
  const errors: AioError[] = []
  
  const deps = createTestDeps({
    reduce: () => ({ state: { count: 1 }, effects: [{ type: 'Log', payload: { msg: 'test' } }] }),
    execute: () => {
      const start = performance.now()
      while (performance.now() - start < 15) {}
    },
    onError: (err) => { errors.push(err) },
    perfMode: 'strict',
    perfBudget: { effect: 10 },
  })
  
  const dispatch = createDispatch(deps)
  dispatch({ type: 'Inc' })
  
  assertEquals(errors.length, 1)
  assertEquals(errors[0].budget, 10)
})

Deno.test('perf: relaxed budget allows more time', () => {
  const errors: AioError[] = []
  
  const deps = createTestDeps({
    reduce: () => {
      const start = performance.now()
      while (performance.now() - start < 150) {}
      return { state: { count: 1 }, effects: [] }
    },
    onError: (err) => { errors.push(err) },
    perfMode: 'strict',
    perfBudget: { reduce: 200 },  // Relaxed budget
  })
  
  const dispatch = createDispatch(deps)
  dispatch({ type: 'Inc' })
  
  assertEquals(errors.length, 0)
})

// ── Both reduce and effect slow ───────────────────────────────────────

Deno.test('perf: reports both reduce and effect violations', () => {
  const errors: AioError[] = []
  
  const deps = createTestDeps({
    reduce: () => {
      const start = performance.now()
      while (performance.now() - start < 150) {}
      return { state: { count: 1 }, effects: [{ type: 'Log', payload: { msg: 'test' } }] }
    },
    execute: () => {
      const start = performance.now()
      while (performance.now() - start < 20) {}
    },
    onError: (err) => { errors.push(err) },
    perfMode: 'strict',
  })
  
  const dispatch = createDispatch(deps)
  dispatch({ type: 'Inc' })
  
  assertEquals(errors.length, 2)
  assertEquals(errors[0].source, 'performance')
  assertEquals(errors[0].actionType, 'Inc')
  assertEquals(errors[1].source, 'performance')
  assertEquals(errors[1].effectType, 'Log')
})

// ── Default budgets when not specified ────────────────────────────────

Deno.test('perf: default budgets are 100ms reduce, 5ms effect', () => {
  const errors: AioError[] = []
  
  const deps = createTestDeps({
    reduce: () => {
      const start = performance.now()
      while (performance.now() - start < 150) {}
      return { state: { count: 1 }, effects: [{ type: 'Log', payload: { msg: 'test' } }] }
    },
    execute: () => {
      const start = performance.now()
      while (performance.now() - start < 20) {}
    },
    onError: (err) => { errors.push(err) },
    perfMode: 'strict',
    // No perfBudget specified
  })
  
  const dispatch = createDispatch(deps)
  dispatch({ type: 'Inc' })
  
  assertEquals(errors.length, 2)
  assertEquals(errors[0].budget, 100)  // reduce default
  assertEquals(errors[1].budget, 5)     // effect default
})