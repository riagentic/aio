// Electron main.cjs generator — UDS (Unix Domain Socket) mode with IPC bridge
// Dev mode: page from HTTP, state via UDS+IPC
// Prod mode: page from disk via aio:// protocol, state via UDS+IPC

import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
} from "../protocol/transport-shared.ts";
import {
  type AioMeta,
  type ShellConfig,
  tmplBounds,
  tmplBoundsTracking,
  tmplCrashGuard,
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
  /** Dev-mode icon dir — the server's resolved baseDir, THE app-dir decider.
   *  Without it the dev window fell back to cwd/src/, showing a different
   *  window icon than the packaged app for any non-src layout (WYSIDIWYSIP). */
  iconDir?: string;
  meta?: AioMeta;
  /** `<head>` inputs for the templated aio:// shell — without them the
   *  packaged app renders a different `<head>` than dev does. */
  shell?: ShellConfig;
}): string {
  const w = opts.meta?.width ?? 800;
  const h = opts.meta?.height ?? 600;
  const slug = toSlug(opts.meta?.title ?? opts.title ?? "aio-app");
  const title = opts.title ?? "aio";
  const hasCSS = opts.hasCSS ?? false;
  // The window is sized from `meta`; the shell metas must agree with it, so
  // they default to the same numbers instead of silently going missing.
  // Spread only DEFINED overrides: the lifecycle always passes a shell object
  // whose width/height may be undefined, and `...{ width: undefined }` would
  // clobber the defaults this comment promises.
  const shellOverrides = Object.fromEntries(
    Object.entries(opts.shell ?? {}).filter(([, v]) => v !== undefined),
  );
  const shell: ShellConfig = {
    width: w,
    height: h,
    ...shellOverrides,
  };
  return `
const { app, BrowserWindow, Menu, ipcMain, protocol } = require('electron');
const { connect } = require('net');
const path = require('path');
const fs = require('fs');
// Electron 41 + Linux: CloudPrintEnable triggers mDNS discovery that blocks window.print() dialog via Avahi timeout
app.commandLine.appendSwitch('disable-features', 'CloudPrintEnable');
Menu.setApplicationMenu(null);
app.name = ${JSON.stringify(slug)};
${tmplCrashGuard()}

// ── Auto-detect: serve from disk (prod) or HTTP (dev) ──
const BASE_DIR = ${JSON.stringify(opts.baseDir ?? "")};
const USE_PROTOCOL = BASE_DIR && fs.existsSync(path.join(BASE_DIR, 'app.js'));
// machine U11 — never silent: when a dist dir was given but its app.js is
// missing, the window silently falls back from disk (aio://) to HTTP. Say so.
if (BASE_DIR && !USE_PROTOCOL) {
  console.warn('[aio:electron] baseDir set but ' + path.join(BASE_DIR, 'app.js') + ' not found — falling back to the HTTP server (no on-disk bundle)');
}

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
    JSON.stringify(udsProdHTML(title, hasCSS, shell)).replace(/\n/g, "\\n")
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
      const basePfx = BASE_DIR.endsWith(path.sep) ? BASE_DIR: BASE_DIR + path.sep;
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
  // webviewTag rides the same childWindows opt-in as openWindow: both are
  // "render remote content inside the app" capabilities. Off by default; a <webview> without the gate
  // simply doesn't render.
  b.webPreferences = { nodeIntegration: false, contextIsolation: true, preload: preloadFile, webviewTag: ${
    JSON.stringify(!!opts.meta?.childWindows)
  } };
  const win = new BrowserWindow(b);
  if (b.x == null) win.center();

  try {
    const { nativeImage } = require('electron');
    const iconPath = BASE_DIR
      ? path.join(BASE_DIR, 'icon.png')
      : path.join(${
    JSON.stringify(opts.iconDir ?? "")
  } || path.join(process.cwd(), 'src'), 'icon.png');
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
  // The kind of one NDJSON envelope, or null if it is not one. The prefix
  // match is exact for everything enc()/encRaw() produce ({"v":2,"t":"…"});
  // anything else falls back to a real parse rather than a guess.
  const frameKind = (line) => {
    const m = /^\\{"v":2,"t":"([a-z-]+)"/.exec(line);
    if (m) return m[1];
    try { const f = JSON.parse(line); return (f && f.v === 2) ? f.t : null; }
    catch { return null; }
  };
  let down = false, lastErrCode = null; // report a backend outage ONCE, not per retry
  const _ipcQueue = [], IPC_QUEUE_MAX = 100; // AIO-284: offline queue
  let closing = false;
  win.on('close', () => { closing = true; __aioQuitting = true; });
  // MAIN-FRAME navigations only: a <webview> guest attaching/navigating also
  // fires did-start-navigation on the embedder's webContents — gating on that
  // flipped pageReady false forever (did-finish-load never re-fires for the
  // main frame), silently freezing every server→renderer state message the
  // moment a webview attached. Handles
  // both Electron signatures: new (event-details object with isMainFrame) and
  // legacy positional (4th arg).
  win.webContents.on('did-start-navigation', (e, _url, _inPlace, isMainFrame) => {
    const main = (e && typeof e.isMainFrame === 'boolean') ? e.isMainFrame: isMainFrame;
    if (main !== false) pageReady = false;
  });
  win.webContents.on('did-finish-load', () => { pageReady = true; });

  ipcMain.on('__aio:ready', () => {
    if (closing) return;
    if (sock) {
      win.webContents.send('__aio:open');
      sock.write('{"v":2,"t":"subs","d":{"subs":["*"]}}\\n');
      if (lastFullState) win.webContents.send('__aio:msg', lastFullState);
    }
  });

  function connectUDS() {
    sock = connect(SOCK);
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      if (down) { console.info("[aio:electron] backend connection restored (" + SOCK + ")"); down = false; }
      retry = 0; lastErrCode = null; lastFullState = null; lastState = null;
      while (_ipcQueue.length > 0 && sock && !sock.destroyed) sock.write(_ipcQueue.shift() + '\\n');
      if (!closing && pageReady) win.webContents.send('__aio:open');
    });
    sock.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line || closing) continue;
        // v2 envelope: cache the latest full-state frame for late renderers.
        // Classify by the frame's DECODED kind, never by a substring: any
        // frame whose payload merely CONTAINS the text '"t":"state"' — a chat
        // message, a field named t, a serialized frame inside state — was
        // cached as the full-state replay and handed to the next renderer as
        // if it were a snapshot. dec()-then-switch removes the whole class.
        const kind = frameKind(line);
        if (kind === 'state') { lastState = line; lastFullState = line; }
        else if (kind === 'patches') lastState = line;
        if (pageReady) win.webContents.send('__aio:msg', line);
      }
    });
    // Capture the reason only — an 'error' is always followed by 'close', which
    // reports the outage ONCE with the true cause. Prevents a Node stack-trace
    // flood every retry (the "connection working, or visibly obvious why not"
    // rule): a persistent outage should say what's wrong once, then stay quiet.
    sock.on('error', (err) => { lastErrCode = (err && (err.code || err.message)) || 'error'; });
    sock.on('close', () => {
      sock = null;
      if (closing) return;
      if (pageReady) win.webContents.send('__aio:close');
      if (!down) {
        down = true;
        const why = (lastErrCode === 'ECONNREFUSED' || lastErrCode === 'ENOENT')
          ? "backend not reachable — is the aio server running?"
          : ("backend connection lost" + (lastErrCode ? " (" + lastErrCode + ")": ""));
        console.warn("[aio:electron] " + why + " at " + SOCK + " — reconnecting (backoff up to 8s)…");
      }
      const delay = Math.min(${BACKOFF_BASE_MS} * Math.pow(2, retry), ${BACKOFF_MAX_MS});
      retry++;
      reconnectTimer = setTimeout(connectUDS, delay);
    });
  }
  connectUDS();

  ipcMain.on('__aio:print', () => {
    if (!win.isDestroyed()) win.webContents.print({ silent: false, printBackground: true });
  });

  // open a link in the system browser. Allowlist http/https ONLY —
  // a compromised renderer must not reach file:/ or custom shell handlers.
  ipcMain.on('__aio:openExternal', (_event, url) => {
    try {
      const u = new URL(String(url));
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        require('electron').shell.openExternal(u.href);
      }
    } catch { /* malformed url — ignore */ }
  });

  // Child windows (openWindow): an http/https page in a CHILD BrowserWindow
  // with an app-supplied preload. Guardrails (maintainer decision):
  //   • gated: only when aio.run({ childWindows: true }) — off by default;
  //   • http/https only;
  //   • the preload must resolve INSIDE the app dir, and its REALPATH must
  //     too (a symlink escaping the dir is rejected);
  //   • Chromium sandbox stays ON unless the caller EXPLICITLY passes
  //     sandbox:false (needed only for page-world injection past strict CSPs)
  //     — logged loudly per window either way.
  const CHILD_WINDOWS = ${JSON.stringify(!!opts.meta?.childWindows)};
  const dappWindows = new Set();
  ipcMain.on('__aio:openWindow', (_event, payload) => {
    try {
      if (!CHILD_WINDOWS) {
        console.warn('[aio:electron] openWindow denied — enable with aio.run({ childWindows: true })');
        return;
      }
      const { url, preload } = payload || {};
      const u = new URL(String(url));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
      const root = fs.realpathSync(BASE_DIR || process.cwd());
      const pfx = root.endsWith(path.sep) ? root: root + path.sep;
      const p = path.resolve(String(preload || ''));
      if (!p.startsWith(pfx) || !fs.existsSync(p)) return;
      // Symlink escape: judge the REAL file, not the link's address.
      if (!fs.realpathSync(p).startsWith(pfx)) return;
      const sandbox = payload.sandbox === false ? false: true;
      console.warn('[aio:electron] openWindow → ' + u.href + (sandbox ? '': ' (sandbox DISABLED by app request)'));
      const child = new BrowserWindow({
        width: 1100,
        height: 800,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox,
          preload: p,
        },
      });
      dappWindows.add(child);
      child.on('closed', () => dappWindows.delete(child));
      child.setMenuBarVisibility(false);
      child.loadURL(u.href);
    } catch { /* malformed request — ignore */ }
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
  const _appOrigin = USE_PROTOCOL ? 'aio://app': new URL(${
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
