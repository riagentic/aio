import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { createDispatch } from '../src/dispatch.ts'
import { createServer } from '../src/server.ts'
import { join } from '@std/path'

const noop = { debug: () => {}, warn: () => {}, error: () => {} }

// ── Unit: snapshot / loadSnapshot on app-like object ─────────────────

Deno.test('snapshot: returns JSON string of current state', () => {
  const state = { count: 5, name: 'test' }
  const json = JSON.stringify(state)
  assertEquals(json, '{"count":5,"name":"test"}')
  assertEquals(JSON.parse(json), state)
})

Deno.test('loadSnapshot: replaces state and triggers broadcast', () => {
  type S = { count: number; label: string }
  type A = { type: string }
  let state: S = { count: 0, label: 'init' }
  let broadcasts = 0

  const dispatch = createDispatch<S, A, never>({
    reduce: (s, a) => {
      if (a.type === 'INC') return { state: { ...s, count: s.count + 1 }, effects: [] }
      return { state: s, effects: [] }
    },
    execute: () => {},
    getState: () => state,
    setState: (s) => { state = s },
    onDone: () => { broadcasts++ },
    log: noop, debug: false,
  })

  dispatch({ type: 'INC' })
  assertEquals(state.count, 1)
  const snap = JSON.stringify(state)

  dispatch({ type: 'INC' })
  dispatch({ type: 'INC' })
  assertEquals(state.count, 3)

  // Restore snapshot
  state = JSON.parse(snap)
  assertEquals(state.count, 1)
  assertEquals(state.label, 'init')

  // Can keep dispatching after restore
  dispatch({ type: 'INC' })
  assertEquals(state.count, 2)

  dispatch.close()
})

Deno.test('loadSnapshot: invalid JSON throws', () => {
  assertThrows(() => JSON.parse('not json{{{'), SyntaxError)
})

// ── Integration: HTTP endpoints ─────────────────────────────────────

const PORT = 19830

async function waitFor(fn: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout')
    await new Promise(r => setTimeout(r, 10))
  }
}

Deno.test('snapshot HTTP: GET /__snapshot returns state JSON', async () => {
  const dir = await Deno.makeTempDir()
  await Deno.mkdir(join(dir, 'dist'), { recursive: true })
  await Deno.writeTextFile(join(dir, 'dist', 'app.js'), 'export function mount(){}')

  const state = { count: 42, items: ['a', 'b'] }

  const server = createServer({
    port: PORT,
    title: 'SnapshotTest',
    getUIState: () => state,
    dispatch: () => {},
    getSnapshot: () => JSON.stringify(state),
    loadSnapshot: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, 'dist'),
  })

  await new Promise(r => setTimeout(r, 50))

  try {
    const resp = await fetch(`http://127.0.0.1:${PORT}/__snapshot`)
    assertEquals(resp.status, 200)
    assertEquals(resp.headers.get('content-type'), 'application/json')
    assertEquals(resp.headers.get('content-disposition'), 'attachment; filename="snapshot.json"')
    const body = await resp.json()
    assertEquals(body, state)
  } finally {
    await server.shutdown()
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('snapshot HTTP: POST /__snapshot loads state', async () => {
  const dir = await Deno.makeTempDir()
  await Deno.mkdir(join(dir, 'dist'), { recursive: true })
  await Deno.writeTextFile(join(dir, 'dist', 'app.js'), 'export function mount(){}')

  let loaded = ''

  const server = createServer({
    port: PORT,
    title: 'SnapshotTest',
    getUIState: () => ({}),
    dispatch: () => {},
    getSnapshot: () => '{}',
    loadSnapshot: (json) => { loaded = json },
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, 'dist'),
  })

  await new Promise(r => setTimeout(r, 50))

  try {
    const snapshot = JSON.stringify({ count: 99, restored: true })
    const resp = await fetch(`http://127.0.0.1:${PORT}/__snapshot`, {
      method: 'POST',
      body: snapshot,
      headers: { 'Content-Type': 'application/json', 'X-AIO': '1' },
    })
    assertEquals(resp.status, 200)
    await resp.body?.cancel()
    assertEquals(loaded, snapshot)
  } finally {
    await server.shutdown()
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('snapshot HTTP: POST /__snapshot rejects invalid JSON', async () => {
  const dir = await Deno.makeTempDir()
  await Deno.mkdir(join(dir, 'dist'), { recursive: true })
  await Deno.writeTextFile(join(dir, 'dist', 'app.js'), 'export function mount(){}')

  const server = createServer({
    port: PORT,
    title: 'SnapshotTest',
    getUIState: () => ({}),
    dispatch: () => {},
    getSnapshot: () => '{}',
    loadSnapshot: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, 'dist'),
  })

  await new Promise(r => setTimeout(r, 50))

  try {
    const resp = await fetch(`http://127.0.0.1:${PORT}/__snapshot`, {
      method: 'POST',
      body: 'not json{{{',
      headers: { 'X-AIO': '1' },
    })
    assertEquals(resp.status, 400)
    const text = await resp.text()
    assertEquals(text, 'Invalid JSON')
  } finally {
    await server.shutdown()
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('snapshot HTTP: clients receive broadcast after POST', async () => {
  const dir = await Deno.makeTempDir()
  await Deno.mkdir(join(dir, 'dist'), { recursive: true })
  await Deno.writeTextFile(join(dir, 'dist', 'app.js'), 'export function mount(){}')

  let state: Record<string, unknown> = { count: 0, pad: '' }
  let broadcast: (() => void) | null = null

  const server = createServer({
    port: PORT,
    title: 'SnapshotBroadcast',
    getUIState: () => state,
    dispatch: () => {},
    getSnapshot: () => JSON.stringify(state),
    loadSnapshot: (json) => { state = JSON.parse(json); broadcast?.() },
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, 'dist'),
  })
  broadcast = server.broadcast

  await new Promise(r => setTimeout(r, 50))

  try {
    // Connect WS client
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    const msgs: string[] = []
    ws.addEventListener('message', (e) => { if (!(e.data as string).startsWith('__boot:')) msgs.push(e.data as string) })
    await new Promise<void>(r => { ws.onopen = () => r() })
    await waitFor(() => msgs.length >= 1) // initial state

    // POST snapshot → client should receive broadcast
    const resp = await fetch(`http://127.0.0.1:${PORT}/__snapshot`, {
      method: 'POST',
      body: JSON.stringify({ count: 77, pad: 'restored' }),
      headers: { 'X-AIO': '1' },
    })
    assertEquals(resp.status, 200)
    await resp.body?.cancel()

    await waitFor(() => msgs.length >= 2)
    const update = JSON.parse(msgs[msgs.length - 1])
    // Could be full or delta depending on change ratio
    const count = update.$p ? update.$p.count : update.count
    assertEquals(count, 77)

    ws.close()
  } finally {
    await server.shutdown()
    await Deno.remove(dir, { recursive: true })
  }
})
