// HTML shell generation — dispatches to prod, AIO dev, or React dev templates.

import type { RenderBudget } from "../vitals/types.ts";
import { escHtml } from "./server-html-constants.ts";
import { devWsScript } from "./server-html-scripts.ts";

/** Validate a UI entry filename before interpolating into the dev HTML shell's
 *  `import('/${uiEntry}?v=...')`. The value comes from config (`ui.entry`) and
 *  is interpolated raw — a value like `App.tsx');alert(1);//` would break out
 *  of the import string literal (self-XSS in the dev shell). Allow only safe
 *  path characters + .ts/.tsx extension. Throws on invalid input. */
function _safeUiEntry(uiEntry: string): string {
  if (!/^[\w./-]+\.(ts|tsx)$/.test(uiEntry)) {
    throw new Error(
      `invalid ui.entry "${uiEntry}" — must match /^[\w./-]+\.(ts|tsx)$/ (alphanumerics, ".", "/", "-", "_" + .ts/.tsx). ` +
        `This is interpolated into the dev HTML import path and must be a safe filename.`,
    );
  }
  return uiEntry;
}

/** Builds the common <head> content shared across all modes */
function headContent(
  title: string,
  hasCSS: boolean,
  showStatus?: boolean,
  width?: number,
  height?: number,
  renderBudget?: RenderBudget,
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
  return `  <meta charset="UTF-8">
  <meta name="referrer" content="no-referrer">
  <title>${
    escHtml(title)
  }</title>${metaW}${metaH}${cssLink}${statusScript}${configScript}`;
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
  uiEntry = "App.tsx", // AIO-8.1: convention default, override via ui.entry
): string {
  const head = headContent(
    title,
    hasCSS,
    showStatus,
    width,
    height,
    renderBudget,
  );

  if (prod) return prodHTML(head);
  return aioDevHTML(head, importMap, uiEntry);
}

/** Prod: app.js bundles React + useAio + user code, exports mount() */
function prodHTML(head: string): string {
  return `<!DOCTYPE html>
<html>
<head>
${head}
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

/** Dev (AIO renderer): native VDOM — no React/ReactDOM, signal-driven re-render */
function aioDevHTML(
  head: string,
  importMap: string,
  uiEntry = "App.tsx",
): string {
  const entry = _safeUiEntry(uiEntry);
  return `<!DOCTYPE html>
<html>
<head>
${head}
</head>
<body>
  <div id="root"></div>
  <script type="importmap">${importMap.replace(/</g, "\\u003c")}</script>
  <script type="module">${devWsScript()}

    // ── Blank-screen guard (dev) ─────────────────────────────────────
    // Every boot failure used to be a silent white page (error only in the
    // browser console). Now: any failed import / missing default export /
    // state timeout / mount error shows an in-page diagnostic AND reports
    // to the server so the TERMINAL says why. DOM built via textContent —
    // error strings are never interpolated as HTML.
    const _root = document.getElementById('root')
    let _mounted = false
    function _overlay(stage, msg, fix) {
      const box = document.createElement('div')
      box.dataset.aioBlankScreen = stage // machine-readable marker (tests, tools)
      box.style.cssText = 'font:14px/1.5 system-ui;padding:2rem;max-width:52rem;margin:2rem auto;background:#1a1a2e;color:#e0e0e0;border-radius:12px;border:1px solid #e94560'
      const h = document.createElement('div')
      h.style.cssText = 'color:#e94560;font-weight:700;margin-bottom:.75rem'
      h.textContent = '[aio] blank screen \u2014 ' + stage
      const pre = document.createElement('pre')
      pre.style.cssText = 'white-space:pre-wrap;background:#16213e;padding:1rem;border-radius:8px;overflow:auto'
      pre.textContent = msg
      box.appendChild(h); box.appendChild(pre)
      if (fix) {
        const f = document.createElement('div')
        f.style.cssText = 'margin-top:.75rem;color:#7ec8a9'
        f.textContent = 'fix: ' + fix
        box.appendChild(f)
      }
      const t = document.createElement('div')
      t.style.cssText = 'margin-top:.75rem;color:#888'
      t.textContent = 'Details also logged in the server terminal (dev only \u2014 production shows nothing).'
      box.appendChild(t)
      _root.replaceChildren(box)
    }
    function _fail(stage, err) {
      const msg = String(err && (err.stack || err.message) || err)
      console.error('[aio] blank screen (' + stage + '):', err)
      _overlay(stage, msg) // render immediately — never race the report
      fetch('/__aio/client-error', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ blankScreen: stage, message: String(err && err.message || err), stack: msg }),
      }).then(r => r.json())
        .then(c => { if (c && c.fix) _overlay(stage, msg, c.fix) })
        .catch(() => {})
    }
    // "empty" = no elements and no text — a null render still leaves a
    // comment node, so hasChildNodes() alone would miss it.
    const _empty = () => !_root.querySelector('*') && !(_root.textContent || '').trim()
    setTimeout(() => {
      if (_mounted) return
      if (_root.textContent === 'Loading\\u2026') {
        _fail('waiting for state', 'No state arrived from the server within 10s. Is the WebSocket connected? Check the terminal and: am clients')
      } else if (_empty()) {
        _fail('boot hang', 'The UI did not mount within 10s and no error was thrown \u2014 a module import is probably hanging. Check the Network tab.')
      }
    }, 10000)

    // Mount AIO app — bind cells reactively, wait for server state, then render
    try {
      const _aioMod = await import('aio')
      const _appMod = await import('/${entry}?v=' + Date.now())
      const App = _appMod.default
      if (!App) throw new Error('${entry} has no default export \u2014 add: export default function App() { \u2026 }')
      if (_aioMod.ensureConnected) _aioMod.ensureConnected()
      if (_aioMod._waitForState) {
        _root.textContent = 'Loading\\u2026'
        await _aioMod._waitForState()
      }
      const { mount: _mount } = await import('/__aio/air/aio-renderer.ts')
      _mount(_root, App)
      _mounted = true
      if (_empty()) {
        _fail('empty render', 'App mounted but rendered nothing. Does App return null (or an empty fragment)?')
      }
    } catch (_e) {
      _fail('boot', _e)
    }
  </script>
</body>
</html>`;
}
