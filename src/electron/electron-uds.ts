// Electron main.cjs generator — UDS (Unix Domain Socket) mode with IPC bridge
// Dev mode: page from HTTP, state via UDS+IPC
// Prod mode: page from disk via aio:// protocol, state via UDS+IPC

import {
  type AioMeta,
  tmplBounds,
  tmplBoundsTracking,
  tmplKeyboardShortcuts,
  tmplWillNavigate,
  toSlug,
  udsPreloadScript,
  udsProdHTML,
} from "./electron-shared.ts";

/** Generates an Electron main.cjs that connects to backend via Unix domain socket + IPC bridge */
export function electronMainScriptUDS(url: string, socketPath: string, opts: {
  baseDir?: string;
  title?: string;
  hasCSS?: boolean;
  meta?: AioMeta;
}): string {
  const w = opts.meta?.width ?? 800;
  const h = opts.meta?.height ?? 600;
  const slug = toSlug(opts.meta?.title ?? opts.title ?? "aio-app");
  const title = opts.title ?? "aio";
  const hasCSS = opts.hasCSS ?? false;
  return `
const { app, BrowserWindow, Menu, ipcMain, protocol } = require('electron');
const { connect } = require('net');
const path = require('path');
const fs = require('fs');
// Electron 41 + Linux: CloudPrintEnable triggers mDNS discovery that blocks window.print() dialog via Avahi timeout
app.commandLine.appendSwitch('disable-features', 'CloudPrintEnable');
Menu.setApplicationMenu(null);
app.name = ${JSON.stringify(slug)};

// ── Auto-detect: serve from disk (prod) or HTTP (dev) ──
const BASE_DIR = ${JSON.stringify(opts.baseDir ?? "")};
const USE_PROTOCOL = BASE_DIR && fs.existsSync(path.join(BASE_DIR, 'app.js'));

// AIO-56: Register aio:// scheme as privileged BEFORE app.on('ready').
if (USE_PROTOCOL) {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'aio',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  }]);
}

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
};

const PROD_HTML = ${
    JSON.stringify(udsProdHTML(title, hasCSS)).replace(/\n/g, "\\n")
  };

// ── Window state persistence ──
${tmplBounds(true)}

// ── Preload script (written to temp) ──
const preloadCode = ${JSON.stringify(udsPreloadScript())};
const preloadFile = path.join(app.getPath('temp'), '__aio_preload_' + process.pid + '.cjs');
fs.writeFileSync(preloadFile, preloadCode);

let reconnectTimer = null;
let sock = null;

app.on('ready', () => {
  if (USE_PROTOCOL) {
    protocol.handle('aio', async (req) => {
      const url = new URL(req.url);
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { pathname = url.pathname; }
      if (pathname === '/' || pathname === '') {
        return new Response(PROD_HTML, { headers: { 'Content-Type': 'text/html' } });
      }
      const filePath = path.resolve(path.join(BASE_DIR, pathname));
      const basePfx = BASE_DIR.endsWith(path.sep) ? BASE_DIR : BASE_DIR + path.sep;
      if (!filePath.startsWith(basePfx) && filePath !== BASE_DIR) {
        return new Response('Forbidden', { status: 403 });
      }
      try {
        const data = await require('fs/promises').readFile(filePath);
        const ext = path.extname(filePath).toLowerCase();
        return new Response(data, { headers: { 'Content-Type': MIME[ext] || 'application/octet-stream' } });
      } catch {
        return new Response('Not Found', { status: 404 });
      }
    });
  }

  const b = loadBounds(${w}, ${h});
  b.webPreferences = { nodeIntegration: false, contextIsolation: true, preload: preloadFile };
  const win = new BrowserWindow(b);
  if (b.x == null) win.center();

  try {
    const { nativeImage } = require('electron');
    const iconPath = BASE_DIR
      ? path.join(BASE_DIR, 'icon.png')
      : path.join(process.cwd(), 'src', 'icon.png');
    if (fs.existsSync(iconPath)) {
      win.setIcon(nativeImage.createFromDataURL(
        'data:image/png;base64,' + fs.readFileSync(iconPath).toString('base64')
      ));
    }
  } catch {}

${tmplBoundsTracking()}

  // ── UDS connection — NDJSON over Unix socket ──
  const SOCK = ${JSON.stringify(socketPath)};
  let buf = '', retry = 0, lastFullState = null, lastState = null, pageReady = false;
  const _ipcQueue = [], IPC_QUEUE_MAX = 100; // AIO-284: offline queue
  let closing = false;
  win.on('close', () => { closing = true; });
  win.webContents.on('did-start-navigation', () => { pageReady = false; });
  win.webContents.on('did-finish-load', () => { pageReady = true; });

  ipcMain.on('__aio:ready', () => {
    if (closing) return;
    if (sock) {
      win.webContents.send('__aio:open');
      sock.write('__subs:["*"]\\n');
      if (lastFullState) win.webContents.send('__aio:msg', lastFullState);
    }
  });

  function connectUDS() {
    sock = connect(SOCK);
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      retry = 0; lastFullState = null; lastState = null;
      while (_ipcQueue.length > 0 && sock && !sock.destroyed) sock.write(_ipcQueue.shift() + '\\n');
      if (!closing && pageReady) win.webContents.send('__aio:open');
    });
    sock.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line || closing) continue;
        if (line[0] === '{') {
          lastState = line;
          if (line.indexOf('"$p"') === -1 && line.indexOf('"$f"') === -1) lastFullState = line;
        }
        if (pageReady) win.webContents.send('__aio:msg', line);
      }
    });
    sock.on('error', (err) => { console.error("[aio:electron] UDS socket error:", err); });
    sock.on('close', () => {
      sock = null;
      if (closing) return;
      if (pageReady) win.webContents.send('__aio:close');
      const delay = Math.min(1000 * Math.pow(2, retry), 8000);
      retry++;
      reconnectTimer = setTimeout(connectUDS, delay);
    });
  }
  connectUDS();

  ipcMain.on('__aio:print', () => {
    if (!win.isDestroyed()) win.webContents.print({ silent: false, printBackground: true });
  });

  // mdview #7: open a link in the system browser. Allowlist http/https ONLY —
  // a compromised renderer must not reach file:/ or custom shell handlers.
  ipcMain.on('__aio:openExternal', (_event, url) => {
    try {
      const u = new URL(String(url));
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        require('electron').shell.openExternal(u.href);
      }
    } catch { /* malformed url — ignore */ }
  });

  ipcMain.on('__aio:send', (_event, json) => {
    const s = sock;
    if (s && !s.destroyed) {
      s.write(json + '\\n', (err) => {
        if (err && !closing && sock === s) {
          s.destroy();
          sock = null;
          if (pageReady && !win.isDestroyed()) win.webContents.send('__aio:close');
        }
      });
    } else if (_ipcQueue.length < IPC_QUEUE_MAX) {
      _ipcQueue.push(json);
    }
  });

${tmplKeyboardShortcuts()}

  if (!USE_PROTOCOL) {
    app.on('certificate-error', (event, _wc, _url, _err, _cert, cb) => {
      const u = new URL(${JSON.stringify(url)});
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') { event.preventDefault(); cb(true); }
      else cb(false);
    });
  }

  // AIO-73: aio:/// (no host) fails — use aio://app/ (with host component)
  win.loadURL(USE_PROTOCOL ? 'aio://app/': ${JSON.stringify(url)});
  const _appOrigin = USE_PROTOCOL ? 'aio://app' : new URL(${
    JSON.stringify(url)
  }).origin;
${tmplWillNavigate("_appOrigin")}
});

app.on('window-all-closed', () => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (sock) sock.destroy();
  try { fs.unlinkSync(preloadFile); } catch {}
  process.exit(0);
});
`.trim();
}
