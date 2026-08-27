// Shared types, helpers, and CJS template fragments for Electron script generators

import { generateHTML } from "../server/server-html-gen.ts";
import type { UiTheme } from "../server/aio-types.ts";

export type Log = { info: (msg: string) => void; error: (msg: string) => void };

/** The `<head>`-shaped half of `UiConfig` — everything the HTML shell must
 *  carry because no runtime frame can deliver it after the page exists. */
export type ShellConfig = {
  showStatus?: boolean;
  width?: number;
  height?: number;
  viewport?: string | false;
  head?: string;
  /** ui.lang — `<html lang>`; the packaged shell must carry what dev serves. */
  lang?: string;
  /** ui.chrome — the packaged shell must draw the same title bar dev does. */
  chrome?: "standard" | "themed" | "none";
  /** ui.theme + the identity its accent comes from — without these the
   *  packaged app renders unstyled where dev renders themed, which is the
   *  exact shell-divergence class this whole file exists to prevent. */
  theme?: UiTheme;
  themeName?: string;
};

/** Window metadata extracted from config or HTML meta tags */
export type AioMeta = {
  title?: string;
  width?: number;
  height?: number;
  /** Allow openWindow child windows (off by default — see AioRunOptions). */
  childWindows?: boolean;
  /** `ui.chrome` — how much of the window the OS draws. See UiConfig. */
  chrome?: "standard" | "themed" | "none";
};

/** Slugifies a title for use as Electron app name (stable userData path) */
export function toSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
    "aio-app";
}

// ── Reusable CJS template fragments (embedded in generated Electron main.cjs) ──

/** Main-process crash guard. Without a listener, ANY uncaught exception in the
 *  Electron main process pops the native "A JavaScript error occurred in the
 *  main process" dialog — intrusive, uncopyable, and meaningless to end users.
 *  Installing a handler suppresses that dialog; we log the error prominently to
 *  stderr instead (visible in the dev console and app log). During quit a late
 *  socket/window callback must never dialog or crash — it just exits clean.
 *  Expects `app` to be in scope. Set `__aioQuitting = true` on window close. */
export function tmplCrashGuard(): string {
  return `
let __aioQuitting = false;
app.on('before-quit', () => { __aioQuitting = true; });
app.on('will-quit', () => { __aioQuitting = true; });
process.on('uncaughtException', (err) => {
  const info = (err && err.stack) || String(err);
  if (__aioQuitting) { console.error('[aio:electron] exception during quit (ignored): ' + info); return; }
  console.error('[aio:electron] uncaught exception in main process: ' + info);
  try { app.quit(); } catch { process.exit(1); }
});
process.on('unhandledRejection', (reason) => {
  console.error('[aio:electron] unhandled promise rejection in main process: ' + ((reason && reason.stack) || String(reason)));
});`;
}

/** Die with the aio server that launched this window.
 *
 *  Electron is spawned as a plain child: when the server is SIGKILLed,
 *  OOM-killed or crashes, the window stays up — "reconnecting" forever to a
 *  socket that will never come back, and when the app is started again the
 *  OLD window reconnects to the NEW server while the new server opens its own.
 *  Two windows, one app, one of them running yesterday's renderer. So the
 *  launcher passes its pid and the main process watches it: gone ⇒ quit, with
 *  a line saying why. A `process.ppid` check would not do — the `.bin/electron`
 *  shim sits between the two and outlives its parent as well.
 *  Expects `app` and `__aioQuitting` (tmplCrashGuard) in scope. */
export function tmplParentWatch(): string {
  return `
const __aioParent = Number(process.env.AIO_PARENT_PID || 0);
if (__aioParent > 0) {
  const __aioParentTimer = setInterval(() => {
    let alive = true;
    try { process.kill(__aioParent, 0); } catch (e) { alive = !!(e && e.code === 'EPERM'); }
    if (alive) return;
    clearInterval(__aioParentTimer);
    console.warn('[aio:electron] the aio server (pid ' + __aioParent + ') is gone — closing the window');
    __aioQuitting = true;
    try { app.quit(); } catch { process.exit(0); }
  }, 2000);
  __aioParentTimer.unref && __aioParentTimer.unref();
}`;
}

/** Window bounds persistence: stateFile, loadBounds, saveBounds.
 *  @param async Use async fs/promises variant (UDS) vs sync writeFileSync (standard) */
export function tmplBounds(async = false): string {
  const save = async
    ? `  try { require('fs/promises').writeFile(stateFile, JSON.stringify(win.getBounds())).catch(() => {}); } catch {}`
    : `  // AIO-272: window state persistence failures should be visible
  try { fs.writeFileSync(stateFile, JSON.stringify(win.getBounds())); }
  catch (e) { console.error("[aio:electron] saveBounds failed:", e); }`;
  return `
const stateFile = path.join(app.getPath('userData'), 'window-state.json');

function loadBounds(dw, dh) {
  try {
    const d = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (d.width > 0 && d.height > 0) return d;
  } catch {}
  return { width: dw, height: dh };
}

function saveBounds(win) {
${save}
}`;
}

/** THE window-shape rule, for BOTH generated shells: how much of the frame the
 *  OS draws (`ui.chrome`) and whether remote content may render inside the app
 *  (`childWindows` → `<webview>`).
 *
 *  It lives here because it was decided TWICE and only once correctly. The UDS
 *  shell read `meta.chrome` and `meta.childWindows`; the WebSocket shell — the
 *  one taken whenever the app has a TCP port, i.e. `--expose`, `--port=N`, or
 *  `transport: "ws"` — read neither. So the same `ui.chrome: "none"` produced a
 *  frameless window under `deno task dev` and a fully framed one under
 *  `deno task dev --expose`: one config, two windows, no warning. `ui.chrome`
 *  is one of the three identity-derived defaults the framework promises are
 *  the same everywhere the app appears, which makes a transport-dependent
 *  answer exactly the divergence class this project refuses.
 *
 *  Emits the `b.webPreferences = …` / `b.frame = …` pair; `extra` carries the
 *  keys only one shell has (the UDS preload). Expects `b` in scope. */
export function tmplWindowShape(
  meta: AioMeta | undefined,
  extra: Record<string, string> = {},
): string {
  const prefs = [
    "nodeIntegration: false",
    "contextIsolation: true",
    // webviewTag rides the same childWindows opt-in as openWindow: both are
    // "render remote content inside the app". Off by default; a <webview>
    // without the gate simply does not render.
    `webviewTag: ${JSON.stringify(!!meta?.childWindows)}`,
    ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`),
  ];
  return `  b.webPreferences = { ${prefs.join(", ")} };
  // ui.chrome: "themed"/"none" drop the OS frame. "themed" gets aio's own
  // title bar back from the page shell (server-html-gen); "none" is a bare
  // canvas and the app draws whatever it wants, including its drag region.
  b.frame = ${JSON.stringify((meta?.chrome ?? "standard") === "standard")};`;
}

/** Debounced bounds tracking (resize/move/close) — returns CJS lines to insert inside ready */
export function tmplBoundsTracking(): string {
  return `  let t;
  const save = () => { clearTimeout(t); t = setTimeout(() => saveBounds(win), 500); };
  win.on('resize', save);
  win.on('move', save);
  win.on('close', () => saveBounds(win));`;
}

/** Local keyboard shortcuts (Ctrl+F5/Ctrl+R reload, F12 devtools,
 *  Ctrl+Shift+Del clear cache). Plain F5 is deliberately NOT bound — it stays
 *  free for aio apps' own custom shortcuts. */
export function tmplKeyboardShortcuts(): string {
  return `  // Local keyboard shortcuts (only when window has focus)
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    // Ctrl+F5 / Ctrl+R / Ctrl+Shift+R — hard reload (bypasses cache).
    // Plain F5 is left to the app (custom in-app shortcuts).
    if ((ctrl && input.key === 'F5') || (ctrl && input.key.toLowerCase() === 'r')) {
      event.preventDefault();
      win.webContents.reloadIgnoringCache();
    }
    // F12 / Ctrl+Shift+I — toggle DevTools
    if (input.key === 'F12' || (ctrl && input.shift && input.key.toLowerCase() === 'i')) {
      event.preventDefault();
      win.webContents.toggleDevTools();
    }
    // Ctrl+Shift+Delete — clear all caches and hard reload
    if (ctrl && input.shift && input.key === 'Delete') {
      event.preventDefault();
      win.webContents.session.clearCache().then(() => {
        win.webContents.session.clearStorageData().then(() => {
          win.webContents.reloadIgnoringCache();
        });
      });
    }
    // Ctrl+P — renderer window.print() is a no-op on Electron 41 Linux, call from main instead
    if (ctrl && !input.shift && input.key.toLowerCase() === 'p') {
      event.preventDefault();
      win.webContents.print({ silent: false, printBackground: true });
    }
  });`;
}

/** will-navigate interception — blocks cross-origin nav, relays via IPC.
 *  @param originExpr JS expression that evaluates to the app origin string */
export function tmplWillNavigate(originExpr: string): string {
  return `  // AIO-54: Electron swallows <a> clicks before DOM dispatch — relay via IPC.
  // only SAME-APP links are in-app navigation. A cross-origin
  // (external) link must never be fed to navigate() — for a routerless app that
  // pushState()s a bogus path and white-screens on reload. Send external
  // http/https to the system browser instead; block everything else.
  //
  // "Same app" is protocol + host, NOT \`URL.origin\`: for a custom scheme the
  // WHATWG origin is the literal string "null", so on the zero-port page
  // (aio://app/) every navigation — including the dev reload of the root —
  // compared unequal, was vetoed here, and the window sat on its old document
  // with the relay frozen (net::ERR_ABORTED, nothing logged).
  const _sameApp = (u) => (u.protocol + '//' + u.host) === ${originExpr};
  win.webContents.on('will-navigate', (event, navUrl) => {
    let u;
    try { u = new URL(navUrl); } catch {
      event.preventDefault();
      console.warn('[aio:electron] navigation blocked (unparsable URL): ' + navUrl);
      return;
    }
    if (_sameApp(u)) {
      if (u.pathname === '/' || u.pathname === '') return; // full reload of root
      event.preventDefault();
      win.webContents.send('__aio:navigate', navUrl); // in-app route
      return;
    }
    event.preventDefault(); // external — never route it into the app
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      require('electron').shell.openExternal(navUrl);
    } else {
      console.warn('[aio:electron] navigation blocked (not this app, not http): ' + navUrl);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // window.open / target=_blank to an external site → system browser, not a
    // rogue Electron window.
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        require('electron').shell.openExternal(url);
      }
    } catch {}
    return { action: 'deny' };
  });
  // Local hotfix: <webview> GUESTS need the same popup policy — the guest's
  // 'new-window' DOM event was removed in Electron 22, so a renderer-side
  // listener never fires and a target=_blank inside an embedded page did
  // nothing at all (no window, no external open). The guest's own
  // setWindowOpenHandler is the supported route.
  win.webContents.on('did-attach-webview', (_ev, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      try {
        const u = new URL(url);
        if (u.protocol === 'http:' || u.protocol === 'https:') {
          require('electron').shell.openExternal(url);
        }
      } catch {}
      return { action: 'deny' };
    });
  });`;
}

// ── Client connect page HTML (used by electronClientScript) ──

export const CONNECT_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>aio</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #1a1a2e; color: #e0e0e0;
      display: flex; align-items: flex-start; justify-content: center;
      min-height: 100vh; user-select: none; padding: 3rem 1rem;
    }
    .card { width: 100%; max-width: 420px; }
    h1 {
      font-size: 1.8rem; font-weight: 300; letter-spacing: 0.1em;
      color: #4a9eff; margin-bottom: 1.5rem; text-align: center;
    }
    form { display: flex; gap: 0.5rem; }
    input {
      flex: 1; padding: 0.6rem 1rem; font-size: 0.95rem;
      background: #16213e; border: 1px solid #333; border-radius: 6px;
      color: #e0e0e0; outline: none; min-width: 0;
    }
    input:focus { border-color: #4a9eff; }
    input::placeholder { color: #666; }
    button {
      padding: 0.6rem 1.2rem; font-size: 0.95rem;
      background: #4a9eff; border: none; border-radius: 6px;
      color: white; cursor: pointer; white-space: nowrap;
    }
    button:hover { background: #3a8eef; }
    #err { margin-top: 1rem; font-size: 0.85rem; color: #f44; min-height: 1.2em; text-align: center; }
    .section { margin-top: 1.75rem; }
    .section h2 {
      font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.12em;
      color: #6b7a99; margin-bottom: 0.6rem; display: flex; align-items: center; gap: 0.5rem;
    }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: #3ecf8e; display: inline-block; }
    .dot.scanning { background: #4a9eff; animation: pulse 1s infinite; }
    @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.3 } }
    .app {
      display: flex; align-items: center; justify-content: space-between;
      padding: 0.6rem 0.8rem; background: #16213e; border: 1px solid #26304d;
      border-radius: 8px; margin-bottom: 0.4rem; cursor: pointer;
    }
    .app:hover { border-color: #4a9eff; background: #1b2947; }
    .app .name { font-size: 0.95rem; color: #e0e0e0; }
    .app .meta { font-size: 0.78rem; color: #6b7a99; margin-top: 0.15rem; }
    .app .badge { font-size: 0.7rem; color: #d9a441; }
    .empty { font-size: 0.82rem; color: #55617d; padding: 0.3rem 0; }
    .row { display: flex; align-items: center; gap: 0.4rem; }
    .del { color: #55617d; font-size: 0.8rem; padding: 0 0.3rem; }
    .del:hover { color: #f44; }
    .pairform { flex: 1; display: flex; gap: 0.4rem; }
    .pairform input { padding: 0.5rem 0.7rem; letter-spacing: 0.25em; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <h1>aio</h1>
    <form id="f">
      <input id="addr" type="text" placeholder="192.168.88.180:8000" autofocus spellcheck="false" />
      <button type="submit">Connect</button>
    </form>
    <div id="err"></div>

    <div class="section" id="discovered-section" style="display:none">
      <h2><span class="dot scanning" id="scan-dot"></span> Apps on your network</h2>
      <div id="discovered"></div>
    </div>

    <div class="section" id="recents-section" style="display:none">
      <h2>Recent</h2>
      <div id="recents"></div>
    </div>
  </div>
  <script>
    function go(url) {
      if (!url) return;
      if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'http://' + url;
      try { new URL(url); } catch { document.getElementById('err').textContent = 'Invalid URL'; return; }
      document.getElementById('err').textContent = '';
      location.href = url;
    }
    document.getElementById('f').onsubmit = (e) => {
      e.preventDefault();
      go(document.getElementById('addr').value.trim());
    };
    function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '': String(s); return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

    // Filled by the Electron main process (see electron-client-script). In a
    // plain browser these stay empty and only the manual field shows.
    function appRow(a, extra) {
      const badge = a.needsAuth ? '<span class="badge">\\u26bf auth</span>': '';
      const sub = esc(a.url || a.host + ':' + a.port);
      const data = 'data-url="' + esc(a.url) + '" data-host="' + esc(a.host || '') +
        '" data-port="' + esc(a.port) + '" data-tls="' + (a.tls ? '1': '') +
        '" data-auth="' + (a.needsAuth ? '1': '') + '"';
      return '<div class="row"><div class="app" ' + data + ' style="flex:1">' +
        '<div><div class="name">' + esc(a.title || a.name) + '</div><div class="meta">' + sub + '</div></div>' +
        badge + '</div>' + (extra || '') + '</div>';
    }
    // Auth apps with no token yet → pair by PIN. Everything else connects directly.
    function onAppClick(el) {
      const url = el.getAttribute('data-url') || '';
      if (el.getAttribute('data-auth') === '1' && !/[?&]token=/.test(url)) promptPair(el);
      else go(url);
    }
    function promptPair(el) {
      const host = el.getAttribute('data-host');
      const port = Number(el.getAttribute('data-port'));
      const tls = el.getAttribute('data-tls') === '1';
      const row = el.closest('.row');
      row.innerHTML = '<form class="pairform">' +
        '<input class="pin" inputmode="numeric" maxlength="6" placeholder="pair code" spellcheck="false" />' +
        '<button type="submit">Pair</button></form>';
      const form = row.querySelector('.pairform');
      form.onsubmit = (e) => {
        e.preventDefault();
        const pin = row.querySelector('.pin').value.trim();
        if (!/^[0-9]{6}$/.test(pin)) { document.getElementById('err').textContent = 'Enter the 6-digit code shown by the app'; return; }
        document.getElementById('err').textContent = 'Pairing\\u2026';
        location.href = 'aio-pair:' + encodeURIComponent(JSON.stringify({ host, port, tls, pin }));
      };
      row.querySelector('.pin').focus();
    }
    window.__aioSetDiscovered = function(apps) {
      const sec = document.getElementById('discovered-section');
      const box = document.getElementById('discovered');
      sec.style.display = 'block';
      if (!apps || !apps.length) { box.innerHTML = '<div class="empty">searching\\u2026</div>'; return; }
      box.innerHTML = apps.map((a) => appRow(a)).join('');
      box.querySelectorAll('.app').forEach((el) => el.onclick = () => onAppClick(el));
    };
    window.__aioScanDone = function() { const d = document.getElementById('scan-dot'); if (d) d.classList.remove('scanning'); };
    window.__aioSetRecents = function(items) {
      const sec = document.getElementById('recents-section');
      const box = document.getElementById('recents');
      if (!items || !items.length) { sec.style.display = 'none'; return; }
      sec.style.display = 'block';
      box.innerHTML = items.map((a) => appRow(a, '<span class="del" data-del="' + esc(a.url) + '">\\u2715</span>')).join('');
      box.querySelectorAll('.app').forEach((el) => el.onclick = () => onAppClick(el));
      box.querySelectorAll('.del').forEach((el) => el.onclick = (e) => {
        e.stopPropagation();
        location.href = 'aio-forget:' + encodeURIComponent(el.getAttribute('data-del'));
      });
    };
  </script>
</body>
</html>`;

// ── UDS-mode template helpers ──

/** Generates preload script CJS code (contextBridge IPC + AIO-54 navigate relay) */
export function udsPreloadScript(): string {
  return `
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('__aioIPC', {
  send:      (json) => ipcRenderer.send('__aio:send', json),
  ready:     ()     => ipcRenderer.send('__aio:ready'),
  onMessage: (fn)   => ipcRenderer.on('__aio:msg',   (_e, line) => fn(line)),
  onOpen:    (fn)   => ipcRenderer.on('__aio:open',  () => fn()),
  onClose:   (fn)   => ipcRenderer.on('__aio:close', () => fn()),
  // Renderer window.print() is a silent no-op on Electron 41 Linux — route through main
  print:     ()     => ipcRenderer.send('__aio:print'),
  // open an http/https link in the system browser. The main process
  // enforces the allowlist — a renderer can't reach arbitrary shell targets.
  openExternal: (url) => ipcRenderer.send('__aio:openExternal', url),
  // Child window: open an http/https page in a CHILD BrowserWindow whose
  // preload (a file the app ships inside its own directory) can inject a
  // provider — e.g. a wallet provider speaking to the app's local bridge.
  // Gated by aio.run({ childWindows: true }); the main process validates the
  // URL and the preload path. opts: { preload, sandbox } — sandbox stays ON
  // unless the app EXPLICITLY passes sandbox: false (logged).
  openWindow: (url, opts) => ipcRenderer.send('__aio:openWindow', { url, ...(opts || {}) }),
});
// Window controls for ui.chrome "themed"/"none": a frameless window loses
// minimise, maximise and close along with its frame, and a page cannot get
// them back on its own. Exposed ALWAYS (not only when themed) so an app using
// chrome:"none" can build its own bar out of the same three verbs — the bridge
// is the capability; the title bar is just one consumer of it.
contextBridge.exposeInMainWorld('__aioWindow', {
  minimize: () => ipcRenderer.send('__aio:win', 'minimize'),
  maximize: () => ipcRenderer.send('__aio:win', 'maximize'),
  close:    () => ipcRenderer.send('__aio:win', 'close'),
});
// AIO-54: Relay intercepted <a> navigations back to renderer as CustomEvent
ipcRenderer.on('__aio:navigate', (_e, url) => {
  window.dispatchEvent(new CustomEvent('aio:navigate', { detail: { url } }));
});
`;
}

/** Generates prod-mode index.html for the aio:// protocol.
 *
 *  This DELEGATES to the one prod shell (`generateHTML(prod: true)`) rather
 *  than hand-rolling a second one. It used to be its own copy, and the copy
 *  silently dropped every `<head>` input — `ui.head`, `ui.viewport`,
 *  `ui.showStatus`, the `aio:width/height` metas. The result was a packaged
 *  Electron app that did not look like the same app in dev: a `ui.head` reset
 *  (body margin, `color-scheme`) applied under `deno task dev` and vanished in
 *  the AppImage. Divergence between the shells IS the bug class, so there is
 *  now only one shell.
 *
 *  `renderBudget`/`syncCells`/`callTimeouts` stay unset here on purpose — a
 *  build-time-templated shell cannot know them, which is exactly why the
 *  server sends the "cfg" frame (see `_applyServerConfig`). Shell-injected
 *  keys win; these gaps are filled at connect. Only head content, which no
 *  frame can retrofit, has to be threaded through. */
export function udsProdHTML(
  title: string,
  hasCSS: boolean,
  shell?: ShellConfig,
): string {
  // renderBudget / uiEntry / syncCells / callTimeouts are deliberately absent —
  // see the note above: the cfg frame fills them at connect.
  return generateHTML({
    title,
    prod: true,
    hasCSS,
    importMap: "", // prod bundles its own imports
    showStatus: shell?.showStatus,
    width: shell?.width,
    height: shell?.height,
    viewport: shell?.viewport,
    headExtra: shell?.head,
    chrome: shell?.chrome,
    theme: shell?.theme,
    themeName: shell?.themeName,
    lang: shell?.lang,
  });
}
