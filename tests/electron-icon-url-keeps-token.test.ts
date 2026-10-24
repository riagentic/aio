// aio-client (electron-client-script.ts) `connectTo`:
//   iconUrl = url.replace(/\/$/, '') + '/icon.png'
// A token-bearing URL — the shape a paired profile and every share link has
// (`http://host:port/?token=K`) — yields `http://host:port/?token=K/icon.png`:
// the fetch hits `/` with a CORRUPTED token (`K/icon.png`), so an app that
// needs a token never gets its window icon (and the server sees an auth
// failure per connect). The icon URL must keep the path and the query apart.
//
// The functions are pulled out of the GENERATED script and run with stubs —
// the script itself only runs inside Electron.
import { assertEquals } from "@std/assert";
import { electronClientScript } from "../src/electron/electron-client-script.ts";

function extractFn(src: string, header: string): string {
  const start = src.indexOf(header);
  if (start < 0) throw new Error(`not found: ${header}`);
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end + 2);
}

Deno.test("aio-client: the window-icon fetch of a ?token= URL keeps the token intact and asks for the icon route", async () => {
  const src = electronClientScript(null);
  const connectToSrc = extractFn(
    src,
    "async function connectTo(win, url, withheld) {",
  ) +
    extractFn(src, "function looksLikeAio(html) {") +
    extractFn(src, "function parseMeta(html) {");
  const fetched: string[] = [];
  const errs: string[] = [];
  const make = new Function(
    "fetchPage",
    "fetchBuffer",
    "loadRecents",
    "saveRecent",
    "nativeImage",
    "loadBounds",
    "trackBounds",
    "_trustedHosts",
    "__aioIpcBind", // the app-window bind (electron-web-isolation.test.ts)
    "__aioOrigin",
    "learnProof", // the pin proof, after a connect (pin-proof.test.ts)
    "seenChanged", // a host's first-seen certificate (generated-eval test)
    "_seenCerts",
    `${connectToSrc}\nreturn connectTo;`,
  );
  const connectTo = make(
    () => Promise.resolve('<html><div id="root"></div></html>'),
    (u: string) => {
      fetched.push(u);
      return Promise.resolve(null);
    },
    () => [],
    () => [],
    { createFromBuffer: () => ({}) },
    () => ({ width: 800, height: 600 }),
    () => {},
    new Set(),
    () => {},
    (u: string) => new URL(u).origin,
    () => {},
    () => false,
    new Map(),
  ) as (win: unknown, url: string) => Promise<void>;
  const win = {
    setIcon() {},
    setResizable() {},
    setSize() {},
    setPosition() {},
    center() {},
    setTitle() {},
    loadURL() {},
    webContents: {
      executeJavaScript: (js: string) => {
        errs.push(js);
        return Promise.resolve();
      },
    },
  };
  // Exactly the URL profileToRecent() builds for a paired app.
  await connectTo(win, "http://192.168.1.5:8000/?token=SECRETKEY");
  assertEquals(errs, [], "connectTo reported an error");
  assertEquals(fetched.length, 1);
  const icon = new URL(fetched[0]!);
  assertEquals(icon.pathname, "/__aio/icon", `icon fetched from ${fetched[0]}`);
  assertEquals(icon.searchParams.get("token"), "SECRETKEY");
});

// Same shape in the dev/standalone window's TRAY icon (electron-scripts.ts):
// the lifecycle launches it with `${localUrl}?token=${token}` under --expose.
Deno.test("electron main script: the tray-icon fetch of a ?token= URL is not '<url>?token=K/icon.png'", async () => {
  const { electronMainScript } = await import(
    "../src/electron/electron-scripts.ts"
  );
  const src = electronMainScript("http://127.0.0.1:8123?token=SECRETKEY", {
    title: "t",
  } as never);
  const m = /net\.fetch\(("[^"]*")\)/.exec(src);
  assertEquals(m !== null, true, "tray-icon fetch not found in the script");
  const icon = new URL(JSON.parse(m![1]!));
  assertEquals(icon.pathname, "/__aio/icon", `tray icon fetched from ${icon}`);
  assertEquals(icon.searchParams.get("token"), "SECRETKEY");
});

// The dev/standalone window (WebSocket shell) shows the app's icon in the
// taskbar too, not only the tray: the fetched icon is set on the window.
Deno.test("electron main script: the window gets the app's icon, not Electron's default", async () => {
  const { electronMainScript } = await import(
    "../src/electron/electron-scripts.ts"
  );
  const src = electronMainScript("http://127.0.0.1:8123", {
    title: "t",
  } as never);
  // From the icon-size cap (tmplIconFit) the shell emits just before it.
  const start = src.indexOf("const __aioIconFit = ");
  const tail = "(e && e.message) || String(e)));";
  const end = src.indexOf(tail, start) + tail.length;
  assertEquals(start > 0 && end > start, true, "window icon code not found");
  const got: unknown[] = [];
  const img = {
    isEmpty: () => false,
    getSize: () => ({ width: 32, height: 32 }),
  };
  const run = new Function(
    "require",
    "win",
    src.slice(start, end) + "\nreturn __aioIcon;",
  );
  await run(
    () => ({
      net: { fetch: () => Promise.resolve(new Response(new Uint8Array([1]))) },
      nativeImage: { createFromBuffer: () => img },
    }),
    { setIcon: (i: unknown) => got.push(i), isDestroyed: () => false },
  );
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(got, [img]);
});

// A field report: nothing said "this window has no icon" — the
// default gear showed and the cause was found by reading the main script.
Deno.test("electron main scripts: a window left with Electron's default icon says why", async () => {
  const { electronMainScript } = await import(
    "../src/electron/electron-scripts.ts"
  );
  const { electronMainScriptUDS } = await import(
    "../src/electron/electron-uds.ts"
  );
  const warned: string[] = [];
  const con = { warn: (m: string) => warned.push(m), error: () => {} };
  // WebSocket shell: the icon route answers 404.
  const ws = electronMainScript("http://127.0.0.1:8123", { title: "t" });
  const tail = "(e && e.message) || String(e)));";
  const a = ws.indexOf("const __aioIcon = ");
  const b = ws.indexOf(tail, a) + tail.length;
  await new Function(
    "require",
    "win",
    "console",
    ws.slice(a, b) + "\nreturn __aioIcon.catch(() => {});",
  )(
    () => ({
      net: { fetch: () => Promise.resolve(new Response("", { status: 404 })) },
      nativeImage: {},
    }),
    { setIcon: () => {}, isDestroyed: () => false },
    con,
  );
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(warned, [
    "⚠ this window has no icon of its own — Electron's default shows: GET /__aio/icon answered HTTP 404",
  ]);
  // UDS shell: no icon.png and no default icon passed.
  warned.length = 0;
  const uds = electronMainScriptUDS("http://127.0.0.1:8123", "/s.sock", {
    title: "t",
    iconDir: "/app",
  });
  const c = uds.indexOf("  let __aioIcon = null;");
  const d = uds.indexOf("\n  }\n", uds.indexOf("Electron's default shows", c)) +
    4;
  new Function(
    "require",
    "win",
    "console",
    "fs",
    "path",
    "process",
    "BASE_DIR",
    uds.slice(c, d),
  )(
    () => ({ nativeImage: {} }),
    { setIcon: () => {} },
    con,
    { existsSync: () => false },
    { join: (...p: string[]) => p.join("/") },
    { env: {}, cwd: () => "/" },
    "",
  );
  assertEquals(warned, [
    "⚠ this window has no icon of its own — Electron's default shows: no /app/icon.png and no default icon was passed",
  ]);
});
