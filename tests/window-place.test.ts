/**
 * ONE placement decider (splash-place.ts): the app's window, the splash, the
 * download window and the Retry / Quit question all open on the same screen,
 * centred on the same rectangle. The Electron main script and the Cocoa
 * helpers run the rule's OWN SOURCE; the Windows Forms helpers carry it in
 * PowerShell. Each copy is evaluated here against the TS rule on the same
 * inputs — the owner's two monitors (DP-2 2560×1440 at +0+392, primary;
 * DP-0.8 1440×2560 at +2560+0), no saved state, a window saved on a monitor
 * that is gone, mixed scale (a 2× screen, in Electron's logical pixels).
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type Bounds,
  boundsFromState,
  centredOn,
  EDGE_MARGIN,
  type Rect,
  splashOrigin,
  windowRect,
} from "../src/electron/splash-place.ts";
import { electronMainScript } from "../src/electron/electron-scripts.ts";
import { electronMainScriptUDS } from "../src/electron/electron-uds.ts";
import {
  MAC_ASK_JXA,
  MAC_PLACE_JS,
  MAC_PROGRESS_JXA,
  MAC_SPLASH_JXA,
  placeArg,
  PS_PLACE,
  WINDOWS_ASK_PS,
  WINDOWS_PROGRESS_PS,
  WINDOWS_SPLASH_PS,
} from "../src/electron/runtime-dialog.ts";

const DP2 = { x: 0, y: 392, width: 2560, height: 1440 };
const DP08 = { x: 2560, y: 0, width: 1440, height: 2560 };
const OWNER = { screens: [DP2, DP08], primary: DP2 };
const SAVED =
  '{"x":636,"y":624,"width":1296,"height":939,"declaredWidth":800,"declaredHeight":600}';

/** Every layout × state the copies are compared on. */
const CASES: {
  name: string;
  screens: Rect[];
  primary: Rect;
  state: string | null;
}[] = [
  { name: "owner, saved on DP-2", ...OWNER, state: SAVED },
  { name: "owner, no saved state", ...OWNER, state: null },
  {
    name: "owner, saved on the portrait DP-0.8",
    ...OWNER,
    state:
      '{"x":2700,"y":900,"width":1000,"height":800,"declaredWidth":800,"declaredHeight":600}',
  },
  {
    name: "saved on a monitor that is gone (DP-0.8 unplugged)",
    screens: [DP2],
    primary: DP2,
    state:
      '{"x":2700,"y":900,"width":1000,"height":800,"declaredWidth":800,"declaredHeight":600}',
  },
  {
    name: "saved half on a gone monitor",
    screens: [DP2],
    primary: DP2,
    state:
      '{"x":2000,"y":500,"width":1000,"height":800,"declaredWidth":800,"declaredHeight":600}',
  },
  {
    name: "mixed scale: a 2× 4K screen right of a 1× one (logical pixels)",
    screens: [{ x: 0, y: 0, width: 1920, height: 1040 }, {
      x: 1920,
      y: 0,
      width: 1920,
      height: 1080,
    }],
    primary: { x: 0, y: 0, width: 1920, height: 1040 },
    state:
      '{"x":2100,"y":100,"width":1200,"height":800,"declaredWidth":800,"declaredHeight":600}',
  },
  {
    name: "a declared size that changed, no position",
    ...OWNER,
    state:
      '{"width":1296,"height":939,"declaredWidth":640,"declaredHeight":480}',
  },
  {
    name: "larger than the screen",
    screens: [{ x: 0, y: 0, width: 1280, height: 720 }],
    primary: { x: 0, y: 0, width: 1280, height: 720 },
    state:
      '{"x":100,"y":50,"width":1600,"height":1000,"declaredWidth":800,"declaredHeight":600}',
  },
  { name: "unreadable state", ...OWNER, state: "{not json" },
];

/** The TS rule: where the window opens. */
const rule = (c: typeof CASES[number]) => {
  const r = windowRect(
    boundsFromState(c.state, 800, 600),
    c.screens,
    c.primary,
  );
  return { x: r.x, y: r.y, width: r.width, height: r.height };
};

Deno.test("window place: the owner's layout — saved window on DP-2 opens there; no state, the primary's centre", () => {
  assertEquals(rule(CASES[0]!), { x: 636, y: 624, width: 1296, height: 939 });
  // 800×600 centred on DP-2's work area.
  assertEquals(rule(CASES[1]!), { x: 880, y: 812, width: 800, height: 600 });
  // Gone: moved into DP-2, the screen it overlaps most (here none: the first),
  // EDGE_MARGIN (64) inside its right edge.
  assertEquals(rule(CASES[3]!), { x: 1496, y: 900, width: 1000, height: 800 });
});

Deno.test("window place: the Electron main script runs the rule's own source — same rectangle on every case, in both shells", () => {
  for (
    const src of [
      electronMainScript("http://127.0.0.1:1/", { title: "x" }),
      electronMainScriptUDS("http://127.0.0.1:1/", "/tmp/x.sock", {
        meta: { title: "x" },
      }),
    ]
  ) {
    for (const c of CASES) {
      // The generated loadBounds, run against this case's displays and file.
      const a = src.indexOf("function boundsFromState(");
      const b = src.indexOf("function saveBounds(win)");
      const body = "let __aioDw, __aioDh, __aioRestoreMax;\n" +
        src.slice(a, b) + "\nreturn loadBounds(800, 600);";
      const got = new Function("fs", "stateFile", "require", "console", body)(
        {
          readFileSync: () => {
            if (c.state === null) throw new Error("ENOENT");
            return c.state;
          },
        },
        "/ud/window-state.json",
        () => ({
          screen: {
            getAllDisplays: () => c.screens.map((workArea) => ({ workArea })),
            getPrimaryDisplay: () => ({ workArea: c.primary }),
          },
        }),
        { warn: () => {} },
      );
      assertEquals(got, rule(c), c.name);
    }
  }
});

/** Cocoa's screens for a layout: frames bottom-up from the primary's
 *  bottom-left, the primary first (the one with the menu bar). */
function fakeCocoa(screens: Rect[], primary: Rect) {
  const ordered = [primary, ...screens.filter((s) => s !== primary)];
  // Electron's origin is the primary's top-left; Cocoa's is its bottom-left.
  const top = primary.y, PH = primary.height;
  const frame = (r: Rect) => ({
    origin: { x: r.x, y: PH - (r.y - top + r.height) },
    size: { width: r.width, height: r.height },
  });
  const ns = ordered.map((r) => ({
    frame: frame(r),
    visibleFrame: frame(r),
  }));
  return {
    NSScreen: {
      screens: { count: ns.length, objectAtIndex: (i: number) => ns[i] },
    },
    NSMakePoint: (x: number, y: number) => ({ x, y }),
    shift: top, // Electron y of the Cocoa primary's top
    PH,
  };
}

Deno.test("window place: the Cocoa helpers run the rule's own source — the splash, the download window and the question land where the TS rule says", () => {
  for (const js of [MAC_SPLASH_JXA, MAC_PROGRESS_JXA, MAC_ASK_JXA]) {
    assertStringIncludes(js, MAC_PLACE_JS);
    assertStringIncludes(js, "aioPlace(");
    assert(!js.includes("win.center"), "Cocoa's own centring");
  }
  for (const c of CASES) {
    // Cocoa's coordinates start at the primary's top-left: shift Electron's.
    const top = c.primary.y;
    const sh = (r: Rect) => ({ ...r, y: r.y - top });
    const $ = fakeCocoa(c.screens.map(sh), sh(c.primary));
    const aioPlace = new Function("$", MAC_PLACE_JS + "\nreturn aioPlace;")(
      $,
    ) as (T: unknown, w: number, h: number) => { x: number; y: number };
    const b = boundsFromState(c.state, 800, 600);
    const T = JSON.parse(
      placeArg({ ...b, ...(b.y === undefined ? {} : { y: b.y - top }) }),
    );
    const want = centredOn(
      windowRect(
        { ...b, ...(b.y === undefined ? {} : { y: b.y - top }) },
        c.screens.map(sh),
        sh(c.primary),
      ),
      460,
      140,
    );
    const got = aioPlace(T, 460, 140);
    assertEquals({ x: got.x, y: $.PH - got.y - 140 }, want, c.name);
  }
});

Deno.test("window place: the Windows helpers carry the rule in PowerShell — splash, download window and question all place by it", () => {
  for (const ps of [WINDOWS_SPLASH_PS, WINDOWS_PROGRESS_PS, WINDOWS_ASK_PS]) {
    assertStringIncludes(ps, PS_PLACE);
    assertStringIncludes(ps, "AioPlace $T");
    assert(!ps.includes("CenterScreen"), "Windows Forms' own centring");
    assert(!ps.includes("MessageBox]::Show"), "a box that places itself");
  }
  assertEquals(placeArg(null), "");
  assertEquals(placeArg({ width: 800, height: 600 }), "[null,null,800,600]");
  assertEquals(
    placeArg({ x: 636, y: 624, width: 1296, height: 939 }),
    "[636,624,1296,939]",
  );
});

/** Where the window REALLY is (a move): centred on it as it is, only its
 *  screen chosen — as Electron's own splash and the GTK one do. */
const onReal = (b: Bounds, c: typeof CASES[number], w: number, h: number) =>
  centredOn(
    {
      x: b.x!,
      y: b.y!,
      width: b.width,
      height: b.height,
      screen: windowRect(b, c.screens, c.primary).screen,
    },
    w,
    h,
  );

Deno.test("window place: a move centres the Cocoa and Windows helpers on where the window really is, never where windowRect would open it", () => {
  // The move ticks pass the real flag.
  assertStringIncludes(
    MAC_SPLASH_JXA,
    "aioPlace(JSON.parse(lastAt), win.frame.size.width, win.frame.size.height, true)",
  );
  assertStringIncludes(
    WINDOWS_SPLASH_PS,
    "AioPlace ($a2 | ConvertFrom-Json) $f.Width $f.Height (AioAll) (AioPrimary) $true",
  );
  let differs = 0;
  for (const c of CASES) {
    const b = boundsFromState(c.state, 800, 600);
    if (b.x === undefined) continue;
    const top = c.primary.y;
    const sh = (r: Rect) => ({ ...r, y: r.y - top });
    const $ = fakeCocoa(c.screens.map(sh), sh(c.primary));
    const aioPlace = new Function("$", MAC_PLACE_JS + "\nreturn aioPlace;")(
      $,
    ) as (T: unknown, w: number, h: number, real?: boolean) => {
      x: number;
      y: number;
    };
    const bs = { ...b, y: b.y! - top };
    const T = JSON.parse(placeArg(bs));
    const want = onReal(
      bs,
      {
        ...c,
        screens: c.screens.map(sh),
        primary: sh(c.primary),
      },
      460,
      140,
    );
    const got = aioPlace(T, 460, 140, true);
    assertEquals({ x: got.x, y: $.PH - got.y - 140 }, want, c.name);
    const open = aioPlace(T, 460, 140);
    if (open.x !== got.x || open.y !== got.y) differs++;
  }
  assert(differs > 0, "a case where the real window is not where it opens");
});

const pwsh = (() => {
  for (const n of ["pwsh", "powershell.exe", "powershell"]) {
    for (const d of (Deno.env.get("PATH") ?? "").split(/[:;]/)) {
      try {
        if (d && Deno.statSync(`${d}/${n}`).isFile) return `${d}/${n}`;
      } catch { /* not here */ }
    }
  }
  return null;
})();

Deno.test({
  name:
    "window place: the PowerShell copy gives the TS rule's origin on every case (run where PowerShell is)",
  // System.Windows.Forms is Windows-only: a PowerShell 7 on Linux (a CI
  // runner ships one) cannot load the assembly the copy runs on.
  ignore: !pwsh || Deno.build.os !== "windows",
  async fn() {
    const rect = (r: Rect) =>
      `(New-Object System.Drawing.Rectangle(${r.x}, ${r.y}, ${r.width}, ${r.height}))`;
    let script = "Add-Type -AssemblyName System.Windows.Forms\n" +
      "Add-Type -AssemblyName System.Drawing\n" + PS_PLACE;
    for (const c of CASES) {
      const b = boundsFromState(c.state, 800, 600);
      const T = placeArg(b);
      script += `$o = AioPlace ('${T}' | ConvertFrom-Json) 460 140 @(${
        c.screens.map(rect).join(", ")
      }) ${rect(c.primary)}\n"$($o[0]),$($o[1])"\n`;
      script += `$o = AioPlace ('${T}' | ConvertFrom-Json) 460 140 @(${
        c.screens.map(rect).join(", ")
      }) ${rect(c.primary)} $true\n"$($o[0]),$($o[1])"\n`;
    }
    const o = await new Deno.Command(pwsh!, {
      args: ["-NoProfile", "-Command", "-"],
      stdin: "piped",
      stdout: "piped",
    }).spawn();
    const w = o.stdin.getWriter();
    // A blank line ends the input: Windows PowerShell 5.1 reading `-Command -`
    // holds a multi-line function until one comes and, at end of input
    // without it, drops the whole script — exit 0, nothing printed (measured
    // on w11pro). The app itself passes scripts with -EncodedCommand.
    await w.write(new TextEncoder().encode(script + "\n\n"));
    await w.close();
    const out = new TextDecoder().decode((await o.output()).stdout).trim()
      .split(/\r?\n/);
    CASES.forEach((c, i) => {
      const r = windowRect(
        boundsFromState(c.state, 800, 600),
        c.screens,
        c.primary,
      );
      const want = centredOn(r, 460, 140);
      assertEquals(out[2 * i], `${want.x},${want.y}`, c.name);
      // A move: where the window really is (no position: where it opens).
      const b = boundsFromState(c.state, 800, 600);
      const real = b.x === undefined ? want : onReal(b, c, 460, 140);
      assertEquals(out[2 * i + 1], `${real.x},${real.y}`, `${c.name} (real)`);
    });
  },
});

Deno.test("window place: the splash centres on the window's rectangle, on its screen", () => {
  for (const c of CASES) {
    const b: Bounds = boundsFromState(c.state, 800, 600);
    const r = windowRect(b, c.screens, c.primary);
    assertEquals(
      splashOrigin({
        mode: "window",
        target: b,
        screens: c.screens,
        primary: c.primary,
        pointer: null,
        w: 480,
        h: 300,
      }),
      centredOn(r, 480, 300),
      c.name,
    );
  }
});

// ── the edge margin: nothing aio places reaches a screen edge ─────────────
// feedback/critical.md: a window placed at x = 0 gets its window-manager
// frame at x = -10 (muffin) or grows its own shadow to x = -16 (frameless
// Electron); an NVIDIA X driver faults on that and can take the desktop
// down. These make an off-screen or non-integer rect unshippable.

/** Every rect the rule returns lies the margin inside its screen, in whole
 *  pixels, at least 1×1. */
function assertInside(r: Rect & { screen: Rect }, what: string) {
  const s = r.screen;
  const mx = Math.min(EDGE_MARGIN, Math.floor(s.width / 8));
  const my = Math.min(EDGE_MARGIN, Math.floor(s.height / 8));
  for (const v of [r.x, r.y, r.width, r.height]) {
    assert(
      Number.isInteger(v),
      `${what}: ${JSON.stringify(r)} has a non-integer`,
    );
  }
  assert(r.width >= 1 && r.height >= 1, `${what}: empty ${JSON.stringify(r)}`);
  assert(
    r.x >= s.x + mx && r.y >= s.y + my &&
      r.x + r.width <= s.x + s.width - mx &&
      r.y + r.height <= s.y + s.height - my,
    `${what}: ${JSON.stringify(r)} is not ${mx}/${my} px inside ${
      JSON.stringify(s)
    }`,
  );
}

Deno.test("window place: EDGE_MARGIN is the literal the emitted functions carry", () => {
  assertEquals(EDGE_MARGIN, 64);
  for (const fn of [windowRect, centredOn]) {
    assertStringIncludes(
      fn.toString(),
      `Math.min(${EDGE_MARGIN}, Math.floor(s.width / 8))`,
    );
    assertStringIncludes(
      fn.toString(),
      `Math.min(${EDGE_MARGIN}, Math.floor(s.height / 8))`,
    );
  }
});

Deno.test("window place: the field states that took the desktop down open inside the margin, maximized", () => {
  // A work area under a desktop panel, and the states three apps had saved
  // when they took the desktop down (x = 0, the whole work area).
  const wa = { x: 0, y: 518, width: 2560, height: 1368 };
  const screens = [wa, { x: 2560, y: 0, width: 1440, height: 2560 }];
  for (
    const state of [
      '{"x":0,"y":518,"width":2560,"height":1368,"declaredWidth":1000,"declaredHeight":780}',
      '{"x":0,"y":518,"width":2560,"height":1368,"declaredWidth":1200,"declaredHeight":820,"maximized":true}',
      '{"x":-10,"y":473,"width":2580,"height":1413,"declaredWidth":800,"declaredHeight":600}',
    ]
  ) {
    const d = JSON.parse(state);
    const r = windowRect(
      boundsFromState(state, d.declaredWidth, d.declaredHeight),
      screens,
      wa,
    );
    assertInside(r, state);
    assertEquals({ x: r.x, y: r.y }, { x: 64, y: 582 }, state);
    assert(
      r.fills,
      `${state}: a window as big as the work area opens maximized`,
    );
  }
  // An ordinary window is not maximized.
  assertEquals(
    windowRect({ width: 800, height: 600 }, screens, wa).fills,
    false,
  );
});

Deno.test("window place: randomized — any input (NaN, Infinity, negative, huge, fractional, odd screens) gives a whole rect inside the margin", () => {
  let seed = 0x2545f491;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)]!;
  const weird = () =>
    pick([
      NaN,
      Infinity,
      -Infinity,
      0,
      -1,
      -10,
      0.5,
      1e9,
      -1e9,
      1e-9,
      Math.round(rnd() * 5000) - 1000,
      rnd() * 3000,
    ]);
  const screen = (): Rect => ({
    x: pick([0, -1920, 1920, 2560, Math.round(rnd() * 4000) - 2000]),
    y: pick([0, -1080, 392, 518, Math.round(rnd() * 3000) - 1000]),
    width: pick([
      1,
      7,
      64,
      200,
      800,
      1366,
      1440,
      2560,
      3840,
      Math.ceil(rnd() * 5000),
    ]),
    height: pick([
      1,
      7,
      64,
      200,
      768,
      1080,
      1440,
      2560,
      Math.ceil(rnd() * 5000),
    ]),
  });
  for (let i = 0; i < 20000; i++) {
    const screens = Array.from({ length: Math.floor(rnd() * 3) }, screen);
    const primary = screens[0] ?? screen();
    const b = {
      width: weird(),
      height: weird(),
      x: rnd() < 0.2 ? undefined : weird(),
      y: weird(),
    };
    const r = windowRect(b as never, screens, primary);
    assertInside(r, `#${i} ${JSON.stringify(b)}`);
    if (r.screen.width >= 16 && r.screen.height >= 16) {
      const w = 1 + Math.floor(rnd() * 600), h = 1 + Math.floor(rnd() * 300);
      const o = centredOn(r, w, h);
      const s = r.screen;
      const mx = Math.min(EDGE_MARGIN, Math.floor(s.width / 8));
      const my = Math.min(EDGE_MARGIN, Math.floor(s.height / 8));
      assert(
        Number.isInteger(o.x) && Number.isInteger(o.y),
        `#${i} centredOn ${JSON.stringify(o)}`,
      );
      assert(
        o.x >= s.x + mx && o.y >= s.y + my,
        `#${i} centredOn ${JSON.stringify(o)} left/above the margin`,
      );
      if (w <= s.width - 2 * mx) {
        assert(o.x + w <= s.x + s.width - mx, `#${i} centredOn right`);
      }
      if (h <= s.height - 2 * my) {
        assert(o.y + h <= s.y + s.height - my, `#${i} centredOn below`);
      }
    }
  }
});

Deno.test("window place: window-state.json is written to a temp file and renamed — a crash never leaves it empty", () => {
  for (
    const src of [
      electronMainScript("http://127.0.0.1:1/", { title: "x" }),
      electronMainScriptUDS("http://127.0.0.1:1/", "/tmp/x.sock", {
        meta: { title: "x" },
      }),
    ]
  ) {
    const a = src.indexOf("function saveBounds(win)");
    const body = src.slice(a, src.indexOf("\n}", a));
    assert(/rename(Sync)?\(tmp, stateFile\)/.test(body), body);
    assert(
      !/writeFile(Sync)?\(stateFile/.test(body),
      `writes the state in place:\n${body}`,
    );
  }
});
