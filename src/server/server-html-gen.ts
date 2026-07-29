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
/** Default viewport — responsive, mobile-correct. Overridable via ui.viewport.
 *  AIO-423 (realitio): without this, mobile Chrome falls back to a 980px layout
 *  viewport and every app renders shrunken by default ("mobile broken by
 *  default"). This is mobile 101 and must be the out-of-the-box behaviour. */
const DEFAULT_VIEWPORT =
  "width=device-width, initial-scale=1, viewport-fit=cover";

function headContent(
  title: string,
  hasCSS: boolean,
  showStatus?: boolean,
  width?: number,
  height?: number,
  renderBudget?: RenderBudget,
  viewport?: string | false,
  headExtra?: string,
  syncCells?: string[],
): string {
  const cssLink = hasCSS ? '\n  <link rel="stylesheet" href="/style.css">' : "";
  const statusScript = showStatus === false
    ? "\n  <script>window.__aioShowStatus=false</script>"
    : "";
  // Client-side config the page needs BEFORE any module runs. `syncCells` is
  // the localFirst decision: it is made on the server at compose time, so the
  // browser has no other way to learn that a cell's methods run locally.
  const clientConfig = {
    ...(renderBudget ? { renderBudget } : {}),
    ...(syncCells && syncCells.length ? { syncCells } : {}),
  };
  const configScript = Object.keys(clientConfig).length > 0
    ? `\n  <script>window.__aioConfig=${
      JSON.stringify(clientConfig).replace(/</g, "\\u003c")
    }</script>`
    : "";
  const metaW = width ? `\n  <meta name="aio:width" content="${width}">` : "";
  const metaH = height
    ? `\n  <meta name="aio:height" content="${height}">`
    : "";
  // ui.viewport === false opts out (rare fixed-width layouts); a string overrides.
  const metaViewport = viewport === false
    ? ""
    : `\n  <meta name="viewport" content="${
      escHtml(viewport || DEFAULT_VIEWPORT)
    }">`;
  // ui.head — verbatim <head> content (meta description, OG tags, favicon,
  // fonts). Not escaped: it's trusted author config, like the CSS link.
  const extra = headExtra ? `\n  ${headExtra}` : "";
  return `  <meta charset="UTF-8">
  <meta name="referrer" content="no-referrer">${metaViewport}
  <title>${
    escHtml(title)
  }</title>${metaW}${metaH}${cssLink}${statusScript}${configScript}${extra}`;
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
  viewport?: string | false, // ui.viewport override (false = opt out)
  headExtra?: string, // ui.head — verbatim <head> content
  syncCells?: string[], // localFirst: cells the client runs locally + syncs
): string {
  const head = headContent(
    title,
    hasCSS,
    showStatus,
    width,
    height,
    renderBudget,
    viewport,
    headExtra,
    syncCells,
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
  // The client's dev flag. Every dev-only tripwire in the isomorphic core —
  // frozen state so a component mutation throws at the site, the readonly hint,
  // the hidden-field read guard — reads `__aioDev`, and until now only the TEST
  // harnesses ever set it. So the browser you actually develop in was the most
  // PERMISSIVE environment aio has, and its bugs surfaced later, in a test or
  // in production. It is set before any module loads, and never in prod.
  return `<!DOCTYPE html>
<html>
<head>
${head}
</head>
<body>
  <div id="root"></div>
  <script>window.__aioDev=true</script>
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
      // risoto 2026-07-16f: a render error carries the component path it
      // escaped from — name it, so "Cannot read properties of undefined"
      // becomes bisect-free ("in <NetworkPanel> ← <App>").
      const chain = err && Array.isArray(err.__aioComponents)
        ? ' (in ' + err.__aioComponents.map(c => '<' + c + '>').join(' \\u2190 ') + ')'
        : ''
      const msg = String(err && (err.stack || err.message) || err) + chain
      console.error('[aio] blank screen (' + stage + '):', err, chain)
      _overlay(stage, msg) // render immediately — never race the report
      fetch('/__aio/client-error', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ blankScreen: stage, message: String(err && err.message || err) + chain, stack: msg }),
      }).then(r => r.json())
        .then(c => { if (c && c.fix) _overlay(stage, msg, c.fix) })
        .catch(() => {})
    }
    // "empty" = no elements and no text — a null render still leaves a
    // comment node, so hasChildNodes() alone would miss it.
    const _empty = () => !_root.querySelector('*') && !(_root.textContent || '').trim()
    // quant Ugly #3: right after a dev restart the server may still be
    // transpiling, so a dynamic import fails transiently with "Failed to fetch
    // dynamically imported module" — the SAME error as a real failure. Retry
    // transient import errors (showing "Building\\u2026", not the scary card)
    // before giving up; a genuine error still surfaces after the retries.
    const _importRetry = async (specOrThunk, attempts) => {
      attempts = attempts || 8
      const load = typeof specOrThunk === 'function' ? specOrThunk : () => import(specOrThunk)
      for (let i = 0; i < attempts; i++) {
        try { return await load() }
        catch (e) {
          const msg = String(e && e.message || e)
          const transient = /Failed to fetch|error loading|Importing a module|dynamically imported/i.test(msg)
          if (!transient || i === attempts - 1) throw e
          if (_empty()) _root.textContent = 'Building\\u2026'
          await new Promise(r => setTimeout(r, 250))
        }
      }
    }
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
      const _aioMod = await _importRetry('aio')
      const _appMod = await _importRetry(() => import('/${entry}?v=' + Date.now()))
      const App = _appMod.default
      if (!App) throw new Error('${entry} has no default export \u2014 add: export default function App() { \u2026 }')
      if (_aioMod.ensureConnected) _aioMod.ensureConnected()
      if (_aioMod._waitForState) {
        _root.textContent = 'Loading\\u2026'
        await _aioMod._waitForState()
      }
      const { mount: _mount } = await _importRetry('/__aio/air/aio-renderer.ts')
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
