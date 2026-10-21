// The splash Electron's main process draws itself (Windows, Electron already
// present): its page lays out the spec as the helpers do, it is made BEFORE
// the app's window, the app's window never waits for it, it stays minMs, and
// the session hands it off only when no download opened the helper.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  electronSplashFor,
  electronSplashPage,
  tmplSplash,
} from "../src/electron/electron-splash.ts";
import { splashSession } from "../src/electron/splash-session.ts";
import type { ProgressDialog } from "../src/electron/runtime-dialog.ts";
import { resolveSplash } from "../src/build/splash.ts";
import type { SplashSpec } from "../src/electron/splash.ts";
import { electronMainScript } from "../src/electron/electron-scripts.ts";
import {
  tmplBounds,
  tmplCrashGuard,
  tmplShowWhenPainted,
} from "../src/electron/electron-shared.ts";
import { electronMainScriptUDS } from "../src/electron/electron-uds.ts";
import { classifyElectronLine } from "../src/electron/electron-renderer-log.ts";
import { pngFromRgba } from "../src/build/app-icon.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { accountEnv } from "./e2e-app-harness.ts";

const png = await pngFromRgba(new Uint8Array(640 * 360 * 4).fill(40), 640, 360);
const spec = (extra: Record<string, unknown> = {}): SplashSpec => {
  const r = resolveSplash(
    { build: { splash: { image: "s@2x.png", ...extra } } },
    { root: "/p", appId: "com.example.notes", read: () => png },
  );
  if ("error" in r) throw new Error(r.error);
  return r.splash!;
};

Deno.test("electron splash: the page is the helpers' frame — @2x halved, the text over the image in its font and colours, both modes, corners, border; no bar, no ✕", () => {
  const p = electronSplashPage(
    spec({
      text: "{title} <1>",
      color: "#ffffff",
      border: "#123456",
      radius: 12,
      font: { family: "Georgia", size: 15 },
    }),
    "Notes",
    "windows",
  );
  assertEquals([p.w, p.h], [320, 180]);
  assertStringIncludes(p.html, '<p id="t">Notes &lt;1&gt;</p>');
  assertStringIncludes(p.html, "border-radius:12px");
  assertStringIncludes(p.html, "border:1px solid #123456");
  assertStringIncludes(p.html, '15pt "Georgia"');
  assertStringIncludes(p.html, "#t{color:#ffffff}");
  assertStringIncludes(p.html, "@media (prefers-color-scheme:dark)");
  assertStringIncludes(p.html, "text-align:center"); // the default
  // Windows' default: no text shadow (as its helper); macOS/Linux: one.
  assertStringIncludes(p.html, "text-shadow:none");
  assertStringIncludes(
    electronSplashPage(spec(), "Notes", "darwin").html,
    "text-shadow:0 1px 2px",
  );
  assert(!/progress|✕/.test(p.html));
  // text: false — the image alone; below the image — a strip under it.
  assert(
    !electronSplashPage(spec({ text: false }), "N", "windows").html
      .includes('id="t"'),
  );
  const below = electronSplashPage(
    spec({ textPosition: "below" }),
    "N",
    "windows",
  );
  assert(below.h > 180, `${below.h}`);
});

Deno.test("electron splash: the main script makes it before the app's window, in both shells; none without one", async () => {
  assertEquals(tmplSplash(null), "");
  const e = await electronSplashFor(spec(), "Notes", "windows");
  try {
    for (
      const src of [
        electronMainScript("http://127.0.0.1:1/", { splash: e.splash }),
        electronMainScriptUDS("aio://app/", "/tmp/x.sock", {
          meta: { splash: e.splash },
        }),
      ]
    ) {
      new Function("require", "process", src); // parses
      const made = src.indexOf("__aioSplashOpen();");
      const win = src.indexOf("const win = new BrowserWindow(b);");
      assert(made > 0 && made < win, "the splash is made first");
      assertStringIncludes(src, "w.showInactive();");
      assertStringIncludes(src, "focusable: false");
    }
    assertStringIncludes(await Deno.readTextFile(e.splash.page), "<img");
  } finally {
    await Deno.remove(e.dir, { recursive: true });
  }
  assert(
    !electronMainScript("http://127.0.0.1:1/").includes("__aioSplashOpen"),
  );
});

Deno.test("electron splash: its main-process lines are logged at info", () => {
  assertEquals(
    classifyElectronLine("[aio:main:info] electron: splash — visible 90 ms"),
    {
      route: "info",
      text: "electron: splash — visible 90 ms",
      from: "electron",
    },
  );
});

function opener(opened: string[]) {
  return () =>
    Promise.resolve({
      name: "fake",
      open(title: string) {
        opened.push(title);
        const d: ProgressDialog = {
          update() {},
          shown: Promise.resolve(),
          cancelled: new Promise(() => {}),
          lost: new Promise(() => {}),
          close: () => Promise.resolve(),
        };
        return Promise.resolve(d);
      },
    });
}

Deno.test("electron splash: the session opens the helper only for a download, and hands the splash to Electron otherwise — silently, once; show firstStart never hands off", async () => {
  const run = (s: SplashSpec, download: boolean) => {
    const opened: string[] = [], log: string[] = [];
    const ses = splashSession(s, {
      title: "Notes",
      log: { info: (m) => log.push(m), error: (m) => log.push(m) },
      backend: opener(opened),
      electronDraws: true,
    });
    ses.open();
    if (download) ses.download();
    return { ses, opened, log };
  };
  const later = run(spec(), false);
  await new Promise((r) => setTimeout(r, 5));
  assertEquals(later.opened, []);
  assertEquals(later.ses.handOff!(), true);
  assertEquals(later.ses.handOff!(), false);
  assertEquals(await later.ses.closed, "ready");
  later.ses.ready();
  assertEquals(later.log, []);
  // A first start: the helper is the download's window, and keeps the splash.
  const first = run(spec(), true);
  await new Promise((r) => setTimeout(r, 5));
  assertEquals(first.opened, ["Notes"]);
  assertEquals(first.ses.handOff!(), false);
  first.ses.shutdown();
  const fs = run(spec({ show: "firstStart" }), false);
  assertEquals(fs.ses.handOff!(), false);
  fs.ses.ready();
});

// ── Real Electron on the nested display (ELECTRON_E2E=1) ─────────────────

const ELECTRON_BIN = Deno.env.get("AIO_TEST_ELECTRON") ??
  "node_modules/.bin/electron";
const e2eSkip = () => {
  try {
    Deno.statSync(ELECTRON_BIN);
  } catch {
    return true;
  }
  return !Deno.env.get("ELECTRON_E2E") ||
    (Deno.build.os === "linux" && !testDisplayEnv().DISPLAY);
};

Deno.test({
  name:
    "electron splash e2e: on screen before the app's window every time, the window not held, the splash gone minMs after it appeared",
  ignore: e2eSkip(),
  async fn() {
    const dir = await tempDir("electron-splash-e2e-");
    try {
      const e = await electronSplashFor(
        spec({ minMs: 1500 }),
        "Notes",
        "windows",
      );
      const main = `const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
app.setPath('userData', ${JSON.stringify(join(dir, "profile"))});
${tmplCrashGuard()}
${tmplBounds()}
const __aioBgNow = () => null;
app.whenReady().then(() => {
  const b = loadBounds(800, 600);
${tmplSplash(e.splash)}
  const win = new BrowserWindow({ show: false, ...b });
${tmplShowWhenPainted()}
  win.loadURL('data:text/html,<p>app</p>');
  setTimeout(() => app.exit(0), 3500);
});
`;
      await Deno.writeTextFile(join(dir, "main.cjs"), main);
      const lines: string[] = [];
      for (let i = 0; i < 3; i++) {
        const out = await new Deno.Command(ELECTRON_BIN, {
          args: ["--no-sandbox", join(dir, "main.cjs")],
          env: {
            ...Deno.env.toObject(),
            ...testDisplayEnv(),
            HOME: dir,
            ...accountEnv(),
          },
          signal: AbortSignal.timeout(30_000),
        }).output();
        const said = new TextDecoder().decode(out.stderr).split("\n")
          .filter((l) => l.includes("splash —"));
        const vis = said.findIndex((l) => l.includes("visible"));
        const shows = said.findIndex((l) => l.includes("window shows"));
        assert(vis >= 0 && shows > vis, said.join("\n"));
        assert(!said[shows]!.includes("BEFORE"), said.join("\n"));
        assert(said.some((l) => l.includes("closed (ready)")), said.join("\n"));
        lines.push(...said);
      }
      await Deno.remove(e.dir, { recursive: true });
      console.log(lines.join("\n"));
    } finally {
      await dropTempDir(dir);
    }
  },
});
