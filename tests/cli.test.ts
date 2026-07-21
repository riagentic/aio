import { assertEquals } from "@std/assert";
import { parseCli, VERSION } from "../src/server/aio.ts";
import {
  electronClientScript,
  electronMainScript,
  electronMainScriptUDS,
} from "../src/electron/electron.ts";

Deno.test("parseCli: defaults — empty args", () => {
  const r = parseCli([]);
  assertEquals(r.verbose, false);
  assertEquals(r.port, undefined);
  assertEquals(r.persist, undefined);
  assertEquals(r.client, undefined);
});

Deno.test("parseCli: --port=3000", () => {
  const r = parseCli(["--port=3000"]);
  assertEquals(r.port, 3000);
});

Deno.test("parseCli: --port with invalid value ignored", () => {
  const r = parseCli(["--port=abc"]);
  assertEquals(r.port, undefined);
});

Deno.test("parseCli: --port=0 and --port=70000 ignored", () => {
  assertEquals(parseCli(["--port=0"]).port, undefined);
  assertEquals(parseCli(["--port=70000"]).port, undefined);
});

Deno.test("parseCli: boolean flags", () => {
  const r = parseCli([
    "--no-persist",
    "--client=browser",
    "--keep-server",
    "--verbose",
    "--prod",
  ]);
  assertEquals(r.persist, false);
  assertEquals(r.client, "browser");
  assertEquals(r.keepServer, true);
  assertEquals(r.verbose, true);
  assertEquals(r.prod, true);
});

Deno.test("parseCli: --title=MyApp", () => {
  const r = parseCli(["--title=MyApp"]);
  assertEquals(r.title, "MyApp");
});

Deno.test("parseCli: unknown flag does not crash", () => {
  const r = parseCli(["--unknown-flag"]);
  assertEquals(r.verbose, false); // still parses fine
});

Deno.test("parseCli: mixed known and unknown flags", () => {
  const r = parseCli(["--verbose", "--foo", "--port=9000"]);
  assertEquals(r.verbose, true);
  assertEquals(r.port, 9000);
});

Deno.test("parseCli: --version sets version flag", () => {
  const r = parseCli(["--version"]);
  assertEquals(r.version, true);
});

Deno.test("parseCli: --version alongside other flags", () => {
  const r = parseCli(["--verbose", "--version", "--port=3000"]);
  assertEquals(r.version, true);
  assertEquals(r.verbose, true);
  assertEquals(r.port, 3000);
});

Deno.test("parseCli: --expose sets expose flag", () => {
  const r = parseCli(["--expose"]);
  assertEquals(r.expose, true);
});

Deno.test("parseCli: --expose alongside other flags", () => {
  const r = parseCli(["--verbose", "--expose", "--port=3000"]);
  assertEquals(r.expose, true);
  assertEquals(r.verbose, true);
  assertEquals(r.port, 3000);
});

Deno.test("parseCli: --help sets help flag", () => {
  const r = parseCli(["--help"]);
  assertEquals(r.help, true);
});

Deno.test("parseCli: --help alongside other flags", () => {
  const r = parseCli(["--help", "--verbose", "--port=3000"]);
  assertEquals(r.help, true);
  assertEquals(r.verbose, true);
  assertEquals(r.port, 3000);
});

Deno.test("parseCli: --server-url sets serverUrl", () => {
  const r = parseCli(["--server-url=http://192.168.1.100:8000"]);
  assertEquals(r.serverUrl, "http://192.168.1.100:8000");
});

Deno.test("parseCli: --server-url alongside other flags", () => {
  const r = parseCli([
    "--server-url=http://10.0.0.5:3000?token=abc",
    "--title=Remote",
  ]);
  assertEquals(r.serverUrl, "http://10.0.0.5:3000?token=abc");
  assertEquals(r.title, "Remote");
});

Deno.test("parseCli: bare --server-url sets empty string", () => {
  const r = parseCli(["--server-url"]);
  assertEquals(r.serverUrl, "");
});

Deno.test("parseCli: --server-url-like flag is unknown, not swallowed by --server-url prefix", () => {
  const r = parseCli(["--server-url-transform=foo"]);
  assertEquals(r.serverUrl, undefined);
});

Deno.test("parseCli: --client=server-only flag", () => {
  const r = parseCli(["--client=server-only"]);
  assertEquals(r.client, "server-only");
});

Deno.test("parseCli: --width and --height", () => {
  const r = parseCli(["--width=1024", "--height=768"]);
  assertEquals(r.width, 1024);
  assertEquals(r.height, 768);
});

Deno.test("parseCli: --width and --height ignore invalid values", () => {
  assertEquals(parseCli(["--width=abc"]).width, undefined);
  assertEquals(parseCli(["--height=-1"]).height, undefined);
});

Deno.test("electronMainScript: uses full URL", () => {
  const script = electronMainScript("http://192.168.1.100:8000?token=abc");
  assertEquals(script.includes("http://192.168.1.100:8000?token=abc"), true);
  assertEquals(script.includes("BrowserWindow"), true);
});

Deno.test("electronMainScript: accepts AioMeta", () => {
  const script = electronMainScript("http://localhost:3000", {
    width: 1024,
    height: 768,
  });
  assertEquals(script.includes("loadBounds(1024, 768)"), true);
});

Deno.test("electronMainScript: defaults when no meta", () => {
  const script = electronMainScript("http://localhost:3000");
  assertEquals(script.includes("loadBounds(800, 600)"), true);
});

Deno.test("electronMainScript: persists window bounds", () => {
  const script = electronMainScript("http://localhost:3000");
  assertEquals(script.includes("window-state.json"), true);
  assertEquals(script.includes("saveBounds"), true);
});

Deno.test("electronMainScript: sets app.name from title for stable userData", () => {
  const script = electronMainScript("http://localhost:3000", {
    title: "My Dashboard",
  });
  assertEquals(script.includes('app.name = "my-dashboard"'), true);
});

Deno.test("electronMainScript: app.name defaults to aio-app without title", () => {
  const script = electronMainScript("http://localhost:3000");
  assertEquals(script.includes('app.name = "aio-app"'), true);
});

Deno.test("electronClientScript: sets app.name to aio-client", () => {
  const script = electronClientScript();
  assertEquals(script.includes("app.name = 'aio-client'"), true);
});

Deno.test("electronClientScript: contains connect page HTML", () => {
  const script = electronClientScript();
  assertEquals(script.includes("CONNECT_HTML"), true);
  assertEquals(script.includes("<h1>aio</h1>"), true);
  assertEquals(script.includes('placeholder="192.168'), true);
});

Deno.test("electronClientScript: contains parseMeta function", () => {
  const script = electronClientScript();
  assertEquals(script.includes("function parseMeta"), true);
  assertEquals(script.includes("aio:width"), true);
  assertEquals(script.includes("aio:height"), true);
});

Deno.test("electronClientScript: contains connectTo function", () => {
  const script = electronClientScript();
  assertEquals(script.includes("async function connectTo"), true);
  assertEquals(script.includes("setSize"), true);
  assertEquals(script.includes("setTitle"), true);
  assertEquals(script.includes("/icon.png"), true);
});

Deno.test("electronClientScript: handles --server-url= from argv", () => {
  const script = electronClientScript();
  assertEquals(script.includes("--server-url="), true);
  assertEquals(script.includes("process.argv"), true);
});

Deno.test("VERSION is a semver string", () => {
  assertEquals(typeof VERSION, "string");
  assertEquals(/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(VERSION), true);
});

// ── electronMainScript: edge cases ──────────────────────────────

Deno.test("electronMainScript: special char title slugified", () => {
  const script = electronMainScript("http://localhost:3000", {
    title: "My App! @v2",
  });
  assertEquals(script.includes('app.name = "my-app-v2"'), true);
});

Deno.test("electronMainScript: empty title defaults to aio-app", () => {
  const script = electronMainScript("http://localhost:3000", { title: "" });
  assertEquals(script.includes('app.name = "aio-app"'), true);
});

Deno.test("electronMainScript: keyboard shortcuts Ctrl+F5 and F12 present", () => {
  const script = electronMainScript("http://localhost:3000");
  // Reload is Ctrl+F5 — plain F5 stays free for app-level custom shortcuts.
  assertEquals(script.includes("(ctrl && input.key === 'F5')"), true);
  assertEquals(script.includes("input.key === 'F12'"), true);
  assertEquals(script.includes("reloadIgnoringCache"), true);
  assertEquals(script.includes("toggleDevTools"), true);
});

Deno.test("electronMainScript: nodeIntegration disabled, contextIsolation true", () => {
  const script = electronMainScript("http://localhost:3000");
  assertEquals(script.includes("nodeIntegration: false"), true);
  assertEquals(script.includes("contextIsolation: true"), true);
});

Deno.test("electronMainScript: Menu.setApplicationMenu(null) present", () => {
  const script = electronMainScript("http://localhost:3000");
  assertEquals(script.includes("Menu.setApplicationMenu(null)"), true);
});

Deno.test("electronMainScript: certificate-error handler accepts localhost self-signed certs", () => {
  const script = electronMainScript("https://localhost:8000");
  assertEquals(script.includes("certificate-error"), true);
  assertEquals(script.includes("localhost"), true);
  assertEquals(script.includes("127.0.0.1"), true);
  // Remote hosts must NOT be auto-trusted
  assertEquals(script.includes("cb(false)"), true);
});

// ── electronClientScript: edge cases ──────────────────────────────

Deno.test("electronClientScript: redirect limit handling", () => {
  const script = electronClientScript();
  assertEquals(script.includes("maxRedirects"), true);
  assertEquals(script.includes("Too many redirects"), true);
  assertEquals(script.includes("non-HTTP scheme"), true);
});

Deno.test("electronClientScript: nodeIntegration disabled", () => {
  const script = electronClientScript();
  assertEquals(script.includes("nodeIntegration: false"), true);
  assertEquals(script.includes("contextIsolation: true"), true);
});

// ── --isolate flag ──────────────────────────────────────────────

Deno.test("parseCli: --isolate=counter,dc", () => {
  const r = parseCli(["--isolate=counter,dc"]);
  assertEquals(r.isolate, ["counter", "dc"]);
});

Deno.test("parseCli: --isolate=single", () => {
  const r = parseCli(["--isolate=counter"]);
  assertEquals(r.isolate, ["counter"]);
});

Deno.test("parseCli: no --isolate returns undefined", () => {
  const r = parseCli([]);
  assertEquals(r.isolate, undefined);
});

// ── --transport flag ──────────────────────────────────────────────

Deno.test("parseCli: --transport=uds", () => {
  const r = parseCli(["--transport=uds"]);
  assertEquals(r.transport, "uds");
});

Deno.test("parseCli: --transport=ws", () => {
  const r = parseCli(["--transport=ws"]);
  assertEquals(r.transport, "ws");
});

Deno.test("parseCli: --transport=invalid ignored", () => {
  const r = parseCli(["--transport=tcp"]);
  assertEquals(r.transport, undefined);
});

Deno.test("parseCli: no --transport returns undefined", () => {
  const r = parseCli([]);
  assertEquals(r.transport, undefined);
});

// ── --client flag ──────────────────────────────────────────────

Deno.test("parseCli: --client=browser", () => {
  const r = parseCli(["--client=browser"]);
  assertEquals(r.client, "browser");
});

Deno.test("parseCli: --client=server-only", () => {
  const r = parseCli(["--client=server-only"]);
  assertEquals(r.client, "server-only");
});

Deno.test("parseCli: --client=cli", () => {
  const r = parseCli(["--client=cli"]);
  assertEquals(r.client, "cli");
});

Deno.test("parseCli: --client with invalid value ignored", () => {
  const r = parseCli(["--client=invalid"]);
  assertEquals(r.client, undefined);
});

Deno.test("parseCli: --kill-existing", () => {
  const r = parseCli(["--kill-existing"]);
  assertEquals(r.killExisting, true);
});

// ── electronMainScriptUDS ──────────────────────────────────────────

Deno.test("electronMainScriptUDS: contains socket path and IPC bridge", () => {
  const script = electronMainScriptUDS(
    "http://localhost:8000",
    "/tmp/aio-test.sock",
    {},
  );
  assertEquals(script.includes("/tmp/aio-test.sock"), true);
  assertEquals(script.includes("require('net')"), true);
  assertEquals(script.includes("__aioIPC"), true);
  assertEquals(script.includes("contextBridge"), true);
});

Deno.test("electronMainScriptUDS: dev mode loads page from HTTP URL", () => {
  const script = electronMainScriptUDS(
    "http://localhost:8000",
    "/tmp/aio-test.sock",
    {},
  );
  assertEquals(script.includes("http://localhost:8000"), true);
  assertEquals(script.includes("loadURL"), true);
});

Deno.test("electronMainScriptUDS: prod mode uses aio:// protocol", () => {
  const script = electronMainScriptUDS(
    "http://localhost:8000",
    "/tmp/aio-test.sock",
    { baseDir: "/app/dist" },
  );
  assertEquals(script.includes("protocol.handle('aio'"), true);
  assertEquals(script.includes("USE_PROTOCOL"), true);
  assertEquals(script.includes("aio:///"), true);
  assertEquals(script.includes("/app/dist"), true);
});

Deno.test("electronMainScriptUDS: prod HTML includes CSS when hasCSS", () => {
  const script = electronMainScriptUDS(
    "http://localhost:8000",
    "/tmp/aio-test.sock",
    { baseDir: "/app/dist", hasCSS: true },
  );
  assertEquals(script.includes("style.css"), true);
});

Deno.test("electronMainScriptUDS: respects meta dimensions", () => {
  const script = electronMainScriptUDS(
    "http://localhost:9000",
    "/tmp/aio-test.sock",
    { meta: { width: 1200, height: 900 } },
  );
  assertEquals(script.includes("1200"), true);
  assertEquals(script.includes("900"), true);
});

Deno.test("electronMainScriptUDS: default dimensions without meta", () => {
  const script = electronMainScriptUDS(
    "http://localhost:8000",
    "/tmp/test.sock",
    {},
  );
  assertEquals(script.includes("800"), true);
  assertEquals(script.includes("600"), true);
});

Deno.test("electronMainScriptUDS: sets app.name from title", () => {
  const script = electronMainScriptUDS(
    "http://localhost:8000",
    "/tmp/test.sock",
    { title: "My Dashboard" },
  );
  assertEquals(script.includes('app.name = "my-dashboard"'), true);
});

Deno.test("electronMainScriptUDS: default app.name without title", () => {
  const script = electronMainScriptUDS(
    "http://localhost:8000",
    "/tmp/test.sock",
    {},
  );
  assertEquals(script.includes('app.name = "aio-app"'), true);
});

Deno.test("electronMainScriptUDS: contains IPC bridge setup", () => {
  const script = electronMainScriptUDS(
    "http://localhost:8000",
    "/tmp/test.sock",
    {},
  );
  assertEquals(script.includes("ipcMain.on"), true);
  assertEquals(script.includes("__aio:send"), true);
  assertEquals(script.includes("__aio:msg"), true);
  assertEquals(script.includes("__aio:open"), true);
  assertEquals(script.includes("__aio:close"), true);
});

Deno.test("electronMainScriptUDS: contains reconnect logic", () => {
  const script = electronMainScriptUDS(
    "http://localhost:8000",
    "/tmp/test.sock",
    {},
  );
  assertEquals(script.includes("reconnectTimer"), true);
  assertEquals(script.includes("connectUDS"), true);
});

Deno.test("electronMainScriptUDS: contains window state persistence", () => {
  const script = electronMainScriptUDS(
    "http://localhost:8000",
    "/tmp/test.sock",
    {},
  );
  assertEquals(script.includes("window-state.json"), true);
  assertEquals(script.includes("saveBounds"), true);
  assertEquals(script.includes("loadBounds"), true);
});

Deno.test("electronMainScriptUDS: contains keyboard shortcuts", () => {
  const script = electronMainScriptUDS(
    "http://localhost:8000",
    "/tmp/test.sock",
    {},
  );
  // Ctrl+F5 reload (plain F5 left to the app), F12 devtools.
  assertEquals(script.includes("(ctrl && input.key === 'F5')"), true);
  assertEquals(script.includes("input.key === 'F12'"), true);
});

Deno.test("electronMainScriptUDS: contains icon loading logic", () => {
  const script = electronMainScriptUDS(
    "http://localhost:8000",
    "/tmp/test.sock",
    {},
  );
  assertEquals(script.includes("icon.png"), true);
  assertEquals(script.includes("nativeImage"), true);
});

Deno.test("electronMainScriptUDS: closing flag prevents IPC after close", () => {
  const script = electronMainScriptUDS(
    "http://localhost:8000",
    "/tmp/test.sock",
    {},
  );
  assertEquals(script.includes("closing"), true);
  assertEquals(script.includes("win.on('close'"), true);
});

Deno.test("electronMainScriptUDS: pageReady flag with did-finish-load", () => {
  const script = electronMainScriptUDS(
    "http://localhost:8000",
    "/tmp/test.sock",
    {},
  );
  assertEquals(script.includes("pageReady"), true);
  assertEquals(script.includes("did-finish-load"), true);
  assertEquals(script.includes("lastState"), true);
});

Deno.test("electronMainScript: title with special chars", () => {
  const script = electronMainScript("http://localhost:3000", {
    title: "App's & <Title>",
  });
  assertEquals(script.includes("BrowserWindow"), true);
});

Deno.test("electronClientScript: has maxRedirects safety", () => {
  const script = electronClientScript();
  assertEquals(script.includes("maxRedirects"), true);
});
