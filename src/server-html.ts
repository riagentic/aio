// Pure utility functions for HTML generation, MIME types, CDN handling, and browser error classification.
// Extracted from server.ts — no side effects, no Deno APIs beyond types.

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
 *  npm packages → esm.sh CDN URLs. jsr/local imports are skipped (handled differently). */
export function buildBrowserImportMap(
  denoImports: Record<string, string>,
): string {
  const imports: Record<string, string> = {
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
  return JSON.stringify({ imports });
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
): string {
  const cssLink = hasCSS ? '\n  <link rel="stylesheet" href="/style.css">' : "";
  const statusScript = showStatus === false
    ? "\n  <script>window.__aioShowStatus=false</script>"
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
  <title>${escHtml(title)}</title>${metaW}${metaH}${cssLink}${statusScript}
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
  <script type="importmap">${importMap}</script>
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
    try {
      const { default: App } = await import('/App.tsx?v=' + Date.now())
      createRoot(document.getElementById('root')).render(createElement(App))
    } catch (e) {
      console.error('[aio] App load failed:', e)
      const r = await fetch('/__aio/error')
      const errData = r.ok ? await r.json().catch(() => null) : null
      const hasServerErr = errData && errData.errors && errData.errors.length
      let label = hasServerErr ? 'Build Error' : 'Runtime Error'
      let fixText = ''
      try {
        const cr = await fetch('/__aio/client-error', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: e?.message, stack: e?.stack })
        })
        if (cr.ok) {
          const classified = await cr.json()
          if (classified.fix) fixText = classified.fix
          if (classified.label) label = classified.label
        }
      } catch {}
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
      const body = hasServerErr ? mkBuildErrors(errData.errors) : mkStack(e?.stack)
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
  </script>
</body>
</html>`;
}

/** Classifies browser errors and returns actionable fix suggestions */
export function classifyBrowserError(
  message: string,
): { classification: string; fix: string; label: string } {
  const missingModule = message.match(
    /Failed to resolve module specifier "([^"]+)"/,
  );
  if (missingModule) {
    const pkg = missingModule[1];
    return {
      classification: "missing-import",
      label: "Import Error",
      fix:
        `Add "${pkg}": "npm:${pkg}" to deno.json imports — AIO auto-aliases npm packages for the browser.`,
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
