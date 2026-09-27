// 🔒 The IPC guard, measured in a real Electron — the one proof a fake cannot
// give. A guard that refuses the app's OWN page bricks every app, so this
// runs the generated tmplPermissionGuard + tmplIpcGuard + tmplWillNavigate in
// a real main process on the nested test display (never the user's) and
// asks, on both shells (http and the privileged aio:// scheme):
//   (a) the window's top frame on the app origin — IPC answered;
//   (b) a <webview> guest and a subframe with the same preload — refused;
//   (c) will-redirect — the event shape the guard reads (Electron >= 25
//       details object), a same-app URL that 302s to another site LOADS in
//       the window as in 1.0.12, and that site then gets neither IPC nor the
//       app's permissions.
// Unit-level twin: electron-ipc-sender-guard.test.ts.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  tmplIpcGuard,
  tmplPermissionGuard,
  tmplWillNavigate,
} from "../src/electron/electron-shared.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ELECTRON_BIN = "node_modules/.bin/electron";
function e2eSkip(): string | null {
  try {
    Deno.statSync(ELECTRON_BIN);
  } catch {
    return "Electron not installed";
  }
  if (!Deno.env.get("ELECTRON_E2E")) return "set ELECTRON_E2E=1 to run";
  if (!testDisplayEnv().DISPLAY) return "no nested test display";
  return null;
}

const PRELOAD = `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('__probe', (tag) => ipcRenderer.invoke('probe', tag)
  .then((r) => r, (e) => 'refused: ' + String((e && e.message) || e)));
`;

function mainScript(dir: string, scheme: "http" | "aio"): string {
  return `
const { app, BrowserWindow, protocol } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const BASE_DIR = ${JSON.stringify(dir)};
const PRELOAD = path.join(BASE_DIR, 'preload.js');
${
    scheme === "aio"
      ? `protocol.registerSchemesAsPrivileged([{ scheme: 'aio', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);`
      : ""
  }
${tmplPermissionGuard(null)}
${tmplIpcGuard()}
ipcMain.handle('probe', (_e, tag) => 'ok:' + tag);
// Never the real system browser: record what the shell would open.
const opened = [];
require('electron').shell.openExternal = (u) => { opened.push(u); return Promise.resolve(); };
const out = (o) => { console.log('RESULT ' + JSON.stringify(o)); app.exit(0); };
setTimeout(() => out({ error: 'timeout' }), 45000);
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const serve = (fn) => new Promise((ok) => {
  const s = http.createServer((q, res) => fn(q, res));
  s.listen(0, '127.0.0.1', () => ok('http://127.0.0.1:' + s.address().port));
});
const html = (res, body) => { res.setHeader('content-type', 'text/html'); res.end(body); };
app.whenReady().then(async () => {
  // Another site: the guest, the framed page and the "identity provider".
  const foreign = await serve((q, res) => {
    if (q.url === '/r302') { res.statusCode = 302; res.setHeader('location', '/frame'); return res.end(); }
    // The identity provider's own login form, and its answer: back to the
    // app's callback.
    if (q.url === '/idp/login') { res.statusCode = 302; res.setHeader('location', appUrl + '/__aio/auth/oidc/callback?code=c'); return res.end(); }
    if (q.url === '/idp') return html(res, '<form id="f" method="post" action="/idp/login"><input name="u" value="me"></form>');
    html(res, '<h1>' + q.url + '</h1>');
  });
  const page = '<h1>app</h1><webview src="' + foreign + '/guest" preload="file://' + PRELOAD +
    '" style="width:200px;height:100px"></webview><iframe src="' + foreign + '/r302"></iframe>' +
    // aio's SSO button (browser-auth-ui.ts), its click handler verbatim.
    '<a id="sso" href="/__aio/auth/oidc/start" onclick="event.preventDefault();' +
    ' const r = encodeURIComponent(location.pathname + location.search);' +
    ' location.href = \\'/__aio/auth/oidc/start?redirect=\\' + r;">SSO</a>';
  const ssoHits = [];
  let appUrl;
  if (${JSON.stringify(scheme)} === 'aio') {
    protocol.handle('aio', () => new Response(page, { headers: { 'content-type': 'text/html' } }));
    appUrl = 'aio://app';
  } else {
    appUrl = await serve((q, res) => {
      if (q.url.startsWith('/__aio/auth/oidc/start')) ssoHits.push(q.url);
      if (q.url.startsWith('/__aio/auth/oidc/callback')) ssoHits.push(q.url);
      const to = q.url.startsWith('/__aio/auth/oidc/start')
        ? foreign + '/idp'
        : q.url.startsWith('/__aio/auth/oidc/callback')
        ? '/'
        : { '/login': foreign + '/idp', '/back': '/' }[q.url];
      if (to) { res.statusCode = 302; res.setHeader('location', to); return res.end(); }
      html(res, page);
    });
  }
  const win = new BrowserWindow({ width: 500, height: 400, show: true, webPreferences: {
    preload: PRELOAD, contextIsolation: true, nodeIntegrationInSubFrames: true, webviewTag: true } });
  const _appOrigin = appUrl;
  __aioIpcBind(win, _appOrigin);
  ${tmplWillNavigate("_appOrigin")}
  // What will-redirect hands a listener, as the guard reads it.
  const redirects = [];
  win.webContents.on('will-redirect', (e, ...a) => redirects.push({
    url: e.url, isMainFrame: e.isMainFrame, positional: a.map((x) => typeof x) }));
  let guest = null;
  win.webContents.on('did-attach-webview', (_e, g) => { guest = g; });
  const loaded = (u) => new Promise((ok) => {
    win.webContents.once('did-finish-load', ok);
    win.loadURL(u);
  });
  const top = (js) => win.webContents.executeJavaScript(js, true).catch((e) => 'threw: ' + e);
  const until = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await wait(100); return fn(); };
  await loaded(appUrl + '/');
  const r = { scheme: ${JSON.stringify(scheme)} };
  r.top = await top("window.__probe('top')");
  r.topNotifications = await top("navigator.permissions.query({ name: 'notifications' }).then((x) => x.state)");
  const frame = await until(() => win.webContents.mainFrame.frames.find((f) => f.url.endsWith('/frame')));
  r.frame = frame ? await frame.executeJavaScript("window.__probe ? window.__probe('frame') : 'no preload'", true) : 'no frame';
  await until(() => guest && guest.getURL().endsWith('/guest') && !guest.isLoading());
  r.guest = guest ? await guest.executeJavaScript("window.__probe ? window.__probe('guest') : 'no preload'", true) : 'no guest';
  if (r.scheme === 'http') {
    // The user clicks aio's SSO button: a page-initiated same-app navigation.
    const landed = new Promise((ok) => win.webContents.once('did-finish-load', ok));
    await top("document.getElementById('sso').click()");
    await Promise.race([landed, wait(5000)]);
    r.ssoButton = { hits: ssoHits.slice(), url: win.webContents.getURL(),
      ipc: await top("window.__probe('sso')") };
    // …and signs in THERE: the provider's own form loads in the window (it
    // is not the app's link to decide), whose answer returns to the app.
    const back = new Promise((ok) => win.webContents.on('did-finish-load', () => {
      if (win.webContents.getURL() === appUrl + '/') ok();
    }));
    await top("document.getElementById('f').submit()");
    await Promise.race([back, wait(5000)]);
    r.ssoDone = { hits: ssoHits.slice(1), url: win.webContents.getURL(),
      ipc: await top("window.__probe('signed-in')"), opened };
    await loaded(appUrl + '/');
    // An app's own login route that 302s to its identity provider.
    await loaded(appUrl + '/login');
    r.login = { url: win.webContents.getURL() };
    r.login.ipc = await top("window.__probe('idp')");
    r.login.notifications = await top("navigator.permissions.query({ name: 'notifications' }).then((x) => x.state)");
    await loaded(appUrl + '/back');
    r.back = { url: win.webContents.getURL(), ipc: await top("window.__probe('home')") };
  }
  r.redirects = redirects;
  r.appUrl = appUrl;
  r.foreign = foreign;
  out(r);
});`;
}

// deno-lint-ignore no-explicit-any
async function run(scheme: "http" | "aio"): Promise<{ r: any; err: string }> {
  const dir = Deno.realPathSync(await tempDir("aio-ipc-e2e-"));
  try {
    await Deno.writeTextFile(join(dir, "preload.js"), PRELOAD);
    const file = join(dir, "main.cjs");
    await Deno.writeTextFile(file, mainScript(dir, scheme));
    const { stdout, stderr } = await new Deno.Command(ELECTRON_BIN, {
      args: [file, "--no-sandbox"],
      // A main.cjs that throws shows a dialog and never exits: bound it.
      signal: AbortSignal.timeout(90_000),
      env: { ...testDisplayEnv(), ELECTRON_ENABLE_LOGGING: "0" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const err = new TextDecoder().decode(stderr);
    const line = new TextDecoder().decode(stdout).split("\n").find((l) =>
      l.startsWith("RESULT ")
    );
    assert(line, "no result: " + err.slice(-2000));
    const r = JSON.parse(line.slice(7));
    assertEquals(r.error, undefined, err.slice(-1500));
    return { r, err };
  } finally {
    await dropTempDir(dir);
  }
}

const E2E = {
  ignore: e2eSkip() !== null,
  sanitizeResources: false, // aio-ok: a real Electron child owns the sockets and timers; teardown stops it
  sanitizeOps: false, // aio-ok: a real Electron child owns the sockets and timers; teardown stops it
};

function assertOwnAndGuests(r: Record<string, unknown>, err: string) {
  // (a) the app's own page — the must-prove case.
  assertEquals(r.top, "ok:top", JSON.stringify(r));
  assertEquals(r.topNotifications, "granted");
  // (b) the same preload in a subframe and in a <webview> guest.
  assertStringIncludes(String(r.frame), "refused:", JSON.stringify(r));
  assertStringIncludes(String(r.frame), "a subframe");
  assertStringIncludes(String(r.guest), "refused:", JSON.stringify(r));
  assertStringIncludes(String(r.guest), "another window or a <webview> guest");
  assertStringIncludes(
    err,
    '[aio:electron] IPC "probe" REFUSED from a subframe',
  );
  assertStringIncludes(
    err,
    '[aio:electron] IPC "probe" REFUSED from another window or a <webview> guest',
  );
}

Deno.test({
  ...E2E,
  name:
    "ipc e2e (http shell): own top frame answered, guest + subframe refused, a login 302 loads in the window with no IPC",
  async fn() {
    const { r, err } = await run("http");
    assertOwnAndGuests(r, err);
    // (c) the shape the guard reads: a details object, url + isMainFrame.
    const sub = r.redirects.find((x: { url: string }) =>
      x.url.endsWith("/frame")
    );
    assertEquals(sub, {
      url: r.foreign + "/frame",
      isMainFrame: false,
      positional: ["string", "boolean", "boolean", "number", "number"],
    }, JSON.stringify(r.redirects));
    const login = r.redirects.find((x: { url: string }) =>
      x.url === r.foreign + "/idp"
    );
    assertEquals(login?.isMainFrame, true, JSON.stringify(r.redirects));
    // aio's SSO button reaches the server (1.0.12 handed it to the client
    // router, which pushState'd it — the server never saw it) and the
    // identity provider it redirects to loads in the window, without IPC.
    assertEquals(r.ssoButton.hits, ["/__aio/auth/oidc/start?redirect=%2F"]);
    assertEquals(r.ssoButton.url, r.foreign + "/idp");
    assertStringIncludes(r.ssoButton.ipc, "a page of another origin");
    // The provider's login form loads in the window and its answer reaches
    // the app's callback: the window is the app again, with its IPC (the
    // shell used to veto that form and hand it to the system browser).
    assertEquals(r.ssoDone, {
      hits: ["/__aio/auth/oidc/callback?code=c"],
      url: r.appUrl + "/",
      ipc: "ok:signed-in",
      opened: [],
    });
    // The login route's 302 LOADS in the window (1.0.12 behaviour kept)…
    assertEquals(r.login.url, r.foreign + "/idp");
    // …and the site there is not the app.
    assertStringIncludes(r.login.ipc, "refused:");
    assertStringIncludes(r.login.ipc, "a page of another origin");
    assertEquals(r.login.notifications, "denied");
    assertStringIncludes(
      err,
      "[aio:electron] a redirect took the app window to " + r.foreign,
    );
    // Back home, the app again.
    assertEquals(r.back, { url: r.appUrl + "/", ipc: "ok:home" });
  },
});

Deno.test({
  ...E2E,
  name:
    "ipc e2e (aio:// shell): own top frame answered, guest + subframe refused",
  async fn() {
    const { r, err } = await run("aio");
    assertEquals(r.appUrl, "aio://app");
    assertOwnAndGuests(r, err);
  },
});
