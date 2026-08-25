// HTML shell generation — dispatches to prod, AIO dev, or React dev templates.

import { UI_ENTRY } from "./app-files.ts";
import type { CallTimeouts } from "../protocol/protocol-types.ts";
import type { RenderBudget } from "../vitals/types.ts";
import type { UiConfig, UiTheme } from "./aio-types.ts";
import { appThemeCss, appThemeTokensCss } from "../build/app-theme.ts";

/** `ui.chrome` — how much of the desktop window the OS draws. */
export type UiChrome = NonNullable<UiConfig["chrome"]>;
/** `ui.theme` — how much of the default look the shell emits. Defined in
 *  aio-types (ONE spelling), re-exported here where the shells reach for it. */
export type { UiTheme };
import { DEFAULT_LANG, escHtml } from "./server-html-constants.ts";
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
 *  AIO-423: without this, mobile Chrome falls back to a 980px layout
 *  viewport and every app renders shrunken by default ("mobile broken by
 *  default"). This is mobile 101 and must be the out-of-the-box behaviour. */
const DEFAULT_VIEWPORT =
  "width=device-width, initial-scale=1, viewport-fit=cover";

/** The title bar aio draws for `ui.chrome: "themed"` — CSS + a mount script,
 *  emitted into the `<head>` so no target's `<body>` template has to know
 *  about it.
 *
 *  Frameless windows are easy; frameless windows that are still USABLE are
 *  not. Dropping the OS frame silently takes three things with it — you can no
 *  longer drag the window, minimise/maximise/close it, or double-click the bar
 *  to zoom — and an app that discovers that after shipping has to rebuild all
 *  three by hand. This puts them back, as ordinary DOM the app's own
 *  stylesheet restyles (`.aio-titlebar*`, `--aio-titlebar-*`).
 *
 *  It mounts only when `window.__aioWindow` exists, i.e. under Electron. The
 *  SAME page served to a browser tab has no window to control, so the bar
 *  removes itself rather than rendering three dead buttons — one shell, both
 *  targets, no build-time branch. */
/** The `<html>` open tag — ONE spelling, on every shell.
 *
 *  Five hand-written `<html>` tags shipped without a `lang`, which is WCAG 2.1
 *  SC 3.1.1 (Level A): a screen reader picks its default voice and
 *  pronunciation rules instead of the page's language, browser translation
 *  misfires, and hyphenation falls back to the UA locale. The framework already
 *  ships an icon, a viewport, a stylesheet and a title bar by default; this is
 *  the one `<html>`-level default it was missing. `ui.lang` overrides it. */
export function htmlOpen(lang?: string): string {
  const tag = (lang ?? DEFAULT_LANG).trim() || DEFAULT_LANG;
  return `<html lang="${escHtml(tag)}">`;
}

function chromeShell(chrome: UiChrome | undefined): string {
  if (chrome !== "themed") return "";
  // The bar's own defaults are written as `var(--theme-token, <literal>)`, so
  // it adopts the default theme's surface/text/border when one is present and
  // still looks finished when `ui.theme: "none"` removed them. A title bar
  // that ignores the app's palette is the tell of bolted-on chrome.
  const css = ":root{--aio-titlebar-height:34px;" +
    "--aio-titlebar-bg:var(--aio-surface-2,#f0f1f3);" +
    "--aio-titlebar-fg:var(--aio-text,#1f2328);" +
    "--aio-titlebar-hover:var(--aio-tint,#0000000f);" +
    "--aio-titlebar-close:var(--aio-danger,#e81123);" +
    // A FAMILY LIST, like --aio-font it defaults to: it used to be a `font`
    // shorthand (`13px/1 system-ui,…`), which nothing could have consumed
    // correctly — and nothing did. The bar reads it below.
    "--aio-titlebar-font:var(--aio-font,system-ui,-apple-system," +
    "sans-serif)}" +
    "@media(prefers-color-scheme:dark){:root{" +
    "--aio-titlebar-bg:var(--aio-surface-2,#1b1f24);" +
    "--aio-titlebar-fg:var(--aio-text,#c9d1d9);" +
    "--aio-titlebar-hover:var(--aio-tint,#ffffff1f)}}" +
    "html.aio-themed body{padding-top:var(--aio-titlebar-height)}" +
    ".aio-titlebar{position:fixed;inset:0 0 auto 0;display:flex;" +
    "align-items:center;height:var(--aio-titlebar-height);" +
    "background:var(--aio-titlebar-bg);color:var(--aio-titlebar-fg);" +
    "font-size:13px;font-family:var(--aio-titlebar-font);" +
    "line-height:1;user-select:none;" +
    "border-bottom:1px solid var(--aio-border,transparent);" +
    "-webkit-app-region:drag;z-index:2147483000}" +
    ".aio-titlebar-title{flex:1;padding:0 12px;overflow:hidden;" +
    "white-space:nowrap;text-overflow:ellipsis;opacity:.8}" +
    ".aio-titlebar-controls{display:flex;height:100%;" +
    "-webkit-app-region:no-drag}" +
    ".aio-titlebar-button{width:44px;height:100%;display:grid;" +
    "place-items:center;padding:0;border:0;background:none;color:inherit;" +
    "cursor:pointer}" +
    ".aio-titlebar-button:hover{background:var(--aio-titlebar-hover)}" +
    '.aio-titlebar-button[data-act="close"]:hover{' +
    "background:var(--aio-titlebar-close);color:#fff}";
  // Glyphs as inline SVG: a font-dependent "─ □ ✕" renders at three different
  // sizes across platforms, and the em-dash trick is invisible in some fonts.
  const svg = (d: string) =>
    `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" ` +
    `stroke="currentColor" stroke-width="1.1">${d}</svg>`;
  const buttons = [
    ["minimize", "Minimize", '<path d="M0 5h10"/>'],
    ["maximize", "Maximize", '<rect x="0.5" y="0.5" width="9" height="9"/>'],
    ["close", "Close", '<path d="M0 0l10 10M10 0L0 10"/>'],
  ]
    .map(([act, label, d]) =>
      `<button class="aio-titlebar-button" data-act="${act}" ` +
      `aria-label="${label}" title="${label}">${svg(d!)}</button>`
    )
    .join("");
  const js = `(function(){function m(){` +
    `if(!window.__aioWindow||document.querySelector('.aio-titlebar'))return;` +
    `var b=document.createElement('div');b.className='aio-titlebar';` +
    `b.innerHTML='<div class="aio-titlebar-title"></div>' +` +
    `'<div class="aio-titlebar-controls">${buttons}</div>';` +
    `var t=b.firstChild;t.textContent=document.title;` +
    // The app owns document.title; a bar that shows the boot-time value is a
    // bar that goes stale the moment a route changes it.
    `try{new MutationObserver(function(){t.textContent=document.title})` +
    `.observe(document.querySelector('title'),{childList:true})}catch(e){}` +
    `b.addEventListener('click',function(e){var a=e.target.closest` +
    `&&e.target.closest('[data-act]');if(a)window.__aioWindow[a.dataset.act]()});` +
    `b.addEventListener('dblclick',function(e){if(!(e.target.closest` +
    `&&e.target.closest('[data-act]')))window.__aioWindow.maximize()});` +
    `document.documentElement.classList.add('aio-themed');` +
    `document.body.insertBefore(b,document.body.firstChild)}` +
    `if(document.readyState==='loading')` +
    `document.addEventListener('DOMContentLoaded',m);else m()})()`;
  return `\n  <style>${css}</style>\n  <script>${js}</script>`;
}

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
  callTimeouts?: CallTimeouts,
  // "/" for server-served shells; "./" for the Android asset shell, whose
  // WebView loads from android_asset where absolute /-paths don't resolve.
  assetBase = "/",
  chrome?: UiChrome,
  theme?: UiTheme,
  themeName?: string,
  /** `<html lang>` is written by {@linkcode htmlOpen}, not here — the shells
   *  pass it positionally so this stays one argument list. */
  _lang?: string,
  /** Carry the full look, disabled, for a runtime that learns `ui.theme` only
   *  after the shell exists (the packaged android WebView). */
  deferTheme = false,
): string {
  // THE baseline, on every target, always — before the app's stylesheet so
  // any of it can be overridden by a single rule.
  //
  // Without it every aio app inherited the browser default `body{margin:8px}`
  // and rendered inside a white frame nobody asked for. No template and no
  // example ships a style.css, so that was EVERY app until its author
  // discovered the cause — the same class as the 980px mobile viewport
  // DEFAULT_VIEWPORT exists to fix ("broken by default" is not a default).
  //
  // Deliberately two rules. This is a baseline, not an opinion: it does not
  // touch fonts, colours, spacing or anything else an app should decide.
  //
  // …and `theme: "none"` turns even this off, because that word has to mean
  // what it says. It documented "nothing at all, not even the variables" while
  // still shipping these two rules — so an app that wanted aio to keep its
  // hands off its CSS entirely had no way to ask, and the one word that looked
  // like the way to ask quietly did not. `box-sizing: border-box` on `*` is a
  // real layout change to a page that assumed content-box; an app porting an
  // existing stylesheet needs a switch that is actually off.
  const baseStyle = theme === "none"
    ? ""
    : `\n  <style>*,*::before,*::after{box-sizing:border-box}body{margin:0}</style>`;
  // The default look (ui.theme). Inlined rather than linked: it is small, it
  // must not cost a round trip before first paint, and the android shell has
  // no server to fetch it from — one emission point, every target.
  //
  // THE opt-in rule. Nothing here paints unless the app asked for it by name.
  // aio's look is not a default because an app can bring CSS in more ways than
  // a shell can see — a `style.css`, a `<style>` in `ui.head`, a sheet the
  // component itself renders, a CSS-in-JS runtime — and a cascade LAYER does
  // not make an unasked-for rule safe: `@layer aio` wins only where the app
  // DISAGREES, so wherever the app said nothing (`max-width` on `<main>`,
  // `display`/`gap` on a class it happens to call `.row`) the default applied
  // unopposed and quietly re-laid-out a page nobody asked it to touch. Worst
  // of all to debug: a rule you never wrote that is not the browser default
  // either. So the shell of an app that never mentions `theme` carries only
  // the INERT half — the `--aio-*` custom properties, which paint nothing
  // unless something references them (`chrome: "themed"`'s title bar does).
  //
  //   unset / "tokens" → variables only, nothing paints  (the default)
  //   "auto"           → the full look until the app ships style.css
  //   "full"           → the full look, always
  //   "none"           → nothing at all, not even the variables
  const themeCss = theme === "none"
    ? null
    : theme === "full" || (theme === "auto" && !hasCSS)
    ? appThemeCss(themeName || title)
    : appThemeTokensCss(themeName || title);
  const themeStyle = themeCss === null ? "" : `\n  <style>${themeCss}</style>`;
  // The android half of `ui.theme`. A packaged APK's shell is written at BUILD
  // time, before `aio.run()` exists, so the build cannot know whether the app
  // opted in — and shipping the default meant a scaffolded android app (whose
  // template markup uses .card/.row/.stack) rendered themed in `deno task dev`
  // and unstyled in the APK. So the full sheet travels with the shell,
  // DISABLED (`media="not all"` parses and applies nothing), and the standalone
  // runtime — which does receive the config — enables it at boot. No flash: the
  // page starts in the state an app that never asked for a theme wants.
  const deferredTheme = deferTheme && themeCss !== null
    ? `\n  <style media="not all" data-aio-theme-deferred>${
      appThemeCss(themeName || title)
    }</style>`
    : "";
  const cssLink = hasCSS
    ? `\n  <link rel="stylesheet" href="${assetBase}style.css">`
    : "";
  const statusScript = showStatus === false
    ? "\n  <script>window.__aioShowStatus=false</script>"
    : "";
  // Client-side config the page needs BEFORE any module runs. `syncCells` is
  // the localFirst decision: it is made on the server at compose time, so the
  // browser has no other way to learn that a cell's methods run locally.
  // `callTimeouts` is the resolved `await cell.method()` ceiling — without it
  // the browser falls back to its own constant and gives up on calls the
  // server is still happily running.
  const clientConfig = {
    ...(renderBudget ? { renderBudget } : {}),
    ...(syncCells && syncCells.length ? { syncCells } : {}),
    ...(callTimeouts ? { callTimeouts } : {}),
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
  // The favicon link only where a server (or the aio:// protocol handler)
  // answers it. The android asset shell has no root to resolve `/__aio/icon`
  // against — and a WebView has no tab to show a favicon in anyway, so
  // emitting it there is a guaranteed dead request in every console.
  const iconLink = assetBase === "/"
    ? `\n  <link rel="icon" href="/__aio/icon">`
    : "";
  return `  <meta charset="UTF-8">
  <meta name="referrer" content="no-referrer">${metaViewport}
  <title>${
    escHtml(title)
  }</title>${iconLink}${metaW}${metaH}${baseStyle}${themeStyle}${deferredTheme}${
    chromeShell(chrome)
  }${cssLink}${statusScript}${configScript}${extra}`;
}

/** Generates the HTML shell — dev: CDN import map + live-transpiled App.tsx, prod: self-contained app.js */
/** Everything the page shell can be told. NAMED, because it was seventeen
 *  positional arguments and every one of them was optional after the fourth:
 *  the call sites had grown `/* renderBudget *\/ undefined` comments to stay
 *  readable, two of the seventeen were added in a single session, and the one
 *  mistake this shape invites — passing a `string | undefined` in the wrong
 *  slot — type-checks perfectly. A field report asked for exactly this. */
export interface HtmlShellOptions {
  title: string;
  /** Serve the built bundle (`dist/app.js`) instead of the dev import map. */
  prod: boolean;
  /** The app ships a `style.css` — decides the link tag AND `theme: "auto"`. */
  hasCSS: boolean;
  /** Dev import map, inlined into the page. Empty in prod. */
  importMap: string;
  showStatus?: boolean;
  width?: number;
  height?: number;
  renderBudget?: RenderBudget;
  /** ui.entry — the component this page mounts (default: App.tsx). */
  uiEntry?: string;
  /** ui.viewport — override the meta tag, or `false` to omit it. */
  viewport?: string | false;
  /** ui.head — verbatim extra `<head>` content. */
  headExtra?: string;
  /** localFirst: cells the client runs locally and syncs. */
  syncCells?: string[];
  callTimeouts?: CallTimeouts;
  /** ui.chrome — the desktop window frame. */
  chrome?: UiChrome;
  /** ui.theme — how much of the default look this shell emits. */
  theme?: UiTheme;
  /** The identity the accent hue is derived from (the appId). */
  themeName?: string;
  /** ui.lang — the document language (default: "en"). */
  lang?: string;
}

export function generateHTML(o: HtmlShellOptions): string {
  const head = headContent(
    o.title,
    o.hasCSS,
    o.showStatus,
    o.width,
    o.height,
    o.renderBudget,
    o.viewport,
    o.headExtra,
    o.syncCells,
    o.callTimeouts,
    "/",
    o.chrome,
    o.theme,
    o.themeName,
  );

  if (o.prod) return prodHTML(head, o.lang);
  return aioDevHTML(head, o.importMap, o.uiEntry ?? UI_ENTRY, o.lang);
}

/** Android local (standalone WebView) shell. Delegates its `<head>` to the
 *  ONE head builder every other target uses — a hand-rolled copy in the
 *  Android build once carried a different default viewport (no
 *  viewport-fit=cover) and could never learn `ui.head`, so the packaged APK
 *  did not look like the same app in dev (WYSIDIWYSIP; same bug class the
 *  Electron shell fixed by delegating to `generateHTML`). Body differs by
 *  construction: the bundle is IIFE loaded as a classic script (an ESM
 *  `export` would throw in the WebView) and auto-mounts — there is no
 *  importer to call mount().
 *
 *  Head inputs a build-time shell cannot know (`renderBudget`/`syncCells`/
 *  `callTimeouts`) stay unset — the server's "cfg" frame fills them at
 *  connect, exactly as for the Electron aio:// shell. */
export function androidLocalHTML(
  title: string,
  hasCSS: boolean,
  shell?: {
    showStatus?: boolean;
    viewport?: string | false;
    head?: string;
    theme?: UiTheme;
    themeName?: string;
    lang?: string;
  },
): string {
  const head = headContent(
    title,
    hasCSS,
    shell?.showStatus,
    undefined, // width/height — phone window, sized by the OS
    undefined,
    undefined, // renderBudget — cfg frame
    shell?.viewport,
    shell?.head,
    undefined,
    undefined,
    "./", // relative assets — android_asset has no server root
    undefined, // chrome — a phone has no window frame to own
    shell?.theme,
    shell?.themeName,
    shell?.lang,
    // Only when the build could not be told: an explicit ui.theme in the build
    // (not possible today) would make the deferred copy dead weight.
    shell?.theme === undefined,
  );
  return `<!DOCTYPE html>
${htmlOpen(shell?.lang)}
<head>
${head}
</head>
<body>
  <div id="root"></div>
  <script src="./app.js"></script>
</body>
</html>`;
}

/** Prod: app.js bundles React + useAio + user code, exports mount() */
function prodHTML(head: string, lang?: string): string {
  return `<!DOCTYPE html>
${htmlOpen(lang)}
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
  uiEntry = UI_ENTRY,
  lang?: string,
): string {
  const entry = _safeUiEntry(uiEntry);
  // The client's dev flag. Every dev-only tripwire in the isomorphic core —
  // frozen state so a component mutation throws at the site, the readonly hint,
  // the hidden-field read guard — reads `__aioDev`, and until now only the TEST
  // harnesses ever set it. So the browser you actually develop in was the most
  // PERMISSIVE environment aio has, and its bugs surfaced later, in a test or
  // in production. It is set before any module loads, and never in prod.
  return `<!DOCTYPE html>
${htmlOpen(lang)}
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
      // a field report: a render error carries the component path it
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
    // right after a dev restart the server may still be
    // transpiling, so a dynamic import fails transiently with "Failed to fetch
    // dynamically imported module" — the SAME error as a real failure. Retry
    // transient import errors (showing "Building\\u2026", not the scary card)
    // before giving up; a genuine error still surfaces after the retries.
    const _importRetry = async (specOrThunk, attempts) => {
      attempts = attempts || 8
      const load = typeof specOrThunk === 'function' ? specOrThunk: () => import(specOrThunk)
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
