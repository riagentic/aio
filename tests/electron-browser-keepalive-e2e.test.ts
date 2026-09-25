// `<Browser keepAlive>` in REAL Electron.
//
// `tests/ui-browser.test.ts` pins the renderer side against happy-dom, where a
// `<webview>` is an inert element; only Electron can say what a guest does.
// Measured on Electron 44: a `<webview>` MOVED in the document loses its guest
// (`append` → destroyed and never re-created; `moveBefore` → a fresh guest),
// so `keepAlive`'s old park-and-restore (move into a display:none holder, move
// back) put a DEAD element on the page: a blank box after the first remount.
// It now keeps the page the guest was on. Opt-in like every real-window test
// (ELECTRON_E2E=1), and ONLY on the nested test display.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import * as esbuild from "esbuild";
import { stopEsbuildService } from "../src/build/esbuild-shared.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = new URL("../", import.meta.url).pathname;
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

// The host app: the real AIR renderer, the real `<Browser>`, two signals.
const entry = (src: string) => `
import { mount, signal } from "${REPO}src/air/aio-renderer.ts";
import { h } from "${REPO}src/air/vdom.ts";
import { Browser } from "${REPO}src/ui/browser.ts";
const show = signal(true);
const cls = signal("a");
const guest = ${JSON.stringify(src)};
mount(document.getElementById("app"), () =>
  h("div", { id: "host" },
    show.value
      ? h(Browser, { src: guest, keepAlive: "reader", class: cls.value,
          style: { width: "300px", height: "200px", display: "inline-flex" } })
      : null));
globalThis.__t = { show, cls };
`;

Deno.test({
  name:
    "browser keepAlive e2e: a remount shows a LIVE guest on the page the last one browsed to",
  ignore: e2eSkip() !== null,
  sanitizeResources: false, // aio-ok: a real Electron child owns the sockets and timers; teardown stops it
  sanitizeOps: false, // aio-ok: a real Electron child owns the sockets and timers; teardown stops it
  async fn() {
    const dir = await tempDir("aio-keepalive-e2e-");
    const port = freePort();
    const server = Deno.serve(
      { port, hostname: "127.0.0.1", onListen() {} },
      (req) =>
        new Response(
          `<p id=p>${new URL(req.url).pathname}</p>`,
          { headers: { "content-type": "text/html" } },
        ),
    );
    try {
      const origin = `http://127.0.0.1:${port}`;
      await Deno.writeTextFile(join(dir, "entry.ts"), entry(`${origin}/`));
      const out = await esbuild.build({
        entryPoints: [join(dir, "entry.ts")],
        bundle: true,
        format: "iife",
        platform: "browser",
        write: false,
        logLevel: "silent",
      });
      await Deno.writeTextFile(
        join(dir, "host.html"),
        `<!doctype html><div id="app"></div><script>${
          out.outputFiles[0]!.text
        }</script>`,
      );
      const main = `
const { app, BrowserWindow, webContents } = require('electron');
const out = (o) => { console.log('RESULT ' + JSON.stringify(o)); app.exit(0); };
setTimeout(() => out({ error: 'timeout' }), 30000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f) => { for (let i = 0; i < 100 && !f(); i++) await wait(50); };
const live = () => webContents.getAllWebContents().filter((w) => w.getType() === 'webview' && !w.isDestroyed());
let loads = 0;
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 500, height: 400, show: false,
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false } });
  const host = (js) => win.webContents.executeJavaScript(js);
  win.webContents.on('did-attach-webview', (_e, g) => g.on('did-finish-load', () => loads++));
  win.webContents.on('did-finish-load', () => run().catch((e) => out({ error: String(e) })));
  async function run() {
    await until(() => loads === 1);
    // The user browses on, in the guest, with no onNavigate in the app.
    await live()[0].executeJavaScript("document.cookie = 'k=1; max-age=3600'; location.href = '/page2'");
    await until(() => loads === 2);
    await host("__t.show.set(false)");
    await wait(400);
    const gone = [await host("document.querySelectorAll('webview').length"), live().length];
    await host("__t.cls.set('b'); __t.show.set(true)");
    await until(() => loads === 3);
    await wait(200);
    const g = live()[0];
    const dom = await host("(() => { const w = [...document.querySelectorAll('webview')]; return { n: w.length, parent: w[0] && w[0].parentElement.id, cls: w[0] && w[0].getAttribute('class'), width: w[0] && w[0].getBoundingClientRect().width }; })()");
    const page = g ? await g.executeJavaScript("[document.getElementById('p').textContent, document.cookie]") : null;
    out({ gone, dom, page, live: live().length, loads });
  }
  win.loadFile(${JSON.stringify(join(dir, "host.html"))});
});`;
      const file = join(dir, "main.cjs");
      await Deno.writeTextFile(file, main);
      const { stdout, stderr } = await new Deno.Command(ELECTRON_BIN, {
        args: [file, "--no-sandbox"],
        env: { ...testDisplayEnv(), ELECTRON_ENABLE_LOGGING: "0" },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const line = new TextDecoder().decode(stdout).split("\n").find((l) =>
        l.startsWith("RESULT ")
      );
      assert(
        line,
        "no result: " + new TextDecoder().decode(stderr).slice(-2000),
      );
      const r = JSON.parse(line.slice(7));
      assertEquals(r.error, undefined);
      assertEquals(r.gone, [0, 0], "unmounted: no element, no guest left over");
      assertEquals(r.dom, { n: 1, parent: "host", cls: "b", width: 300 });
      assertEquals(r.live, 1, "a LIVE guest — the old restore left none");
      assertEquals(
        r.page,
        ["/page2", "k=1"],
        "the page it was on; the session kept",
      );
      assertEquals(r.loads, 3);
    } finally {
      await server.shutdown();
      await stopEsbuildService(() => esbuild.stop());
      await dropTempDir(dir);
    }
  },
});
