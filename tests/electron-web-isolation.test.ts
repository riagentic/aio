// 🔒 Embedded and child web content: what a page that is not the app may do.
//
// A field report's audit of third-party pages inside an aio desktop app (a
// `<webview>` guest, an `openWindow` child window) listed what was left to
// Electron's defaults: pop-ups, navigation, downloads, device requests, the
// session a child window lives in, and no way to wipe a guest's storage.
//
// The first half RUNS the generated fragments against a fake Electron, so what
// is asserted is what the shell decides. The second half (ELECTRON_E2E=1) asks
// a real Electron on the nested test display — every claim there is about what
// Electron does, and a stub that agrees with a guess is not evidence. Its
// control case is the measurement the rules stand on: without them, a page in
// a `<webview>` with no partition reads what the app serves on aio://.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  shellBridgePreload,
  tmplIpcGuard,
  tmplPermissionGuard,
  tmplWebGuard,
  tmplWillNavigate,
  tmplWindowShape,
} from "../src/electron/electron-shared.ts";
import { electronMainScript } from "../src/electron/electron-scripts.ts";
import { electronClientScript } from "../src/electron/electron-client-script.ts";
import { contentSecurityPolicy } from "../src/server/security-headers.ts";
import { electronMainScriptUDS } from "../src/electron/electron-uds.ts";
import { VALID_ELECTRON_KEYS } from "../src/server/config.ts";
import type { ElectronPermissions } from "../src/server/aio-types.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

// deno-lint-ignore no-explicit-any
type Fn = (...a: any[]) => any;
const APP = "aio://app";

/** A fake webContents: records its listeners and its window-open handler. */
function mkWc(type: string, url: string) {
  const on: Record<string, Fn[]> = {};
  const wc = {
    url,
    open: null as Fn | null,
    getType: () => type,
    getURL: () => wc.url,
    session: undefined as unknown,
    on: (ev: string, f: Fn) => void (on[ev] ??= []).push(f),
    once: (ev: string, f: Fn) => void (on[ev] ??= []).push(f),
    setWindowOpenHandler: (f: Fn) => void (wc.open = f),
    emit: (ev: string, ...a: unknown[]) => (on[ev] ?? []).map((f) => f(...a)),
    listens: (ev: string) => (on[ev] ?? []).length,
  };
  return wc;
}
type Wc = ReturnType<typeof mkWc>;

function mkSes() {
  const on: Record<string, Fn> = {};
  const calls: string[] = [];
  const ses = {
    device: null as Fn | null,
    calls,
    on: (ev: string, f: Fn) => void (on[ev] = f),
    emit: (ev: string, ...a: unknown[]) => on[ev]!(...a),
    setDevicePermissionHandler: (f: Fn) => void (ses.device = f),
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    clearStorageData: () => Promise.resolve(void calls.push("storage")),
    clearCache: () => Promise.resolve(void calls.push("cache")),
    clearAuthCache: () => Promise.resolve(void calls.push("auth")),
  };
  return ses;
}

/** The permission guard + the web guard, run against a fake main process. */
function webMain(
  meta: { guestDownloads?: boolean } = {},
  allow: ElectronPermissions | null = null,
) {
  const appOn: Record<string, Fn[]> = {};
  const warnings: string[] = [];
  const opened: string[] = [];
  const handle: Record<string, Fn> = {};
  const parts: Record<string, ReturnType<typeof mkSes>> = {};
  const defaultSession = mkSes();
  const clock = { now: 1_000_000 };
  // A name only identity can catch: no spelling rule knows it.
  const appAlias = { name: "\u0000none" };
  const api = new Function(
    "app",
    "require",
    "console",
    "Date",
    "ipcMain",
    tmplPermissionGuard(allow) + tmplWebGuard(meta) +
      "\nreturn { bind: (wc, o) => { __aioAppWc = wc; __aioAppOrigin = o; }," +
      " popup: __aioWebPopup, track: __aioWebTrack, child: __aioGuardChild," +
      " session: __aioWebSession, clear: __aioClearPartition, perm: __aioPermOk };",
  )(
    { on: (ev: string, f: Fn) => void (appOn[ev] ??= []).push(f) },
    () => ({
      session: {
        defaultSession,
        // Electron's own (measured, 44): '' and 'persist:' ARE the default.
        fromPartition: (n: string) =>
          n === "" || n === "persist:" || n === appAlias.name
            ? defaultSession
            : (parts[n] ??= mkSes()),
      },
      webContents: { fromFrame: (f: { wc?: unknown }) => f.wc ?? null },
      shell: { openExternal: (u: string) => void opened.push(u) },
    }),
    { warn: (m: unknown) => warnings.push(String(m)), error() {}, log() {} },
    { now: () => clock.now },
    { handle: (c: string, f: Fn) => void (handle[c] = f) },
  ) as {
    bind(wc: unknown, origin: string): void;
    popup(wc: unknown, url: string): void;
    track(wc: unknown): void;
    child(child: { webContents: Wc }, start: string, origins?: unknown): void;
    session(ses: unknown): void;
    clear(name: unknown): Promise<{ ok: boolean; partition: string }>;
    perm(wc: unknown, permission: string, requesting: string): boolean;
  };
  const appEmit = (ev: string, ...a: unknown[]) =>
    (appOn[ev] ?? []).forEach((f) => f(...a));
  const appWc = mkWc("window", APP + "/");
  appWc.session = defaultSession;
  api.bind(appWc, APP);
  return {
    ...api,
    appAlias,
    appWc,
    appEmit,
    warnings,
    opened,
    handle,
    parts,
    clock,
    defaultSession,
  };
}

const click = (wc: Wc) => wc.emit("input-event", {}, { type: "mouseDown" });
const ev = () => {
  const e = {
    prevented: false,
    preventDefault: () => void (e.prevented = true),
  };
  return e;
};

// ── Split: <webview> without openWindow ────────────────────────────────────

Deno.test("web isolation: electron.webviewTag enables <webview> and NOT openWindow; childWindows keeps meaning both", () => {
  const tag = (meta: Record<string, unknown>) =>
    tmplWindowShape(meta).match(/webviewTag: (\w+)/)![1];
  assertEquals(tag({}), "false");
  assertEquals(tag({ webviewTag: true }), "true");
  assertEquals(tag({ childWindows: true }), "true");
  const uds = (meta: Record<string, unknown>) =>
    electronMainScriptUDS("http://127.0.0.1:1/", "/tmp/x.sock", { meta });
  const only = uds({ webviewTag: true });
  assertStringIncludes(only, "webviewTag: true");
  assertStringIncludes(only, "const CHILD_WINDOWS = false;");
  const both = uds({ childWindows: true });
  assertStringIncludes(both, "webviewTag: true");
  assertStringIncludes(both, "const CHILD_WINDOWS = true;");
  // The WebSocket shell reads the same rule.
  assertStringIncludes(
    electronMainScript("http://127.0.0.1:1/", { webviewTag: true }),
    "webviewTag: true",
  );
  // …and the config accepts the two new keys of the block (their way to the
  // window's meta is pinned by electron-sandbox-policy.test.ts).
  assert(VALID_ELECTRON_KEYS.has("webviewTag"));
  assert(VALID_ELECTRON_KEYS.has("guestDownloads"));
});

// ── H1: only the app's window is the app ───────────────────────────────────

Deno.test('web isolation: a pop-up window is never the app — with electron.permissions it holds nothing scoped "app"', () => {
  const m = webMain({}, { "clipboard-read": ["app"] });
  const popup = mkWc("window", "https://dapp.example/pop");
  assertEquals(m.perm(m.appWc, "clipboard-read", APP), true);
  // A window, asking from the origin it shows: the old rule called that "app".
  assertEquals(m.perm(popup, "clipboard-read", "https://dapp.example"), false);
  // Without the list too: no other window is the app; a child window keeps
  // its documented 1.0.12 answer, and a pop-up is not a child window.
  const d = webMain();
  const child = mkWc("window", "https://dapp.example/");
  d.child({ webContents: child }, "https://dapp.example/");
  assertEquals(d.perm(child, "clipboard-read", "https://dapp.example"), true);
  assertEquals(d.perm(popup, "clipboard-read", "https://dapp.example"), false);
  assertEquals(d.perm(popup, "fullscreen", "https://dapp.example"), true);
});

Deno.test("web isolation: a child window's window.open is denied — no window, and the link needs a real click", () => {
  const m = webMain();
  const child = mkWc("window", "https://dapp.example/");
  m.child({ webContents: child }, "https://dapp.example/");
  assert(child.open, "the child window has no window-open handler");
  assertEquals(child.open({ url: "https://evil.example/" }), {
    action: "deny",
  });
  assertEquals(m.opened, []);
  assertEquals(m.warnings.length, 1, m.warnings.join("\n"));
  assertStringIncludes(
    m.warnings[0]!,
    "pop-up BLOCKED from openWindow child window https://dapp.example",
  );
  click(child);
  assertEquals(child.open({ url: "https://docs.example/a" }), {
    action: "deny",
  });
  assertEquals(m.opened, ["https://docs.example/a"]);
});

// ── H3: a guest's links to the system browser ──────────────────────────────

Deno.test("web isolation: a guest's pop-up reaches the system browser only as http(s), after real input, once per 2 s — each refusal said once", () => {
  // (A declared permission list keeps the permission guard's own first-guest
  // line out of the count.)
  const m = webMain({}, {});
  const guest = mkWc("webview", "https://news.example/story");
  m.appEmit("web-contents-created", {}, guest); // input is tracked from birth
  assertEquals(guest.listens("input-event"), 1);
  // No input at all: a page may not open the browser by itself.
  for (let i = 0; i < 50; i++) m.popup(guest, "https://spam.example/" + i);
  assertEquals(m.opened, []);
  assertEquals(m.warnings.length, 1, m.warnings.join("\n"));
  assertStringIncludes(
    m.warnings[0]!,
    "pop-up BLOCKED from <webview> guest https://news.example",
  );
  assertStringIncludes(m.warnings[0]!, "no click or key press");
  // A mouse MOVE is not a gesture; a click is.
  guest.emit("input-event", {}, { type: "mouseMove" });
  m.popup(guest, "https://a.example/");
  assertEquals(m.opened, []);
  click(guest);
  m.popup(guest, "https://a.example/");
  assertEquals(m.opened, ["https://a.example/"]);
  // The same click does not open a second one…
  m.popup(guest, "https://b.example/");
  assertEquals(m.opened, ["https://a.example/"]);
  assertStringIncludes(m.warnings[1]!, "more than one link in 2 s");
  // …2 s later it does, while the click is still fresh; 5 s after it, not.
  m.clock.now += 2001;
  m.popup(guest, "https://b.example/");
  assertEquals(m.opened, ["https://a.example/", "https://b.example/"]);
  m.clock.now += 5001;
  m.popup(guest, "https://c.example/");
  assertEquals(m.opened.length, 2);
  // Never anything but http(s), click or not.
  click(guest);
  m.clock.now += 3000;
  for (const u of ["file:///etc/passwd", "ms-msdt:x", "javascript:1", "nope"]) {
    m.popup(guest, u);
  }
  assertEquals(m.opened.length, 2);
  assert(
    m.warnings.some((w) => w.includes("got file:")),
    m.warnings.join("\n"),
  );
  assert(m.warnings.some((w) => w.includes("not a URL")));
});

Deno.test("web isolation: both app shells route a guest's window.open through the gate", () => {
  const nav = tmplWillNavigate("_appOrigin");
  assertStringIncludes(nav, "__aioWebPopup(guest, url);");
  // The unbounded call is gone from the guest's handler.
  const guestHook = nav.slice(nav.indexOf("'did-attach-webview'"));
  assert(
    !guestHook.includes("shell.openExternal"),
    "the guest opens links ungated",
  );
  for (
    const src of [
      electronMainScript("http://127.0.0.1:1/", {}),
      electronMainScriptUDS("http://127.0.0.1:1/", "/tmp/x.sock", {}),
    ]
  ) {
    assertStringIncludes(src, "function __aioWebPopup(wc, url)");
    assertStringIncludes(src, "function __aioWebSession(ses)");
    new Function(src); // parses
  }
});

// ── H4: where a child window may go ────────────────────────────────────────

Deno.test("web isolation: a child window navigates as in 1.0.18 (any site) but never to aio:/file:; origins turns the restriction on", () => {
  const go = (wc: Wc, url: string, what = "will-navigate") => {
    const e = ev();
    wc.emit(what, e, url);
    return !e.prevented;
  };
  const blocked = (m: ReturnType<typeof webMain>) =>
    m.warnings.filter((w) => w.includes("navigation BLOCKED"));
  // The default — and "*", the same thing spelled out: a login flow that
  // crosses origins AFTER it landed, by link and by redirect.
  for (const origins of [undefined, "*"]) {
    const m = webMain();
    const wc = mkWc("window", "");
    m.child({ webContents: wc }, "https://dapp.example/", origins);
    wc.emit("did-navigate", {}, "https://dapp.example/");
    assertEquals(go(wc, "https://id.example/login"), true);
    assertEquals(go(wc, "https://sso.example/", "will-redirect"), true);
    assertEquals(go(wc, "mailto:x@dapp.example"), true); // as 1.0.18
    assertEquals(m.warnings, [], "the default says nothing");
    // …never the app's own scheme or the disk, by link or by redirect.
    assertEquals(go(wc, "aio://app/"), false);
    assertEquals(go(wc, "aio://app/again"), false);
    assertEquals(go(wc, "file:///etc/passwd", "will-redirect"), false);
    assertEquals(go(wc, "javascript:alert(1)"), false);
    assertEquals(go(wc, "not a url"), false);
    assertEquals(blocked(m).length, 4, m.warnings.join("\n"));
    assertStringIncludes(
      blocked(m)[0]!,
      "openWindow child window https://dapp.example to aio: — a child window never navigates to the app's own scheme or to a file",
    );
  }

  // origins: [...] — the restriction, ON.
  const m = webMain();
  const wc = mkWc("window", "");
  m.child({ webContents: wc }, "http://dapp.example/", ["https://id.example"]);
  // The first load's redirects are the opened URL's own: http → https, → www.
  assertEquals(go(wc, "https://www.dapp.example/", "will-redirect"), true);
  // …but never to another scheme, landed or not.
  assertEquals(go(wc, "file:///etc/passwd", "will-redirect"), false);
  wc.emit("did-navigate", {}, "https://www.dapp.example/");
  assertEquals(go(wc, "https://www.dapp.example/swap"), true);
  assertEquals(go(wc, "http://dapp.example/old"), true); // the origin asked for
  assertEquals(go(wc, "https://id.example/login"), true); // listed
  assertEquals(go(wc, "https://evil.example/"), false);
  assertEquals(go(wc, "https://evil.example/2"), false);
  assertEquals(go(wc, "https://evil.example/", "will-redirect"), false);
  assertEquals(go(wc, "aio://app/"), false);
  assertEquals(go(wc, "mailto:x@dapp.example"), false);
  assertEquals(go(wc, "not a url"), false);
  // A subframe's redirect is not the window's navigation.
  const sub = Object.assign(ev(), { isMainFrame: false });
  wc.emit("will-redirect", sub, "https://ads.example/");
  assertEquals(sub.prevented, false);
  // Once per destination; names the window, the destination and the option.
  assertEquals(blocked(m).length, 5, m.warnings.join("\n"));
  assertStringIncludes(
    blocked(m)[1]!,
    "openWindow child window http://dapp.example to https://evil.example — this window was opened with origins",
  );
  // An empty list is a restriction too: the opening origin only.
  const only = mkWc("window", "");
  m.child({ webContents: only }, "https://solo.example/", []);
  only.emit("did-navigate", {}, "https://solo.example/");
  assertEquals(go(only, "https://solo.example/next"), true);
  assertEquals(go(only, "https://id.example/login"), false);
});

// ── A page cannot silence the guard's log ──────────────────────────────────

Deno.test("web isolation: 300 made-up pop-up schemes do not silence the log — a download cancellation is still said; each kind stops at its own cap and says so", () => {
  const m = webMain();
  m.appEmit("ready");
  const guest = mkWc("webview", "https://flood.example/");
  m.track(guest);
  for (let i = 0; i < 300; i++) m.popup(guest, `a${i}:x`);
  // The page chose 300 schemes: one line, not 300 — its text is not a key.
  assertEquals(m.warnings.length, 1, m.warnings.slice(0, 5).join("\n"));
  assertStringIncludes(m.warnings[0]!, "got a0:");
  // A scheme of any length is not echoed whole.
  const long = mkWc("webview", "https://long.example/");
  m.popup(long, "b" + "x".repeat(5000) + ":y");
  assert(m.warnings[1]!.length < 400, String(m.warnings[1]!.length));
  const e = ev();
  m.defaultSession.emit("will-download", e, {}, guest);
  assertEquals(e.prevented, true);
  assertStringIncludes(
    m.warnings[2]!,
    "download CANCELLED from <webview> guest https://flood.example",
  );
  // What a page CAN vary is its own origin: 300 of them fill the pop-up
  // lines only, and the line that says so is said once.
  const before = m.warnings.length;
  for (let i = 0; i < 300; i++) {
    m.popup(mkWc("webview", `https://h${i}.example/`), "x:y");
  }
  const more = m.warnings.slice(before);
  assertEquals(more.length, 31, "32 pop-up lines, then one that says so");
  assertStringIncludes(more[30]!, "further pop-up lines are not said");
  // …still refused, and another kind still speaks.
  const child = mkWc("window", "https://dapp.example/");
  m.child({ webContents: child }, "https://dapp.example/");
  const d = ev();
  m.defaultSession.emit("will-download", d, {}, child);
  assertEquals(d.prevented, true);
  assertStringIncludes(
    m.warnings.at(-1)!,
    "download CANCELLED from openWindow child window",
  );
});

// ── W1: downloads ──────────────────────────────────────────────────────────

Deno.test("web isolation: a guest's or child window's download is cancelled and said once; the app's own is not; guestDownloads allows", () => {
  const m = webMain();
  m.appEmit("ready");
  const ses = m.defaultSession;
  const guest = mkWc("webview", "https://files.example/x");
  const child = mkWc("window", "https://dapp.example/");
  m.child({ webContents: child }, "https://dapp.example/");
  const dl = (s: ReturnType<typeof mkSes>, wc: unknown) => {
    const e = ev();
    s.emit("will-download", e, {}, wc);
    return e.prevented;
  };
  assertEquals(dl(ses, guest), true);
  assertEquals(dl(ses, guest), true);
  assertEquals(dl(ses, child), true);
  assertEquals(dl(ses, m.appWc), false, "the app's own download was cancelled");
  assertEquals(dl(ses, undefined), false); // started by the main process
  assertEquals(m.warnings.length, 2, m.warnings.join("\n"));
  assertStringIncludes(
    m.warnings[0]!,
    "download CANCELLED from <webview> guest https://files.example",
  );
  assertStringIncludes(m.warnings[0]!, "electron: { guestDownloads: true }");
  // Every later session too — a <webview> partition is one.
  const part = mkSes();
  m.appEmit("session-created", part);
  assertEquals(dl(part, guest), true);

  const on = webMain({ guestDownloads: true });
  on.appEmit("ready");
  assertEquals(dl(on.defaultSession, guest), false);
  assertEquals(on.warnings, []);
});

// ── W2: devices ────────────────────────────────────────────────────────────

Deno.test("web isolation: a guest or child window gets no device, by name; the app's own page is left to Electron as in 1.0.18 (no preventDefault, no Bluetooth listener)", () => {
  const m = webMain({}, {});
  const part = mkSes();
  m.appEmit("session-created", part);
  assertEquals(
    part.device!({ deviceType: "hid", origin: "https://x.example" }),
    false,
  );
  assertEquals(part.device!({ deviceType: "usb", origin: APP }), false);
  const picked: unknown[][] = [];
  const cb = (...a: unknown[]) => void picked.push(a);
  const guest = mkWc("webview", "https://x.example/");
  for (const kind of ["select-hid-device", "select-usb-device"]) {
    const e = ev();
    part.emit(kind, e, {
      deviceList: [{ deviceId: "d1" }],
      frame: { url: "https://x.example/page", wc: guest },
    }, cb);
    assertEquals(e.prevented, true, kind);
  }
  const s = ev();
  part.emit("select-serial-port", s, [{ portId: "p1" }], guest, cb);
  assertEquals(s.prevented, true);
  m.appEmit("web-contents-created", {}, guest);
  const b = ev();
  guest.emit("select-bluetooth-device", b, [{ deviceId: "b1" }], cb);
  assertEquals(b.prevented, true);
  // Cancelled every time: no id ever reaches Electron.
  assertEquals(picked, [[], [], [""], [""]]);
  assertEquals(m.warnings.length, 4, m.warnings.join("\n"));
  assertStringIncludes(
    m.warnings[0]!,
    "HID device request CANCELLED for https://x.example",
  );
  // A child window: the same, Bluetooth included.
  const child = mkWc("window", "https://dapp.example/");
  m.appEmit("web-contents-created", {}, child); // before it is known as one
  m.child({ webContents: child }, "https://dapp.example/");
  assertEquals(child.listens("select-bluetooth-device"), 1);
  const c = ev();
  part.emit("select-serial-port", c, [], child, cb);
  assertEquals(c.prevented, true);
  // A frame nobody can name is not the app's page.
  const anon = ev();
  part.emit("select-hid-device", anon, { frame: null }, cb);
  assertEquals(anon.prevented, true);
  // A foreign frame in the app's own window is not the app's page either.
  const framed = ev();
  part.emit("select-usb-device", framed, {
    frame: { url: "https://ads.example/x", wc: m.appWc },
  }, cb);
  assertEquals(framed.prevented, true);

  // The app's OWN page: nothing is prevented and no callback is called —
  // Electron's default, exactly what 1.0.18 (no listener at all) left it.
  picked.length = 0;
  const said = m.warnings.length;
  m.appEmit("ready");
  m.appEmit("web-contents-created", {}, m.appWc);
  assertEquals(
    m.appWc.listens("select-bluetooth-device"),
    0,
    "a listener on the app's window replaces Electron's default",
  );
  for (const kind of ["select-hid-device", "select-usb-device"]) {
    const e = ev();
    m.defaultSession.emit(kind, e, {
      frame: { url: APP + "/", wc: m.appWc },
    }, cb);
    assertEquals(e.prevented, false, kind);
  }
  const own = ev();
  m.defaultSession.emit("select-serial-port", own, [], m.appWc, cb);
  assertEquals(own.prevented, false);
  assertEquals(picked, []);
  assertEquals(m.warnings.length, said + 3, m.warnings.join("\n"));
  assertStringIncludes(
    m.warnings[said]!,
    "HID device request from the app's own page (aio://app) was left to Electron",
  );
});

// ── W6: what a guest is made of, and whose session it lives in ─────────────

function attach(wp: Record<string, unknown>, params: Record<string, unknown>) {
  const handlers: Record<string, Fn> = {};
  const warnings: string[] = [];
  const appSession = {};
  const webContents = {
    session: appSession,
    on: (e: string, f: Fn) => void (handlers[e] = f),
    setWindowOpenHandler() {},
  };
  new Function(
    "win",
    "fs",
    "path",
    "console",
    "BASE_DIR",
    "_appOrigin",
    "require",
    "app",
    "ipcMain",
    tmplPermissionGuard(null) + tmplWebGuard() +
      "\n__aioAppWc = win.webContents;\n{\n" + tmplWillNavigate("_appOrigin") +
      "\n}",
  )(
    { webContents },
    { realpathSync: (p: string) => p },
    { sep: "/" },
    { warn: (m: unknown) => warnings.push(String(m)), error() {}, log() {} },
    "/app",
    APP,
    () => ({
      session: {
        defaultSession: {},
        // "app-alias": a name only identity can catch.
        fromPartition: (n: string) =>
          n === "" || n === "persist:" || n === "app-alias" ? appSession : {},
      },
    }),
    { on() {} },
    { handle() {} },
  );
  const again = () => handlers["will-attach-webview"]!(null, wp, params);
  again();
  return { warnings, again };
}

Deno.test("web isolation: a guest's sandbox, isolation and no-Node are forced whatever the tag asked", () => {
  const wp: Record<string, unknown> = {
    sandbox: false,
    nodeIntegration: true,
    contextIsolation: false,
    partition: "persist:p",
  };
  attach(wp, { src: "https://x.example/" });
  assertEquals(
    [wp.sandbox, wp.nodeIntegration, wp.contextIsolation],
    [true, false, true],
  );
});

Deno.test("web isolation: another site's guest with no partition gets its own session, never the app's; said once", () => {
  const wp: Record<string, unknown> = { partition: "" };
  const a = attach(wp, { src: "https://news.example/" });
  assertEquals(wp.partition, "persist:aio-webview");
  a.again();
  assertEquals(a.warnings.length, 1, a.warnings.join("\n"));
  assertStringIncludes(
    a.warnings[0]!,
    'gets the session "persist:aio-webview"',
  );
  // The app chose one: kept, and nothing to say.
  const named: Record<string, unknown> = { partition: "persist:reader" };
  assertEquals(attach(named, { src: "https://news.example/" }).warnings, []);
  assertEquals(named.partition, "persist:reader");
  // The app's own page in a guest (a preview) stays where its routes are —
  // and is told what it shares.
  const own: Record<string, unknown> = {};
  const o = attach(own, { src: "aio://app/preview" });
  assertEquals(own.partition, undefined);
  assertEquals(o.warnings.length, 1);
  assertStringIncludes(o.warnings[0]!, "stays in the app's session");
  // No src to judge by: not the app's. about:blank neither — it is where a
  // guest that browses starts, and in the app's session it could never leave.
  for (const params of [{}, { src: "about:blank" }]) {
    const none: Record<string, unknown> = {};
    attach(none, params);
    assertEquals(none.partition, "persist:aio-webview", JSON.stringify(params));
  }
  // The app's own content by another name stays.
  const data: Record<string, unknown> = {};
  attach(data, { src: "data:text/html,<p>preview</p>" });
  assertEquals(data.partition, undefined);
});

Deno.test("web isolation: a partition NAME that resolves to the app's own session (\"persist:\", by identity) is no partition — another site's guest is moved out", () => {
  // "persist:" IS the default session; "app-alias" is caught by identity
  // alone; in webPreferences or in params, whichever carries it.
  for (const name of ["persist:", "persist:  ", "app-alias"]) {
    for (const where of ["wp", "params"]) {
      const wp: Record<string, unknown> = where === "wp"
        ? { partition: name }
        : {};
      const params: Record<string, unknown> = {
        src: "https://news.example/",
        ...(where === "params" ? { partition: name } : {}),
      };
      const a = attach(wp, params);
      assertEquals(wp.partition, "persist:aio-webview", name + " " + where);
      assertStringIncludes(
        a.warnings[0]!,
        'gets the session "persist:aio-webview"',
      );
    }
  }
  // On the app's own page it stays where it is — and is held there.
  const own: Record<string, unknown> = { partition: "persist:" };
  const o = attach(own, { src: "aio://app/preview" });
  assertEquals(own.partition, "persist:");
  assertStringIncludes(o.warnings[0]!, "stays in the app's session");
});

// Agent-measured (Electron 44): params.allowpopups = 'off' in
// will-attach-webview changes nothing. The documented contract is that a
// guest WITH allowpopups opens links through the click gate — so the hook
// leaves the attribute alone (the real-window run below has such a guest).
Deno.test("web isolation: the attach hook does not pretend to switch allowpopups off", () => {
  const params: Record<string, unknown> = {
    src: "https://x.example/",
    allowpopups: "on",
    nodeintegration: "on",
  };
  attach({ partition: "persist:p" }, params);
  assertEquals(params.allowpopups, "on");
  assertEquals(params.nodeintegration, "off"); // what the hook does force
});

// ── A guest in the app's own session; a foreign frame in the app's window ──

/** Both guards and the window's navigation rules, on a fake window. */
function shell(appOrigin = APP) {
  const filters: { filter: unknown; fn: Fn }[] = [];
  const session = {
    webRequest: {
      onBeforeRequest: (filter: unknown, fn: Fn) =>
        void filters.push({ filter, fn }),
    },
  };
  const win = Object.assign(mkWc("window", appOrigin + "/"), {
    session,
    isDestroyed: () => false,
    executeJavaScript: () => Promise.resolve([null]),
  });
  const warnings: string[] = [];
  new Function(
    "app",
    "require",
    "console",
    "ipcMain",
    "win",
    "fs",
    "path",
    "_appOrigin",
    tmplPermissionGuard(null) + tmplWebGuard() + "\n{\n" +
      tmplWillNavigate("_appOrigin") + "\n}",
  )(
    { on() {} },
    () => ({ session: { defaultSession: session, fromPartition: () => ({}) } }),
    { warn: (w: unknown) => warnings.push(String(w)), error() {}, log() {} },
    { handle() {} },
    { webContents: win },
    { realpathSync: (p: string) => p },
    { sep: "/" },
    appOrigin,
  );
  const guest = (url: string, own: boolean) => {
    const g = Object.assign(mkWc("webview", url), {
      id: 7,
      session: own ? session : { webRequest: session.webRequest },
      isDestroyed: () => false,
    });
    win.emit("did-attach-webview", {}, g);
    return g;
  };
  return { win, warnings, guest, filters };
}

Deno.test("web isolation: a guest in the app's own session may not leave for another site — page, redirect or embedder; one with a partition is not held", () => {
  const s = shell();
  // A guest with a session of its own: nothing is installed for it.
  s.guest("https://news.example/", false);
  assertEquals(s.filters.length, 0);
  const own = s.guest(APP + "/preview", true);
  s.guest(APP + "/second", true); // one listener per session, not per guest
  assertEquals(s.filters.length, 1);
  // Main-frame requests to http(s) only: nothing else costs a callback.
  assertEquals(s.filters[0]!.filter, {
    urls: ["http://*/*", "https://*/*"],
    types: ["mainFrame"],
  });
  const ask = (wc: unknown, url: string, resourceType = "mainFrame") => {
    let cancel: boolean | undefined;
    s.filters[0]!.fn(
      { url, resourceType, webContents: wc },
      (r: { cancel: boolean }) => void (cancel = r.cancel),
    );
    return cancel;
  };
  // However the navigation started, its request passes here: cancelled.
  assertEquals(ask(own, "https://evil.example/a"), true);
  assertEquals(ask(own, "http://evil.example/b"), true);
  // Said once per site, with the fix.
  assertEquals(s.warnings.length, 2, s.warnings.join("\n"));
  assertStringIncludes(
    s.warnings[0]!,
    "navigation BLOCKED in <webview> guest to https://evil.example",
  );
  assertStringIncludes(s.warnings[0]!, 'partition="persist:name"');
  ask(own, "https://evil.example/again");
  assertEquals(s.warnings.length, 2);
  // The app's own window in that session goes where it always could (its
  // rules are will-navigate's), and a frame inside the guest is not the guest.
  assertEquals(ask(s.win, "https://sso.example/login"), false);
  assertEquals(ask(own, "https://video.example/embed", "subFrame"), false);
  // A main-frame request that names NO page cannot be shown not to be a
  // guest's: it does not go out, and is said — the app's own never is.
  assertEquals(ask(undefined, "https://x.example/"), true);
  assertEquals(ask(null, "https://x.example/2"), true);
  assertEquals(ask(undefined, APP + "/preview"), false);
  assertEquals(ask(undefined, "https://x.example/sw.js", "script"), false);
  assertEquals(s.warnings.length, 3, s.warnings.join("\n"));
  assertStringIncludes(
    s.warnings[2]!,
    "a page load of https://x.example in the app's session named no window or <webview> and was CANCELLED",
  );
  // A request that cannot be judged does not load, and says so.
  assertEquals(ask(own, "http://["), true);
  assertStringIncludes(s.warnings[3]!, "could not be checked");
  // An http(s) app origin (the dev window): its own pages are not "another site".
  const dev = shell("http://127.0.0.1:8000");
  const g = dev.guest("http://127.0.0.1:8000/preview", true);
  const devAsk = (url: string) => {
    let cancel: boolean | undefined;
    dev.filters[0]!.fn(
      { url, resourceType: "mainFrame", webContents: g },
      (r: { cancel: boolean }) => void (cancel = r.cancel),
    );
    return cancel;
  };
  assertEquals(devAsk("http://127.0.0.1:8000/other"), false);
  assertEquals(devAsk("http://127.0.0.1:9000/other"), true);
});

Deno.test("web isolation: a foreign <iframe> in the app's own aio:// window is said once per site, with both ways out", () => {
  const s = shell();
  const frame = (url: string, main = false) =>
    s.win.emit("did-frame-navigate", {}, url, 200, "OK", main);
  frame(APP + "/", true);
  frame(APP + "/embed");
  frame("about:blank");
  frame("data:text/html,x");
  assertEquals(s.warnings, []);
  frame("https://video.example/embed/1");
  frame("https://video.example/embed/2");
  assertEquals(s.warnings.length, 1, s.warnings.join("\n"));
  assertStringIncludes(
    s.warnings[0]!,
    "an <iframe> from https://video.example",
  );
  assertStringIncludes(s.warnings[0]!, '<webview partition="persist:name">');
  assertStringIncludes(s.warnings[0]!, `{ 'frame-src': "'self'" }`);
  // The same exposure one level down: a guest in the app's own session (no
  // partition, the app's own page) that embeds a foreign frame — said once
  // per site, as its own line. A guest with a session of its own: nothing.
  const inner = s.guest(APP + "/preview", true);
  const apart = s.guest("https://news.example/", false);
  assertEquals(apart.listens("did-frame-navigate"), 0);
  const gframe = (url: string, main = false) =>
    inner.emit("did-frame-navigate", {}, url, 200, "OK", main);
  gframe(APP + "/preview", true);
  gframe(APP + "/embed");
  assertEquals(s.warnings.length, 1);
  gframe("https://video.example/embed/1");
  gframe("https://video.example/embed/2");
  assertEquals(s.warnings.length, 2, s.warnings.join("\n"));
  assertStringIncludes(
    s.warnings[1]!,
    "an <iframe> from https://video.example loaded in a <webview> with no partition (the app's session)",
  );
  assertStringIncludes(
    s.warnings[1]!,
    "everything the app serves on aio://app",
  );
  // The claim is about aio://: an http(s) app origin is an ordinary web page.
  const dev = shell("http://127.0.0.1:8000");
  assertEquals(dev.win.listens("did-frame-navigate"), 0);
  assertEquals(
    dev.guest("http://127.0.0.1:8000/p", true).listens("did-frame-navigate"),
    0,
  );
});

// ── The connect-mode shell (a window onto a remote app) ────────────────────

Deno.test("web isolation: the connect-mode shell binds its window to the app it connected to, denies pop-ups, and carries the device and download rules", async () => {
  const src = electronClientScript(null);
  new Function(src); // parses
  for (
    const has of [
      "function __aioWebSession(ses)",
      "function __aioIpcBind(win, origin)",
      "ses.setDevicePermissionHandler(() => false);",
    ]
  ) assertStringIncludes(src, has);
  // RUN it: the window it makes, the page it connects to.
  const appOn: Record<string, Fn[]> = {};
  const opened: string[] = [];
  const wins: (Wc & { loaded: string[] })[] = [];
  class BrowserWindow {
    webContents = Object.assign(mkWc("window", ""), {
      loaded: [] as string[],
      executeJavaScript: () => Promise.resolve(),
    });
    constructor() {
      wins.push(this.webContents);
    }
    loadURL(u: string) {
      this.webContents.url = u;
      this.webContents.loaded.push(u);
    }
    on() {}
    setResizable() {}
    setSize() {}
    setPosition() {}
    center() {}
    setTitle() {}
    setIcon() {}
  }
  const electron = {
    app: {
      name: "",
      on: (n: string, f: Fn) => void (appOn[n] ??= []).push(f),
      getPath: () => "/nonexistent-aio-client-test",
      quit() {},
    },
    BrowserWindow,
    Menu: { setApplicationMenu() {} },
    nativeImage: { createFromBuffer: () => ({}) },
    session: { defaultSession: mkSes() },
    shell: { openExternal: (u: string) => void opened.push(u) },
    ipcMain: { on() {}, handle() {} },
  };
  const nodeRequire = (await import("node:module")).createRequire(
    import.meta.url,
  );
  const api = new Function(
    "require",
    "process",
    "console",
    "setInterval",
    // No network in a unit test: the page it "fetched" is an aio app.
    src +
      "\nfetchPage = () => Promise.resolve('<div id=\"root\"></div>');" +
      "\nfetchBuffer = () => Promise.resolve(null);" +
      "\nreturn { perm: __aioPermOk };",
  )(
    (name: string) =>
      name === "electron" ? electron : nodeRequire("node:" + name),
    {
      env: {},
      argv: ["--server-url=https://app.example:8443/?token=k"],
      platform: "linux",
      stdout: { on() {} },
      stderr: { on() {} },
      on() {},
      removeAllListeners() {},
      exit: (c: number) => {
        throw new Error("process.exit(" + c + ")");
      },
    },
    { log() {}, warn() {}, error() {} },
    () => 0,
  ) as { perm(wc: unknown, permission: string, requesting: string): boolean };
  for (const f of appOn["ready"] ?? []) f();
  const win = wins[0]!;
  // Before the connect lands, the window shows aio's own connect page (a
  // data: URL): no origin is the app yet, so it holds nothing.
  win.url = "data:text/html,connect";
  assertEquals(api.perm(win, "clipboard-read", win.url), false);
  for (let i = 0; i < 100 && !win.loaded.length; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assertEquals(win.loaded, ["https://app.example:8443/?token=k"]);
  const A = "https://app.example:8443";
  // The app it connected to is the app…
  assertEquals(api.perm(win, "clipboard-read", A), true);
  // …a pop-up window is not, whatever it shows (it was: a window, asking
  // from the origin it shows) — and none opens.
  const popup = mkWc("window", "https://evil.example/");
  assertEquals(
    api.perm(popup, "clipboard-read", "https://evil.example"),
    false,
  );
  assertEquals(api.perm(mkWc("window", A + "/x"), "clipboard-read", A), false);
  assert(win.open, "the connect window has no window-open handler");
  assertEquals(win.open({ url: "https://docs.example/" }), { action: "deny" });
  assertEquals(win.open({ url: "file:///etc/passwd" }), { action: "deny" });
  assertEquals(opened, ["https://docs.example/"]);
  // …and neither is a site a redirect put in the app's window.
  win.url = "https://evil.example/landed";
  assertEquals(api.perm(win, "clipboard-read", "https://evil.example"), false);
});

// ── Lock → wipe ────────────────────────────────────────────────────────────

Deno.test("web isolation: clearPartition wipes the named partition, refuses the app's own session, and is the app page's alone", async () => {
  const m = webMain();
  assertThrows(() => m.clear(""), Error, "clearPartition refused");
  assertThrows(() => m.clear(undefined), Error, "clearPartition refused");
  assertEquals(await m.clear("persist:dapps"), {
    ok: true,
    partition: "persist:dapps",
  });
  assertEquals(m.parts["persist:dapps"]!.calls.sort(), [
    "auth",
    "cache",
    "storage",
  ]);
  assertEquals(m.defaultSession.calls, []);
  assertStringIncludes(m.warnings[0]!, 'partition "persist:dapps" cleared');
  // "persist:" IS the app's own session (Electron: fromPartition('persist:')
  // === defaultSession). Refused by identity — a name no spelling rule knows
  // is caught too — and by spelling for 'persist:' + blanks.
  for (
    const name of ["persist:", "persist: ", "persist:\t", " ", m.appAlias.name]
  ) {
    assertThrows(
      () => m.clear(name),
      Error,
      "resolves to the app's own session",
      JSON.stringify(name),
    );
  }
  assertEquals(m.defaultSession.calls, [], "the app's own session was wiped");
  assertEquals(m.warnings.length, 1, "a refused wipe said it cleared");
  // Registered on the ipcMain in scope — the guarded one, in a shell — and
  // reachable from the page in BOTH shells (the shell bridge).
  m.appEmit("ready");
  assertEquals(
    await m.handle["__aio:clearPartition"]!({}, "p2"),
    { ok: true, partition: "p2" },
  );
  assertStringIncludes(
    shellBridgePreload(),
    "clearPartition: (partition) => ipcRenderer.invoke('__aio:clearPartition', partition)",
  );
  for (
    const src of [
      electronMainScript("http://127.0.0.1:1/", {}),
      electronMainScriptUDS("http://127.0.0.1:1/", "/tmp/x.sock", {}),
    ]
  ) {
    // After the guard's shadow, so `ipcMain` there is the guarded one.
    assert(
      src.indexOf("const ipcMain = (() => {") > 0 &&
        src.includes("ipcMain.handle('__aio:clearPartition'"),
    );
    assert(!src.includes("raw.handle('__aio:clearPartition'"));
  }
});

// ── Real Electron ──────────────────────────────────────────────────────────

const REPO = fromFileUrl(new URL("../", import.meta.url));
const ELECTRON_BIN = join(REPO, "node_modules/.bin/electron");
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

// What a page can get from the app's own scheme: a readable fetch, an opaque
// one, a POST, a script that runs, and a read from a worker.
const AIO_REACH = `(async () => {
  const t = (p) => Promise.race([p, new Promise((ok) => setTimeout(() => ok('hang'), 4000))]);
  const r = {};
  r.fetch = await t(fetch('aio://app/x.js').then((x) => x.text().then(() => 'read'), () => 'refused'));
  r.nocors = await t(fetch('aio://app/x.js', { mode: 'no-cors' }).then(() => 'sent', () => 'refused'));
  r.post = await t(fetch('aio://app/x.js', { method: 'POST', body: 'x' }).then(() => 'sent', () => 'refused'));
  const tag = (el, url) => t(new Promise((ok) => { const e = document.createElement(el); e.onload = () => ok('loaded'); e.onerror = () => ok('refused'); e.src = url; document.head.appendChild(e); }));
  r.script = await tag('script', 'aio://app/x.js');
  const src = "fetch('aio://app/x.js').then((x) => x.text()).then(() => postMessage('read'), () => postMessage('refused'))";
  try {
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    r.worker = await t(new Promise((ok) => { w.onmessage = (e) => ok(e.data); w.onerror = () => ok('refused'); }));
  } catch (e) { r.worker = 'refused'; }
  return r;
})()`;
const READS = {
  fetch: "read",
  nocors: "sent",
  post: "sent",
  script: "loaded",
  worker: "read",
};
const REFUSED = {
  fetch: "refused",
  nocors: "refused",
  post: "refused",
  script: "refused",
  worker: "refused",
};

/** One real Electron run. `guarded: false` is the control: the same window
 *  and guests with none of aio's rules. Links never reach a real browser —
 *  `shell.openExternal` is replaced by a recorder, and the run aborts if the
 *  replacement did not take. */
const cspMeta = (cfg: Parameters<typeof contentSecurityPolicy>[0]) =>
  `<meta http-equiv="Content-Security-Policy" content="${
    contentSecurityPolicy(cfg, "'self'")
  }">`;

async function runReal(guarded: boolean) {
  const dir = await tempDir("aio-web-isolation-e2e-");
  try {
    const preload = join(dir, "bridge.cjs");
    await Deno.writeTextFile(
      preload,
      shellBridgePreload({ standalone: true }),
    );
    const main = `
const { app, BrowserWindow, protocol, session, shell, webContents } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
app.setPath('userData', ${JSON.stringify(join(dir, "profile"))});
const BASE_DIR = ${JSON.stringify(dir)};
const R = { warnings: [], opened: [] };
const out = () => { console.log('RESULT ' + JSON.stringify(R)); app.exit(0); };
setTimeout(() => { R.error = 'timeout at ' + R.step; out(); }, 50000);
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const __openExternal = (u) => { R.opened.push(u); return Promise.resolve(); };
shell.openExternal = __openExternal;
if (require('electron').shell.openExternal !== __openExternal) { R.error = 'openExternal not replaced'; out(); }
const __warn = console.warn;
console.warn = (...a) => { R.warnings.push(a.join(' ')); };
protocol.registerSchemesAsPrivileged([{ scheme: 'aio', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
${
      guarded
        // hid: the app's page may ASK (the permission list decides that, as
        // it always did) — what it then gets is the device rule under test.
        ? tmplPermissionGuard({ "clipboard-read": ["app"], hid: ["app"] }) +
          tmplWebGuard() +
          tmplIpcGuard()
        : "const ipcMain = require('electron').ipcMain;"
    }
const serve = (fn) => new Promise((ok) => { const s = http.createServer(fn); s.listen(0, '127.0.0.1', () => ok('http://127.0.0.1:' + s.address().port)); });
const short = (u) => String(u).replace(/^http:..127.0.0.1:[0-9]+/, '');
app.whenReady().then(async () => {
  let OTHER = '';
  const hits = [];
  const SITE = await serve((q, res) => {
    if (q.url === '/dl') { res.setHeader('content-disposition', 'attachment; filename="x.bin"'); res.setHeader('content-type', 'application/octet-stream'); return res.end('data'); }
    if (q.url === '/hop') { res.statusCode = 302; res.setHeader('location', OTHER + '/landed'); return res.end(); }
    hits.push(q.url);
    res.setHeader('content-type', 'text/html');
    res.end('<h1>' + q.url + '</h1><button id=b onclick="window.open(&quot;https://example.com/clicked&quot;)">x</button>');
  });
  OTHER = await serve((q, res) => { res.setHeader('content-type', 'text/html'); res.end('<h1>other</h1>'); });
  protocol.handle('aio', (req) => {
    const u = new URL(req.url);
    const html = (body) => new Response(body, { headers: { 'Content-Type': 'text/html' } });
    if (u.pathname === '/') {
      // The DEFAULT policy of an aio page (security-headers.ts), as the
      // packaged shell emits it: a <meta>.
      return html(${JSON.stringify(cspMeta(undefined))} +
        '<webview id=g1 src="' + SITE + '/g1" webpreferences="sandbox=no" nodeintegration style="width:300px;height:120px"></webview>' +
        '<webview id=g2 src="' + SITE + '/g2" partition="persist:e2e" allowpopups style="width:300px;height:120px"></webview>' +
        '<webview id=own src="aio://app/preview" style="width:300px;height:60px"></webview>' +
        '<webview id=blank src="about:blank" style="width:300px;height:60px"></webview>' +
        // "persist:" IS the default session; the tag refuses the attribute
        // itself (the guest never attaches), webpreferences carries it past.
        '<webview id=g3 src="' + SITE + '/g3" webpreferences="partition=persist:" style="width:300px;height:60px"></webview>' +
        '<iframe id=f src="' + SITE + '/frame" style="width:300px;height:60px"></iframe>');
    }
    // The app's own page in a guest, embedding another site's frame.
    if (u.pathname === '/preview') return html('<h1>preview</h1><iframe src="' + SITE + '/in-guest"></iframe>');
    if (u.pathname === '/leave') return new Response('', { status: 302, headers: { location: SITE + '/redirected' } });
    // The documented way out for an app that wants no foreign frame.
    if (u.pathname === '/noframes') {
      return html(${
      JSON.stringify(cspMeta({ cspDirectives: { "frame-src": "'self'" } }))
    } + '<iframe src="' + SITE + '/frame-refused"></iframe><iframe src="aio://app/preview"></iframe>');
    }
    return new Response('window.__x = 1;', { headers: { 'Content-Type': 'text/javascript' } });
  });
  // Downloads: what the rules had decided by the time this listener (added
  // after theirs) runs. Always cancelled in the end: no save dialog in a test.
  const items = [];
  const watch = (ses) => ses.on('will-download', (e) => { items.push(e.defaultPrevented ? 'cancelled' : 'allowed'); e.preventDefault(); });
  app.on('session-created', watch);
  watch(session.defaultSession);
  const win = new BrowserWindow({ width: 700, height: 500, webPreferences: { nodeIntegration: false, contextIsolation: true, webviewTag: true, preload: ${
      JSON.stringify(preload)
    } } });
  const _appOrigin = 'aio://app';
  const guests = {};
  const popups = [];
${
      guarded
        ? "  __aioIpcBind(win, _appOrigin);\n" + tmplWillNavigate("_appOrigin")
        : "  win.webContents.on('did-attach-webview', (_e, g) => g.setWindowOpenHandler(({ url }) => { popups.push(url); return { action: 'deny' }; }));"
    }
  win.webContents.on('did-attach-webview', (_e, g) => g.once('did-finish-load', () => {
    const at = g.getURL();
    guests[at === 'about:blank' ? 'blank' : at === 'aio://app/preview' ? 'own' : short(at).slice(1)] = g;
  }));
  R.step = 'load';
  win.loadURL('aio://app/');
  for (let i = 0; i < 150 && Object.keys(guests).length < 5; i++) await wait(100);
  const { g1, g2, g3, own, blank } = guests;
  if (!g1 || !g2 || !g3 || !own || !blank) { R.error = 'guests: ' + Object.keys(guests); return out(); }
  const press = async (g) => {
    const at = await g.executeJavaScript("(() => { const r = document.getElementById('b').getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()");
    g.focus();
    g.sendInputEvent({ type: 'mouseDown', x: at[0], y: at[1], button: 'left', clickCount: 1 });
    g.sendInputEvent({ type: 'mouseUp', x: at[0], y: at[1], button: 'left', clickCount: 1 });
    await wait(500);
  };
  // ── the guest: what it is made of, whose session, what it reaches
  R.step = 'guest';
  const prefs = g1.getLastWebPreferences();
  R.g1 = {
    sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration,
    node: await g1.executeJavaScript("typeof process + ' ' + typeof require"),
    appSession: g1.session === session.defaultSession,
    ownSession: g1.session === session.fromPartition('persist:aio-webview'),
    aio: await g1.executeJavaScript(${JSON.stringify(AIO_REACH)}),
  };
  R.g2 = { named: g2.session === session.fromPartition('persist:e2e'), aio: await g2.executeJavaScript(${
      JSON.stringify(AIO_REACH)
    }) };
  R.g3 = { appSession: g3.session === session.defaultSession, aio: await g3.executeJavaScript(${
      JSON.stringify(AIO_REACH)
    }) };
  R.persistIsDefault = session.fromPartition('persist:') === session.defaultSession;
  R.app = await win.webContents.executeJavaScript(${JSON.stringify(AIO_REACH)});
  // ── pop-ups: by itself, then after a real click, then twice
  R.step = 'popups';
  // 300 made-up schemes first: a page may not talk the log into silence.
  ${
      guarded
        ? `await g2.executeJavaScript("for (let i = 0; i < 300; i++) window.open('a' + i + ':x'); 1");`
        : ""
    }
  await g2.executeJavaScript("window.open('https://example.com/by-itself'); 1");
  await wait(300);
  R.byItself = [...R.opened, ...popups];
  await press(g2);
  R.afterClick = [...R.opened];
  await press(g2);
  R.afterSecondClick = [...R.opened];
  // ── devices
  R.step = 'devices';
  const HID = "navigator.hid ? navigator.hid.requestDevice({ filters: [] }).then((d) => 'devices ' + d.length, (e) => 'refused ' + e.name) : 'no api'";
  R.hid = { guest: await g1.executeJavaScript(HID, true), app: await win.webContents.executeJavaScript(HID, true) };
  // ── the wipe, asked by the app's own page through the shell bridge
  R.step = 'wipe';
  await g2.executeJavaScript("document.cookie = 'k=1; max-age=3600'; localStorage.setItem('a', 'b'); 1");
  R.stored = await g2.executeJavaScript("[document.cookie, localStorage.getItem('a')]");
  ${
      guarded
        ? `R.wipe = await win.webContents.executeJavaScript("__aioShell.clearPartition('persist:e2e').then((r) => r, (e) => 'rejected ' + e.message)");
  R.wipeNone = await win.webContents.executeJavaScript("__aioShell.clearPartition('').then((r) => r, (e) => 'rejected ' + e.message)");
  await win.webContents.executeJavaScript("localStorage.setItem('mine', 'kept'); 1");
  R.wipeApp = await win.webContents.executeJavaScript("__aioShell.clearPartition('persist:').then((r) => r, (e) => 'rejected ' + e.message)");
  R.appKept = await win.webContents.executeJavaScript("localStorage.getItem('mine')");
  R.afterWipe = await g2.executeJavaScript("[document.cookie, localStorage.getItem('a')]");`
        : ""
    }
  // ── a guest in the app's own session: the page, a redirect, the embedder
  R.step = 'own';
  const whose = (g) => g.session === session.defaultSession ? 'app' : g.session === session.fromPartition('persist:aio-webview') ? 'guests' : 'other';
  R.sessions = { own: whose(own), blank: whose(blank) };
  const at = async (js, on) => { await (on || own).executeJavaScript(js + '; 1'); await wait(700); return short(own.getURL()); };
  R.ownSame = await at("location.href = 'aio://app/preview?again'");
  R.ownPage = await at("location.href = '" + SITE + "/by-page'");
  R.ownRedirect = await at("location.href = 'aio://app/leave'");
  R.ownEmbedder = await at("document.getElementById('own').src = '" + SITE + "/by-embedder'", win.webContents);
  R.ownAio = await own.executeJavaScript(${JSON.stringify(AIO_REACH)});
  R.ownHits = hits.filter((h) => /by-page|redirected|by-embedder/.test(h));
  R.inGuestFrame = hits.includes('/in-guest');
  // With that guest held, a WINDOW in the app's session still loads another
  // site (the app's own SSO flow): its request names its webContents.
  // Judged by what the server saw: getURL() names a cancelled load too.
  const sso = new BrowserWindow({ width: 300, height: 200, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  await sso.loadURL(SITE + '/sso').catch(() => {});
  R.sso = { app: sso.webContents.session === session.defaultSession, served: hits.includes('/sso') };
  sso.destroy();
  // …and one that started blank browses, in the guests' session.
  await win.webContents.executeJavaScript("document.getElementById('blank').src = '" + SITE + "/from-blank'; 1");
  await wait(700);
  R.blankAt = short(blank.getURL());
  R.blankAio = await blank.executeJavaScript(${JSON.stringify(AIO_REACH)});
  // ── a foreign <iframe> in the app's own window, under the default policy
  R.step = 'iframe';
  const fr = win.webContents.mainFrame.frames.find((f) => f.url.startsWith(SITE));
  R.iframe = fr ? await fr.executeJavaScript(${
      JSON.stringify(AIO_REACH)
    }) : 'not loaded';
  const strict = new BrowserWindow({ width: 300, height: 200, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  await strict.loadURL('aio://app/noframes');
  await wait(700);
  R.noframes = { foreign: hits.includes('/frame-refused'), own: strict.webContents.mainFrame.frames.some((f) => f.url === 'aio://app/preview') };
  strict.destroy();
  // ── a child window, made as the shell makes one
  R.step = 'child';
  const child = new BrowserWindow({ width: 400, height: 300, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: 'persist:aio-child' } });
  R.childSession = { app: child.webContents.session === session.defaultSession, persistent: child.webContents.session.isPersistent() };
  ${guarded ? "__aioGuardChild(child, SITE + '/child');" : ""}
  await child.loadURL(SITE + '/child');
  R.childAio = await child.webContents.executeJavaScript(${
      JSON.stringify(AIO_REACH)
    });
  const before = webContents.getAllWebContents().length;
  await child.webContents.executeJavaScript("window.open('" + SITE + "/pop'); 1");
  await wait(700);
  R.childPopups = webContents.getAllWebContents().length - before;
  await child.webContents.executeJavaScript("location.href = '/same'; 1");
  await wait(600);
  R.childSame = short(child.webContents.getURL());
  await child.webContents.executeJavaScript("location.href = '" + OTHER + "/away'; 1");
  await wait(600);
  R.childAway = short(child.webContents.getURL());
  await child.webContents.executeJavaScript("location.href = '" + SITE + "/hop'; 1");
  await wait(600);
  R.childHop = short(child.webContents.getURL());
  ${
      guarded
        ? `// Never the app's own scheme (only with the rules: unguarded, Electron
  // hands a scheme this session does not serve to the OS).
  await child.webContents.executeJavaScript("location.href = 'aio://app/preview'; 1");
  await wait(600);
  R.childAio2 = short(child.webContents.getURL());
  // …and one opened with origins stays on them.
  const held = new BrowserWindow({ width: 400, height: 300, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: 'persist:aio-child' } });
  __aioGuardChild(held, SITE + '/held', []);
  await held.loadURL(SITE + '/held');
  await held.webContents.executeJavaScript("location.href = '/held-same'; 1");
  await wait(600);
  await held.webContents.executeJavaScript("location.href = '" + OTHER + "/away'; 1");
  await wait(600);
  R.heldAway = short(held.webContents.getURL());
  await held.webContents.executeJavaScript("location.href = '" + SITE + "/hop'; 1");
  await wait(600);
  R.heldHop = short(held.webContents.getURL());
  held.destroy();`
        : ""
    }
  // ── downloads, last: a refused one leaves nothing on screen
  R.step = 'downloads';
  await g1.executeJavaScript("location.href = '/dl'; 1");
  await child.webContents.executeJavaScript("location.href = '" + SITE + "/dl'; 1");
  await wait(1000);
  R.downloads = items;
  out();
}).catch((e) => { R.error = String((e && e.stack) || e); out(); });`;
    new Function(main); // a generated script nothing type-checks: parse it
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
    return r;
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
    "web isolation e2e control: WITHOUT the rules a <webview> with no partition reads and POSTs to aio://app (a worker too), a guest opens links by itself, a child window opens a real window and goes anywhere",
  async fn() {
    const r = await runReal(false);
    assertEquals(r.g1.appSession, true);
    assertEquals(r.g1.aio, {
      fetch: "read",
      nocors: "sent",
      post: "sent",
      script: "loaded",
      worker: "read",
    });
    // A partition of its own never had the scheme: that part is Electron's.
    assertEquals(r.g2.aio, REFUSED);
    assertEquals(r.childAio, REFUSED);
    assertEquals(r.byItself, ["https://example.com/by-itself"]);
    assertEquals(r.childPopups, 1);
    assertEquals(r.childAway, "/away");
    assertEquals(r.childHop, "/landed");
    // Electron's own: a guest cannot get Node back, and nobody gets a device.
    assertEquals(r.g1.sandbox, true);
    assertEquals(r.g1.node, "undefined undefined");
    assertEquals(r.hid.app, "devices 0");
    assertEquals(r.downloads, ["allowed", "allowed"]);
    // A guest in the app's session goes wherever it is sent — and the site
    // it lands on reads aio://app.
    assertEquals(r.sessions, { own: "app", blank: "app" });
    assertEquals(
      [r.ownSame, r.ownPage, r.ownRedirect, r.ownEmbedder],
      ["aio://app/preview?again", "/by-page", "/redirected", "/by-embedder"],
    );
    assertEquals(r.ownAio, READS);
    assertEquals(r.blankAio, READS);
    // "persist:" is not a partition: it IS the app's session, and a guest
    // that gets the name past the tag sits in it and reads aio://app.
    assertEquals(r.persistIsDefault, true);
    assertEquals(r.g3, { appSession: true, aio: READS });
    assertEquals(r.inGuestFrame, true);
    assertEquals(r.sso, { app: true, served: true });
    // The default policy loads a foreign frame, and the frame reads aio://app:
    // this is why it is SAID (the rule cannot be a refusal — see the shell).
    assertEquals(r.iframe, READS);
  },
});

Deno.test({
  ...E2E,
  name:
    "web isolation e2e: a real guest cannot reach aio://, opens a link only on a real click (one per 2 s), saves no file and gets no device; a child window opens no window, navigates anywhere but aio:// and is held by origins; the app wipes a partition, never its own session",
  async fn() {
    const r = await runReal(true);
    const said = (s: string) =>
      assert(
        r.warnings.some((w: string) => w.includes(s)),
        `no line "${s}" in:\n${r.warnings.join("\n")}`,
      );
    // W6 — forced, and out of the app's session: nothing of aio:// is reachable.
    assertEquals(
      [r.g1.sandbox, r.g1.contextIsolation, r.g1.nodeIntegration, r.g1.node],
      [true, true, false, "undefined undefined"],
    );
    assertEquals([r.g1.appSession, r.g1.ownSession], [false, true]);
    assertEquals(r.g1.aio, REFUSED);
    assertEquals(r.g2.named, true, "a named partition is the app's choice");
    assertEquals(r.g2.aio, REFUSED);
    said('gets the session "persist:aio-webview"');
    // …and the app's own page still loads everything it serves.
    assertEquals(r.app, {
      fetch: "read",
      nocors: "sent",
      post: "sent",
      script: "loaded",
      worker: "read",
    });
    // H3 — by itself: nothing. A real click: one. A second click at once: none.
    assertEquals(r.byItself, []);
    assertEquals(r.afterClick, ["https://example.com/clicked"]);
    assertEquals(r.afterSecondClick, ["https://example.com/clicked"]);
    said("pop-up BLOCKED from <webview> guest");
    // The 300 made-up schemes are ONE line, and every later kind still speaks
    // (the downloads at the end of this run are the proof).
    assertEquals(
      r.warnings.filter((w: string) => w.includes("only http/https links open"))
        .length,
      1,
    );
    said("no click or key press");
    said("more than one link in 2 s");
    // W2 — no device, for the guest (its permission is refused) or the app.
    assert(/^(refused|devices 0)/.test(r.hid.guest), r.hid.guest);
    assertEquals(r.hid.app, "devices 0");
    said(
      "HID device request from the app's own page (aio://app) was left to Electron",
    );
    // Lock → wipe.
    assertEquals(r.stored, ["k=1", "b"]);
    assertEquals(r.wipe, { ok: true, partition: "persist:e2e" });
    assertStringIncludes(r.wipeNone, "clearPartition refused");
    // "persist:" is the app's own session: refused, nothing of the app wiped.
    assertStringIncludes(r.wipeApp, "resolves to the app's own session");
    assertEquals(r.appKept, "kept");
    // …and a guest that asks for it is moved out like one with no partition.
    assertEquals(r.g3, { appSession: false, aio: REFUSED });
    assertEquals(r.afterWipe, ["", null]);
    said('partition "persist:e2e" cleared');
    // A guest in the app's own session stays on the app: its own navigation,
    // a redirect and the embedder's src are all stopped — nothing of the
    // other site was ever requested by the page or the redirect.
    assertEquals(r.sessions, { own: "app", blank: "guests" });
    assertEquals(r.ownSame, "aio://app/preview?again");
    assertEquals(
      [r.ownPage, r.ownRedirect, r.ownEmbedder],
      Array(3).fill("aio://app/preview?again"),
      "a guest in the app's session left for another site",
    );
    assertEquals(r.ownHits, []);
    said("navigation BLOCKED in <webview> guest to http://127.0.0.1");
    said("stays in the app's session");
    // Its foreign frame loads (as in the app's window) and is said; a window
    // in the app's session still leaves for another site.
    assertEquals(r.inGuestFrame, true);
    said("loaded in a <webview> with no partition (the app's session)");
    assertEquals(r.sso, { app: true, served: true });
    assert(
      !r.warnings.some((w: string) => w.includes("named no window")),
      r.warnings.join("\n"),
    );
    // One that started on about:blank browses — out of the app's session.
    assertEquals(r.blankAt, "/from-blank");
    assertEquals(r.blankAio, REFUSED);
    // A foreign <iframe> under the DEFAULT policy loads and reads aio://app
    // (not refusable without breaking embeds): said, with the two ways out —
    // and the CSP way out does refuse the frame, and only the foreign one.
    assertEquals(r.iframe, READS);
    said("loaded in the app's own window");
    assertEquals(r.noframes, { foreign: false, own: true });
    // H1/H2/H4 — the child window, in the child windows' persistent session.
    assertEquals(r.childSession, { app: false, persistent: true });
    assertEquals(r.childAio, REFUSED);
    assertEquals(r.childPopups, 0, "a child window opened a real window");
    said("pop-up BLOCKED from openWindow child window");
    // Navigation as in 1.0.18 — a login flow crosses origins, by link and by
    // redirect — but never to the app's own scheme; origins holds it.
    assertEquals(r.childSame, "/same");
    assertEquals(r.childAway, "/away");
    assertEquals(r.childHop, "/landed");
    assertEquals(r.childAio2, "/landed", "a child window reached aio://");
    said("to aio: — a child window never navigates to the app's own scheme");
    assertEquals(r.heldAway, "/held-same", "it left its listed origins");
    assertEquals(r.heldHop, "/held-same", "a redirect took it off them");
    said("this window was opened with origins");
    // W1 — both downloads cancelled, both said.
    assertEquals(r.downloads, ["cancelled", "cancelled"]);
    said("download CANCELLED from <webview> guest");
    said("download CANCELLED from openWindow child window");
  },
});
