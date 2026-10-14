// REAL Electron: `--server-url` at a server that is down.
//
// A launch that goes straight to an address has no connect page: the window
// is opened and the app's page is fetched. With nothing listening there the
// window stays BLANK — on purpose: an unattended kiosk window is not handed
// an address box it never had, and what it shows must not change under it.
//
// What the launch did wrong was the telling. The reason was written into the
// page's `err` element — an element of the connect page, which this window
// never loaded. Measured here (Electron 44): a script for a window that has
// loaded NOTHING neither runs nor fails, its promise stays pending — so there
// was no line at all, on the page or in the log. (On a loaded page without
// that element the same call rejected, unhandled.)
//
// In a real Electron because the stub the unit tests boot against resolves
// every `executeJavaScript` (tests/electron-client-generated-eval).
//
// Gate: ELECTRON_E2E=1 (deno task test:electron), Linux, the nested test
// display — no window lands on the desktop.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import { electronClientScript } from "../src/electron/electron.ts";
import { realElectronBin } from "../src/electron/electron-spawn.ts";
import { freePort } from "../src/testing/server-test.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { accountEnv } from "./e2e-app-harness.ts";

const ELECTRON_BIN = "node_modules/.bin/electron";

function shouldSkip(): string | null {
  if (Deno.build.os !== "linux") return "linux (nested X display)";
  try {
    Deno.statSync(ELECTRON_BIN);
  } catch {
    return "Electron not installed — run: deno task install:electron";
  }
  if (!Deno.env.get("DISPLAY") && !Deno.env.get("WAYLAND_DISPLAY")) {
    return "no display (set DISPLAY or WAYLAND_DISPLAY)";
  }
  if (!Deno.env.get("ELECTRON_E2E")) {
    return "E2E disabled — set ELECTRON_E2E=1 to run";
  }
  return null;
}

Deno.test({
  name:
    "aio-client (real): --server-url at a server that is down says the address and the cause, rejects nothing unhandled, and leaves the window blank",
  ignore: shouldSkip() !== null,
  // aio-ok: a real Electron binary driven over CDP; its sockets outlive the test body
  sanitizeOps: false,
  sanitizeResources: false, // aio-ok: see above
  async fn() {
    const dir = await tempDir("el-down-");
    const main = join(dir, "main.cjs");
    await Deno.writeTextFile(main, electronClientScript(null));
    const dead = freePort(); // nothing listens here
    const cdp = freePort();
    const env: Record<string, string> = {
      ...Deno.env.toObject(),
      ...testDisplayEnv(),
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(dir, "no-bus")}`,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      ...accountEnv(join(dir, "config")),
      HOME: join(dir, "home"),
      AIO_DISCOVERY_PORT: String(freePort()),
    };
    delete env.WAYLAND_DISPLAY;
    const proc = new Deno.Command(await realElectronBin(ELECTRON_BIN), {
      args: [
        main,
        `--remote-debugging-port=${cdp}`,
        "--no-sandbox",
        "--disable-gpu",
        `--server-url=http://127.0.0.1:${dead}/?token=sekrit`,
      ],
      env,
      stdin: "null",
      stdout: "null",
      stderr: "piped",
    }).spawn();
    let err = "";
    const dec = new TextDecoder();
    const pump = (async () => {
      for await (const c of proc.stderr) err += dec.decode(c);
    })().catch(() => {});
    let exited = false;
    const status = proc.status.then((s) => {
      exited = true;
      return s;
    });
    const until = async (
      pred: () => boolean | Promise<boolean>,
      what: string,
    ) => {
      const end = Date.now() + 30_000;
      while (!(await pred())) {
        if (exited || Date.now() > end) throw new Error(`${what}:\n${err}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    let pages: { type: string; url: string }[] = [];
    try {
      await until(
        () => /\[aio-client\] cannot open /.test(err),
        "the failed connect was not said",
      );
      await until(async () => {
        try {
          pages = (await (await fetch(`http://127.0.0.1:${cdp}/json`)).json())
            .filter((t: { type: string }) => t.type === "page");
          return pages.length > 0;
        } catch {
          return false; // aio-ok: the debugger port is not up yet
        }
      }, "the window never appeared");
      // An ordinary stop: everything the main process had to say is said
      // by the time it has exited.
      proc.kill("SIGTERM");
      await status;
    } finally {
      try {
        proc.kill("SIGKILL");
      } catch { /* aio-ok: already gone — the passing case */ }
      await status;
      await pump;
      await dropTempDir(dir);
    }
    assert(
      !/unhandled promise rejection/.test(err),
      `a rejection nobody handled:\n${err}`,
    );
    const line = err.split("\n").find((l) => l.includes("cannot open"))!;
    assertMatch(line, new RegExp(`http://127\\.0\\.0\\.1:${dead}/`));
    assertMatch(line, /ECONNREFUSED|refused/i);
    assert(!line.includes("sekrit"), `the token is in the log: ${line}`);
    // The kiosk's window is what it was: one page that loaded nothing (its
    // URL is empty — not even about:blank), no connect page.
    assertEquals(pages.map((p) => p.url), [""]);
  },
});
