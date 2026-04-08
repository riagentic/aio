// Shared types, helpers, and CJS template fragments for Electron script generators

export type Log = { info: (msg: string) => void; error: (msg: string) => void };

/** Window metadata extracted from config or HTML meta tags */
export type AioMeta = { title?: string; width?: number; height?: number };

/** Slugifies a title for use as Electron app name (stable userData path) */
export function toSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
    "aio-app";
}

// ── Reusable CJS template fragments (embedded in generated Electron main.cjs) ──

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

/** Debounced bounds tracking (resize/move/close) — returns CJS lines to insert inside ready */
export function tmplBoundsTracking(): string {
  return `  let t;
  const save = () => { clearTimeout(t); t = setTimeout(() => saveBounds(win), 500); };
  win.on('resize', save);
  win.on('move', save);
  win.on('close', () => saveBounds(win));`;
}

/** Local keyboard shortcuts (F5/Ctrl+R reload, F12 devtools, Ctrl+Shift+Del clear cache) */
export function tmplKeyboardShortcuts(): string {
  return `  // Local keyboard shortcuts (only when window has focus)
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    // F5 / Ctrl+R / Ctrl+Shift+R — hard reload (bypasses cache)
    if (input.key === 'F5' || (ctrl && input.key.toLowerCase() === 'r')) {
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
  });`;
}

/** will-navigate interception — blocks cross-origin nav, relays via IPC.
 *  @param originExpr JS expression that evaluates to the app origin string */
export function tmplWillNavigate(originExpr: string): string {
  return `  // AIO-54: Electron swallows <a> clicks before DOM dispatch — relay via IPC
  win.webContents.on('will-navigate', (event, navUrl) => {
    try {
      const u = new URL(navUrl);
      if (u.origin === ${originExpr} && (u.pathname === '/' || u.pathname === '')) return;
    } catch {}
    event.preventDefault();
    win.webContents.send('__aio:navigate', navUrl);
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));`;
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
      display: flex; align-items: center; justify-content: center;
      height: 100vh; user-select: none;
    }
    .card { text-align: center; padding: 2rem 2.5rem; }
    h1 {
      font-size: 1.8rem; font-weight: 300; letter-spacing: 0.1em;
      color: #4a9eff; margin-bottom: 1.5rem;
    }
    form { display: flex; gap: 0.5rem; }
    input {
      flex: 1; padding: 0.6rem 1rem; font-size: 0.95rem;
      background: #16213e; border: 1px solid #333; border-radius: 6px;
      color: #e0e0e0; outline: none; width: 260px;
    }
    input:focus { border-color: #4a9eff; }
    input::placeholder { color: #666; }
    button {
      padding: 0.6rem 1.2rem; font-size: 0.95rem;
      background: #4a9eff; border: none; border-radius: 6px;
      color: white; cursor: pointer;
    }
    button:hover { background: #3a8eef; }
    #err { margin-top: 1rem; font-size: 0.85rem; color: #f44; min-height: 1.2em; }
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
  </div>
  <script>
    document.getElementById('f').onsubmit = (e) => {
      e.preventDefault();
      let val = document.getElementById('addr').value.trim();
      if (!val) return;
      if (!val.startsWith('http://') && !val.startsWith('https://')) val = 'http://' + val;
      try { new URL(val); } catch { document.getElementById('err').textContent = 'Invalid URL'; return; }
      document.getElementById('err').textContent = '';
      location.href = val;
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
});
// AIO-54: Relay intercepted <a> navigations back to renderer as CustomEvent
ipcRenderer.on('__aio:navigate', (_e, url) => {
  window.dispatchEvent(new CustomEvent('aio:navigate', { detail: { url } }));
});
`;
}

/** Generates prod-mode index.html for aio:// protocol */
export function udsProdHTML(title: string, hasCSS: boolean): string {
  const safeTitle = title.replace(/[&<>"']/g, "");
  const cssLink = hasCSS ? '\n  <link rel="stylesheet" href="/style.css">' : "";
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="referrer" content="no-referrer">
  <title>${safeTitle}</title>${cssLink}
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
