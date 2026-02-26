import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { createServer } from '../src/server.ts'
import { join } from '@std/path'

const PORT = 19877

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
    ws.addEventListener('message', (e) => received.push(e.data as string))

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('WS connect failed'))
    })

    // 1. Initial full state
    await waitFor(() => received.length >= 1)
    assertEquals(JSON.parse(received[0]), { counter: 0, name: 'test', flag: true })

    // 2. First action → full broadcast (broadcast() hasn't cached state yet)
    ws.send(JSON.stringify({ type: 'INCREMENT', payload: { by: 5 } }))
    await waitFor(() => received.length >= 2)

    const full = JSON.parse(received[1])
    assertEquals(full, { counter: 5, name: 'test', flag: true })

    // 3. Second action → delta patch (1 of 3 keys = 33% < 50%)
    ws.send(JSON.stringify({ type: 'INCREMENT', payload: { by: 3 } }))
    await waitFor(() => received.length >= 3)

    const delta = JSON.parse(received[2])
    assertEquals(delta.$p, { counter: 8 })         // only changed key
    assertEquals(delta.$d, undefined)               // no deleted keys

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
    ws1.addEventListener('message', (e) => msgs1.push(e.data as string))
    ws2.addEventListener('message', (e) => msgs2.push(e.data as string))

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
