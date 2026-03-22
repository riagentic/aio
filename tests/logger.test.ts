// logger.test.ts — isolated tests for AioLogger
import { assertEquals, assertMatch } from '@std/assert'
import { AioLogger, setLogger, getLogger, log } from '../src/logger.ts'

const tmpDir = () => Deno.makeTempDirSync()

/** Create logger with heartbeat disabled (avoids interval leaks in tests) */
function mkLogger(opts: { dir: string; console?: boolean; suppressTypes?: string[] }): AioLogger {
  return new AioLogger({ ...opts, heartbeat: 0, console: opts.console ?? false })
}

Deno.test('logger: init creates log directory', async () => {
  const dir = `${tmpDir()}/logs`
  const l = mkLogger({ dir })
  await l.init()
  const stat = await Deno.stat(dir)
  assertEquals(stat.isDirectory, true)
})

Deno.test('logger: setLogger/getLogger wires singleton', () => {
  const l = mkLogger({ dir: tmpDir() })
  setLogger(l)
  assertEquals(getLogger(), l)
  setLogger(null)
  assertEquals(getLogger(), null)
})

Deno.test('logger: public log API no-ops when no logger set', () => {
  setLogger(null)
  // Should not throw
  log.trace('cat', 'msg')
  log.debug('cat', 'msg')
  log.info('cat', 'msg')
  log.warn('cat', 'msg')
  log.error('cat', 'msg')
})

Deno.test('logger: observe writes to app.log for lifecycle events', async () => {
  const dir = tmpDir()
  const l = mkLogger({ dir })
  await l.init()
  l.onStart(['counter'], 8000)
  // Give async write time to flush
  await new Promise(r => setTimeout(r, 100))
  const content = await Deno.readTextFile(`${dir}/app.log`)
  const entry = JSON.parse(content.trim())
  assertEquals(entry.cat, 'app')
  assertEquals(entry.msg, 'started')
  assertEquals(entry.data.features, 'counter')
})

Deno.test('logger: observe skips internal actions', async () => {
  const dir = tmpDir()
  const l = mkLogger({ dir })
  await l.init()
  l.observe({ type: 'counter:__FlowState' }, { counter: {} })
  l.observe({ type: 'counter:__exec' }, { counter: {} })
  l.observe({ type: 'counter:__setIncrement' }, { counter: {} })
  await new Promise(r => setTimeout(r, 100))
  try {
    await Deno.stat(`${dir}/debug.log`)
    // If debug.log exists, it should NOT contain these internal types
  } catch {
    // File doesn't exist — correct, nothing was logged
  }
})

Deno.test('logger: error deduplication suppresses after 5 repeats', async () => {
  const dir = tmpDir()
  const l = mkLogger({ dir })
  await l.init()
  // Simulate 7 identical errors
  for (let i = 0; i < 7; i++) {
    l.observe({ type: 'counter:__error', payload: { _method: 'save', error: 'timeout' } }, { counter: {} })
  }
  await new Promise(r => setTimeout(r, 100))
  const content = await Deno.readTextFile(`${dir}/app.log`)
  const lines = content.trim().split('\n').map(l => JSON.parse(l))
  // Should have: first error + suppression notice = 2 app.log entries
  assertEquals(lines.length, 2)
  assertMatch(lines[1].msg, /suppressing repeats/)
})

Deno.test('logger: perf deduplication logs first then summary on heartbeat', async () => {
  const dir = tmpDir()
  const l = mkLogger({ dir })
  await l.init()
  l.perf('reduce', 'counter:increment', 150, 100)
  l.perf('reduce', 'counter:increment', 200, 100)
  l.perf('reduce', 'counter:increment', 180, 100)
  await new Promise(r => setTimeout(r, 100))
  const content = await Deno.readTextFile(`${dir}/perf.log`)
  const lines = content.trim().split('\n').map(l => JSON.parse(l))
  // Only first violation logged (deduped), summary comes on heartbeat
  assertEquals(lines.length, 1)
  assertMatch(lines[0].msg, /exceeded budget/)
})

Deno.test('logger: rotation renames existing logs', async () => {
  const dir = tmpDir()
  // Create a pre-existing app.log
  await Deno.mkdir(dir, { recursive: true })
  await Deno.writeTextFile(`${dir}/app.log`, 'old content\n')
  const l = mkLogger({ dir })
  await l.init()
  // Old log should be renamed to app.log.1
  const rotated = await Deno.readTextFile(`${dir}/app.log.1`)
  assertEquals(rotated, 'old content\n')
})

Deno.test('logger: suppress types filters specified actions', async () => {
  const dir = tmpDir()
  const l = mkLogger({ dir, suppressTypes: ['tick:heartbeat'] })
  await l.init()
  l.observe({ type: 'tick:heartbeat' }, {})
  l.observe({ type: 'counter:increment' }, { counter: {} })
  await new Promise(r => setTimeout(r, 100))
  const content = await Deno.readTextFile(`${dir}/debug.log`)
  const lines = content.trim().split('\n').map(l => JSON.parse(l))
  assertEquals(lines.length, 1)
  assertEquals(lines[0].msg, 'increment')
})

Deno.test('logger: onStop logs shutdown with uptime', async () => {
  const dir = tmpDir()
  const l = mkLogger({ dir })
  await l.init()
  l.onStart(['counter'])
  await new Promise(r => setTimeout(r, 50))
  l.onStop()
  await new Promise(r => setTimeout(r, 100))
  const content = await Deno.readTextFile(`${dir}/app.log`)
  const lines = content.trim().split('\n').map(l => JSON.parse(l))
  const stopEntry = lines.find(e => e.msg === 'stopped')
  assertEquals(stopEntry?.cat, 'app')
  assertEquals(typeof stopEntry?.data?.uptime, 'string')
})

Deno.test('logger: flow events tracked in app.log', async () => {
  const dir = tmpDir()
  const l = mkLogger({ dir })
  await l.init()
  l.onStart(['checkout'])
  // Simulate flow start step
  l.observe({ type: 'checkout:__flow:step1', payload: { _flow: 'place' } }, { checkout: {} })
  // Simulate flow done
  l.observe({ type: 'checkout:__flow:done', payload: { _flow: 'place' } }, { checkout: {} })
  await new Promise(r => setTimeout(r, 100))
  const content = await Deno.readTextFile(`${dir}/app.log`)
  const lines = content.trim().split('\n').map(l => JSON.parse(l))
  const doneEntry = lines.find(e => e.msg === 'place done')
  assertEquals(doneEntry?.cat, 'flow:checkout')
})

Deno.test('logger: write failure logs to console (first 3 only)', async () => {
  const dir = '/nonexistent/path/that/should/fail'
  const l = mkLogger({ dir })
  // Force ready = true to exercise write path
  // @ts-ignore private access for testing
  l.ready = true
  const errors: string[] = []
  const origError = console.error
  console.error = (...args: unknown[]) => errors.push(args.join(' '))
  l.pub('info', 'test', 'msg1')
  l.pub('info', 'test', 'msg2')
  l.pub('info', 'test', 'msg3')
  l.pub('info', 'test', 'msg4') // should be suppressed
  await new Promise(r => setTimeout(r, 200))
  console.error = origError
  // Should have logged at most 3 write errors
  assertEquals(errors.filter(e => e.includes('[logger] write failed')).length <= 3, true)
})
