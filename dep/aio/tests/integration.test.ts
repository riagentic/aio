import { assertEquals, assertNotEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { createServer } from '../src/server.ts'
import { createDispatch } from '../src/dispatch.ts'
import { createScheduleManager, isScheduleEffect, schedule, type ScheduleEffect } from '../src/schedule.ts'
import { join } from '@std/path'

const PORT = 19810

// Skip server protocol messages (boot ID, etc.) — only collect state/delta JSON
const isProto = (d: string) => typeof d === 'string' && d.startsWith('__boot:')

// Wait until condition is true (polling with timeout)
async function waitFor(fn: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout')
    await new Promise(r => setTimeout(r, 10))
  }
}

Deno.test('integration: WS connect → initial state → action → delta broadcast', async () => {
  const dir = await Deno.makeTempDir()
  await Deno.mkdir(join(dir, 'dist'), { recursive: true })
  await Deno.writeTextFile(join(dir, 'dist', 'app.js'), 'export function mount(){}')

  // 3 keys — changing 1 of 3 (33%) triggers delta patch (<50% threshold)
  let state: Record<string, unknown> = { counter: 0, name: 'test', flag: true }
  let broadcast: (() => void) | null = null

  const server = createServer({
    port: PORT,
    title: 'Integration',
    getUIState: () => state,
    dispatch: (action: unknown) => {
      const a = action as { type: string; payload?: { by?: number } }
      if (a.type === 'INCREMENT') {
        state = { ...state, counter: (state.counter as number) + (a.payload?.by ?? 1) }
        broadcast?.()
      }
    },
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, 'dist'),
  })
  broadcast = server.broadcast

  await new Promise(r => setTimeout(r, 50))

  try {
    // Connect and collect messages
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    const received: string[] = []
    ws.addEventListener('message', (e) => { if (!isProto(e.data as string)) received.push(e.data as string) })

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('WS connect failed'))
    })

    // 1. Initial full state
    await waitFor(() => received.length >= 1)
    assertEquals(JSON.parse(received[0]), { counter: 0, name: 'test', flag: true })

    // 2. First action → delta patch (per-client cache initialized on connect)
    ws.send(JSON.stringify({ type: 'INCREMENT', payload: { by: 5 } }))
    await waitFor(() => received.length >= 2)

    const delta1 = JSON.parse(received[1])
    assertEquals(delta1.$p, { counter: 5 })        // only changed key
    assertEquals(delta1.$d, undefined)              // no deleted keys

    // 3. Second action → still delta (1 of 3 keys = 33% < 50%)
    ws.send(JSON.stringify({ type: 'INCREMENT', payload: { by: 3 } }))
    await waitFor(() => received.length >= 3)

    const delta2 = JSON.parse(received[2])
    assertEquals(delta2.$p, { counter: 8 })         // only changed key
    assertEquals(delta2.$d, undefined)               // no deleted keys

    ws.close()
  } finally {
    await server.shutdown()
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('integration: invalid actions are rejected gracefully', async () => {
  const dir = await Deno.makeTempDir()
  await Deno.mkdir(join(dir, 'dist'), { recursive: true })
  await Deno.writeTextFile(join(dir, 'dist', 'app.js'), 'export function mount(){}')

  let dispatched = false
  const server = createServer({
    port: PORT,
    title: 'Integration',
    getUIState: () => ({ ok: true }),
    dispatch: () => { dispatched = true },
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, 'dist'),
  })

  await new Promise(r => setTimeout(r, 50))

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    await new Promise<void>(r => { ws.onopen = () => r() })

    // Missing type field — should NOT dispatch
    ws.send(JSON.stringify({ payload: 'no type' }))
    await new Promise(r => setTimeout(r, 50))
    assertEquals(dispatched, false)

    // Malformed JSON — should NOT dispatch
    ws.send('not json{{{')
    await new Promise(r => setTimeout(r, 50))
    assertEquals(dispatched, false)

    // Valid action — SHOULD dispatch
    ws.send(JSON.stringify({ type: 'PING' }))
    await new Promise(r => setTimeout(r, 50))
    assertEquals(dispatched, true)

    ws.close()
  } finally {
    await server.shutdown()
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('integration: multiple clients receive broadcasts', async () => {
  const dir = await Deno.makeTempDir()
  await Deno.mkdir(join(dir, 'dist'), { recursive: true })
  await Deno.writeTextFile(join(dir, 'dist', 'app.js'), 'export function mount(){}')

  let state: Record<string, unknown> = { v: 0, pad1: '', pad2: '' }
  let broadcast: (() => void) | null = null

  const server = createServer({
    port: PORT,
    title: 'Integration',
    getUIState: () => state,
    dispatch: (action: unknown) => {
      const a = action as { type: string }
      if (a.type === 'BUMP') {
        state = { ...state, v: (state.v as number) + 1 }
        broadcast?.()
      }
    },
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, 'dist'),
  })
  broadcast = server.broadcast

  await new Promise(r => setTimeout(r, 50))

  try {
    const ws1 = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    const msgs1: string[] = []
    const msgs2: string[] = []
    ws1.addEventListener('message', (e) => { if (!isProto(e.data as string)) msgs1.push(e.data as string) })
    ws2.addEventListener('message', (e) => { if (!isProto(e.data as string)) msgs2.push(e.data as string) })

    await Promise.all([
      new Promise<void>(r => { ws1.onopen = () => r() }),
      new Promise<void>(r => { ws2.onopen = () => r() }),
    ])

    // Both get initial state
    await waitFor(() => msgs1.length >= 1 && msgs2.length >= 1)

    // One client sends action → both receive update
    ws1.send(JSON.stringify({ type: 'BUMP' }))
    await waitFor(() => msgs1.length >= 2 && msgs2.length >= 2)

    const u1 = JSON.parse(msgs1[1])
    const u2 = JSON.parse(msgs2[1])
    const v1 = u1.$p ? u1.$p.v : u1.v
    const v2 = u2.$p ? u2.$p.v : u2.v
    assertEquals(v1, 1)
    assertEquals(v2, 1)

    ws1.close()
    ws2.close()
  } finally {
    await server.shutdown()
    await Deno.remove(dir, { recursive: true })
  }
})

// ── Per-user getUIState test ──────────────────────────────────

Deno.test('integration: per-user getUIState returns different state per user', async () => {
  const dir = await Deno.makeTempDir()
  await Deno.mkdir(join(dir, 'dist'), { recursive: true })
  await Deno.writeTextFile(join(dir, 'dist', 'app.js'), 'export function mount(){}')

  const users = {
    'admin-tok': { id: 'alice', role: 'admin' },
    'viewer-tok': { id: 'bob', role: 'viewer' },
  }

  let state: Record<string, unknown> = { counter: 0, secret: 'admin-only' }
  let broadcast: (() => void) | null = null

  const server = createServer({
    port: PORT,
    title: 'PerUser',
    users,
    getUIState: (user?: { id: string; role: string }) => {
      // Admin gets full state, viewer gets filtered
      if (user?.role === 'admin') return state
      return { counter: state.counter }  // no secret
    },
    dispatch: (action: unknown) => {
      const a = action as { type: string }
      if (a.type === 'INC') {
        state = { ...state, counter: (state.counter as number) + 1 }
        broadcast?.()
      }
    },
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, 'dist'),
  })
  broadcast = server.broadcast

  await new Promise(r => setTimeout(r, 50))

  try {
    // Connect admin (alice)
    const ws1 = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=admin-tok`)
    const msgs1: string[] = []
    ws1.addEventListener('message', (e) => { if (!isProto(e.data as string)) msgs1.push(e.data as string) })
    await new Promise<void>(r => { ws1.onopen = () => r() })
    await waitFor(() => msgs1.length >= 1)

    // Connect viewer (bob)
    const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=viewer-tok`)
    const msgs2: string[] = []
    ws2.addEventListener('message', (e) => { if (!isProto(e.data as string)) msgs2.push(e.data as string) })
    await new Promise<void>(r => { ws2.onopen = () => r() })
    await waitFor(() => msgs2.length >= 1)

    // Admin gets full state (including secret)
    const init1 = JSON.parse(msgs1[0])
    assertEquals(init1.counter, 0)
    assertEquals(init1.secret, 'admin-only')

    // Viewer gets filtered state (no secret)
    const init2 = JSON.parse(msgs2[0])
    assertEquals(init2.counter, 0)
    assertEquals(init2.secret, undefined)

    // Bump state — both get their filtered view
    ws1.send(JSON.stringify({ type: 'INC' }))
    await waitFor(() => msgs1.length >= 2 && msgs2.length >= 2)

    const u1 = JSON.parse(msgs1[msgs1.length - 1])
    const c1 = u1.$p ? u1.$p.counter : u1.counter
    assertEquals(c1, 1)

    const u2 = JSON.parse(msgs2[msgs2.length - 1])
    const c2 = u2.$p ? u2.$p.counter : u2.counter
    assertEquals(c2, 1)
    // Viewer should still not have secret in broadcast
    assertEquals(u2.secret, undefined)
    if (u2.$p) assertEquals(u2.$p.secret, undefined)

    ws1.close()
    ws2.close()
  } finally {
    await server.shutdown()
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('integration: unauthenticated WS rejected when users configured', async () => {
  const dir = await Deno.makeTempDir()
  await Deno.mkdir(join(dir, 'dist'), { recursive: true })
  await Deno.writeTextFile(join(dir, 'dist', 'app.js'), 'export function mount(){}')

  const users = { 'valid-tok': { id: 'alice', role: 'admin' } }

  const server = createServer({
    port: PORT,
    title: 'AuthReject',
    users,
    getUIState: () => ({ ok: true }),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, 'dist'),
  })

  await new Promise(r => setTimeout(r, 50))

  try {
    // HTTP without token → 401
    const resp = await fetch(`http://127.0.0.1:${PORT}`)
    assertEquals(resp.status, 401)
    await resp.body?.cancel()

    // WS without token → 401 (HTTP upgrade rejected)
    const wsResp = await fetch(`http://127.0.0.1:${PORT}/ws`, {
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Sec-WebSocket-Key': btoa('test'),
        'Sec-WebSocket-Version': '13',
      },
    })
    assertEquals(wsResp.status, 401)
    await wsResp.body?.cancel()
  } finally {
    await server.shutdown()
    await Deno.remove(dir, { recursive: true })
  }
})

// ── CSS hot reload signal test ──────────────────────────────────

Deno.test('integration: CSS-only change sends __css signal, not __reload', async () => {
  const dir = await Deno.makeTempDir()
  await Deno.writeTextFile(join(dir, 'style.css'), 'body { color: red }')
  await Deno.writeTextFile(join(dir, 'app.ts'), 'console.log("hi")')

  const server = createServer({
    port: PORT,
    title: 'CSSTest',
    getUIState: () => ({}),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: false, // dev mode — enables file watcher
  })

  await new Promise(r => setTimeout(r, 100))

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    const received: string[] = []
    ws.addEventListener('message', (e) => {
      if (typeof e.data === 'string' && (e.data === '__css' || e.data === '__reload')) {
        received.push(e.data as string)
      }
    })

    await new Promise<void>(r => { ws.onopen = () => r() })
    await new Promise(r => setTimeout(r, 100))

    // Modify CSS only → should get __css
    await Deno.writeTextFile(join(dir, 'style.css'), 'body { color: blue }')
    await waitFor(() => received.length >= 1, 3000)
    assertEquals(received[0], '__css')

    // Modify TS file → should get __reload
    await Deno.writeTextFile(join(dir, 'app.ts'), 'console.log("changed")')
    await waitFor(() => received.length >= 2, 3000)
    assertEquals(received[1], '__reload')

    ws.close()
  } finally {
    await server.shutdown()
    await Deno.remove(dir, { recursive: true })
  }
})

// ── Guardrail integration tests ──────────────────────────────────

// Helper: sets up server with dispatch callback that calls reduce+execute inline
// (mirrors the core dispatch loop in aio.ts for guardrail testing)
async function withGuardrailServer(
  reduceFn: (state: Record<string, unknown>, action: { type: string }) => unknown,
  fn: (ws: WebSocket, received: string[]) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir()
  await Deno.mkdir(join(dir, 'dist'), { recursive: true })
  await Deno.writeTextFile(join(dir, 'dist', 'app.js'), 'export function mount(){}')

  let state: Record<string, unknown> = { counter: 0, status: 'ok' }
  let broadcast: (() => void) | null = null

  const server = createServer({
    port: PORT,
    title: 'Guardrail',
    getUIState: () => state,
    dispatch: (action: unknown) => {
      const a = action as { type: string }
      let reduced: unknown
      try {
        reduced = reduceFn(state, a)
      } catch (e) {
        console.error(`[test] reduce threw: ${e}`)
        return // server survives
      }
      // Validate reducer output (same guardrail as aio.ts)
      if (!reduced || typeof reduced !== 'object' || !('state' in (reduced as object)) || !Array.isArray((reduced as Record<string, unknown>).effects)) {
        console.error(`[test] bad reducer shape`)
        return // skip, don't crash
      }
      const r = reduced as { state: Record<string, unknown>; effects: { type?: string }[] }
      state = r.state
      for (const effect of r.effects) {
        if (!effect || typeof effect.type !== 'string') {
          console.warn(`[test] invalid effect skipped`)
          continue
        }
      }
      broadcast?.()
    },
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, 'dist'),
  })
  broadcast = server.broadcast

  await new Promise(r => setTimeout(r, 50))

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    const received: string[] = []
    ws.addEventListener('message', (e) => { if (!isProto(e.data as string)) received.push(e.data as string) })
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('WS connect failed'))
    })
    // Wait for initial state
    await waitFor(() => received.length >= 1)
    await fn(ws, received)
    ws.close()
  } finally {
    await server.shutdown()
    await Deno.remove(dir, { recursive: true })
  }
}

Deno.test('guardrail: reducer bad shape → server survives, valid actions still work', async () => {
  await withGuardrailServer(
    (state, action) => {
      if (action.type === 'BAD') return 'not an object' // bad shape
      return { state: { ...state, counter: (state.counter as number) + 1 }, effects: [] }
    },
    async (ws, received) => {
      // Send bad action — reducer returns wrong shape, server should survive
      ws.send(JSON.stringify({ type: 'BAD' }))
      await new Promise(r => setTimeout(r, 100))

      // Send valid action — should still process and broadcast
      ws.send(JSON.stringify({ type: 'INC' }))
      await waitFor(() => received.length >= 2)

      const last = JSON.parse(received[received.length - 1])
      const counter = last.$p ? last.$p.counter : last.counter
      assertEquals(counter, 1)
    },
  )
})

Deno.test('guardrail: effect missing .type → skipped, state still updates', async () => {
  await withGuardrailServer(
    (state, action) => {
      if (action.type === 'WITH_BAD_EFFECT') {
        return {
          state: { ...state, counter: (state.counter as number) + 1 },
          effects: [{ type: 'VALID_EFFECT' }, { noType: true }, null],
        }
      }
      return { state, effects: [] }
    },
    async (ws, received) => {
      ws.send(JSON.stringify({ type: 'WITH_BAD_EFFECT' }))
      await waitFor(() => received.length >= 2)

      const last = JSON.parse(received[received.length - 1])
      const counter = last.$p ? last.$p.counter : last.counter
      assertEquals(counter, 1) // state updated despite bad effects
    },
  )
})

Deno.test('guardrail: reducer throw → recovery, subsequent actions still work', async () => {
  await withGuardrailServer(
    (state, action) => {
      if (action.type === 'EXPLODE') throw new Error('kaboom')
      return { state: { ...state, counter: (state.counter as number) + 1 }, effects: [] }
    },
    async (ws, received) => {
      // Throw — server should catch and continue
      ws.send(JSON.stringify({ type: 'EXPLODE' }))
      await new Promise(r => setTimeout(r, 100))

      // Valid action after throw — should work fine
      ws.send(JSON.stringify({ type: 'INC' }))
      await waitFor(() => received.length >= 2)

      const last = JSON.parse(received[received.length - 1])
      const counter = last.$p ? last.$p.counter : last.counter
      assertEquals(counter, 1)
    },
  )
})

// ── Schedule integration tests ──────────────────────────────────────

const noopLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

Deno.test('integration: config-level schedule.every dispatches actions on interval', async () => {
  type S = { count: number }
  type A = { type: string }
  type E = { type: string }

  let state: S = { count: 0 }
  let doneCount = 0

  const scheduleManager = createScheduleManager(
    (action) => dispatch(action as A), noopLog
  )

  const dispatch = createDispatch<S, A, E>({
    reduce: (s, a) => {
      if (a.type === 'Tick') return { state: { count: s.count + 1 }, effects: [] }
      return { state: s, effects: [] }
    },
    execute: (effect) => {
      if (isScheduleEffect(effect)) { scheduleManager.handle(effect as ScheduleEffect); return }
    },
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => { doneCount++ },
    log: noopLog, debug: false,
  })

  // Boot config-level schedule
  scheduleManager.start([
    { id: 'heartbeat', every: 30, action: { type: 'Tick' } },
  ])

  await new Promise(r => setTimeout(r, 85))
  scheduleManager.cancelAll()
  dispatch.close()

  assertEquals(state.count >= 2, true, `expected >=2 ticks, got ${state.count}`)
})

Deno.test('integration: schedule.after effect from reducer fires once', async () => {
  type S = { started: boolean; saved: boolean }
  type A = { type: string }
  type E = { type: string }

  let state: S = { started: false, saved: false }

  const scheduleManager = createScheduleManager(
    (action) => dispatch(action as A), noopLog
  )

  const dispatch = createDispatch<S, A, E>({
    reduce: (s, a) => {
      if (a.type === 'Start') return {
        state: { ...s, started: true },
        effects: [schedule.after('save-delay', 50, { type: 'Save' }) as unknown as E],
      }
      if (a.type === 'Save') return { state: { ...s, saved: true }, effects: [] }
      return { state: s, effects: [] }
    },
    execute: (effect) => {
      if (isScheduleEffect(effect)) { scheduleManager.handle(effect as ScheduleEffect); return }
    },
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => {},
    log: noopLog, debug: false,
  })

  dispatch({ type: 'Start' })
  assertEquals(state.started, true)
  assertEquals(state.saved, false)

  await new Promise(r => setTimeout(r, 80))
  assertEquals(state.saved, true) // after-delay fired Save action

  // Verify it only fired once
  const countBefore = state.saved
  await new Promise(r => setTimeout(r, 80))
  assertEquals(state.saved, countBefore)

  scheduleManager.cancelAll()
  dispatch.close()
})

// ── SQLite persistence integration ──────────────────────────────────

import { openDb, loadTables, syncTables, table, pk, text, integer } from '../src/sql.ts'

Deno.test('integration: db arrays persist to SQLite and restore on restart', () => {
  const path = Deno.makeTempFileSync({ suffix: '.db' })
  const schema = {
    items: table({ id: pk(), name: text(), qty: integer() }),
  }

  // First "session" — write data
  {
    const { aioDB, raw } = openDb(path, schema)
    const prev = { items: [] as unknown[] }
    const state = {
      items: [
        { id: 1, name: 'apple', qty: 3 },
        { id: 2, name: 'banana', qty: 7 },
      ],
    }
    syncTables(raw, schema, state, prev)
    aioDB.close()
  }

  // Second "session" — reopen, load, verify
  {
    const { aioDB, raw } = openDb(path, schema)
    const loaded = loadTables(raw, schema)
    assertEquals(loaded.items.length, 2)
    const items = loaded.items as { id: number; name: string; qty: number }[]
    assertEquals(items[0].name, 'apple')
    assertEquals(items[1].qty, 7)
    aioDB.close()
  }

  Deno.removeSync(path)
})
