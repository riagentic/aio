// The two Electron window shells — the WebSocket one (electronMainScript) and
// the zero-port UDS one (electronMainScriptUDS) — set up the same window from
// the shared tmpl* fragments. A feature added to one and not the other is how
// the WebSocket shell's window went without its icon (a field report).
//
// The list cannot rot: it is every exported tmpl* of the modules the shells
// share. A new fragment fails here until it is placed in SAME (both shells,
// same output for the same meta) or DIFFERS (with the reason).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import * as shared from "../src/electron/electron-shared.ts";
import * as splashMod from "../src/electron/electron-splash.ts";
import type { AioMeta } from "../src/electron/electron-shared.ts";
import type { ElectronSplash } from "../src/electron/electron-splash.ts";
import { electronMainScript } from "../src/electron/electron-scripts.ts";
import { electronMainScriptUDS } from "../src/electron/electron-uds.ts";

const URL_ = "https://127.0.0.1:8443/";
const TITLE = "Parity Probe";
const splash: ElectronSplash = {
  page: "/s/splash.html",
  title: TITLE,
  w: 320,
  h: 200,
  mode: "window",
  follow: true,
  minMs: 0,
  maxMs: 3000,
  fadeMs: 100,
  windowShadow: false,
};
// Every window option on, so every fragment emits something.
const meta: AioMeta = {
  title: TITLE,
  appId: "parity-probe",
  width: 640,
  height: 480,
  tray: true,
  confirmUnload: true,
  showWhenPainted: { capMs: 1234 },
  shortcuts: { reload: true, print: true },
  splash,
  profileDir: "/s/profile",
  guestPreloads: { dir: "/s/gp", files: ["a.js"] },
  chrome: "themed",
};

const ws = electronMainScript(URL_, meta);
const uds = electronMainScriptUDS(URL_, "/s/app.sock", { title: TITLE, meta });

/** Fragments both shells emit with the same arguments — the output must
 *  appear verbatim in both generated scripts. */
const SAME: Record<string, () => string> = {
  tmplAppMenu: () => shared.tmplAppMenu(TITLE),
  tmplProfileDir: () => shared.tmplProfileDir(meta.profileDir),
  tmplCrashGuard: () => shared.tmplCrashGuard(meta.confirmUnload),
  tmplPermissionGuard: () => shared.tmplPermissionGuard(meta.permissions),
  tmplWebGuard: () => shared.tmplWebGuard(meta),
  tmplIpcGuard: () => shared.tmplIpcGuard(),
  tmplGuestPreloads: () => shared.tmplGuestPreloads(meta.guestPreloads),
  tmplParentWatch: () => shared.tmplParentWatch(),
  tmplWindowShape: () =>
    shared.tmplWindowShape(meta, { preload: "preloadFile" }),
  tmplShowWhenPainted: () => shared.tmplShowWhenPainted(meta.showWhenPainted),
  tmplBoundsTracking: () => shared.tmplBoundsTracking(),
  tmplRendererDiagnostics: () => shared.tmplRendererDiagnostics(true),
  tmplTray: () => shared.tmplTray(meta, "__aioIcon", TITLE),
  tmplIconFit: () => shared.tmplIconFit(),
  tmplKeyboardShortcuts: () => shared.tmplKeyboardShortcuts(meta.shortcuts),
  tmplPreloadCleanup: () => shared.tmplPreloadCleanup(),
  tmplChromiumSwitches: () => shared.tmplChromiumSwitches(),
  tmplWindowClass: () => shared.tmplWindowClass(meta, TITLE),
  tmplCertificateGuard: () => shared.tmplCertificateGuard(URL_),
  tmplSplash: () => splashMod.tmplSplash(meta.splash),
};

/** Fragments both shells call with shell-specific arguments, or only one
 *  shell needs — each with why. */
const DIFFERS: Record<string, { only?: "uds" | "ws"; why: string }> = {
  tmplBounds: { why: "the UDS shell loads bounds asynchronously" },
  tmplWillNavigate: { why: "the UDS shell reopens its relay on a veto" },
  tmplPreloadWrite: { why: "each shell has its own preload" },
  tmplSocketFetch: { only: "uds", why: "the aio:// proxy to the app socket" },
};

const SRC = {
  ws: Deno.readTextFileSync(
    new URL("../src/electron/electron-scripts.ts", import.meta.url),
  ),
  uds: Deno.readTextFileSync(
    new URL("../src/electron/electron-uds.ts", import.meta.url),
  ),
};

const fragments = [
  ...Object.keys(shared),
  ...Object.keys(splashMod),
].filter((k) => /^tmpl[A-Z]/.test(k)).sort();

Deno.test("electron shells: every shared tmpl* fragment is classified", () => {
  const known = new Set([...Object.keys(SAME), ...Object.keys(DIFFERS)]);
  assertEquals(fragments.filter((f) => !known.has(f)), [], "unclassified");
  assertEquals(
    [...known].filter((f) => !fragments.includes(f)),
    [],
    "classified but no longer exported",
  );
});

Deno.test("electron shells: both call every window fragment (or say why not)", () => {
  for (const f of fragments) {
    const only = DIFFERS[f]?.only;
    for (const shell of ["ws", "uds"] as const) {
      const calls = SRC[shell].includes(`${f}(`);
      assertEquals(
        calls,
        !only || only === shell,
        `${f} in the ${shell} shell`,
      );
    }
  }
});

Deno.test("electron shells: the same meta gives the same window setup in both", () => {
  for (const [f, emit] of Object.entries(SAME)) {
    const out = emit();
    // aio-ok: a guard, not the claim — an empty fragment would make the two includes below vacuous
    assert(out.trim().length > 0, `${f} emits nothing for the probe meta`);
    assertStringIncludes(ws, out, `${f}: WebSocket shell`);
    assertStringIncludes(uds, out, `${f}: UDS shell`);
  }
});

Deno.test("electron shells: both set the window's own icon", () => {
  // Not a shared fragment — the WS shell fetches it, the UDS one reads it.
  assertStringIncludes(ws, "win.setIcon(");
  assertStringIncludes(uds, "win.setIcon(");
});

Deno.test("electron shells: the window class is the app id, set on Linux only", () => {
  assertEquals(shared.windowClassName(meta, TITLE), "parity-probe");
  assertEquals(shared.windowClassName({ title: TITLE }), "parity-probe");
  assertEquals(shared.windowClassName(undefined, "Other App"), "other-app");
  assertEquals(
    shared.tmplWindowClass(meta),
    `if (process.platform === 'linux') app.setDesktopName("parity-probe.desktop");\n`,
  );
  // Before any window exists: Chromium reads it at each window's creation.
  for (const s of [ws, uds]) {
    assert(
      s.indexOf("app.setDesktopName(") < s.indexOf("new BrowserWindow("),
      "the class is set before the first window",
    );
  }
});

Deno.test("electron shells: both preloads carry the one shell bridge (__aioShell, __aioWindow and its icon calls)", () => {
  const bridge = shared.shellBridgePreload();
  assertStringIncludes(shared.udsPreloadScript(), bridge);
  // The WebSocket shell writes its preload from a JSON string literal.
  assertStringIncludes(ws, JSON.stringify(bridge).slice(1, -1));
  assertStringIncludes(bridge, "setTrayIcon:");
});

Deno.test("the aio client window has its own class too — the one its .desktop names", async () => {
  const { electronClientScript, CLIENT_WINDOW_CLASS } = await import(
    "../src/electron/electron-client-script.ts"
  );
  assertEquals(CLIENT_WINDOW_CLASS, "aio-client");
  const s = electronClientScript(null);
  assertStringIncludes(s, shared.tmplWindowClass(undefined, "aio-client"));
  assert(
    s.indexOf("app.setDesktopName(") < s.indexOf("new BrowserWindow("),
    "the class is set before the window",
  );
});

Deno.test("electron shells: every generated script parses — main scripts, preloads, the aio client", async () => {
  const { electronClientScript } = await import(
    "../src/electron/electron-client-script.ts"
  );
  const scripts: Record<string, string> = {
    "ws main": ws,
    "uds main": uds,
    "ws main, bare meta": electronMainScript(URL_, {}),
    "uds main, bare meta": electronMainScriptUDS(URL_, "/s/a.sock", {}),
    "ws preload": shared.shellBridgePreload({ standalone: true }) +
      shared.udsPreloadDiagnostics(),
    "uds preload": shared.udsPreloadScript(),
    "aio client": electronClientScript(null),
    "aio client, baked + pinned": electronClientScript("https://h:1", {
      strictPin: true,
    }),
  };
  const broken: string[] = [];
  for (const [name, code] of Object.entries(scripts)) {
    try {
      new Function("require", "module", "exports", "__dirname", code);
    } catch (e) {
      broken.push(`${name}: ${(e as Error).message}`);
    }
  }
  assertEquals(broken, [], "generated scripts that do not parse");
});
