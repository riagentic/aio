// Electron main.cjs generator — self-contained client with connect page

import { CONNECT_HTML, tmplBounds } from "./electron-shared.ts";

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
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 8000 }, (res) => {
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

app.on('ready', () => {
  let directUrl = null;
  for (const arg of process.argv) {
    if (arg.startsWith('--server-url=')) {
      directUrl = arg.slice(13); // AIO-230: '--server-url=' is 13 chars
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
      console.error('--server-url must use http:// or https:// scheme');
      process.exit(1);
    }
    connectTo(win, directUrl);
    return;
  }

  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(CONNECT_HTML));

  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    connectTo(win, url);
  });
});

app.on('window-all-closed', () => process.exit(0));
`.trim();
}
