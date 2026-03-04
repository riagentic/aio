import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { createServer } from '../src/server.ts'
import { connectCli } from '../src/cli-client.ts'
import { join } from '@std/path'

const PORT = 19850

// Wait until condition is true (polling with timeout)
async function waitFor(fn: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout')
    await new Promise(r => setTimeout(r, 10))
  }
}

// Minimal server for testing — prod: true to skip file watcher
async function withServer(
  getState: () => Record<string, unknown>,
  dispatch: (action: unknown) => void,
  fn: (url: string, broadcast: () => void) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir()
  await Deno.mkdir(join(dir, 'dist'), { recursive: true })
  await Deno.writeTextFile(join(dir, 'dist', 'app.js'), 'export function mount(){}')
  const server = createServer({
    port: PORT,
    title: 'CLI Test',
    getUIState: () => getState(),
    dispatch,
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, 'dist'),
  })
  await new Promise(r => setTimeout(r, 50))
  try {
    await fn(`http://127.0.0.1:${PORT}`, server.broadcast)
  } finally {
    await server.shutdown()
  }
  await Deno.remove(dir, { recursive: true })
}

Deno.test('cli-client: connects and receives initial state', async () => {
  const state = { counter: 42, name: 'test' }
  await withServer(
    () => state,
    () => {},
    async (url) => {
      const cli = connectCli<typeof state>(url)
      const s = await cli.ready
      assertEquals(s.counter, 42)
      assertEquals(s.name, 'test')
      assertEquals(cli.state, s)
      assertEquals(cli.connected, true)
      cli.close()
    },
  )
})

Deno.test('cli-client: subscribe fires on state change', async () => {
  let state: Record<string, unknown> = { counter: 0, name: 'test', flag: true }
  let doBroadcast: (() => void) | null = null

  await withServer(
    () => state,
    (action: unknown) => {
      const a = action as { type: string; payload?: { by?: number } }
      if (a.type === 'INC') {
        state = { ...state, counter: (state.counter as number) + (a.payload?.by ?? 1) }
        doBroadcast?.()
      }
    },
    async (url, broadcast) => {
      doBroadcast = broadcast
      const cli = connectCli<{ counter: number; name: string; flag: boolean }>(url)
      await cli.ready

      const received: number[] = []
      cli.subscribe(s => received.push(s.counter))

      // subscribe fires immediately with current state
      assertEquals(received, [0])

      // Send action and wait for update
      cli.send({ type: 'INC', payload: { by: 5 } })
      await waitFor(() => received.length >= 2)
      assertEquals(received[1], 5)

      // Another action
      cli.send({ type: 'INC', payload: { by: 3 } })
      await waitFor(() => received.length >= 3)
      assertEquals(received[2], 8)

      cli.close()
    },
  )
})

Deno.test('cli-client: send queues actions before connected', async () => {
  let state: Record<string, unknown> = { counter: 0, name: 'test', flag: true }
  let doBroadcast: (() => void) | null = null

  await withServer(
    () => state,
    (action: unknown) => {
      const a = action as { type: string; payload?: { by?: number } }
      if (a.type === 'INC') {
        state = { ...state, counter: (state.counter as number) + (a.payload?.by ?? 1) }
        doBroadcast?.()
      }
    },
    async (url, broadcast) => {
      doBroadcast = broadcast
      const cli = connectCli<{ counter: number }>(url)

      // Queue actions before connected
      cli.send({ type: 'INC', payload: { by: 10 } })
      cli.send({ type: 'INC', payload: { by: 5 } })

      await cli.ready

      // Queued actions should have been sent
      await waitFor(() => cli.state?.counter === 15, 3000)
      assertEquals(cli.state?.counter, 15)

      cli.close()
    },
  )
})

Deno.test('cli-client: unsubscribe stops notifications', async () => {
  const state = { counter: 0 }
  await withServer(
    () => state,
    () => {},
    async (url) => {
      const cli = connectCli<typeof state>(url)
      await cli.ready

      const received: number[] = []
      const unsub = cli.subscribe(s => received.push(s.counter))

      assertEquals(received, [0])  // immediate fire

      unsub()

      // Even if state somehow updates, unsubscribed listener should not fire again
      assertEquals(received.length, 1)

      cli.close()
    },
  )
})

Deno.test('cli-client: close stops connection', async () => {
  const state = { value: 'hello' }
  await withServer(
    () => state,
    () => {},
    async (url) => {
      const cli = connectCli<typeof state>(url)
      await cli.ready
      assertEquals(cli.connected, true)

      cli.close()
      // Give WebSocket time to close
      await new Promise(r => setTimeout(r, 100))
      assertEquals(cli.connected, false)
      assertEquals(cli.state, state)  // state preserved after close
    },
  )
})

Deno.test('cli-client: delta patches applied correctly', async () => {
  // 3 keys — changing 1 triggers delta (33% < 50% threshold)
  let state: Record<string, unknown> = { a: 1, b: 2, c: 3 }
  let doBroadcast: (() => void) | null = null

  await withServer(
    () => state,
    (action: unknown) => {
      const a = action as { type: string; payload?: { key: string; val: number } }
      if (a.type === 'SET' && a.payload) {
        state = { ...state, [a.payload.key]: a.payload.val }
        doBroadcast?.()
      }
    },
    async (url, broadcast) => {
      doBroadcast = broadcast
      const cli = connectCli<{ a: number; b: number; c: number }>(url)
      await cli.ready

      assertEquals(cli.state, { a: 1, b: 2, c: 3 })

      // Change one key — should come as delta patch
      cli.send({ type: 'SET', payload: { key: 'b', val: 99 } })
      await waitFor(() => cli.state?.b === 99)
      assertEquals(cli.state, { a: 1, b: 99, c: 3 })

      cli.close()
    },
  )
})
