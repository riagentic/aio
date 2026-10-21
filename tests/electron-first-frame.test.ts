/**
 * The desktop window's first frame (field report #42): made hidden, shown
 * when its page has painted (`ready-to-show`) or after WINDOW_SHOW_CAP_MS,
 * with the page's background where aio knows it. Measured on X11 (`:77`,
 * a dark page): before, a light window for 1.3–2.2 s before the page; after,
 * the page is the first frame, no later than before.
 */
import { classifyElectronLine } from "../src/electron/electron-renderer-log.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  tmplShowWhenPainted,
  tmplWindowShape,
  WINDOW_SHOW_CAP_MS,
} from "../src/electron/electron-shared.ts";
import { electronMainScript } from "../src/electron/electron-scripts.ts";
import { electronMainScriptUDS } from "../src/electron/electron-uds.ts";
import { electronClientScript } from "../src/electron/electron-client-script.ts";
import { appIdentityColors, windowBackground } from "../src/build/app-theme.ts";
import { electronBackgroundRefusal } from "../src/server/config.ts";

/** The show logic, run against a fake window and fake timers. */
function showRig(
  restoreMax: boolean,
  bg: string | null = null,
  placed: Record<string, number> | null = null,
  bounds = { x: 10, y: 20, width: 800, height: 600 },
  platform = "linux",
) {
  const calls: string[] = [];
  const handlers: Record<string, () => void> = {};
  const timers: (() => void)[] = [];
  const later: (() => void)[] = []; // the move debounce
  const warns: string[] = [];
  const lines: string[] = [];
  const win = {
    isDestroyed: () => false,
    show: () => calls.push("show"),
    maximize: () => calls.push("maximize"),
    getBounds: () => ({ ...bounds }),
    once: (e: string, f: () => void) => (handlers[e] = f),
    on: (e: string, f: () => void) => (handlers[e] = f),
    setBackgroundColor: (c: string) => calls.push(`bg ${c}`),
  };
  const screen = {
    dipToScreenRect: (_w: unknown, r: typeof bounds) => ({
      x: r.x * 1.5,
      y: r.y * 1.5,
      width: r.width * 1.5,
      height: r.height * 1.5,
    }),
  };
  const theme = {
    on: (_e: string, f: () => void) => (handlers.theme = f),
    removeListener() {},
  };
  new Function(
    "win",
    "__aioRestoreMax",
    "__aioBgNow",
    "setTimeout",
    "clearTimeout",
    "console",
    "require",
    "process",
    "__aioPlaced",
    tmplShowWhenPainted(),
  )(
    win,
    restoreMax,
    () => bg,
    (f: () => void, ms: number) => {
      if (ms === 100) return later.push(f);
      assertEquals(ms, WINDOW_SHOW_CAP_MS);
      timers.push(f);
      return timers.length;
    },
    () => {},
    { warn: (m: string) => warns.push(m) },
    () => ({ nativeTheme: theme, screen }),
    { platform, stderr: { write: (s: string) => lines.push(s) } },
    placed,
  );
  return { calls, handlers, timers, later, warns, lines, bounds };
}

Deno.test("first frame: the window shows once its page has painted — once, with a saved maximize applied in that moment, and nothing said", () => {
  const r = showRig(true);
  assertEquals(r.calls, [], "hidden until the page has painted");
  r.handlers["ready-to-show"]!();
  assertEquals(r.calls, ["maximize", "show"]);
  r.timers[0]!(); // the cap, late: nothing more
  assertEquals(r.calls, ["maximize", "show"]);
  assertEquals(r.warns, []);
});

Deno.test("first frame: once shown, the window says where it REALLY is (the splash follows it) — on Windows in physical pixels too; not where aio placed it is said once, with both rects; a move says it again", () => {
  const placed = { x: 10, y: 20, width: 800, height: 600 };
  const same = showRig(false, null, placed);
  same.handlers["ready-to-show"]!();
  assertEquals(same.lines.map((l) => classifyElectronLine(l.trimEnd())), [
    { route: "window", at: placed },
  ]);
  assertEquals(same.warns, [], "where aio placed it: nothing said");
  // A window manager put it elsewhere.
  const moved = showRig(false, null, placed, {
    x: 40,
    y: 70,
    width: 800,
    height: 600,
  }, "win32");
  moved.handlers["ready-to-show"]!();
  assertEquals(classifyElectronLine(moved.lines[0]!.trimEnd()), {
    route: "window",
    at: {
      x: 40,
      y: 70,
      width: 800,
      height: 600,
      screen: { x: 60, y: 105, width: 1200, height: 900 },
    },
  });
  assertEquals(moved.warns.length, 1);
  assertStringIncludes(moved.warns[0]!, '"x":40,"y":70');
  assertStringIncludes(moved.warns[0]!, 'aio placed it ({"x":10,"y":20');
  // Moved again (the user, a WM): said again where it is — no warning.
  moved.bounds.x = 500;
  moved.handlers["move"]!();
  moved.later.at(-1)!();
  assertEquals(moved.lines.length, 2);
  assertStringIncludes(moved.lines[1]!, '"x":500');
  assertEquals(moved.warns.length, 1);
});

Deno.test("first frame: a page that never paints is shown after the cap, said once; a late paint changes nothing", () => {
  assertEquals(WINDOW_SHOW_CAP_MS, 5_000);
  const r = showRig(false);
  r.timers[0]!();
  assertEquals(r.calls, ["show"]);
  assertEquals(r.warns.length, 1);
  assertStringIncludes(r.warns[0]!, "had not painted its page 5000 ms after");
  r.handlers["ready-to-show"]!();
  assertEquals(r.calls, ["show"]);
  assertEquals(r.warns.length, 1);
});

Deno.test("first frame: the background follows the OS's dark mode while the window lives; none set, none followed", () => {
  const r = showRig(false, "#101418");
  r.handlers.theme!();
  assertEquals(r.calls, ["bg #101418"]);
  assertEquals(showRig(false).handlers.theme, undefined);
});

Deno.test("first frame: the window is made hidden, with the known background as the OS is now", () => {
  const bg = { light: "#fafafa", dark: "#101418" };
  for (const dark of [false, true]) {
    const b: Record<string, unknown> = {};
    new Function("b", "require", tmplWindowShape({ background: bg }))(
      b,
      () => ({ nativeTheme: { shouldUseDarkColors: dark } }),
    );
    assertEquals(b.show, false);
    assertEquals(b.backgroundColor, dark ? bg.dark : bg.light);
  }
  const b: Record<string, unknown> = {};
  new Function("b", "require", tmplWindowShape(undefined))(b, () => {
    throw new Error("not asked");
  });
  assertEquals(b.show, false);
  assert(!("backgroundColor" in b), "unknown: Electron's own");
});

Deno.test("first frame: both shells (connect and UDS) make the window hidden and show it when painted, and parse", () => {
  const meta = {
    title: "x",
    background: { light: "#ffffff", dark: "#000000" },
  };
  for (
    const s of [
      electronMainScript("http://127.0.0.1:1/", meta),
      electronMainScriptUDS("http://127.0.0.1:1/", "/tmp/x.sock", { meta }),
    ]
  ) {
    new Function(s); // parses
    const hidden = s.indexOf("b.show = false;");
    const made = s.indexOf("const win = new BrowserWindow(b);");
    const shown = s.indexOf("win.once('ready-to-show'");
    assert(hidden > 0 && made > hidden && shown > made);
    assertStringIncludes(s, '"light":"#ffffff","dark":"#000000"');
  }
});

Deno.test("first frame: the background is the app's setting, else the page background aio's theme paints, else unknown", () => {
  const id = appIdentityColors("com.example.notes");
  const theme = { light: id.light.background, dark: id.dark.background };
  const app = "com.example.notes";
  assertEquals(windowBackground("#101418", "tokens", true, app), {
    light: "#101418",
    dark: "#101418",
  });
  assertEquals(
    windowBackground({ light: "#ffffff", dark: "#000000" }, "full", false, app),
    { light: "#ffffff", dark: "#000000" },
  );
  assertEquals(windowBackground(null, "full", true, app), theme);
  assertEquals(windowBackground(undefined, "auto", false, app), theme);
  // "auto" steps aside for the app's style.css; "tokens" and "none" paint nothing.
  assertEquals(windowBackground(null, "auto", true, app), undefined);
  assertEquals(windowBackground(null, "tokens", false, app), undefined);
  assertEquals(windowBackground(null, undefined, false, app), undefined);
  assertEquals(windowBackground(null, "none", false, app), undefined);
});

Deno.test("first frame: electron.backgroundColor takes #rrggbb or { light, dark } of those, and refuses anything else by name", () => {
  for (
    const ok of [undefined, "#101418", "#ABCDEF", {
      light: "#ffffff",
      dark: "#000000",
    }]
  ) assertEquals(electronBackgroundRefusal(ok), null);
  const bad: [unknown, string][] = [
    ["black", "must be"],
    ["#fff", "must be"],
    [null, "must be"],
    [["#000000"], "must be"],
    [{ light: "#ffffff" }, "electron.backgroundColor.dark"],
    [
      { light: "#ffffff", dark: "#000000", dim: "#111111" },
      '"dim" is not a mode',
    ],
    [{ light: "white", dark: "#000000" }, "electron.backgroundColor.light"],
  ];
  for (const [v, says] of bad) {
    const r = electronBackgroundRefusal(v);
    assert(r && r.includes(says), `${JSON.stringify(v)}: ${r}`);
  }
});

Deno.test("first frame: the aio client's window (the connect page) is hidden until painted too, and parses", () => {
  const s = electronClientScript();
  new Function(s);
  const made = s.indexOf("const win = new BrowserWindow({");
  assert(made > 0 && s.indexOf("show: false,", made) > made);
  assert(s.indexOf("win.once('ready-to-show'", made) > made);
});
