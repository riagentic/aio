import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { parseCli, VERSION } from '../src/aio.ts'
import { electronMainScript, electronClientScript } from '../src/electron.ts'

Deno.test('parseCli: defaults — empty args', () => {
  const r = parseCli([])
  assertEquals(r.verbose, false)
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
  const r = parseCli(['--no-persist', '--no-electron', '--keep-alive', '--verbose', '--prod'])
  assertEquals(r.persist, false)
  assertEquals(r.electron, false)
  assertEquals(r.keepAlive, true)
  assertEquals(r.verbose, true)
  assertEquals(r.prod, true)
})

Deno.test('parseCli: --title=MyApp', () => {
  const r = parseCli(['--title=MyApp'])
  assertEquals(r.title, 'MyApp')
})

Deno.test('parseCli: unknown flag does not crash', () => {
  const r = parseCli(['--unknown-flag'])
  assertEquals(r.verbose, false) // still parses fine
})

Deno.test('parseCli: mixed known and unknown flags', () => {
  const r = parseCli(['--verbose', '--foo', '--port=9000'])
  assertEquals(r.verbose, true)
  assertEquals(r.port, 9000)
})

Deno.test('parseCli: --version sets version flag', () => {
  const r = parseCli(['--version'])
  assertEquals(r.version, true)
})

Deno.test('parseCli: --version alongside other flags', () => {
  const r = parseCli(['--verbose', '--version', '--port=3000'])
  assertEquals(r.version, true)
  assertEquals(r.verbose, true)
  assertEquals(r.port, 3000)
})

Deno.test('parseCli: --expose sets expose flag', () => {
  const r = parseCli(['--expose'])
  assertEquals(r.expose, true)
})

Deno.test('parseCli: --expose alongside other flags', () => {
  const r = parseCli(['--verbose', '--expose', '--port=3000'])
  assertEquals(r.expose, true)
  assertEquals(r.verbose, true)
  assertEquals(r.port, 3000)
})

Deno.test('parseCli: --help sets help flag', () => {
  const r = parseCli(['--help'])
  assertEquals(r.help, true)
})

Deno.test('parseCli: --help alongside other flags', () => {
  const r = parseCli(['--help', '--verbose', '--port=3000'])
  assertEquals(r.help, true)
  assertEquals(r.verbose, true)
  assertEquals(r.port, 3000)
})

Deno.test('parseCli: --url sets url', () => {
  const r = parseCli(['--url=http://192.168.1.100:8000'])
  assertEquals(r.url, 'http://192.168.1.100:8000')
})

Deno.test('parseCli: --url alongside other flags', () => {
  const r = parseCli(['--url=http://10.0.0.5:3000?token=abc', '--title=Remote'])
  assertEquals(r.url, 'http://10.0.0.5:3000?token=abc')
  assertEquals(r.title, 'Remote')
})

Deno.test('parseCli: bare --url sets empty string', () => {
  const r = parseCli(['--url'])
  assertEquals(r.url, '')
})

Deno.test('parseCli: --url-like flag is unknown, not swallowed by --url prefix', () => {
  const r = parseCli(['--url-transform=foo'])
  assertEquals(r.url, undefined)
})

Deno.test('parseCli: --headless flag', () => {
  const r = parseCli(['--headless'])
  assertEquals(r.headless, true)
})

Deno.test('parseCli: --width and --height', () => {
  const r = parseCli(['--width=1024', '--height=768'])
  assertEquals(r.width, 1024)
  assertEquals(r.height, 768)
})

Deno.test('parseCli: --width and --height ignore invalid values', () => {
  assertEquals(parseCli(['--width=abc']).width, undefined)
  assertEquals(parseCli(['--height=-1']).height, undefined)
})

Deno.test('electronMainScript: uses full URL', () => {
  const script = electronMainScript('http://192.168.1.100:8000?token=abc')
  assertEquals(script.includes('http://192.168.1.100:8000?token=abc'), true)
  assertEquals(script.includes('BrowserWindow'), true)
})

Deno.test('electronMainScript: accepts AioMeta', () => {
  const script = electronMainScript('http://localhost:3000', { width: 1024, height: 768 })
  assertEquals(script.includes('loadBounds(1024, 768)'), true)
})

Deno.test('electronMainScript: defaults when no meta', () => {
  const script = electronMainScript('http://localhost:3000')
  assertEquals(script.includes('loadBounds(800, 600)'), true)
})

Deno.test('electronMainScript: persists window bounds', () => {
  const script = electronMainScript('http://localhost:3000')
  assertEquals(script.includes('window-state.json'), true)
  assertEquals(script.includes('saveBounds'), true)
})

Deno.test('electronMainScript: sets app.name from title for stable userData', () => {
  const script = electronMainScript('http://localhost:3000', { title: 'My Dashboard' })
  assertEquals(script.includes('app.name = "my-dashboard"'), true)
})

Deno.test('electronMainScript: app.name defaults to aio-app without title', () => {
  const script = electronMainScript('http://localhost:3000')
  assertEquals(script.includes('app.name = "aio-app"'), true)
})

Deno.test('electronClientScript: sets app.name to aio-client', () => {
  const script = electronClientScript()
  assertEquals(script.includes("app.name = 'aio-client'"), true)
})

Deno.test('electronClientScript: contains connect page HTML', () => {
  const script = electronClientScript()
  assertEquals(script.includes('CONNECT_HTML'), true)
  assertEquals(script.includes('<h1>aio</h1>'), true)
  assertEquals(script.includes('placeholder="192.168'), true)
})

Deno.test('electronClientScript: contains parseMeta function', () => {
  const script = electronClientScript()
  assertEquals(script.includes('function parseMeta'), true)
  assertEquals(script.includes('aio:width'), true)
  assertEquals(script.includes('aio:height'), true)
})

Deno.test('electronClientScript: contains connectTo function', () => {
  const script = electronClientScript()
  assertEquals(script.includes('async function connectTo'), true)
  assertEquals(script.includes('setSize'), true)
  assertEquals(script.includes('setTitle'), true)
  assertEquals(script.includes('/icon.png'), true)
})

Deno.test('electronClientScript: handles --url= from argv', () => {
  const script = electronClientScript()
  assertEquals(script.includes('--url='), true)
  assertEquals(script.includes('process.argv'), true)
})

Deno.test('VERSION is a semver string', () => {
  assertEquals(typeof VERSION, 'string')
  assertEquals(/^\d+\.\d+\.\d+$/.test(VERSION), true)
})

// ── electronMainScript: edge cases ──────────────────────────────

Deno.test('electronMainScript: special char title slugified', () => {
  const script = electronMainScript('http://localhost:3000', { title: 'My App! @v2' })
  assertEquals(script.includes('app.name = "my-app-v2"'), true)
})

Deno.test('electronMainScript: empty title defaults to aio-app', () => {
  const script = electronMainScript('http://localhost:3000', { title: '' })
  assertEquals(script.includes('app.name = "aio-app"'), true)
})

Deno.test('electronMainScript: keyboard shortcuts F5 and F12 present', () => {
  const script = electronMainScript('http://localhost:3000')
  assertEquals(script.includes("input.key === 'F5'"), true)
  assertEquals(script.includes("input.key === 'F12'"), true)
  assertEquals(script.includes('reloadIgnoringCache'), true)
  assertEquals(script.includes('toggleDevTools'), true)
})

Deno.test('electronMainScript: nodeIntegration disabled, contextIsolation true', () => {
  const script = electronMainScript('http://localhost:3000')
  assertEquals(script.includes('nodeIntegration: false'), true)
  assertEquals(script.includes('contextIsolation: true'), true)
})

Deno.test('electronMainScript: Menu.setApplicationMenu(null) present', () => {
  const script = electronMainScript('http://localhost:3000')
  assertEquals(script.includes('Menu.setApplicationMenu(null)'), true)
})

// ── electronClientScript: edge cases ──────────────────────────────

Deno.test('electronClientScript: redirect limit handling', () => {
  const script = electronClientScript()
  assertEquals(script.includes('maxRedirects'), true)
  assertEquals(script.includes('Too many redirects'), true)
  assertEquals(script.includes('non-HTTP scheme'), true)
})

Deno.test('electronClientScript: nodeIntegration disabled', () => {
  const script = electronClientScript()
  assertEquals(script.includes('nodeIntegration: false'), true)
  assertEquals(script.includes('contextIsolation: true'), true)
})
