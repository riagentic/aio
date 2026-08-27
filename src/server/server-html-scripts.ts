// Inline JS script builders for dev-mode HTML shells.
// Each function returns a JS string to embed inside <script type="module">.

/** Dev reload WebSocket — live reload on file changes. Shared by AIO + React
 *  dev modes. SKIPPED on a page with no HTTP origin (the aio:// zero-port
 *  shell) or with an IPC bridge: there the bridge already delivers
 *  reload/css/boot (browser-shared handleControlFrame), and `ws://app/ws` is a
 *  socket that cannot exist — retrying it every 2s was noise on a blank page. */
export function devWsScript(): string {
  return `
    const _devWsOk = /^https?:$/.test(location.protocol) && !window.__aioIPC
    if (!_devWsOk) console.debug('[aio] reload WS skipped: ' + (window.__aioIPC ? 'IPC bridge delivers reload' : 'no HTTP origin (' + location.protocol + ')'))
    const proto = location.protocol === 'https:' ? 'wss:': 'ws:'
    const _tk = new URLSearchParams(location.search).get('token')
    const _wsUrl = proto + '//' + location.host + '/ws' + (_tk ? '?token=' + encodeURIComponent(_tk): '')
    let _bootId = null
    function _devWs() {
      const ws = new WebSocket(_wsUrl)
      // v2 envelope (B4b): every frame is {v:2,t,d}
      ws.onmessage = ev => {
        if (typeof ev.data !== 'string' || ev.data[0] !== '{') return
        let f; try { f = JSON.parse(ev.data) } catch { return }
        if (!f || f.v !== 2) return
        if (f.t === 'graph-error' || f.t === 'graph-clear') { ws.close(); location.reload(); return }
        if (f.t === 'reload') { ws.close(); location.reload() }
        else if (f.t === 'css') {
          document.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
            if (link.href.startsWith(location.origin)) link.href = link.href.split('?')[0] + '?t=' + Date.now()
          })
        } else if (f.t === 'boot') {
          const id = f.d && f.d.id
          if (_bootId && _bootId !== id) { ws.close(); location.reload() }
          _bootId = id
        }
      }
      ws.onclose = () => setTimeout(_devWs, 2000)
      ws.onerror = (e) => console.warn('[aio] reload WS error:', e)
      ws.onopen = () => console.debug('[aio] reload WS connected')
    }
    if (_devWsOk) _devWs()`;
}

// The 50-line dev "health overlay" (a corner dot + a panel rendering
// `window._aioDiag` events) lived here from the day it was written and was
// never injected into any shell — generated markup with no route to a page.
// Two doc comments and a test header described it as if it existed.
//
// It is gone rather than wired, for two reasons. It duplicated a sink that
// already works: `_deliverDiag` (src/protocol/protocol-diagnostics.ts) falls
// back to the console whenever the page defines no `window._aioDiag`, which
// was every page, so nothing was ever lost by the overlay's absence. And
// injecting DOM code that has never once executed into every dev page is a
// regression risk taken on behalf of a feature nobody asked for.
//
// `window._aioDiag` remains the documented hook: a page (or an app's own dev
// tooling) that defines it receives every diagnostic event, and the console
// fallback covers every page that does not.
