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
  const connectToSrc = extractFn(src, "async function connectTo(win, url) {") +
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
