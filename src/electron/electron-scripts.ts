// Electron main.cjs script generators — standard (WebSocket) and client modes

import {
  type AioMeta,
  tmplBounds,
  tmplBoundsTracking,
  tmplCrashGuard,
  tmplKeyboardShortcuts,
  tmplParentWatch,
  tmplWillNavigate,
  tmplWindowShape,
  toSlug,
} from "./electron-shared.ts";

/** Generates a minimal Electron main.cjs that loads the given URL */
export function electronMainScript(url: string, meta?: AioMeta): string {
  const w = meta?.width ?? 800;
  const h = meta?.height ?? 600;
  const slug = toSlug(meta?.title ?? "aio-app");
  return `
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
Menu.setApplicationMenu(null);
app.name = ${JSON.stringify(slug)};
${tmplCrashGuard()}
${tmplParentWatch()}

// ── Window state persistence ──
${tmplBounds()}

app.on('ready', () => {
  const b = loadBounds(${w}, ${h});
${tmplWindowShape(meta)}
  const win = new BrowserWindow(b);
  if (b.x == null) win.center();
${tmplBoundsTracking()}
  win.loadURL(${JSON.stringify(url)});
  const _appOrigin = new URL(${JSON.stringify(url)}).origin;
${tmplWillNavigate("_appOrigin")}
  // Accept the self-signed cert aio --expose generates for THIS app's own
  // origin — and nothing else. The check must read the URL that FAILED (arg 3);
  // re-parsing the app's own URL made the condition a constant true for every
  // local launch, so any cert error from any host (an intercepting proxy on a
  // hostile network answering the page's fetch to a third-party API) was
  // silently trusted.
  app.on('certificate-error', (event, _wc, failedUrl, _err, _cert, cb) => {
    let sameOrigin = false;
    try { sameOrigin = new URL(failedUrl).origin === new URL(${
    JSON.stringify(url)
  }).origin; } catch { sameOrigin = false; }
    if (sameOrigin) { event.preventDefault(); cb(true); }
    else cb(false);
  });
${tmplKeyboardShortcuts()}
});
app.on('window-all-closed', () => process.exit(0));
`.trim();
}
