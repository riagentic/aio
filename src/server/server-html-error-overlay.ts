// Inline JS for the React dev error overlay — module loading, error probing, and display.
// Returns a JS string to embed inside <script type="module"> after the error boundary + dev WS.

/** Module loading + error overlay: fetches App.tsx, mounts React with error boundary,
 *  probes broken imports on failure, and renders error overlay in #root. */
export function errorOverlayScript(): string {
  return `
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
      const mod = await import(moduleUrl)
      const App = mod.default
      const aio = await import('aio')
      _aioMod = aio
      if (aio._waitForState) {
        document.getElementById('root').textContent = 'Loading\u2026'
        await aio._waitForState()
      }
      createRoot(document.getElementById('root')).render(
        createElement(_AioBoundary, null, createElement(App))
      )
    } catch (e) {
      console.error('[aio] App load failed:', e)
      ${_probeImportsScript()}
      ${_errorHelperScript()}
      ${_errorClassifyScript()}
      const fixBox = mkFix(fixText)
      document.getElementById('root').innerHTML =
        '<div style="margin:0;padding:1.75rem 2rem;min-height:100vh;background:#141414;font:13px/1.7 monospace;box-sizing:border-box">'
        + '<div style="max-width:920px">'
        + '<div style="color:#ff6b6b;font-size:1.1rem;font-weight:700;margin-bottom:1.25rem;padding-bottom:.75rem;border-bottom:1px solid #2a2a2a">&#9888; ' + esc(label) + '</div>'
        + body
        + fixBox
        + '<div style="margin-top:1.5rem;padding-top:.75rem;border-top:1px solid #2a2a2a;color:#444;font-size:11px">F12 DevTools &nbsp;&#183;&nbsp; am errors &nbsp;&#183;&nbsp; ' + new Date().toLocaleTimeString() + '</div>'
        + '</div></div>'
    }`;
}

/** probeImports: recursively probes sub-imports to find the real culprit when import() fails */
function _probeImportsScript(): string {
  return `async function probeImports(parentSrc, parentUrl, depth, visited) {
        depth = depth || 0
        visited = visited || new Set()
        if (depth > 10 || visited.has(parentUrl)) return []
        visited.add(parentUrl)
        var IMPORT_RE = /(?:from\\s+|import\\s*\\(\\s*)["']([^"']+)["']/g
        var specifiers = []
        var m
        while ((m = IMPORT_RE.exec(parentSrc)) !== null) if (m[1]) specifiers.push(m[1])
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
      }`;
}

/** Helper functions for building error overlay HTML */
function _errorHelperScript(): string {
  return `function mkMessage(text) {
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
      }`;
}

/** Error classification logic — determines label, body, fixText based on error type */
function _errorClassifyScript(): string {
  return `let label = 'Runtime Error', fixText = '', body = ''
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
      }`;
}
