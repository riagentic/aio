import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { formatUptime, parsePayload, resolvePort, parseGlobalFlags, readPid, writePid, removePid, isProcessAlive, resolvePath, resolveControlPort } from '../src/am.ts'
import type { PidFile } from '../src/am.ts'
import { createServer } from '../src/server.ts'
import { VERSION } from '../src/aio.ts'
import { join } from '@std/path'

// ── Unit: formatUptime ───────────────────────────────────────

Deno.test('am: formatUptime — seconds', () => {
  assertEquals(formatUptime(0), '0s')
  assertEquals(formatUptime(45), '45s')
  assertEquals(formatUptime(59), '59s')
})

Deno.test('am: formatUptime — minutes', () => {
  assertEquals(formatUptime(60), '1m 0s')
  assertEquals(formatUptime(125), '2m 5s')
  assertEquals(formatUptime(3599), '59m 59s')
})

Deno.test('am: formatUptime — hours', () => {
  assertEquals(formatUptime(3600), '1h 0m')
  assertEquals(formatUptime(7265), '2h 1m')
})

// ── Unit: parsePayload ───────────────────────────────────────

Deno.test('am: parsePayload — key=value pairs', () => {
  assertEquals(parsePayload(['by=5', 'name=alice']), { by: 5, name: 'alice' })
})

Deno.test('am: parsePayload — boolean/null auto-parse', () => {
  assertEquals(parsePayload(['active=true', 'deleted=false', 'data=null']), { active: true, deleted: false, data: null })
})

Deno.test('am: parsePayload — bare key becomes true', () => {
  assertEquals(parsePayload(['force']), { force: true })
})

Deno.test('am: parsePayload — string values', () => {
  assertEquals(parsePayload(['msg=hello world']), { msg: 'hello world' })
})

Deno.test('am: parsePayload — array/object values', () => {
  assertEquals(parsePayload(['tags=[1,2,3]']), { tags: [1, 2, 3] })
})

// ── Unit: resolvePath ────────────────────────────────────────

Deno.test('am: resolvePath — simple key', () => {
  const r = resolvePath({ count: 42 }, 'count')
  assertEquals(r, { found: true, value: 42 })
})

Deno.test('am: resolvePath — nested dot-path', () => {
  const state = { fleet: [{ name: 'a', stats: { pnl: 100 } }] }
  assertEquals(resolvePath(state, 'fleet[0].stats.pnl'), { found: true, value: 100 })
  assertEquals(resolvePath(state, 'fleet[0].name'), { found: true, value: 'a' })
})

Deno.test('am: resolvePath — dot-number still works', () => {
  const state = { fleet: [{ name: 'a' }] }
  assertEquals(resolvePath(state, 'fleet.0.name'), { found: true, value: 'a' })
})

Deno.test('am: resolvePath — missing path', () => {
  assertEquals(resolvePath({ a: 1 }, 'b'), { found: false })
  assertEquals(resolvePath({ a: { b: 1 } }, 'a.c'), { found: false })
})

Deno.test('am: resolvePath — bracket array index', () => {
  assertEquals(resolvePath({ items: ['x', 'y', 'z'] }, 'items[1]'), { found: true, value: 'y' })
})

Deno.test('am: resolvePath — chained brackets', () => {
  const state = { matrix: [[1, 2], [3, 4]] }
  assertEquals(resolvePath(state, 'matrix[1][0]'), { found: true, value: 3 })
})

Deno.test('am: resolvePath — brace-pick from root', () => {
  const state = { counter: 5, page: 'home', items: [1, 2] }
  assertEquals(resolvePath(state, '{counter,page}'), { found: true, value: { counter: 5, page: 'home' } })
})

Deno.test('am: resolvePath — brace-pick from nested path', () => {
  const state = { fleet: [{ name: 'a', stats: { pnl: 100 }, active: true }] }
  assertEquals(resolvePath(state, 'fleet[0].{name,active}'), { found: true, value: { name: 'a', active: true } })
})

Deno.test('am: resolvePath — brace-pick skips missing keys', () => {
  const state = { user: { id: 1, name: 'bob' } }
  assertEquals(resolvePath(state, 'user.{id,role}'), { found: true, value: { id: 1 } })
})

Deno.test('am: resolvePath — brace-pick with nested traverse', () => {
  const state = { owner: { id: 1, name: 'alice', stats: { pnl: 50 } } }
  assertEquals(resolvePath(state, 'owner.{id,stats.pnl}'), { found: true, value: { id: 1, 'stats.pnl': 50 } })
})

Deno.test('am: resolvePath — brace-pick on missing prefix', () => {
  assertEquals(resolvePath({ a: 1 }, 'nope.{x,y}'), { found: false })
})

// ── Unit: resolvePath — wildcard [*] ────────────────────────

Deno.test('am: resolvePath — wildcard plucks field from array', () => {
  const state = { fleet: [{ pair: 'BTC', status: 'on' }, { pair: 'ETH', status: 'off' }] }
  assertEquals(resolvePath(state, 'fleet[*].pair'), { found: true, value: ['BTC', 'ETH'] })
})

Deno.test('am: resolvePath — wildcard with brace-pick', () => {
  const state = { fleet: [{ pair: 'BTC', status: 'on', pnl: 5 }, { pair: 'ETH', status: 'off', pnl: -2 }] }
  const r = resolvePath(state, 'fleet[*].{pair,status}')
  assertEquals(r, { found: true, value: [{ pair: 'BTC', status: 'on' }, { pair: 'ETH', status: 'off' }] })
})

Deno.test('am: resolvePath — wildcard nested path', () => {
  const state = { fleet: [{ stats: { pnl: 10 } }, { stats: { pnl: 20 } }] }
  assertEquals(resolvePath(state, 'fleet[*].stats.pnl'), { found: true, value: [10, 20] })
})

Deno.test('am: resolvePath — wildcard on non-array returns not found', () => {
  assertEquals(resolvePath({ fleet: 'nope' }, 'fleet[*].pair'), { found: false })
})

Deno.test('am: resolvePath — wildcard bare returns full array', () => {
  const state = { items: [1, 2, 3] }
  assertEquals(resolvePath(state, 'items[*]'), { found: true, value: [1, 2, 3] })
})

Deno.test('am: resolvePath — wildcard no matches returns not found', () => {
  const state = { fleet: [{ a: 1 }, { a: 2 }] }
  assertEquals(resolvePath(state, 'fleet[*].missing'), { found: false })
})

// ── Unit: parseGlobalFlags ───────────────────────────────────

Deno.test('am: parseGlobalFlags — basic', () => {
  const r = parseGlobalFlags(['status'])
  assertEquals(r.command, 'status')
  assertEquals(r.args, [])
  assertEquals(r.flags, {})
})

Deno.test('am: parseGlobalFlags — with flags', () => {
  const r = parseGlobalFlags(['--json', '--port=9000', 'state', 'todos'])
  assertEquals(r.command, 'state')
  assertEquals(r.args, ['todos'])
  assertEquals(r.flags.json, true)
  assertEquals(r.flags.port, 9000)
})

Deno.test('am: parseGlobalFlags — --body flag', () => {
  const r = parseGlobalFlags(['dispatch', '--body={"type":"Inc"}'])
  assertEquals(r.command, 'dispatch')
  assertEquals(r.flags.jsonBody, '{"type":"Inc"}')
})

Deno.test('am: parseGlobalFlags — no args defaults to help', () => {
  const r = parseGlobalFlags([])
  assertEquals(r.command, 'help')
})

// ── Unit: PID file I/O ──────────────────────────────────────

Deno.test('am: PID file round-trip', () => {
  const pf: PidFile = { pid: 12345, port: 8000, startedAt: Date.now(), status: 'started' }
  try {
    writePid(pf)
    const read = readPid()
    assertEquals(read, pf)
  } finally {
    removePid()
    assertEquals(readPid(), null)
  }
})

Deno.test('am: readPid returns null when no file', () => {
  removePid() // ensure clean
  assertEquals(readPid(), null)
})

// ── Unit: resolvePort ────────────────────────────────────────

Deno.test('am: resolvePort — flag wins', () => {
  assertEquals(resolvePort(9999), 9999)
})

Deno.test('am: resolvePort — falls back to pid file', () => {
  writePid({ pid: 1, port: 3000, startedAt: 0, status: 'started' })
  try {
    assertEquals(resolvePort(), 3000)
  } finally {
    removePid()
  }
})

Deno.test('am: resolvePort — default 8000', () => {
  removePid()
  assertEquals(resolvePort(), 8000)
})

// ── Unit: isProcessAlive ─────────────────────────────────────

Deno.test('am: isProcessAlive — current process is alive', () => {
  assertEquals(isProcessAlive(Deno.pid), true)
})

Deno.test('am: isProcessAlive — bogus PID is dead', () => {
  assertEquals(isProcessAlive(999999), false)
})

// ── Unit: PidFile status field ────────────────────────────────

Deno.test('am: PidFile with status field round-trip', () => {
  const pf: PidFile = { pid: 42, port: 9000, startedAt: 1000, status: 'starting' }
  try {
    writePid(pf)
    assertEquals(readPid(), pf)
  } finally { removePid() }
})

Deno.test('am: readPid backward compat — old PidFile without status treated as started', () => {
  try {
    // Write old-style PID file (no status field)
    Deno.writeTextFileSync('.aio.pid', JSON.stringify({ pid: 99, port: 8000, startedAt: 500 }))
    const pf = readPid()!
    assertEquals(pf.status, 'started')
    assertEquals(pf.pid, 99)
    assertEquals(pf.port, 8000)
  } finally { removePid() }
})

Deno.test('am: PidFile status transitions', () => {
  try {
    writePid({ pid: 10, port: 8000, startedAt: 0, status: 'starting' })
    assertEquals(readPid()!.status, 'starting')
    writePid({ pid: 10, port: 8000, startedAt: 0, status: 'started' })
    assertEquals(readPid()!.status, 'started')
    writePid({ pid: 10, port: 8000, startedAt: 0, status: 'stopping' })
    assertEquals(readPid()!.status, 'stopping')
  } finally { removePid() }
})

Deno.test('am: PidFile with trojanPort round-trip', () => {
  const pf: PidFile = { pid: 1234, port: 8000, startedAt: Date.now(), status: 'started', trojanPort: 9001 }
  try {
    writePid(pf)
    const loaded = readPid()!
    assertEquals(loaded.trojanPort, 9001)
    assertEquals(loaded.port, 8000)
  } finally { removePid() }
})

Deno.test('am: resolveControlPort returns trojanPort when TLS active', () => {
  try {
    writePid({ pid: 1234, port: 8000, startedAt: Date.now(), status: 'started', trojanPort: 9001 })
    assertEquals(resolveControlPort(8000), 9001)
    assertEquals(resolveControlPort(9999), 9999) // different main port — no match
  } finally { removePid() }
})

Deno.test('am: resolveControlPort falls back to main port without trojanPort', () => {
  try {
    writePid({ pid: 1234, port: 8000, startedAt: Date.now(), status: 'started' })
    assertEquals(resolveControlPort(8000), 8000)
  } finally { removePid() }
})

Deno.test('am: resolveControlPort falls back when no PID file', () => {
  removePid()
  assertEquals(resolveControlPort(8000), 8000)
})

// ── Unit: --wait flag parsing ──────────────────────────────────

Deno.test('am: parseGlobalFlags — --wait=N parsed', () => {
  const r = parseGlobalFlags(['start', '--wait=30', '--port=9000'])
  assertEquals(r.command, 'start')
  assertEquals(r.args, [])
  assertEquals(r.flags.wait, 30)
  assertEquals(r.flags.port, 9000)
})

Deno.test('am: parseGlobalFlags — bare --wait defaults to 0', () => {
  const r = parseGlobalFlags(['stop', '--wait'])
  assertEquals(r.command, 'stop')
  assertEquals(r.flags.wait, 0)
})

Deno.test('am: parseGlobalFlags — no --wait leaves undefined', () => {
  const r = parseGlobalFlags(['start', '--port=9000'])
  assertEquals(r.command, 'start')
  assertEquals(r.flags.wait, undefined)
  assertEquals(r.flags.port, 9000)
})

// ── Unit: --wait for state (watch mode) ───────────────────────

Deno.test('am: parseGlobalFlags — state --wait=5 parsed', () => {
  const r = parseGlobalFlags(['state', 'fleet[0].stats', '--wait=5'])
  assertEquals(r.command, 'state')
  assertEquals(r.args, ['fleet[0].stats'])
  assertEquals(r.flags.wait, 5)
})

// ── Integration: trojan endpoints via live server ────────────

const AM_TEST_PORT = 19860

async function withTrojanServer(fn: (url: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir()
  await Deno.writeTextFile(join(dir, 'App.tsx'), 'export default () => null')
  const appState = { count: 10, items: ['a', 'b'] }
  const server = createServer({
    port: AM_TEST_PORT,
    title: 'AmTest',
    getUIState: () => ({ count: appState.count }),
    dispatch: () => {},
    getSnapshot: () => JSON.stringify(appState),
    loadSnapshot: () => {},
    baseDir: dir,
    debug: () => {},
    prod: false,
    trojan: {
      getState: () => appState,
      getSchedules: () => ['tick'],
      startedAt: Date.now() - 10_000,
    },
  })
  await new Promise(r => setTimeout(r, 50))
  try {
    await fn(`http://127.0.0.1:${AM_TEST_PORT}`)
  } finally {
    await server.shutdown()
    await Deno.remove(dir, { recursive: true })
  }
}

Deno.test('am-integration: trojanGet state', async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__trojan/state`)
    assertEquals(resp.status, 200)
    const data = await resp.json()
    assertEquals(data.count, 10)
    assertEquals(data.items, ['a', 'b'])
  })
})

Deno.test('am-integration: trojanGet config', async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__trojan/config`)
    assertEquals(resp.status, 200)
    const data = await resp.json()
    assertEquals(data.port, AM_TEST_PORT)
    assertEquals(data.title, 'AmTest')
    assertEquals(data.expose, false)
    assertEquals(data.authMode, 'public')
    assertEquals(data.prod, false)
  })
})

Deno.test('am-integration: trojanGet metrics', async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__trojan/metrics`)
    assertEquals(resp.status, 200)
    const data = await resp.json()
    assertEquals(typeof data.uptime, 'number')
    assertEquals(data.uptime >= 9, true)
    assertEquals(data.connections, 0)
    assertEquals(data.schedules, 1)
  })
})

Deno.test('am-integration: trojanPost dispatch', async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__trojan/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'Increment', payload: { by: 1 } }),
    })
    assertEquals(resp.status, 200)
    const data = await resp.json()
    assertEquals(data.ok, true)
  })
})

Deno.test('am-integration: trojanGet schedules', async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__trojan/schedules`)
    assertEquals(resp.status, 200)
    const data = await resp.json()
    assertEquals(data, ['tick'])
  })
})

Deno.test('am-integration: health check via root', async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(url)
    assertEquals(resp.status, 200)
    const body = await resp.text()
    assertEquals(body.includes('<!DOCTYPE html>'), true)
  })
})

// ── Subprocess am tests ──────────────────────────────────────────

const amScript = join(import.meta.dirname ?? '.', '..', 'src', 'am.ts')

/** Run am.ts as subprocess with --json, return parsed JSON output */
async function runAm(args: string[]): Promise<{ code: number; stdout: string; stderr: string; json?: unknown }> {
  const result = await new Deno.Command('deno', {
    args: ['run', '-A', '--unstable-kv', amScript, '--json', `--port=${AM_TEST_PORT}`, ...args],
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  const dec = new TextDecoder()
  const stdout = dec.decode(result.stdout).trim()
  const stderr = dec.decode(result.stderr).trim()
  let json: unknown
  try { json = JSON.parse(stdout) } catch { /* not JSON */ }
  return { code: result.code, stdout, stderr, json }
}

Deno.test('am-cli: state — full state via subprocess', async () => {
  await withTrojanServer(async () => {
    const r = await runAm(['state'])
    assertEquals(r.code, 0)
    const data = r.json as { count: number; items: string[] }
    assertEquals(data.count, 10)
    assertEquals(data.items, ['a', 'b'])
  })
})

Deno.test('am-cli: state — dot-path resolution', async () => {
  await withTrojanServer(async () => {
    const r = await runAm(['state', 'count'])
    assertEquals(r.code, 0)
    assertEquals(r.json, 10)
  })
})

Deno.test('am-cli: state — missing path error', async () => {
  await withTrojanServer(async () => {
    const r = await runAm(['state', 'nonexistent'])
    assertEquals(r.code, 1)
    assertEquals(r.stderr.includes('not found'), true)
  })
})

Deno.test('am-cli: dispatch — send action', async () => {
  await withTrojanServer(async () => {
    const r = await runAm(['dispatch', 'Increment', 'by=1'])
    assertEquals(r.code, 0)
    const data = r.json as { ok: boolean }
    assertEquals(data.ok, true)
  })
})

Deno.test('am-cli: dispatch — --body JSON', async () => {
  await withTrojanServer(async () => {
    const r = await runAm(['dispatch', '--body={"type":"Reset"}'])
    assertEquals(r.code, 0)
    const data = r.json as { ok: boolean }
    assertEquals(data.ok, true)
  })
})

Deno.test('am-cli: clients — list (empty)', async () => {
  await withTrojanServer(async () => {
    const r = await runAm(['clients'])
    assertEquals(r.code, 0)
    assertEquals(Array.isArray(r.json), true)
    assertEquals((r.json as unknown[]).length, 0)
  })
})

Deno.test('am-cli: schedules — list active', async () => {
  await withTrojanServer(async () => {
    const r = await runAm(['schedules'])
    assertEquals(r.code, 0)
    assertEquals(r.json, ['tick'])
  })
})

Deno.test('am-cli: config — returns port + title', async () => {
  await withTrojanServer(async () => {
    const r = await runAm(['config'])
    assertEquals(r.code, 0)
    const data = r.json as { port: number; title: string }
    assertEquals(data.port, AM_TEST_PORT)
    assertEquals(data.title, 'AmTest')
  })
})

Deno.test('am-cli: metrics — returns uptime + connections', async () => {
  await withTrojanServer(async () => {
    const r = await runAm(['metrics'])
    assertEquals(r.code, 0)
    const data = r.json as { uptime: number; connections: number }
    assertEquals(typeof data.uptime, 'number')
    assertEquals(data.connections, 0)
  })
})

Deno.test('am-cli: health — running server ok', async () => {
  await withTrojanServer(async () => {
    const r = await runAm(['health'])
    assertEquals(r.code, 0)
    const data = r.json as { healthy: boolean }
    assertEquals(data.healthy, true)
  })
})

Deno.test('am-cli: health — dead port fails', async () => {
  // No server running on this port
  const result = await new Deno.Command('deno', {
    args: ['run', '-A', '--unstable-kv', amScript, '--json', '--port=19899', 'health'],
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  assertEquals(result.code, 1)
})

Deno.test('am-cli: version — outputs semver', async () => {
  const r = await runAm(['version'])
  assertEquals(r.code, 0)
  const data = r.json as { version: string }
  assertEquals(data.version, VERSION)
})

Deno.test('am-cli: help — lists commands', async () => {
  const r = await runAm(['help'])
  assertEquals(r.code, 0)
  const data = r.json as { commands: string[] }
  assertEquals(Array.isArray(data.commands), true)
  assertEquals(data.commands.includes('start'), true)
  assertEquals(data.commands.includes('state'), true)
  assertEquals(data.commands.includes('dispatch'), true)
})

Deno.test('am-cli: log — reads .aio.log', async () => {
  // Write a temporary log file
  const logContent = 'line1 hello\nline2 world\nline3 error found\n'
  await Deno.writeTextFile('.aio.log', logContent)
  try {
    const result = await new Deno.Command('deno', {
      args: ['run', '-A', '--unstable-kv', amScript, '--json', 'log'],
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    const dec = new TextDecoder()
    const stdout = dec.decode(result.stdout).trim()
    const data = JSON.parse(stdout)
    assertEquals(data.total, 4) // 3 lines + trailing empty
    assertEquals(data.lines.length > 0, true)
  } finally {
    await Deno.remove('.aio.log').catch(() => {})
  }
})

Deno.test('am-cli: log — filter works', async () => {
  await Deno.writeTextFile('.aio.log', 'info: ok\nerror: bad\ninfo: fine\n')
  try {
    const result = await new Deno.Command('deno', {
      args: ['run', '-A', '--unstable-kv', amScript, '--json', 'log', 'error'],
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    const dec = new TextDecoder()
    const stdout = dec.decode(result.stdout).trim()
    const data = JSON.parse(stdout)
    assertEquals(data.filter, 'error')
    assertEquals(data.lines.every((l: string) => l.includes('error')), true)
  } finally {
    await Deno.remove('.aio.log').catch(() => {})
  }
})
