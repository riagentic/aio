/**
 * The Linux splash drawn by aio itself — GTK 3 over FFI on a worker thread
 * (src/electron/gtk-splash.ts). A REAL draw, on the nested test display
 * `:77` only (never the desktop): skipped where there is no libgtk-3, no
 * `:77` of this user's, or no cookie for it.
 *
 * Each case runs in a child process (this file under `deno run`): GTK is
 * initialised once per PROCESS and keeps its display, so a case in the test
 * process would decide every later one — and the child is handed `:77` in
 * its own environment, never this process's.
 *
 * What is checked is what the window IS, from outside it: the X11 hints the
 * window manager reads (`xprop`), and the pixels where the background, the
 * bar and its track must be (`import`, ImageMagick — skipped without it).
 */
import { assert, assertEquals, assertMatch } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { resolveSplash } from "../src/build/splash.ts";
import { pngFromRgba } from "../src/build/app-icon.ts";
import {
  gtkAsk,
  type GtkDialog,
  gtkProgress,
  gtkSplash,
} from "../src/electron/gtk-splash.ts";
import type { SplashSpec } from "../src/electron/splash.ts";
import { identityDialogColors } from "../src/build/app-theme.ts";
import { dialogBackend } from "../src/electron/runtime-dialog.ts";
import {
  AIO_NESTED_DISPLAY,
  displayIsUp,
  displayOwner,
  nestedDisplayCookie,
} from "../src/server/nested-display.ts";

// `$AIO_TEST_DISPLAY` wins, as for every GUI test (src/testing/test-display.ts):
// a run pointed at another display (the GPU lab) must not draw on `:77` — a
// Xephyr that is itself a window on the real desktop.
const EXPLICIT = Deno.env.get("AIO_TEST_DISPLAY") || null;
const D = EXPLICIT ?? AIO_NESTED_DISPLAY;
const linux = Deno.build.os === "linux";
const hasGtk = linux && (() => {
  try {
    Deno.dlopen("libgtk-3.so.0", {}).close();
    return true;
  } catch {
    return false;
  }
})();
const cookie = !linux
  ? null
  : EXPLICIT
  ? Deno.env.get("XAUTHORITY") ?? null
  : nestedDisplayCookie(D);
const ignore = !hasGtk || !cookie ||
  !(EXPLICIT ? displayIsUp(D) : displayOwner(D) === "mine");
/** `bin` is on PATH. */
const onPath = (bin: string) =>
  (Deno.env.get("PATH") ?? "").split(":").some((d) => {
    try {
      return Deno.statSync(join(d, bin)).isFile;
    } catch {
      return false;
    }
  });

/** A fully transparent PNG (what shows through is the splash background),
 *  or one of a single colour. */
async function spec(
  w: number,
  h: number,
  splash: Record<string, unknown>,
  file = "splash.png",
  rgba = [0, 0, 0, 0],
): Promise<SplashSpec> {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < px.length; i += 4) px.set(rgba, i);
  const png = await pngFromRgba(px, w, h);
  const r = resolveSplash({ build: { splash: { image: file, ...splash } } }, {
    root: "/p",
    appId: "com.example.notes",
    read: () => png,
  });
  if ("error" in r) throw new Error(r.error);
  return r.splash!;
}

const within = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([
    p,
    new Promise<never>((_, no) =>
      setTimeout(() => no(new Error(`${what}: not within ${ms} ms`)), ms)
    ),
  ]);

const run = (bin: string, args: string[]) => {
  try {
    const o = new Deno.Command(bin, { args, stdout: "piped", stderr: "null" })
      .outputSync();
    return { ok: o.success, out: new TextDecoder().decode(o.stdout) };
  } catch {
    return null; // not installed
  }
};

/** One screen pixel of the display, `#rrggbb`, or null without ImageMagick. */
const pixel = (x: number, y: number): string | null => {
  const r = run("import", [
    "-window",
    "root",
    "-crop",
    `1x1+${x}+${y}`,
    "-depth",
    "8",
    "txt:-",
  ]);
  return r && (r.out.match(/#[0-9A-Fa-f]{6}/)?.[0] ?? "").toLowerCase();
};

const settle = () => new Promise((r) => setTimeout(r, 300));

/** How many pixels of each colour a screen rectangle holds, or null without
 *  ImageMagick. */
const colours = (
  b: { x: number; y: number; w: number; h: number },
): Map<string, number> | null => {
  const r = run("import", [
    "-window",
    "root",
    "-crop",
    `${b.w}x${b.h}+${b.x}+${b.y}`,
    "-depth",
    "8",
    "txt:-",
  ]);
  if (!r) return null;
  const n = new Map<string, number>();
  for (const m of r.out.matchAll(/ #([0-9A-Fa-f]{6})/g)) {
    const c = `#${m[1]!.toLowerCase()}`;
    n.set(c, (n.get(c) ?? 0) + 1);
  }
  return n;
};

// ── the child: one case, its findings as JSON on stdout ───────────────────

async function child(name: string): Promise<Record<string, unknown>> {
  if (name === "no-display") {
    const t0 = performance.now();
    const o = await gtkSplash(await spec(48, 30, {}));
    return {
      why: "why" in o ? o.why : null,
      ms: Math.round(performance.now() - t0),
    };
  }
  if (name === "contain" || name === "cover") return await looked(name);
  if (name === "above") return await above();
  if (name === "dialogs") return await dialogs();
  if (name === "move") return await moved();
  if (name === "linger") {
    // The app goes on after its splash: closed, then a while of nothing.
    const o = await gtkSplash(await spec(48, 30, {}));
    if ("why" in o) return { why: o.why };
    const d = await o.open("Notes", "Starting Notes…") as GtkDialog;
    await within(d.shown, 5_000, "shown");
    await d.close();
    await new Promise((r) => setTimeout(r, 1_500));
    return { alive: true };
  }
  const s = name === "2x"
    ? await spec(480, 300, { text: false, progress: false }, "splash@2x.png")
    : await spec(480, 300, { text: "Starting {title}…", progress: true });
  const o = await gtkSplash(s);
  if ("why" in o) return { why: o.why };
  const d = await o.open(
    "Notes",
    name === "2x" ? "" : "Starting Notes…",
  ) as GtkDialog;
  let lost = "";
  d.lost.then((w) => (lost = w));
  await within(d.shown, 5_000, "shown");
  const what = await d.what;
  const r: Record<string, unknown> = { what, colors: s.light };
  if (name === "draw") {
    const x = +what.match(/ at=(-?\d+),/)![1]!;
    const y = +what.match(/ at=-?\d+,(-?\d+)/)![1]!;
    const xid = what.match(/ xid=(0x[0-9a-f]+)/)![1]!;
    r.props = run("xprop", ["-id", xid])?.out ?? "";
    d.update(0.5, "Installing · 46 of 92 MB");
    await settle();
    // The bar: 24 px side gaps, its bottom 18 px above the window's.
    const barY = y + 300 - 18 - 4;
    r.bg = pixel(x + 120, y + 100);
    r.fill = pixel(x + 30, barY);
    r.track = pixel(x + 480 - 30, barY);
    d.update(null, "Starting Notes…");
    await settle();
    r.hidden = pixel(x + 30, barY);
    d.update(0.5, "Installing · 46 of 92 MB");
    await settle();
    d.click(); // the ✕, through GTK's "clicked"
    r.cancelled = await within(d.cancelled, 2_000, "cancelled").then(
      () => true,
      () => false,
    );
    await d.close();
    r.gone = !run("xwininfo", ["-id", xid])?.ok;
  } else {
    await d.close();
  }
  r.lost = lost;
  return r;
}

/** The look keys, drawn: `size` with `fit`, the text in a strip below,
 *  centred; the bar along the bottom edge; rounded corners and a border;
 *  no ✕; placed on the app window's saved bounds. */
async function looked(fit: "contain" | "cover") {
  const s = await spec(
    480,
    300,
    {
      text: "Ready",
      progress: true,
      size: { width: 640, height: 360 },
      fit,
      textPosition: "below",
      align: "center",
      radius: 16,
      border: "#ff00ff",
      background: "#202020",
      bar: { position: "bottom-edge", height: 6 },
      cancel: false,
    },
    "splash.png",
    [255, 0, 0, 255],
  );
  const target = { x: 100, y: 100, width: 800, height: 600 };
  const o = await gtkSplash(s, { target });
  if ("why" in o) return { why: o.why };
  const d = await o.open("Notes", "Ready") as GtkDialog;
  let cancelled = false;
  d.cancelled.then(() => (cancelled = true));
  await within(d.shown, 5_000, "shown");
  const what = await d.what;
  const [W, TH] = what.match(/size=(\d+)x(\d+)/)!.slice(1).map(Number) as [
    number,
    number,
  ];
  const x = +what.match(/ at=(-?\d+),/)![1]!;
  const y = +what.match(/ at=-?\d+,(-?\d+)/)![1]!;
  d.update(0.5, "Ready");
  await settle();
  const r = {
    what,
    W,
    TH,
    x,
    y,
    bar: s.light.bar,
    side: pixel(x + 10, y + 100),
    mid: pixel(x + 320, y + 100),
    strip: pixel(x + 100, y + 365),
    edge: pixel(x, y + Math.round(TH / 2)),
    corner: pixel(x + 1, y + 1),
    fill: pixel(x + 40, y + TH - 3),
    cancelled: false,
  };
  d.click(); // there is no ✕: nothing happens
  await new Promise((ok) => setTimeout(ok, 400));
  r.cancelled = cancelled;
  await d.close();
  return r;
}

/** The app's window shows under the splash the moment it is ready: a window
 *  mapped later, over it (no window manager on the test display, so nothing
 *  but the splash itself keeps it above). The pixel under both is the
 *  splash's, once it has re-raised. */
async function above() {
  const s = await spec(480, 300, {}, "splash.png", [255, 0, 0, 255]);
  const o = await gtkSplash(s, {
    target: { x: 100, y: 100, width: 800, height: 600 },
  });
  if ("why" in o) return { why: o.why };
  const d = await o.open("Notes", "") as GtkDialog;
  await within(d.shown, 5_000, "shown");
  const what = await d.what;
  const x = +what.match(/ at=(-?\d+),/)![1]!;
  const y = +what.match(/ at=-?\d+,(-?\d+)/)![1]!;
  let app: Deno.ChildProcess;
  try {
    app = new Deno.Command("xmessage", {
      args: ["-geometry", `600x400+${x - 60}+${y - 50}`, "the app"],
      stdout: "null",
      stderr: "null",
    }).spawn();
  } catch {
    await d.close();
    return { what, skipped: "no xmessage" };
  }
  // Mapped: the app's window is on the display.
  for (let i = 0; i < 50; i++) {
    if (run("xwininfo", ["-name", "xmessage"])?.ok) break;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  await new Promise((ok) => setTimeout(ok, 600));
  const r = { what, under: pixel(x + 240, y + 150), beside: pixel(x - 40, y) };
  await d.close();
  await new Promise((ok) => setTimeout(ok, 300));
  const after = pixel(x + 240, y + 150);
  app.kill();
  await app.status;
  return { ...r, after };
}

/** The download window and the question, drawn by aio over GTK: each
 *  centred on where the app's window opens (a saved window at 100,100
 *  800×600: centre 500,400), the bar filling, the question answering the
 *  button clicked, a closed question answering -1. */
/** The splash opened centred on a saved window at 100,100 800×600, then
 *  told the window really opened at 900,300 640×480: it moves onto that
 *  one's centre (1220,540) — the background there is the splash's. */
async function moved() {
  const s = await spec(240, 150, {}, "splash.png", [255, 0, 0, 255]);
  const o = await gtkSplash(s, {
    target: { x: 100, y: 100, width: 800, height: 600 },
  });
  if ("why" in o) return { why: o.why };
  const d = await o.open("Notes", "") as GtkDialog;
  await within(d.shown, 5_000, "shown");
  const first = await d.what;
  await settle();
  // The new window's centre (800, 450) is well inside any test screen, so the
  // splash lands there whole (EDGE_MARGIN keeps it 64 px off an edge).
  const before = pixel(800, 450);
  d.move?.({ x: 600, y: 300, width: 400, height: 300 });
  await settle();
  const after = pixel(800, 450), old = pixel(500, 400);
  await d.close();
  return { first, before, after, old };
}

async function dialogs() {
  const target = { x: 100, y: 100, width: 800, height: 600 };
  // The app's identity colours, as a start hands them (light: :77 has no
  // dark GTK theme set).
  const colors = identityDialogColors("com.example.notes");
  const box = (what: string) => {
    const [w, h] = what.match(/size=(\d+)x(\d+)/)!.slice(1).map(Number);
    const [x, y] = what.match(/ at=(-?\d+),(-?\d+)/)!.slice(1).map(Number);
    return { x: x!, y: y!, w: w!, h: h! };
  };
  const p = await gtkProgress("Notes", "Getting Notes ready", {
    target,
    colors,
  });
  if ("why" in p) return { why: p.why };
  await within(p.shown, 5_000, "progress shown");
  const pw = await p.what;
  p.update(0.5, "Downloading Electron 9.9.9 — first start only · 46 / 92 MB");
  await settle();
  const seen = colours(box(pw));
  // Its one button, Cancel, cancels.
  let cancelled = false;
  p.cancelled.then(() => (cancelled = true));
  p.click();
  await within(p.cancelled, 5_000, "Cancel");
  await p.close();
  // Through the backend a start uses: the colours reach the window.
  const b = await dialogBackend({ target, colors });
  const bp = b && await b.progress("Notes", "Getting Notes ready");
  bp?.update(0.5, "x");
  await settle();
  // A corner of it, centred on 500,400 at the first one's size.
  const viaBackend = colours({
    x: 500 - Math.floor(box(pw).w / 2) + 4,
    y: 400 - Math.floor(box(pw).h / 2) + 4,
    w: 8,
    h: 8,
  });
  await bp?.close();
  const answers: number[] = [];
  const asked: ReturnType<typeof box>[] = [];
  let askSeen: Map<string, number> | null = null;
  for (const i of [2, 0]) {
    const q = await gtkAsk("Notes", "The download failed.", [
      "Quit",
      "Start the previous version",
      "Retry",
    ], { target, colors });
    if ("why" in q) return { why: q.why };
    await within(q.shown, 5_000, "ask shown");
    asked.push(box(await q.what));
    if (i === 2) {
      await settle(); // shown is mapped; its first paint follows
      askSeen = colours(asked.at(-1)!);
    }
    q.click(i);
    answers.push(await within(q.answer, 5_000, "answer"));
  }
  const top = (m: Map<string, number> | null) =>
    m && [...m].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c]) => c);
  return {
    progress: box(pw),
    asked,
    answers,
    backend: b?.name ?? null,
    colors: colors.light,
    seen: top(seen),
    viaBackend: top(viaBackend),
    askSeen: top(askSeen),
    cancelled,
  };
}

if (import.meta.main) {
  console.log(JSON.stringify(await child(Deno.args[0]!)));
  Deno.exit(0);
}

/** Runs `name` in a child on `display`; its findings. */
async function inChild(
  name: string,
  env: Record<string, string>,
): Promise<Record<string, unknown>> {
  const root = join(fromFileUrl(new URL(".", import.meta.url)), "..");
  const o = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--config",
      join(root, "deno.json"),
      fromFileUrl(import.meta.url),
      name,
    ],
    env: { GDK_BACKEND: "x11", ...env },
    clearEnv: false,
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(60_000),
  }).output();
  const out = new TextDecoder().decode(o.stdout).trim().split("\n").at(-1) ??
    "";
  assert(
    o.success && out.startsWith("{"),
    `child ${name}: ${new TextDecoder().decode(o.stderr)}\n${out}`,
  );
  return JSON.parse(out);
}

/** `:77`, with its cookie — and no Wayland socket to prefer over it. */
const testDisplay = () => ({
  DISPLAY: D,
  XAUTHORITY: cookie!,
  WAYLAND_DISPLAY: "",
});

Deno.test({
  name:
    "GTK splash: a borderless, keep-above, no-taskbar splash window at the image's size, with the text, the bar placed as on Windows/macOS and the spec's colours; the ✕ cancels; close takes it down",
  ignore,
  async fn() {
    const r = await inChild("draw", testDisplay());
    const what = r.what as string;
    assertMatch(what, /size=480x300 scale=1 /);
    assertMatch(what, / text=1 /);
    assertMatch(what, / barpx=8 /); // solid: 6 pt at 96 dpi
    const props = r.props as string;
    if (props) {
      // The hints a window manager reads: a splash, above, out of the
      // taskbar and the pager, no frame (Motif decorations 0).
      assertMatch(
        props,
        /_NET_WM_WINDOW_TYPE\(ATOM\) = _NET_WM_WINDOW_TYPE_SPLASH/,
      );
      for (const st of ["ABOVE", "SKIP_TASKBAR", "SKIP_PAGER"]) {
        assertMatch(props, new RegExp(`_NET_WM_STATE_${st}`), st);
      }
      assertMatch(props, /_MOTIF_WM_HINTS\(_MOTIF_WM_HINTS\) = 0x2, 0x0, 0x0/);
      // Never takes the focus: the app's window gets it when it shows.
      assertMatch(props, /Client accepts input or input focus: False/);
    }
    const c = r.colors as SplashSpec["light"];
    if (r.bg !== null) {
      assertEquals(r.bg, c.background, "background");
      assertEquals(r.fill, c.bar, "fill (the left half at 50 %)");
      assertEquals(r.track, c.track, "track (the right half)");
      assertEquals(r.hidden, c.background, "no download: the bar is hidden");
    }
    assertEquals(r.cancelled, true, "the ✕ cancels");
    assertEquals(r.gone, true, "closed: the window is destroyed");
    assertEquals(r.lost, "");
  },
});

Deno.test({
  name:
    "GTK splash: stays above the app's window shown after it (even with no window manager to honour keep-above); closed, the app's window is what shows",
  // The app's window is an xmessage; the pixels are read with ImageMagick.
  ignore: ignore || !onPath("xmessage") || !onPath("import"),
  async fn() {
    const r = await inChild("above", testDisplay());
    assert(!r.skipped && r.under !== null, JSON.stringify(r));
    assert(r.beside && r.beside !== "#ff0000", `the app's window: ${r.beside}`);
    assertEquals(r.under, "#ff0000", "the splash, over the app's window");
    assert(r.after && r.after !== "#ff0000", `closed: the app's window`);
  },
});

Deno.test({
  name:
    "GTK dialogs: the download window and the question are aio's own, in the app's identity colours, centred where the app's window opens; Cancel (the download window's one button) cancels; the question answers the button clicked",
  ignore,
  async fn() {
    const r = await inChild("dialogs", testDisplay());
    const centre = (b: { x: number; y: number; w: number; h: number }) => [
      Math.round(b.x + b.w / 2),
      Math.round(b.y + b.h / 2),
    ];
    const p = r.progress as { x: number; y: number; w: number; h: number };
    assert(p.w >= 424, `the bar's width: ${p.w}`);
    for (const b of [p, ...(r.asked as typeof p[])]) {
      const [cx, cy] = centre(b);
      assert(
        Math.abs(cx! - 500) <= 1 && Math.abs(cy! - 400) <= 1,
        JSON.stringify(b),
      );
    }
    assertEquals(r.answers, [2, 0]);
    assertEquals(r.cancelled, true, "Cancel cancels");
    assertEquals(r.backend, "gtk");
    const c = r.colors as SplashSpec["light"];
    if (r.seen !== null) {
      const seen = r.seen as string[];
      // The page, the bar's fill and its ground — the identity's own.
      assertEquals(seen[0], c.background, JSON.stringify(seen));
      assert(seen.includes(c.bar), `the bar: ${seen}`);
      assert(seen.includes(c.track), `the track: ${seen}`);
      assertEquals((r.askSeen as string[])[0], c.background, "the question");
      assertEquals(
        (r.viaBackend as string[])[0],
        c.background,
        "through dialogBackend",
      );
    }
  },
});

Deno.test({
  name:
    "GTK splash: told where the app's window really is, it moves onto that window's centre",
  ignore,
  async fn() {
    const r = await inChild("move", testDisplay());
    assertMatch(r.first as string, / at=380,325 /); // 500,400 − 120,75
    if (r.after !== null) {
      assertEquals(
        r.after,
        "#ff0000",
        "the splash, on the window's new centre",
      );
      assert(r.before !== "#ff0000", `not there before: ${r.before}`);
      assert(r.old !== "#ff0000", `gone from the old place: ${r.old}`);
    }
  },
});

Deno.test({
  name:
    "GTK splash: an @2x image is drawn at half its pixels; image only has no label and no bar",
  ignore,
  async fn() {
    const r = await inChild("2x", testDisplay());
    assertMatch(r.what as string, /size=240x150 scale=2 /);
    assertMatch(r.what as string, / text=0 barpx=0 /);
    assertEquals(r.lost, "");
  },
});

for (const fit of ["contain", "cover"] as const) {
  Deno.test({
    name:
      `GTK splash: the look keys (size, fit ${fit}, the text below, the bar on the bottom edge, radius, border, no ✕) and placed on the saved window`,
    ignore,
    async fn() {
      const r = await inChild(fit, testDisplay());
      const { W, TH, x, y } = r as {
        W: number;
        TH: number;
        x: number;
        y: number;
      };
      assertEquals(W, 640);
      assert(TH > 360 + 8 + 18, `a strip below the image: ${TH}`);
      // Centred on the saved window's centre (500, 400).
      assertEquals([x, y], [500 - 320, Math.round(400 - TH / 2)]);
      if (r.mid !== null) {
        assertEquals(r.mid, "#ff0000", "the image");
        // contain: the 576-px-wide image leaves 32 px of background each
        // side; cover fills the width.
        assertEquals(r.side, fit === "contain" ? "#202020" : "#ff0000");
        assertEquals(r.strip, "#202020", "the strip below the image");
        assertEquals(r.edge, "#ff00ff", "the border");
        assert(r.corner !== "#202020" && r.corner !== "#ff00ff", "corner cut");
        assertEquals(r.fill, r.bar, "the bar along the bottom edge");
      }
      assertEquals(r.cancelled, false, "no ✕ to cancel with");
    },
  });
}

Deno.test({
  name:
    "GTK splash: the process lives on after the splash closes, on a desktop that loads no GTK module (its worker's end must not unmap libgtk)",
  ignore,
  async fn() {
    // GTK3_MODULES (Cinnamon's xapp module) held libgtk loaded by chance;
    // without it the process segfaulted ~1 s after the close.
    const r = await inChild("linger", {
      ...testDisplay(),
      GTK_MODULES: "",
      GTK3_MODULES: "",
    });
    assertEquals(r, { alive: true });
  },
});

Deno.test({
  name:
    "GTK splash: no display to open is said (the fallback's reason), never a hang",
  ignore: !hasGtk,
  async fn() {
    // Nothing listens on :98.
    const r = await inChild("no-display", {
      DISPLAY: ":98",
      WAYLAND_DISPLAY: "",
    });
    assertMatch(r.why as string, /GTK could not open the display :98/);
    assert((r.ms as number) < 5_000, `${r.ms} ms`);
  },
});
