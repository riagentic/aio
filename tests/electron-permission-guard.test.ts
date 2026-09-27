// 🔒 An embedded page gets no permissions.
//
// Electron's default permission handler grants every request, and aio never
// installed one. Field report (a crypto wallet built on aio): a page in its
// in-app browser — a `<webview>` — read, with `navigator.clipboard.readText()`
// and no prompt, the text the wallet window had just copied. Camera,
// microphone, geolocation and notifications were `granted` the same way.
//
// The guard runs in the main process on every session. These RUN the
// generated fragment against a fake `app`/session, so what is asserted is what
// the shell decides; the ELECTRON_E2E case at the bottom proves it in a real
// Electron with a real `<webview>`.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { tmplPermissionGuard } from "../src/electron/electron-shared.ts";
import { electronClientScript } from "../src/electron/electron-client-script.ts";
import { electronMainScript } from "../src/electron/electron-scripts.ts";
import { electronMainScriptUDS } from "../src/electron/electron-uds.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import type { ElectronPermissions } from "../src/server/aio-types.ts";
import { ELECTRON_PERMISSIONS } from "../src/server/config.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

type Req = (
  wc: unknown,
  permission: string,
  cb: (ok: boolean) => void,
  details?: { requestingUrl?: string },
) => void;
type Check = (wc: unknown, permission: string, origin: string) => boolean;
type Ses = { request?: Req; check?: Check };

function fakeMain(allow: ElectronPermissions | null = null) {
  const on: Record<string, (s?: unknown) => void> = {};
  const warnings: string[] = [];
  const mkSession = (): Ses & {
    setPermissionRequestHandler(f: Req): void;
    setPermissionCheckHandler(f: Check): void;
  } => {
    const s: Ses = {};
    return Object.assign(s, {
      setPermissionRequestHandler(f: Req) {
        s.request = f;
      },
      setPermissionCheckHandler(f: Check) {
        s.check = f;
      },
    });
  };
  const defaultSession = mkSession();
  const app = {
    on(ev: string, f: (s?: unknown) => void) {
      on[ev] = f;
    },
  };
  const markChild = new Function(
    "app",
    "require",
    "console",
    tmplPermissionGuard(allow) +
      "\nreturn (wc) => __aioChildWindows.add(wc);",
  )(
    app,
    () => ({ session: { defaultSession } }),
    { warn: (m: unknown) => warnings.push(String(m)), error() {}, log() {} },
  );
  return {
    defaultSession,
    mkSession,
    created: (s: unknown) => on["session-created"]!(s),
    ready: () => on["ready"]!(),
    markChild: markChild as (wc: unknown) => void,
    warnings,
  };
}

const APP = "http://127.0.0.1:4321";
const win = (url = APP + "/") => ({
  getType: () => "window",
  getURL: () => url,
});
const guest = {
  getType: () => "webview",
  getURL: () => "https://dapp.example/",
};
const ask = (s: Ses, wc: unknown, perm: string, url?: string) => {
  let got: boolean | undefined;
  s.request!(wc, perm, (ok) => got = ok, url ? { requestingUrl: url } : {});
  return got;
};

Deno.test("permissions: a <webview> guest is denied clipboard-read and friends, and it is said once", async () => {
  const m = fakeMain();
  await m.ready();
  const s = m.defaultSession;
  const perms = [
    "clipboard-read",
    "clipboard-sanitized-write",
    "media",
    "geolocation",
    "notifications",
  ];
  for (const p of perms) {
    assertEquals(ask(s, guest, p, "https://dapp.example/"), false, p);
    assertEquals(s.check!(guest, p, "https://dapp.example"), false, p);
  }
  ask(s, guest, "clipboard-read", "https://dapp.example/");
  assertEquals(m.warnings.length, perms.length, m.warnings.join("\n"));
  assertStringIncludes(m.warnings[0]!, 'permission "clipboard-read" DENIED');
  // A video player's fullscreen button still works.
  assertEquals(ask(s, guest, "fullscreen", "https://dapp.example/"), true);
});

Deno.test("permissions: the app's own page keeps them; a foreign or data: frame in it does not", async () => {
  const m = fakeMain();
  await m.ready();
  const s = m.defaultSession;
  assertEquals(ask(s, win(), "clipboard-sanitized-write", APP + "/x"), true);
  // Without electron.permissions an openWindow child window keeps what its
  // own origin asks for (1.0.12, frozen); a frame from elsewhere in it does not.
  const dapp = win("https://dapp.example/");
  m.markChild(dapp);
  for (const p of ["clipboard-read", "media", "geolocation", "notifications"]) {
    assertEquals(ask(s, dapp, p, "https://dapp.example/"), true, p);
    assertEquals(s.check!(dapp, p, "https://dapp.example"), true, p);
    assertEquals(ask(s, dapp, p, "https://ads.example/"), false, p);
  }
  assertEquals(s.check!(win(), "clipboard-read", APP), true);
  assertEquals(ask(s, win(), "media", "https://evil.example/"), false);
  assertEquals(
    s.check!(win(), "clipboard-read", "https://evil.example"),
    false,
  );
  assertEquals(ask(s, win(), "clipboard-read", "data:text/html,x"), false);
  // A custom-scheme app (origin "null") is still its own origin.
  const own = win("aio://app/index.html");
  assertEquals(s.check!(own, "clipboard-read", "aio://app"), true);
  assertEquals(s.check!(own, "clipboard-read", "data:text/html,x"), false);
  // No webContents at all (a cross-origin subframe check) is not the app.
  assertEquals(s.check!(null, "clipboard-read", APP), false);
});

// A page that only QUERIES (navigator.permissions.query, Notification.permission)
// hits the check handler, never the request one: that refusal was silent.
Deno.test("permissions: a denied CHECK is said once per origin and permission; an allowed one stays quiet", async () => {
  const m = fakeMain();
  await m.ready();
  const s = m.defaultSession;
  for (let i = 0; i < 50; i++) {
    assertEquals(
      s.check!(guest, "clipboard-read", "https://dapp.example"),
      false,
    );
    assertEquals(s.check!(win(), "clipboard-read", APP), true);
    assertEquals(s.check!(win(), "fullscreen", "https://dapp.example"), true);
  }
  assertEquals(m.warnings.length, 1, m.warnings.join("\n"));
  assertStringIncludes(
    m.warnings[0]!,
    'permission "clipboard-read" DENIED to embedded page https://dapp.example',
  );
  // The later request from that origin says nothing new; another origin does.
  ask(s, guest, "clipboard-read", "https://dapp.example/deep/page");
  s.check!(guest, "clipboard-read", "https://other.example");
  assertEquals(m.warnings.length, 2, m.warnings.join("\n"));

  // With electron.permissions the app page's unlisted check names the fix;
  // a listed one is quiet.
  const st = fakeMain({ "clipboard-sanitized-write": ["app"] });
  await st.ready();
  const own = win("aio://app/index.html");
  for (let i = 0; i < 20; i++) {
    st.defaultSession.check!(own, "clipboard-sanitized-write", "aio://app");
    st.defaultSession.check!(own, "notifications", "aio://app");
    // Chromium checks these by itself at every load and navigation, with the
    // page's origin or none (measured in a packaged AppImage): not said. Their
    // real use is a request, and that is.
    for (const p of ["media", "web-app-installation", "geolocation"]) {
      assertEquals(st.defaultSession.check!(own, p, "aio://app/"), false, p);
      assertEquals(st.defaultSession.check!(own, p, ""), false, p);
    }
  }
  assertEquals(st.warnings.length, 1, st.warnings.join("\n"));
  assertStringIncludes(
    st.warnings[0]!,
    '"notifications" DENIED to the app\'s own page aio://app — electron.permissions does not grant it; add "notifications": ["app"]',
  );
  ask(st.defaultSession, own, "geolocation", "aio://app/");
  assertEquals(st.warnings.length, 2, st.warnings.join("\n"));
  assertStringIncludes(st.warnings[1]!, '"geolocation" DENIED');
});

Deno.test("permissions: a denial names the origin only — never the app's key — and the lines are bounded", async () => {
  const m = fakeMain({ "clipboard-sanitized-write": ["app"] });
  await m.ready();
  const s = m.defaultSession;
  const keyed = APP + "/?token=SECRETKEY123";
  ask(s, win(keyed), "notifications", keyed);
  ask(s, guest, "geolocation", "https://dapp.example/?token=SECRETKEY123");
  assertEquals(m.warnings.length, 2, m.warnings.join("\n"));
  for (const w of m.warnings) assert(!w.includes("SECRETKEY123"), w);
  assertStringIncludes(m.warnings[0]!, "the app's own page " + APP + " —");
  // 2 origins x 100 pages: one line per origin, not per URL.
  for (let i = 0; i < 100; i++) {
    for (const o of ["https://a.example", "https://b.example"]) {
      ask(s, guest, "media", `${o}/p${i}?q=${i}`);
    }
  }
  assertEquals(m.warnings.length, 4, m.warnings.join("\n"));
  // A guest browsing without end: the set (and app.log) stays bounded.
  for (let i = 0; i < 1000; i++) {
    s.check!(guest, "clipboard-read", `https://site${i}.example`);
  }
  assertEquals(m.warnings.length, 257);
  assertStringIncludes(
    m.warnings[256]!,
    "further ones are refused without a line",
  );
});

Deno.test("permissions: every session is guarded — a <webview> partition too, once each", async () => {
  const m = fakeMain();
  const part = m.mkSession();
  m.created(part);
  m.created(part);
  assert(part.request && part.check, "a new partition got no handlers");
  assertEquals(
    ask(part, guest, "clipboard-read", "https://dapp.example/"),
    false,
  );
  assertEquals(m.defaultSession.request, undefined, "installed before ready");
  await m.ready();
  assert(m.defaultSession.request, "the default session is never guarded");
});

Deno.test("permissions: all three generated Electron mains install the guard", () => {
  const mains = {
    client: electronClientScript(null),
    app: electronMainScript("http://127.0.0.1:1/"),
    uds: electronMainScriptUDS("http://127.0.0.1:1/", "/tmp/x.sock", {}),
  };
  for (const [name, src] of Object.entries(mains)) {
    assertEquals(
      src.split("setPermissionRequestHandler(").length - 1,
      1,
      `${name} main`,
    );
    assertStringIncludes(src, "app.on('session-created', __aioGuardSession)");
    assertStringIncludes(src, "const __aioPermAllow = null;", name);
  }
});

Deno.test("permissions: electron.permissions reaches both app mains (dev and packaged share the UDS one)", () => {
  const permissions = { "clipboard-sanitized-write": ["app"] as const };
  const want = `const __aioPermAllow = ${JSON.stringify(permissions)};`;
  assertStringIncludes(
    electronMainScript("http://127.0.0.1:1/", { permissions }),
    want,
  );
  const uds = electronMainScriptUDS("http://127.0.0.1:1/", "/tmp/x.sock", {
    meta: { permissions },
  });
  assertStringIncludes(uds, want);
  // …and the one place a child window is made marks it as not the app.
  assertEquals(uds.split("new BrowserWindow(").length - 1, 2);
  assertStringIncludes(uds, "__aioChildWindows.add(child.webContents);");
});

Deno.test("permissions: with electron.permissions the app page gets exactly the list, a guest nothing — each denial said", async () => {
  const m = fakeMain({ "clipboard-sanitized-write": ["app"], media: [] });
  await m.ready();
  const s = m.defaultSession;
  assertEquals(ask(s, win(), "clipboard-sanitized-write", APP + "/"), true);
  assertEquals(s.check!(win(), "clipboard-sanitized-write", APP), true);
  for (const p of ["clipboard-read", "media", "notifications", "fullscreen"]) {
    assertEquals(ask(s, win(), p, APP + "/"), false, p);
    assertEquals(s.check!(win(), p, APP), false, p);
  }
  // The listed one is still the app's own page only.
  assertEquals(
    ask(s, win(), "clipboard-sanitized-write", "https://evil.example/"),
    false,
  );
  for (const p of ["clipboard-sanitized-write", "fullscreen", "media"]) {
    assertEquals(ask(s, guest, p, "https://dapp.example/"), false, p);
  }
  // A key Object.prototype carries is not a grant.
  assertEquals(ask(s, win(), "constructor", APP + "/"), false);
  // An openWindow child window shows someone else's site: never "app".
  const dapp = win("https://dapp.example/");
  m.markChild(dapp);
  assertEquals(
    ask(s, dapp, "clipboard-sanitized-write", "https://dapp.example/"),
    false,
  );
  assertEquals(
    s.check!(dapp, "clipboard-sanitized-write", "https://dapp.example"),
    false,
  );
  const own = m.warnings.find((w) => w.includes('"clipboard-read" DENIED'));
  assertStringIncludes(own!, "the app's own page");
  assertStringIncludes(own!, '"clipboard-read": ["app"]');
});

Deno.test("permissions: the accepted names are exactly the installed Electron's", async (t) => {
  let dts: string;
  try {
    dts = await Deno.readTextFile(
      join(
        Deno.realPathSync("node_modules/.bin/electron"),
        "..",
        "electron.d.ts",
      ),
    );
  } catch {
    return void await t.step({
      name: "Electron not installed",
      ignore: true,
      fn() {},
    });
  }
  const union = dts.match(
    /setPermissionRequestHandler\(handler: \(\(webContents: WebContents, permission: ([^,]+),/,
  );
  assert(union, "electron.d.ts no longer spells the handler this way");
  const names = [...union[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assertEquals([...ELECTRON_PERMISSIONS].sort(), names.sort());
});

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

// What a page sees: the check handler answers `permissions.query`, the
// request handler answers a real ask. Runs with a user gesture, focused.
const PAGE_PROBE = `(async () => {
  // A step that never settles says so instead of timing the whole run out.
  const t = (p) => Promise.race([p, new Promise((ok) => setTimeout(() => ok('hang'), 5000))]);
  const no = (e) => e && e.name === 'NotAllowedError' ? 'denied' : 'error: ' + e;
  const q = {};
  for (const n of ['clipboard-read', 'geolocation', 'notifications', 'camera', 'microphone']) {
    q[n] = await t(navigator.permissions.query({ name: n }).then((r) => r.state, no));
  }
  const media = (c) => t(navigator.mediaDevices.getUserMedia(c).then(
    (s) => { s.getTracks().forEach((x) => x.stop()); return 'granted'; }, no));
  const a = {};
  a['clipboard-read'] = await t(navigator.clipboard.readText().then((x) => 'read: ' + x, no));
  a.notifications = await t(Notification.requestPermission());
  a.camera = await media({ video: true });
  a.microphone = await media({ audio: true });
  // code 1 = PERMISSION_DENIED; 2/3 mean the permission passed and only
  // the position itself was unavailable on this box.
  a.geolocation = await t(new Promise((ok) => navigator.geolocation.getCurrentPosition(
    () => ok('granted'), (e) => ok(e.code === 1 ? 'denied' : 'granted'), { timeout: 3000 })));
  // A denied fullscreen never settles its promise here — read the outcome.
  document.documentElement.requestFullscreen().catch(() => {});
  await new Promise((ok) => setTimeout(ok, 1500));
  a.fullscreen = document.fullscreenElement ? 'granted' : 'denied';
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  return { q, a };
})()`;

type PageView = {
  q: Record<string, string>;
  a: Record<string, string>;
  focused: boolean;
};

/** `guard`: false = no guard at all (the control), null = the default,
 *  an object = `electron.permissions`. */
async function runPermProbe(guard: false | null | ElectronPermissions) {
  const dir = await tempDir("aio-perm-e2e-");
  try {
    // Two local servers = two origins: the app page embeds a FOREIGN guest.
    const main = `
const { app, BrowserWindow, clipboard } = require('electron');
const http = require('http');
${guard === false ? "" : tmplPermissionGuard(guard)}
const out = (o) => { console.log('RESULT ' + JSON.stringify(o)); app.exit(0); };
setTimeout(() => out({ error: 'timeout' }), 40000);
const serve = (html) => new Promise((ok) => {
  const s = http.createServer((_q, res) => { res.setHeader('content-type', 'text/html'); res.end(html()); });
  s.listen(0, '127.0.0.1', () => ok('http://127.0.0.1:' + s.address().port + '/'));
});
app.whenReady().then(async () => {
  // What the app window just copied — a seed phrase, in the field report.
  clipboard.writeText('SECRET-MARKER-12345');
  const guestUrl = await serve(() => '<h1>guest</h1>');
  // A third origin, framed by the app page itself — delegated every feature
  // (\`allow\`), so only the guard stands between it and the clipboard.
  const frameUrl = await serve(() => '<h1>frame</h1>');
  const hostUrl = await serve(() => '<webview src="' + guestUrl + '" style="width:300px;height:200px"></webview>' +
    '<iframe src="' + frameUrl + '" allow="clipboard-read; clipboard-write; camera; microphone; geolocation; fullscreen"></iframe>');
  const win = new BrowserWindow({ width: 400, height: 300, webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false } });
  // A clipboard read needs a focused document — \`focused\` proves it had one,
  // so a "denied" read is the guard and never a focus artefact.
  const settle = () => new Promise((ok) => setTimeout(ok, 300));
  const run = (wc, js) =>
    wc.executeJavaScript('document.hasFocus()', true).then((focused) =>
      wc.executeJavaScript(js, true).then((r) => ({ ...r, focused })))
      .catch((e) => 'threw: ' + e);
  win.webContents.on('did-attach-webview', (_e, g) => {
    g.on('did-finish-load', async () => {
      // The user clicks into the embedded page — all the field report needed.
      win.focus();
      await win.webContents.executeJavaScript("document.querySelector('webview').focus()", true);
      g.focus();
      await settle();
      const guest = await run(g, ${JSON.stringify(PAGE_PROBE)});
      await win.webContents.executeJavaScript('document.activeElement.blur()', true);
      win.webContents.focus();
      await settle();
      const own = await run(win.webContents, ${JSON.stringify(PAGE_PROBE)});
      // The user clicks into the framed page.
      await win.webContents.executeJavaScript("document.querySelector('iframe').focus()", true);
      await settle();
      const f = win.webContents.mainFrame.frames.find((x) => x.url === frameUrl);
      const frame = f ? await run(f, ${
      JSON.stringify(PAGE_PROBE)
    }) : 'no frame';
      out({ guest, own, frame });
    });
  });
  win.loadURL(hostUrl);
});`;
    const file = join(dir, "main.cjs");
    await Deno.writeTextFile(file, main);
    const { stdout, stderr } = await new Deno.Command(ELECTRON_BIN, {
      // Fake camera + microphone, so a GRANT is visible on a box with none.
      args: [file, "--no-sandbox", "--use-fake-device-for-media-stream"],
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
    for (const p of ["guest", "own", "frame"]) {
      assertEquals(
        r[p].focused,
        true,
        `the ${p} page never had focus: ${JSON.stringify(r[p])}`,
      );
    }
    return r as { guest: PageView; own: PageView; frame: PageView };
  } finally {
    await dropTempDir(dir);
  }
}

const E2E = {
  ignore: e2eSkip() !== null,
  sanitizeResources: false, // aio-ok: a real Electron child owns the sockets and timers; teardown stops it
  sanitizeOps: false, // aio-ok: a real Electron child owns the sockets and timers; teardown stops it
};

const QUERIED = [
  "clipboard-read",
  "geolocation",
  "notifications",
  "camera",
  "microphone",
];
const ASKED = [...QUERIED, "fullscreen"];
const all = (names: string[], v: string) =>
  Object.fromEntries(names.map((n) => [n, v]));
/** The page's answers, a clipboard read shown as granted/denied. */
const asks = (p: PageView) =>
  Object.fromEntries(
    Object.entries(p.a).map((
      [k, v],
    ) => [k, v === "read: SECRET-MARKER-12345" ? "granted" : v]),
  );

Deno.test({
  ...E2E,
  name:
    "permissions e2e control: WITHOUT the guard a foreign <webview> guest and a foreign iframe are granted everything and read the clipboard",
  async fn() {
    const r = await runPermProbe(false);
    for (const p of [r.guest, r.frame]) {
      assertEquals(p.q, all(QUERIED, "granted"));
      assertEquals(p.a["clipboard-read"], "read: SECRET-MARKER-12345");
      assertEquals(asks(p), all(ASKED, "granted"));
    }
  },
});

Deno.test({
  ...E2E,
  name:
    "permissions e2e: default — a real foreign <webview> guest and a foreign iframe in the app window are denied everything but fullscreen; the app window keeps all",
  async fn() {
    const r = await runPermProbe(null);
    for (const p of [r.guest, r.frame]) {
      assertEquals(p.q, all(QUERIED, "denied"));
      assertEquals(asks(p), {
        ...all(QUERIED, "denied"),
        fullscreen: "granted",
      });
    }
    // The app's own page keeps what 1.0.11 gave it.
    assertEquals(r.own.q, all(QUERIED, "granted"));
    assertEquals(asks(r.own), all(ASKED, "granted"));
  },
});

Deno.test({
  ...E2E,
  name:
    "permissions e2e: electron.permissions — the app window gets exactly the list, a guest gets nothing (not even fullscreen)",
  async fn() {
    const r = await runPermProbe({
      "clipboard-read": ["app"],
      notifications: ["app"],
    });
    for (const p of [r.guest, r.frame]) {
      assertEquals(p.q, all(QUERIED, "denied"));
      assertEquals(asks(p), all(ASKED, "denied"));
    }
    assertEquals(r.own.q, {
      ...all(QUERIED, "denied"),
      "clipboard-read": "granted",
      notifications: "granted",
    });
    assertEquals(asks(r.own), {
      ...all(ASKED, "denied"),
      "clipboard-read": "granted",
      notifications: "granted",
    });
  },
});
