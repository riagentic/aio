/**
 * @module
 * The splash drawn by Electron's own main process — on Windows, whenever
 * Electron is already on the machine (a later start, a run from source, an
 * offline build). Windows' own helper (PowerShell + Windows Forms) needs
 * 0.9–2.4 s to paint (measured on Windows 11: PowerShell's start alone is
 * ~0.4 s) while Electron's window is ready 0.25–0.8 s after it starts, so the
 * helper's splash could only come late or not at all. The main process makes
 * the splash window FIRST, before the app's window, from a page that draws
 * the spec's look exactly as the helpers do (splash-place.ts `splashFrame`,
 * `fitRect`; `helperLook`): image, text, font, colours, corners, border,
 * text shadow. No download runs here (Electron is present), so there is no
 * bar and no ✕. The helper keeps the download (Electron not there yet).
 *
 * Linux and macOS keep GTK and Cocoa: both are on screen ~0.2 s after the app
 * starts, before Electron is even started.
 *
 * Nothing waits for it: the app's window shows the moment its page has
 * painted, as without a splash; the splash stays above it until it has been
 * on screen `minMs`, then fades (`fadeMs`); it follows the window
 * (`followWindow`), and goes after `maxMs` with no window.
 */
import { join } from "@std/path";
import { fitRect, splashFrame } from "./splash-place.ts";
import { helperLook, lookOf, type SplashSpec, splashText } from "./splash.ts";
import { MAIN_TAG } from "./electron-renderer-log.ts";

/** What the main script is handed (AioMeta `splash`). */
export type ElectronSplash = {
  /** The page's file (written by the aio process, removed when Electron
   *  exits). */
  page: string;
  /** The app's title (the window's, as the helpers' windows). */
  title: string;
  w: number;
  h: number;
  mode: "window" | "primary" | "pointer";
  follow: boolean;
  minMs: number;
  maxMs: number;
  fadeMs: number;
  windowShadow: boolean;
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** The splash's page and window size for `os`: the frame the helpers draw,
 *  laid out by the same rules. Pure. */
export function electronSplashPage(
  spec: SplashSpec,
  title: string,
  os: "windows" | "darwin" | "linux",
): { html: string; w: number; h: number } {
  const L = helperLook(spec, os);
  const f = spec.font;
  const px = f.size * 96 / 72;
  const text = spec.text === null ? "" : splashText(spec.text, title);
  // The text's line box (the helpers measure theirs; one line, 1.25 em).
  const lh = text ? Math.ceil(px * 1.25) : 0;
  const fr = splashFrame({ ...L, bp: 0 }, lh);
  const img = fitRect(L.iw, L.ih, L.w, L.h, L.fit);
  const family = f.family === null
    ? "system-ui,'Segoe UI',sans-serif"
    : `${JSON.stringify(f.family).replace(/</g, "\\3c ")},sans-serif`;
  const mode = (c: SplashSpec["light"]) =>
    `#s{background:${c.background}}#t{color:${c.text}}`;
  const css = `html,body{margin:0;width:${L.w}px;height:${fr.TH}px;` +
    `overflow:hidden;background:transparent}` +
    `#s{position:absolute;inset:0;overflow:hidden;` +
    `border-radius:${L.radius}px;box-sizing:border-box;` +
    (L.border ? `border:1px solid ${L.border};` : "") + `}` +
    `#s img{position:absolute;left:${img.x}px;top:${img.y}px;` +
    `width:${img.width}px;height:${img.height}px}` +
    `#t{position:absolute;left:${L.side}px;right:${L.side}px;` +
    `bottom:${fr.TH - fr.labelBottom}px;margin:0;text-align:${L.align};` +
    `white-space:nowrap;overflow:hidden;text-overflow:ellipsis;` +
    `font:${f.weight} ${f.size}pt ${family};line-height:${lh}px;` +
    `text-shadow:${L.shadow ? "0 1px 2px rgba(0,0,0,.45)" : "none"}}` +
    mode(spec.light) +
    `@media (prefers-color-scheme:dark){${mode(spec.dark)}}`;
  return {
    html:
      `<!doctype html><meta charset="utf-8"><title>${
        esc(title)
      }</title><style>${css}</style>` +
      `<div id="s"><img alt="" src="data:image/png;base64,${spec.image.png}">` +
      (text ? `<p id="t">${esc(text)}</p>` : "") + `</div>`,
    w: L.w,
    h: fr.TH,
  };
}

/** The main script's splash: made before the app's window (`__aioSplashOpen`
 *  right before `new BrowserWindow`), told when that window shows and where
 *  it is (`__aioSplashOnWindow`, from tmplShowWhenPainted). Every line it
 *  says is a `[aio:main:info]` line, logged by the aio process. Expects
 *  `centredOn`, `__aioPlaced`, `__aioPlacedOn` in scope. Empty without a
 *  splash. */
export function tmplSplash(s: ElectronSplash | null | undefined): string {
  if (!s) return "";
  const say = (m: string) =>
    `process.stderr.write(${
      JSON.stringify(`${MAIN_TAG}info] electron: splash — `)
    } + ${m} + '\\n')`;
  return `
const __aioSpl = ${JSON.stringify(s)};
let __aioSplWin = null, __aioSplAt = 0, __aioSplReady = false, __aioSplGone = false, __aioSplCap;
const __aioSplT0 = Date.now() - Math.round(process.uptime() * 1000);
function __aioSplashClose(why) {
  if (__aioSplGone) return;
  __aioSplGone = true;
  clearTimeout(__aioSplCap);
  const w = __aioSplWin;
  if (why === 'cap') ${
    say(
      `'closed after ' + (__aioSpl.maxMs / 1000) + ' s without the main window showing'`,
    )
  };
  else if (why) ${say(`'closed (' + why + ')'`)};
  if (!w || w.isDestroyed()) return;
  const n = Math.round(__aioSpl.fadeMs / 16);
  let i = 0;
  const step = () => {
    if (w.isDestroyed()) return;
    if (++i >= n) return w.destroy();
    try { w.setOpacity(1 - i / n); } catch {}
    setTimeout(step, 16);
  };
  n > 0 ? step() : w.destroy();
}
function __aioSplashPlace(r) {
  const { screen } = require('electron');
  if (__aioSpl.mode === 'window' && r) {
    const on = r.screen || screen.getDisplayMatching(r).workArea;
    return centredOn({ x: r.x, y: r.y, width: r.width, height: r.height, screen: on }, __aioSpl.w, __aioSpl.h);
  }
  const d = __aioSpl.mode === 'pointer'
    ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    : screen.getPrimaryDisplay();
  return centredOn({ ...d.workArea, screen: d.workArea }, __aioSpl.w, __aioSpl.h);
}
function __aioSplashOpen() {
  try {
    const { BrowserWindow } = require('electron');
    const at = __aioSplashPlace(__aioPlaced && { ...__aioPlaced, screen: __aioPlacedOn });
    const w = new BrowserWindow({
      x: at.x, y: at.y, width: __aioSpl.w, height: __aioSpl.h,
      show: false, frame: false, transparent: true, resizable: false,
      movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, focusable: false, alwaysOnTop: true,
      hasShadow: __aioSpl.windowShadow, title: __aioSpl.title,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
    });
    __aioSplWin = w;
    w.setAlwaysOnTop(true, 'floating');
    w.once('ready-to-show', () => {
      if (__aioSplGone || w.isDestroyed()) return;
      w.showInactive();
      __aioSplAt = Date.now();
      ${
    say(
      `'visible ' + (__aioSplAt - __aioSplT0) + ' ms after Electron started (Electron\\'s own window)'`,
    )
  };
      __aioSplashSettle();
      __aioSplCap = setTimeout(() => { if (!__aioSplReady) __aioSplashClose('cap'); }, __aioSpl.maxMs);
    });
    w.on('closed', () => { __aioSplGone = true; });
    w.loadFile(__aioSpl.page).catch((e) => ${
    say(`'not shown (' + (e && e.message || e) + ')'`)
  });
  } catch (e) {
    ${say(`'not shown (' + (e && e.message || e) + ')'`)};
  }
}
// Closed once the app's window is up AND the splash has been on screen minMs.
function __aioSplashSettle() {
  if (__aioSplGone || !__aioSplReady || !__aioSplAt) return;
  const left = __aioSplAt + __aioSpl.minMs - Date.now();
  if (left > 0) setTimeout(__aioSplashSettle, left);
  else __aioSplashClose('ready');
}
// From tmplShowWhenPainted: the app's window shows (first) or moved, at \`at\`.
function __aioSplashOnWindow(at, first) {
  if (__aioSplGone) return;
  if (first) {
    __aioSplReady = true;
    ${
    say(
      `(__aioSplAt ? 'the app\\'s window shows ' + (Date.now() - __aioSplAt) + ' ms after the splash appeared' : 'the app\\'s window shows BEFORE the splash painted')`,
    )
  };
    __aioSplashSettle();
  }
  if (__aioSpl.mode === 'window' && __aioSpl.follow && __aioSplWin && !__aioSplWin.isDestroyed()) {
    try { const p = __aioSplashPlace(at); __aioSplWin.setPosition(p.x, p.y); } catch {}
  }
}
__aioSplashOpen();
`;
}

/** The page written to a fresh temporary folder, and what the main script is
 *  handed. The caller removes `dir` when Electron exits. */
export async function electronSplashFor(
  spec: SplashSpec,
  title: string,
  os: "windows" | "darwin" | "linux",
): Promise<{ splash: ElectronSplash; dir: string }> {
  const p = electronSplashPage(spec, title, os);
  const L = helperLook(spec, os);
  const l = lookOf(spec);
  const dir = await Deno.makeTempDir({ prefix: "aio-splash-" });
  const page = join(dir, "splash.html");
  await Deno.writeTextFile(page, p.html);
  return {
    dir,
    splash: {
      page,
      title,
      w: p.w,
      h: p.h,
      mode: L.mode,
      follow: l.followWindow !== false,
      minMs: spec.minMs,
      maxMs: l.maxMs,
      fadeMs: L.fadeMs,
      windowShadow: L.windowShadow,
    },
  };
}
