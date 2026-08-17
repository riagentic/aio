// Unit tests for src/electron.ts — pure function coverage (no Electron/display needed)
import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  electronClientScript,
  electronMainScript,
  electronMainScriptUDS,
} from "../src/electron/electron.ts";

// ── electronMainScript ──────────────────────────────────────────────

Deno.test("electron: mainScript — default dimensions 800x600", () => {
  const s = electronMainScript("http://localhost:3000");
  assertStringIncludes(s, "loadBounds(800, 600)");
});

Deno.test("electron: mainScript — custom dimensions from meta", () => {
  const s = electronMainScript("http://localhost:3000", {
    width: 1024,
    height: 768,
  });
  assertStringIncludes(s, "loadBounds(1024, 768)");
});

Deno.test("electron: mainScript — URL is embedded", () => {
  const s = electronMainScript("https://my-app.local:8080");
  assertStringIncludes(s, "https://my-app.local:8080");
});

Deno.test("electron: mainScript — slug from title", () => {
  const s = electronMainScript("http://localhost:3000", {
    title: "My Cool App!",
  });
  assertStringIncludes(s, '"my-cool-app"');
});

Deno.test("electron: mainScript — default slug when no title", () => {
  const s = electronMainScript("http://localhost:3000");
  assertStringIncludes(s, '"aio-app"');
});

Deno.test("electron: mainScript — contains window state persistence", () => {
  const s = electronMainScript("http://localhost:3000");
  assertStringIncludes(s, "window-state.json");
  assertStringIncludes(s, "saveBounds");
  assertStringIncludes(s, "loadBounds");
});

Deno.test("electron: mainScript — keyboard shortcuts", () => {
  const s = electronMainScript("http://localhost:3000");
  assertStringIncludes(s, "reloadIgnoringCache");
  assertStringIncludes(s, "toggleDevTools");
  assertStringIncludes(s, "F5");
  assertStringIncludes(s, "F12");
});

Deno.test("electron: mainScript — self-signed cert acceptance for localhost", () => {
  const s = electronMainScript("https://localhost:8443");
  assertStringIncludes(s, "certificate-error");
  assertStringIncludes(s, "localhost");
});

Deno.test("electron: mainScript — menu disabled", () => {
  const s = electronMainScript("http://localhost:3000");
  assertStringIncludes(s, "Menu.setApplicationMenu(null)");
});

Deno.test("electron: mainScript — context isolation enabled", () => {
  const s = electronMainScript("http://localhost:3000");
  assertStringIncludes(s, "contextIsolation: true");
  assertStringIncludes(s, "nodeIntegration: false");
});

// ── electronClientScript ────────────────────────────────────────────

Deno.test("electron: clientScript — contains connect page HTML", () => {
  const s = electronClientScript();
  assertStringIncludes(s, "CONNECT_HTML");
  assertStringIncludes(s, "<title>aio</title>");
  assertStringIncludes(s, "Connect</button>");
});

Deno.test("electron: clientScript — parses --server-url from argv", () => {
  const s = electronClientScript();
  assertStringIncludes(s, "--server-url=");
  assertStringIncludes(s, "process.argv");
});

Deno.test("electron: clientScript — validates URL scheme", () => {
  const s = electronClientScript();
  assertStringIncludes(s, "http://");
  assertStringIncludes(s, "https://");
});

Deno.test("electron: clientScript — fetches page meta (title, width, height)", () => {
  const s = electronClientScript();
  assertStringIncludes(s, "parseMeta");
  assertStringIncludes(s, "aio:width");
  assertStringIncludes(s, "aio:height");
});

Deno.test("electron: clientScript — fetches icon from server", () => {
  const s = electronClientScript();
  assertStringIncludes(s, "/icon.png");
  assertStringIncludes(s, "nativeImage.createFromBuffer");
});

Deno.test("electron: clientScript — redirect handling bounded", () => {
  const s = electronClientScript();
  assertStringIncludes(s, "maxRedirects");
  assertStringIncludes(s, "Too many redirects");
});

Deno.test("electron: clientScript — PIN pairing flow wired", () => {
  const s = electronClientScript();
  // Main process: POST helper, pair handler, and the aio-pair: route.
  assertStringIncludes(s, "function postJson");
  assertStringIncludes(s, "/__aio/pair");
  assertStringIncludes(s, "async function pairWith");
  assertStringIncludes(s, "aio-pair:");
  // A paired app's cert is pinned before the page loads.
  assertStringIncludes(s, "pinCert(rec.host, rec.cert)");
  // Connect page: auth apps prompt for a PIN instead of connecting blind.
  assertStringIncludes(s, "promptPair");
  assertStringIncludes(s, "onAppClick");
});

// ── electronMainScriptUDS ───────────────────────────────────────────

Deno.test("electron: UDS script — socket path embedded", () => {
  const s = electronMainScriptUDS(
    "http://localhost:3000",
    "/tmp/test.sock",
    {},
  );
  assertStringIncludes(s, "/tmp/test.sock");
});

Deno.test("electron: UDS script — IPC bridge preload", () => {
  const s = electronMainScriptUDS(
    "http://localhost:3000",
    "/tmp/test.sock",
    {},
  );
  assertStringIncludes(s, "contextBridge.exposeInMainWorld");
  assertStringIncludes(s, "__aioIPC");
  assertStringIncludes(s, "__aio:send");
  assertStringIncludes(s, "__aio:ready");
  assertStringIncludes(s, "__aio:msg");
  assertStringIncludes(s, "__aio:open");
  assertStringIncludes(s, "__aio:close");
});

Deno.test("electron: UDS script — NDJSON protocol", () => {
  const s = electronMainScriptUDS(
    "http://localhost:3000",
    "/tmp/test.sock",
    {},
  );
  // Uses newline-delimited JSON over UDS
  assertStringIncludes(s, "split('\\n')");
  assertStringIncludes(s, "json + '\\n'");
});

Deno.test("electron: UDS script — reconnection with exponential backoff", () => {
  const s = electronMainScriptUDS(
    "http://localhost:3000",
    "/tmp/test.sock",
    {},
  );
  assertStringIncludes(s, "Math.pow(2, retry)");
  assertStringIncludes(s, "8000"); // max backoff
  assertStringIncludes(s, "connectUDS");
});

Deno.test("electron: UDS script — ready handshake (not timeout)", () => {
  const s = electronMainScriptUDS(
    "http://localhost:3000",
    "/tmp/test.sock",
    {},
  );
  assertStringIncludes(s, "__aio:ready");
  assertStringIncludes(s, "ipcMain.on");
  // Should NOT use timeout-based state sending (the v0.9.4 bug)
  // The pattern is: ipcMain.on('__aio:ready', ...) triggers state replay
});

Deno.test("electron: UDS script — auto-detect prod vs dev", () => {
  const s = electronMainScriptUDS("http://localhost:3000", "/tmp/test.sock", {
    baseDir: "/app/dist",
  });
  assertStringIncludes(s, "USE_PROTOCOL");
  assertStringIncludes(s, "app.js");
  assertStringIncludes(s, "aio://");
});

Deno.test("electron: UDS script — custom title and CSS", () => {
  const s = electronMainScriptUDS("http://localhost:3000", "/tmp/test.sock", {
    title: "Dashboard",
    hasCSS: true,
  });
  assertStringIncludes(s, "Dashboard");
  assertStringIncludes(s, "style.css");
});

Deno.test("electron: UDS script — no CSS when hasCSS=false", () => {
  const s = electronMainScriptUDS("http://localhost:3000", "/tmp/test.sock", {
    title: "Test",
    hasCSS: false,
  });
  const hasCSSLink = s.includes("style.css");
  assertEquals(hasCSSLink, false);
});

Deno.test("electron: UDS script — custom meta dimensions", () => {
  const s = electronMainScriptUDS("http://localhost:3000", "/tmp/test.sock", {
    meta: { width: 1200, height: 900, title: "Big App" },
  });
  assertStringIncludes(s, "loadBounds(1200, 900)");
  assertStringIncludes(s, '"big-app"');
});

Deno.test("electron: UDS script — preload cleanup on exit", () => {
  const s = electronMainScriptUDS(
    "http://localhost:3000",
    "/tmp/test.sock",
    {},
  );
  assertStringIncludes(s, "unlinkSync(preloadFile)");
});

Deno.test("electron: UDS script — MIME types for static serving", () => {
  const s = electronMainScriptUDS("http://localhost:3000", "/tmp/test.sock", {
    baseDir: "/app",
  });
  assertStringIncludes(s, "text/html");
  assertStringIncludes(s, "application/javascript");
  assertStringIncludes(s, "text/css");
  assertStringIncludes(s, "application/wasm");
});

Deno.test("electron: UDS script — socket destruction on window close", () => {
  const s = electronMainScriptUDS(
    "http://localhost:3000",
    "/tmp/test.sock",
    {},
  );
  assertStringIncludes(s, "sock.destroy()");
  assertStringIncludes(s, "clearTimeout(reconnectTimer)");
});

Deno.test("electron: UDS script — buffers frames until the renderer is ready", () => {
  const s = electronMainScriptUDS(
    "http://localhost:3000",
    "/tmp/test.sock",
    {},
  );
  // ONE readiness decider — the renderer's own __aio:ready. `did-finish-load`
  // used to gate relayed frames independently of it, and everything that
  // landed between the two was dropped (see tests/electron-main-relay.test.ts,
  // which proves the behaviour rather than the spelling).
  assertStringIncludes(s, "let rendererReady = false");
  assertEquals(
    s.includes("pageReady"),
    false,
    "a second readiness flag must not come back",
  );
  assertEquals(
    s.includes("on('did-finish-load'"),
    false,
    "did-finish-load must not gate frame delivery — only __aio:ready does",
  );
  // Buffering is a queue, not a one-slot cache: every undelivered frame waits.
  assertStringIncludes(s, "_pending.push(");
  assertStringIncludes(s, "function _pump()");
});

Deno.test("electron: UDS script — reports a backend outage once, with the true reason", () => {
  const s = electronMainScriptUDS(
    "http://localhost:3000",
    "/tmp/test.sock",
    {},
  );
  // No raw per-error stack-trace flood anymore.
  assertEquals(
    s.includes('console.error("[aio:electron] UDS socket error:"'),
    false,
    "the raw per-retry socket-error log must be gone",
  );
  // Outage is reported once (guarded by the `down` flag) with an actionable reason.
  assertStringIncludes(s, "let down = false");
  assertStringIncludes(s, "if (!down)");
  assertStringIncludes(s, "is the aio server running?");
  // ECONNREFUSED/ENOENT get the "server not running" hint, not a generic dump.
  assertStringIncludes(s, "ECONNREFUSED");
  assertStringIncludes(s, "ENOENT");
  // Recovery is announced once.
  assertStringIncludes(s, "backend connection restored");
});

// ── electron auto-install ────────────────────────────────
import { autoInstallElectron } from "../src/electron/electron-spawn.ts";

// The contract is "is Electron INSTALLED now", not "did the installer exit
// zero" — because `deno install --allow-scripts` exits zero having skipped the
// lifecycle script, leaving a package with no `dist/`. Returning success there
// is what told a build the runtime was ready when it was not, and sent a user
// chasing `deno task install:electron` in a loop.
Deno.test("autoInstallElectron: answers 'is it installed', not 'did the command exit 0'", async () => {
  const infos: string[] = [];
  const log = { info: (m: string) => infos.push(m), error: () => {} };

  assertEquals(
    await autoInstallElectron(
      log,
      () => Promise.resolve({ success: true }),
      () => Promise.resolve(true),
    ),
    true,
  );
  assertEquals(
    await autoInstallElectron(
      log,
      // The exact shape of the bug: the command succeeds, nothing is installed.
      () => Promise.resolve({ success: true }),
      () => Promise.resolve(false),
    ),
    false,
    "an installer that exits 0 while installing nothing must NOT report success",
  );
  assertEquals(
    await autoInstallElectron(
      log,
      () => Promise.resolve({ success: false }),
      () => Promise.resolve(true),
    ),
    true,
    "…and a non-zero exit with the runtime present is still installed",
  );
  assertEquals(
    await autoInstallElectron(
      log,
      () => Promise.reject(new Error("spawn")),
      () => Promise.resolve(false),
    ),
    false,
  );
  // Loud: every attempt announces what it's doing (no silent installs).
  assertEquals(infos.length >= 4, true);
  assertEquals(infos[0]!.includes("--allow-scripts=npm:electron"), true);
});

// ── Main-process crash guard (no native error dialog on close) ──────

Deno.test("electron: all templates install a main-process crash guard", () => {
  // Without an uncaughtException listener, ANY stray exception in the Electron
  // main process pops the native "A JavaScript error occurred" dialog — the
  // "javascript error popup on close" users report. Every template must install
  // the guard so the dialog can never appear.
  const scripts = [
    electronMainScript("http://localhost:3000"),
    electronMainScriptUDS("http://localhost:3000", "/tmp/t.sock", {}),
    electronClientScript(),
  ];
  for (const s of scripts) {
    assertStringIncludes(s, "process.on('uncaughtException'");
    assertStringIncludes(s, "process.on('unhandledRejection'");
  }
});

Deno.test("electron: generated main.cjs is syntactically valid JS", () => {
  // new Function(body) PARSES the whole script (regex literals included) without
  // executing it — catches a malformed regex range or any syntax breakage that
  // would otherwise only surface when Electron loads the generated main.cjs.
  const scripts = [
    electronMainScript("http://localhost:3000", { title: "App" }),
    electronMainScriptUDS("http://localhost:3000", "/tmp/t.sock", {
      title: "App",
    }),
    electronClientScript(),
  ];
  for (const s of scripts) {
    // Throws SyntaxError on any parse error (e.g. an out-of-order regex range).
    new Function(s);
  }
});
