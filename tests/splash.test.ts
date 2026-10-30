// build.splash — the native splash: the resolver, the pure lifetime, the
// helpers' scripts and arguments, the session, and the launch under it.
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@^1.0.0";
import { join } from "@std/path";
import {
  overTextColor,
  resolveSplash,
  sourceSplash,
  SPLASH_MAX_BYTES,
} from "../src/build/splash.ts";
import { pngFromRgba } from "../src/build/app-icon.ts";
import { decodePngSync } from "../src/build/png-scale.ts";
import { gtkSplashLayout } from "../src/electron/gtk-splash.ts";
import { electronSplashPage } from "../src/electron/electron-splash.ts";
import {
  boundsFromState,
  fitRect,
  roundedRows,
  splashFrame,
  splashOrigin,
} from "../src/electron/splash-place.ts";
import { webSplash } from "../src/build/web-splash.ts";
import { _splashKotlin } from "../src/build/build-android.ts";
import { appIdentityColors } from "../src/build/app-theme.ts";
import {
  bakedSplash,
  BAR_PT,
  helperLook,
  lookOf,
  SPLASH_CAP_MS,
  type SplashEvent,
  splashHasText,
  splashNotDrawn,
  splashOpened,
  type SplashSpec,
  type SplashState,
  splashStep,
  splashText,
  splashWithVersion,
  targetSplash,
  withRunTimeShow,
} from "../src/electron/splash.ts";
import {
  linuxSplash,
  MAC_PROGRESS_JXA,
  MAC_SPLASH_JXA,
  macSplashArgs,
  type ProgressDialog,
  splashBackend,
  type SplashOpener,
  WINDOWS_SPLASH_PS,
  windowsSplashEnv,
  yadSplash,
} from "../src/electron/runtime-dialog.ts";
import { splashSession } from "../src/electron/splash-session.ts";
import {
  forwardStderr,
  runUnderSplash,
} from "../src/electron/electron-spawn.ts";
import { electronMainScript } from "../src/electron/electron-scripts.ts";
import { electronMainScriptUDS } from "../src/electron/electron-uds.ts";
import {
  formatRendererLine,
  mountLine,
} from "../src/electron/electron-renderer-log.ts";
import { sharedRuntimeForStart } from "../src/electron/shared-runtime.ts";
import { ELECTRON_VERSION_FILE } from "../src/electron/electron-runtime-fetch.ts";
import {
  VALID_BUILD_KEYS,
  VALID_FEATURES_CONFIG_KEYS,
  validateConfig,
} from "../src/server/config.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

/** A PNG header pngSize reads: signature + IHDR with w × h. */
function png(w: number, h: number, pad = 0): Uint8Array {
  const b = new Uint8Array(33 + pad);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  const v = new DataView(b.buffer);
  v.setUint32(16, w);
  v.setUint32(20, h);
  return b;
}

const files: Record<string, Uint8Array> = {
  "/p/assets/splash.png": png(480, 300),
  "/p/assets/splash@2x.png": png(960, 600),
  "/p/assets/big.png": png(10, 10, SPLASH_MAX_BYTES),
  "/p/assets/huge.png": png(2560, 1440),
  "/p/assets/huge@2x.png": png(2560, 1440),
  "/p/assets/not.png": new TextEncoder().encode("GIF89a……………………………………"),
};
const ctx = {
  root: "/p",
  appId: "com.example.notes",
  // The resolver resolves with the host's rules: `C:\p\assets\…` on Windows.
  read: (p: string) =>
    files[p.replace(/^[A-Za-z]:/, "").replaceAll("\\", "/")] ?? null,
};
const resolveOf = (splash: unknown) =>
  resolveSplash({ build: { splash } }, ctx);
const spec = (splash: unknown): SplashSpec => {
  const r = resolveOf(splash);
  if ("error" in r) throw new Error(r.error);
  return r.splash!;
};
const err = (splash: unknown): string => {
  const r = resolveOf(splash);
  assert("error" in r, `expected a refusal for ${JSON.stringify(splash)}`);
  return r.error;
};

// ── the config ─────────────────────────────────────────────────────────────

const warned = (splash: unknown) => {
  const said: string[] = [];
  const r = resolveSplash({ build: { splash } }, {
    ...ctx,
    warn: (m) => said.push(m),
  });
  assert(!("error" in r), JSON.stringify(r));
  return { s: r.splash!, said };
};

Deno.test("splash config: textPosition none with an explicit text/downloadText is kept, and SAID by name — never dropped quietly", () => {
  const a = warned({
    image: "assets/splash.png",
    textPosition: "none",
    text: "Hello",
    downloadText: "Fetching {pct}%",
  });
  assertEquals(a.s.text, null);
  assertEquals(a.said.length, 1);
  assertStringIncludes(a.said[0]!, 'build.splash.textPosition is "none"');
  assertStringIncludes(a.said[0]!, "text and downloadText are never shown");
  assertEquals(
    warned({ image: "assets/splash.png", textPosition: "none" }).said,
    [],
  );
  assertEquals(
    warned({ image: "assets/splash.png", textPosition: "none", text: false })
      .said,
    [],
  );
});

Deno.test("splash: an image larger than the screen is fitted (aspect kept), said at build; @2x halved first; an explicit size is the app's", () => {
  const big = warned({ image: "assets/huge.png" });
  const L = helperLook(big.s, "linux");
  assertEquals([L.sized, L.w, L.h], [true, 1092, 614]);
  assertEquals([L.iw, L.ih], [2560, 1440]);
  assertEquals(big.said.length, 1);
  assertStringIncludes(big.said[0]!, "2560×1440 logical px");
  // yad draws the image at its pixel size (docs/build/targets.md).
  assertStringIncludes(big.said[0]!, "(not by the yad fallback)");
  const page = electronSplashPage(big.s, "N", "windows");
  assertEquals(page.w, 1092);
  // @2x: 1280×720 logical — still over the box, said in logical px.
  const half = warned({ image: "assets/huge@2x.png" });
  assertStringIncludes(half.said[0]!, "1280×720 logical px");
  const H = helperLook(half.s, "linux");
  assertEquals([H.sized, H.w, H.h, H.iw], [true, 1092, 614, 1280]);
  const sized = warned({
    image: "assets/huge.png",
    size: { width: 2000, height: 1000 },
  });
  assertEquals(sized.said, []);
  assertEquals(helperLook(sized.s, "linux").w, 2000);
  // An ordinary image is untouched.
  const S = helperLook(spec({ image: "assets/splash.png" }), "linux");
  assertEquals([S.sized, S.w, S.h], [false, 480, 300]);
});

Deno.test("splash config: absent or false is none; the image alone takes every default from the app's identity", () => {
  assertEquals(resolveSplash({}, ctx), { splash: null });
  assertEquals(resolveOf(false), { splash: null });
  assert(VALID_BUILD_KEYS.has("splash"));
  assert(!VALID_BUILD_KEYS.has("startWindow"));
  const s = spec({ image: "assets/splash.png" });
  const id = appIdentityColors(ctx.appId);
  assertEquals(s.image.w, 480);
  assertEquals(s.image.h, 300);
  assertEquals(s.image.scale, 1);
  // 1.0.23's defaults: the title, and the download's own line while
  // Electron downloads.
  assertEquals(s.text, "{title}");
  assertEquals(s.downloadText, "Getting {title} ready · {got} of {total} MB");
  assertEquals(s.look!.radius, 8);
  assertEquals(s.look!.align, null); // not set: centred by every helper
  assertEquals(helperLook(s, "windows").align, "center");
  assertEquals(helperLook(s, "darwin").fadeMs, 200);
  // The bar (and its ✕) while Electron downloads.
  assertEquals(s.progress, true);
  assertEquals(s.minMs, 1000);
  assertEquals(s.font, { family: null, size: 13, weight: "bold" });
  assertEquals(s.bar, "solid");
  // The text over the image reads on the image (this fixture is a bare
  // header that cannot be decoded: white); the rest is the identity's.
  assertEquals(s.light, {
    background: id.light.background,
    text: "#ffffff",
    bar: id.light.accent,
    track: id.light.track,
  });
  assertEquals(s.dark.text, "#ffffff");
  // Below the image, the text is on the strip: the identity's text colour.
  const below = spec({ image: "assets/splash.png", textPosition: "below" });
  assertEquals(below.light.text, id.light.text);
  assertEquals(below.dark.text, id.dark.text);
  assertEquals(
    atob(s.image.png).length,
    files["/p/assets/splash.png"]!.length,
  );
});

Deno.test("splash config: the default text colour reads on the image's lower part — white on a dark one, near-black on a light one; a set colour, or text below the image, is not measured", async () => {
  // Top half light, lower half dark — and the reverse.
  const two = (top: number, low: number) => {
    const w = 40, h = 30, px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      px.fill(i < (w * h) / 2 ? top : low, i * 4, i * 4 + 3);
      px[i * 4 + 3] = 255;
    }
    return pngFromRgba(px, w, h);
  };
  const dark = await two(240, 20), light = await two(20, 235);
  const f: Record<string, Uint8Array> = {
    ...files,
    "/p/d.png": dark,
    "/p/l.png": light,
  };
  const of = (splash: unknown) => {
    const r = resolveSplash({ build: { splash } }, {
      ...ctx,
      read: (p) => f[p.replace(/^[A-Za-z]:/, "").replaceAll("\\", "/")] ?? null,
    });
    if ("error" in r) throw new Error(r.error);
    return r.splash!;
  };
  assertEquals([
    of({ image: "d.png" }).light.text,
    of({ image: "d.png" }).dark.text,
  ], ["#ffffff", "#ffffff"]);
  assertEquals([
    of({ image: "l.png" }).light.text,
    of({ image: "l.png" }).dark.text,
  ], ["#111111", "#111111"]);
  assertEquals(of({ image: "l.png", color: "#ff0000" }).light.text, "#ff0000");
  const id = appIdentityColors(ctx.appId);
  assertEquals(
    of({ image: "l.png", textPosition: "below" }).light.text,
    id.light.text,
  );
  // The sync decode is the async one's pixels; a transparent image is
  // measured over the background it is drawn on.
  assertEquals((decodePngSync(dark) as { rgba: Uint8Array }).rgba[0], 240);
  const clear = await pngFromRgba(new Uint8Array(4 * 4 * 4), 4, 4);
  assertEquals(overTextColor(decodePngSync(clear), "#000000"), "#ffffff");
  assertEquals(overTextColor(decodePngSync(clear), "#ffffff"), "#111111");
  assertEquals(overTextColor("not a PNG", "#ffffff"), "#ffffff");
});

Deno.test("splash config: an @2x image is drawn at half its pixels; set colours are the same in both modes", () => {
  const s = spec({
    image: "assets/splash@2x.png",
    text: "Starting {title}…",
    progress: true,
    minMs: 0,
    font: { family: "Georgia", size: 18, weight: "normal" },
    color: "#ffffff",
    bar: { style: "thin", color: "#ff0000", track: "#000000" },
  });
  assertEquals(s.image.scale, 2);
  assertEquals(s.text, "Starting {title}…");
  assertEquals(s.minMs, 0);
  assertEquals(s.font, { family: "Georgia", size: 18, weight: "normal" });
  assertEquals(s.bar, "thin");
  for (const m of [s.light, s.dark]) {
    assertEquals([m.text, m.bar, m.track], ["#ffffff", "#ff0000", "#000000"]);
  }
  assertEquals(spec({ image: "assets/splash.png", text: false }).text, null);
});

Deno.test("splash config: every bad value is refused by its key, with the fix", () => {
  const img = "assets/splash.png";
  assertStringIncludes(err(true), "must be false (no splash) or");
  assertStringIncludes(err({}), "build.splash.image is undefined");
  assertStringIncludes(err({ image: "nope.png" }), "which is not there");
  assertStringIncludes(err({ image: "assets/not.png" }), "is not a PNG");
  assertStringIncludes(err({ image: "assets/big.png" }), "under 1 MB");
  assertStringIncludes(
    err({ image: img, heading: "x" }),
    "build.splash.heading is not a key aio reads",
  );
  assertStringIncludes(err({ image: img, text: "" }), "non-empty string");
  assertStringIncludes(err({ image: img, text: "{name}" }), "{name}");
  assertStringIncludes(err({ image: img, progress: 1 }), "progress is 1");
  assertStringIncludes(err({ image: img, minMs: -1 }), "0 to 10000");
  assertStringIncludes(err({ image: img, minMs: 1.5 }), "0 to 10000");
  assertStringIncludes(err({ image: img, color: "red" }), '"#rrggbb"');
  assertStringIncludes(err({ image: img, font: { size: 4 } }), "8 to 48");
  assertStringIncludes(err({ image: img, font: { weight: 700 } }), '"bold"');
  assertStringIncludes(
    err({ image: img, font: { family: "" } }),
    "font.family",
  );
  assertStringIncludes(err({ image: img, font: { x: 1 } }), "font.x");
  assertStringIncludes(err({ image: img, bar: { style: "fat" } }), '"thin"');
  assertStringIncludes(
    err({ image: img, bar: { color: "#fff" } }),
    "bar.color",
  );
  assertStringIncludes(err({ image: img, bar: { x: 1 } }), "bar.x");
});

Deno.test("splash text: the placeholders, MB, and ? while the size is unknown", () => {
  assertEquals(splashText("Starting {title}…", "Notes"), "Starting Notes…");
  assertEquals(
    splashText("{got} / {total} MB ({pct}%)", "N", 45e6, 110e6),
    "45 / 110 MB (40%)",
  );
  assertEquals(splashText("{got} / {total} ({pct})", "N", 5e6, 0), "5 / ? (?)");
  // A key on Object.prototype is not a placeholder.
  assertEquals(splashText("{constructor}", "N"), "{constructor}");
});

// ── the lifetime ───────────────────────────────────────────────────────────

const O = { minMs: 1000, capMs: 30_000 };
const run = (events: SplashEvent[], s: SplashState = splashOpened(0)) =>
  events.reduce((st, e) => splashStep(st, e, O), s);

const at = (s: SplashState) => s.closed;

Deno.test("splash lifetime: ready after minMs — the splash goes at ready", () => {
  assertEquals(
    at(run([{ type: "shown", at: 100 }, { type: "ready", at: 1200 }])),
    "ready",
  );
});

Deno.test("splash lifetime: ready before minMs — the splash stays until minMs after it APPEARED; the app's window is not held for it", () => {
  const early = run([{ type: "shown", at: 100 }, { type: "ready", at: 300 }]);
  // Two timelines: the app is ready (its window shows now), the splash stays.
  assertEquals(early.readyAt, 300);
  assertEquals(at(early), null);
  assertEquals(at(run([{ type: "tick", at: 1099 }], early)), null);
  assertEquals(at(run([{ type: "tick", at: 1100 }], early)), "ready");
});

Deno.test("splash lifetime: ready before the splash is visible — there is nothing to cover any more, it goes at once", () => {
  assertEquals(at(run([{ type: "ready", at: 10 }])), "ready");
  // …and a late ack changes nothing.
  assertEquals(
    at(run([{ type: "ready", at: 10 }, { type: "shown", at: 650 }])),
    "ready",
  );
});

Deno.test("splash lifetime: a lost helper (never visible) stays lost, ready or not", () => {
  assertEquals(at(run([{ type: "lost" }, { type: "ready", at: 300 }])), "lost");
  assertEquals(at(run([{ type: "lost" }])), "lost");
});

Deno.test("splash lifetime: exit, shutdown, a dismissal, a failed download and a lost helper close it at once; a closed one stays closed", () => {
  for (
    const t of ["exit", "shutdown", "dismissed", "failed", "lost"] as const
  ) {
    const s = run([{ type: "shown", at: 0 }, { type: t }]);
    assertEquals(at(s), t);
    assertEquals(at(run([{ type: "ready", at: 5000 }], s)), t);
    assertEquals(at(run([{ type: "tick", at: 90_000 }], s)), t);
  }
});

Deno.test("splash lifetime: the cap closes it without a ready signal, never during a download, and counts from the download's end", () => {
  assertEquals(run([{ type: "tick", at: 29_999 }]).closed, null);
  assertEquals(run([{ type: "tick", at: 30_000 }]).closed, "cap");
  const dl = run([
    { type: "shown", at: 0 },
    { type: "download", on: true, at: 10 },
    { type: "tick", at: 120_000 },
  ]);
  assertEquals(dl.closed, null);
  const after = run([{ type: "download", on: false, at: 120_000 }], dl);
  assertEquals(run([{ type: "tick", at: 149_999 }], after).closed, null);
  assertEquals(run([{ type: "tick", at: 150_000 }], after).closed, "cap");
  assertEquals(SPLASH_CAP_MS, 30_000);
  // A ready signal after the cap leaves it closed as the cap closed it.
  const capped = run([{ type: "tick", at: 30_000 }]);
  assertEquals(at(run([{ type: "ready", at: 31_000 }], capped)), "cap");
});

Deno.test("splash: nothing holds the app's window for the splash — both shells show it when its page has painted, with no splash hold in them", () => {
  for (
    const src of [
      electronMainScript("http://127.0.0.1:1/"),
      electronMainScriptUDS("aio://app/", "/tmp/x.sock", {}),
    ]
  ) {
    new Function("require", "process", src); // parses
    assertStringIncludes(src, "const win = new BrowserWindow(b);");
    assertStringIncludes(
      src,
      "win.once('ready-to-show', () => __aioShow(false));",
    );
    for (const k of ["AIO_SPLASH", "__aioHold", "splashHold"]) {
      assert(!src.includes(k), k);
    }
  }
});

// ── the helpers ────────────────────────────────────────────────────────────

const full = spec({
  image: "assets/splash@2x.png",
  text: "{got} of {total} MB",
  progress: true,
  font: { family: "Georgia", size: 15 },
  bar: { style: "thin" },
});
// Image only (`text: false`): no label, no bar.
const plain = spec({
  image: "assets/splash.png",
  text: false,
  progress: false,
});
const a = {
  title: "Notes",
  text: "0 of ? MB",
  image: "/t/splash@2x.png",
  file: "/t/progress",
  ack: "/t/shown",
};

Deno.test("splash helpers: the macOS script parses, reads every argument it is given, and neither JXA script uses registerSubclass (it hangs on macOS 14)", () => {
  new Function(MAC_SPLASH_JXA); // parses
  assert(!MAC_SPLASH_JXA.includes("registerSubclass("));
  assert(!MAC_PROGRESS_JXA.includes("registerSubclass("));
  const argv = macSplashArgs(full, a);
  assertEquals(argv.length, 16);
  assertStringIncludes(MAC_SPLASH_JXA, `argv[${argv.length - 1}]`);
  assertEquals(argv.slice(1, 3), ["0 of ? MB", "1"]);
  assertEquals(argv[9], "2");
  assertEquals(argv[10], "Georgia");
  assertEquals(argv[13], String(BAR_PT.thin));
  assertEquals(macSplashArgs(plain, a)[2], "0");
  assertEquals(macSplashArgs(plain, a)[13], "0"); // no progress → no bar
  for (
    const k of [
      "setActivationPolicy",
      "orderFrontRegardless",
      "alphaValue",
      "NSShadow",
    ]
  ) {
    assertStringIncludes(MAC_SPLASH_JXA, k);
  }
});

Deno.test("splash helpers: the Windows script reads exactly the variables it is given, is borderless, on top, off the taskbar, and fades", () => {
  const env = windowsSplashEnv(full, a);
  const read = new Set(
    [...WINDOWS_SPLASH_PS.matchAll(/\$env:(AIO_SPL_\w+)/g)].map((m) => m[1]!),
  );
  assertEquals([...read].sort(), Object.keys(env).sort());
  assertEquals(env.AIO_SPL_BAR, String(BAR_PT.thin));
  assertEquals(env.AIO_SPL_SCALE, "2");
  assertEquals(windowsSplashEnv(plain, a).AIO_SPL_BAR, "0");
  assertEquals(windowsSplashEnv(plain, a).AIO_SPL_HASTEXT, "0");
  for (
    const k of [
      "FormBorderStyle = 'None'",
      "ShowInTaskbar = $false",
      "TopMost = $true",
      "Opacity",
      "AIO_SPL_ACK",
    ]
  ) assertStringIncludes(WINDOWS_SPLASH_PS, k);
});

Deno.test("splash helpers: a splash closed while its helper was starting is never shown (measured on Windows: a warm start's window loads before PowerShell is up)", () => {
  const ps = WINDOWS_SPLASH_PS;
  const psCheck = ps.indexOf("-eq 'close') { exit 0 }");
  assert(
    psCheck > 0 &&
      psCheck < ps.indexOf("[System.Windows.Forms.Application]::Run($f)"),
  );
  const js = MAC_SPLASH_JXA;
  const jsCheck = js.indexOf("pre.js === 'close') $.exit(0)");
  assert(jsCheck > 0 && jsCheck < js.indexOf("win.orderFrontRegardless"));
});

Deno.test("splash helpers: above the app's window, never the focus — Windows: TopMost, shown without activation (measured on w11pro: above the later Electron window, WS_EX_NOACTIVATE); macOS: the floating level, ordered front, never activated (measured: layer 3 over Electron's 0, never frontmost)", () => {
  const ps = WINDOWS_SPLASH_PS;
  for (
    const k of [
      "$f = New-Object AioSplashForm",
      "$f.TopMost = $true",
      "protected override bool ShowWithoutActivation { get { return true; } }",
      "p.ExStyle |= 0x08000008", // WS_EX_NOACTIVATE | WS_EX_TOPMOST
    ]
  ) assertStringIncludes(ps, k);
  // ShowDialog activates the window whatever it asks for.
  assert(!ps.includes("ShowDialog"), "the splash is never shown as a dialog");
  const js = MAC_SPLASH_JXA;
  for (
    const k of [
      "NSApplicationActivationPolicyAccessory",
      "win.level = 3;",
      "win.orderFrontRegardless;",
    ]
  ) assertStringIncludes(js, k);
  for (const k of ["activateIgnoringOtherApps", "makeKeyAndOrderFront"]) {
    assert(!js.includes(k), k);
  }
});

const pwsh = (() => {
  for (
    const p of (Deno.env.get("PATH") ?? "").split(
      Deno.build.os === "windows" ? ";" : ":",
    )
  ) {
    for (const n of ["pwsh", "pwsh.exe", "powershell.exe"]) {
      try {
        if (Deno.statSync(join(p, n)).isFile) return join(p, n);
      } catch { /* not here */ }
    }
  }
  return null;
})();

Deno.test({
  name: "splash helpers: the Windows script parses (PowerShell's own parser)",
  ignore: !pwsh,
  async fn() {
    const tmp = await tempDir("splash-ps-");
    try {
      const f = join(tmp, "s.ps1");
      await Deno.writeTextFile(f, WINDOWS_SPLASH_PS);
      const out = await new Deno.Command(pwsh!, {
        args: [
          "-NoProfile",
          "-Command",
          `$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${f}',[ref]$null,[ref]$e);$e.Count`,
        ],
        stdout: "piped",
      }).output();
      assertEquals(new TextDecoder().decode(out.stdout).trim(), "0");
    } finally {
      await dropTempDir(tmp);
    }
  },
});

Deno.test("splash helpers: yad draws the image above the bar and its text, borderless, on top, off the taskbar — the bar is the download's, else it pulses", () => {
  const y = yadSplash(full, a);
  for (
    const k of [
      "--progress",
      "--image=/t/splash@2x.png",
      "--image-on-top",
      "--undecorated",
      "--no-buttons",
      "--skip-taskbar",
      "--on-top",
      "--center",
      "--percentage=0",
    ]
  ) assert(y.args.includes(k), k);
  // yad 0.40 puts a --text BESIDE the image (measured): the text is the bar's,
  // and the bar's text is plain — markup would be shown as typed.
  assert(!y.args.some((x) => x.startsWith("--text=")));
  assertEquals(y.line(0.5, "a & b\nc"), "49\n# a & b c\n");
  assertEquals(y.line(null, "a & b"), "# a & b\n");
  const p = yadSplash(plain, a);
  assert(p.args.includes("--pulsate"));
  assertEquals(p.line(0.5, "x"), "");
});

Deno.test("splash helpers: Linux says in ONE line what was drawn — yad, zenity text only, or nothing", () => {
  assertEquals(linuxSplash({ yad: true, zenity: true }).use, "yad");
  const z = linuxSplash({ yad: false, zenity: true });
  assertEquals(z.use, "zenity");
  assertStringIncludes(z.note, "text");
  const n = linuxSplash({ yad: false, zenity: false });
  assertEquals(n.use, null);
  assertStringIncludes(n.note, "not shown");
  for (const x of [z, n]) assert(!x.note.includes("\n"));
});

/** An X display number with no server: no socket, no lock file. */
function unservedDisplay(): string {
  const taken = (p: string) => {
    try {
      Deno.statSync(p);
      return true;
    } catch {
      return false; // aio-ok: absent is the answer
    }
  };
  for (let n = 4242; n < 5242; n++) {
    if (!taken(`/tmp/.X11-unix/X${n}`) && !taken(`/tmp/.X${n}-lock`)) {
      return `:${n}`;
    }
  }
  throw new Error("no free X display number in :4242–:5241");
}

Deno.test({
  name:
    "splash helpers: Linux without yad — a fake zenity is handed a text-only pulsing window, and the text as it changes",
  ignore: Deno.build.os !== "linux",
  async fn() {
    const tmp = await tempDir("splash-zenity-");
    const old = {
      PATH: Deno.env.get("PATH"),
      DISPLAY: Deno.env.get("DISPLAY"),
      WAYLAND_DISPLAY: Deno.env.get("WAYLAND_DISPLAY"),
    };
    try {
      const bin = join(tmp, "zenity");
      await Deno.writeTextFile(
        bin,
        `#!/bin/sh\nprintf '%s\\n' "$@" > "${tmp}/args"\n/bin/cat > "${tmp}/stdin"\n`,
      );
      await Deno.chmod(bin, 0o755);
      // ONLY the fake: a box with yad installed (in /usr/bin) would pick it.
      Deno.env.set("PATH", tmp);
      // A display nobody serves, and no Wayland: GTK cannot draw, so the
      // helpers are asked. Not a fixed ":99" — CI's Xvfb lives there, and
      // GTK drew on it. The number is the first with no X socket or lock.
      Deno.env.delete("WAYLAND_DISPLAY");
      Deno.env.set("DISPLAY", unservedDisplay());
      const notes: string[] = [];
      const s = spec({ image: "assets/splash.png", text: "Starting {title}…" });
      const opener = await splashBackend(s, { log: (m) => notes.push(m) });
      assertEquals(opener?.name, "zenity splash");
      assertEquals(notes.length, 1);
      assertStringIncludes(notes[0]!, "yad is not installed");
      assertStringIncludes(notes[0]!, "GTK could not draw it (");
      const d = await opener!.open("Notes", "Starting Notes…");
      d.update(null, "Starting Notes…");
      await d.close();
      const args = (await Deno.readTextFile(join(tmp, "args"))).split("\n");
      for (
        const k of [
          "--progress",
          "--pulsate",
          "--no-cancel",
          "--text=Starting Notes…",
        ]
      ) {
        assert(args.includes(k), k);
      }
      assertStringIncludes(
        await Deno.readTextFile(join(tmp, "stdin")),
        "# Starting Notes…\n",
      );
    } finally {
      for (const [k, v] of Object.entries(old)) {
        if (v === undefined) Deno.env.delete(k);
        else Deno.env.set(k, v);
      }
      await dropTempDir(tmp);
    }
  },
});

// ── the session and the launch ─────────────────────────────────────────────

/** A helper that records what it was told; `show()` puts it on screen. */
function fakeOpener() {
  const seen = {
    opened: [] as string[],
    lines: [] as Array<[number | null, string]>,
    closed: 0,
  };
  let show!: () => void, cancel!: () => void;
  const opener: SplashOpener = {
    name: "fake splash",
    open(title, text) {
      seen.opened.push(`${title} | ${text}`);
      const d: ProgressDialog = {
        update: (f, t) => void seen.lines.push([f, t]),
        shown: new Promise<void>((r) => (show = r)),
        cancelled: new Promise<void>((r) => (cancel = r)),
        lost: new Promise<string>(() => {}),
        close: () => (seen.closed++, Promise.resolve()),
      };
      return Promise.resolve(d);
    },
  };
  return { opener, seen, show: () => show(), cancel: () => cancel() };
}

const tickle = () => new Promise((r) => setTimeout(r, 5));

/** The session's tick is unref'd — a splash never keeps the app alive — so a
 *  test that waits on it alone can see its event loop end first: on Windows's
 *  ~15 ms timer grain the tick is not yet due when the loop checks. Held. */
const held = <T>(p: Promise<T>, ms = 5000): Promise<T> => {
  // Keeps the loop alive while `p` settles — and FAILS after `ms` rather than
  // waiting forever: a splash that never closes (a lost ready signal) must be
  // a red test, not a hang (the mutation gate killed one at its ceiling).
  let keep: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    keep = setTimeout(
      () => reject(new Error(`the splash did not settle within ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([p, late]).finally(() => clearTimeout(keep));
};

function session(
  s: SplashSpec,
  f: ReturnType<typeof fakeOpener>,
  clock = { t: 0 },
) {
  const log: string[] = [];
  const ses = splashSession(s, {
    title: "Notes",
    log: { info: (m) => log.push(m), error: (m) => log.push(`! ${m}`) },
    backend: () => Promise.resolve(f.opener),
    now: () => clock.t,
    tickMs: 2,
  });
  return { ses, log, clock };
}

Deno.test("splash session: opened with its text, says when it is visible; a ready signal before minMs keeps the splash (not the app) until minMs has passed", async () => {
  const f = fakeOpener();
  const { ses, log, clock } = session(
    spec({ image: "assets/splash.png", text: "Starting {title}…" }),
    f,
  );
  ses.open();
  await tickle();
  assertEquals(f.seen.opened, ["Notes | Starting Notes…"]);
  clock.t = 40;
  f.show();
  await tickle();
  assert(
    log.some((l) => /visible 40 ms after it was asked for/.test(l)),
    log.join("\n"),
  );
  clock.t = 500;
  ses.ready();
  await tickle();
  assertEquals(f.seen.closed, 0); // the splash stays for minMs…
  // …while the app's window shows now: said once, at the ready signal.
  const said = (l: string) =>
    l.includes("the app is ready 460 ms after the splash appeared") &&
    l.includes("its window shows now");
  assertEquals(log.filter(said).length, 1, log.join("\n"));
  clock.t = 1040;
  assertEquals(await held(ses.closed), "ready");
  assertEquals(f.seen.closed, 1);
  ses.ready();
  await tickle();
  assertEquals(log.filter(said).length, 1, log.join("\n"));
});

Deno.test("splash session: ready before the splash is on screen — it goes at once, and says the app was first", async () => {
  const f = fakeOpener();
  const { ses, log } = session(plain, f);
  ses.open();
  await tickle();
  ses.ready();
  assertEquals(await held(ses.closed), "ready");
  assert(
    log.some((l) =>
      l.includes("the app is ready, before the splash was on screen")
    ),
    log.join("\n"),
  );
});

Deno.test("splash session: a download fills the bar and the text; its end hides the bar; a dismissal is the download's cancel", async () => {
  const f = fakeOpener();
  const { ses } = session(
    spec({
      image: "assets/splash@2x.png",
      text: "{got} of {total} MB",
      downloadText: "{got} of {total} MB",
      progress: true,
    }),
    f,
  );
  ses.open();
  await tickle();
  f.show();
  const d = ses.download()!;
  d.bytes(45e6, 110e6);
  d.update(0.41, "ignored");
  assertEquals(f.seen.lines.at(-1), [0.41, "45 of 110 MB"]);
  await d.close();
  assertEquals(f.seen.lines.at(-1), [null, "45 of 110 MB"]);
  const d2 = ses.download()!;
  f.cancel();
  await d2.cancelled;
  assertEquals(await held(ses.closed), "dismissed");
  assertEquals(ses.download(), null);
});

Deno.test("splash session: no progress → the bar never shows; a failed download closes it before the plain question", async () => {
  const f = fakeOpener();
  const { ses } = session(
    spec({ image: "assets/splash.png", text: "x", progress: false }),
    f,
  );
  ses.open();
  await tickle();
  ses.download()!.update(0.5, "");
  assertEquals(f.seen.lines.at(-1)![0], null);
  ses.fail();
  assertEquals(await held(ses.closed), "failed");
});

Deno.test("splash session: the cap closes it and says so ONCE", async () => {
  const f = fakeOpener();
  const { ses, log, clock } = session(plain, f);
  ses.open();
  await tickle();
  f.show();
  clock.t = SPLASH_CAP_MS;
  assertEquals(await held(ses.closed), "cap");
  await tickle();
  assertEquals(
    log.filter((l) => l.includes("without the main window's ready signal"))
      .length,
    1,
  );
});

Deno.test("splash session: closed while its helper was starting — the window never maps, and the opener's worker is freed", async () => {
  const f = fakeOpener();
  let disposed = 0, letGo!: () => void;
  const up = new Promise<void>((r) => (letGo = r));
  const ses = splashSession(plain, {
    title: "N",
    log: { info: () => {}, error: () => {} },
    backend: async () => {
      await up;
      return { ...f.opener, dispose: () => void disposed++ };
    },
  });
  ses.open();
  ses.exit(); // Electron ended before the helper was up
  assertEquals(await held(ses.closed), "exit");
  letGo();
  await tickle();
  assertEquals(f.seen.opened, []);
  assertEquals(disposed, 1);
});

Deno.test("splash session: no helper on this desktop — lost, quietly (the backend's own line said why)", async () => {
  const log: string[] = [];
  const ses = splashSession(plain, {
    title: "N",
    log: { info: (m) => log.push(m), error: (m) => log.push(m) },
    backend: () => Promise.resolve(null),
  });
  ses.open();
  assertEquals(await held(ses.closed), "lost");
  assertEquals(log, []);
});

const fakeProc = () => {
  let exit!: () => void;
  const status = new Promise<Deno.CommandStatus>((r) =>
    exit = () => r({ success: true, code: 0, signal: null })
  );
  return { proc: { status } as Deno.ChildProcess, exit: () => exit() };
};

Deno.test("launch under the splash: the spawn is never held for the window, and the window's ready signal closes it", async () => {
  const f = fakeOpener();
  const { ses, clock } = session(
    spec({ image: "assets/splash.png", minMs: 0 }),
    f,
  );
  const order: string[] = [];
  const opener = f.opener.open;
  f.opener.open = (t, x) => (order.push("splash"), opener(t, x));
  const p = fakeProc();
  let mounted: (() => void) | undefined;
  const proc = await runUnderSplash(ses, undefined, (onMounted) => {
    order.push("spawn");
    mounted = onMounted;
    return Promise.resolve(p.proc);
  });
  assert(proc === p.proc);
  await tickle();
  // The spawn was not held for the window: the helper opened while it ran.
  assertEquals(order, ["spawn", "splash"]);
  clock.t = 10;
  f.show();
  await tickle();
  clock.t = 20;
  mounted!();
  assertEquals(await held(ses.closed), "ready");
  p.exit();
});

Deno.test("launch under the splash: the open is requested before the launch starts", async () => {
  const calls: string[] = [];
  const fake = {
    open: () => calls.push("open"),
    download: () => null,
    ready: () => {},
    exit: () => calls.push("exit"),
    shutdown: () => calls.push("shutdown"),
    fail: () => {},
    closed: new Promise<never>(() => {}),
  };
  const ctl = new AbortController();
  await runUnderSplash(fake, ctl.signal, () => {
    calls.push("launch");
    return Promise.resolve(null);
  });
  assertEquals(calls, ["open", "launch", "exit"]);
  ctl.abort();
  assertEquals(calls.at(-1), "shutdown");
});

Deno.test("launch under the splash: Electron's exit closes it; no splash is the launch alone", async () => {
  const f = fakeOpener();
  const { ses } = session(plain, f);
  const p = fakeProc();
  await runUnderSplash(ses, undefined, () => Promise.resolve(p.proc));
  p.exit();
  assertEquals(await held(ses.closed), "exit");
  let hooked: unknown = "unset";
  await runUnderSplash(null, undefined, (onMounted) => {
    hooked = onMounted;
    return Promise.resolve(null);
  });
  assertEquals(hooked, undefined);
});

Deno.test("launch under the splash: the window's mount line on Electron's stderr is the ready signal — once, and only that line", async () => {
  const lines = [
    formatRendererLine("info", "page loaded"),
    formatRendererLine("info", mountLine(12)),
  ];
  const proc = new Deno.Command(Deno.execPath(), {
    args: ["eval", `console.error(${JSON.stringify(lines.join("\n"))})`],
    stdout: "null",
    stderr: "piped",
  }).spawn();
  let mounted = 0;
  forwardStderr(proc, () => mounted++);
  await proc.status;
  for (let i = 0; i < 50 && mounted === 0; i++) await tickle();
  assertEquals(mounted, 1);
});

Deno.test("splash: an online start's download is shown IN the splash (no plain window), and a failure closes it before the plain Retry / Quit", async () => {
  const tmp = await tempDir("splash-shared-");
  try {
    const calls: string[] = [];
    const handle = {
      update: () => {},
      bytes: () => {},
      cancelled: new Promise<void>(() => {}),
      lost: new Promise<string>(() => {}),
      close: () => (calls.push("download-end"), Promise.resolve()),
    };
    const fake = {
      open: () => {},
      download: () => (calls.push("download"), handle),
      ready: () => {},
      exit: () => {},
      shutdown: () => {},
      fail: () => void calls.push("fail"),
      closed: new Promise<never>(() => {}),
    };
    const exe = await sharedRuntimeForStart({
      version: "9.9.9",
      slug: "linux-x64",
      execPath: join(tmp, "app"),
      title: "Notes",
      log: { info: () => {}, error: () => {} },
      root: join(tmp, "store"),
      sha256: "0".repeat(64),
      fetch: (() => Promise.reject(new TypeError("offline"))) as typeof fetch,
      dialog: {
        name: "fake",
        progress: () => (
          calls.push("plain-window"), Promise.reject(new Error("x"))
        ),
        ask: () => (calls.push("ask"), Promise.resolve("quit" as const)),
      },
      splash: fake,
    });
    assertEquals(exe, null);
    assertEquals(calls, ["download", "download-end", "fail", "ask"]);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("splash session: a helper that dies before its ack ends the download's handle as LOST (not a cancel)", async () => {
  let give!: (o: null) => void;
  const ses = splashSession(plain, {
    title: "N",
    log: { info: () => {}, error: () => {} },
    backend: () => new Promise((r) => (give = r)),
  });
  ses.open();
  const d = ses.download()!; // asked for within ms — the helper has not acked
  assert(d);
  let cancelled = false;
  d.cancelled.then(() => (cancelled = true));
  give(null);
  assertEquals(await held(ses.closed), "lost");
  const why = await Promise.race([
    d.lost,
    tickle().then(() => "still pending"),
  ]);
  assertStringIncludes(why, "never showed");
  await tickle();
  assertEquals(cancelled, false);
});

Deno.test("splash: an online start whose splash is lost mid-download goes on in the plain progress window, carrying what it showed — said once", async () => {
  const tmp = await tempDir("splash-shared-lost-");
  try {
    const calls: string[] = [];
    const updates: Array<[number | null, string]> = [];
    let lose!: (why: string) => void;
    let plainOpen!: () => void;
    const plainOpened = new Promise<void>((r) => (plainOpen = r));
    const handle = {
      update: () => {},
      bytes: () => {},
      cancelled: new Promise<void>(() => {}),
      lost: new Promise<string>((r) => (lose = r)),
      close: () => (calls.push("splash-end"), Promise.resolve()),
    };
    const fake = {
      open: () => {},
      download: () => (calls.push("download"), handle),
      ready: () => {},
      exit: () => {},
      shutdown: () => {},
      fail: () => void calls.push("fail"),
      closed: new Promise<never>(() => {}),
    };
    const errors: string[] = [];
    const exe = await sharedRuntimeForStart({
      version: "9.9.9",
      slug: "linux-x64",
      execPath: join(tmp, "app"),
      title: "Notes",
      log: { info: () => {}, error: (m) => errors.push(m) },
      root: join(tmp, "store"),
      sha256: "0".repeat(64),
      // The download is under way when the helper dies; it fails once the
      // plain window is up (the test's end, not the point).
      fetch: (() => {
        lose("helper exited 4");
        return plainOpened.then(() => Promise.reject(new TypeError("offline")));
      }) as typeof fetch,
      dialog: {
        name: "fake",
        progress: () => {
          calls.push("plain-window");
          plainOpen();
          return Promise.resolve({
            update: (f: number | null, d: string) => void updates.push([f, d]),
            cancelled: new Promise<void>(() => {}),
            lost: new Promise<string>(() => {}),
            close: () => (calls.push("plain-end"), Promise.resolve()),
          });
        },
        ask: () => (calls.push("ask"), Promise.resolve("quit" as const)),
      },
      splash: fake,
    });
    assertEquals(exe, null);
    assertEquals(calls, [
      "download",
      "plain-window",
      "plain-end",
      "fail",
      "ask",
    ]);
    assertEquals(updates[0], [null, "Looking for Electron 9.9.9…"]);
    assertEquals(
      errors.filter((e) => e.includes("splash could not be shown")).length,
      1,
      errors.join("\n"),
    );
    assertStringIncludes(errors.join("\n"), "helper exited 4");
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("splash: the build's record carries it; a record without it (or none) is no splash", async () => {
  const tmp = await tempDir("splash-baked-");
  try {
    assertEquals(await bakedSplash(tmp), null);
    assertEquals(await bakedSplash(undefined), null);
    const f = join(tmp, ELECTRON_VERSION_FILE);
    await Deno.writeTextFile(f, JSON.stringify({ version: "1.0.0" }));
    assertEquals(await bakedSplash(tmp), null);
    await Deno.writeTextFile(
      f,
      JSON.stringify({ version: "1.0.0", splash: plain }),
    );
    assertEquals(await bakedSplash(tmp), plain);
  } finally {
    await dropTempDir(tmp);
  }
});

// ── {version}, downloadText, the GTK layout, a run from source ────────────

Deno.test("splash config: {version} is a placeholder; downloadText is checked like text and kept only when set", () => {
  const img = "assets/splash.png";
  const s = spec({
    image: img,
    text: "{title} {version}",
    downloadText: "Installing dependencies · {got} of {total} MB",
  });
  assertEquals(s.text, "{title} {version}");
  assertEquals(
    s.downloadText,
    "Installing dependencies · {got} of {total} MB",
  );
  // Left out: the download's own line (1.0.23); text false: none.
  assertEquals(
    spec({ image: img, text: "x" }).downloadText,
    "Getting {title} ready · {got} of {total} MB",
  );
  assert(!("downloadText" in spec({ image: img, text: false })));
  assertStringIncludes(
    err({ image: img, downloadText: "{name}" }),
    "build.splash.downloadText uses {name}",
  );
  assertStringIncludes(
    err({ image: img, text: "{name}" }),
    "{title} {version} {got} {total} {pct}",
  );
  for (const bad of ["", " ", false, 1]) {
    assertStringIncludes(
      err({ image: img, downloadText: bad }),
      "build.splash.downloadText is",
    );
  }
});

Deno.test("splash version: {version} filled in text and downloadText, the run-time placeholders left for splashText", () => {
  const s = splashWithVersion(
    spec({
      image: "assets/splash.png",
      text: "{title} {version}",
      downloadText: "{version}: {got} of {total} MB",
    }),
    "0.1.760",
  );
  assertEquals(s.text, "{title} 0.1.760");
  assertEquals(s.downloadText, "0.1.760: {got} of {total} MB");
  assertEquals(splashText(s.text!, "Risoto"), "Risoto 0.1.760");
  // Image only stays image only; no downloadText stays absent.
  const p = splashWithVersion(plain, "1.2.3");
  assertEquals(p.text, null);
  assert(!("downloadText" in p));
});

Deno.test("splash session: downloadText while a download runs, text before and after it", async () => {
  const f = fakeOpener();
  const { ses } = session(
    spec({
      image: "assets/splash.png",
      text: "Notes 1.0",
      downloadText: "Installing · {got} of {total} MB",
      progress: true,
    }),
    f,
  );
  ses.open();
  await tickle();
  f.show();
  assertEquals(f.seen.opened, ["Notes | Notes 1.0"]);
  const d = ses.download()!;
  assertEquals(f.seen.lines.at(-1), [null, "Installing · 0 of ? MB"]);
  d.bytes(38e6, 92e6);
  d.update(0.41, "ignored");
  assertEquals(f.seen.lines.at(-1), [0.41, "Installing · 38 of 92 MB"]);
  await d.close();
  assertEquals(f.seen.lines.at(-1), [null, "Notes 1.0"]);
  ses.shutdown();
  assertEquals(await held(ses.closed), "shutdown");
});

Deno.test("splash helpers: text false with a downloadText still gets a label — it reads empty until a download runs", () => {
  const s = spec({
    image: "assets/splash.png",
    text: false,
    downloadText: "Installing · {pct} %",
    progress: true,
  });
  assertEquals(s.text, null);
  assert(splashHasText(s));
  assert(!splashHasText(plain));
  assertEquals(windowsSplashEnv(s, a).AIO_SPL_HASTEXT, "1");
  assertEquals(windowsSplashEnv(plain, a).AIO_SPL_HASTEXT, "0");
  assertEquals(macSplashArgs(s, a)[2], "1");
  assertEquals(
    yadSplash(s, a).line(0.5, "Installing · 50 %"),
    "49\n# Installing · 50 %\n",
  );
});

Deno.test("splash helpers: Linux — GTK first; with why it could not, yad, then zenity, then none, in ONE line", () => {
  const g = linuxSplash({ gtk: true, yad: true, zenity: true });
  assertEquals(g.use, "gtk");
  assertStringIncludes(g.note, "drawn by GTK 3");
  const why = "GTK could not open the display :0";
  const y = linuxSplash({ gtk: why, yad: true, zenity: true });
  assertEquals(y.use, "yad");
  assertStringIncludes(y.note, `GTK could not draw it (${why}); drawn by yad`);
  const z = linuxSplash({ gtk: why, yad: false, zenity: true });
  assertEquals(z.use, "zenity");
  assertStringIncludes(z.note, "GTK could not draw it");
  const n = linuxSplash({ gtk: why, yad: false, zenity: false });
  assertEquals(n.use, null);
  assertStringIncludes(n.note, "not shown: GTK could not draw it");
  for (const x of [g, y, z, n]) assert(!x.note.includes("\n"));
});

Deno.test("splash layout: today's numbers by default — the bar 18 px above the bottom, 24 px side gaps, the text 8 px above the bar; @2x halved", () => {
  const L = gtkSplashLayout(full); // @2x 960×600, thin bar
  assertEquals([L.w, L.h, L.bp, L.side, L.bottom], [480, 300, 4, 24, 18]);
  assertEquals(splashFrame(L, 20), {
    TH: 300,
    yb: 300 - 18 - 4,
    bx: 24,
    bw: 480 - 48,
    labelBottom: 300 - 18 - 4 - 8,
  });
  const solid = spec({ image: "assets/splash.png", progress: true });
  assertEquals(gtkSplashLayout(solid).bp, 8); // 6 pt at 96 dpi
  // No bar: the text's bottom is 18 px above the window's.
  assertEquals(splashFrame(gtkSplashLayout(plain), 20).labelBottom, 282);
  // The defaults (1.0.23): centred, a 200 ms fade, 8 px corners; the text's
  // and the window's shadow where the OS draws them (not Windows).
  const w = helperLook(plain, "windows"), m = helperLook(plain, "darwin");
  assertEquals([w.shadow, w.windowShadow, w.fadeMs, w.align], [
    false,
    false,
    200,
    "center",
  ]);
  assertEquals([m.shadow, m.windowShadow, m.radius, m.border], [
    true,
    true,
    8,
    null,
  ]);
  assertEquals(helperLook(plain, "linux").shadow, true);
  assertEquals([w.sized, w.mode, w.cancel, w.barRadius], [
    false,
    "window",
    true,
    null,
  ]);
});

Deno.test("splash layout: size, fit, a strip below, the bar along the bottom edge, the margin and the bar's height", () => {
  const s = spec({
    image: "assets/splash.png", // 480×300
    text: "x",
    progress: true,
    size: { width: 640, height: 360 },
    textPosition: "below",
    margin: 12,
    bar: { height: 5, position: "bottom-edge" },
  });
  const L = gtkSplashLayout(s);
  assertEquals([L.sized, L.w, L.h, L.bp, L.side, L.bottom], [
    true,
    640,
    360,
    5,
    12,
    12,
  ]);
  const f = splashFrame(L, 20);
  // The strip: 8 above the text, the text, the margin under it.
  assertEquals(f.TH, 360 + 8 + 20 + 12);
  assertEquals([f.yb, f.bx, f.bw], [f.TH - 5, 0, 640]);
  assertEquals(f.labelBottom, f.TH - 12);
  // cover fills (cropped), contain shows it whole (centred).
  assertEquals(fitRect(480, 300, 640, 360, "cover"), {
    x: 0,
    y: -20,
    width: 640,
    height: 400,
  });
  assertEquals(fitRect(480, 300, 640, 360, "contain"), {
    x: 32,
    y: 0,
    width: 576,
    height: 360,
  });
  // A rounded shape covers the box exactly once per row.
  const rows = roundedRows(100, 60, 10);
  assertEquals(rows.at(-1), { x: 0, y: 10, width: 100, height: 40 });
  // The corner rows step in (the top row most), the rest span the width.
  assertEquals([rows[0]!.y, rows[0]!.x > 5, rows[1]!.y], [0, true, 59]);
  assert(rows.every((r) => r.x >= 0 && r.x + r.width <= 100));
});

Deno.test("splash place: centred on the app window's saved bounds, fitted to a screen that still exists; else the primary's centre; or the pointer's screen", () => {
  // The owner's two monitors (#39): DP-2 primary, DP-0.8 portrait right.
  const dp2 = { x: 0, y: 392, width: 2560, height: 1440 };
  const dp08 = { x: 2560, y: 0, width: 1440, height: 2560 };
  const screens = [dp2, dp08];
  const saved = boundsFromState(
    '{"x":636,"y":624,"width":1296,"height":939,"declaredWidth":800,"declaredHeight":600}',
    800,
    600,
  );
  const at = (o: Partial<Parameters<typeof splashOrigin>[0]>) =>
    splashOrigin({
      mode: "window",
      target: saved,
      screens,
      primary: dp2,
      pointer: null,
      w: 640,
      h: 360,
      ...o,
    });
  // Centre of the saved window (636+648-320, 624+469.5-180).
  assertEquals(at({}), { x: 964, y: 914 });
  // No saved position: where the window opens, the primary's centre.
  assertEquals(at({ target: null }), { x: 960, y: 932 });
  assertEquals(at({ target: { width: 800, height: 600 } }), { x: 960, y: 932 });
  assertEquals(at({ mode: "primary" }), { x: 960, y: 932 });
  // The pointer's screen, whatever the saved bounds.
  assertEquals(at({ mode: "pointer", pointer: { x: 3000, y: 100 } }), {
    x: 2560 + 720 - 320,
    y: 1280 - 180,
  });
  // A saved window on a screen that is gone: moved into the one it overlaps
  // most, as Electron moves the window itself, then centred on.
  const half = { x: 3500, y: 300, width: 800, height: 600 };
  // (Moved EDGE_MARGIN — 64 — inside DP-0.8's right edge: 4000-64-800.)
  assertEquals(at({ target: half }), { x: 3216, y: 420 });
  // Overlapping none: the first screen, as Electron's own fit picks.
  const gone = { x: 5000, y: 300, width: 800, height: 600 };
  assertEquals(at({ target: gone }), { x: 1776, y: 576 });
  // Kept EDGE_MARGIN inside the screen (an NVIDIA X driver has crashed on a
  // window at its edge, feedback/critical.md); one larger sits at the margin.
  assertEquals(at({ target: { x: 0, y: 392, width: 100, height: 100 } }), {
    x: 64,
    y: 456,
  });
  assertEquals(at({ w: 3000, target: null }), { x: 64, y: 932 });
  // The saved file (the main script's own rule): no position → the size
  // alone; unreadable → the declared size; a declared size that changed wins.
  assertEquals(boundsFromState('{"width":900,"height":700}', 800, 600), {
    width: 800,
    height: 600,
    maximized: false,
  });
  assertEquals(boundsFromState("not json", 800, 600), {
    width: 800,
    height: 600,
    maximized: false,
  });
  assertEquals(
    boundsFromState(
      '{"x":10,"y":20,"width":800,"height":600,"declaredWidth":800,"declaredHeight":600,"maximized":true}',
      1024,
      768,
    ),
    { x: 10, y: 20, width: 1024, height: 768, maximized: true },
  );
});

Deno.test("splash helpers: the look reaches Windows and macOS whole; yad is placed on the saved window", () => {
  const s = spec({
    image: "assets/splash.png",
    text: "x",
    progress: true,
    align: "center",
    radius: 12,
    border: "#102030",
  });
  const t = { x: 100, y: 200, width: 800, height: 600 };
  const win = JSON.parse(
    windowsSplashEnv(s, { ...a, target: t }).AIO_SPL_LOOK!,
  );
  assertEquals([win.align, win.radius, win.border], ["center", 12, "#102030"]);
  assertEquals(win.target, [100, 200, 800, 600]);
  const mac = JSON.parse(macSplashArgs(s, { ...a, target: t })[14]!);
  assertEquals(mac, helperLook(s, "darwin", t));
  assertStringIncludes(MAC_SPLASH_JXA, "JSON.parse(argv[14])");
  for (
    const k of [
      "L.target",
      "L.radius",
      "L.border",
      "L.align",
      "L.cancel",
      "L.fadeMs",
      "L.barEdge",
    ]
  ) {
    assertStringIncludes(WINDOWS_SPLASH_PS, `$${k}`, k);
    assertStringIncludes(MAC_SPLASH_JXA, k, k);
  }
  assertStringIncludes(WINDOWS_SPLASH_PS, "$f.StartPosition = 'Manual'");
  assert(!WINDOWS_SPLASH_PS.includes("CenterScreen"));
  assert(!MAC_SPLASH_JXA.includes("win.center"));
  assert(
    yadSplash(s, { ...a, target: t }).args.includes(
      "--geometry=480x300+260+350",
    ),
  );
  assert(yadSplash(s, a).args.includes("--center"));
});

Deno.test("splash helpers: what a helper cannot draw is named, once, never dropped", () => {
  const none = spec({ image: "assets/splash@2x.png" });
  assertEquals(splashNotDrawn(none, "windows"), []);
  assertEquals(splashNotDrawn(none, "cocoa"), []);
  assertEquals(splashNotDrawn(none, "gtk"), []);
  // yad has no ✕ for the default bar's download.
  assertEquals(splashNotDrawn(none, "yad"), ["the @2x scale", "cancel (no ✕)"]);
  const s = spec({
    image: "assets/splash.png",
    progress: true,
    shadow: true,
    windowShadow: true,
    size: { width: 100, height: 100 },
    radius: 4,
  });
  assertEquals(splashNotDrawn(s, "windows"), ["shadow", "windowShadow"]);
  assertEquals(splashNotDrawn(s, "cocoa"), []);
  assertEquals(splashNotDrawn(s, "gtk"), ["windowShadow"]);
  assertEquals(splashNotDrawn(s, "yad"), [
    "size",
    "shadow",
    "radius",
    "windowShadow",
    "cancel (no ✕)",
  ]);
  assertEquals(splashNotDrawn(s, "web"), ["size", "windowShadow"]);
  assertEquals(splashNotDrawn(s, "android"), [
    "size",
    "shadow",
    "radius",
    "windowShadow",
  ]);
});

Deno.test("splash config: every look key is checked by name; show never is no splash; textPosition none is no text", () => {
  const img = "assets/splash.png";
  for (
    const [k, v, msg] of [
      ["fit", "fill", '"cover" or "contain"'],
      ["position", "center", '"window", "primary" or "pointer"'],
      ["background", "white", '"#rrggbb"'],
      ["textPosition", "top", '"over", "below" or "none"'],
      ["align", "middle", '"left", "center" or "right"'],
      ["margin", -1, "0 to 200"],
      ["shadow", "yes", "true or false"],
      ["radius", 1.5, "0 to 200"],
      ["border", "#fff", '"#rrggbb"'],
      ["windowShadow", 1, "true or false"],
      ["maxMs", 10, "1000 to 600000"],
      ["fadeMs", 5000, "0 to 2000"],
      ["show", "once", '"always", "firstStart" or "never"'],
      ["cancel", "no", "true or false"],
      ["followWindow", "yes", "true or false"],
      ["size", 640, '{ "width": 640, "height": 360 }'],
    ] as const
  ) {
    assertStringIncludes(
      err({ image: img, [k]: v }),
      `build.splash.${k} is`,
      k,
    );
    assertStringIncludes(err({ image: img, [k]: v }), msg, k);
  }
  assertStringIncludes(
    err({ image: img, size: { width: 640 } }),
    "size.height is missing",
  );
  assertStringIncludes(
    err({ image: img, size: { w: 1, h: 1 } }),
    "size.w is not a key",
  );
  assertStringIncludes(err({ image: img, bar: { height: 0 } }), "bar.height");
  assertStringIncludes(
    err({ image: img, bar: { position: "top" } }),
    "bar.position",
  );
  assertStringIncludes(err({ image: img, bar: { radius: 99 } }), "bar.radius");
  assertStringIncludes(
    err({ image: img, minMs: 3000, maxMs: 2000 }),
    "under minMs",
  );
  assertEquals(resolveOf({ image: img, show: "never" }), { splash: null });
  // A typo is refused even when the splash is off.
  assertStringIncludes(
    err({ image: img, show: "never", fitt: "cover" }),
    "fitt",
  );
  const n = spec({
    image: img,
    text: "x",
    downloadText: "y",
    textPosition: "none",
  });
  assertEquals([n.text, n.downloadText], [null, undefined]);
  const b = spec({ image: img, background: "#123456" });
  assertEquals([b.light.background, b.dark.background], ["#123456", "#123456"]);
  // A spec an earlier aio baked (no look) looks as it did then: square,
  // left-aligned, the 100 ms fade.
  const { look: _l, ...old } = plain;
  assertEquals(lookOf(old as SplashSpec), {
    ...plain.look!,
    radius: 0,
    align: "left",
    fadeMs: 100,
  });
});

Deno.test("splash session: show firstStart opens only when a download starts — without one, the window shows at once", async () => {
  const s = spec({
    image: "assets/splash.png",
    text: "x",
    downloadText: "x",
    show: "firstStart",
  });
  const f = fakeOpener();
  const { ses, log } = session(s, f);
  ses.open();
  await tickle();
  assertEquals(f.seen.opened, []);
  ses.ready();
  assertEquals(await held(ses.closed), "ready");
  assert(
    log.some((l) => l.includes('not shown (show: "firstStart", no download)')),
  );
  const f2 = fakeOpener();
  const two = session(s, f2);
  two.ses.open();
  two.ses.download();
  await tickle();
  assertEquals(f2.seen.opened, ["Notes | x"]);
  two.ses.shutdown();
});

Deno.test("splash: maxMs is the desktop cap, the web's and Android's; fadeMs their fade", () => {
  const s = spec({
    image: "assets/splash.png",
    text: "x",
    maxMs: 5000,
    fadeMs: 400,
  });
  const page = webSplash(s, "Notes");
  assertStringIncludes(page.body, "setTimeout(go,5000)");
  assertStringIncludes(page.head, "transition:opacity 0.4s");
  const today = webSplash(plain, "Notes");
  assertStringIncludes(today.body, `setTimeout(go,${SPLASH_CAP_MS})`);
  assertStringIncludes(today.head, "transition:opacity 0.2s");
  assertStringIncludes(today.body, "},250)");
  const kt = _splashKotlin(s, "Notes", "system");
  assertStringIncludes(kt, ", capMs = 5000L, fadeMs = 400L)");
  assert(!_splashKotlin(plain, "Notes", "system").includes("capMs"));
  assertEquals(
    targetSplash(
      spec({ image: "assets/splash.png", show: "firstStart" }),
      "web",
    ).splash,
    null,
  );
  assertEquals(targetSplash(plain, "android"), { splash: plain, note: null });
});

Deno.test("splash from source: the build's resolver over deno.json, {version} filled — and nothing on dev's automatic restart", () => {
  const config = {
    build: {
      splash: { image: "assets/splash.png", text: "{title} {version}" },
    },
  };
  const at = { ...ctx, version: "0.1.5", restarted: false };
  const r = sourceSplash(config, at);
  assert(!("error" in r));
  assertEquals(r.splash!.text, "{title} 0.1.5");
  assertEquals(
    r.splash,
    splashWithVersion(
      spec({ image: "assets/splash.png", text: "{title} {version}" }),
      "0.1.5",
    ),
  );
  assertEquals(sourceSplash(config, { ...at, restarted: true }), {
    splash: null,
  });
  assertEquals(sourceSplash({}, at), { splash: null });
  assertEquals(sourceSplash(undefined, at), { splash: null });
  const bad = sourceSplash({ build: { splash: { image: "nope.png" } } }, at);
  assert("error" in bad && bad.error.includes("which is not there"));
});

// ── aio.run({ splash: { show } }): the person's say at run time ────────────

Deno.test("splash run-time show: the app's answer replaces the build's show; throws, slow or a wrong value keep the build's, said once", () => {
  const always = spec({ image: "assets/splash.png" });
  const first = spec({ image: "assets/splash.png", show: "firstStart" });
  const said: string[] = [];
  const say = (m: string) => void said.push(m);
  // No hook: the build's spec, untouched, nothing said.
  assertEquals(withRunTimeShow(always, undefined, say), {
    spec: always,
    byApp: false,
  });
  const off = withRunTimeShow(always, () => "firstStart", say);
  assertEquals([lookOf(off.spec).show, off.byApp], ["firstStart", true]);
  assertEquals(lookOf(always).show, "always"); // pure: the input is kept
  const on = withRunTimeShow(first, () => "always", say);
  assertEquals([lookOf(on.spec).show, on.byApp], ["always", true]);
  assertEquals(said, []);
  // A 1.0.22-baked spec (no look) still takes it.
  const { look: _l, ...old } = always;
  assertEquals(
    lookOf(withRunTimeShow(old as SplashSpec, () => "firstStart", say).spec)
      .show,
    "firstStart",
  );
  const kept = (show: () => unknown, now?: () => number) => {
    said.length = 0;
    const r = withRunTimeShow(first, show, say, now);
    assertEquals(r, { spec: first, byApp: false });
    assertEquals(said.length, 1);
    assertStringIncludes(said[0]!, `the build's show ("firstStart") is used`);
    return said[0]!;
  };
  assertStringIncludes(
    kept(() => {
      throw new Error("settings not loaded");
    }),
    "threw (settings not loaded)",
  );
  let t = 0;
  assertStringIncludes(
    kept(() => "always", () => (t += 51)),
    "took 51 ms (over 50 ms)",
  );
  assertStringIncludes(kept(() => "never"), `returned "never"`);
  assertStringIncludes(kept(() => false), "returned false");
  assertStringIncludes(
    kept(() => Promise.resolve("always")),
    "returned [object Promise]",
  );
});

Deno.test("splash run-time show: firstStart from the app shows nothing on a normal start, says so in its own words, and a download still shows the splash", async () => {
  const s = withRunTimeShow(
    spec({ image: "assets/splash.png", text: "x", downloadText: "x" }),
    () => "firstStart",
    () => {},
  ).spec;
  const run = (f: ReturnType<typeof fakeOpener>, electronDraws = false) => {
    const log: string[] = [];
    const ses = splashSession(s, {
      title: "Notes",
      log: { info: (m) => log.push(m), error: (m) => log.push(`! ${m}`) },
      backend: () => Promise.resolve(f.opener),
      tickMs: 2,
      showByApp: true,
      electronDraws,
    });
    return { ses, log };
  };
  const f = fakeOpener();
  const { ses, log } = run(f);
  ses.open();
  await tickle();
  ses.ready();
  assertEquals(await held(ses.closed), "ready");
  assertEquals(f.seen.opened, []);
  assert(
    log.includes(
      `electron: splash — not shown (the app's run-time show: "firstStart")`,
    ),
    log.join("\n"),
  );
  // Windows: Electron's main process does not draw it either.
  const w = run(fakeOpener(), true);
  w.ses.open();
  assertEquals(w.ses.handOff?.(), false);
  w.ses.shutdown();
  // Electron missing: the download runs in the splash, always.
  const f2 = fakeOpener();
  const two = run(f2);
  two.ses.open();
  two.ses.download();
  await tickle();
  assertEquals(f2.seen.opened, ["Notes | x"]);
  two.ses.shutdown();
});

Deno.test("aio.run({ splash }): a wrong type or key is refused at boot, a function is taken", () => {
  const refused = (obj: Record<string, unknown>) => {
    let code: number | null = null;
    const orig = console.error;
    console.error = () => {};
    try {
      validateConfig(
        obj,
        VALID_FEATURES_CONFIG_KEYS,
        "CellsConfig",
        ((c: number) => {
          code = c;
          throw new Error("exit");
        }) as (c: number) => never,
      );
    } catch { /* the exit stub */ }
    console.error = orig;
    return code === 1;
  };
  assert(refused({ splash: { show: "firstStart" } }));
  assert(refused({ splash: { shwo: () => "always" } }));
  assert(refused({ splash: () => "always" }));
  assert(refused({ splash: "firstStart" }));
  assert(!refused({ splash: { show: () => "firstStart" } }));
  assert(!refused({ splash: {} }));
});
