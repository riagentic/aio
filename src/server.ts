// HTTP + WebSocket server with live TSX transpilation (dev) or static serving (prod)
import { join, extname, resolve, SEPARATOR } from '@std/path'
import type { AioUser } from './aio.ts'

type DispatchFn = (event: unknown, user?: AioUser) => void
type GetUIStateFn = (user?: AioUser) => unknown

/** Internal config — passed by aio.run(), not user-facing */
export interface ServerConfig {
  port: number
  socketPath?: string          // Unix domain socket path — when set, serves over UDS instead of TCP
  title: string
  width?: number           // window width hint (embedded in HTML meta)
  height?: number          // window height hint (embedded in HTML meta)
  getUIState: GetUIStateFn    // optional user for per-user filtering
  dispatch: DispatchFn
  getSnapshot?: () => string
  loadSnapshot?: (json: string) => void
  baseDir: string
  debug: (msg: string) => void
  prod?: boolean           // serve pre-built dist/ instead of live-transpiling
  distDir?: string         // absolute path to dist/ (required when prod=true)
  expose?: boolean         // bind 0.0.0.0 instead of 127.0.0.1
  token?: string           // access token required when expose=true (no users)
  cert?: string            // PEM cert string — enables HTTPS when set (auto-generated when --expose)
  key?: string             // PEM key string — required when cert is set
  users?: Record<string, AioUser>  // per-user token map (overrides token)
  showStatus?: boolean     // show reconnection indicator (default: true)
  deltaThreshold?: number  // 0-1: ratio of changed keys for delta vs full broadcast (default: 0.5)
  maxConnections?: number  // max concurrent WebSocket clients (default: 100)
  syncRate?: number        // throttle UI updates: max 1 push per N ms (default: 10 = 100fps)
  allowedOrigins?: string[]  // extra allowed origins beyond localhost (e.g. Docker, reverse proxy)
  onConnect?: (user?: AioUser) => void
  onDisconnect?: (user?: AioUser) => void
  // Time-travel (dev mode)
  onTTCommand?: (cmd: string, arg?: number) => void
  getTTBroadcast?: () => unknown
  // Health endpoint — GET /__health
  getHealth?: () => unknown
  // Trojan — control API (localhost-only, auth-gated when exposed)
  trojan?: {
    getState: () => unknown                  // raw unfiltered state
    getSchedules: () => string[]             // active schedule IDs
    getTTHistory?: () => unknown             // time-travel entries (wire format)
    forcePersist?: () => void                // trigger immediate persist
    sqlQuery?: (sql: string) => Promise<unknown[]>  // read-only SQL query (async)
    shutdown?: () => Promise<void>           // graceful shutdown
    startedAt: number                        // Date.now() at boot
  }
}

// Constant-time string comparison — prevents timing attacks on token auth
// Compares full length even on mismatch to avoid leaking token length
export function _timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder()
  const ab = encoder.encode(a)
  const bb = encoder.encode(b)
  const len = Math.max(ab.length, bb.length)
  let result = ab.length ^ bb.length  // length difference contributes to result
  for (let i = 0; i < len; i++) result |= (ab[i] ?? 0) ^ (bb[i] ?? 0)
  return result === 0
}

/** Resolves user from token map — checks query param and Authorization header */
function resolveUser(users: Record<string, AioUser>, url: URL, req: Request): AioUser | null {
  const qToken = url.searchParams.get('token')
  const auth = req.headers.get('authorization')
  const hToken = auth?.startsWith('Bearer ') ? auth.slice(7) : null
  for (const candidate of [qToken, hToken]) {
    if (!candidate) continue
    for (const [t, user] of Object.entries(users)) {
      if (_timingSafeEqual(candidate, t)) return user
    }
  }
  return null
}

/** Returned to aio.run() so it can push state updates and shut down cleanly */
export interface ServerHandle {
  broadcast: () => void
  broadcastTT: () => void
  shutdown: () => Promise<void>
  clientCount: () => number
  trojanPort?: number  // set when TLS is active — HTTP-only trojan endpoint on 127.0.0.1
  socketPath?: string  // set when UDS is active
}

function fileExists(path: string): boolean {
  try { Deno.statSync(path); return true } catch { return false }
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.md': 'text/plain',
  '.xml': 'application/xml',
}

// Extensions that should be read as text (readTextFile) — everything else is binary (readFile)
const TEXT_EXTENSIONS = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.md', '.xml', '.ts', '.tsx'])

// browser.ts path — single source of truth for useAio + msg (transpiled on demand in dev)
const BROWSER_TS = resolve(join(import.meta.dirname ?? '.', 'browser.ts'))

// Escape HTML entities to prevent XSS (includes ' for completeness even though current use is double-quote-delimited)
function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
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
function generateHTML(title: string, prod: boolean, hasCSS: boolean, showStatus?: boolean, width?: number, height?: number): string {
  const cssLink = hasCSS ? '\n  <link rel="stylesheet" href="/style.css">' : ''
  const statusScript = showStatus === false ? '\n  <script>window.__aioShowStatus=false</script>' : ''
  const metaW = width ? `\n  <meta name="aio:width" content="${width}">` : ''
  const metaH = height ? `\n  <meta name="aio:height" content="${height}">` : ''

  if (prod) {
    // Prod: app.js bundles React + useAio + user code, exports mount()
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="referrer" content="no-referrer">
  <title>${escHtml(title)}</title>${metaW}${metaH}${cssLink}${statusScript}
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
  <meta name="referrer" content="no-referrer">
  <title>${escHtml(title)}</title>${metaW}${metaH}${cssLink}${statusScript}
</head>
<body>
  <div id="root"></div>
  <script type="importmap">${IMPORT_MAP}</script>
  <script type="module">
    import { createElement } from 'react'
    import { createRoot } from 'react-dom/client'
    const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    // Dev reload WS — always active so live reload works even without useAio
    const _tk = new URLSearchParams(location.search).get('token')
    const _wsUrl = proto + '//' + location.host + '/ws' + (_tk ? '?token=' + encodeURIComponent(_tk) : '')
    let _bootId = null
    function _devWs() {
      const ws = new WebSocket(_wsUrl)
      ws.onmessage = ev => {
        if (ev.data === '__reload') { ws.close(); location.reload() }
        else if (ev.data === '__css') {
          const link = document.querySelector('link[rel="stylesheet"][href*="style.css"]')
          if (link) link.href = '/style.css?t=' + Date.now()
        } else if (typeof ev.data === 'string' && ev.data.startsWith('__boot:')) {
          const id = ev.data.slice(7)
          if (_bootId && _bootId !== id) { ws.close(); location.reload() }
          _bootId = id
        }
      }
      ws.onclose = () => setTimeout(_devWs, 2000)
    }
    _devWs()
    try {
      const { default: App } = await import('/App.tsx?v=' + Date.now())
      createRoot(document.getElementById('root')).render(createElement(App))
    } catch (e) {
      console.error('[aio] App load failed:', e)
      const r = await fetch('/__aio/error')
      const errData = r.ok ? await r.json().catch(() => null) : null
      const hasServerErr = errData && errData.errors && errData.errors.length
      const label = hasServerErr ? 'Build Error' : 'Runtime Error'
      fetch('/__aio/client-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: e?.message, stack: e?.stack })
      }).catch(() => {})
      function mkBuildErrors(errors) {
        return errors.map(function(err) {
          const prefix = err.line != null ? String(err.line) + ' | ' : ''
          const caretDiv = (err.col != null && prefix)
            ? '<div style="padding-left:calc(' + (err.col + prefix.length) + '*1ch);color:#ff6b6b;line-height:1">^</div>'
            : ''
          return '<div style="margin-bottom:1.5rem">'
            + (err.file ? '<div style="color:#569cd6;margin-bottom:.35rem">' + esc(err.file) + (err.line != null ? ':' + err.line : '') + (err.col != null ? ':' + err.col : '') + '</div>' : '')
            + '<div style="color:#f1fa8c;margin-bottom:.5rem">' + esc(err.text) + '</div>'
            + (err.lineText ? '<div style="background:#0d1117;padding:.5rem .85rem;border-radius:4px;border-left:3px solid #ff6b6b"><span style="color:#555">' + esc(prefix) + '</span><span style="color:#ddd">' + esc(err.lineText) + '</span>' + caretDiv + '</div>' : '')
            + '</div>'
        }).join('')
      }
      function mkStack(stack) {
        if (!stack) return '<div style="color:#555">(no stack trace)</div>'
        const lines = stack.split('\\n')
        const frames = lines.slice(1).map(function(f) {
          const t = f.trim()
          const dim = !t || t.includes('node_modules') || (t.includes('deno:') && !t.includes(location.host))
          return '<div style="padding:.05rem 0;color:' + (dim ? '#444' : '#bbb') + '">' + esc(t) + '</div>'
        })
        return '<div style="color:#f1fa8c;margin-bottom:.75rem">' + esc(lines[0]) + '</div>'
          + '<div style="background:#0d1117;padding:.6rem .9rem;border-radius:4px">' + frames.join('') + '</div>'
      }
      const body = hasServerErr ? mkBuildErrors(errData.errors) : mkStack(e?.stack)
      document.getElementById('root').innerHTML =
        '<div style="margin:0;padding:1.75rem 2rem;min-height:100vh;background:#141414;font:13px/1.7 monospace;box-sizing:border-box">'
        + '<div style="max-width:920px">'
        + '<div style="color:#ff6b6b;font-size:1.1rem;font-weight:700;margin-bottom:1.25rem;padding-bottom:.75rem;border-bottom:1px solid #2a2a2a">&#9888; ' + label + '</div>'
        + body
        + '<div style="margin-top:1.5rem;padding-top:.75rem;border-top:1px solid #2a2a2a;color:#444;font-size:11px">F12 DevTools &nbsp;&#183;&nbsp; am errors &nbsp;&#183;&nbsp; ' + new Date().toLocaleTimeString() + '</div>'
        + '</div></div>'
    }
  </script>
</body>
</html>`
}

type EsbuildMessage = { text: string; location?: { file?: string; line?: number; column?: number; lineText?: string } | null }
type TransformResult = { code: string; warnings: EsbuildMessage[] }

// Lazy esbuild — dynamic import with computed specifier so deno compile won't embed the native binary
let transformFn: ((input: string, opts: Record<string, unknown>) => Promise<TransformResult>) | null = null
async function getTransform() {
  if (!transformFn) {
    const mod = await import('npm:esbuild@^0.24')
    transformFn = mod.transform as (input: string, opts: Record<string, unknown>) => Promise<TransformResult>
  }
  return transformFn!
}

// Transpile cache — keyed by filepath, invalidated when source changes, capped at 200 entries
const TRANSPILE_CACHE_MAX = 200
const transpileCache = new Map<string, { source: string; code: string }>()

/** Formats esbuild message with location info: "text (file:line:col)\n  > lineText" */
function fmtEsbuildMsg(m: EsbuildMessage, file?: string): string {
  const loc = m.location
  const where = loc ? ` (${loc.file ?? file ?? '?'}:${loc.line}:${loc.column})` : ''
  const line = loc?.lineText ? `\n  > ${loc.lineText}` : ''
  return `${m.text}${where}${line}`
}

/** Extracts readable errors from esbuild exceptions */
function fmtEsbuildError(err: unknown, file: string): string {
  const e = err as { errors?: EsbuildMessage[] }
  if (e.errors?.length) return e.errors.map(m => fmtEsbuildMsg(m, file)).join('\n')
  return String(err)
}

// Converts .ts/.tsx to browser-ready JS via esbuild (cached, invalidated on file change)
async function transpile(source: string, filepath: string, log?: (msg: string) => void): Promise<string> {
  const cached = transpileCache.get(filepath)
  if (cached && cached.source === source) return cached.code
  const transform = await getTransform()
  const loader = filepath.endsWith('.tsx') ? 'tsx' as const : 'ts' as const
  const result = await transform(source, { loader, format: 'esm', target: 'esnext', jsx: 'automatic', jsxImportSource: 'react' })
  if (result.warnings?.length && log) {
    for (const w of result.warnings) log(`esbuild warning: ${fmtEsbuildMsg(w, filepath)}`)
  }
  if (transpileCache.size >= TRANSPILE_CACHE_MAX) {
    // Evict oldest entry (first inserted key)
    const oldest = transpileCache.keys().next().value
    if (oldest) transpileCache.delete(oldest)
  }
  transpileCache.set(filepath, { source, code: result.code })
  return result.code
}

/** Safety limits — prevent resource exhaustion */
const WS_MAX_MESSAGE = 1_000_000  // 1MB — reject oversized WS messages
const WS_MAX_CONNECTIONS = 100    // max concurrent WebSocket clients
const SNAPSHOT_MAX_SIZE = 10_000_000  // 10MB — reject oversized snapshot uploads

/** Delta computation result */
export type DeltaResult = { msg: string; newKeyJsons: Record<string, string>; kind: 'skip' | 'delta' | 'full' }

/** Flatten one level: for object-valued top-level keys, use dot-notation (e.g. "mdview.scrollY").
 *  Primitive/array top-level values stay as-is. This gives v0.5 namespaced state fine-grained delta. */
function flattenKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const flat: Record<string, unknown> = {}
  for (const k of Object.keys(obj)) {
    const v = obj[k]
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const sk of Object.keys(v as Record<string, unknown>)) {
        flat[`${k}.${sk}`] = (v as Record<string, unknown>)[sk]
      }
    } else {
      flat[k] = v
    }
  }
  return flat
}

/** Unflatten dot-notation keys back into nested structure for the patch */
function unflattenPatch(changed: Record<string, unknown>, removed: string[]): { $p: Record<string, unknown>; $d?: string[] } {
  const patch: Record<string, unknown> = {}
  const topDeletions: string[] = []
  for (const [k, v] of Object.entries(changed)) {
    const dot = k.indexOf('.')
    if (dot === -1) { patch[k] = v; continue }
    const parent = k.slice(0, dot)
    const child = k.slice(dot + 1)
    if (!patch[parent] || typeof patch[parent] !== 'object') patch[parent] = {}
    ;(patch[parent] as Record<string, unknown>)[child] = v
  }
  for (const k of removed) {
    const dot = k.indexOf('.')
    if (dot === -1) { topDeletions.push(k); continue }
    // Nested removal: "mdview.oldKey" → { mdview: { $d: ['oldKey'] } }
    const parent = k.slice(0, dot)
    const child = k.slice(dot + 1)
    if (!patch[parent] || typeof patch[parent] !== 'object') patch[parent] = {}
    const p = patch[parent] as Record<string, unknown>
    if (!p.$d) p.$d = []
    ;(p.$d as string[]).push(child)
  }
  const result: { $p: Record<string, unknown>; $d?: string[] } = { $p: patch }
  if (topDeletions.length) result.$d = topDeletions
  return result
}

/** Computes delta patch between old and new UI state — pure function, testable in isolation.
 *  Uses dot-notation for object-valued top-level keys (v0.5 namespaced state) to enable
 *  fine-grained delta within feature slices. */
export function _computeDelta(
  uiState: unknown,
  lastState: unknown,
  lastKeyJsons: Record<string, string>,
  threshold = 0.5,
): DeltaResult {
  // First broadcast or non-object state — full send
  if (lastState === null || !uiState || typeof uiState !== 'object' || Array.isArray(uiState)) {
    const newKeyJsons: Record<string, string> = {}
    if (uiState && typeof uiState === 'object' && !Array.isArray(uiState)) {
      const flat = flattenKeys(uiState as Record<string, unknown>)
      for (const k of Object.keys(flat)) newKeyJsons[k] = JSON.stringify(flat[k])
    }
    return { msg: JSON.stringify(uiState), newKeyJsons, kind: 'full' }
  }

  const flat = flattenKeys(uiState as Record<string, unknown>)
  const lastFlat = flattenKeys(lastState as Record<string, unknown>)
  const keys = Object.keys(flat)
  const changed: Record<string, unknown> = {}
  const newKeyJsons: Record<string, string> = {}
  let changedCount = 0

  for (const k of keys) {
    // Skip stringify for unchanged references (check via flattened last)
    if (flat[k] === lastFlat[k] && lastKeyJsons[k]) {
      newKeyJsons[k] = lastKeyJsons[k]
      continue
    }
    const json = JSON.stringify(flat[k])
    newKeyJsons[k] = json
    if (json !== lastKeyJsons[k]) { changed[k] = flat[k]; changedCount++ }
  }
  const removed: string[] = []
  for (const k of Object.keys(lastKeyJsons)) {
    if (!(k in newKeyJsons)) { removed.push(k); changedCount++ }
  }

  if (changedCount === 0) return { msg: '', newKeyJsons, kind: 'skip' }

  // Patch when changed ratio is below threshold (default 50% — small patches are cheaper than full state).
  // Use max(new, old) key count so removals don't shrink the denominator and bias toward full state.
  const totalKeys = Math.max(keys.length, Object.keys(lastKeyJsons).length)
  if (changedCount < totalKeys * threshold) {
    const patch = unflattenPatch(changed, removed)
    return { msg: JSON.stringify(patch), newKeyJsons, kind: 'delta' }
  }

  return { msg: JSON.stringify(uiState), newKeyJsons, kind: 'full' }
}

/** Starts HTTP + WS server, returns broadcast handle for state pushes and shutdown */
export function createServer(config: ServerConfig): ServerHandle {
  const { port, title, getUIState, dispatch, debug, prod = false, distDir } = config
  const absBaseDir = resolve(config.baseDir)  // normalize to absolute — fixes cache key matching
  const absDistDir = distDir ? resolve(distDir) : null
  // Detect style.css — dev: src/style.css, prod: dist/style.css
  const hasCSS = fileExists(join(absBaseDir, 'style.css')) || (absDistDir ? fileExists(join(absDistDir, 'style.css')) : false)
  if (hasCSS) debug('style.css detected — injecting <link>')
  const WS_RATE_LIMIT = 100  // max messages per second per client
  const WS_BYTES_PER_SEC = 5_000_000  // 5MB/s per client — prevents bandwidth DoS
  type ClientMeta = { id: string; user?: AioUser; lastState: unknown; lastKeyJsons: Record<string, string>; msgCount: number; bytesThisSec: number; msgResetTimer?: ReturnType<typeof setTimeout> }
  const connections = new Map<WebSocket, ClientMeta>()
  const syncRate = config.syncRate ?? 10
  let broadcastQueued = false
  let broadcastDirty = false
  let broadcastThrottle: ReturnType<typeof setTimeout> | null = null
  let lastError = ''  // last transpile error — served at /__aio/error
  let lastErrorData: { errors: Array<{ text: string; file?: string; line?: number; col?: number; lineText?: string }> } | null = null
  const bootId = crypto.randomUUID().slice(0, 8)  // unique per server start — triggers browser reload on reconnect
  const noCache = prod ? {} : { 'Cache-Control': 'no-store' } as Record<string, string>  // prevent Electron/browser caching in dev

  // Coalesced + throttled broadcast — batches synchronous bursts via microtask; optionally throttles async streams
  // Leading edge fires immediately (after microtask coalesce); trailing flush ensures last state always arrives
  // Per-client delta: each client tracks its own lastState/lastKeyJsons (supports getUIState per client)
  function broadcast(): void {
    broadcastDirty = true

    if (broadcastQueued) return        // microtask already pending this tick
    if (syncRate > 0 && broadcastThrottle) return  // inside throttle window — trailing flush will catch it

    broadcastQueued = true
    queueMicrotask(() => {
      broadcastQueued = false
      broadcastDirty = false
      try {
        for (const [ws, meta] of connections) {
          if (ws.readyState !== WebSocket.OPEN) continue
          let uiState: unknown
          try {
            uiState = getUIState(meta.user)
          } catch (e) {
            debug(`broadcast: getUIState error — ${e}`)
            continue
          }
          if (uiState === meta.lastState) continue  // skip if ref unchanged
          const delta = _computeDelta(uiState, meta.lastState, meta.lastKeyJsons, config.deltaThreshold)
          meta.lastState = uiState
          meta.lastKeyJsons = delta.newKeyJsons
          if (delta.kind === 'skip') continue
          debug(`broadcast ${delta.kind} → client ${meta.id.slice(0, 8)}`)
          try { ws.send(delta.msg) } catch { /* client disconnecting */ }
        }
      } catch (e) { debug(`broadcast error: ${e}`) }

      if (syncRate > 0) {
        broadcastThrottle = setTimeout(() => {
          broadcastThrottle = null
          if (broadcastDirty) broadcast()  // trailing flush — last state always reaches UI
        }, syncRate)
      }
    })
  }

  // Upgrades HTTP to WebSocket — sends initial state, forwards actions to dispatch
  function handleWs(req: Request, user?: AioUser): Response {
    // Validate origin — only accept localhost connections (skip when exposed — token handles auth)
    if (!config.expose) {
      const origin = req.headers.get('origin')
      if (origin) {
        try {
          const u = new URL(origin)
          const h = u.hostname
          const isLocal = h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]'
          const isAllowed = config.allowedOrigins?.includes(h) ?? false
          if (!isLocal && !isAllowed) {
            debug(`ws: rejected origin ${origin}`)
            return new Response('Forbidden', { status: 403 })
          }
        } catch {
          return new Response('Bad Request', { status: 400 })
        }
      }
    }

    const maxConn = config.maxConnections ?? WS_MAX_CONNECTIONS
    if (connections.size >= maxConn) {
      debug(`ws: rejected — max connections (${maxConn})`)
      return new Response('Too Many Connections', { status: 503 })
    }
    const { socket, response } = Deno.upgradeWebSocket(req)
    const clientId = crypto.randomUUID()
    const meta: ClientMeta = { id: clientId, user, lastState: null, lastKeyJsons: {}, msgCount: 0, bytesThisSec: 0 }
    socket.onerror = (e) => {
      debug(`ws: error ${clientId.slice(0, 8)} — ${e instanceof ErrorEvent ? e.message : e}`)
      connections.delete(socket)
    }
    socket.onopen = () => {
      connections.set(socket, meta)
      debug(`ws: connect ${clientId.slice(0, 8)} user=${user?.id ?? 'anon'} (${connections.size} total)`)
      if (config.onConnect) try { config.onConnect(meta.user) } catch (e) { debug(`hook onConnect: ${e}`) }
      try {
        const uiState = getUIState(meta.user)
        const msg = JSON.stringify(uiState)
        // Init delta cache so first broadcast computes a proper delta (dot-notation for nested)
        if (uiState && typeof uiState === 'object' && !Array.isArray(uiState)) {
          const flat = flattenKeys(uiState as Record<string, unknown>)
          for (const k of Object.keys(flat)) meta.lastKeyJsons[k] = JSON.stringify(flat[k])
        }
        meta.lastState = uiState
        socket.send(msg)
      } catch (e) {
        debug(`ws: getUIState error on connect — ${e}`)
      }
      // Send TT metadata on connect (dev mode)
      if (config.getTTBroadcast) {
        try {
          const ttData = config.getTTBroadcast()
          socket.send('__tt:' + JSON.stringify(ttData))
        } catch (e) { debug(`ws: getTTBroadcast error on connect — ${e}`) }
      }
      // Boot ID — browser reloads page if server restarted (stale JS in memory)
      socket.send('__boot:' + bootId)
    }
    socket.onmessage = (e) => {
      try {
        // Rate limiting — reset counters every second
        meta.msgCount++
        if (!meta.msgResetTimer) {
          meta.msgResetTimer = setTimeout(() => { meta.msgCount = 0; meta.bytesThisSec = 0; meta.msgResetTimer = undefined }, 1000)
        }
        if (meta.msgCount > WS_RATE_LIMIT) {
          debug(`ws: rate limit exceeded for ${meta.id.slice(0, 8)} (${meta.msgCount}/s)`)
          return
        }
        if (typeof e.data !== 'string') {
          debug(`ws: binary message dropped — only JSON strings accepted`)
          return
        }
        if (e.data.length > WS_MAX_MESSAGE) {
          debug(`ws: message too large (${e.data.length} bytes), dropped`)
          return
        }
        meta.bytesThisSec += e.data.length
        if (meta.bytesThisSec > WS_BYTES_PER_SEC) {
          debug(`ws: byte rate exceeded for ${meta.id.slice(0, 8)} (${(meta.bytesThisSec / 1_000_000).toFixed(1)}MB/s)`)
          return
        }
        // Time-travel commands: __tt:undo, __tt:redo, __tt:goto:5, etc.
        if (e.data.startsWith('__tt:') && config.onTTCommand) {
          debug(`ws: tt command ${e.data}`)
          const body = e.data.slice(5)
          if (body.startsWith('goto:')) {
            const n = Number(body.slice(5))
            if (Number.isInteger(n) && n >= 0 && n < 1_000_000) config.onTTCommand('goto', n)
          } else {
            config.onTTCommand(body)
          }
          return
        }
        const parsed = JSON.parse(e.data)

        if (!parsed || typeof parsed.type !== 'string') {
          debug(`ws: invalid action — missing type field`)
          return
        }
        if (parsed.payload !== undefined && (typeof parsed.payload !== 'object' || parsed.payload === null || Array.isArray(parsed.payload))) {
          debug(`ws: invalid action — payload must be a plain object`)
          return
        }
        debug(`ws: recv ${JSON.stringify(parsed)} user=${meta.user?.id ?? 'anon'}`)
        dispatch(parsed, meta.user)
      } catch (err) { debug(`ws: malformed message — ${err}`) }
    }
    socket.onclose = () => {
      connections.delete(socket)
      if (meta.msgResetTimer) clearTimeout(meta.msgResetTimer)
      debug(`ws: disconnect ${clientId.slice(0, 8)} user=${meta.user?.id ?? 'anon'} (${connections.size} total)`)
      if (config.onDisconnect) try { config.onDisconnect(meta.user) } catch (e) { debug(`hook onDisconnect: ${e}`) }
    }
    return response
  }

  // Serves HTML, virtual routes, and static/dist files
  async function serveStatic(pathname: string, req?: Request): Promise<Response> {
    if (pathname === '/') {
      return new Response(generateHTML(title, prod, hasCSS, config.showStatus, config.width, config.height), { headers: { 'Content-Type': 'text/html', ...noCache } })
    }

    if (pathname === '/__aio/ui.js') {
      try {
        const source = await Deno.readTextFile(BROWSER_TS)
        const code = await transpile(source, BROWSER_TS, debug)
        return new Response(code, { headers: { 'Content-Type': 'application/javascript', ...noCache } })
      } catch (err) {
        debug(`transpile browser.ts error: ${fmtEsbuildError(err, 'browser.ts')}`)
        return new Response(`throw new Error("browser.ts transpile failed")`, {
          headers: { 'Content-Type': 'application/javascript', ...noCache },
        })
      }
    }

    if (!prod && pathname === '/__aio/error') {
      return new Response(JSON.stringify(lastErrorData), { headers: { 'Content-Type': 'application/json' } })
    }

    if (!prod && pathname === '/__aio/client-error' && req?.method === 'POST') {
      try {
        const body = await req.json() as { message?: string; stack?: string }
        debug(`client error: ${body.stack ?? body.message ?? '(no details)'}`)
      } catch { /* ignore malformed body */ }
      return new Response(null, { status: 204 })
    }

    if (pathname === '/__snapshot' && config.getSnapshot && config.loadSnapshot) {
      if (!req || req.method === 'GET') {
        return new Response(config.getSnapshot(), {
          headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': 'attachment; filename="snapshot.json"',
          },
        })
      }
      // CSRF protection — require custom header (browsers won't add this cross-origin without preflight)
      if (req.method === 'POST' && !req.headers.get('x-aio')) {
        return new Response('Missing X-AIO header', { status: 403 })
      }
      if (req.method === 'POST') {
        // Fast reject when content-length header is present and already too large
        const clHeader = req.headers.get('content-length')
        if (clHeader !== null && Number(clHeader) > SNAPSHOT_MAX_SIZE) {
          return new Response(`Snapshot too large (max ${SNAPSHOT_MAX_SIZE} bytes)`, { status: 413 })
        }
        try {
          const json = await req.text()
          if (json.length > SNAPSHOT_MAX_SIZE) {
            return new Response(`Snapshot too large (max ${SNAPSHOT_MAX_SIZE} bytes)`, { status: 413 })
          }
          JSON.parse(json) // validate
          config.loadSnapshot(json)
          return new Response('OK', { status: 200 })
        } catch {
          return new Response('Invalid JSON', { status: 400 })
        }
      }
      return new Response('Method Not Allowed', { status: 405 })
    }

    // ── Health endpoint ──
    if (pathname === '/__health' && config.getHealth) {
      try {
        const health = config.getHealth()
        return new Response(JSON.stringify(health, null, 2), {
          headers: { 'Content-Type': 'application/json' },
        })
      } catch (e) {
        return new Response(JSON.stringify({ status: 'error', error: String(e) }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    // ── Trojan: debug/control REST API (localhost-only, auth-gated when exposed) ──
    if (config.trojan && pathname.startsWith('/__trojan/')) {
      const route = pathname.slice('/__trojan/'.length)
      const trojan = config.trojan
      const json = (data: unknown) => new Response(JSON.stringify(data, null, 2), { headers: { 'Content-Type': 'application/json' } })
      const err = (msg: string, status = 400) => new Response(JSON.stringify({ error: msg }), { status, headers: { 'Content-Type': 'application/json' } })
      const method = req?.method ?? 'GET'

      // GET endpoints — inspect
      if (method === 'GET') {
        if (route === 'state') return json(trojan.getState())
        if (route === 'ui') {
          const user = new URL(req!.url).searchParams.get('user') ?? undefined
          const users = config.users
          const aioUser = user && users ? Object.values(users).find(u => u.id === user) : undefined
          return json(getUIState(aioUser))
        }
        if (route === 'clients') {
          const clients = [...connections.entries()].map(([ws, m]) => ({
            id: m.id, user: m.user?.id, readyState: ws.readyState,
          }))
          return json(clients)
        }
        if (route === 'history') return json(trojan.getTTHistory?.() ?? { entries: [], index: 0, paused: false })
        if (route === 'schedules') return json(trojan.getSchedules())
        if (route === 'metrics') {
          return json({
            uptime: Math.round((Date.now() - trojan.startedAt) / 1000),
            connections: connections.size,
            schedules: trojan.getSchedules().length,
          })
        }
        if (route === 'config') {
          return json({
            port, title, expose: config.expose ?? false,
            authMode: config.users ? 'users' : config.token ? 'token' : 'public',
            prod: prod,
          })
        }
      }

      // POST endpoints — control
      if (method === 'POST' && req) {
        if (route === 'dispatch') {
          try {
            const body = await req.text()
            const action = JSON.parse(body)
            if (!action || typeof action.type !== 'string') return err('missing type field')
            // Strip user field — trojan dispatch should not allow user impersonation
            delete action.user
            dispatch(action, undefined)
            return json({ ok: true })
          } catch { return err('invalid JSON') }
        }
        if (route === 'snapshot') {
          if (!config.loadSnapshot) return err('snapshots not available', 501)
          try {
            const body = await req.text()
            JSON.parse(body) // validate
            config.loadSnapshot(body)
            return json({ ok: true })
          } catch { return err('invalid JSON') }
        }
        if (route === 'tt') {
          if (!config.onTTCommand) return err('time-travel not active', 501)
          try {
            const body = await req.text()
            const { cmd, arg } = JSON.parse(body)
            if (!cmd || typeof cmd !== 'string') return err('missing cmd field')
            if (cmd === 'goto' && typeof arg === 'number') config.onTTCommand('goto', arg)
            else config.onTTCommand(cmd)
            return json({ ok: true })
          } catch { return err('invalid JSON') }
        }
        if (route === 'sql') {
          if (!trojan.sqlQuery) return err('SQLite not configured', 501)
          try {
            const body = await req.text()
            const { query } = JSON.parse(body)
            if (!query || typeof query !== 'string') return err('missing query field')
            // Block destructive SQL — trojan API is read-only
            if (query.includes(';')) return err('multi-statement queries not allowed', 403)
            const first = query.trimStart().toUpperCase()
            if (/^(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|REINDEX|REPLACE|PRAGMA|WITH)\b/.test(first)) {
              return err('trojan SQL is read-only — use dispatch for mutations', 403)
            }
            return json(await trojan.sqlQuery(query))
          } catch (e) { return err(String(e instanceof Error ? e.message : e)) }
        }
        if (route === 'persist') {
          if (!trojan.forcePersist) return err('persistence not available', 501)
          trojan.forcePersist()
          return json({ ok: true })
        }
        if (route === 'shutdown') {
          if (!trojan.shutdown) return err('shutdown not available', 501)
          // Respond first, then shut down (can't respond after process dies)
          const resp = json({ ok: true, msg: 'shutting down' })
          queueMicrotask(() => trojan.shutdown!())
          return resp
        }
      }

      return err('not found', 404)
    }

    // Prod: serve bundled assets from distDir
    if (prod && absDistDir && (pathname === '/app.js' || pathname === '/style.css')) {
      const file = pathname.slice(1)  // strip leading /
      try {
        const body = await Deno.readTextFile(join(absDistDir, file))
        const ct = file.endsWith('.css') ? 'text/css' : 'application/javascript'
        return new Response(body, { headers: { 'Content-Type': ct, ...noCache } })
      } catch {
        return new Response('Not Found', { status: 404 })
      }
    }

    const filename = pathname.replace(/^\//, '')
    const filepath = resolve(absBaseDir, filename)
    // Path traversal protection — resolved path must be inside baseDir
    if (!filepath.startsWith(absBaseDir + SEPARATOR)) {
      return new Response('Forbidden', { status: 403 })
    }
    const ext = extname(filepath)
    const isText = TEXT_EXTENSIONS.has(ext)

    // Binary files — read as bytes, serve directly
    if (!isText) {
      try {
        const bytes = await Deno.readFile(filepath)
        return new Response(bytes, { headers: { 'Content-Type': MIME[ext] ?? 'application/octet-stream', ...noCache } })
      } catch {
        return new Response('Not Found', { status: 404 })
      }
    }

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
        body = await transpile(body, filepath, debug)
        contentType = 'application/javascript'
        lastError = ''
        lastErrorData = null
      } catch (err) {
        const formatted = fmtEsbuildError(err, filename)
        debug(`transpile error: ${formatted}`)
        lastError = formatted
        const rawMsgs = (err as { errors?: EsbuildMessage[] }).errors ?? []
        lastErrorData = {
          errors: rawMsgs.length
            ? rawMsgs.map(m => ({ text: m.text, file: m.location?.file ?? filename, line: m.location?.line, col: m.location?.column, lineText: m.location?.lineText }))
            : [{ text: formatted }],
        }
        return new Response(
          `throw new Error(${JSON.stringify(lastError)})`,
          { status: 200, headers: { 'Content-Type': 'application/javascript', ...noCache } },
        )
      }
    }

    return new Response(body, { headers: { 'Content-Type': contentType, ...noCache } })
  }

  // File watcher — debounced live reload on src/ changes
  // CSS-only changes send __css (inject without page reload), mixed changes send __reload
  const RELOAD_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.css', '.html', '.json', '.svg'])
  let reloadTimer: ReturnType<typeof setTimeout> | null = null
  let reloadIsFull = false
  function scheduleReload(path: string): void {
    // Skip editor temp files, swap files, lockfiles, etc.
    const dot = path.lastIndexOf('.')
    const ext = dot >= 0 ? path.slice(dot) : ''
    if (!RELOAD_EXT.has(ext)) return
    debug(`watch: changed ${path}`)
    // Normalize to match cache keys — use realPathSync to resolve symlinks (e.g. /var → /private/var on macOS)
    try { path = Deno.realPathSync(path) } catch { /* file deleted — resolve() fallback is fine */ }
    transpileCache.delete(resolve(path))
    if (!path.endsWith('.css')) reloadIsFull = true
    if (reloadTimer) clearTimeout(reloadTimer)
    // 100ms debounce — batch rapid file changes into single reload
    reloadTimer = setTimeout(() => {
      reloadTimer = null
      const signal = reloadIsFull ? '__reload' : '__css'
      reloadIsFull = false
      debug(`${signal} → ${connections.size} client(s)`)
      for (const ws of connections.keys()) {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(signal)
        } catch { /* client disconnecting */ }
      }
    }, 100)
  }

  // Dev only: watch src/ for changes and live-reload
  let fsWatcher: Deno.FsWatcher | null = null
  if (!prod) {
    try {
      fsWatcher = Deno.watchFs(absBaseDir, { recursive: true })
      ;(async () => {
        try {
          for await (const event of fsWatcher!) {
            if (event.kind === 'modify' || event.kind === 'create') {
              for (const path of event.paths) scheduleReload(path)
            }
          }
        } catch (e) { console.warn(`[aio] file watcher stopped — hot reload disabled: ${e}`) }
      })()
    } catch (e) { debug(`watch: failed to start — ${e}`) }
  }

  const hostname = config.expose ? '0.0.0.0' : '127.0.0.1'
  const tlsOpts = config.cert && config.key ? { cert: config.cert, key: config.key } : {}

  // Auth-free handler for trojan server (127.0.0.1-only) — routes control endpoints without token checks
  const handleTrojan = async (req: Request, pathname: string): Promise<Response> => {
    return await serveStatic(pathname, req)
  }

  // Extracted handler — reused by main server (with auth gates)
  const handleRequest = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const { pathname } = url

    // Auth path 1: per-user token map — resolve user or reject
    if (config.users) {
      const user = resolveUser(config.users, url, req)
      if (!user) return new Response('Unauthorized', { status: 401 })
      if (pathname === '/ws') return handleWs(req, user)
      debug(`http: ${req.method} ${pathname} user=${user.id}`)
      const resp = await serveStatic(pathname, req)
      resp.headers.set('X-Content-Type-Options', 'nosniff')
      return resp
    }

    // Auth path 2: single shared token (--expose without users)
    if (config.token) {
      const qToken = url.searchParams.get('token')
      const auth = req.headers.get('authorization')
      const hToken = auth?.startsWith('Bearer ') ? auth.slice(7) : null
      const validQ = qToken !== null && _timingSafeEqual(qToken, config.token)
      const validH = hToken !== null && _timingSafeEqual(hToken, config.token)
      if (!validQ && !validH) {
        return new Response('Unauthorized', { status: 401 })
      }
    }

    if (pathname === '/ws') return handleWs(req)
    debug(`http: ${req.method} ${pathname}`)
    const resp = await serveStatic(pathname, req)
    resp.headers.set('X-Content-Type-Options', 'nosniff')
    return resp
  }

  let httpServer: Deno.HttpServer
  const udsPath = config.socketPath
  if (udsPath) {
    // UDS mode — clean up stale socket file before binding
    try { Deno.removeSync(udsPath) } catch { /* doesn't exist — fine */ }
    httpServer = Deno.serve({ path: udsPath, onListen: () => {} }, handleRequest)
  } else {
    try {
      httpServer = Deno.serve({ port, hostname, onListen: () => {}, ...tlsOpts }, handleRequest)
    } catch (e) {
      if (e instanceof Deno.errors.AddrInUse) {
        throw new Error(`port ${port} already in use — pick another with --port=N`)
      }
      throw e
    }
  }

  // When TLS is active: spin up a plain-HTTP server on 127.0.0.1 (OS-assigned port) for am tooling.
  // am always communicates over HTTP — avoids needing cert trust in CLI tools.
  let trojanServer: Deno.HttpServer | null = null
  let trojanPort: number | undefined
  if (config.cert) {
    trojanServer = Deno.serve(
      { port: 0, hostname: '127.0.0.1', onListen: (addr) => { trojanPort = addr.port } },
      (req) => {
        const { pathname } = new URL(req.url)
        // Trojan server is 127.0.0.1-only — bypass auth, route control endpoints directly
        if (pathname.startsWith('/__trojan/') || pathname.startsWith('/__snapshot') || pathname.startsWith('/__aio/')) {
          return handleTrojan(req, pathname)
        }
        // Health probe for `am status`
        if (pathname === '/') return new Response('ok', { status: 200 })
        return new Response('Not Found', { status: 404 })
      },
    )
  }

  // Sends TT metadata to all connected clients
  function broadcastTT(): void {
    if (!config.getTTBroadcast) return
    try {
      const ttData = '__tt:' + JSON.stringify(config.getTTBroadcast())
      for (const [ws] of connections) {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(ttData) } catch { /* client disconnecting */ }
        }
      }
    } catch (e) { debug(`broadcastTT error: ${e}`) }
  }

  return {
    broadcast,
    broadcastTT,
    clientCount: () => connections.size,
    trojanPort,
    socketPath: udsPath,
    shutdown: async () => {
      if (reloadTimer) clearTimeout(reloadTimer)
      fsWatcher?.close()
      for (const [ws] of connections) {
        try { ws.close(1001, 'server shutting down') } catch { /* already closing */ }
      }
      connections.clear()
      await Promise.all([
        httpServer.shutdown(),
        trojanServer?.shutdown(),
      ])
      // Clean up UDS socket file
      if (udsPath) try { Deno.removeSync(udsPath) } catch { /* already removed */ }
    },
  }
}
