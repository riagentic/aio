// HTML shell generation — dispatches to prod, AIO dev, or React dev templates.

import type { RenderBudget } from "../vitals/types.ts";
import { escHtml } from "./server-html-constants.ts";
import { devWsScript } from "./server-html-scripts.ts";

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
  return `<!DOCTYPE html>
<html>
<head>
${head}
</head>
<body>
  <div id="root"></div>
  <script type="importmap">${importMap.replace(/</g, "\\u003c")}</script>
  <script type="module">${devWsScript()}

    // Mount AIO app — bind cells reactively, wait for server state, then render
    const _aioMod = await import('aio')
    const _appMod = await import('/${uiEntry}?v=' + Date.now())
    const App = _appMod.default
    if (_aioMod.ensureConnected) _aioMod.ensureConnected()
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
