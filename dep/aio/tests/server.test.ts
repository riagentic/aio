import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { createServer } from '../src/server.ts'
import { join } from '@std/path'

const TEST_PORT = 19876

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
