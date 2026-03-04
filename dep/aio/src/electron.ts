// Electron launcher — tries packaged binary first, falls back to dev mode

type Log = { info: (msg: string) => void; error: (msg: string) => void }

/** Window metadata extracted from config or HTML meta tags */
export type AioMeta = { title?: string; width?: number; height?: number }

/** Slugifies a title for use as Electron app name (stable userData path) */
function toSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'aio-app'
}

/** Generates a minimal Electron main.cjs that loads the given URL */
export function electronMainScript(url: string, meta?: AioMeta): string {
  const w = meta?.width ?? 800
  const h = meta?.height ?? 600
  const slug = toSlug(meta?.title ?? 'aio-app')
  return `
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
Menu.setApplicationMenu(null);
app.name = ${JSON.stringify(slug)};

// ── Window state persistence ──
const stateFile = path.join(app.getPath('userData'), 'window-state.json');

function loadBounds(dw, dh) {
  try {
    const d = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (d.width > 0 && d.height > 0) return d;
  } catch {}
  return { width: dw, height: dh };
}

function saveBounds(win) {
  try { fs.writeFileSync(stateFile, JSON.stringify(win.getBounds())); } catch {}
}

app.on('ready', () => {
  const b = loadBounds(${w}, ${h});
  b.webPreferences = { nodeIntegration: false, contextIsolation: true };
  const win = new BrowserWindow(b);
  if (b.x == null) win.center();
  let t;
  const save = () => { clearTimeout(t); t = setTimeout(() => saveBounds(win), 500); };
  win.on('resize', save);
  win.on('move', save);
  win.on('close', () => saveBounds(win));
  win.loadURL(${JSON.stringify(url)});
  // Local keyboard shortcuts (only when window has focus — NOT globalShortcut)
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
  });
});
app.on('window-all-closed', () => process.exit(0));
`.trim()
}

/** Generates a self-contained Electron main.cjs with a connect page for aio-client */
export function electronClientScript(): string {
  return `
const { app, BrowserWindow, Menu, nativeImage } = require('electron');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');

Menu.setApplicationMenu(null);
app.name = 'aio-client';

// ── Window state persistence ──
const stateFile = path.join(app.getPath('userData'), 'window-state.json');

function loadBounds(dw, dh) {
  try {
    const d = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (d.width > 0 && d.height > 0) return d;
  } catch {}
  return { width: dw, height: dh };
}

function saveBounds(win) {
  try { fs.writeFileSync(stateFile, JSON.stringify(win.getBounds())); } catch {}
}

function trackBounds(win) {
  let t;
  const save = () => { clearTimeout(t); t = setTimeout(() => saveBounds(win), 500); };
  win.on('resize', save);
  win.on('move', save);
  win.on('close', () => saveBounds(win));
}

// ── Helpers ──

function fetchPage(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 8000 }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 400) {
        res.resume();
        return reject(new Error('Server returned ' + res.statusCode));
      }
      // Follow redirects (bounded, http/https only)
      if (res.statusCode >= 300 && res.headers.location) {
        res.resume();
        if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
        const loc = res.headers.location;
        if (!loc.startsWith('http://') && !loc.startsWith('https://')) return reject(new Error('Redirect to non-HTTP scheme'));
        return fetchPage(loc, maxRedirects - 1).then(resolve, reject);
      }
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function fetchBuffer(url, maxBytes = 1048576) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) { res.destroy(); return resolve(null); }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function parseMeta(html) {
  const meta = {};
  const titleMatch = html.match(/<title>([^<]*)<\\/title>/i);
  if (titleMatch) meta.title = titleMatch[1];
  const widthMatch = html.match(/<meta[^>]*aio:width[^>]*content="(\\d+)"/i)
    || html.match(/<meta[^>]*content="(\\d+)"[^>]*aio:width/i);
  if (widthMatch) meta.width = parseInt(widthMatch[1], 10);
  const heightMatch = html.match(/<meta[^>]*aio:height[^>]*content="(\\d+)"/i)
    || html.match(/<meta[^>]*content="(\\d+)"[^>]*aio:height/i);
  if (heightMatch) meta.height = parseInt(heightMatch[1], 10);
  return meta;
}

async function connectTo(win, url) {
  try {
    const html = await fetchPage(url);
    const meta = parseMeta(html);

    // Try fetching icon
    const iconUrl = url.replace(/\\/$/, '') + '/icon.png';
    const iconBuf = await fetchBuffer(iconUrl);
    if (iconBuf && iconBuf.length > 0) {
      try { win.setIcon(nativeImage.createFromBuffer(iconBuf)); } catch {}
    }

    // Restore saved bounds, fall back to server meta, then defaults
    const dw = meta.width || 800;
    const dh = meta.height || 600;
    const b = loadBounds(dw, dh);
    win.setResizable(true);
    win.setSize(b.width, b.height);
    if (b.x != null && b.y != null) win.setPosition(b.x, b.y);
    else win.center();
    if (meta.title) win.setTitle(meta.title.replace(/[\\x00-\\x1f\\x7f]/g, ''));

    trackBounds(win);
    win.loadURL(url);
  } catch (e) {
    const msg = e.message || String(e);
    win.webContents.executeJavaScript(
      "document.getElementById('err').textContent = " + JSON.stringify(msg)
    );
  }
}

// ── Connect page HTML ──

const CONNECT_HTML = \`<!DOCTYPE html>
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
    .card {
      text-align: center; padding: 2rem 2.5rem;
    }
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
    #err {
      margin-top: 1rem; font-size: 0.85rem; color: #f44;
      min-height: 1.2em;
    }
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
</html>\`;

// ── Main ──

app.on('ready', () => {
  // Parse --url= from argv
  let directUrl = null;
  for (const arg of process.argv) {
    if (arg.startsWith('--url=')) {
      directUrl = arg.slice(6);
      break;
    }
  }

  const win = new BrowserWindow({
    width: 480, height: 300,
    resizable: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  if (directUrl) {
    if (!directUrl.startsWith('http://') && !directUrl.startsWith('https://')) {
      console.error('--url must use http:// or https:// scheme');
      process.exit(1);
    }
    connectTo(win, directUrl);
    return;
  }

  // Show connect page
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(CONNECT_HTML));

  // Intercept navigation from the form
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    connectTo(win, url);
  });
});

app.on('window-all-closed', () => process.exit(0));
`.trim()
}

// OS-aware packaged Electron binary path
function distBinPath(): string {
  switch (Deno.build.os) {
    case 'darwin': return 'dist/mac/aio-ui-electron.app/Contents/MacOS/aio-ui-electron'
    case 'windows': return 'dist/win-unpacked/aio-ui-electron.exe'
    default: return 'dist/linux-unpacked/aio-ui-electron'
  }
}

/** Resolves an Electron binary — $ELECTRON_PATH > packaged dist > node_modules dev */
async function findElectronBin(log: Log): Promise<string | null> {
  // 1. ELECTRON_PATH env var (AppImage / custom deployment)
  const envPath = Deno.env.get('ELECTRON_PATH')
  if (envPath) {
    try { await Deno.stat(envPath); return envPath }
    catch { log.error(`$ELECTRON_PATH set but not found: ${envPath}`) }
  }

  // 2. Packaged binary (electron-builder output)
  const distBin = distBinPath()
  try { await Deno.stat(distBin); return distBin }
  catch { /* no packaged binary */ }

  // 3. node_modules dev binary
  const electronBin = Deno.build.os === 'windows'
    ? 'node_modules\\.bin\\electron.cmd'
    : 'node_modules/.bin/electron'
  try { await Deno.stat(electronBin); return electronBin }
  catch { log.error('Electron not found — install: deno install npm:electron && deno approve-scripts && deno install') }

  return null
}

/** Writes script to temp file, spawns Electron, cleans up after exit */
async function spawnElectron(bin: string, script: string, extraArgs: string[] = []): Promise<Deno.ChildProcess> {
  const tmpFile = await Deno.makeTempFile({ suffix: '.cjs' })
  await Deno.writeTextFile(tmpFile, script)
  const proc = new Deno.Command(bin, { args: [tmpFile, ...extraArgs] }).spawn()
  proc.status.then(() => Deno.remove(tmpFile).catch(() => {}))
  return proc
}

/** Spawns Electron with the main app script */
export async function launchElectron(url: string, log: Log, meta?: AioMeta): Promise<Deno.ChildProcess | null> {
  const bin = await findElectronBin(log)
  if (!bin) return null
  log.info(`launching Electron (${bin.includes('node_modules') ? 'dev' : bin.includes('dist') ? 'packaged' : '$ELECTRON_PATH'})`)
  return spawnElectron(bin, electronMainScript(url, meta))
}

/** Launches Electron with the client connect-page script (no server needed) */
export async function launchElectronClient(log: Log, url?: string): Promise<Deno.ChildProcess | null> {
  const bin = await findElectronBin(log)
  if (!bin) return null
  const args = url ? [`--url=${url}`] : []
  log.info(`launching aio client${url ? ` → ${url}` : ''}`)
  return spawnElectron(bin, electronClientScript(), args)
}
