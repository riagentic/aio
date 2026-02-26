// HTTP + WebSocket server with live TSX transpilation (dev) or static serving (prod)
import { join, extname, resolve } from '@std/path'

type DispatchFn = (event: unknown) => void
type GetUIStateFn = () => unknown

// Internal config — passed by aio.run(), not user-facing
export interface ServerConfig {
  port: number
  title: string
  getUIState: GetUIStateFn
  dispatch: DispatchFn
  baseDir: string
  debug: (msg: string) => void
  prod?: boolean       // serve pre-built dist/ instead of live-transpiling
  distDir?: string     // absolute path to dist/ (required when prod=true)
}

// Returned to aio.run() so it can push state updates and shut down cleanly
export interface ServerHandle {
  broadcast: () => void
  shutdown: () => Promise<void>
}

function fileExists(path: string): boolean {
  try { Deno.statSync(path); return true } catch { return false }
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
}

// browser.ts path — single source of truth for useAio + msg (transpiled on demand in dev)
const BROWSER_TS = resolve(join(import.meta.dirname ?? '.', 'browser.ts'))

// Escape HTML entities to prevent XSS
function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const IMPORT_MAP = `{
      "imports": {
        "react": "https://esm.sh/react@18.3.1",
        "react-dom/client": "https://esm.sh/react-dom@18.3.1/client",
        "react/jsx-runtime": "https://esm.sh/react@18.3.1/jsx-runtime",
        "aio": "/__aio/ui.js"
      }
    }`

// Generates the HTML shell — dev: CDN import map + live-transpiled App.tsx, prod: self-contained app.js
function generateHTML(title: string, prod: boolean, hasCSS: boolean): string {
  const cssLink = hasCSS ? '\n  <link rel="stylesheet" href="/style.css">' : ''

  if (prod) {
    // Prod: app.js bundles React + useAio + user code, exports mount()
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${escHtml(title)}</title>${cssLink}
</head>
<body>
  <div id="root"></div>
  <script type="module">
    const { mount } = await import('/app.js')
    mount(document.getElementById('root'))
  </script>
</body>
</html>`
  }

  // Dev: CDN React via import map + live transpile + error overlay
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${escHtml(title)}</title>${cssLink}
</head>
<body>
  <div id="root"></div>
  <script type="importmap">${IMPORT_MAP}</script>
  <script type="module">
    import { createElement } from 'react'
    import { createRoot } from 'react-dom/client'
    const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    try {
      const { default: App } = await import('/App.tsx')
      createRoot(document.getElementById('root')).render(createElement(App))
    } catch (e) {
      const r = await fetch('/__aio/error')
      const msg = r.ok ? await r.text() : e.message
      document.getElementById('root').innerHTML =
        '<pre style="margin:2rem;padding:1.5rem;background:#1e1e1e;color:#f44;border-radius:8px;font:14px/1.6 monospace;white-space:pre-wrap;overflow:auto">'
        + '<b style="color:#ff6b6b">Build Error</b>\\n\\n'
        + '<span style="color:#ccc">' + esc(msg) + '</span></pre>'
      const ws = new WebSocket(proto + '//' + location.host + '/ws')
      ws.onmessage = (ev) => { if (ev.data === '__reload') location.reload() }
    }
  </script>
</body>
</html>`
}

// Lazy esbuild — dynamic import with computed specifier so deno compile won't embed the native binary
let transformFn: ((input: string, opts: Record<string, unknown>) => Promise<{ code: string }>) | null = null
async function getTransform() {
  if (!transformFn) {
    const specifier = 'npm:esbuild'
    const mod = await import(specifier)
    transformFn = mod.transform
  }
  return transformFn!
}

// Transpile cache — keyed by filepath, invalidated when source changes
const transpileCache = new Map<string, { source: string; code: string }>()

// Converts .ts/.tsx to browser-ready JS via esbuild (cached, invalidated on file change)
async function transpile(source: string, filepath: string): Promise<string> {
  const cached = transpileCache.get(filepath)
  if (cached && cached.source === source) return cached.code
  const transform = await getTransform()
  const loader = filepath.endsWith('.tsx') ? 'tsx' as const : 'ts' as const
  const result = await transform(source, { loader, format: 'esm', target: 'esnext', jsx: 'automatic', jsxImportSource: 'react' })
  transpileCache.set(filepath, { source, code: result.code })
  return result.code
}

const WS_MAX_MESSAGE = 1_000_000  // 1MB — reject oversized WS messages

// Starts HTTP + WS server, returns broadcast handle
export function createServer(config: ServerConfig): ServerHandle {
  const { port, title, getUIState, dispatch, debug, prod = false, distDir } = config
  const absBaseDir = resolve(config.baseDir)  // normalize to absolute — fixes cache key matching
  const absDistDir = distDir ? resolve(distDir) : null
  // Detect style.css — dev: src/style.css, prod: dist/style.css
  const hasCSS = fileExists(join(absBaseDir, 'style.css')) || (absDistDir ? fileExists(join(absDistDir, 'style.css')) : false)
  if (hasCSS) debug('style.css detected — injecting <link>')
  const connections = new Set<WebSocket>()
  let broadcastQueued = false
  let lastBroadcastState: unknown = null
  let lastKeyJsons: Record<string, string> = {}  // per-key JSON cache for delta detection
  let lastError = ''  // last transpile error — served at /__aio/error

  // Coalesced broadcast — batches multiple state changes into one push
  // Sends delta patches when only a few top-level keys changed, full state otherwise
  function broadcast(): void {
    if (broadcastQueued) return
    broadcastQueued = true
    queueMicrotask(() => {
      broadcastQueued = false
      let uiState: unknown
      try {
        uiState = getUIState()
        if (uiState === lastBroadcastState) return  // skip if state ref unchanged
      } catch (e) {
        debug(`broadcast: getUIState error — ${e}`)
        return
      }

      let msg: string
      if (lastBroadcastState !== null && uiState && typeof uiState === 'object' && !Array.isArray(uiState)) {
        // Compute delta — compare each top-level key's JSON
        const obj = uiState as Record<string, unknown>
        const keys = Object.keys(obj)
        const changed: Record<string, unknown> = {}
        const newKeyJsons: Record<string, string> = {}
        let changedCount = 0

        for (const k of keys) {
          const json = JSON.stringify(obj[k])
          newKeyJsons[k] = json
          if (json !== lastKeyJsons[k]) {
            changed[k] = obj[k]
            changedCount++
          }
        }
        // Track removed keys
        const removed: string[] = []
        for (const k of Object.keys(lastKeyJsons)) {
          if (!(k in newKeyJsons)) { removed.push(k); changedCount++ }
        }

        lastKeyJsons = newKeyJsons

        if (changedCount === 0) {
          lastBroadcastState = uiState
          return  // refs differ but content identical — skip broadcast
        }

        if (changedCount > 0 && changedCount < keys.length * 0.5) {
          // Patch — less than half the keys changed
          const patch: Record<string, unknown> = { $p: changed }
          if (removed.length) patch.$d = removed
          msg = JSON.stringify(patch)
          debug(`broadcast delta (${changedCount}/${keys.length} keys) → ${connections.size} client(s)`)
        } else {
          msg = JSON.stringify(uiState)
          debug(`broadcast full → ${connections.size} client(s)`)
        }
      } else {
        // First broadcast or non-object state — send full
        if (uiState && typeof uiState === 'object' && !Array.isArray(uiState)) {
          const obj = uiState as Record<string, unknown>
          lastKeyJsons = {}
          for (const k of Object.keys(obj)) lastKeyJsons[k] = JSON.stringify(obj[k])
        }
        msg = JSON.stringify(uiState)
        debug(`broadcast full → ${connections.size} client(s)`)
      }

      lastBroadcastState = uiState
      for (const ws of connections) {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg)
      }
    })
  }

  // Upgrades HTTP to WebSocket — sends initial state, forwards actions to dispatch
  function handleWs(req: Request): Response {
    // Validate origin — only accept localhost connections
    const origin = req.headers.get('origin')
    if (origin) {
      try {
        const u = new URL(origin)
        if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
          debug(`ws: rejected origin ${origin}`)
          return new Response('Forbidden', { status: 403 })
        }
      } catch {
        return new Response('Bad Request', { status: 400 })
      }
    }

    const { socket, response } = Deno.upgradeWebSocket(req)
    connections.add(socket)
    socket.onopen = () => {
      debug(`ws: connect (${connections.size} total)`)
      try {
        socket.send(JSON.stringify(getUIState()))
      } catch (e) {
        debug(`ws: getUIState error on connect — ${e}`)
      }
    }
    socket.onmessage = (e) => {
      try {
        if (typeof e.data === 'string' && e.data.length > WS_MAX_MESSAGE) {
          debug(`ws: message too large (${e.data.length} bytes), dropped`)
          return
        }
        const event = JSON.parse(e.data)
        if (!event || typeof event.type !== 'string') {
          debug(`ws: invalid action — missing type field`)
          return
        }
        debug(`ws: recv ${JSON.stringify(event)}`)
        dispatch(event)
      } catch (err) { debug(`ws: malformed message — ${err}`) }
    }
    socket.onclose = () => {
      connections.delete(socket)
      debug(`ws: disconnect (${connections.size} total)`)
    }
    return response
  }

  // Serves HTML, virtual routes, and static/dist files
  async function serveStatic(pathname: string): Promise<Response> {
    if (pathname === '/' || pathname === '/index.html') {
      return new Response(generateHTML(title, prod, hasCSS), { headers: { 'Content-Type': 'text/html' } })
    }

    if (pathname === '/__aio/ui.js') {
      try {
        const source = await Deno.readTextFile(BROWSER_TS)
        const code = await transpile(source, BROWSER_TS)
        return new Response(code, { headers: { 'Content-Type': 'application/javascript' } })
      } catch (err) {
        debug(`transpile browser.ts error: ${err}`)
        return new Response(`throw new Error("browser.ts transpile failed")`, {
          headers: { 'Content-Type': 'application/javascript' },
        })
      }
    }

    if (pathname === '/__aio/error') {
      return new Response(lastError, { headers: { 'Content-Type': 'text/plain' } })
    }

    // Prod: serve bundled assets from distDir
    if (prod && absDistDir && (pathname === '/app.js' || pathname === '/style.css')) {
      const file = pathname.slice(1)  // strip leading /
      try {
        const body = await Deno.readTextFile(join(absDistDir, file))
        const ct = file.endsWith('.css') ? 'text/css' : 'application/javascript'
        return new Response(body, { headers: { 'Content-Type': ct } })
      } catch {
        return new Response('Not Found', { status: 404 })
      }
    }

    const filename = pathname.replace(/^\//, '')
    const filepath = resolve(absBaseDir, filename)
    // Path traversal protection — resolved path must be inside baseDir
    if (!filepath.startsWith(absBaseDir + '/')) {
      return new Response('Forbidden', { status: 403 })
    }
    const ext = extname(filepath)

    let body: string
    try {
      body = await Deno.readTextFile(filepath)
    } catch {
      return new Response('Not Found', { status: 404 })
    }

    let contentType = MIME[ext] ?? 'text/plain'

    // Dev only: live-transpile .ts/.tsx via esbuild
    if (!prod && (ext === '.tsx' || ext === '.ts')) {
      try {
        body = await transpile(body, filepath)
        contentType = 'application/javascript'
        lastError = ''
      } catch (err) {
        debug(`transpile error: ${filepath} — ${err}`)
        lastError = `${filename}: ${err}`
        return new Response(
          `throw new Error(${JSON.stringify(lastError)})`,
          { status: 200, headers: { 'Content-Type': 'application/javascript' } },
        )
      }
    }

    return new Response(body, { headers: { 'Content-Type': contentType } })
  }

  // File watcher — debounced live reload on src/ changes
  let reloadTimer: ReturnType<typeof setTimeout> | null = null
  function scheduleReload(path: string): void {
    debug(`watch: changed ${path}`)
    transpileCache.delete(path)
    if (reloadTimer) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      reloadTimer = null
      debug(`reload → ${connections.size} client(s)`)
      for (const ws of connections) {
        if (ws.readyState === WebSocket.OPEN) ws.send('__reload')
      }
    }, 100)
  }

  // Dev only: watch src/ for changes and live-reload
  if (!prod) {
    ;(async () => {
      try {
        const watcher = Deno.watchFs(absBaseDir, { recursive: true })
        for await (const event of watcher) {
          if (event.kind === 'modify' || event.kind === 'create') {
            for (const path of event.paths) scheduleReload(path)
          }
        }
      } catch (e) { debug(`watch: stopped — ${e}`) }
    })()
  }

  const httpServer = Deno.serve({ port, hostname: '127.0.0.1', onListen: () => {} }, (req) => {
    const { pathname } = new URL(req.url)
    if (pathname === '/ws') return handleWs(req)
    debug(`http: ${req.method} ${pathname}`)
    return serveStatic(pathname)
  })

  return { broadcast, shutdown: () => httpServer.shutdown() }
}
