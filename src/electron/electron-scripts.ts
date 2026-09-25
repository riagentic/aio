// Electron main.cjs script generators — standard (WebSocket) and client modes

import {
  type AioMeta,
  shellBridgePreload,
  tmplBounds,
  tmplBoundsTracking,
  tmplCrashGuard,
  tmplKeyboardShortcuts,
  tmplParentWatch,
  tmplPermissionGuard,
  tmplPreloadCleanup,
  tmplPreloadWrite,
  tmplRendererDiagnostics,
  tmplTray,
  tmplWillNavigate,
  tmplWindowShape,
  toSlug,
} from "./electron-shared.ts";

/** Generates a minimal Electron main.cjs that loads the given URL */
export function electronMainScript(url: string, meta?: AioMeta): string {
  const w = meta?.width ?? 800;
  const h = meta?.height ?? 600;
  // The userData directory — the title's slug, or the profile the
  // lifecycle derived from this run's HOME (electronProfileName).
  const slug = meta?.profileName ?? toSlug(meta?.title ?? "aio-app");
  // The tray icon is the app's own monogram, fetched from the app itself —
  // the WebSocket shell has no app dir to read `icon.png` from.
  const trayIcon =
    `(async () => { const { net, nativeImage } = require('electron'); ` +
    `const r = await net.fetch(${
      JSON.stringify(url.replace(/\/$/, "") + "/icon.png")
    }); if (!r.ok) return null; ` +
    `return nativeImage.createFromBuffer(Buffer.from(await r.arrayBuffer())); })()`;
  return `
const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
Menu.setApplicationMenu(null);
// The shell bridge (focus, tray clicks) — the ONLY preload this window has;
// it must not carry __aioIPC, whose presence would select the IPC transport.
${tmplPreloadWrite(JSON.stringify(shellBridgePreload({ standalone: true })))}
app.name = ${JSON.stringify(slug)};
${tmplCrashGuard()}
${tmplPermissionGuard()}
${tmplParentWatch()}

// ── Window state persistence ──
${tmplBounds()}

app.on('ready', () => {
  const b = loadBounds(${w}, ${h});
${tmplWindowShape(meta, { preload: "preloadFile" })}
  const win = new BrowserWindow(b);
  if (b.x == null) win.center();
${tmplBoundsTracking()}
${tmplRendererDiagnostics(false)}
${tmplTray(meta, trayIcon, meta?.title)}
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
app.on('window-all-closed', () => { ${tmplPreloadCleanup()} process.exit(0); });
`.trim();
}
