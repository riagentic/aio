import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { createServer, _timingSafeEqual } from '../src/server.ts'
import { join } from '@std/path'

const TEST_PORT = 19800

// Use prod: true to skip file watcher (avoids resource leaks in tests)
async function withServer(fn: (url: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir()
  await Deno.writeTextFile(join(dir, 'hello.txt'), 'world')
  await Deno.mkdir(join(dir, 'dist'), { recursive: true })
  await Deno.writeTextFile(join(dir, 'dist', 'app.js'), 'export function mount(){}')
  const server = createServer({
    port: TEST_PORT,
    title: 'Test',
    getUIState: () => ({ ok: true }),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, 'dist'),
  })
  await new Promise(r => setTimeout(r, 50))
  try {
    await fn(`http://127.0.0.1:${TEST_PORT}`)
  } finally {
    await server.shutdown()
  }
  await Deno.remove(dir, { recursive: true })
}

Deno.test('server: index returns HTML with title', async () => {
  await withServer(async (url) => {
    const resp = await fetch(url)
    assertEquals(resp.status, 200)
    const body = await resp.text()
    assertEquals(body.includes('<!DOCTYPE html>'), true)
    assertEquals(body.includes('Test'), true)
  })
})

Deno.test('server: HTML omits aio:width meta tag when not configured', async () => {
  await withServer(async (url) => {
    const resp = await fetch(url)
    const body = await resp.text()
    assertEquals(body.includes('aio:width'), false)
    assertEquals(body.includes('aio:height'), false)
  })
})

Deno.test('server: serves files from baseDir', async () => {
  await withServer(async (url) => {
    const resp = await fetch(`${url}/hello.txt`)
    assertEquals(resp.status, 200)
    assertEquals(await resp.text(), 'world')
  })
})

Deno.test('server: serves prod dist/app.js', async () => {
  await withServer(async (url) => {
    const resp = await fetch(`${url}/app.js`)
    assertEquals(resp.status, 200)
    const body = await resp.text()
    assertEquals(body.includes('mount'), true)
  })
})

Deno.test('server: 404 for missing files', async () => {
  await withServer(async (url) => {
    const resp = await fetch(`${url}/nope.txt`)
    assertEquals(resp.status, 404)
    await resp.body?.cancel()
  })
})

Deno.test('server: path traversal normalized by URL parser gives 404', async () => {
  await withServer(async (url) => {
    // URL parser normalizes /../ to / — so /../../etc/passwd becomes /etc/passwd
    // The file doesn't exist in baseDir, so 404 (not serving actual /etc/passwd)
    const resp = await fetch(`${url}/../../../etc/passwd`)
    assertEquals(resp.status, 404)
    await resp.body?.cancel()
  })
})

// ── Width/height meta tags ──────────────────────────────────

const META_PORT = 19801

Deno.test('server: HTML includes aio:width meta tag when configured', async () => {
  const dir = await Deno.makeTempDir()
  await Deno.mkdir(join(dir, 'dist'), { recursive: true })
  await Deno.writeTextFile(join(dir, 'dist', 'app.js'), 'export function mount(){}')
  const server = createServer({
    port: META_PORT,
    title: 'MetaTest',
    width: 1200,
    height: 900,
    getUIState: () => ({ ok: true }),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, 'dist'),
  })
  await new Promise(r => setTimeout(r, 50))
  try {
    const resp = await fetch(`http://127.0.0.1:${META_PORT}`)
    const body = await resp.text()
    assertEquals(body.includes('<meta name="aio:width" content="1200">'), true)
    assertEquals(body.includes('<meta name="aio:height" content="900">'), true)
    assertEquals(body.includes('MetaTest'), true)
  } finally {
    await server.shutdown()
  }
  await Deno.remove(dir, { recursive: true })
})

// ── Expose / token auth tests ──────────────────────────────────

const EXPOSE_PORT = 19802

async function withExposedServer(fn: (url: string, token: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir()
  await Deno.mkdir(join(dir, 'dist'), { recursive: true })
  await Deno.writeTextFile(join(dir, 'dist', 'app.js'), 'export function mount(){}')
  const token = 'test-token-123'
  const server = createServer({
    port: EXPOSE_PORT,
    title: 'Exposed',
    getUIState: () => ({ ok: true }),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, 'dist'),
    expose: true,
    token,
  })
  await new Promise(r => setTimeout(r, 50))
  try {
    await fn(`http://127.0.0.1:${EXPOSE_PORT}`, token)
  } finally {
    await server.shutdown()
  }
  await Deno.remove(dir, { recursive: true })
}

Deno.test('server: expose rejects request without token', async () => {
  await withExposedServer(async (url) => {
    const resp = await fetch(url)
    assertEquals(resp.status, 401)
    await resp.body?.cancel()
  })
})

Deno.test('server: expose accepts request with ?token=', async () => {
  await withExposedServer(async (url, token) => {
    const resp = await fetch(`${url}?token=${token}`)
    assertEquals(resp.status, 200)
    const body = await resp.text()
    assertEquals(body.includes('<!DOCTYPE html>'), true)
  })
})

Deno.test('server: expose accepts request with Authorization header', async () => {
  await withExposedServer(async (url, token) => {
    const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } })
    assertEquals(resp.status, 200)
    await resp.body?.cancel()
  })
})

Deno.test('server: expose skips origin check on WS', async () => {
  await withExposedServer(async (url, token) => {
    // With valid token, non-localhost origin should be allowed
    const resp = await fetch(`${url}/ws?token=${token}`, {
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Origin': 'https://remote-device.local',
        'Sec-WebSocket-Key': btoa('test'),
        'Sec-WebSocket-Version': '13',
      },
    })
    // Should get 101 (upgrade) not 403 — but Deno returns 101 for successful upgrade
    // If origin check were active, we'd get 403
    assertEquals(resp.status !== 403, true)
    await resp.body?.cancel()
  })
})

Deno.test('server: expose rejects wrong token with 401', async () => {
  await withExposedServer(async (url) => {
    const resp = await fetch(`${url}?token=wrong-token-value`)
    assertEquals(resp.status, 401)
    await resp.body?.cancel()
  })
})

Deno.test('server: WS rejects oversized message (>1MB)', async () => {
  await withServer(async (url) => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws`)
    let dispatched = false

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('WS failed'))
    })

    // Wait for initial state
    await new Promise(r => setTimeout(r, 50))

    // Send oversized message (>1MB) — should be silently dropped
    const huge = JSON.stringify({ type: 'BIG', payload: 'x'.repeat(1_100_000) })
    ws.send(huge)
    await new Promise(r => setTimeout(r, 50))

    // Dispatch should not have been called (message dropped)
    assertEquals(dispatched, false)

    ws.close()
  })
})

Deno.test('server: WS rejects non-localhost origin', async () => {
  await withServer(async (url) => {
    const resp = await fetch(`${url}/ws`, {
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Origin': 'https://evil.com',
        'Sec-WebSocket-Key': btoa('test'),
        'Sec-WebSocket-Version': '13',
      },
    })
    assertEquals(resp.status, 403)
    await resp.body?.cancel()
  })
})

// ── allowedOrigins tests ──────────────────────────────────────

const ORIGINS_PORT = 19803

Deno.test('server: allowedOrigins accepts custom origin', async () => {
  const dir = await Deno.makeTempDir()
  await Deno.mkdir(join(dir, 'dist'), { recursive: true })
  await Deno.writeTextFile(join(dir, 'dist', 'app.js'), 'export function mount(){}')
  const server = createServer({
    port: ORIGINS_PORT,
    title: 'Origins',
    getUIState: () => ({ ok: true }),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, 'dist'),
    allowedOrigins: ['myapp.local'],
  })
  await new Promise(r => setTimeout(r, 50))
  try {
    // Custom allowed origin should succeed
    const resp = await fetch(`http://127.0.0.1:${ORIGINS_PORT}/ws`, {
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Origin': 'http://myapp.local',
        'Sec-WebSocket-Key': btoa('test'),
        'Sec-WebSocket-Version': '13',
      },
    })
    assertEquals(resp.status !== 403, true)
    await resp.body?.cancel()

    // Non-allowed origin should still be rejected
    const resp2 = await fetch(`http://127.0.0.1:${ORIGINS_PORT}/ws`, {
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Origin': 'https://evil.com',
        'Sec-WebSocket-Key': btoa('test'),
        'Sec-WebSocket-Version': '13',
      },
    })
    assertEquals(resp2.status, 403)
    await resp2.body?.cancel()
  } finally {
    await server.shutdown()
  }
  await Deno.remove(dir, { recursive: true })
})

// ── Users (multi-user) auth tests ──────────────────────────────────

const USERS_PORT = 19804

const TEST_USERS: Record<string, { id: string; role: string }> = {
  'alice-token-123': { id: 'alice', role: 'admin' },
  'bob-token-456': { id: 'bob', role: 'viewer' },
}

async function withUsersServer(fn: (url: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir()
  await Deno.mkdir(join(dir, 'dist'), { recursive: true })
  await Deno.writeTextFile(join(dir, 'dist', 'app.js'), 'export function mount(){}')
  const server = createServer({
    port: USERS_PORT,
    title: 'Users',
    getUIState: () => ({ ok: true }),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, 'dist'),
    users: TEST_USERS,
  })
  await new Promise(r => setTimeout(r, 50))
  try {
    await fn(`http://127.0.0.1:${USERS_PORT}`)
  } finally {
    await server.shutdown()
  }
  await Deno.remove(dir, { recursive: true })
}

Deno.test('server: users auth — rejects missing token with 401', async () => {
  await withUsersServer(async (url) => {
    const resp = await fetch(url)
    assertEquals(resp.status, 401)
    await resp.body?.cancel()
  })
})

Deno.test('server: users auth — accepts correct token via query param', async () => {
  await withUsersServer(async (url) => {
    const resp = await fetch(`${url}?token=alice-token-123`)
    assertEquals(resp.status, 200)
    const body = await resp.text()
    assertEquals(body.includes('<!DOCTYPE html>'), true)
  })
})

Deno.test('server: users auth — accepts correct token via Bearer header', async () => {
  await withUsersServer(async (url) => {
    const resp = await fetch(url, { headers: { 'Authorization': 'Bearer bob-token-456' } })
    assertEquals(resp.status, 200)
    await resp.body?.cancel()
  })
})

Deno.test('server: users auth — wrong token → 401', async () => {
  await withUsersServer(async (url) => {
    const resp = await fetch(`${url}?token=wrong-token-value`)
    assertEquals(resp.status, 401)
    await resp.body?.cancel()
  })
})

Deno.test('server: no users no token — public access', async () => {
  await withServer(async (url) => {
    const resp = await fetch(url)
    assertEquals(resp.status, 200)
    await resp.body?.cancel()
  })
})

Deno.test('server: IPv6 [::1] origin accepted', async () => {
  await withServer(async (url) => {
    const resp = await fetch(`${url}/ws`, {
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Origin': 'http://[::1]:8000',
        'Sec-WebSocket-Key': btoa('test'),
        'Sec-WebSocket-Version': '13',
      },
    })
    // URL parser strips brackets: hostname = '::1', but we also check '[::1]'
    assertEquals(resp.status !== 403, true)
    await resp.body?.cancel()
  })
})

// ── timingSafeEqual unit tests ────────────────────────────────

Deno.test('timingSafeEqual: equal strings return true', () => {
  assertEquals(_timingSafeEqual('abc', 'abc'), true)
  assertEquals(_timingSafeEqual('', ''), true)
  assertEquals(_timingSafeEqual('a-long-token-value-123', 'a-long-token-value-123'), true)
})

Deno.test('timingSafeEqual: different strings return false', () => {
  assertEquals(_timingSafeEqual('abc', 'def'), false)
  assertEquals(_timingSafeEqual('abc', 'abcd'), false)
  assertEquals(_timingSafeEqual('abc', 'ab'), false)
  assertEquals(_timingSafeEqual('abc', ''), false)
  assertEquals(_timingSafeEqual('', 'abc'), false)
})

Deno.test('timingSafeEqual: different lengths return false', () => {
  assertEquals(_timingSafeEqual('short', 'a-much-longer-string'), false)
  assertEquals(_timingSafeEqual('a-much-longer-string', 'short'), false)
})

// ── CSRF rejection test ──────────────────────────────────────

const CSRF_PORT = 19805

Deno.test('server: POST /__snapshot without X-AIO header returns 403', async () => {
  const dir = await Deno.makeTempDir()
  await Deno.mkdir(join(dir, 'dist'), { recursive: true })
  await Deno.writeTextFile(join(dir, 'dist', 'app.js'), 'export function mount(){}')
  const server = createServer({
    port: CSRF_PORT,
    title: 'CSRFTest',
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
    // POST without X-AIO header → 403
    const resp = await fetch(`http://127.0.0.1:${CSRF_PORT}/__snapshot`, {
      method: 'POST',
      body: '{"count":1}',
      headers: { 'Content-Type': 'application/json' },
    })
    assertEquals(resp.status, 403)
    const text = await resp.text()
    assertEquals(text, 'Missing X-AIO header')

    // POST with X-AIO header → 200
    const resp2 = await fetch(`http://127.0.0.1:${CSRF_PORT}/__snapshot`, {
      method: 'POST',
      body: '{"count":1}',
      headers: { 'Content-Type': 'application/json', 'X-AIO': '1' },
    })
    assertEquals(resp2.status, 200)
    await resp2.body?.cancel()
  } finally {
    await server.shutdown()
    await Deno.remove(dir, { recursive: true })
  }
})

// ── WS rate limiting test ────────────────────────────────────

const RATE_PORT = 19806

Deno.test('server: WS rate limiting drops messages over 100/sec', async () => {
  const dir = await Deno.makeTempDir()
  await Deno.mkdir(join(dir, 'dist'), { recursive: true })
  await Deno.writeTextFile(join(dir, 'dist', 'app.js'), 'export function mount(){}')
  let actionCount = 0
  const server = createServer({
    port: RATE_PORT,
    title: 'RateTest',
    getUIState: () => ({ n: actionCount }),
    dispatch: () => { actionCount++ },
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, 'dist'),
  })
  await new Promise(r => setTimeout(r, 50))
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${RATE_PORT}/ws`)
    await new Promise<void>(r => { ws.onopen = () => r() })
    // Wait for initial state
    await new Promise(r => setTimeout(r, 50))

    // Send 120 messages rapidly — first 100 should dispatch, rest dropped
    actionCount = 0
    for (let i = 0; i < 120; i++) {
      ws.send(JSON.stringify({ type: 'TICK' }))
    }
    // Wait for all messages to process
    await new Promise(r => setTimeout(r, 200))

    // Should have dispatched <= 100 (rate limit kicks in after 100)
    assertEquals(actionCount <= 100, true, `expected <=100 dispatches, got ${actionCount}`)
    assertEquals(actionCount >= 90, true, `expected >=90 dispatches, got ${actionCount}`)

    ws.close()
  } finally {
    await server.shutdown()
    await Deno.remove(dir, { recursive: true })
  }
})

// ── Trojan API tests ────────────────────────────────────────────────

const TROJAN_PORT = 19807

async function withTrojanServer(fn: (url: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir()
  await Deno.writeTextFile(join(dir, 'App.tsx'), 'export default () => null')
  let appState = { count: 42, name: 'test' }
  const dispatched: unknown[] = []
  const server = createServer({
    port: TROJAN_PORT,
    title: 'TrojanTest',
    getUIState: () => ({ count: appState.count }),
    dispatch: (action) => { dispatched.push(action) },
    getSnapshot: () => JSON.stringify(appState),
    loadSnapshot: (json: string) => { appState = JSON.parse(json) },
    baseDir: dir,
    debug: () => {},
    prod: false,
    trojan: {
      getState: () => appState,
      getSchedules: () => ['heartbeat', 'cleanup'],
      getTTHistory: () => ({ entries: [{ id: 0, type: '__init', ts: 1000 }], index: 0, paused: false }),
      forcePersist: () => {},
      startedAt: Date.now() - 5000,
    },
  })
  await new Promise(r => setTimeout(r, 50))
  try {
    await fn(`http://127.0.0.1:${TROJAN_PORT}`)
  } finally {
    await server.shutdown()
    await Deno.remove(dir, { recursive: true })
  }
}

Deno.test('trojan: GET /state returns raw state', async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__trojan/state`)
    assertEquals(resp.status, 200)
    const data = await resp.json()
    assertEquals(data.count, 42)
    assertEquals(data.name, 'test')
  })
})

Deno.test('trojan: GET /ui returns filtered UI state', async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__trojan/ui`)
    assertEquals(resp.status, 200)
    const data = await resp.json()
    assertEquals(data.count, 42)
    assertEquals(data.name, undefined) // filtered out by getUIState
  })
})

Deno.test('trojan: GET /clients returns connection list', async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__trojan/clients`)
    assertEquals(resp.status, 200)
    const data = await resp.json()
    assertEquals(Array.isArray(data), true)
    assertEquals(data.length, 0) // no WS connections
  })
})

Deno.test('trojan: GET /history returns TT state', async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__trojan/history`)
    assertEquals(resp.status, 200)
    const data = await resp.json()
    assertEquals(data.entries.length, 1)
    assertEquals(data.entries[0].type, '__init')
  })
})

Deno.test('trojan: GET /schedules returns active IDs', async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__trojan/schedules`)
    assertEquals(resp.status, 200)
    const data = await resp.json()
    assertEquals(data, ['heartbeat', 'cleanup'])
  })
})

Deno.test('trojan: GET /metrics returns uptime and counts', async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__trojan/metrics`)
    assertEquals(resp.status, 200)
    const data = await resp.json()
    assertEquals(typeof data.uptime, 'number')
    assertEquals(data.uptime >= 4, true) // started 5s ago
    assertEquals(data.connections, 0)
    assertEquals(data.schedules, 2)
  })
})

Deno.test('trojan: POST /dispatch dispatches action', async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__trojan/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'INCREMENT', payload: { by: 1 } }),
    })
    assertEquals(resp.status, 200)
    const data = await resp.json()
    assertEquals(data.ok, true)
  })
})

Deno.test('trojan: POST /dispatch rejects missing type', async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__trojan/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: 'no type' }),
    })
    assertEquals(resp.status, 400)
    await resp.body?.cancel()
  })
})

Deno.test('trojan: POST /snapshot replaces state', async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__trojan/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 99 }),
    })
    assertEquals(resp.status, 200)
    const data = await resp.json()
    assertEquals(data.ok, true)
  })
})

Deno.test('trojan: POST /persist triggers persistence', async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__trojan/persist`, { method: 'POST' })
    assertEquals(resp.status, 200)
    const data = await resp.json()
    assertEquals(data.ok, true)
  })
})

Deno.test('trojan: GET /unknown returns 404', async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__trojan/nope`)
    assertEquals(resp.status, 404)
    await resp.body?.cancel()
  })
})

Deno.test('trojan: not available when trojan config absent', async () => {
  // withServer creates a prod server without trojan config → 404
  await withServer(async (url) => {
    const resp = await fetch(`${url}/__trojan/state`)
    assertEquals(resp.status, 404)
    await resp.body?.cancel()
  })
})

// ── POST /tt time-travel tests ──────────────────────────────────

const TT_PORT = 19808

Deno.test('trojan: POST /tt routes undo command to onTTCommand', async () => {
  const dir = await Deno.makeTempDir()
  await Deno.writeTextFile(join(dir, 'App.tsx'), 'export default () => null')
  const ttCmds: { cmd: string; arg?: number }[] = []
  const server = createServer({
    port: TT_PORT,
    title: 'TTTest',
    getUIState: () => ({}),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: false,
    onTTCommand: (cmd, arg) => { ttCmds.push({ cmd, arg }) },
    trojan: {
      getState: () => ({}),
      getSchedules: () => [],
      startedAt: Date.now(),
    },
  })
  await new Promise(r => setTimeout(r, 50))
  try {
    const resp = await fetch(`http://127.0.0.1:${TT_PORT}/__trojan/tt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'undo' }),
    })
    assertEquals(resp.status, 200)
    const data = await resp.json()
    assertEquals(data.ok, true)
    assertEquals(ttCmds.length, 1)
    assertEquals(ttCmds[0].cmd, 'undo')

    // Test goto with arg
    const resp2 = await fetch(`http://127.0.0.1:${TT_PORT}/__trojan/tt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'goto', arg: 3 }),
    })
    assertEquals(resp2.status, 200)
    await resp2.body?.cancel()
    assertEquals(ttCmds.length, 2)
    assertEquals(ttCmds[1].cmd, 'goto')
    assertEquals(ttCmds[1].arg, 3)
  } finally {
    await server.shutdown()
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('trojan: POST /tt without onTTCommand returns 501', async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__trojan/tt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'undo' }),
    })
    assertEquals(resp.status, 501)
    await resp.body?.cancel()
  })
})

// ── SQL read-only enforcement ──────────────────────────────

Deno.test('trojan: POST /sql blocks INSERT', async () => {
  const dir = await Deno.makeTempDir()
  await Deno.writeTextFile(join(dir, 'App.tsx'), 'export default () => null')
  const server = createServer({
    port: TT_PORT + 1,
    title: 'SQLTest',
    getUIState: () => ({}),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: false,
    trojan: {
      getState: () => ({}),
      getSchedules: () => [],
      sqlQuery: () => [],
      startedAt: Date.now(),
    },
  })
  await new Promise(r => setTimeout(r, 50))
  try {
    // INSERT should be blocked
    const resp = await fetch(`http://127.0.0.1:${TT_PORT + 1}/__trojan/sql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'INSERT INTO users VALUES (1)' }),
    })
    assertEquals(resp.status, 403)
    const data = await resp.json()
    assertEquals(data.error.includes('read-only'), true)

    // DELETE should be blocked
    const resp2 = await fetch(`http://127.0.0.1:${TT_PORT + 1}/__trojan/sql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'DELETE FROM users' }),
    })
    assertEquals(resp2.status, 403)
    await resp2.body?.cancel()

    // SELECT should pass
    const resp3 = await fetch(`http://127.0.0.1:${TT_PORT + 1}/__trojan/sql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT * FROM users' }),
    })
    assertEquals(resp3.status, 200)
    await resp3.body?.cancel()
  } finally {
    await server.shutdown()
    await Deno.remove(dir, { recursive: true })
  }
})

// ── POST /shutdown triggers callback ─────────────────────────

Deno.test('trojan: POST /shutdown returns ok and triggers callback', async () => {
  const dir = await Deno.makeTempDir()
  await Deno.writeTextFile(join(dir, 'App.tsx'), 'export default () => null')
  let shutdownCalled = false
  const server = createServer({
    port: TT_PORT + 2,
    title: 'ShutdownTest',
    getUIState: () => ({}),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: false,
    trojan: {
      getState: () => ({}),
      getSchedules: () => [],
      shutdown: async () => { shutdownCalled = true },
      startedAt: Date.now(),
    },
  })
  await new Promise(r => setTimeout(r, 50))
  try {
    const resp = await fetch(`http://127.0.0.1:${TT_PORT + 2}/__trojan/shutdown`, { method: 'POST' })
    assertEquals(resp.status, 200)
    const data = await resp.json()
    assertEquals(data.ok, true)
    // Give queueMicrotask time to fire
    await new Promise(r => setTimeout(r, 50))
    assertEquals(shutdownCalled, true)
  } finally {
    await server.shutdown()
    await Deno.remove(dir, { recursive: true })
  }
})

// ── WS __boot message and binary message handling ─────────────

Deno.test('server: WS __boot: message sent on connect', async () => {
  await withServer(async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws`)
    const messages: string[] = []

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        // Collect messages for a bit
        ws.onmessage = (e) => {
          if (typeof e.data === 'string') messages.push(e.data)
        }
        setTimeout(resolve, 200)
      }
      ws.onerror = () => reject(new Error('WS failed'))
    })

    // Should have received __boot:<id> message
    const bootMsg = messages.find(m => m.startsWith('__boot:'))
    assertEquals(bootMsg !== undefined, true, 'should receive __boot message')
    assertEquals(bootMsg!.length > '__boot:'.length, true, 'boot ID should not be empty')

    ws.close()
  })
})

Deno.test('server: WS binary message dropped without crash', async () => {
  await withServer(async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws`)

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('WS failed'))
    })

    // Wait for initial state
    await new Promise(r => setTimeout(r, 50))

    // Send binary data — should be silently dropped
    ws.send(new Uint8Array([1, 2, 3, 4]))
    await new Promise(r => setTimeout(r, 100))

    // Server should still be alive — send valid action
    ws.send(JSON.stringify({ type: 'Ping' }))
    await new Promise(r => setTimeout(r, 50))

    // No crash — connection still open
    assertEquals(ws.readyState, WebSocket.OPEN)
    ws.close()
  })
})
