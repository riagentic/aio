// Electron main.cjs generator — UDS (Unix Domain Socket) mode with IPC bridge
// Dev mode: page from HTTP, state via UDS+IPC
// Prod mode: page from disk via aio:// protocol, state via UDS+IPC

import { MIME } from "../server/server-html-constants.ts";
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  backoffDelay,
} from "../protocol/transport-shared.ts";
import {
  type AioMeta,
  type ShellConfig,
  tmplBounds,
  tmplBoundsTracking,
  tmplCrashGuard,
  tmplKeyboardShortcuts,
  tmplParentWatch,
  tmplRendererDiagnostics,
  tmplWillNavigate,
  tmplWindowShape,
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
  /** The app's DEFAULT icon as base64 PNG — used when the app ships no
   *  `icon.png`. Passed in (rather than generated here) so `electron/` keeps
   *  its narrow import surface; the server owns the app's identity anyway. */
  defaultIcon?: string;
  meta?: AioMeta;
  /** `<head>` inputs for the templated aio:// shell — without them the
   *  packaged app renders a different `<head>` than dev does. */
  shell?: ShellConfig;
  /** The app's HTTP handler, on a Unix socket, because this app binds no TCP
   *  port (electron + UDS). The window then serves `aio://` by proxying to it
   *  — same handler, same HTML, same transpiled modules as `http://` would
   *  have delivered, minus the port. Dev: everything goes through it. Prod
   *  (page from dist/): only what dist/ does not hold — the app's custom
   *  `routes` and /__aio/* — falls through to it, streamed. */
  httpSocketPath?: string;
  /** TEST WHAT YOU SHIP — `AIO_ELECTRON_PROTOCOL=1`. Load the window over
   *  `aio://app/` in dev too, proxying to the HTTP server instead of a socket
   *  or dist/. The packaged artifact is the ONLY thing that took the scheme
   *  path (a privileged custom scheme, the preload bridge as the sole
   *  transport, no `__aioConfig` in the shell, the `cfg` frame filling it), and
   *  `deno task dev` never did — so a renderer that died on that path died in
   *  the field first. With this, the shipped path runs on a developer's
   *  machine against the dev server. */
  forceProtocol?: boolean;
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
${tmplParentWatch()}

// ── Where the page comes from: disk (prod), the app's socket (dev, zero
//    port), or the HTTP server (everything else) ──
const BASE_DIR = ${JSON.stringify(opts.baseDir ?? "")};
const HTTP_SOCK = ${JSON.stringify(opts.httpSocketPath ?? "")};
// The HTTP server's URL — where a forced aio:// window (AIO_ELECTRON_PROTOCOL=1)
// proxies to when this app has no socket and no dist/. Same handler, same
// bytes, over TCP instead of a socket path.
const HTTP_URL = ${JSON.stringify(url)};
const FORCE_PROTOCOL = ${JSON.stringify(!!opts.forceProtocol)};
const FROM_DISK = !!(BASE_DIR && fs.existsSync(path.join(BASE_DIR, 'app.js')));
// Disk wins when a bundle is there: the page needs no server at all (the
// app's routes still fall through to HTTP_SOCK when it is set — see the
// handler). Otherwise the socket, when this app has one — that is the dev
// app that binds no port, and http:// would have nothing to answer it.
const FROM_SOCKET = !FROM_DISK && !!HTTP_SOCK;
// …or the developer asked for the shipped path explicitly: the page comes
// through the same aio:// handler, proxied to http://. Nothing else changes.
const FROM_HTTP = !FROM_DISK && !FROM_SOCKET && FORCE_PROTOCOL;
const USE_PROTOCOL = FROM_DISK || FROM_SOCKET || FROM_HTTP;
if (FROM_HTTP) {
  console.warn('[aio:electron] AIO_ELECTRON_PROTOCOL=1 — the window loads aio://app/ (the packaged path) proxied to ' + HTTP_URL);
}
// machine U11 — never silent: when a dist dir was given but its app.js is
// missing, the window silently falls back from disk (aio://) to HTTP. Say so.
if (BASE_DIR && !FROM_DISK) {
  console.warn('[aio:electron] baseDir set but ' + path.join(BASE_DIR, 'app.js') + ' not found — falling back to ' + (FROM_SOCKET ? 'the app socket' : 'the HTTP server') + ' (no on-disk bundle)');
}

// AIO-56: Register aio:// scheme as privileged BEFORE app.on('ready').
if (USE_PROTOCOL) {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'aio',
    // stream:true — a route response is handed to Chromium as it arrives.
    // Without it every aio:// body (a 100 MB image included) would be held in
    // main-process memory before the first byte reached the renderer.
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  }]);
}

// One request to the app's HTTP handler over its local socket — a Unix socket,
// or a named pipe (\\\\.\\pipe\\...) on Windows; Node's own http.request speaks
// both natively (the socketPath option, libuv underneath), so the page, its
// modules and every asset arrive through the SAME handler an http:// fetch
// would have reached — headers, status and bytes intact, nothing re-encoded.
//
// STREAMED, both ways. The Response wraps the Node response body as a web
// ReadableStream (Readable.toWeb), so the promise resolves on HEADERS and
// Chromium reads the body as the app writes it: a 100 MB route response is
// never buffered in this process, and an <img> starts decoding on the first
// chunk. A request body (POST/PUT) is piped in the same way.
function socketFetch(reqPath, method, headers, body) {
  return new Promise((resolve) => {
    const { Readable } = require('stream');
    // The socket when this app has one; otherwise the HTTP server (forced
    // aio:// in dev). A self-signed --expose cert is this app's own — the
    // http:// branch trusts it the way certificate-error does below.
    let target, http;
    if (HTTP_SOCK) { http = require('http'); target = { socketPath: HTTP_SOCK }; }
    else {
      const u = new URL(HTTP_URL);
      http = require(u.protocol === 'https:' ? 'https' : 'http');
      target = { host: u.hostname, port: u.port, rejectUnauthorized: false };
    }
    const r = http.request(
      { ...target, path: reqPath, method: method || 'GET', headers: headers || {} },
      (res) => {
        const h = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') h[k] = v;
          else if (Array.isArray(v)) h[k] = v.join(', ');
        }
        const status = res.statusCode || 200;
        // A body-less status must not carry a stream — Response() throws.
        const noBody = status === 204 || status === 304 || (method || 'GET') === 'HEAD';
        if (noBody) res.resume();
        resolve(new Response(noBody ? null : Readable.toWeb(res), { status, headers: h }));
      },
    );
    // A dead socket must not hang the window forever on a blank page. Say what
    // failed, in the window, where the developer is already looking.
    r.on('error', (e) => resolve(new Response(
      'aio: cannot reach the app over its ' + (HTTP_SOCK ? 'socket (' + HTTP_SOCK + ')' : 'HTTP server (' + HTTP_URL + ')') + ': ' + e.message,
      { status: 502, headers: { 'Content-Type': 'text/plain' } },
    )));
    if (body && typeof body.getReader === 'function') Readable.fromWeb(body).pipe(r);
    else { if (body) r.write(body); r.end(); }
  });
}

// THE server's table, not a copy of it. A hand-kept subset here served every
// font, .webp, .mp4 and .pdf in dist/ as application/octet-stream in the
// packaged app while dev (which goes through the server) served them
// correctly — a silent dev/prod divergence with nothing gating the pair.
// tests/electron-uds-mime.test.ts pins the generated table to this import.
const MIME = ${JSON.stringify(MIME)};

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
      // Proxy EVERYTHING to the app's handler, path and query intact. No
      // special cases here on purpose: the dev page, its on-demand transpiled
      // modules, /__aio/* and the app's own routes are one surface, and a
      // second copy of the routing table in the window is how the two come to
      // disagree about what the app serves.
      const viaSocket = () => {
        const hdrs = {};
        req.headers.forEach((v, k) => { hdrs[k] = v; });
        const body = (req.method === 'GET' || req.method === 'HEAD') ? undefined : req.body;
        return socketFetch(url.pathname + url.search, req.method, hdrs, body);
      };
      if (FROM_SOCKET || FROM_HTTP) return await viaSocket();
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { pathname = url.pathname; }
      if (pathname === '/' || pathname === '') {
        return new Response(PROD_HTML, { headers: { 'Content-Type': 'text/html' } });
      }
      // The shell's favicon URL is one string on every target (server, dev,
      // packaged). Here there is no server behind it, so map it onto the icon
      // the build wrote next to the bundle — a 404 favicon in the packaged app
      // would be the classic "works in dev" divergence.
      if (pathname === '/__aio/icon') {
        for (const [f, t] of [['icon.png', 'image/png'], ['icon.svg', 'image/svg+xml']]) {
          try {
            const data = await require('fs/promises').readFile(path.join(BASE_DIR, f));
            return new Response(data, { headers: { 'Content-Type': t } });
          } catch { /* next candidate */ }
        }
        return new Response('Not Found', { status: 404 });
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
        // Not a file in dist/. When this app has an HTTP handler on a socket,
        // that is where the rest of the app lives — its custom routes
        // (<img src="/nft-image/x"> resolves to aio://app/nft-image/x on this
        // origin) and /__aio/*. Proxied unchanged, streamed. Without a socket
        // there is nothing behind this path: 404, as before.
        if (HTTP_SOCK || FROM_HTTP) return await viaSocket();
        return new Response('Not Found', { status: 404 });
      }
    });
  }

  const b = loadBounds(${w}, ${h});
${tmplWindowShape(opts.meta, { preload: "preloadFile" })}
  const win = new BrowserWindow(b);
  if (b.x == null) win.center();

  try {
    const { nativeImage } = require('electron');
    const iconPath = BASE_DIR
      ? path.join(BASE_DIR, 'icon.png')
      : path.join(${
    JSON.stringify(opts.iconDir ?? "")
  } || path.join(process.cwd(), 'src'), 'icon.png');
    // The app's own icon.png wins; otherwise the generated monogram, so an
    // app nobody has drawn an icon for is still tellable apart in a taskbar
    // from the other three aio apps running beside it.
    const b64 = fs.existsSync(iconPath)
      ? fs.readFileSync(iconPath).toString('base64')
      : ${JSON.stringify(opts.defaultIcon ?? "")};
    if (b64) {
      win.setIcon(nativeImage.createFromDataURL('data:image/png;base64,' + b64));
    }
  } catch {}

${tmplBoundsTracking()}
${tmplRendererDiagnostics(true)}

  // ── UDS connection — NDJSON over Unix socket ──
  //
  // The reconnect curve is EMITTED FROM THE AUTHORITY, not retyped here. This
  // file used to import BACKOFF_BASE_MS/BACKOFF_MAX_MS from
  // protocol/transport-shared.ts and then re-implement the formula inline —
  // and the copy had already drifted: it dropped the ±20% jitter term, so the
  // Electron client was the one client in the framework that reconnected on a
  // bare exponential curve. Emitting the function's own source means a change
  // to the shared curve reaches this generated script by construction, and a
  // copy that cannot drift is worth more than a copy that is correct today.
  const BACKOFF_BASE_MS = ${BACKOFF_BASE_MS}, BACKOFF_MAX_MS = ${BACKOFF_MAX_MS};
  const backoffDelay = ${backoffDelay.toString()};
  const SOCK = ${JSON.stringify(socketPath)};
  let buf = '', retry = 0, lastFullState = null;
  // The connection's \`proto\` hello and \`cfg\` frame, cached like the snapshot.
  // The server writes both ONCE, at accept (uds.ts) — and this socket belongs
  // to the main process, so it outlives every document the window shows. A
  // reload (Ctrl+R, Ctrl+Shift+Del, the app's own location.reload()) never
  // reaches the server as a new connection, and the re-seed below used to
  // hand the fresh document the last snapshot and nothing else. On the
  // packaged aio:// shell \`cfg\` is the ONLY carrier of syncCells (localFirst
  // adoption), callTimeouts and renderBudget — udsProdHTML embeds none of
  // them — so one Ctrl+R silently turned every localFirst cell back into a
  // round-trip and every awaited call onto the default ceiling. Dev never
  // showed it: its shell embeds the same keys.
  let lastProto = null, lastCfg = null;
  // ONE decider for "the renderer can receive frames": its own __aio:ready
  // signal. Readiness used to be decided TWICE — did-finish-load gated every
  // relayed frame while __aio:ready gated a replay that carried only the last
  // full-state frame — so everything that landed in the gap (the accept-time
  // "proto" hello, the "cfg" frame that is sent EXACTLY ONCE and is the only
  // way a build-time-templated shell learns its config, "tt-state", and every
  // "patches" delta during a reload) was dropped forever. The socket connects
  // long before a page finishes loading, so that gap was the normal path.
  let rendererReady = false;
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

  // Frames the renderer has not received yet, in order. Nothing is ever
  // relayed straight past this queue — one path in, one path out, so a frame
  // cannot overtake an older one that is still waiting.
  const _pending = [], PENDING_MAX = 500;
  // When readiness was cleared, and whether the stall has been reported. A
  // relay that stops delivering is INVISIBLE by construction: the socket is
  // open, the uplink works, connected stays true, and the only symptom is a
  // screen that does not change. The old queue said nothing until it had
  // dropped 500 frames — which for a quiet app is never. Fail loud instead:
  // one line naming the stall, and the window is told too, so a dev sees it in
  // the app rather than in a terminal they are not reading. (cc §5.1.)
  let _notReadySince = 0, _stallReported = false;
  // A stall needs a VICTIM: a document that was alive and listening when the
  // gate closed, and that nothing has replaced since. Without this the
  // detector fired on the FIRST load — the gate closes on loadURL's own
  // navigation, no document has ever signalled ready, a busy app's frames
  // arrive for 5 s while a large bundle parses — and reported "down" to
  // /__aio/health and sent the dropped-socket signal to a page that had not
  // registered a listener yet, then "up" when the page simply arrived. An
  // instrument saying "down" for a client that is provably loading is a
  // false reading, not noise. A reload is the same case once its navigation
  // COMMITS (did-navigate): the old document is gone and the new one will
  // announce itself, or did-fail-load restores the old one — neither is a
  // stall. The stall is the gap in between: gate closed on a ready document,
  // no commit, no veto, no failure — cc §5.1's frozen page.
  let _stallCandidate = false, _slowLoadNoted = false;
  const STALL_MS = 5000;
  function _queue(k, line) {
    // A full snapshot supersedes every state/patches frame queued before it —
    // that keeps the state stream O(1) here without dropping anything else.
    if (k === 'state') {
      for (let i = _pending.length - 1; i >= 0; i--) {
        const pk = _pending[i].k;
        if (pk === 'state' || pk === 'patches') _pending.splice(i, 1);
      }
    }
    _pending.push({ k: k, line: line });
    const gatedMs = (!rendererReady && _notReadySince)
      ? Date.now() - _notReadySince
      : 0;
    if (gatedMs > STALL_MS && !_stallCandidate && !_slowLoadNoted) {
      // A slow load, said once, as what it is — observe-only, no signal to
      // the window, nothing to the server: the mount watchdog
      // (tmplRendererDiagnostics) is the instrument for a page that never
      // arrives at all.
      _slowLoadNoted = true;
      _rlog('info', 'the document is still loading after ' +
        Math.round(gatedMs / 1000) + 's — ' + _pending.length +
        ' frame(s) wait for it to signal ready (a large bundle or a slow ' +
        'disk is the usual cause; not a relay stall: no document was ' +
        'listening when this load began)');
    }
    if (gatedMs > STALL_MS && _stallCandidate && !_stallReported) {
      _stallReported = true;
      const why = 'the renderer has not signalled ready for ' +
        Math.round((Date.now() - _notReadySince) / 1000) + 's and ' +
        _pending.length + ' frame(s) are undelivered — the window is CONNECTED ' +
        'but receiving nothing. A new document sends __aio:ready; a navigation ' +
        'that never loaded one leaves the relay stalled here.';
      console.warn('[aio:electron] ' + why);
      // Said where it can be SEEN, not only in a terminal nobody is reading:
      // the window gets the same signal a dropped socket gives it, so its
      // connection banner shows instead of a frozen page that claims to be
      // connected (cc §5.3, ask 2) — and the server hears it as a client
      // degradation, so /__aio/health and am status stop saying "healthy"
      // (ask 3). Reopened by whatever restores the relay: the new document's
      // __aio:ready, did-fail-load, or a vetoed navigation.
      if (!closing && !win.isDestroyed()) win.webContents.send('__aio:close');
      _relayHealth('down', why);
    }
    if (_pending.length > PENDING_MAX) {
      const lost = _pending.splice(0, _pending.length - PENDING_MAX);
      console.warn('[aio:electron] renderer has not signalled ready — dropped ' +
        lost.length + ' undelivered frame(s) (queue limit ' + PENDING_MAX + ')');
    }
  }
  function _pump() {
    if (!rendererReady || closing || win.isDestroyed()) return;
    while (_pending.length > 0) win.webContents.send('__aio:msg', _pending.shift().line);
  }
  // THE NAVIGATION CONTRACT — from measurement, not from the docs.
  //
  // What real Electron (44) emits, in order, and the shape of each:
  //
  //   a vetoed in-app <a> click:   did-start-navigation {sameDoc:false}
  //                                will-navigate {vetoed}
  //                                did-stop-loading            — nothing else
  //   history.pushState / a hash:  did-start-navigation {sameDoc:TRUE}
  //                                did-navigate-in-page
  //   location.reload():           did-start-navigation {sameDoc:false}
  //                                will-navigate  (with the CURRENT url)
  //                                did-navigate … dom-ready … did-finish-load
  //   an allowed navigation:       did-start-navigation {sameDoc:false}
  //                                will-navigate  did-navigate … did-finish-load
  //
  // Two facts in there decide everything below. did-start-navigation fires
  // BEFORE will-navigate, as a cross-document navigation, even when the veto
  // is about to happen — so at that moment the shell cannot know whether a
  // new document is coming. And a vetoed navigation emits NO did-fail-load,
  // so nothing after the veto will ever reopen what was closed.
  //
  // That is the whole of field report cc §5.1/§5.2/§5.3: clearing readiness
  // here on every cross-document navigation closed the relay on every link
  // click, the veto kept the old document, and the relay stayed closed for its
  // life — frames queued, none delivered, uplink fine, screen frozen,
  // connected still true. A first fix guarded on isSameDocument and passed
  // a stub that had guessed the order; real Electron does not emit that flag
  // on the event that matters. So:
  //
  //   • did-start-navigation only GATES (readiness off, nothing destroyed);
  //   • will-navigate's in-app veto REOPENS it (_onInAppNavVetoed) — the
  //     veto is the one moment the shell knows the document is staying, and
  //     it always runs after the gate closed;
  //   • did-navigate — the new document's COMMIT, which a vetoed navigation
  //     never reaches — does the destructive half: drop queued deltas (they
  //     assume a base the new document does not have) and seed the snapshot.
  //
  // Same-document navigations (pushState, hash) are skipped outright: the
  // document, and its listeners, are not going anywhere. <webview> guests fire
  // this on the embedder's webContents with isMainFrame false and are skipped
  // for the same reason. Both signatures handled: modern (details object) and
  // legacy positional (event, url, isInPlace, isMainFrame).
  win.webContents.on('did-start-navigation', (e, _url, _inPlace, isMainFrame) => {
    const main = (e && typeof e.isMainFrame === 'boolean') ? e.isMainFrame: isMainFrame;
    if (main === false) return;
    const sameDoc = (e && typeof e.isSameDocument === 'boolean')
      ? e.isSameDocument
      : _inPlace;
    if (sameDoc === true) return;
    _stallCandidate = rendererReady; // only a listening document can be stalled
    _slowLoadNoted = false;
    rendererReady = false;
    _notReadySince = Date.now();
  });
  // The document REALLY changed. Only now is a queued DELTA meaningless — it
  // assumes a base state the new document does not have — so the queued
  // state stream is replaced with the latest snapshot. Connection-scoped
  // frames (proto/cfg/…) still apply and stay. (Doing this at
  // did-start-navigation destroyed the queue of a document that then turned
  // out to be staying.)
  win.webContents.on('did-navigate', () => {
    // The old document is gone; the new one announces itself when it is
    // ready. Waiting for that is a load, not a stall.
    _stallCandidate = false;
    for (let i = _pending.length - 1; i >= 0; i--) {
      const pk = _pending[i].k;
      if (pk === 'state' || pk === 'patches') _pending.splice(i, 1);
    }
    if (lastFullState) _pending.push({ k: 'state', line: lastFullState });
    // …and the connection-scoped frames it never saw, FIRST, in accept order
    // (proto, cfg, then the snapshot) — unless one of that kind is still in
    // the queue, in which case the queued one is newer or the same and is
    // delivered once, not twice.
    const queued = new Set(_pending.map((p) => p.k));
    if (lastCfg && !queued.has('cfg')) _pending.unshift({ k: 'cfg', line: lastCfg });
    if (lastProto && !queued.has('proto')) _pending.unshift({ k: 'proto', line: lastProto });
  });
  // will-navigate vetoed an in-app navigation (tmplWillNavigate calls this):
  // the document stays, so everything queued for it is still valid — reopen
  // the relay and deliver. Idempotent: a veto that arrives with the relay
  // already open (an older Electron that orders the events differently) is a
  // no-op, never a double pump.
  function _onInAppNavVetoed(navUrl) {
    if (rendererReady) return;
    rendererReady = true;
    _notReadySince = 0;
    if (_stallReported) {
      _stallReported = false;
      _relayHealth('up', 'the relay reopened on the vetoed navigation to ' + navUrl);
    }
    _pump();
  }
  // The relay's health, as the SERVER sees it. A renderer that receives
  // nothing is invisible from the server side by construction — the socket it
  // reads is this process's, and this process is reading it fine — so the
  // shell reports on its behalf through the same cdiag frame a browser's
  // own degraded() escalation travels on. It lands in /__aio/health as
  // clientDegraded, which is what am status and am health read: the
  // field report's "connected for minutes, received nothing, and every
  // instrument said fine" (cc §5.3, ask 3).
  function _relayHealth(kind, lastError) {
    if (!sock || sock.destroyed) return;
    try {
      sock.write(JSON.stringify({ v: 2, t: 'cdiag', d: {
        name: 'electron:relay', kind: kind, failures: kind === 'down' ? 1 : 0,
        since: _notReadySince || Date.now(), lastError: lastError,
      } }) + '\\n');
    } catch (e) { console.warn('[aio:electron] could not report relay health: ' + e); }
  }

  // A main-frame navigation that FAILS leaves the old document in place — and
  // that document already signalled ready once; it will not do so again. Give
  // it its relay back, or every later frame (state, ui-surface requests, the
  // next reload) waits on a ready that never comes: the window shows a live
  // page that has quietly stopped answering. -3 is net::ERR_ABORTED (a vetoed
  // or superseded navigation); any other code is a real load failure, said so.
  win.webContents.on('did-fail-load', (e, code, desc, failedUrl, isMainFrame) => {
    if (isMainFrame === false || rendererReady) return;
    rendererReady = true;
    _notReadySince = 0;
    if (_stallReported) {
      _stallReported = false;
      _relayHealth('up', 'the failed navigation left the old document in place');
    }
    _pump();
    console.warn('[aio:electron] navigation to ' + failedUrl + ' failed (' + code + ' ' + desc +
      ') — the previous document stays and keeps its bridge');
  });

  ipcMain.on('__aio:ready', () => {
    if (closing) return;
    rendererReady = true;
    _notReadySince = 0;
    if (_stallReported) {
      _stallReported = false;
      _relayHealth('up', 'a document signalled ready');
    }
    if (sock) {
      win.webContents.send('__aio:open');
      _pump();
      sock.write('{"v":2,"t":"subs","d":{"subs":["*"]}}\\n');
    } else {
      // No backend right now. Saying nothing left the renderer to its own 10s
      // watchdog — a window that looks connected and is not.
      win.webContents.send('__aio:close');
    }
  });

  function connectUDS() {
    // A connection that died mid-frame leaves half a line here. Carrying it
    // into the NEXT connection glued it onto that connection's first frame —
    // the "proto" hello — so a crash-mid-write silently destroyed the version
    // gate and handed the renderer one undecodable line. The buffer is
    // per-connection; reset it with the connection.
    buf = '';
    sock = connect(SOCK);
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      if (down) { console.info("[aio:electron] backend connection restored (" + SOCK + ")"); down = false; }
      retry = 0; lastErrCode = null; lastFullState = null;
      lastProto = null; lastCfg = null; // a new connection speaks its own hello
      while (_ipcQueue.length > 0 && sock && !sock.destroyed) sock.write(_ipcQueue.shift() + '\\n');
      if (!closing && rendererReady) { win.webContents.send('__aio:open'); _pump(); }
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
        if (kind === 'state') lastFullState = line;
        else if (kind === 'proto') lastProto = line;
        else if (kind === 'cfg') lastCfg = line;
        _queue(kind, line);
      }
      _pump();
    });
    // Capture the reason only — an 'error' is always followed by 'close', which
    // reports the outage ONCE with the true cause. Prevents a Node stack-trace
    // flood every retry (the "connection working, or visibly obvious why not"
    // rule): a persistent outage should say what's wrong once, then stay quiet.
    sock.on('error', (err) => { lastErrCode = (err && (err.code || err.message)) || 'error'; });
    sock.on('close', () => {
      sock = null;
      if (closing) return;
      if (rendererReady) win.webContents.send('__aio:close');
      if (!down) {
        down = true;
        const why = (lastErrCode === 'ECONNREFUSED' || lastErrCode === 'ENOENT')
          ? "backend not reachable — is the aio server running?"
          : ("backend connection lost" + (lastErrCode ? " (" + lastErrCode + ")": ""));
        console.warn("[aio:electron] " + why + " at " + SOCK + " — reconnecting (backoff up to 8s)…");
      }
      const delay = backoffDelay(retry);
      retry++;
      reconnectTimer = setTimeout(connectUDS, delay);
    });
  }
  connectUDS();

  // Window controls for a frameless window (ui.chrome). One channel, one
  // switch: a renderer can ask for exactly these three verbs and nothing else.
  ipcMain.on('__aio:win', (_event, verb) => {
    if (win.isDestroyed()) return;
    if (verb === 'minimize') win.minimize();
    else if (verb === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
    else if (verb === 'close') win.close();
  });

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
          if (rendererReady && !win.isDestroyed()) win.webContents.send('__aio:close');
        }
      });
    } else if (_ipcQueue.length < IPC_QUEUE_MAX) {
      _ipcQueue.push(json);
    }
  });

${tmplKeyboardShortcuts()}

  if (!USE_PROTOCOL) {
    // Reads the URL that FAILED (arg 3), compared to this app's own origin —
    // see the twin in electron-scripts.ts. Checking the app's own URL instead
    // made this a constant true, trusting every bad cert from every host.
    app.on('certificate-error', (event, _wc, failedUrl, _err, _cert, cb) => {
      let sameOrigin = false;
      try { sameOrigin = new URL(failedUrl).origin === new URL(${
    JSON.stringify(url)
  }).origin; } catch { sameOrigin = false; }
      if (sameOrigin) { event.preventDefault(); cb(true); }
      else cb(false);
    });
  }

  // AIO-73: aio:/// (no host) fails — use aio://app/ (with host component)
  win.loadURL(USE_PROTOCOL ? 'aio://app/': ${JSON.stringify(url)});
  // protocol//host on both branches — see tmplWillNavigate for why not .origin.
  const _appOrigin = USE_PROTOCOL ? 'aio://app': (u => u.protocol + '//' + u.host)(new URL(${
    JSON.stringify(url)
  }));
${tmplWillNavigate("_appOrigin", "_onInAppNavVetoed")}
});

app.on('window-all-closed', () => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (sock) sock.destroy();
  try { fs.unlinkSync(preloadFile); } catch {}
  process.exit(0);
});
`.trim();
}
