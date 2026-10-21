// The splash on the app's window, where the window REALLY is.
//
// Every helper is placed by the same rule as the window (splash-place.ts),
// from the saved bounds — a prediction. A window manager, a DPI change or
// Electron itself may still put the window elsewhere, so once it shows the
// main process says where it is (`WINDOW_TAG`, and after each move), and the
// splash moves onto it (`followWindow`, on by default). On Windows the
// helpers are per-monitor DPI aware and place in physical pixels, the space
// `screen.dipToScreenRect` converts the window into.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  classifyElectronLine,
  WINDOW_TAG,
  type WindowAt,
  windowLine,
} from "../src/electron/electron-renderer-log.ts";
import {
  macSplashArgs,
  moveArg,
  type ProgressDialog,
  PS_DPI,
  type SplashOpener,
  WINDOWS_ASK_PS,
  WINDOWS_PROGRESS_PS,
  WINDOWS_SPLASH_PS,
  windowsSplashEnv,
} from "../src/electron/runtime-dialog.ts";
import { MAC_SPLASH_JXA } from "../src/electron/runtime-dialog.ts";
import { splashSession } from "../src/electron/splash-session.ts";
import { resolveSplash } from "../src/build/splash.ts";
import type { SplashSpec } from "../src/electron/splash.ts";
import { windowBoundsOf } from "../src/electron/electron-spawn.ts";
import {
  tmplBounds,
  tmplCrashGuard,
  tmplShowWhenPainted,
} from "../src/electron/electron-shared.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { accountEnv } from "./e2e-app-harness.ts";

const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==",
  ),
  (ch) => ch.charCodeAt(0),
);
const spec = (extra: Record<string, unknown> = {}): SplashSpec => {
  const r = resolveSplash({ build: { splash: { image: "s.png", ...extra } } }, {
    root: "/p",
    appId: "com.example.notes",
    read: () => png,
  });
  if ("error" in r) throw new Error(r.error);
  return r.splash!;
};

/** A session over a fake helper that records its moves (or has none). */
async function follow(s: SplashSpec, canMove = true) {
  const moves: WindowAt[] = [];
  const log: string[] = [];
  const d: ProgressDialog = {
    update() {},
    shown: Promise.resolve(),
    cancelled: new Promise(() => {}),
    lost: new Promise(() => {}),
    close: () => Promise.resolve(),
    ...(canMove ? { move: (at: WindowAt) => void moves.push(at) } : {}),
  };
  const opener: SplashOpener = {
    name: "fake",
    open: () => Promise.resolve(d),
  };
  const ses = splashSession(s, {
    title: "Notes",
    log: { info: (m) => log.push(m), error: (m) => log.push(`! ${m}`) },
    backend: () => Promise.resolve(opener),
    tickMs: 5,
  });
  ses.open();
  await new Promise((r) => setTimeout(r, 10));
  return { ses, moves, log };
}

const AT = { x: 900, y: 300, width: 640, height: 480 };

Deno.test("follow: the splash moves onto the window where it really is — when it shows and after each move", async () => {
  const f = await follow(spec());
  f.ses.windowAt?.(AT);
  f.ses.windowAt?.({ ...AT, x: 950 });
  assertEquals(f.moves, [AT, { ...AT, x: 950 }]);
  f.ses.shutdown();
  f.ses.windowAt?.({ ...AT, x: 10 });
  assertEquals(f.moves.length, 2, "closed: nothing moves");
});

Deno.test("follow: off with followWindow false, and for position primary / pointer (not centred on the window)", async () => {
  for (
    const s of [
      spec({ followWindow: false }),
      spec({ position: "primary" }),
      spec({ position: "pointer" }),
    ]
  ) {
    const f = await follow(s);
    f.ses.windowAt?.(AT);
    assertEquals(f.moves, []);
    f.ses.shutdown();
  }
});

Deno.test("follow: a helper that cannot move (yad, zenity) is said once, with where the window is", async () => {
  const f = await follow(spec(), false);
  f.ses.windowAt?.(AT);
  f.ses.windowAt?.({ ...AT, x: 1 });
  const said = f.log.filter((l) => l.includes("cannot move it"));
  assertEquals(said.length, 1);
  assertStringIncludes(said[0]!, "900,300 640x480");
  f.ses.shutdown();
});

Deno.test("follow: the window line is one tagged JSON line; anything else under the tag is a plain line", () => {
  const at = { ...AT, screen: { x: 1350, y: 450, width: 960, height: 720 } };
  assertEquals(classifyElectronLine(windowLine(at)), { route: "window", at });
  for (const bad of [`${WINDOW_TAG}{`, `${WINDOW_TAG}{"x":1}`]) {
    assertEquals(classifyElectronLine(bad).route, "raw", bad);
  }
});

Deno.test("follow: Windows helpers get the window in physical pixels when the main process could convert it; the others its DIPs", () => {
  const at = { ...AT, screen: { x: 1350, y: 450, width: 960, height: 720 } };
  assertEquals(moveArg(at, true), "[1350,450,960,720]");
  assertEquals(moveArg(at, false), "[900,300,640,480]");
  assertEquals(moveArg(AT, true), "[900,300,640,480]", "no conversion");
});

Deno.test("follow: the saved window opens the Windows helpers where it is in physical pixels; elsewhere, and for a changed declared size, its DIPs", async () => {
  const dir = await tempDir("window-follow-");
  try {
    await Deno.writeTextFile(
      join(dir, "window-state.json"),
      JSON.stringify({
        x: 100,
        y: 50,
        width: 640,
        height: 480,
        declaredWidth: 800,
        declaredHeight: 600,
        screen: { x: 150, y: 75, width: 960, height: 720 },
      }),
    );
    const meta = { profileDir: dir, width: 800, height: 600 };
    assertEquals(windowBoundsOf(meta, "N", "windows"), {
      x: 150,
      y: 75,
      width: 960,
      height: 720,
    });
    const dips = windowBoundsOf(meta, "N", "linux");
    assertEquals([dips.x, dips.y, dips.width, dips.height], [
      100,
      50,
      640,
      480,
    ]);
    // The app now declares another size: the saved rect is not reused.
    const other = windowBoundsOf({ ...meta, width: 1000 }, "N", "windows");
    assertEquals([other.x, other.width], [100, 1000]);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("follow: every Windows helper is per-monitor DPI aware before its first window, and sizes itself by that monitor's scale; the splash re-places from its move file", () => {
  assertStringIncludes(PS_DPI, "SetProcessDpiAwarenessContext([IntPtr](-4))");
  assertStringIncludes(PS_DPI, "GetDpiForMonitor");
  for (const ps of [WINDOWS_SPLASH_PS, WINDOWS_PROGRESS_PS, WINDOWS_ASK_PS]) {
    const dpi = ps.indexOf(PS_DPI);
    assert(dpi > 0, "PS_DPI missing");
    for (
      const form of [
        "New-Object System.Windows.Forms.Form",
        "New-Object AioSplashForm",
      ]
    ) {
      const at = ps.indexOf(form);
      assert(at < 0 || at > dpi, `${form} before the DPI awareness`);
    }
    assertStringIncludes(ps, "$K = ");
  }
  assertStringIncludes(WINDOWS_PROGRESS_PS, "$f.Scale(");
  assertStringIncludes(WINDOWS_ASK_PS, "$f.Scale(");
  // The splash: its logical sizes and its font at the monitor's scale.
  assertStringIncludes(WINDOWS_SPLASH_PS, "$FW = [int]($img.Width / $sc * $K)");
  assertStringIncludes(
    WINDOWS_SPLASH_PS,
    "[System.Drawing.GraphicsUnit]::Pixel",
  );
  assertStringIncludes(WINDOWS_SPLASH_PS, "ReadAllText($env:AIO_SPL_AT)");
  const s = spec();
  const a = { title: "N", text: "t", image: "/i", file: "/f", ack: "/a" };
  assertEquals(windowsSplashEnv(s, { ...a, at: "/at" }).AIO_SPL_AT, "/at");
  // Cocoa: the move file is the last argument, read each tick.
  const argv = macSplashArgs(s, { ...a, at: "/at" });
  assertEquals(argv.at(-1), "/at");
  assertStringIncludes(
    MAC_SPLASH_JXA,
    `const atFile = argv[${argv.length - 1}]`,
  );
  assertStringIncludes(
    MAC_SPLASH_JXA,
    "win.setFrameOrigin(aioPlace(JSON.parse(lastAt)",
  );
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
  return Deno.build.os !== "linux" || !Deno.env.get("ELECTRON_E2E") ||
    !testDisplayEnv().DISPLAY;
};

/** The generated placement + show code in a real Electron: the window line
 *  it writes once shown, and what it warned. */
async function realWindow(saved: Record<string, number> | null) {
  const dir = await tempDir("window-follow-e2e-");
  try {
    const profile = join(dir, "profile");
    await Deno.mkdir(profile);
    if (saved) {
      await Deno.writeTextFile(
        join(profile, "window-state.json"),
        JSON.stringify({ ...saved, declaredWidth: 800, declaredHeight: 600 }),
      );
    }
    const main = `const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
app.setPath('userData', ${JSON.stringify(profile)});
${tmplCrashGuard()}
${tmplBounds()}
const __aioBgNow = () => null;
app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, ...loadBounds(800, 600) });
${tmplShowWhenPainted()}
  win.loadURL('data:text/html,x');
  setTimeout(() => app.exit(0), 2500);
});
`;
    await Deno.writeTextFile(join(dir, "main.cjs"), main);
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
    const lines = new TextDecoder().decode(out.stderr).split("\n");
    return {
      at: lines.map((l) => classifyElectronLine(l)).find((r) =>
        r.route === "window"
      ),
      warned: lines.filter((l) => l.includes("not where aio placed it")),
    };
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test({
  name:
    "follow e2e: predicted == actual — the generated rule's rect is the window Electron really opens (a saved window, one half off the display, none saved)",
  ignore: e2eSkip(),
  async fn() {
    const kept = await realWindow({ x: 300, y: 200, width: 640, height: 480 });
    assertEquals(kept.at, {
      route: "window",
      at: { x: 300, y: 200, width: 640, height: 480 },
    });
    assertEquals(kept.warned, []);
    // Moved back onto the display by the rule, and opened exactly there.
    for (const saved of [{ x: 99999, y: 200, width: 640, height: 480 }, null]) {
      const r = await realWindow(saved);
      assert(r.at, "no window line");
      assertEquals(r.warned, [], JSON.stringify(r.at));
    }
  },
});
