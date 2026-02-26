import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { parseCli } from '../src/aio.ts'

Deno.test('parseCli: defaults — empty args', () => {
  const r = parseCli([])
  assertEquals(r.debug, false)
  assertEquals(r.port, undefined)
  assertEquals(r.persist, undefined)
  assertEquals(r.electron, undefined)
})

Deno.test('parseCli: --port=3000', () => {
  const r = parseCli(['--port=3000'])
  assertEquals(r.port, 3000)
})

Deno.test('parseCli: --port with invalid value ignored', () => {
  const r = parseCli(['--port=abc'])
  assertEquals(r.port, undefined)
})

Deno.test('parseCli: --port=0 and --port=70000 ignored', () => {
  assertEquals(parseCli(['--port=0']).port, undefined)
  assertEquals(parseCli(['--port=70000']).port, undefined)
})

Deno.test('parseCli: boolean flags', () => {
  const r = parseCli(['--no-persist', '--no-electron', '--keep-alive', '--debug', '--prod'])
  assertEquals(r.persist, false)
  assertEquals(r.electron, false)
  assertEquals(r.keepAlive, true)
  assertEquals(r.debug, true)
  assertEquals(r.prod, true)
})

Deno.test('parseCli: --title=MyApp', () => {
  const r = parseCli(['--title=MyApp'])
  assertEquals(r.title, 'MyApp')
})

Deno.test('parseCli: unknown flag does not crash', () => {
  const r = parseCli(['--unknown-flag'])
  assertEquals(r.debug, false) // still parses fine
})

Deno.test('parseCli: mixed known and unknown flags', () => {
  const r = parseCli(['--debug', '--foo', '--port=9000'])
  assertEquals(r.debug, true)
  assertEquals(r.port, 9000)
})
