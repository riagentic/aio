// Electron main.cjs generator — self-contained client with connect page

import {
  CONNECT_HTML,
  tmplAppMenu,
  tmplBounds,
  tmplCrashGuard,
  tmplIpcGuard,
  tmplPermissionGuard,
  tmplPreloadWrite,
  tmplShowWhenPainted,
  tmplWebGuard,
} from "./electron-shared.ts";

/** Generates a self-contained Electron main.cjs with a connect page for aio-client */
/** The client's `app.name` — the name of its profile directory. */
export const CLIENT_PROFILE = "aio-client";

export function electronClientScript(
  bakedUrl?: string | null,
  opts?: { strictPin?: boolean },
): string {
  // The address the BUILD already knew. Without it a shipped client opens a box
  // asking the user to type a server they were never told — the build recorded
  // `build.server`, printed it, refused the build without it, and then dropped
  // it on the floor. It is a DEFAULT, not a lock: an explicit --server-url or an
  // imported profile still wins, and --connect always reaches the picker.
  const baked = bakedUrl ? JSON.stringify(bakedUrl) : "null";
  return `
const __AIO_BAKED_URL = ${baked};
// The strict pin (opt-in: 'electron: { strictPin }' for a launched client,
// 'build: { strictPin }' for a packaged one, --strict-pin for one run): a
// pinned host presenting a certificate its pin does not cover is REFUSED —
// before the request line (and the token in it) is written, and before the
// page loads — and stays refused until it is paired again by PIN or a fresh
// .aioapp is imported. Off, the mismatch is warned about and the host is
// reached as before (see warnPinChanged).
const __AIO_STRICT_PIN = ${
    opts?.strictPin === true
  } || process.argv.includes('--strict-pin');
// One connection per request, so each one has a handshake to judge — a
// kept-alive socket was last looked at before the pin it now answers to (and
// one opened by a request that is not held to the pin could carry the next
// request, token and all, past it).
const __AIO_PIN_AGENT = false;
const { app, BrowserWindow, Menu, nativeImage } = require('electron');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

${tmplAppMenu("aio client")}
app.name = '${CLIENT_PROFILE}';
${tmplCrashGuard()}
${tmplPermissionGuard()}
${tmplWebGuard()}
${tmplIpcGuard()}
// print() (aio/browser): window.print() is a silent no-op in Electron on
// Linux (measured, Electron 44) — the app shells print from the main
// process (__aioShell.print, Ctrl+P); so does this window. A profile that
// cannot hold the file costs print() alone, said here — not the client.
const __aioPreloadFile = (() => {
  try {
${
    tmplPreloadWrite(
      JSON.stringify(
        "const { contextBridge, ipcRenderer } = require('electron');\n" +
          "contextBridge.exposeInMainWorld('__aioShell', { print: () => ipcRenderer.send('__aio:print') });\n",
      ),
    )
  }
    return preloadFile;
  } catch (e) {
    console.error('[aio-client] print() falls back to window.print() (a no-op on Linux): its preload could not be written (' + ((e && e.message) || e) + ')');
    return undefined;
  }
})();

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
    const req = mod.get(url, { timeout: 8000, rejectUnauthorized: false, agent: __AIO_PIN_AGENT }, (res) => {
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
    guardPin(req, mod, url, reject);
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// The pin is looked at HERE, on the connection that is about to carry the
// request line (and the ?token= in it): 'secureConnect' runs inside the
// handshake-done callback, before the buffered request is written. Strict:
// the request is destroyed there, so nothing is sent (refuse(err) answers the
// caller first — the destroy's own error is a bare "socket hang up"); a
// certificate that cannot be read is a mismatch (fail closed).
// Not strict: the request is destroyed there too, UNLESS this certificate has
// been decided for this run (see decidePin) — the caller gets a pinUndecided
// error naming the certificate, decides, and asks again.
function guardPin(req, mod, url, refuse) {
  if (mod !== https) return;
  req.on('socket', (sock) => {
    sock.once('secureConnect', () => {
      const host = new URL(url).host;
      if (!_pinnedCerts.has(host)) {
        try { _presented.set(host, { chain: chainPem(sock), authorized: sock.authorized === true }); } catch {}
        return;
      }
      try {
        const peer = sock.getPeerCertificate();
        const der = peer && peer.raw ? Buffer.from(peer.raw).toString('base64') : '';
        if (pinMismatch(host, der)) {
          if (!__AIO_STRICT_PIN) {
            if (der && (_pinDecided.get(host) === der || (_pinKeyless.get(host) === der && !hasToken(url)))) return;
            const e = new Error('The certificate pinned for ' + host + ' has changed.');
            e.pinUndecided = { host, der };
            refuse(e); req.destroy();
            return;
          }
          const note = warnPinChanged(host);
          if (__AIO_STRICT_PIN) { refuse(pinRefusal(new Error(note))); req.destroy(); }
        }
      } catch (e) {
        if (__AIO_STRICT_PIN && _pinnedCerts.has(host)) { refuse(pinRefusal(e)); req.destroy(); }
      }
    });
  });
}

// ── A host with no pin: the certificate it was first seen with ──
// A manual connect (no pairing, no profile, often no key at all: a login
// app) has no pin, and the window's cookie jar — a login session — went to
// whatever certificate answered at that address later. So the chain such a
// host presents is kept with its recent ('seen', trust on first use) and held
// to like a pin, for its COOKIES: a connect that meets another certificate
// (one 'seen' does not cover — a leaf re-issued under the same root does)
// takes that host's cookies out of the jar before the page loads, says so,
// and keeps the new chain. The price is one sign-in per server root change
// (aio's root lives ten years, src/server/tls.ts). Not a pin: nothing is
// refused, strict or not. A certificate the machine's trust store accepts is
// first seen as nothing — the public PKI vouches for it, and its intermediate
// rotates.
// host -> the chain PEM the latest https request to an unpinned host met.
const _presented = new Map();
// host -> the chain PEM first seen there (from the recents at start).
const _seenCerts = new Map();
function chainPem(sock) {
  let out = '', c = sock.getPeerCertificate(true);
  for (let n = 0; c && c.raw && n < 8; n++) {
    out += '-----BEGIN CERTIFICATE-----' + Buffer.from(c.raw).toString('base64') + '-----END CERTIFICATE-----';
    if (!c.issuerCertificate || c.issuerCertificate === c) break;
    c = c.issuerCertificate;
  }
  return out;
}
// The fetch of url met its host's certificate: true when it is not the one
// first seen there (its cookies must not go). Updates the seen chain.
function seenChanged(url) {
  const host = new URL(url).host;
  const now = url.startsWith('https:') && !_pinnedCerts.has(host) ? _presented.get(host) : null;
  if (!now || !now.chain) return false;
  const was = _seenCerts.get(host);
  if (!was) {
    if (!now.authorized) _seenCerts.set(host, now.chain);
    return false;
  }
  if (pinMatches(was, now.chain)) return false;
  if (now.authorized) _seenCerts.delete(host); else _seenCerts.set(host, now.chain);
  const note = 'The certificate of ' + host + ' has CHANGED since this client first met it, and nothing can prove it is the same server (it is not paired) — so its cookies (a login) were NOT sent. ' +
    'If the server was reinstalled or regenerated its certificate, sign in again. If it was not, something between this client and the app is answering in its place — do not enter anything you would not hand to a stranger.';
  console.error('[aio-client] WARNING: ' + note);
  return true;
}

// ── A changed certificate, not strict: may this server be sent the key? ──
// What a server that regenerated its certificate still has, and something
// answering in its place does not, is the app's key. So the key is not sent
// to find out: the server is asked to PROVE it holds it, for the certificate
// it is presenting (the server side is src/server/pin-proof.ts).
//   • proved            → that certificate becomes the pin; connect as before.
//   • not proved, and this app HAS proved before (recents: proves) → the key
//     is withheld: the address is opened without it.
//   • not proved, never has (a server older than the proof) → as before:
//     warned about, and reached with the key. Refusing here would lock a
//     paired client out of a server that only regenerated its certificate.
// host -> the base64 DER decided for this run (guardPin lets it through).
const _pinDecided = new Map();
// host -> the base64 DER that was decided AGAINST: it is opened without the
// key, so only a request that carries none goes through. One that carries the
// key (the same recent, clicked again) is undecided again, and asks again —
// in one map with the above, the second click sent the key to what had just
// failed to prove.
const _pinKeyless = new Map();
function hasToken(url) { return /[?&]token=/.test(url); }
function hmacHex(key, msg) { return crypto.createHmac('sha256', key).update(msg).digest('hex'); }
// One proof exchange with the server at base. token: sent only by learnProof,
// on a connection the pin already covers. Resolves { valid, cert, der }.
function askProof(base, key, token, onSocket) {
  return new Promise((resolve) => {
    const nonce = crypto.randomBytes(32).toString('hex');
    const payload = Buffer.from(JSON.stringify({ nonce, tag: hmacHex(key, 'aio-pin-proof-v1:c:' + nonce) }));
    let der = '';
    // answered: the server SAID something that is not a proof. Not answered
    // (its time ran out, the connection broke) decides nothing — see provePin.
    const none = (answered) => resolve({ valid: false, cert: null, der, answered: answered === true });
    const url = base + '/__aio/pin-proof' + (token ? '?token=' + encodeURIComponent(token) : '');
    const req = https.request(url, {
      method: 'POST', timeout: 8000, rejectUnauthorized: false, agent: false,
      headers: { 'content-type': 'application/json', 'content-length': payload.length },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { if (data.length < 65536) data += chunk; });
      res.on('end', () => {
        let j = null; try { j = JSON.parse(data); } catch {}
        if (res.statusCode !== 200 || !j || typeof j.proof !== 'string' || typeof j.cert !== 'string') return none(true);
        const want = hmacHex(key, 'aio-pin-proof-v1:s:' + nonce + ':' + normPem(j.cert));
        const a = Buffer.from(j.proof), b = Buffer.from(want);
        // The proof is for THE certificate this connection presented.
        const valid = a.length === b.length && crypto.timingSafeEqual(a, b) && !!der && pinMatches(j.cert, der);
        resolve({ valid, cert: j.cert, der, answered: true });
      });
    });
    req.on('socket', (sock) => sock.once('secureConnect', () => {
      try {
        const peer = sock.getPeerCertificate();
        der = peer && peer.raw ? Buffer.from(peer.raw).toString('base64') : '';
      } catch {}
      if (onSocket && onSocket(der) === false) { none(); req.destroy(); }
    }));
    req.on('error', () => none());
    req.on('timeout', () => { req.destroy(); none(); });
    req.write(payload); req.end();
  });
}
// Every recent of this app at this host: (host, key) names the pairing.
function patchRecents(host, key, patch) {
  try {
    const list = loadRecents().map((r) => {
      let h = ''; try { h = new URL(r.url).host; } catch {}
      return h === host && r.key === key ? Object.assign({}, r, patch) : r;
    });
    fs.writeFileSync(recentsPath(), JSON.stringify(list), { mode: 0o600 });
    try { fs.chmodSync(recentsPath(), 0o600); } catch {}
  } catch {}
}
function pairingOf(host, key) {
  return loadRecents().find((r) => { try { return new URL(r.url).host === host && r.key === key; } catch { return false; } });
}
// A connect that met its pin: learn, once per pairing, that this server can
// prove — from then on "cannot prove" is not something it would say.
function learnProof(url) {
  try {
    const u = new URL(url);
    const appKey = u.searchParams.get('token');
    if (u.protocol !== 'https:' || !appKey || !_pinnedCerts.has(u.host)) return;
    const rec = pairingOf(u.host, appKey);
    if (!rec || rec.proves) return;
    askProof(u.origin, appKey, appKey, (der) => !pinMismatch(u.host, der)).then((p) => {
      if (p.valid) patchRecents(u.host, appKey, { proves: true });
    });
  } catch {}
}
// The decision for one changed certificate. Resolves the URL to open: the
// one asked for, or the same address WITHOUT the key.
async function decidePin(url, undecided) {
  const u = new URL(url);
  const appKey = u.searchParams.get('token');
  // host:port of the certificate that was presented — never the address
  // (which carries the key): the lines below are printed.
  const pinnedHost = undecided.host;
  if (!appKey) {
    // No key in this address: nothing to withhold. Said, and reached.
    warnPinChanged(pinnedHost);
    _pinDecided.set(pinnedHost, undecided.der);
    return { url, withheld: false };
  }
  const p = await askProof(u.origin, appKey, null, null);
  if (p.valid && p.der === undecided.der) {
    repin(pinnedHost, appKey, p.cert);
    return { url, withheld: false };
  }
  const rec = pairingOf(pinnedHost, appKey);
  // What the lines below say is gone once a page loads: it is kept with the
  // pairing, and the connect page shows it on that recent until the
  // certificate is pinned again (a proof, or pairing).
  patchRecents(pinnedHost, appKey, { changed: new Date().toISOString() });
  if (rec && rec.proves) {
    _pinKeyless.set(pinnedHost, undecided.der);
    u.searchParams.delete('token');
    const note = 'The certificate pinned for ' + pinnedHost + ' has CHANGED, and what answers there could not prove it holds this app\\'s key — so the key was NOT sent. ' +
      'If the server of this app was reinstalled, pair again (or import a fresh .aioapp). If it was not, something between this client and the app is answering in its place — do not enter anything you would not hand to a stranger.';
    console.error('[aio-client] WARNING: ' + note);
    return { url: u.href, withheld: true, note };
  }
  _pinDecided.set(pinnedHost, undecided.der);
  warnPinChanged(pinnedHost);
  return { url, withheld: false };
}
// A proved certificate becomes the pin, in this run and in the pairing.
function repin(hostName, key, cert) {
  pinCert(hostName, cert);
  patchRecents(hostName, key, { cert, proves: true, changed: undefined });
  console.error('[aio-client] The certificate pinned for ' + hostName + ' changed, and the server proved it holds this app\\'s key: the new certificate is pinned.');
}
// A certificate the pin does not cover, met by the WINDOW (the server
// regenerated it while the page was open — no connect is there to decide):
// the server is asked to prove, with each key paired at that address. Only a
// proof opens it; anything else stays refused until the next connect decides.
// One question per certificate and run — one that was ANSWERED. A question
// that got no answer (a server still starting: its 8 s ran out, or the
// connection broke) used to count as "cannot prove" until the client was
// restarted; it decides nothing, so the window's next request asks again.
// (What is sent to ask is a nonce and its HMAC, never the key.)
const _pinProving = new Map();
function provePin(host, der) {
  const id = host + ' ' + der;
  if (!_pinProving.has(id)) _pinProving.set(id, (async () => {
    const keys = new Set();
    for (const r of loadRecents()) { try { if (r.key && new URL(r.url).host === host) keys.add(r.key); } catch {} }
    let unanswered = false;
    for (const key of keys) {
      const p = await askProof('https://' + host, key, null, null);
      if (p.valid && p.der === der) { repin(host, key, p.cert); return true; }
      if (!p.answered) unanswered = true;
    }
    if (unanswered) _pinProving.delete(id);
    return false;
  })().catch(() => false));
  return _pinProving.get(id);
}

// The page the WINDOW loads carries what a request of this script never does:
// the cookie jar. A connect made with the key leaves it there too (the server
// hands the page 'aio_key_<app>' for its follow-up requests, for as long as
// this run lasts) — so an address opened WITHOUT the key, because what
// answers there did not prove it holds it, was sent the key all the same, by
// the window. And every other cookie of that host: a login session is as good
// as the key to whatever answers in the server's place. So EVERY cookie the
// window would send that host is taken out of the jar first (cookies ignore
// the port: another app's at that host name too — it would be sent as well).
// The page was fetched (by this script, with no cookie) before it is loaded.
// A genuine server never comes here: it proves, and is re-pinned. A jar that
// cannot be read throws, and the page is not loaded.
async function dropHostCookies(win, url) {
  const name = new URL(url).hostname.replace(/^[[]|[\]]$/g, '');
  const jar = win.webContents.session.cookies;
  for (const c of await jar.get({})) {
    const domain = String(c.domain || '').replace(/^[.]/, '').replace(/^[[]|[\]]$/g, '');
    if (domain !== name && (c.hostOnly !== false || !name.endsWith('.' + domain))) continue;
    await jar.remove((c.secure ? 'https://' : 'http://') + (domain.includes(':') ? '[' + domain + ']' : domain) + (c.path || '/'), c.name);
  }
}

// A strict refusal, marked: connectTo answers it with the connect page (the
// one place to pair again) when the launch went straight to an address.
function pinRefusal(e) { try { e.pinRefused = true; } catch {} return e; }

// Pairing only: its answer is what REPLACES a pin, so it is not held to one.
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
    const req = mod.get(url, { timeout: 5000, rejectUnauthorized: false, agent: __AIO_PIN_AGENT }, (res) => {
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
    // Its own connection, and the URL carries the token too.
    guardPin(req, mod, url, () => resolve(null));
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
const DISCOVERY_PORT = (() => {
  const raw = process.env.AIO_DISCOVERY_PORT;
  if (raw === undefined || String(raw).trim() === "") return 8099;
  const s = String(raw).trim();
  const n = Number(s);
  // Decimal digits only — same rule as the server's discoveryPortOf / AIO_PORT.
  // [0-9], never the backslash class: this script is a template literal, and
  // an un-doubled backslash-d reaches the file as a bare "d" — the test then
  // matched no port at all and the variable was ignored outright.
  if (!/^[0-9]+$/.test(s) || n < 1 || n > 65535) return 8099;
  return n;
})();

// A probe that never left is not "no apps on the network": said ONCE (the
// connect page sweeps repeatedly), with no address in it. macOS refuses the
// broadcast to an app without the Local Network permission — "No route to
// host", while everything else on the network works.
//
// The same for a socket that could not be made, and for one that FAILED after
// the probe left (its 'error' event): the sweep then ends with an empty list
// that says nothing about what is running, and it ended in silence. Each kind
// is said once in the log, with the OS reason; the connect page shows the
// latest reason where it says "searching…" for as long as sweeps keep failing.
const _discoverySaid = {};
let _discoveryNote = '';
function discoveryFailed(what, why) {
  const reason = String((why && (why.code || why.message)) || why);
  _discoveryNote = 'search unavailable (' + reason + ') — type the address above';
  if (_discoverySaid[what]) return;
  _discoverySaid[what] = true;
  console.error('[aio-client] discovery: ' + what + ' (' + reason + ') — ' +
    (what === 'the probe could not be sent' ? 'nothing was asked' : 'no answer can be heard') +
    ', so an empty result says nothing about what is running. Type the address instead.' +
    (process.platform === 'darwin'
      ? ' On macOS this is the Local Network permission: allow this app ' +
        'under System Settings > Privacy & Security > Local Network.'
      : ''));
}
function discoveryUnsent(why) { discoveryFailed('the probe could not be sent', why); }

// Where a sweep sends its probe — the twin of the server's broadcastTargets
// (src/server/discovery.ts; tests/discovery-broadcast-targets.test.ts runs
// both on the same lists). The limited broadcast leaves by ONE interface, and
// with a VPN up that is the VPN: the LAN was never asked. So each non-loopback
// IPv4 interface's own broadcast address is probed too (not a /31 or /32: a
// point-to-point link or a single host has none). [0-9], never the backslash
// class — see DISCOVERY_PORT.
function broadcastTargets(ifaces) {
  const quad = (s) => {
    const m = /^([0-9]{1,3})[.]([0-9]{1,3})[.]([0-9]{1,3})[.]([0-9]{1,3})$/.exec(String(s));
    if (!m) return null;
    const q = m.slice(1).map(Number);
    return q.every((n) => n <= 255) ? q : null;
  };
  const out = ['255.255.255.255'];
  for (const i of ifaces) {
    if (i.family !== 'IPv4' && i.family !== 4) continue;
    const a = quad(i.address), m = quad(i.netmask);
    if (!a || !m || a[0] === 127) continue;
    if (m[0] === 255 && m[1] === 255 && m[2] === 255 && m[3] >= 254) continue;
    const b = a.map((x, k) => x | (~m[k] & 255)).join('.');
    if (!out.includes(b)) out.push(b);
  }
  return out;
}

function discoverApps(timeoutMs, cb) {
  let sock;
  const found = new Map();
  const heard = []; // { host, port, name, addrs } of every reply kept
  const own = new Set(); // this machine's addresses
  _discoveryNote = '';
  // A sweep answers ONCE. A socket that failed used to answer [] at the error
  // and again when its timeout fired — and one that failed twice, twice more —
  // so the connect page was redrawn by a sweep that had already ended.
  let ended = false, timer;
  const end = (apps) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    try { sock.close(); } catch {}
    cb(apps);
  };
  try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); }
  catch (e) { discoveryFailed('the search socket could not be opened', e); return end([]); }
  sock.on('message', (msg, rinfo) => {
    const text = msg.toString('utf8');
    if (!text.startsWith('AIO1 ')) return;
    let ad; try { ad = JSON.parse(text.slice(5)); } catch { return; }
    if (typeof ad.name !== 'string' || typeof ad.port !== 'number') return;
    const host = rinfo.address;
    // This machine answers each target from the address of the interface the
    // probe left by: one app, several hosts. They are one host.
    // So is another machine on two subnets this one shares: each reply names
    // the other's source among its own addresses (the twin of oneMachine in
    // src/server/discovery.ts). One APP, by its name: one port on two
    // interfaces can be two apps, each bound to one address.
    const at = (own.has(host) ? '' : host) + ':' + ad.port + ':' + ad.name;
    if (found.has(at)) return;
    const addrs = Array.isArray(ad.addrs) ? ad.addrs.filter((x) => typeof x === 'string') : [];
    delete ad.addrs;
    const me = { host, port: ad.port, name: ad.name, addrs };
    if (heard.some((h) => h.port === me.port && h.name === me.name && h.host !== host &&
      h.addrs.includes(host) && addrs.includes(h.host))) return;
    heard.push(me);
    ad.host = host;
    ad.url = (ad.tls ? 'https': 'http') + '://' + host + ':' + ad.port;
    found.set(at, ad);
  });
  sock.on('error', (why) => {
    if (ended) return;
    discoveryFailed('the search socket failed', why);
    end([]);
  });
  sock.bind(() => {
    if (ended) return;
    try { sock.setBroadcast(true); } catch {}
    const probe = Buffer.from('AIO_DISCOVER? v1');
    let ifaces = [];
    try { ifaces = Object.values(require('os').networkInterfaces()).flat(); } catch {}
    const targets = broadcastTargets(ifaces);
    for (const i of ifaces) own.add(i.address);
    // Unsent only when NO target took the probe — one refused (the limited
    // broadcast routed into a VPN) beside one sent is a sweep that asked.
    let failed = 0;
    const unsent = (why) => { if (++failed === targets.length) discoveryUnsent(why); };
    for (const to of targets) {
      try {
        sock.send(probe, DISCOVERY_PORT, to, (why) => { if (why) unsent(why); });
      } catch (why) { unsent(why); }
    }
    timer = setTimeout(
      () => end([...found.values()].sort((a, b) => a.name.localeCompare(b.name))),
      timeoutMs,
    );
  });
}

// What the connect page is handed: each entry with the address it SHOWS,
// through the redactor — a paired recent's url carries '?token=<key>', and
// the page printed it under the app's name. The url itself is untouched (it
// is what a click opens, and what "forget" names).
function forPage(list) {
  return list.map((a) => Object.assign({}, a, { shown: __aioRedact(a.url || '') }));
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
// Every certificate in a PEM (or bare base64) text, as base64 DER — the PEM
// armour (whitespace-free after normPem) is the separator.
function pemBodies(p) { return normPem(p).split(/-----[A-Z0-9]+-----/).filter(Boolean); }
// Does the certificate a host presents satisfy its pin?
// What a profile or a pairing reply carries is the file the server serves:
// leaf THEN the app's own root. Comparing that whole text with the one
// certificate Chromium hands over never matched, so the strict pin never fired
// for any current server and every connect rode the looser host list. A pin is
// met by the exact certificate, or by a certificate SIGNED by one in the pin
// (the root: the leaf is re-issued whenever the machine's addresses change,
// the root is the part that does not). The signature is verified — an issuer
// merely named in a presented chain proves nothing.
function pinMatches(pinned, cert) {
  const der = pemBodies(cert)[0];
  if (!der) return false;
  const bodies = pemBodies(pinned);
  if (bodies.includes(der)) return true;
  try {
    const leaf = new crypto.X509Certificate(Buffer.from(der, 'base64'));
    for (const b of bodies) {
      try {
        if (leaf.verify(new crypto.X509Certificate(Buffer.from(b, 'base64')).publicKey)) return true;
      } catch {}
    }
  } catch {}
  return false;
}
// True only for a host that HAS a pin and presents something else.
function pinMismatch(host, cert) {
  const pinned = _pinnedCerts.get(host);
  return !!pinned && !pinMatches(pinned, cert);
}
// A pinned host presenting ANOTHER certificate is not refused — a server that
// regenerated its cert must stay reachable, and refusing would lock every
// paired client out of it. It is never SILENT either: the main-process log
// says so, and so does the connect page when it is the page on screen (a
// data: URL — an app page is never scripted, it may own an element named
// 'err').
function warnPinChanged(pinnedHost) {
  const pinNote = 'The certificate pinned for ' + pinnedHost + ' has CHANGED. ' +
    (__AIO_STRICT_PIN ? 'REFUSED (strict pin): nothing was sent to it. ' : '') +
    'If the server of this app was reinstalled or regenerated its certificate, pair again (or import a fresh .aioapp) to pin the new one' +
    (__AIO_STRICT_PIN ? ' — the connect page (start the client with --connect) pairs by PIN. ' : '. ') +
    'If it was not, something between this client and the app is answering in its place — do not enter anything you would not hand to a stranger.';
  console.error('[aio-client] ' + (__AIO_STRICT_PIN ? 'REFUSED: ' : 'WARNING: ') + pinNote);
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!String(w.webContents.getURL()).startsWith('data:text/html')) continue;
      w.webContents.executeJavaScript(
        "document.getElementById('err') && (document.getElementById('err').textContent = " + JSON.stringify(pinNote) + ")"
      ).catch(() => {});
    }
  } catch {}
  return pinNote;
}

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
    // The pairing reply is as untrusted as a .aioapp file: the same port rule
    // loadProfileFile applies, or a reply's port like "1@evil.example" turned
    // the saved URL's authority into another host.
    if (!Number.isInteger(pr.port) || pr.port < 1 || pr.port > 65535) {
      throw new Error('Pairing failed: the app answered with an invalid port');
    }
    pr.host = info.host; // the server doesn't know its own LAN address — we do
    const rec = profileToRecent(pr);
    pinCert(new URL(rec.url).host, rec.cert);
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

async function connectTo(win, url, withheld) {
  try {
    let html;
    try {
      html = await fetchPage(url);
    } catch (fe) {
      // A changed certificate, not strict: nothing was sent. Decide (see
      // decidePin), then ask again — once: the decision lets it through.
      if (fe && fe.pinUndecided && !withheld) {
        const d = await decidePin(url, fe.pinUndecided);
        return connectTo(win, d.url, d.withheld ? d.note : 'decided');
      }
      // Auth-required aio app (--expose with a token) returns 401/403. Guide
      // the user to append the token from the server's "share:" line.
      const m = /Server returned (401|403)/.exec(fe.message || '');
      // …unless the key was withheld on purpose: say that instead.
      if (m && withheld && withheld !== 'decided') throw pinRefusal(new Error(withheld));
      if (m && !/[?&]token=/.test(url)) {
        throw new Error('This app requires a token. Add it to the address:  ' + url + (url.includes('?') ? '&': '?') + 'token=YOUR_TOKEN   (copy it from the server\\'s "share:" line)');
      }
      throw fe;
    }
    if (!looksLikeAio(html)) {
      throw new Error("This doesn't look like an aio app (no aio markers on the page). Check the address, or that the server is running with --expose.");
    }
    const meta = parseMeta(html);
    const dropCookies = (withheld && !hasToken(url)) || seenChanged(url);
    // A connect made WITHOUT the saved key is not a place that was been to.
    if (!withheld || withheld === 'decided') try {
      // Preserve a pinned cert/key from a prior profile import for this URL.
      const prev = loadRecents().find((r) => r.url === url) || {};
      saveRecent({ url, name: meta.title || new URL(url).host, title: meta.title, host: new URL(url).hostname, port: Number(new URL(url).port) || (url.startsWith('https') ? 443: 80), tls: url.startsWith('https'), needsAuth: /[?&]token=/.test(url), cert: prev.cert || null, key: prev.key || null, seen: _seenCerts.get(new URL(url).host) || undefined, proves: prev.proves || undefined, changed: prev.changed || undefined });
    } catch {}
    if (!withheld) learnProof(url);

    // The app's icon ROUTE, with the connect URL's query kept: appending
    // '/icon.png' to a URL carrying '?token=K' put the path inside the query
    // ('…/?token=K/icon.png'), so a token-guarded app never got its icon —
    // and '/icon.png' only exists when the app ships one; /__aio/icon always
    // answers (the generated monogram otherwise).
    const iconUrl = (() => { const u = new URL(url); u.pathname = '/__aio/icon'; return u.href; })();
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
    // 🔒 This window, showing THIS origin, is the app — nothing else is: a
    // site a redirect lands it on, or any other window, holds no permission
    // (tmplPermissionGuard). Re-bound per connect: the app may be another one.
    __aioIpcBind(win, __aioOrigin(url));
    // A changed certificate that did not prove, opened without the key, or a
    // host's first-seen certificate changed: the window must not send that
    // host its cookies either (dropHostCookies).
    if (dropCookies) await dropHostCookies(win, url);
    win.loadURL(url);
  } catch (e) {
    const msg = e.message || String(e);
    // A pin refusal (strict; or the key withheld and the app then asking for
    // it), on a launch that went straight to an address (--server-url, a
    // profile, the baked one): the window has no page to say it on, and the
    // way back — pairing again — is on the connect page. Open it, saying why.
    // (Measured in a real Electron: the refusal reached the log and the
    // window stayed blank.)
    if (e && e.pinRefused && _openPicker) {
      const open = _openPicker; _openPicker = null;
      open(msg);
      return;
    }
    // In the log first (a line there is token-redacted, tmplCrashGuard): a
    // launch that went straight to an address has loaded no page, and a
    // script for a page that is not there never runs — measured in a real
    // Electron, the promise stays pending: a blank window (left blank on
    // purpose, a kiosk is not handed an address box) and not one line
    // anywhere saying why. On a page without an 'err' element it rejected.
    // aio-ok(token-log): through __aioRedact — this script's redactUrlToken
    console.error('[aio-client] cannot open ' + __aioRedact(url + ': ' + msg));
    win.webContents.executeJavaScript(
      "document.getElementById('err') && (document.getElementById('err').textContent = " + JSON.stringify(msg) + ")"
    ).catch(() => {});
  }
}
// Set by 'ready' for a launch that skips the connect page; null once the
// page is (or is about to be) on screen.
let _openPicker = null;

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
    if (pinned && cert && pinMatches(pinned, cert.data)) {
      event.preventDefault(); callback(true); return;
    }
    // A pin that did NOT match: only the certificate that was DECIDED for
    // this run goes on to the looser list below (the page fetch met it
    // first, see decidePin) — another one here is not the one that was asked
    // about, and the page URL carries the key. Strict decides nothing, so
    // there it is every certificate the pin does not cover.
    if (pinned) {
      const got = pemBodies(cert && cert.data)[0];
      const keyless = !!got && _pinKeyless.get(host) === got && !hasToken(url);
      if (!got || (_pinDecided.get(host) !== got && !keyless)) {
        // Not strict: it may be the app's own server with a new certificate.
        // Ask it to prove (provePin) — the verdict follows the answer.
        if (!__AIO_STRICT_PIN && got) {
          event.preventDefault();
          provePin(host, got).then((ok) => { if (!ok) warnPinChanged(host); callback(ok); });
          return;
        }
        warnPinChanged(host); callback(false); return;
      }
    }
    // No pin, but a certificate first seen there: another one is refused
    // until a connect decides (seenChanged) — the window would send it the
    // host's cookies.
    const seen = !pinned && _seenCerts.get(host);
    if (seen && !(cert && pinMatches(seen, cert.data))) {
      console.error('[aio-client] WARNING: the certificate of ' + host + ' changed while the app was open — refused; reconnect to decide.');
      callback(false); return;
    }
    // Fallback: a host we fetched + validated as an aio app (manual connects
    // without a profile). Looser than pinning, but the user chose the address.
    if (_trustedHosts.has(host)) { event.preventDefault(); callback(true); return; }
  } catch {}
  callback(false);
});

app.on('ready', () => {
  // Strict: 'certificate-error' above fires only for a certificate Chromium
  // itself refuses. One the machine's trust store accepts (a public CA, a
  // corporate proxy root) would load with no question asked — so every
  // certificate for a host name that HAS a pin is held to it here.
  // (hostname carries no port: any pin of that name may answer; the
  // per-port verdict stays with 'certificate-error'.) -3 = Chromium's own
  // result, -2 = refused.
  if (__AIO_STRICT_PIN) {
    require('electron').session.defaultSession.setCertificateVerifyProc((request, cb) => {
      try {
        const pins = [];
        for (const [h, pin] of _pinnedCerts) {
          let name = h;
          try { name = new URL('https://' + h).hostname; } catch {}
          if (name === request.hostname || name === '[' + request.hostname + ']') pins.push(pin);
        }
        if (pins.length && !pins.some((pin) => pinMatches(pin, request.certificate.data))) {
          warnPinChanged(request.hostname);
          cb(-2); return;
        }
      } catch { cb(-2); return; }
      cb(-3);
    });
  }
  // Pre-pin certs from stored recents/profiles so click-to-reconnect trusts
  // them without a fresh fetch.
  try {
    // Key by the URL host (host:port), the SAME key the certificate-error
    // lookup uses (new URL(url).host) — a bare hostname never matched an app
    // on a non-default port, so strict pinning never fired and every profile
    // install silently fell through to the looser TOFU host list.
    // PER ITEM: this whole loop is inside one try, so a single stored recent
    // with an unparsable url threw out of the loop and left every LATER recent
    // unpinned — the strict pin silently downgraded to the looser TOFU list for
    // all of them. One bad entry skips only itself.
    for (const r of loadRecents()) {
      try {
        const h = new URL(r.url).host;
        if (r.cert) pinCert(h, r.cert);
        // Newest first: the latest chain seen at a host is the one kept.
        if (r.seen && !_seenCerts.has(h)) _seenCerts.set(h, String(r.seen));
      } catch { /* unusable url: skip it */ }
    }
  } catch {}

  let directUrl = null;
  let profileFile = null;
  let bootErr = null; // an unusable profile: shown on the connect page
  for (const arg of process.argv) {
    if (arg.startsWith('--server-url=')) directUrl = arg.slice(13);
    else if (arg.startsWith('--profile=')) profileFile = arg.slice(10);
    // A bare .aioapp path (file association / double-click) is a profile too.
    else if (arg.endsWith('.aioapp')) profileFile = arg;
  }

  // Hidden until its page has painted, like an app's window (no blank frame).
  const win = new BrowserWindow({
    width: 480, height: 300,
    resizable: false,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: __aioPreloadFile },
  });
  const __aioPrint = () => { if (!win.isDestroyed()) win.webContents.print({ silent: false, printBackground: true }); };
  ipcMain.on('__aio:print', __aioPrint); // the app's origin only (tmplIpcGuard)
  // No Ctrl/⌘+P here: the client cannot read the remote app's
  // electron.shortcuts.print, and taking the key broke an app's own mod+p
  // (a command palette). print() reaches __aio:print above.
  {
    const __aioRestoreMax = false, __aioBgNow = () => null;
${tmplShowWhenPainted()}
  }
  // 🔒 The same rules as an app's own shell. Until a connect, no origin is
  // the app (the connect page needs no permission). There is no <webview>
  // (webviewTag is off) and no openWindow here, so the one other page this
  // process could show was a pop-up: window.open made a real window, which
  // the permission guard took for the app (a window, asking from the origin
  // it shows). It is denied, as in both app shells — an http(s) link goes to
  // the system browser.
  __aioIpcBind(win, '');
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        require('electron').shell.openExternal(url);
      } else {
        console.warn('[aio:electron] pop-up BLOCKED (not http/https)');
      }
    } catch {
      console.warn('[aio:electron] pop-up BLOCKED (not a URL)');
    }
    return { action: 'deny' };
  });

  _openPicker = (why) => { bootErr = why; openPicker(); };

  // Imported profile → pin its cert, remember it, connect straight in.
  if (profileFile) {
    const pr = loadProfileFile(profileFile);
    if (!pr) { console.error('invalid .aioapp profile: ' + profileFile); process.exit(1); }
    // loadProfileFile's host rule admits spellings no URL does ("::1"
    // unbracketed, "a:b"); new URL() throwing here killed the 'ready' handler
    // with a blank 480x300 window and no word why.
    try {
      const rec = profileToRecent(pr);
      pinCert(new URL(rec.url).host, rec.cert);
      saveRecent(rec);
      connectTo(win, rec.url);
      return;
    } catch (e) {
      bootErr = 'This .aioapp profile names a host that is not a usable address: ' + JSON.stringify(String(pr.host)) + '. Ask for a fresh profile, or type the address below.';
      console.error('[aio-client] ' + bootErr + ' (' + profileFile + ')');
    }
  }

  if (!bootErr && directUrl) {
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
  if (!bootErr && __AIO_BAKED_URL && !process.argv.includes('--connect')) {
    connectTo(win, __AIO_BAKED_URL);
    return;
  }

  _openPicker = null;
  openPicker();
  // The connect page — a hoisted function (not re-indented): a strict-pin
  // refusal of a direct launch opens it later, through _openPicker.
  function openPicker() {
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(CONNECT_HTML));

  let scanTimer = null;
  function inject(js) {
    win.webContents.executeJavaScript(js).catch(() => {});
  }
  function scan() {
    discoverApps(1400, (apps) => {
      inject('window.__aioSetDiscovered && window.__aioSetDiscovered(' + JSON.stringify(forPage(apps)) + ')');
      // A sweep that failed is not "searching…": say why, where that is shown.
      if (!apps.length && _discoveryNote) {
        inject('(function(e){ if (e) e.textContent = ' + JSON.stringify(_discoveryNote) + '; })(document.querySelector("#discovered .empty"))');
      }
      inject('window.__aioScanDone && window.__aioScanDone()');
    });
  }
  win.webContents.once('did-finish-load', () => {
    inject('window.__aioSetRecents && window.__aioSetRecents(' + JSON.stringify(forPage(loadRecents())) + ')');
    inject('window.__aioSetDiscovered && window.__aioSetDiscovered([])');
    if (bootErr) inject("document.getElementById('err') && (document.getElementById('err').textContent = " + JSON.stringify(bootErr) + ")");
    scan();
    scanTimer = setInterval(scan, 4000); // keep the LAN list fresh
  });

  win.webContents.on('will-navigate', (event, url) => {
    // The connect page's links only. Once the app is on screen its navigations
    // are its own: re-entering connectTo fetched each one without the window's
    // cookies (a keyed app's tokenless link: 401, the window stayed put) and
    // re-sized the window and saved a recent per link. Like the app shells
    // (tmplWillNavigate): the app's origin — or the site its own flow sent it
    // to (an identity provider) — loads; another site goes to the system
    // browser, anything else is blocked.
    if (!String(win.webContents.getURL()).startsWith('data:')) {
      const app = __aioAppOrigin;
      const cur = __aioOrigin(win.webContents.getURL());
      if (app && (__aioOrigin(url) === app || cur !== app) && /^https?:/.test(url)) return;
      event.preventDefault();
      if (/^https?:/.test(url)) require('electron').shell.openExternal(url);
      else console.warn('[aio-client] navigation blocked (not this app, not http)');
      return;
    }
    event.preventDefault();
    // Recents "forget" action from the page (aio-forget:<encoded-url>)
    if (url.startsWith('aio-forget:')) {
      const gone = decodeURIComponent(url.slice('aio-forget:'.length));
      const list = forgetRecent(gone);
      inject('window.__aioSetRecents && window.__aioSetRecents(' + JSON.stringify(forPage(list)) + ')');
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
  }
});

app.on('window-all-closed', () => process.exit(0));
`.trim();
}
