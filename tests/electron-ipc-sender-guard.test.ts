// 🔒 aio's IPC and the app's permissions answer the app's own page only.
//
// Known gap of 1.0.13: every `__aio:*` ipcMain handler answered ANY sender —
// a <webview> guest whose (app-dir) preload calls ipcRenderer.send, an
// openWindow child's preload, a subframe, a foreign document in the window —
// and a server-side redirect out of the app (will-navigate never sees one)
// put a foreign site in the app's window, where it was that "app" to both.
// The redirect still loads (an app's login route may 302 to its identity
// provider, and did load in 1.0.12); the guards refuse the site instead.
// These RUN the generated fragments against fakes, so what is asserted is
// what the shell decides. The real-Electron proof is electron-ipc-e2e.
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  tmplIpcGuard,
  tmplPermissionGuard,
  tmplWillNavigate,
} from "../src/electron/electron-shared.ts";
import { electronMainScript } from "../src/electron/electron-scripts.ts";
import { electronMainScriptUDS } from "../src/electron/electron-uds.ts";

type Fn = (...a: unknown[]) => unknown;
const APP = "http://127.0.0.1:4321";

function frame(url: string, parent: unknown = null) {
  return { url, parent };
}

function harness() {
  const on: Record<string, Fn> = {};
  const handle: Record<string, Fn> = {};
  const warnings: string[] = [];
  const raw = {
    on: (c: string, f: Fn) => (on[c] = f),
    handle: (c: string, f: Fn) => (handle[c] = f),
  };
  const app = { on() {} };
  const { ipcMain, bind, perm } = new Function(
    "app",
    "require",
    "console",
    tmplPermissionGuard() + tmplIpcGuard() +
      "\nreturn { ipcMain, bind: __aioIpcBind, perm: __aioPermOk };",
  )(
    app,
    () => ({ ipcMain: raw, session: {} }),
    { warn: (m: unknown) => warnings.push(String(m)), error() {}, log() {} },
  ) as {
    ipcMain: { on(c: string, f: Fn): void; handle(c: string, f: Fn): void };
    bind(win: unknown, origin: string): void;
    perm(wc: unknown, permission: string, requesting: string): boolean;
  };
  let url = APP + "/";
  const wc = { getType: () => "window", getURL: () => url };
  const win = { webContents: wc, isDestroyed: () => false };
  const go = (u: string) => (url = u);
  return { on, handle, warnings, ipcMain, bind, perm, win, wc, go };
}

Deno.test("IPC guard: only the app window's top frame on the app's origin is admitted", () => {
  const h = harness();
  const got: unknown[] = [];
  h.ipcMain.on("__aio:send", (_e, json) => got.push(json));
  // Before the shell binds its window, nothing is admitted.
  h.on["__aio:send"]!({ sender: h.wc, senderFrame: frame(APP + "/") }, "early");
  h.bind(h.win, APP);
  const ok = { sender: h.wc, senderFrame: frame(APP + "/x?token=k") };
  h.on["__aio:send"]!(ok, "mine");
  // A <webview> guest / openWindow child: another webContents.
  h.on["__aio:send"]!({ sender: {}, senderFrame: frame(APP + "/") }, "guest");
  // A subframe of the app window — even one on the app's own origin.
  h.on["__aio:send"]!(
    { sender: h.wc, senderFrame: frame(APP + "/", frame(APP)) },
    "sub",
  );
  // The top frame, showing another origin (e.g. after a redirect).
  h.on["__aio:send"]!(
    { sender: h.wc, senderFrame: frame("https://evil.example/") },
    "foreign",
  );
  // A frame already gone.
  h.on["__aio:send"]!({ sender: h.wc, senderFrame: null }, "gone");
  // A disposed frame throws on access: refused, not crashed.
  h.on["__aio:send"]!({
    sender: h.wc,
    get senderFrame() {
      throw new Error("Render frame was disposed");
    },
  }, "disposed");
  assertEquals(got, ["mine"]);
  assertEquals(h.warnings.length, 6, h.warnings.join("\n"));
  for (const w of h.warnings) assert(w.includes('IPC "__aio:send" REFUSED'), w);
  assert(h.warnings.some((w) => w.includes("https://evil.example")));
  assert(!h.warnings.some((w) => w.includes("token=k")));
  // Said once per channel and sender kind.
  h.on["__aio:send"]!({ sender: {}, senderFrame: frame(APP + "/") }, "guest");
  assertEquals(h.warnings.length, 6);
});

Deno.test("IPC guard: a refused invoke rejects with the reason; an admitted one answers", async () => {
  const h = harness();
  h.bind(h.win, "aio://app");
  h.ipcMain.handle("__aio:openWindow", () => ({ ok: true }));
  const call = (e: unknown) =>
    Promise.resolve().then(() => h.handle["__aio:openWindow"]!(e, {}));
  assertEquals(
    await call({ sender: h.wc, senderFrame: frame("aio://app/") }),
    { ok: true },
  );
  await assertRejects(
    () => call({ sender: {}, senderFrame: frame("aio://app/") }),
    Error,
    "REFUSED",
  );
});

Deno.test("permission guard: the app window on a foreign site is not the app", () => {
  const h = harness();
  const other = {
    getType: () => "window",
    getURL: () => "https://idp.example/",
  };
  // Unbound (1.0.12): a window's own origin is its app page.
  assertEquals(h.perm(h.wc, "notifications", APP), true);
  h.bind(h.win, APP);
  assertEquals(h.perm(h.wc, "notifications", APP), true);
  // A redirect took the app window to the identity provider.
  h.go("https://idp.example/login");
  assertEquals(h.perm(h.wc, "notifications", "https://idp.example"), false);
  assertEquals(h.perm(h.wc, "fullscreen", "https://idp.example"), true);
  // Another window is NOT the app once the shell has said which one is: a
  // pop-up a child window opened was (a field report's audit), and held
  // every permission scoped "app".
  assertEquals(h.perm(other, "notifications", "https://idp.example"), false);
  assertEquals(h.perm(other, "fullscreen", "https://idp.example"), true);
  // Back home, the app again.
  h.go(APP + "/done");
  assertEquals(h.perm(h.wc, "notifications", APP), true);
});

Deno.test("IPC guard: both shells register every handler through the guarded ipcMain", () => {
  for (
    const src of [
      electronMainScript(APP + "/"),
      electronMainScriptUDS(APP + "/", "/tmp/x.sock", {}),
    ]
  ) {
    assert(!/\bipcMain\b[^}]*\}\s*=\s*require\('electron'\)/.test(src));
    assert(
      !/require\('electron'\)\.ipcMain/.test(src.replace(tmplIpcGuard(), "")),
    );
    assert(src.includes("__aioIpcBind(win, _appOrigin)"));
    // Bound before any handler registration.
    assert(
      src.indexOf("__aioIpcBind(win, _appOrigin)") <
        src.indexOf("ipcMain.on("),
    );
  }
});

function redirectHarness() {
  const handlers: Record<string, Fn> = {};
  const opened: string[] = [];
  const warnings: string[] = [];
  const routed: unknown[] = [];
  const wc = {
    on: (ev: string, f: Fn) => (handlers[ev] = f),
    setWindowOpenHandler() {},
    getURL: () => APP + "/",
    send: (_ch: string, u: unknown) => routed.push(u),
  };
  new Function(
    "win",
    "fs",
    "path",
    "console",
    "BASE_DIR",
    "_appOrigin",
    "require",
    tmplWillNavigate("_appOrigin"),
  )(
    { webContents: wc },
    {},
    { sep: "/" },
    { warn: (m: unknown) => warnings.push(String(m)), error() {}, log() {} },
    "/app",
    APP,
    () => ({ shell: { openExternal: (u: string) => opened.push(u) } }),
  );
  const redirect = (details: Record<string, unknown>, ...legacy: unknown[]) => {
    let prevented = false;
    handlers["will-redirect"]!(
      { ...details, preventDefault: () => (prevented = true) },
      ...legacy,
    );
    return prevented;
  };
  const navigate = (url: string) => {
    let prevented = false;
    handlers["will-navigate"]!(
      { preventDefault: () => (prevented = true) },
      url,
    );
    return prevented;
  };
  return { redirect, navigate, routed, opened, warnings };
}

Deno.test("will-navigate: a same-app /__aio/auth/ URL is a real load, never a client route", async () => {
  const h = redirectHarness();
  // aio's SSO button: the server must see it (1.0.12 pushState'd it).
  assertEquals(
    h.navigate(APP + "/__aio/auth/oidc/start?redirect=%2F"),
    false,
  );
  assertEquals(h.routed, []);
  // Any other /__aio/ link (a blob without `download`, the pairing page)
  // keeps 1.0.13's in-app handling: a real load would replace the app
  // document with a file or a page that has no way back.
  assertEquals(h.navigate(APP + "/__aio/blobs/abc"), true);
  assertEquals(h.navigate(APP + "/__aio/pair"), true);
  // An app route is still routed in-app.
  assertEquals(h.navigate(APP + "/settings"), true);
  assertEquals(h.routed, [
    APP + "/__aio/blobs/abc",
    APP + "/__aio/pair",
    APP + "/settings",
  ]);
  // The button this exists for still navigates to that path.
  const ui = await Deno.readTextFile(
    new URL("../src/browser/browser-auth-ui.ts", import.meta.url),
  );
  assert(ui.includes("location.href = `/__aio/auth/oidc/start?redirect="));
});

Deno.test("will-redirect: every redirect loads as in 1.0.12; leaving the app is said once per site", () => {
  const h = redirectHarness();
  assertEquals(h.redirect({ url: APP + "/login", isMainFrame: true }), false);
  // An app's login route that 302s to its identity provider keeps working.
  assertEquals(
    h.redirect({ url: "https://idp.example/auth?x=1", isMainFrame: true }),
    false,
  );
  assertEquals(
    h.redirect({ url: "https://idp.example/auth?x=2", isMainFrame: true }),
    false,
  );
  // A subframe's redirect is not the window's document: not said.
  assertEquals(
    h.redirect({ url: "https://ads.example/", isMainFrame: false }),
    false,
  );
  // Older Electron: positional (event, url, isInPlace, isMainFrame).
  assertEquals(h.redirect({}, "https://other.example/", false, true), false);
  assertEquals(h.redirect({}, "https://sub.example/", false, false), false);
  assertEquals(h.opened, [], "nothing goes to the system browser");
  assertEquals(h.warnings.length, 2, h.warnings.join("\n"));
  assert(h.warnings[0]!.includes("https://idp.example"), h.warnings[0]);
  assert(h.warnings[0]!.includes("IPC"), h.warnings[0]);
  assert(h.warnings[1]!.includes("https://other.example"), h.warnings[1]);
  assert(!h.warnings.some((w) => w.includes("x=1")), "no query in the log");
});
