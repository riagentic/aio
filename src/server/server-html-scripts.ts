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
    // Read per attempt, like the bundle's buildWsUrl — minus a token the
    // server already refused: after a sign-in the page URL still carries it,
    // and the new session rides the cookie.
    let _deadTk = null
    const _wsUrl = () => {
      let _tk = new URLSearchParams(location.search).get('token')
      if (_tk === _deadTk) _tk = null
      return proto + '//' + location.host + '/ws' + (_tk ? '?token=' + encodeURIComponent(_tk): '')
    }
    let _bootId = null
    // Paused while the transport says signed out (SIGNED_OUT_EVENT in
    // browser/auth-client.ts): every retry presented the dead ?token=, was
    // charged to the failed-auth budget, and at 429 blocked signing back in.
    // A sign-in (SIGNED_IN_EVENT) resumes it.
    let _devOut = false, _devLive = false, _devT = null
    addEventListener('aio:signed-out', () => { _devOut = true; clearTimeout(_devT); _deadTk = new URLSearchParams(location.search).get('token') })
    addEventListener('aio:signed-in', () => { if (!_devOut) return; _devOut = false; if (!_devLive) _devWs() })
    // One decider for "signed out": the listener above cancels a pending retry,
    // and onclose never arms one while signed out.
    const _devRetry = () => { if (!_devLive) _devWs() }
    // Reload through the bundle's transport when it is up: it first lets the
    // calls this page still owes the server leave the socket (see
    // _reloadWhenDrained). A bare reload here, on the boot id of a restarted
    // server, threw away the offline queue that restart was replaying — in
    // dev only, since prod has no dev socket. Before the bundle loads there
    // is no queue to wait for.
    const _reload = () => typeof window.__aioReloadWhenDrained === 'function' ? window.__aioReloadWhenDrained() : location.reload()
    function _devWs() {
      _devLive = true
      const ws = new WebSocket(_wsUrl())
      // v2 envelope (B4b): every frame is {v:2,t,d}
      ws.onmessage = ev => {
        if (typeof ev.data !== 'string' || ev.data[0] !== '{') return
        let f; try { f = JSON.parse(ev.data) } catch { return }
        if (!f || f.v !== 2) return
        // graph-error is sent INSTEAD of a reload: the graph is red, so the
        // build a reload would fetch is the broken one. Reloading here defeated
        // that and hid the reason. The bundle's own handler paints the overlay;
        // this pre-bundle socket just refuses to reload and says why.
        if (f.t === 'graph-error') {
          const errs = Array.isArray(f.d) ? f.d : []
          for (const e of errs) {
            console.error('[aio:graph] ' + (e.file || '?') + (e.line ? ':' + e.line : '') + ' — ' + (e.message || ''))
            if (e.fix) console.error('[aio:graph] FIX: ' + e.fix)
          }
          if (!errs.length) console.error('[aio:graph] the import graph is invalid — not reloading')
          return
        }
        if (f.t === 'graph-clear') { ws.close(); _reload(); return }
        if (f.t === 'reload') { ws.close(); _reload() }
        else if (f.t === 'css') {
          document.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
            if (link.href.startsWith(location.origin)) link.href = link.href.split('?')[0] + '?t=' + Date.now()
          })
        } else if (f.t === 'boot') {
          const id = f.d && f.d.id
          if (_bootId && _bootId !== id) { ws.close(); _reload() }
          _bootId = id
        }
      }
      ws.onclose = () => { _devLive = false; if (!_devOut) _devT = setTimeout(_devRetry, 2000) }
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
