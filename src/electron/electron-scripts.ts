// Electron main.cjs script generators — standard (WebSocket) and client modes

import { tmplSplash } from "./electron-splash.ts";
import {
  type AioMeta,
  shellBridgePreload,
  shellProfileName,
  tmplAppMenu,
  tmplBounds,
  tmplBoundsTracking,
  tmplCertificateGuard,
  tmplChromiumSwitches,
  tmplCrashGuard,
  tmplGuestPreloads,
  tmplIconFit,
  tmplIpcGuard,
  tmplKeyboardShortcuts,
  tmplParentWatch,
  tmplPermissionGuard,
  tmplPreloadCleanup,
  tmplPreloadWrite,
  tmplProfileDir,
  tmplRendererDiagnostics,
  tmplShowWhenPainted,
  tmplTray,
  tmplWebGuard,
  tmplWillNavigate,
  tmplWindowClass,
  tmplWindowShape,
  udsPreloadDiagnostics,
} from "./electron-shared.ts";

/** Generates a minimal Electron main.cjs that loads the given URL */
export function electronMainScript(url: string, meta?: AioMeta): string {
  const w = meta?.width ?? 800;
  const h = meta?.height ?? 600;
  // The userData directory — the title's slug, or the profile the
  // lifecycle derived from this run's HOME (electronProfileName).
  const slug = shellProfileName(meta);
  // The tray icon is the app's own monogram, fetched from the app itself —
  // the WebSocket shell has no app dir to read `icon.png` from.
  const trayIcon =
    `(async () => { const { net, nativeImage } = require('electron'); ` +
    `const r = await net.fetch(${
      // The icon ROUTE with the query kept — see electron-client-script's
      // connectTo: '/icon.png' appended to '?token=K' landed in the query.
      JSON.stringify((() => {
        const u = new URL(url);
        u.pathname = "/__aio/icon";
        return u.href;
      })())}); if (!r.ok) throw new Error('GET /__aio/icon answered HTTP ' + r.status); ` +
    `return nativeImage.createFromBuffer(Buffer.from(await r.arrayBuffer())); })()`;
  return `
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
${tmplChromiumSwitches()}${tmplWindowClass(meta)}${tmplAppMenu(meta?.title)}
// The shell bridge (focus, tray clicks, the window verbs) and the mount
// signal ("ui mounted N element(s)") — the ONLY preload this window has;
// it must not carry __aioIPC, whose presence would select the IPC transport.
// The name first: it decides the profile directory the preload is written to.
app.name = ${JSON.stringify(slug)};
${tmplProfileDir(meta?.profileDir)}${
    tmplPreloadWrite(
      JSON.stringify(
        shellBridgePreload({ standalone: true }) + udsPreloadDiagnostics(),
      ),
    )
  }
${tmplCrashGuard(meta?.confirmUnload)}
${tmplPermissionGuard(meta?.permissions)}
${tmplWebGuard(meta)}
${tmplIpcGuard()}
${tmplGuestPreloads(meta?.guestPreloads)}
${tmplParentWatch()}

// ── Window state persistence ──
${tmplBounds()}

app.on('ready', () => {
  const b = loadBounds(${w}, ${h});
${tmplSplash(meta?.splash)}
${tmplWindowShape(meta, { preload: "preloadFile" })}
  const win = new BrowserWindow(b);
  const _appOrigin = new URL(${JSON.stringify(url)}).origin;
  __aioIpcBind(win, _appOrigin); // before any handler can run (tmplIpcGuard)
${tmplShowWhenPainted(meta?.showWhenPainted)}
${tmplBoundsTracking()}
${tmplRendererDiagnostics(true)}
  // The window's own icon — the same one, fetched once. An X11 panel reads
  // it from the window: a dev window's class names no installed launcher,
  // so without it every aio app shows Electron's default icon.
${tmplIconFit()}
  const __aioIcon = Promise.resolve(${trayIcon}).then((i) => i && !i.isEmpty() ? __aioIconFit(i) : i);
  // Nothing said "this window has no icon" before: the default gear just
  // showed, and finding why meant reading this script. Said once, with why.
  const __aioNoIcon = (why) => console.warn("⚠ this window has no icon of its own — Electron's default shows: " + why);
  __aioIcon.then((i) => {
    if (!i || i.isEmpty()) return __aioNoIcon('/__aio/icon is not an image Electron can read');
    if (!win.isDestroyed()) win.setIcon(i);
  }, (e) => __aioNoIcon((e && e.message) || String(e)));
${tmplTray(meta, "__aioIcon", meta?.title)}
  win.loadURL(${JSON.stringify(url)});
${tmplWillNavigate("_appOrigin")}
${tmplCertificateGuard(url)}${tmplKeyboardShortcuts(meta?.shortcuts)}
});
app.on('window-all-closed', () => { ${tmplPreloadCleanup()} process.exit(0); });
`.trim();
}
