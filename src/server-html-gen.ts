// HTML shell generation — dispatches to prod, AIO dev, or React dev templates.

import type { RenderBudget } from "./vitals/types.ts";
import { escHtml } from "./server-html-constants.ts";
import {
  devWsScript,
  errorBoundaryScript,
  healthOverlayScript,
} from "./server-html-scripts.ts";
import { errorOverlayScript } from "./server-html-error-overlay.ts";

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
  renderer?: "react" | "aio",
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
  if (renderer === "aio") return aioDevHTML(head, importMap);
  return reactDevHTML(head, importMap);
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
function aioDevHTML(head: string, importMap: string): string {
  return `<!DOCTYPE html>
<html>
<head>
${head}
</head>
<body>
  <div id="root"></div>
  <script type="importmap">${importMap.replace(/</g, "\\u003c")}</script>
  <script type="module">${devWsScript()}

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

/** Dev: CDN React via import map + live transpile + error overlay */
function reactDevHTML(head: string, importMap: string): string {
  return `<!DOCTYPE html>
<html>
<head>
${head}
</head>
<body>
  <div id="root"></div>
  <script type="importmap">${importMap.replace(/</g, "\\u003c")}</script>
  <script type="module">
    import { createElement, Component } from 'react'
    import { createRoot } from 'react-dom/client'
    // Error boundary — catches render errors. Subscribes to state to:
    // 1. Prevent 300ms teardown (keeps _listeners.size > 0 while children are unmounted)
    // 2. Auto-recover when server sends a new state update${errorBoundaryScript()}${devWsScript()}${errorOverlayScript()}${healthOverlayScript()}
  </script>
</body>
</html>`;
}
