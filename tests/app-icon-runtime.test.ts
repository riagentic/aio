// appIcon() — the app's tray icon, window icon and tray tooltip at run time
// (a field report). One effect on the notify pipeline: the builder checks
// it, the server hands it to every UI client as an "icon" frame, the page's
// runtime gives it to the shell's __aioWindow.icon, and the Electron main
// process applies it — looping an animation itself. The generated pieces are
// RUN here against stand-ins; the real-Electron proof is in the ledger.
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { appIcon, isAppIconEffect } from "../src/state/app-icon.ts";
import {
  APP_ICON_LIMITS,
  checkAppIcon,
} from "../src/protocol/app-icon-check.ts";
import { isFrameworkEffect, routeEffect } from "../src/state/route-effect.ts";
import { showAppIconEffect } from "../src/server/aio-dispatch.ts";
import { applyAppIcon } from "../src/browser/app-icon-client.ts";
import { dec } from "../src/protocol/envelope.ts";
import { log } from "../src/diagnostics/logger-api.ts";
import { appIcon as appIconFromMod, cell } from "../mod.ts";
import { testCell } from "../src/cell-test.ts";
import {
  ICON_EDGE,
  shellBridgePreload,
  tmplIconFit,
  tmplTray,
  udsPreloadScript,
} from "../src/electron/electron-shared.ts";

const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

Deno.test("appIcon(): PNG bytes become a data: URL; null and URLs pass as given", () => {
  const e = appIcon({ window: PNG, tray: ["/a.png", "/b.png"], tooltip: null });
  assertEquals(e.type, "__appIcon");
  assertEquals(
    e.window,
    "data:image/png;base64," + btoa("\x89PNG\x01\x02\x03"),
  );
  assertEquals(e.tray, ["/a.png", "/b.png"]);
  assertEquals(e.tooltip, null);
  assertEquals(e.fps, 8);
  assertEquals(appIcon({ tray: null }).tray, null);
  assert(isAppIconEffect(e) && isFrameworkEffect(e));
});

Deno.test("appIcon(): refuses what it cannot apply, at the call site", () => {
  const max = APP_ICON_LIMITS.frames;
  for (
    const [spec, why] of [
      [{}, "at least one of"],
      [{ icon: "/x.png" }, 'unknown key "icon"'],
      [{ tray: [] }, "empty frame list"],
      [{ tray: Array(max + 1).fill("/x.png") }, `at most ${max}`],
      [{ window: "" }, "not an image"],
      [{ window: new Uint8Array(APP_ICON_LIMITS.bytes + 1) }, "per image"],
      [{ window: "data:image/png;base64," + "A".repeat(700_000) }, "per image"],
      [{ tooltip: 3 }, "tooltip"],
      [{ tray: "/x.png", fps: 0 }, "fps"],
    ] as const
  ) {
    assertThrows(() => appIcon(spec as never), Error, why);
  }
});

// The cap is ONE measure everywhere — decoded bytes — so the method refuses
// exactly what the window would: a 450 KB PNG was accepted by the builder
// (raw bytes) and refused by the preload (its 600 KB base64 string).
Deno.test("appIcon(): the size cap is the same at the method and in the window", () => {
  const atCap = appIcon({ tray: new Uint8Array(APP_ICON_LIMITS.bytes) });
  const near = appIcon({ tray: new Uint8Array(450_000) });
  for (const e of [atCap, near]) {
    // What the preload and the main process check: the wire payload.
    checkAppIcon({ tray: e.tray }, APP_ICON_LIMITS);
  }
  const over = new Uint8Array(APP_ICON_LIMITS.bytes + 1);
  assertThrows(() => appIcon({ tray: over }), Error, "per image");
  let bin = "";
  for (const b of over) bin += String.fromCharCode(b);
  assertThrows(
    () =>
      checkAppIcon(
        { tray: "data:image/png;base64," + btoa(bin) },
        APP_ICON_LIMITS,
      ),
    Error,
    "per image",
  );
});

Deno.test("appIcon(): fps above the cap runs at the cap, and says so once", () => {
  const warn = log.warn;
  const said: string[] = [];
  // deno-lint-ignore no-explicit-any
  log.warn = ((c: string, m: string) => said.push(`${c}: ${m}`)) as any;
  try {
    assertEquals(appIcon({ tray: ["/a", "/b"], fps: 60 }).fps, 12);
    assertEquals(appIcon({ tray: ["/a", "/b"], fps: 60 }).fps, 12);
    assertEquals(appIcon({ tray: "/a", fps: 99 }).fps, 12); // static: silent
  } finally {
    log.warn = warn;
  }
  assertEquals(said, ["appIcon: fps 60 is above 12 — running at 12"]);
});

Deno.test("routeEffect: an appIcon effect reaches the appIcon handler only", () => {
  const seen: string[] = [];
  routeEffect(appIcon({ tooltip: "busy" }), {
    schedule: () => seen.push("schedule"),
    own: () => seen.push("own"),
    notify: () => seen.push("notify"),
    appIcon: () => seen.push("appIcon"),
    app: () => seen.push("app"),
  });
  assertEquals(seen, ["appIcon"]);
});

const busy = cell("busy", {
  state: { n: 0 },
  methods: {
    start(s) {
      s.n++;
      s.$do(appIconFromMod({ tooltip: "working" }));
    },
  },
});

testCell(
  busy,
  "s.$do(appIcon(...)) is a framework effect a method may emit",
  (t) => {
    t.send.start();
    t.expect.state((s) => s.n === 1);
    t.expect.effects(["__appIcon"]);
  },
);

Deno.test("server: the effect goes to every UI client as an 'icon' frame — and none is said", () => {
  const sent: string[] = [];
  const warned: string[] = [];
  const e = appIcon({ tray: "/busy.png", tooltip: "2 running" });
  assertEquals(
    showAppIconEffect(e, (r) => (sent.push(r), 2), (m) => warned.push(m)),
    2,
  );
  assertEquals(dec(sent[0]!), {
    v: 2,
    t: "icon",
    d: { tray: "/busy.png", tooltip: "2 running", fps: 8 },
  });
  assertEquals(warned, []);
  showAppIconEffect(e, () => 0, (m) => warned.push(m));
  assert(warned[0]?.includes("no UI client is connected"), warned[0]);
});

Deno.test("client: the frame goes to the shell's __aioWindow.icon; elsewhere it is said once", async () => {
  const g = globalThis as { __aioWindow?: unknown };
  const got: unknown[] = [];
  g.__aioWindow = { icon: (d: unknown) => (got.push(d), Promise.resolve()) };
  try {
    applyAppIcon({ tooltip: "x" });
    assertEquals(got, [{ tooltip: "x" }]);
    // A refusal (the preload's own included: a 404 app URL never reaches the
    // main process) is said, once per distinct reason — never swallowed.
    g.__aioWindow = {
      icon: (d: { tooltip: string }) =>
        Promise.reject(new Error(`refused ${d.tooltip}`)),
    };
    const warns: string[] = [];
    const origWarn = log.warn;
    // deno-lint-ignore no-explicit-any
    log.warn = ((_c: string, m: string) => warns.push(m)) as any;
    try {
      applyAppIcon({ tooltip: "a" });
      applyAppIcon({ tooltip: "a" });
      applyAppIcon({ tooltip: "b" });
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      log.warn = origWarn;
    }
    assertEquals(warns, [
      "the icon was not changed: refused a",
      "the icon was not changed: refused b",
    ]);
  } finally {
    delete g.__aioWindow;
  }
});

// ── the Electron main process (tmplTray's run-time icon half) ────────────

type Img = {
  src: unknown;
  isEmpty: () => boolean;
  getSize: () => { width: number; height: number };
  resize: (o: { width?: number; height?: number }) => Img;
};
/** A fake nativeImage: `data:,huge` is 8000×4000 pixels, anything else 32×32;
 *  `resize` keeps the aspect, as Electron's does. */
const img = (src: unknown, w = 32, h = 32, empty = false): Img => ({
  src,
  isEmpty: () => empty,
  getSize: () => ({ width: w, height: h }),
  resize: (o) => {
    const k = o.width !== undefined ? o.width / w : o.height! / h;
    const W = Math.round(w * k), H = Math.round(h * k);
    return img(`${src}@${W}x${H}`, W, H);
  },
});
const nativeImage = {
  createFromDataURL: (s: string): Img =>
    s === "data:,huge" ? img(s, 8000, 4000) : img(s, 32, 32, s === "data:,bad"),
  createFromBuffer: (b: Uint8Array): Img => img([...b], 32, 32, b.length === 0),
  createEmpty: (): Img => img(null, 0, 0, true),
};

function runMain(tray: boolean) {
  const handle: Record<string, (e: unknown, ...a: unknown[]) => unknown> = {};
  const windowIcons: unknown[] = [];
  const trayIcons: unknown[] = [];
  const tips: string[] = [];
  const lines: string[] = [];
  const warns: string[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const g = globalThis as { __aioTray?: unknown };
  const win = {
    isDestroyed: () => false,
    setIcon: (i: Img) => windowIcons.push(i.src),
    on: () => {},
  };
  class Tray {
    constructor(i: Img) {
      trayIcons.push(["new", i.src]);
    }
    setImage(i: Img) {
      trayIcons.push(i.src);
    }
    setToolTip(t: string) {
      tips.push(t);
    }
    setContextMenu() {}
    on() {}
    isDestroyed() {
      return false;
    }
  }
  const base = nativeImage.createFromDataURL("data:,base");
  new Function(
    "win",
    "app",
    "ipcMain",
    "require",
    "__aioQuitting",
    "process",
    "console",
    "setInterval",
    "clearInterval",
    "__base",
    tmplIconFit() + "\n" +
      tmplTray(tray ? { tray: { tooltip: "Tip" } } : undefined, "__base", "T"),
  )(
    win,
    { on: () => {} },
    { on: () => {}, handle: (c: string, f: () => unknown) => (handle[c] = f) },
    () => ({ Tray, Menu: { buildFromTemplate: () => ({}) }, nativeImage }),
    false,
    { platform: "test", stderr: { write: (s: string) => lines.push(s) } },
    { warn: (m: string) => warns.push(m), error: (m: string) => warns.push(m) },
    (fn: () => void, ms: number) => (timers.push({ fn, ms }), timers.length),
    (id: number | null) => {
      if (id) timers[id - 1] = { fn: () => {}, ms: -1 };
    },
    base,
  );
  // As the preload reads the handler's reply.
  const call = async (spec: unknown) => {
    const r = await handle["__aio:icon"]!({}, spec) as {
      state?: unknown;
      error?: string;
    };
    if (r.error) throw new Error(r.error);
    return r.state;
  };
  const state = () => handle["__aio:iconState"]!({});
  const done = () => delete g.__aioTray;
  return {
    call,
    state,
    windowIcons,
    trayIcons,
    tips,
    lines,
    warns,
    timers,
    done,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

Deno.test("main: a static icon, an animation looped in main, then null puts back the app's own", async () => {
  const m = runMain(true);
  try {
    await tick(); // the tray is created
    await m.call({ window: "data:,one" });
    assertEquals(m.windowIcons, ["data:,one"]);
    const st = await m.call({
      tray: ["data:,a", "data:,b", "data:,c"],
      fps: 10,
    });
    assertEquals((st as { tray: string }).tray, "animated");
    assertEquals(m.timers.at(-1)!.ms, 100, "1000 / fps");
    m.timers.at(-1)!.fn();
    m.timers.at(-1)!.fn();
    m.timers.at(-1)!.fn();
    assertEquals(m.trayIcons.slice(1), [
      "data:,a",
      "data:,b",
      "data:,c",
      "data:,a",
    ]);
    await m.call({ tray: null, tooltip: "2 running" });
    assertEquals(m.timers.at(-1)!.ms, -1, "the animation stopped");
    assertEquals(m.trayIcons.at(-1), "data:,base");
    assertEquals(m.tips.at(-1), "2 running");
    await m.call({ tooltip: null });
    assertEquals(m.tips.at(-1), "Tip", "null is the configured tooltip");
    assertEquals(await m.state(), {
      window: "static",
      tray: "default",
      tooltip: null,
      fps: 10,
      frames: { window: 1, tray: 0 },
    });
    // One info line per change of KIND, for `am logs`.
    assertEquals(m.lines, [
      "[aio:main:info] appIcon: window static · tray default\n",
      "[aio:main:info] appIcon: window static · tray animated (3 frames, 10 fps)\n",
      "[aio:main:info] appIcon: window static · tray default\n",
    ]);
  } finally {
    m.done();
  }
});

Deno.test("main: an icon larger than ICON_EDGE reaches the window and the tray scaled down to it", async () => {
  // An 8000×4000 PNG under the byte cap would be a 128 MB _NET_WM_ICON
  // property on X11, re-sent every animation frame.
  const m = runMain(true);
  try {
    await tick();
    await m.call({
      window: "data:,huge",
      tray: ["data:,huge", "data:,a"],
      fps: 2,
    });
    assertEquals(m.windowIcons, [`data:,huge@${ICON_EDGE}x${ICON_EDGE / 2}`]);
    m.timers.at(-1)!.fn();
    assertEquals(m.trayIcons.slice(1), [
      `data:,huge@${ICON_EDGE}x${ICON_EDGE / 2}`,
      "data:,a",
    ]);
  } finally {
    m.done();
  }
});

Deno.test("main: a bad frame changes nothing, and is refused with why", async () => {
  const m = runMain(true);
  try {
    await tick();
    await assertRejects(
      () => m.call({ tray: ["data:,a", "data:,bad"] }) as Promise<unknown>,
      Error,
      "tray[1] is not an image",
    );
    await assertRejects(
      () => m.call({ window: "/x.png" }) as Promise<unknown>,
      Error,
      "a URL the page did not fetch",
    );
    assertEquals(m.trayIcons.length, 1, "only the tray's creation");
    assertEquals(m.windowIcons, []);
    assert(
      m.warns.some((w) => w.startsWith("⚠ appIcon(): tray[1]")),
      m.warns.join("\n"),
    );
  } finally {
    m.done();
  }
});

Deno.test("main: without ui.tray, a tray change is refused; the window still works", async () => {
  const m = runMain(false);
  try {
    await assertRejects(
      () => m.call({ tooltip: "x" }) as Promise<unknown>,
      Error,
      "need ui.tray",
    );
    await m.call({ window: "data:,w" });
    assertEquals(m.windowIcons, ["data:,w"]);
    assertEquals((await m.state() as { tray: string }).tray, "off");
  } finally {
    m.done();
  }
});

Deno.test("main: what was set before the tray existed is on it when it appears", async () => {
  const m = runMain(true);
  try {
    // Before the tray's async creation has run.
    await m.call({ tray: "data:,early", tooltip: "early" });
    await tick();
    assertEquals(m.trayIcons, [["new", "data:,base"], "data:,early"]);
    assertEquals(m.tips.at(-1), "early");
  } finally {
    m.done();
  }
});

// ── the page's calls (both shells' preloads) ─────────────────────────────

function runPreload(code: string, fetchImpl: (u: string) => Promise<Response>) {
  const invoked: unknown[][] = [];
  // deno-lint-ignore no-explicit-any
  const win: any = {};
  const electron = {
    ipcRenderer: {
      send: () => {},
      on: () => {},
      invoke: (...a: unknown[]) => (
        invoked.push(a),
          Promise.resolve(
            (a[1] as { tooltip?: string })?.tooltip === "REFUSE"
              ? { error: "refused by main" }
              : { state: "ok" },
          )
      ),
    },
    contextBridge: {
      exposeInMainWorld: (k: string, v: unknown) => (win[k] = v),
      executeInMainWorld: () => {},
    },
  };
  new Function(
    "require",
    "window",
    "document",
    "MutationObserver",
    "fetch",
    code,
  )(
    () => electron,
    win,
    { addEventListener: () => {}, getElementById: () => null },
    class {
      observe() {}
      disconnect() {}
    },
    fetchImpl,
  );
  return { w: win.__aioWindow, invoked };
}

Deno.test("page: both shells' __aioWindow carry the icon calls; an app URL is fetched by the page", async () => {
  for (
    const code of [shellBridgePreload({ standalone: true }), udsPreloadScript()]
  ) {
    const fetched: string[] = [];
    const { w, invoked } = runPreload(code, (u) => {
      fetched.push(u);
      return Promise.resolve(
        u === "/missing.png"
          ? new Response("", { status: 404 })
          : new Response(new Uint8Array([1, 2])),
      );
    });
    assertEquals(await w.setIcon("/w.png"), "ok");
    await w.setTrayIcon("data:,t");
    await w.animateTrayIcon(["data:,a", "data:,b"], 6);
    await w.animateIcon(["data:,a", "data:,b"]);
    await w.setTrayTooltip("busy");
    await w.icon({ tooltip: null });
    await w.iconState();
    assertEquals(fetched, ["/w.png"]);
    assertEquals(invoked, [
      ["__aio:icon", { window: [new Uint8Array([1, 2])] }],
      ["__aio:icon", { tray: ["data:,t"] }],
      ["__aio:icon", { tray: ["data:,a", "data:,b"], fps: 6 }],
      ["__aio:icon", { window: ["data:,a", "data:,b"], fps: undefined }],
      ["__aio:icon", { tooltip: "busy" }],
      ["__aio:icon", { tooltip: null }],
      ["__aio:iconState"],
    ]);
    await assertRejects(() => w.setIcon("/missing.png"), Error, "HTTP 404");
    await assertRejects(() => w.icon({ tray: [] }), Error, "empty frame list");
    assertEquals(invoked.length, 7, "a refused call reaches nothing");
    await assertRejects(
      () => w.setTrayTooltip("REFUSE"),
      Error,
      "refused by main",
    );
  }
});
