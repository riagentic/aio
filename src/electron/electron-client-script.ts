// Electron main.cjs generator — self-contained client with connect page

import { CONNECT_HTML, tmplBounds, tmplCrashGuard } from "./electron-shared.ts";

/** Generates a self-contained Electron main.cjs with a connect page for aio-client */
export function electronClientScript(bakedUrl?: string | null): string {
  // The address the BUILD already knew. Without it a shipped client opens a box
  // asking the user to type a server they were never told — the build recorded
  // `build.server`, printed it, refused the build without it, and then dropped
  // it on the floor. It is a DEFAULT, not a lock: an explicit --server-url or an
  // imported profile still wins, and --connect always reaches the picker.
  const baked = bakedUrl ? JSON.stringify(bakedUrl) : "null";
  return `
const __AIO_BAKED_URL = ${baked};
const { app, BrowserWindow, Menu, nativeImage } = require('electron');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');

Menu.setApplicationMenu(null);
app.name = 'aio-client';
${tmplCrashGuard()}

// ── Window state persistence ──
${tmplBounds()}

let _boundsTracked = false; // AIO-234: prevent listener accumulation
function trackBounds(win) {
  if (_boundsTracked) return;
  _boundsTracked = true;
  let t;
  const save = () => { clearTimeout(t); t = setTimeout(() => saveBounds(win), 500); };
  win.on('resize', save);
  win.on('move', save);
  win.on('close', () => saveBounds(win));
}

// ── Helpers ──

function fetchPage(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https: http;
    // aio --expose serves a self-signed cert; a dedicated aio client trusts
    // it (a generic browser can't — that's the point of this client).
    const req = mod.get(url, { timeout: 8000, rejectUnauthorized: false }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 400) {
        res.resume();
        return reject(new Error('Server returned ' + res.statusCode));
      }
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

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https: http;
    const payload = Buffer.from(JSON.stringify(body));
    const req = mod.request(url, {
      method: 'POST', timeout: 8000, rejectUnauthorized: false,
      headers: { 'content-type': 'application/json', 'content-length': payload.length },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => { let j = null; try { j = JSON.parse(data); } catch {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(payload); req.end();
  });
}

function fetchBuffer(url, maxBytes = 1048576) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https: http;
    const req = mod.get(url, { timeout: 5000, rejectUnauthorized: false }, (res) => {
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

// ── LAN discovery (Node dgram — the aio server answers UDP broadcasts) ──
const dgram = require('dgram');
const DISCOVERY_PORT = Number(process.env.AIO_DISCOVERY_PORT) || 8099;

function discoverApps(timeoutMs, cb) {
  let sock;
  const found = new Map();
  try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); }
  catch (e) { return cb([]); }
  sock.on('message', (msg, rinfo) => {
    const text = msg.toString('utf8');
    if (!text.startsWith('AIO1 ')) return;
    let ad; try { ad = JSON.parse(text.slice(5)); } catch { return; }
    if (typeof ad.name !== 'string' || typeof ad.port !== 'number') return;
    const host = rinfo.address;
    const key = host + ':' + ad.port;
    if (found.has(key)) return;
    ad.host = host;
    ad.url = (ad.tls ? 'https': 'http') + '://' + host + ':' + ad.port;
    found.set(key, ad);
  });
  sock.on('error', () => { try { sock.close(); } catch {} cb([]); });
  sock.bind(() => {
    try { sock.setBroadcast(true); } catch {}
    const probe = Buffer.from('AIO_DISCOVER? v1');
    try { sock.send(probe, DISCOVERY_PORT, '255.255.255.255'); } catch {}
    setTimeout(() => {
      try { sock.close(); } catch {}
      cb([...found.values()].sort((a, b) => a.name.localeCompare(b.name)));
    }, timeoutMs);
  });
}

// ── Recents (persisted in userData — data: URLs can't keep localStorage) ──
function recentsPath() { return path.join(app.getPath('userData'), 'recents.json'); }
function loadRecents() {
  try { return JSON.parse(fs.readFileSync(recentsPath(), 'utf8')); } catch { return []; }
}
function saveRecent(entry) {
  try {
    let list = loadRecents().filter((r) => r.url !== entry.url);
    list.unshift(entry);
    list = list.slice(0, 8);
    // 0600: each entry carries the paired app key (and a ?token= URL) — the
    // same forever credential the server keeps owner-only. userData is 0755,
    // so the directory does not protect it.
    fs.writeFileSync(recentsPath(), JSON.stringify(list), { mode: 0o600 });
    try { fs.chmodSync(recentsPath(), 0o600); } catch {}
    return list;
  } catch { return loadRecents(); }
}
function forgetRecent(url) {
  try {
    const list = loadRecents().filter((r) => r.url !== url);
    fs.writeFileSync(recentsPath(), JSON.stringify(list), { mode: 0o600 });
    try { fs.chmodSync(recentsPath(), 0o600); } catch {}
    return list;
  } catch { return loadRecents(); }
}

// ── App profiles (.aioapp — "one file, use forever") ──
// A profile carries the cert to PIN and the auth key. Import once; the client
// connects forever. Stored alongside recents (in the recent's cert+key).
const _pinnedCerts = new Map(); // host -> cert PEM (strict pinning)
function normPem(p) { return String(p || '').replace(/\\s+/g, ''); }
function pinCert(host, cert) { if (host && cert) _pinnedCerts.set(host, normPem(cert)); }

// Turn a .aioapp profile into a connectable recent entry.
function profileToRecent(pr) {
  const scheme = pr.tls ? 'https': 'http';
  const host = pr.host; // discovery could refresh this later by name
  const base = scheme + '://' + host + ':' + pr.port;
  const url = pr.key ? base + '/?token=' + encodeURIComponent(pr.key): base + '/';
  return {
    url,
    name: pr.name,
    title: pr.title,
    host,
    port: pr.port,
    tls: !!pr.tls,
    needsAuth: !!pr.key,
    cert: pr.cert || null,
    key: pr.key || null,
  };
}

function loadProfileFile(file) {
  try {
    const pr = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!pr || pr.aio !== 1 || typeof pr.port !== 'number') return null;
    // Defense-in-depth: a .aioapp is an untrusted file the user may open. The
    // host builds a URL and is rendered into the connect page — reject anything
    // that isn't a plain hostname / IPv4 / bracketed-IPv6 so it can't smuggle
    // markup or a credential-bearing authority. (esc() also escapes quotes.)
    if (pr.host != null && !/^[A-Za-z0-9.:_\\-\\[\\]]+$/.test(String(pr.host))) {
      return null;
    }
    if (!Number.isInteger(pr.port) || pr.port < 1 || pr.port > 65535) return null;
    return pr;
  } catch { return null; }
}

// PIN pairing — submit the code the app shows on startup; the server returns
// the full profile (cert + key) so we pin + save + connect forever after.
async function pairWith(win, info) {
  const scheme = info.tls ? 'https': 'http';
  const base = scheme + '://' + info.host + ':' + info.port;
  const showErr = (m) => win.webContents.executeJavaScript(
    "document.getElementById('err') && (document.getElementById('err').textContent = " + JSON.stringify(m) + ")"
  ).catch(() => {});
  try {
    const res = await postJson(base + '/__aio/pair', { pin: info.pin });
    if (res.status !== 200 || !res.json || !res.json.key) {
      throw new Error(res.status === 401 ? 'Invalid or expired pairing code': 'Pairing failed (HTTP ' + res.status + ')');
    }
    const pr = res.json;
    pr.host = info.host; // the server doesn't know its own LAN address — we do
    const rec = profileToRecent(pr);
    pinCert(rec.host, rec.cert);
    saveRecent(rec);
    connectTo(win, rec.url);
  } catch (e) {
    showErr('Pairing failed: ' + (e && e.message ? e.message: String(e)));
  }
}

// Is this actually an aio app? (guards against navigating to arbitrary sites)
function looksLikeAio(html) {
  return html.includes('/__aio/') || html.includes('aio/jsx-runtime') ||
    html.includes('id="root"') || /aio:(width|height|title)/.test(html);
}

async function connectTo(win, url) {
  try {
    let html;
    try {
      html = await fetchPage(url);
    } catch (fe) {
      // Auth-required aio app (--expose with a token) returns 401/403. Guide
      // the user to append the token from the server's "share:" line.
      const m = /Server returned (401|403)/.exec(fe.message || '');
      if (m && !/[?&]token=/.test(url)) {
        throw new Error('This app requires a token. Add it to the address:  ' + url + (url.includes('?') ? '&': '?') + 'token=YOUR_TOKEN   (copy it from the server\\'s "share:" line)');
      }
      throw fe;
    }
    if (!looksLikeAio(html)) {
      throw new Error("This doesn't look like an aio app (no aio markers on the page). Check the address, or that the server is running with --expose.");
    }
    const meta = parseMeta(html);
    try {
      // Preserve a pinned cert/key from a prior profile import for this URL.
      const prev = loadRecents().find((r) => r.url === url) || {};
      saveRecent({ url, name: meta.title || new URL(url).host, title: meta.title, host: new URL(url).hostname, port: Number(new URL(url).port) || (url.startsWith('https') ? 443: 80), tls: url.startsWith('https'), needsAuth: /[?&]token=/.test(url), cert: prev.cert || null, key: prev.key || null });
    } catch {}

    const iconUrl = url.replace(/\\/$/, '') + '/icon.png';
    const iconBuf = await fetchBuffer(iconUrl);
    if (iconBuf && iconBuf.length > 0) {
      try { win.setIcon(nativeImage.createFromBuffer(iconBuf)); } catch {}
    }

    const dw = meta.width || 800;
    const dh = meta.height || 600;
    const b = loadBounds(dw, dh);
    win.setResizable(true);
    win.setSize(b.width, b.height);
    if (b.x != null && b.y != null) win.setPosition(b.x, b.y);
    else win.center();
    if (meta.title) win.setTitle(meta.title.replace(/[\\x00-\\x1f\\x7f]/g, ''));

    trackBounds(win);
    // We've fetched + validated this as an aio app — trust its (self-signed)
    // cert so Chromium will actually load the HTTPS page.
    try { _trustedHosts.add(new URL(url).host); } catch {}
    win.loadURL(url);
  } catch (e) {
    const msg = e.message || String(e);
    win.webContents.executeJavaScript(
      "document.getElementById('err').textContent = " + JSON.stringify(msg)
    );
  }
}

// ── Connect page HTML ──

const CONNECT_HTML = \`${CONNECT_HTML}\`;

// ── Main ──

// aio --expose serves a self-signed TLS cert. Chromium rejects it with
// "unable to verify the first certificate". A dedicated aio client trusts
// self-signed certs for the host it was told to connect to — but ONLY for
// aio apps we've validated (see _trustedHosts), not the whole internet.
const _trustedHosts = new Set();
app.on('certificate-error', (event, _webContents, url, _error, cert, callback) => {
  try {
    const host = new URL(url).host;
    // Strict pinning: a profile gave us the exact cert for this host.
    const pinned = _pinnedCerts.get(host);
    if (pinned && cert && normPem(cert.data) === pinned) {
      event.preventDefault(); callback(true); return;
    }
    // Fallback: a host we fetched + validated as an aio app (manual connects
    // without a profile). Looser than pinning, but the user chose the address.
    if (_trustedHosts.has(host)) { event.preventDefault(); callback(true); return; }
  } catch {}
  callback(false);
});

app.on('ready', () => {
  // Pre-pin certs from stored recents/profiles so click-to-reconnect trusts
  // them without a fresh fetch.
  try {
    for (const r of loadRecents()) if (r.host && r.cert) pinCert(r.host, r.cert);
  } catch {}

  let directUrl = null;
  let profileFile = null;
  for (const arg of process.argv) {
    if (arg.startsWith('--server-url=')) directUrl = arg.slice(13);
    else if (arg.startsWith('--profile=')) profileFile = arg.slice(10);
    // A bare .aioapp path (file association / double-click) is a profile too.
    else if (arg.endsWith('.aioapp')) profileFile = arg;
  }

  const win = new BrowserWindow({
    width: 480, height: 300,
    resizable: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  // Imported profile → pin its cert, remember it, connect straight in.
  if (profileFile) {
    const pr = loadProfileFile(profileFile);
    if (!pr) { console.error('invalid .aioapp profile: ' + profileFile); process.exit(1); }
    const rec = profileToRecent(pr);
    pinCert(rec.host, rec.cert);
    saveRecent(rec);
    connectTo(win, rec.url);
    return;
  }

  if (directUrl) {
    if (!directUrl.startsWith('http://') && !directUrl.startsWith('https://')) {
      console.error('--server-url must use http:// or https:// scheme');
      process.exit(1);
    }
    connectTo(win, directUrl);
    return;
  }

  // The address baked in at build time (deno.json build.server). Last in
  // precedence behind an explicit flag and an imported profile — both of which
  // are someone choosing THIS run — and skipped entirely by --connect, so the
  // picker is always one flag away when the baked server has moved.
  if (__AIO_BAKED_URL && !process.argv.includes('--connect')) {
    connectTo(win, __AIO_BAKED_URL);
    return;
  }

  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(CONNECT_HTML));

  let scanTimer = null;
  function inject(js) {
    win.webContents.executeJavaScript(js).catch(() => {});
  }
  function scan() {
    discoverApps(1400, (apps) => {
      inject('window.__aioSetDiscovered && window.__aioSetDiscovered(' + JSON.stringify(apps) + ')');
      inject('window.__aioScanDone && window.__aioScanDone()');
    });
  }
  win.webContents.once('did-finish-load', () => {
    inject('window.__aioSetRecents && window.__aioSetRecents(' + JSON.stringify(loadRecents()) + ')');
    inject('window.__aioSetDiscovered && window.__aioSetDiscovered([])');
    scan();
    scanTimer = setInterval(scan, 4000); // keep the LAN list fresh
  });

  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    // Recents "forget" action from the page (aio-forget:<encoded-url>)
    if (url.startsWith('aio-forget:')) {
      const gone = decodeURIComponent(url.slice('aio-forget:'.length));
      const list = forgetRecent(gone);
      inject('window.__aioSetRecents && window.__aioSetRecents(' + JSON.stringify(list) + ')');
      return;
    }
    // PIN pairing request from the connect page (auth app clicked → code entered)
    if (url.startsWith('aio-pair:')) {
      let info = null;
      try { info = JSON.parse(decodeURIComponent(url.slice('aio-pair:'.length))); } catch {}
      if (info && info.host && info.port && info.pin) {
        if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
        pairWith(win, info);
      }
      return;
    }
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
    connectTo(win, url);
  });
});

app.on('window-all-closed', () => process.exit(0));
`.trim();
}
