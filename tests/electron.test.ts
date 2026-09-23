// Unit tests for src/electron.ts — pure function coverage (no Electron/display needed)
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  electronProfileName,
  tmplBounds,
} from "../src/electron/electron-shared.ts";
import { homedir } from "../src/server/paths.ts";
import { lockKey, parseLockKey } from "../src/server/single-instance-lock.ts";
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
  // The preload lives in a private directory of its own (0700, random name —
  // see tmplPreloadWrite), so sweeping it is a directory removal now.
  assertStringIncludes(s, "rmSync(preloadDir");
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
  // did-finish-load appears exactly once — the empty-#root watchdog
  // (tmplRendererDiagnostics), which observes and never gates: the only code
  // after it is a timer that logs. A second listener would be the gate again.
  const finishes = s.split("on('did-finish-load'");
  assertEquals(
    finishes.length,
    2,
    "did-finish-load must appear once (the watchdog)",
  );
  assertStringIncludes(finishes[1]!.slice(0, 200), "++_loadGen");
  assertEquals(
    finishes[1]!.slice(0, 600).includes("rendererReady"),
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
import {
  autoInstallElectron,
  electronConfigNotes,
  electronImportSpec,
  electronSpecsInText,
} from "../src/electron/electron-spawn.ts";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { DEFAULT_ELECTRON_VERSION } from "../src/electron/electron-runtime-fetch.ts";

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
  // …and announces the PINNED version, not a bare `npm:electron` (latest at
  // install time), so a dev tree cannot drift from the build's floor.
  assert(
    infos[0]!.includes(`npm:electron@${DEFAULT_ELECTRON_VERSION}`),
    `the auto-install must name the framework's version: ${infos[0]}`,
  );
});

// A field report: `deno install --allow-scripts=npm:electron npm:electron@X`
// takes a POSITIONAL package, so deno REWRITES the app's import-map entry to
// X. WHICH X is policy — aio is tested with one Electron and a build ships
// exactly that one — but editing somebody's `deno.json` in SILENCE is not, and
// neither is leaving a second copy of the version behind so the file
// disagrees with itself. Both are said, by the installer, for every caller.
Deno.test("autoInstallElectron: the config rewrite is reported, never silent", async () => {
  const root = await tempDir("aio-electron-pin-");
  const none = await tempDir("aio-electron-none-");
  try {
    const pinned = JSON.stringify(
      {
        imports: { electron: "npm:electron@43.7.1" },
        tasks: {
          "install:electron":
            "deno install --allow-scripts=npm:electron@43.7.1",
        },
      },
      null,
      2,
    );
    await Deno.writeTextFile(join(root, "deno.json"), pinned);
    const said: string[] = [];
    const log = {
      warn: (m: string) => said.push(m),
      error: (m: string) => said.push(m),
    };
    assertEquals(
      await autoInstallElectron(
        log,
        // What `deno install <positional>` does to the file, measured.
        () => {
          const rewritten = pinned.replaceAll(
            '"electron": "npm:electron@43.7.1"',
            `"electron": "npm:electron@${DEFAULT_ELECTRON_VERSION}"`,
          );
          return Deno.writeTextFile(join(root, "deno.json"), rewritten)
            .then(() => ({ success: true }));
        },
        () => Promise.resolve(true),
        DEFAULT_ELECTRON_VERSION,
        root,
      ),
      true,
    );
    const all = said.join("\n");
    assertStringIncludes(all, "deno.json");
    assertStringIncludes(all, '"npm:electron@43.7.1"');
    assertStringIncludes(all, `"npm:electron@${DEFAULT_ELECTRON_VERSION}"`);
    assertStringIncludes(all, "am fix");
    // …and the copy the rewrite did NOT touch is named as a disagreement.
    assertStringIncludes(all, "DISAGREE");

    // An install that changes nothing says nothing.
    const quiet: string[] = [];
    await autoInstallElectron(
      {
        warn: (m: string) => quiet.push(m),
        error: (m: string) => quiet.push(m),
      },
      () => Promise.resolve({ success: true }),
      () => Promise.resolve(true),
      DEFAULT_ELECTRON_VERSION,
      none,
    );
    assertEquals(quiet, []);
  } finally {
    await dropTempDir(root);
    await dropTempDir(none);
  }
});

Deno.test("electronConfigNotes / electronSpecsInText: the app's copies of its Electron", () => {
  const was = '{"imports":{"electron":"npm:electron@43.7.1"}}';
  const now = '{"imports":{"electron":"npm:electron@44.4.1"}}';
  assertEquals(electronConfigNotes("deno.json", was, was, "43.7.1"), []);
  const notes = electronConfigNotes("deno.json", was, now, "44.4.1");
  assertEquals(notes.length, 1, notes.join("\n"));
  assertStringIncludes(notes[0]!, "43.7.1");
  assertStringIncludes(notes[0]!, "44.4.1");
  // A second, untouched copy is the disagreement the field report hit.
  const stale = electronConfigNotes(
    "deno.json",
    was,
    now + "\n// npm:electron@43.7.1",
    "44.4.1",
  );
  assertEquals(stale.length, 2, stale.join("\n"));
  assertStringIncludes(stale[1]!, "DISAGREE");
  assertEquals(electronSpecsInText("npm:electron@1.2.3 npm:/electron@1.2.3"), [
    "1.2.3",
  ]);
  assertEquals(electronSpecsInText("npm:electron"), []);
  // An unparseable config never throws out of a NOTE.
  assertEquals(electronImportSpec("{ not json", "deno.json"), null);
});

// ── One home, one Chromium profile ──────────────────────────────────

// A field report: aio lets a second instance of an app run beside the first
// when its home differs (the lock key is `lockKey(appId, home)`), but the
// Electron userData directory was keyed by the app TITLE alone — so both
// windows shared one Chromium profile, its cache, Local Storage and
// IndexedDB. Measured: the second instance hit `net::ERR_CACHE_READ_FAILURE`
// on a script and rendered a blank window; with the profile pointed
// elsewhere, 0 failures in 1674 requests on the same machine.
Deno.test("electron: a non-default home gets its OWN profile, keyed like the lock", () => {
  const home = "/tmp/fbA-some-other-home";
  // The MACHINE default home (`~/.<appId>`, whatever AIO_APPS_DIR says — the
  // Chromium profile is machine-wide) is untouched: nothing written moves.
  const plain = electronProfileName(
    "wallet",
    "My Wallet",
    join(homedir(), ".wallet"),
  );
  const other = electronProfileName("wallet", "My Wallet", home);
  assertEquals(plain, "my-wallet");
  // …and any other home carries THE SAME tag the lock key carries. One key
  // for both, or the two answers to "which instance is this" drift apart.
  const tag = parseLockKey(lockKey("wallet", home)).tag;
  assert(tag, "a non-default home must produce a tagged lock key");
  assertEquals(other, `my-wallet@${tag}`);
  assert(other !== plain);
});

Deno.test("electron: both shells take app.name from the profile name", () => {
  for (
    const s of [
      electronMainScript("http://localhost:3000", {
        title: "My Wallet",
        profileName: "my-wallet@deadbeef",
      }),
      electronMainScriptUDS("http://localhost:3000", "/tmp/t.sock", {
        title: "My Wallet",
        meta: { title: "My Wallet", profileName: "my-wallet@deadbeef" },
      }),
    ]
  ) {
    assertStringIncludes(s, 'app.name = "my-wallet@deadbeef"');
  }
  // No profile name (the default home): the title's slug, exactly as before.
  assertStringIncludes(
    electronMainScript("http://localhost:3000", { title: "My Wallet" }),
    'app.name = "my-wallet"',
  );
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

Deno.test("electron bounds: declared size change beats a leftover window-state.json", () => {
  const s = electronMainScript("http://127.0.0.1:1/", {
    title: "x",
    width: 420,
    height: 620,
  });
  assertStringIncludes(s, "declaredWidth");
  assertStringIncludes(s, "declaredHeight");
  assertStringIncludes(s, "d.declaredWidth === dw");
  assertStringIncludes(s, "loadBounds(420, 620)");
});

Deno.test("electron bounds: a restored position off the current display is fitted", () => {
  // A rect saved on a taller/offset desktop (e.g. y=392 under a top panel)
  // must not be restored verbatim onto a smaller nested display — it would
  // open with its bottom off-screen. Both shells must carry the fitter.
  for (
    const s of [
      electronMainScript("http://127.0.0.1:1/", { title: "x" }),
      electronMainScriptUDS("http://127.0.0.1:1/", "/tmp/x.sock", {
        title: "x",
      }),
    ]
  ) {
    assertStringIncludes(s, "__aioFitBounds");
    assertStringIncludes(s, "screen.getAllDisplays");
    assertStringIncludes(s, "workArea");
    assertStringIncludes(s, "return __aioFitBounds(out)");
  }
});

// ── maximized windows (measured on a nested display with a window manager) ──
//
// A maximized window saved `getBounds()` — the MAXIMIZED rect — as if the user
// had dragged it there: the next launch was a plain window filling the screen,
// and un-maximize had nowhere to go. Now it saves the normal rect plus
// `maximized: true`, and comes back maximized over that rect.

/** Run the generated bounds block for real, against an in-memory state file. */
function boundsHarness(
  async: boolean,
  display = { x: 0, y: 0, width: 1280, height: 900 },
) {
  const files = new Map<string, string>();
  const fsStub = {
    readFileSync: (p: string) => {
      const v = files.get(p);
      if (v === undefined) throw new Error("ENOENT");
      return v;
    },
    writeFileSync: (p: string, d: string) => void files.set(p, d),
  };
  const req = (id: string) => {
    if (id === "electron") {
      return { screen: { getAllDisplays: () => [{ workArea: display }] } };
    }
    if (id === "fs/promises") {
      return {
        writeFile: (
          p: string,
          d: string,
        ) => (files.set(p, d), Promise.resolve()),
      };
    }
    throw new Error(id);
  };
  const body = tmplBounds(async) + `
return { loadBounds, saveBounds, restoreMax: () => __aioRestoreMax };`;
  const api = new Function("app", "path", "fs", "require", body)(
    { getPath: () => "/ud" },
    { join: (...p: string[]) => p.join("/") },
    fsStub,
    req,
  ) as {
    loadBounds: (w: number, h: number) => Record<string, unknown>;
    saveBounds: (win: unknown) => void;
    restoreMax: () => boolean;
  };
  const state = "/ud/window-state.json";
  return { api, files, state };
}

const fakeWin = (max: boolean) => ({
  isMaximized: () => max,
  getBounds: () =>
    max
      ? { x: 0, y: 37, width: 1280, height: 863 }
      : { x: 300, y: 120, width: 800, height: 600 },
  getNormalBounds: () => ({ x: 300, y: 120, width: 800, height: 600 }),
});

Deno.test("electron bounds: a maximized window saves its NORMAL rect and comes back maximized", async () => {
  for (const async of [false, true]) {
    const { api, files, state } = boundsHarness(async);
    api.loadBounds(800, 600);
    api.saveBounds(fakeWin(true));
    await Promise.resolve();
    assertEquals(JSON.parse(files.get(state)!), {
      x: 300,
      y: 120,
      width: 800,
      height: 600,
      declaredWidth: 800,
      declaredHeight: 600,
      maximized: true,
    });
    assertEquals(api.loadBounds(800, 600), {
      x: 300,
      y: 120,
      width: 800,
      height: 600,
    });
    assertEquals(api.restoreMax(), true, `async=${async}`);
    // Un-maximized again: the key is gone, the file is exactly the old shape.
    api.saveBounds(fakeWin(false));
    await Promise.resolve();
    assertEquals(JSON.parse(files.get(state)!), {
      x: 300,
      y: 120,
      width: 800,
      height: 600,
      declaredWidth: 800,
      declaredHeight: 600,
    });
    api.loadBounds(800, 600);
    assertEquals(api.restoreMax(), false);
  }
});

Deno.test("electron bounds: the maximized flag survives a fitted rect and a changed declaration; old files load unchanged", () => {
  const { api, files, state } = boundsHarness(false);
  files.set(
    state,
    JSON.stringify({
      x: 100,
      y: 2000,
      width: 800,
      height: 600,
      declaredWidth: 800,
      declaredHeight: 600,
      maximized: true,
    }),
  );
  assertEquals(api.loadBounds(800, 600), {
    x: 100,
    y: 300,
    width: 800,
    height: 600,
  });
  assertEquals(api.restoreMax(), true);
  assertEquals(api.loadBounds(640, 480), {
    x: 100,
    y: 420,
    width: 640,
    height: 480,
  });
  assertEquals(api.restoreMax(), true);
  // A pre-maximize-key file: exactly what it loaded to before.
  files.set(
    state,
    JSON.stringify({
      x: 0,
      y: 37,
      width: 1280,
      height: 863,
      declaredWidth: 800,
      declaredHeight: 600,
    }),
  );
  assertEquals(api.loadBounds(800, 600), {
    x: 0,
    y: 37,
    width: 1280,
    height: 863,
  });
  assertEquals(api.restoreMax(), false);
  // No position saved: no position keys invented.
  files.set(
    state,
    JSON.stringify({
      width: 900,
      height: 700,
      declaredWidth: 800,
      declaredHeight: 600,
    }),
  );
  assertEquals(api.loadBounds(800, 600), { width: 900, height: 700 });
});

Deno.test("electron bounds: both shells re-maximize right after creating the window", () => {
  for (
    const s of [
      electronMainScript("http://127.0.0.1:1/", { title: "x" }),
      electronMainScriptUDS("http://127.0.0.1:1/", "/tmp/x.sock", {
        title: "x",
      }),
    ]
  ) {
    assertStringIncludes(s, "win.getNormalBounds()");
    assertStringIncludes(s, "out.maximized = true");
    const created = s.indexOf("const win = new BrowserWindow(b);");
    const remax = s.indexOf(
      "if (__aioRestoreMax) {\n    try { win.maximize(); }",
    );
    const tracked = s.indexOf("win.on('resize', save);");
    assertEquals(created > 0 && remax > created && tracked > remax, true);
    new Function(s); // still parses
  }
});
