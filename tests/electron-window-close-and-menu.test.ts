// Every way a window is closed takes ONE path; and on macOS the keyboard
// works because there is a menu.
//
// Measured (Electron 44.4.1, Linux and macOS, the same order on both):
//   win.close() / the title-bar button   close → destroyed → closed
//   app.quit() / the menu's Quit / TERM  before-quit → close → destroyed → closed → will-quit
//   the page's own window.close()        destroyed → closed → window-all-closed
// The last one never fires 'close' — the event a close-to-tray app turns into
// a hide and the one the window's bounds are saved on — and nothing in the
// main process can cancel it. A `closeToTray` app whose page called
// window.close() was simply gone. So the page's function is routed to the
// same verb `__aioWindow.close()` sends, in BOTH shells (the WebSocket shell
// had neither the verbs nor their handler, while the docs promise them "in
// every desktop mode").
//
// And macOS: with `Menu.setApplicationMenu(null)` the menu bar held one item
// (`[app] Quit`, from the framework's stub). The standard shortcuts there are
// menu items, not key handlers — no Edit menu, no Cmd+C/V/X/A/Z in a text
// field; no Cmd+W, Cmd+M, Cmd+H at all.
//
// The real-window halves: tests/electron-second-launch-show-e2e.test.ts
// (window.close() under close-to-tray, real Electron).
import { assert, assertEquals } from "@std/assert";
import {
  shellBridgePreload,
  tmplAppMenu,
  tmplTray,
  udsPreloadScript,
} from "../src/electron/electron-shared.ts";
import { electronMainScript } from "../src/electron/electron-scripts.ts";
import { electronMainScriptUDS } from "../src/electron/electron-uds.ts";
import { electronClientScript } from "../src/electron/electron-client-script.ts";

/** Run a preload's text against stand-ins for Electron's renderer modules;
 *  returns the page's `window` as the preload left it and what was sent. */
function runPreload(code: string) {
  const sent: unknown[][] = [];
  // deno-lint-ignore no-explicit-any
  const win: any = { close: () => sent.push(["NATIVE window.close"]) };
  const electron = {
    ipcRenderer: {
      send: (...a: unknown[]) => sent.push(a),
      on: () => {},
      invoke: () => Promise.resolve(),
    },
    contextBridge: {
      exposeInMainWorld: (k: string, v: unknown) => win[k] = v,
      // The real one runs `func` in the page's world; here that world is `win`.
      executeInMainWorld: ({ func }: { func: () => void }) =>
        new Function("window", `(${func.toString()})()`)(win),
    },
  };
  new Function("require", "window", "document", "MutationObserver", code)(
    () => electron,
    win,
    { addEventListener: () => {}, getElementById: () => null },
    class {
      observe() {}
      disconnect() {}
    },
  );
  return { win, sent };
}

Deno.test("window close: the page's window.close() is the window's close verb, in both shells' preloads", () => {
  for (
    const [name, code] of [
      ["ws", shellBridgePreload({ standalone: true })],
      ["uds", udsPreloadScript()],
    ] as const
  ) {
    const { win, sent } = runPreload(code);
    win.close();
    assertEquals(
      sent,
      [["__aio:win", "close"]],
      `${name}: window.close() must ask the window, not destroy the page`,
    );
    // The documented verbs are there in both (the WS shell had none).
    win.__aioWindow.minimize();
    win.__aioWindow.maximize();
    win.__aioWindow.close();
    assertEquals(sent.slice(1), [
      ["__aio:win", "minimize"],
      ["__aio:win", "maximize"],
      ["__aio:win", "close"],
    ], name);
  }
});

/** The shared window template, run against stand-ins. */
function runTray() {
  const calls: string[] = [];
  const ipc: Record<string, (e: unknown, ...a: unknown[]) => void> = {};
  let destroyed = false;
  const win = {
    isDestroyed: () => destroyed,
    isMinimized: () => false,
    isMaximized: () => false,
    minimize: () => calls.push("minimize"),
    maximize: () => calls.push("maximize"),
    unmaximize: () => calls.push("unmaximize"),
    close: () => calls.push("close"),
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
  };
  new Function(
    "win",
    "app",
    "ipcMain",
    "require",
    "__aioQuitting",
    tmplTray(undefined, "null", "t"),
  )(
    win,
    { on: () => {} },
    {
      on: (ch: string, fn: (e: unknown, ...a: unknown[]) => void) =>
        ipc[ch] = fn,
    },
    () => {
      throw new Error("no module is needed without a tray or a show file");
    },
    false,
  );
  return { calls, ipc, destroy: () => destroyed = true };
}

Deno.test("window close: the verb handler calls win.close() — the cancellable close — and nothing unasked", () => {
  const { calls, ipc, destroy } = runTray();
  const h = ipc["__aio:win"];
  assert(h, "the shared window template registers no '__aio:win' handler");
  h({}, "close");
  h({}, "minimize");
  h({}, "maximize");
  h({}, "destroy"); // not a verb
  h({}, undefined);
  assertEquals(calls, ["close", "minimize", "maximize"]);
  destroy();
  h({}, "close");
  assertEquals(calls.length, 3, "a destroyed window is left alone");
});

Deno.test("window close: both window shells carry the handler exactly once and the routed preload", () => {
  const ws = electronMainScript("http://127.0.0.1:1/", { title: "t" });
  const uds = electronMainScriptUDS("http://127.0.0.1:1/", "/tmp/x.sock", {
    title: "t",
  });
  for (const [name, s] of [["ws", ws], ["uds", uds]] as const) {
    assertEquals(
      s.split("ipcMain.on('__aio:win'").length - 1,
      1,
      `${name}: one handler — two would close twice`,
    );
    assert(s.includes("executeInMainWorld"), `${name}: preload not routed`);
    new Function(s); // throws on a syntax error
  }
});

/** Run the menu template on a given platform; returns what was set. */
function runMenu(platform: string, title?: string) {
  const set: unknown[] = [];
  let ready: (() => void) | null = null;
  const Menu = {
    setApplicationMenu: (m: unknown) => set.push(m),
    buildFromTemplate: (t: unknown) => ({ template: t }),
  };
  const app = {
    name: "slug-name",
    whenReady: () => ({ then: (fn: () => void) => ready = fn }),
  };
  new Function("app", "Menu", "process", tmplAppMenu(title))(app, Menu, {
    platform,
  });
  const beforeReady = [...set];
  (ready as (() => void) | null)?.();
  return { beforeReady, set, waitedForReady: ready !== null };
}

type Item = { role?: string; label?: string; type?: string; submenu?: Item[] };

Deno.test("app menu: macOS gets Quit, the Edit roles and the window roles — after ready", () => {
  const { beforeReady, set, waitedForReady } = runMenu("darwin", "My App");
  // Electron's default menu is still suppressed first, before ready.
  assertEquals(beforeReady, [null]);
  assert(waitedForReady, "buildFromTemplate needs the app to be ready");
  assertEquals(set.length, 2);
  const menus = (set[1] as { template: Item[] }).template;
  const roles = (m: Item) => (m.submenu ?? []).map((i) => i.role ?? i.type);
  // The app menu: the system's own items, named after the app.
  assertEquals(menus[0]!.label, "My App");
  assertEquals(roles(menus[0]!), [
    "hide",
    "hideOthers",
    "unhide",
    "separator",
    "quit",
  ]);
  assertEquals(menus[0]!.submenu!.at(-1)!.label, "Quit My App");
  // Edit: Electron's role carries undo/redo/cut/copy/paste/selectAll.
  assertEquals(menus[1], { role: "editMenu" });
  // Window: Cmd+W is `close` — win.close(), so close-to-tray hides.
  assertEquals(menus[2]!.role, "windowMenu");
  assertEquals(roles(menus[2]!), [
    "minimize",
    "zoom",
    "close",
    "separator",
    "front",
  ]);
  // Nothing of Electron's default menu: no File/View/Help, no devtools item.
  assertEquals(menus.length, 3);
  // Untitled app: the name Electron knows it by.
  const untitled = (runMenu("darwin").set[1] as { template: Item[] }).template;
  assertEquals(untitled[0]!.label, "slug-name");
});

Deno.test("app menu: Linux and Windows are unchanged — no menu at all", () => {
  for (const os of ["linux", "win32"]) {
    const { set, waitedForReady } = runMenu(os, "My App");
    assertEquals(set, [null], os);
    assertEquals(waitedForReady, false, os);
  }
});

Deno.test("app menu: every generated main script carries it", () => {
  for (
    const s of [
      electronMainScript("http://127.0.0.1:1/", { title: "t" }),
      electronMainScriptUDS("http://127.0.0.1:1/", "/tmp/x.sock", {
        title: "t",
      }),
      electronClientScript(),
    ]
  ) {
    assert(s.includes("Menu.setApplicationMenu(null);"));
    assert(s.includes("{ role: 'editMenu' }"));
    assert(s.includes("process.platform === 'darwin'"));
  }
});
