import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { createDispatch } from '../src/dispatch.ts'
import { createServer } from '../src/server.ts'
import { join } from '@std/path'

const noop = { debug: () => {}, warn: () => {}, error: () => {} }

// ── onAction hook (via dispatch) ─────────────────────────────────

Deno.test('hooks: onAction fires before reduce', () => {
  let state = { n: 0 }
  const log: string[] = []

  const onAction = (a: { type: string }, _s: typeof state) => { log.push(`hook:${a.type}`) }
  const reduce = (s: typeof state, a: { type: string }) => {
    log.push(`reduce:${a.type}`)
    return { state: { n: s.n + 1 }, effects: [] as never[] }
  }

  // Wrap reduce like aio.ts does
  const hookedReduce: typeof reduce = (s, a) => {
    try { onAction(a, s) } catch { /* guarded */ }
    return reduce(s, a)
  }

  const dispatch = createDispatch<typeof state, { type: string }, never>({
    reduce: hookedReduce,
    execute: () => {},
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => {},
    log: noop, debug: false,
  })

  dispatch({ type: 'INC' })
  assertEquals(log, ['hook:INC', 'reduce:INC'])
  assertEquals(state.n, 1)
})

Deno.test('hooks: onAction error does not prevent reduce', () => {
  let state = { n: 0 }
  let errCaught = ''

  const hookedReduce = (s: typeof state, a: { type: string }) => {
    try { throw new Error('hook boom') } catch (e) { errCaught = String(e) }
    return { state: { n: s.n + 1 }, effects: [] as never[] }
  }

  const dispatch = createDispatch<typeof state, { type: string }, never>({
    reduce: hookedReduce,
    execute: () => {},
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => {},
    log: noop, debug: false,
  })

  dispatch({ type: 'X' })
  assertEquals(state.n, 1)
  assertEquals(errCaught.includes('hook boom'), true)
})

// ── onEffect hook (via dispatch) ─────────────────────────────────

Deno.test('hooks: onEffect fires before execute', () => {
  let state = { n: 0 }
  const log: string[] = []

  const onEffect = (e: { type: string }) => { log.push(`hook:${e.type}`) }
  const execute = (e: { type: string }) => { log.push(`exec:${e.type}`) }

  const hookedExecute = (e: { type: string }) => {
    try { onEffect(e) } catch { /* guarded */ }
    execute(e)
  }

  const dispatch = createDispatch<typeof state, { type: string }, { type: string }>({
    reduce: (s) => ({ state: { n: s.n + 1 }, effects: [{ type: 'FX' }] }),
    execute: hookedExecute,
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => {},
    log: noop, debug: false,
  })

  dispatch({ type: 'GO' })
  assertEquals(log, ['hook:FX', 'exec:FX'])
})

Deno.test('hooks: onEffect error does not prevent execute', () => {
  let state = { n: 0 }
  const executed: string[] = []

  const hookedExecute = (e: { type: string }) => {
    try { throw new Error('effect hook boom') } catch { /* guarded */ }
    executed.push(e.type)
  }

  const dispatch = createDispatch<typeof state, { type: string }, { type: string }>({
    reduce: (s) => ({ state: { n: s.n + 1 }, effects: [{ type: 'FX' }] }),
    execute: hookedExecute,
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => {},
    log: noop, debug: false,
  })

  dispatch({ type: 'GO' })
  assertEquals(executed, ['FX'])
})

// ── onConnect / onDisconnect hooks (via server) ──────────────────

const HOOK_PORT = 19820

async function waitFor(fn: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout')
    await new Promise(r => setTimeout(r, 10))
  }
}

Deno.test('hooks: onConnect fires on WS open, onDisconnect on WS close (no users = undefined)', async () => {
  const dir = await Deno.makeTempDir()
  await Deno.mkdir(join(dir, 'dist'), { recursive: true })
  await Deno.writeTextFile(join(dir, 'dist', 'app.js'), 'export function mount(){}')

  const connected: (unknown)[] = []
  const disconnected: (unknown)[] = []

  const server = createServer({
    port: HOOK_PORT,
    title: 'HookTest',
    getUIState: () => ({ ok: true }),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, 'dist'),
    onConnect: (user) => connected.push(user),
    onDisconnect: (user) => disconnected.push(user),
  })

  await new Promise(r => setTimeout(r, 50))

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${HOOK_PORT}/ws`)
    await new Promise<void>(r => { ws.onopen = () => r() })
    await waitFor(() => connected.length === 1)

    assertEquals(connected.length, 1)
    assertEquals(connected[0], undefined) // no users configured → undefined

    ws.close()
    await waitFor(() => disconnected.length === 1)

    assertEquals(disconnected.length, 1)
    assertEquals(disconnected[0], undefined) // no users configured → undefined
  } finally {
    await server.shutdown()
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('hooks: onConnect error does not break WS', async () => {
  const dir = await Deno.makeTempDir()
  await Deno.mkdir(join(dir, 'dist'), { recursive: true })
  await Deno.writeTextFile(join(dir, 'dist', 'app.js'), 'export function mount(){}')

  const server = createServer({
    port: HOOK_PORT,
    title: 'HookTest',
    getUIState: () => ({ ok: true }),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, 'dist'),
    onConnect: () => { throw new Error('connect hook boom') },
  })

  await new Promise(r => setTimeout(r, 50))

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${HOOK_PORT}/ws`)
    const msgs: string[] = []
    ws.addEventListener('message', (e) => { if (!(e.data as string).startsWith('__boot:')) msgs.push(e.data as string) })
    await new Promise<void>(r => { ws.onopen = () => r() })

    // Should still receive initial state despite hook error
    await waitFor(() => msgs.length >= 1)
    assertEquals(JSON.parse(msgs[0]).ok, true)

    ws.close()
  } finally {
    await server.shutdown()
    await Deno.remove(dir, { recursive: true })
  }
})

// ── onConnect with AioUser ─────────────────────────────────────────

Deno.test('hooks: onConnect receives AioUser when users configured', async () => {
  const dir = await Deno.makeTempDir()
  await Deno.mkdir(join(dir, 'dist'), { recursive: true })
  await Deno.writeTextFile(join(dir, 'dist', 'app.js'), 'export function mount(){}')

  const connected: unknown[] = []
  const disconnected: unknown[] = []

  const users = { 'test-token-abc': { id: 'alice', role: 'admin' } }

  const server = createServer({
    port: HOOK_PORT,
    title: 'HookTest',
    getUIState: () => ({ ok: true }),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, 'dist'),
    users,
    onConnect: (user) => connected.push(user),
    onDisconnect: (user) => disconnected.push(user),
  })

  await new Promise(r => setTimeout(r, 50))

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${HOOK_PORT}/ws?token=test-token-abc`)
    await new Promise<void>(r => { ws.onopen = () => r() })
    await waitFor(() => connected.length === 1)

    assertEquals(connected.length, 1)
    assertEquals((connected[0] as { id: string }).id, 'alice')
    assertEquals((connected[0] as { role: string }).role, 'admin')

    ws.close()
    await waitFor(() => disconnected.length === 1)

    assertEquals(disconnected.length, 1)
    assertEquals((disconnected[0] as { id: string }).id, 'alice')
  } finally {
    await server.shutdown()
    await Deno.remove(dir, { recursive: true })
  }
})

// ── onRestore hook (post-merge state transform) ─────────────────

Deno.test('hooks: onRestore transforms state', () => {
  // Simulate the pattern from aio.ts / standalone.ts
  const merged = { items: [{ name: 'a' }, { name: 'b', score: undefined }], count: 5 }
  const onRestore = (s: typeof merged) => ({
    ...s,
    items: s.items.map(i => ({ score: 0, ...i })),  // fill missing fields
  })
  const state = onRestore(merged)
  assertEquals(state.count, 5)
  assertEquals(state.items[0], { score: 0, name: 'a' })
  assertEquals(state.items[1], { score: undefined, name: 'b' })  // explicit undefined preserved
})

Deno.test('hooks: onRestore error is survivable (error-guarded pattern)', () => {
  const state = { n: 42 }
  const onRestore = (_s: typeof state): typeof state => { throw new Error('restore boom') }
  // Simulates the try/catch guard in aio.ts
  let result = state
  try { result = onRestore(state) } catch { /* guarded — keep original state */ }
  assertEquals(result, { n: 42 })
})

// ── No hooks = no crash ──────────────────────────────────────────

Deno.test('hooks: all hooks optional — works without any', () => {
  let state = { n: 0 }

  const dispatch = createDispatch<typeof state, { type: string }, { type: string }>({
    reduce: (s) => ({ state: { n: s.n + 1 }, effects: [{ type: 'FX' }] }),
    execute: () => {},
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => {},
    log: noop, debug: false,
  })

  dispatch({ type: 'X' })
  assertEquals(state.n, 1)
})
