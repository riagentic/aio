// Pure utility functions for HTML generation, MIME types, CDN handling, and browser error classification.
// Extracted from server.ts — no side effects, no Deno APIs beyond types.

import type { GraphError } from "./graph-validator.ts";
import type { RenderBudget } from "./vitals/types.ts";

/** MIME type map — file extension → Content-Type */
export const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".txt": "text/plain",
  ".md": "text/plain",
  ".xml": "application/xml",
};

/** Extensions that should be read as text (readTextFile) — everything else is binary (readFile) */
export const TEXT_EXTENSIONS = new Set([
  ".html",
  ".js",
  ".mjs",
  ".css",
  ".json",
  ".svg",
  ".txt",
  ".md",
  ".xml",
  ".ts",
  ".tsx",
]);

/** Escape HTML entities to prevent XSS */
function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

/** CDN base for npm→browser resolution in dev mode */
const CDN = "https://esm.sh";

/** Generates browser import map from framework defaults + deno.json npm packages.
 *  npm packages → esm.sh CDN URLs. jsr/local imports are skipped (handled differently).
 *  When renderer is "aio", React CDN entries are omitted and aio/jsx-runtime points to native JSX. */
export function buildBrowserImportMap(
  denoImports: Record<string, string>,
  renderer?: "react" | "aio",
): Record<string, string> {
  const imports: Record<string, string> = renderer === "aio"
    ? {
      "aio": "/__aio/ui.js",
      "aio/browser": "/__aio/ui.js",
      "aio/jsx-runtime": "/__aio/jsx-runtime.ts",
    }
    : {
      "react": `${CDN}/react@18.3.1`,
      "react-dom/client": `${CDN}/react-dom@18.3.1/client`,
      "react/jsx-runtime": `${CDN}/react@18.3.1/jsx-runtime`,
      "aio": "/__aio/ui.js",
      "aio/browser": "/__aio/ui.js",
    };
  for (const [name, specifier] of Object.entries(denoImports)) {
    if (!specifier.startsWith("npm:")) continue;
    if (imports[name]) continue; // don't override defaults
    const bare = specifier.slice(4); // strip 'npm:'
    imports[name] = `${CDN}/${bare}`;
  }
  return imports;
}

/** Generates the HTML shell — dev: CDN import map + live-transpiled App.tsx, prod: self-contained app.js */
export function generateHTML(
  title: string,
  prod: boolean,
  hasCSS: boolean,
  importMap: string,
  showStatus?: boolean,
  width?: number,
  height?: number,
  renderBudget?: RenderBudget,
  renderer?: "react" | "aio",
): string {
  const cssLink = hasCSS ? '\n  <link rel="stylesheet" href="/style.css">' : "";
  const statusScript = showStatus === false
    ? "\n  <script>window.__aioShowStatus=false</script>"
    : "";
  const configScript = renderBudget
    ? `\n  <script>window.__aioConfig=${
      JSON.stringify({ renderBudget })
    }</script>`
    : "";
  const metaW = width ? `\n  <meta name="aio:width" content="${width}">` : "";
  const metaH = height
    ? `\n  <meta name="aio:height" content="${height}">`
    : "";

  if (prod) {
    // Prod: app.js bundles React + useAio + user code, exports mount()
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="referrer" content="no-referrer">
  <title>${
      escHtml(title)
    }</title>${metaW}${metaH}${cssLink}${statusScript}${configScript}
</head>
<body>
  <div id="root"></div>
  <script type="module">
    const { mount } = await import('/app.js')
    mount(document.getElementById('root'))
  </script>
</body>
</html>`;
  }

  // Dev (AIO renderer): native VDOM — no React/ReactDOM, signal-driven re-render
  if (renderer === "aio") {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="referrer" content="no-referrer">
  <title>${
      escHtml(title)
    }</title>${metaW}${metaH}${cssLink}${statusScript}${configScript}
</head>
<body>
  <div id="root"></div>
  <script type="importmap">${importMap}</script>
  <script type="module">
    // Dev reload WS — live reload on file changes
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const _tk = new URLSearchParams(location.search).get('token')
    const _wsUrl = proto + '//' + location.host + '/ws' + (_tk ? '?token=' + encodeURIComponent(_tk) : '')
    let _bootId = null
    function _devWs() {
      const ws = new WebSocket(_wsUrl)
      ws.onmessage = ev => {
        if (typeof ev.data === 'string' && ev.data.startsWith('__graph_error:')) {
          ws.close(); location.reload(); return
        }
        if (ev.data === '__graph_clear') { ws.close(); location.reload(); return }
        if (ev.data === '__reload') { ws.close(); location.reload() }
        else if (ev.data === '__css') {
          document.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
            if (link.href.startsWith(location.origin)) link.href = link.href.split('?')[0] + '?t=' + Date.now()
          })
        } else if (typeof ev.data === 'string' && ev.data.startsWith('__boot:')) {
          const id = ev.data.slice(7)
          if (_bootId && _bootId !== id) { ws.close(); location.reload() }
          _bootId = id
        }
      }
      ws.onclose = () => setTimeout(_devWs, 2000)
      ws.onerror = (e) => console.warn('[aio] reload WS error:', e)
      ws.onopen = () => console.debug('[aio] reload WS connected')
    }
    _devWs()

    // Mount AIO app — wait for server state, then render
    const _aioMod = await import('aio')
    const _appMod = await import('/App.tsx?v=' + Date.now())
    const App = _appMod.default
    if (_aioMod._waitForState) {
      document.getElementById('root').textContent = 'Loading\\u2026'
      await _aioMod._waitForState()
    }
    const { mount: _mount } = await import('/__aio/aio-renderer.ts')
    _mount(document.getElementById('root'), App)
  </script>
</body>
</html>`;
  }

  // Dev: CDN React via import map + live transpile + error overlay
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="referrer" content="no-referrer">
  <title>${
    escHtml(title)
  }</title>${metaW}${metaH}${cssLink}${statusScript}${configScript}
</head>
<body>
  <div id="root"></div>
  <script type="importmap">${importMap}</script>
  <script type="module">
    import { createElement, Component } from 'react'
    import { createRoot } from 'react-dom/client'
    // Error boundary — catches render errors. Subscribes to state to:
    // 1. Prevent 300ms teardown (keeps _listeners.size > 0 while children are unmounted)
    // 2. Auto-recover when server sends a new state update
    let _aioMod = null
    class _AioBoundary extends Component {
      constructor(p) { super(p); this.state = { error: null }; this._unsub = null }
      static getDerivedStateFromError(e) { return { error: e } }
      componentDidCatch(e, info) { console.error('[aio] Render error:', e, info) }
      componentDidMount() {
        if (_aioMod && _aioMod._subscribe) {
          this._unsub = _aioMod._subscribe(() => {
            if (this.state.error) this.setState({ error: null })
          })
        }
      }
      componentWillUnmount() {
        if (this._unsub) { this._unsub(); this._unsub = null }
      }
      render() {
        if (this.state.error) {
          const e = this.state.error
          return createElement('div', { style: {padding:'2rem',font:'13px/1.7 monospace',color:'#ff6b6b',background:'#141414',minHeight:'100vh'} },
            createElement('div', { style: {fontWeight:700,fontSize:'1.1rem',marginBottom:'1rem'} }, '\\u26A0 Render Error'),
            createElement('div', { style: {color:'#f1fa8c',whiteSpace:'pre-wrap',marginBottom:'1rem'} }, String(e.message || e)),
            createElement('div', { style: {color:'#888',fontSize:'11px'} }, 'Waiting for state update to retry\\u2026'),
            createElement('button', {
              style: {marginTop:'1rem',padding:'.4rem 1rem',background:'#2a2a2a',color:'#ccc',border:'1px solid #444',borderRadius:'4px',cursor:'pointer',font:'inherit'},
              onClick: () => this.setState({ error: null })
            }, 'Retry Now')
          )
        }
        return this.props.children
      }
    }
    const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    // Dev reload WS — always active so live reload works even without useAio
    const _tk = new URLSearchParams(location.search).get('token')
    const _wsUrl = proto + '//' + location.host + '/ws' + (_tk ? '?token=' + encodeURIComponent(_tk) : '')
    let _bootId = null
    function _devWs() {
      const ws = new WebSocket(_wsUrl)
      ws.onmessage = ev => {
        if (typeof ev.data === 'string' && ev.data.startsWith('__graph_error:')) {
          ws.close(); location.reload()
          return
        }
        if (ev.data === '__graph_clear') {
          ws.close(); location.reload()
          return
        }
        if (ev.data === '__reload') { ws.close(); location.reload() }
        else if (ev.data === '__css') {
          document.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
            if (link.href.startsWith(location.origin)) link.href = link.href.split('?')[0] + '?t=' + Date.now()
          })
        } else if (typeof ev.data === 'string' && ev.data.startsWith('__boot:')) {
          const id = ev.data.slice(7)
          if (_bootId && _bootId !== id) { ws.close(); location.reload() }
          _bootId = id
        }
      }
      ws.onclose = () => setTimeout(_devWs, 2000)
      ws.onerror = (e) => console.warn('[aio] reload WS error:', e)
      ws.onopen = () => console.debug('[aio] reload WS connected')
    }
    _devWs()
    class AioLoadError extends Error {
      constructor(msg, detail) { super(msg); this.name = 'AioLoadError'; this._aio = true; Object.assign(this, detail) }
    }
    const moduleUrl = '/App.tsx?v=' + Date.now()
    let src = ''
    try {
      const pre = await fetch(moduleUrl)
      if (!pre.ok) {
        throw new AioLoadError('Module pre-validation failed (HTTP ' + pre.status + ')', { status: pre.status, body: await pre.text() })
      }
      src = await pre.text()
      if (src.trimStart().startsWith('throw new Error(')) {
        const msg = src.match(/throw new Error\\("(.+)"\\)/s)?.[1]?.replace(/\\\\n/g, '\\n')?.replace(/\\\\"/g, '"') ?? src
        throw new AioLoadError('Transpile error', { status: 200, transpileError: true, body: msg })
      }
      // Import from original HTTP URL (not blob) so browser can resolve relative imports
      const mod = await import(moduleUrl)
      const App = mod.default
      // Import _waitForState from the framework — delays mount until server state arrives.
      // This eliminates the null-state race: React never renders until state is guaranteed non-null.
      const aio = await import('aio')
      _aioMod = aio
      if (aio._waitForState) {
        document.getElementById('root').textContent = 'Loading\u2026'
        await aio._waitForState()
      }
      // Mount React inside error boundary — subscribes to state to prevent teardown + auto-recover
      createRoot(document.getElementById('root')).render(
        createElement(_AioBoundary, null, createElement(App))
      )
    } catch (e) {
      console.error('[aio] App load failed:', e)
      // When import() fails with the generic browser error, probe sub-imports to find the real culprit
      async function probeImports(parentSrc, parentUrl, depth, visited) {
        depth = depth || 0
        visited = visited || new Set()
        if (depth > 10 || visited.has(parentUrl)) return []
        visited.add(parentUrl)
        var IMPORT_RE = /(?:from\\s+|import\\s*\\(\\s*)["']([^"']+)["']/g
        var specifiers = []
        var m
        while ((m = IMPORT_RE.exec(parentSrc)) !== null) if (m[1]) specifiers.push(m[1])
        // Parse import map from page for bare specifier resolution
        var importMapEl = document.querySelector('script[type="importmap"]')
        var importMapData = importMapEl ? JSON.parse(importMapEl.textContent || '{}').imports || {} : {}
        function resolveSpec(spec) {
          if (spec.startsWith('./') || spec.startsWith('../')) return new URL(spec, parentUrl).href
          return importMapData[spec] || null
        }
        var results = await Promise.allSettled(specifiers.map(function(spec) {
          return (async function() {
            var resolved = resolveSpec(spec)
            if (!resolved) return { spec: spec, reason: '"' + spec + '" not in import map. Add to deno.json imports.' }
            // Skip CDN URLs for recursive probing (they work or they don't — no sub-import analysis)
            var isCdn = resolved.startsWith('https://') || resolved.startsWith('http://')
            var r
            try { r = await fetch(resolved) } catch(e) {
              return { spec: spec, reason: (isCdn ? 'CDN unreachable: ' : 'Fetch failed: ') + (e.message || 'network error') }
            }
            if (!r.ok) return { spec: spec, status: r.status, reason: 'HTTP ' + r.status }
            var body = await r.text()
            if (body.trimStart().startsWith('throw new Error(')) {
              var msg = body.match(/throw new Error\\("(.+)"\\)/s)
              return { spec: spec, reason: msg ? msg[1].replace(/\\\\n/g, '\\n').replace(/\\\\"/g, '"') : 'transpile error' }
            }
            // Recurse into local module imports (not CDN)
            if (!isCdn) {
              var subBroken = await probeImports(body, resolved, depth + 1, visited)
              if (subBroken.length) return subBroken
            }
            return null
          })()
        }))
        var broken = []
        for (var i = 0; i < results.length; i++) {
          var r = results[i]
          if (r.status === 'fulfilled' && r.value) {
            if (Array.isArray(r.value)) broken.push.apply(broken, r.value)
            else broken.push(r.value)
          } else if (r.status === 'rejected') {
            broken.push({ spec: '?', reason: r.reason && r.reason.message || 'fetch failed' })
          }
        }
        return broken
      }
      function mkMessage(text) {
        return '<div style="color:#f1fa8c;margin-bottom:.75rem;white-space:pre-wrap">' + esc(text) + '</div>'
      }
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
      function mkFix(fixText) {
        if (!fixText) return ''
        return '<div style="margin-top:1rem;padding:.75rem 1rem;background:#1a2332;border:1px solid #2a4a6a;border-radius:6px">'
          + '<div style="color:#569cd6;font-weight:700;margin-bottom:.4rem;font-size:11px">FIX</div>'
          + '<div style="color:#98c379">' + esc(fixText) + '</div>'
          + '</div>'
      }
      let label = 'Runtime Error', fixText = '', body = ''
      if (e && e._aio) {
        if (e.status === 404) {
          label = 'File Not Found'
          body = mkMessage('App.tsx does not exist')
          fixText = 'Create src/App.tsx with a default export React component.'
        } else if (e.transpileError) {
          label = 'Build Error'
          try {
            const r = await fetch('/__aio/error')
            const errData = r.ok ? await r.json() : null
            body = errData && errData.errors && errData.errors.length ? mkBuildErrors(errData.errors) : mkMessage(e.body)
          } catch(_) { body = mkMessage(e.body || e.message) }
        } else {
          label = 'Server Error (' + e.status + ')'
          body = mkMessage(e.body || e.message)
          fixText = 'Check terminal for server errors.'
        }
      } else {
        const r = await fetch('/__aio/error').catch(function() { return null })
        const errData = r && r.ok ? await r.json().catch(function() { return null }) : null
        const hasServerErr = errData && errData.errors && errData.errors.length
        // Probe sub-imports when browser gives the generic "Failed to fetch" error
        const isGenericImportFail = e && e.message && e.message.includes('Failed to fetch dynamically imported module')
        let brokenImports = []
        if (isGenericImportFail && src) {
          try { brokenImports = await probeImports(src, new URL(moduleUrl, location.origin).href) } catch(_) {}
        }
        if (brokenImports.length) {
          label = 'Import Error'
          body = brokenImports.map(function(bi) {
            return mkMessage(bi.spec + ' — ' + bi.reason)
          }).join('')
          fixText = brokenImports.length === 1
            ? 'Fix the error in ' + brokenImports[0].spec + ' (see above), then save to reload.'
            : brokenImports.length + ' broken imports found. Fix the errors above, then save to reload.'
        } else if (hasServerErr) {
          label = 'Build Error'
          body = mkBuildErrors(errData.errors)
        } else {
          label = 'Runtime Error'
          body = mkStack(e && e.stack)
          try {
            const cr = await fetch('/__aio/client-error', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: e && e.message, stack: e && e.stack })
            })
            if (cr.ok) {
              const c = await cr.json()
              if (c.fix) fixText = c.fix
              if (c.label) label = c.label
            }
          } catch(_) {}
        }
      }
      const fixBox = mkFix(fixText)
      document.getElementById('root').innerHTML =
        '<div style="margin:0;padding:1.75rem 2rem;min-height:100vh;background:#141414;font:13px/1.7 monospace;box-sizing:border-box">'
        + '<div style="max-width:920px">'
        + '<div style="color:#ff6b6b;font-size:1.1rem;font-weight:700;margin-bottom:1.25rem;padding-bottom:.75rem;border-bottom:1px solid #2a2a2a">&#9888; ' + label + '</div>'
        + body
        + fixBox
        + '<div style="margin-top:1.5rem;padding-top:.75rem;border-top:1px solid #2a2a2a;color:#444;font-size:11px">F12 DevTools &nbsp;&#183;&nbsp; am errors &nbsp;&#183;&nbsp; ' + new Date().toLocaleTimeString() + '</div>'
        + '</div></div>'
    }
    // ── Health Overlay ──
    var _diagDot = document.createElement('div')
    Object.assign(_diagDot.style, {position:'fixed',bottom:'12px',right:'12px',zIndex:'99999',width:'8px',height:'8px',borderRadius:'50%',background:'#2a2',cursor:'pointer',display:'none',transition:'background .3s',boxShadow:'0 0 4px rgba(0,0,0,.3)'})
    document.body.appendChild(_diagDot)
    var _diagBadge = document.createElement('div')
    Object.assign(_diagBadge.style, {position:'absolute',top:'-8px',right:'-4px',fontSize:'9px',background:'#e25',color:'#fff',borderRadius:'6px',padding:'0 3px',lineHeight:'14px',display:'none'})
    _diagDot.appendChild(_diagBadge)
    var _diagPanel = document.createElement('div')
    Object.assign(_diagPanel.style, {position:'fixed',bottom:'28px',right:'12px',zIndex:'99998',width:'400px',maxHeight:'300px',overflow:'auto',background:'#1a1a1a',border:'1px solid #333',borderRadius:'8px',font:'12px/1.6 monospace',color:'#ccc',display:'none',boxShadow:'0 4px 16px rgba(0,0,0,.5)'})
    document.body.appendChild(_diagPanel)
    var _diagEvents = [], _diagUnread = 0
    _diagDot.onclick = function() {
      var show = _diagPanel.style.display === 'none'
      _diagPanel.style.display = show ? 'block' : 'none'
      if (show) { _diagUnread = 0; _updateDiagDot() }
    }
    function _updateDiagDot() {
      var hasErr = _diagEvents.some(function(e) { return e.severity === 'error' })
      var hasWarn = _diagEvents.some(function(e) { return e.severity === 'warning' })
      _diagDot.style.background = hasErr ? '#e25' : hasWarn ? '#ea0' : '#2a2'
      _diagBadge.style.display = _diagUnread > 0 ? 'block' : 'none'
      _diagBadge.textContent = String(_diagUnread)
    }
    function _renderDiagPanel() {
      var cutoff = Date.now() - 60000
      _diagEvents = _diagEvents.filter(function(e) { return e.ts > cutoff })
      if (!_diagEvents.length) { _diagDot.style.display = 'none'; _diagPanel.style.display = 'none'; return }
      _diagPanel.innerHTML = _diagEvents.map(function(ev) {
        var c = ev.severity === 'error' ? '#e25' : ev.severity === 'warning' ? '#ea0' : '#888'
        var age = Math.round((Date.now() - ev.ts) / 1000)
        return '<div style="padding:6px 10px;border-bottom:1px solid #2a2a2a">'
          + '<span style="color:' + c + '">\\u25CF</span> '
          + '<b>' + esc(ev.type) + '</b> <span style="color:#555">' + age + 's ago</span>'
          + '<div style="color:#aaa;margin:2px 0">' + esc(ev.message) + '</div>'
          + (ev.hint ? '<div style="color:#98c379;font-size:11px">\\u2192 ' + esc(ev.hint) + '</div>' : '')
          + '</div>'
      }).join('')
    }
    window._aioDiag = function(ev) {
      _diagEvents.push(ev)
      _diagUnread++
      _diagDot.style.display = 'block'
      _updateDiagDot()
      if (_diagPanel.style.display !== 'none') _renderDiagPanel()
    }
    setInterval(function() { if (_diagPanel.style.display !== 'none') _renderDiagPanel() }, 10000)
  </script>
</body>
</html>`;
}

/** Generates a static diagnostic HTML page when the import graph has errors.
 *  Zero JS imports — cannot fail to load. Only inline JS for live reload WS. */
export function generateDiagnosticHTML(
  errors: GraphError[],
  title: string,
): string {
  const errorBlocks = errors.map((e) => {
    const loc = e.line != null
      ? `:${e.line}${e.col != null ? `:${e.col}` : ""}`
      : "";
    const fileLabel = e.file
      ? `<div style="color:#569cd6;margin-bottom:.35rem">${
        escHtml(e.file)
      }${loc}</div>`
      : "";
    const lineSnippet = e.lineText
      ? `<div style="background:#0d1117;padding:.5rem .85rem;border-radius:4px;border-left:3px solid #ff6b6b;margin-bottom:.5rem"><span style="color:#555">${
        e.line != null ? e.line + " | " : ""
      }</span><span style="color:#ddd">${escHtml(e.lineText)}</span></div>`
      : "";
    const fixBox = e.fix
      ? `<div style="margin-top:.5rem;padding:.6rem .9rem;background:#1a2332;border:1px solid #2a4a6a;border-radius:6px"><div style="color:#569cd6;font-weight:700;margin-bottom:.3rem;font-size:11px">FIX</div><div style="color:#98c379">${
        escHtml(e.fix)
      }</div></div>`
      : "";
    return `<div style="margin-bottom:1.5rem">${fileLabel}<div style="color:#f1fa8c;margin-bottom:.5rem">${
      escHtml(e.message)
    }</div>${lineSnippet}${fixBox}</div>`;
  }).join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${escHtml(title)} — Module Errors</title>
</head>
<body style="margin:0;padding:1.75rem 2rem;min-height:100vh;background:#141414;font:13px/1.7 monospace;box-sizing:border-box">
  <div style="max-width:920px">
    <div style="color:#ff6b6b;font-size:1.1rem;font-weight:700;margin-bottom:1.25rem;padding-bottom:.75rem;border-bottom:1px solid #2a2a2a">&#10006; ${errors.length} module error${
    errors.length !== 1 ? "s" : ""
  } &#8212; fix to continue</div>
    ${errorBlocks}
    <div style="margin-top:1.5rem;padding-top:.75rem;border-top:1px solid #2a2a2a;color:#555;font-size:11px">Save any file to re-validate &#183; Auto-reloads when fixed &#183; ${
    new Date().toLocaleTimeString()
  }</div>
  </div>
  <script>
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var tk = new URLSearchParams(location.search).get('token');
    var wsUrl = proto + '//' + location.host + '/ws' + (tk ? '?token=' + encodeURIComponent(tk) : '');
    var ws = new WebSocket(wsUrl);
    ws.onmessage = function(ev) {
      if (ev.data === '__reload' || ev.data === '__graph_clear') location.reload();
      if (typeof ev.data === 'string' && ev.data.startsWith('__graph_error:')) location.reload();
    };
    ws.onclose = function() { setTimeout(function() { location.reload(); }, 2000); };
  </script>
</body>
</html>`;
}

/** Classifies browser errors and returns actionable fix suggestions */
export function classifyBrowserError(
  message: string,
): { classification: string; fix: string; label: string } {
  // "Failed to fetch dynamically imported module" — browser's generic import() error
  if (message.includes("Failed to fetch dynamically imported module")) {
    // Extract the URL that failed, if present
    const failedUrl = message.match(/module:\s*(https?:\/\/\S+)/)?.[1];
    const isAppRoot = failedUrl && /\/App\.tsx/.test(failedUrl);
    return {
      classification: "dynamic-import-failed",
      label: "Module Load Error",
      fix: isAppRoot
        ? "A sub-import inside App.tsx failed to load. Open DevTools → Network tab and look for red (failed) requests to find the broken import. Check the terminal for transpile errors."
        : `Module failed to load${
          failedUrl ? ": " + failedUrl : ""
        }. Open DevTools → Network tab to find the failing request. Check the terminal for transpile errors.`,
    };
  }
  const missingModule = message.match(
    /Failed to resolve module specifier "([^"]+)"/,
  );
  if (missingModule) {
    const pkg = missingModule[1]!;
    const isRelative = pkg.startsWith("./") || pkg.startsWith("../");
    return {
      classification: isRelative ? "missing-relative-import" : "missing-import",
      label: "Import Error",
      fix: isRelative
        ? `File "${pkg}" not found. Check: (1) the file exists at that path relative to the importing module, (2) the filename and extension are spelled correctly (.tsx, not .ts), (3) the file has no transpile errors — check the terminal for esbuild output.`
        : `Add "${pkg}": "npm:${pkg}" to deno.json imports — AIO auto-aliases npm packages for the browser.`,
    };
  }
  if (message.includes("is server-only") && message.includes("[aio]")) {
    return {
      classification: "server-only",
      label: "Server-Only Code",
      fix:
        "@std/* and node:* are server-only. Move this code to an async method or effect, or use import type for types.",
    };
  }
  if (message.includes("Deno is not defined")) {
    return {
      classification: "platform-api",
      label: "Platform API",
      fix:
        "Deno.* APIs are server-only and unavailable in browser. Move to an async method or effect.",
    };
  }
  if (message.includes("is not a function")) {
    return {
      classification: "stubbed-call",
      label: "Import Error",
      fix:
        "This function may be from a server-only module. Check the import source — @std/* and node:* are not available in browser.",
    };
  }
  if (message.includes("Cannot read properties of undefined")) {
    return {
      classification: "destructure-stub",
      label: "Import Error",
      fix:
        "Likely destructuring from a server-only module. Check the import source.",
    };
  }
  return { classification: "unknown", fix: "", label: "Runtime Error" };
}
