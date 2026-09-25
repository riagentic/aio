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
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

type Req = (
  wc: unknown,
  permission: string,
  cb: (ok: boolean) => void,
  details?: { requestingUrl?: string },
) => void;
type Check = (wc: unknown, permission: string, origin: string) => boolean;
type Ses = { request?: Req; check?: Check };

function fakeMain() {
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
  new Function("app", "require", "console", tmplPermissionGuard())(
    app,
    () => ({ session: { defaultSession } }),
    { warn: (m: unknown) => warnings.push(String(m)), error() {}, log() {} },
  );
  return {
    defaultSession,
    mkSession,
    created: (s: unknown) => on["session-created"]!(s),
    ready: () => on["ready"]!(),
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
  }
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

async function runPermProbe(guard: boolean) {
  const dir = await tempDir("aio-perm-e2e-");
  try {
    const q =
      "Promise.all(['clipboard-read','geolocation','notifications'].map((n) => navigator.permissions.query({ name: n }).then((r) => r.state, (e) => 'error: ' + e)))";
    // Two local servers = two origins: the app page embeds a FOREIGN guest.
    const main = `
const { app, BrowserWindow } = require('electron');
const http = require('http');
${guard ? tmplPermissionGuard() : ""}
const out = (o) => { console.log('RESULT ' + JSON.stringify(o)); app.exit(0); };
setTimeout(() => out({ error: 'timeout' }), 20000);
const serve = (html) => new Promise((ok) => {
  const s = http.createServer((_q, res) => { res.setHeader('content-type', 'text/html'); res.end(html()); });
  s.listen(0, '127.0.0.1', () => ok('http://127.0.0.1:' + s.address().port + '/'));
});
app.whenReady().then(async () => {
  const guestUrl = await serve(() => '<h1>guest</h1>');
  const hostUrl = await serve(() => '<webview src="' + guestUrl + '" style="width:300px;height:200px"></webview>');
  const win = new BrowserWindow({ width: 400, height: 300, webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false } });
  const run = (wc, js) => wc.executeJavaScript(js, true).catch((e) => 'threw: ' + e);
  win.webContents.on('did-attach-webview', (_e, g) => {
    g.on('did-finish-load', async () => {
      // The check handler answers query(); the request handler answers a
      // real ask. (A clipboard READ needs a focused document, which a
      // window-manager-less test display never gives — so it is not probed.)
      const guest = await run(g, ${JSON.stringify(q)});
      const guestAsk = await run(g, "Notification.requestPermission()");
      const own = await run(win.webContents, ${JSON.stringify(q)});
      out({ guest, guestAsk, own });
    });
  });
  win.loadURL(hostUrl);
});`;
    const file = join(dir, "main.cjs");
    await Deno.writeTextFile(file, main);
    const { stdout, stderr } = await new Deno.Command(ELECTRON_BIN, {
      args: [file, "--no-sandbox"],
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
    return r as { guest: string[]; guestAsk: string; own: string[] };
  } finally {
    await dropTempDir(dir);
  }
}

const E2E = {
  ignore: e2eSkip() !== null,
  sanitizeResources: false, // aio-ok: a real Electron child owns the sockets and timers; teardown stops it
  sanitizeOps: false, // aio-ok: a real Electron child owns the sockets and timers; teardown stops it
};

Deno.test({
  ...E2E,
  name:
    "permissions e2e control: WITHOUT the guard a foreign <webview> guest is granted everything (the probe can see a leak)",
  async fn() {
    const r = await runPermProbe(false);
    assertEquals(r.guest, ["granted", "granted", "granted"]);
    assertEquals(r.guestAsk, "granted");
  },
});

Deno.test({
  ...E2E,
  name:
    "permissions e2e: a real foreign <webview> guest is denied clipboard-read, geolocation and notifications the app window keeps",
  async fn() {
    const r = await runPermProbe(true);
    assertEquals(r.guest, ["denied", "denied", "denied"]);
    assertEquals(r.guestAsk, "denied");
    // The app's own page keeps what 1.0.11 gave it.
    assertEquals(r.own, ["granted", "granted", "granted"]);
  },
});
