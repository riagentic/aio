/**
 * @module
 * The SPLASH: deno.json `build.splash`, the desktop app's introduction image,
 * shown from the very start of the app until its main window has loaded —
 * and, in an online app, the screen its Electron downloads behind.
 *
 * The build resolves the config (`build/splash.ts`) into the plain
 * {@linkcode SplashSpec} below and bakes it into `dist/electron.json`; the
 * window is drawn by the OS's own helper (runtime-dialog.ts), up before
 * Electron is started — or even on disk. On Windows, when Electron is
 * already here, its main process draws it first instead (electron-splash.ts:
 * the Forms helper is slower than the app's window). Its lifetime is the pure {@linkcode splashStep}; splash-session.ts runs it.
 */
import { join } from "@std/path";
import { ELECTRON_VERSION_FILE } from "./electron-runtime-fetch.ts";
import type { Bounds } from "./splash-place.ts";

/** One colour mode, `#rrggbb`. `background` is behind the image (a PNG with
 *  transparency); `bar`/`track` are the download bar's fill and ground. */
export type SplashColors = {
  background: string;
  text: string;
  bar: string;
  track: string;
};

/** What the build resolved from `build.splash`. Plain JSON. */
export type SplashSpec = {
  /** The PNG as base64; `scale` 2 for an `…@2x.png` (drawn at half its
   *  pixel size, so it is crisp on a 2× screen). */
  image: { png: string; w: number; h: number; scale: 1 | 2 };
  /** Drawn over the image; `{title} {got} {total} {pct}` (`{version}` was
   *  filled by the build). Null: image only. */
  text: string | null;
  /** Drawn instead of `text` while Electron downloads. Absent/null: `text`.
   *  (Optional: a spec an earlier aio baked has none.) */
  downloadText?: string | null;
  /** A bar under the text while Electron downloads. */
  progress: boolean;
  /** The splash stays at least this long once it is on screen. */
  minMs: number;
  /** The text's font; `family` null = the system's. Size in points. */
  font: { family: string | null; size: number; weight: "normal" | "bold" };
  bar: "solid" | "thin";
  light: SplashColors;
  dark: SplashColors;
  /** The rest of the look (`size`, `position`, …). Optional: a spec an
   *  earlier aio baked has none — {@linkcode lookOf} gives its defaults. */
  look?: SplashLook;
};

/** deno.json `build.splash`'s look keys, resolved. A null is "not set": the
 *  target's own default, which is how it looked before the key existed. */
export type SplashLook = {
  /** The window's (the image box's) logical size; null = the image's. */
  size: { width: number; height: number } | null;
  /** How the image fills `size` when its shape differs. */
  fit: "cover" | "contain";
  /** Centred on the app window's saved bounds (the primary display when
   *  there are none), on the primary display, or on the pointer's. */
  position: "window" | "primary" | "pointer";
  /** The text over the image's lower part, or in a strip below it. */
  textPosition: "over" | "below";
  /** null: left on the desktop, centred on Android and the web. */
  align: "left" | "center" | "right" | null;
  /** The text's and bar's gap to the window's edges; null: 24 px at the
   *  sides, 18 px at the bottom. */
  margin: number | null;
  /** The text's shadow; null: the OS's (macOS, Linux on; Windows off). */
  shadow: boolean | null;
  /** The window's corner radius, px. */
  radius: number;
  /** A 1 px border's colour; null: none. */
  border: string | null;
  /** The window's drop shadow; null: the OS's (macOS on). */
  windowShadow: boolean | null;
  /** The cap: no ready signal within this long (no download running), the
   *  splash goes. */
  maxMs: number;
  /** The fade out; null: the target's (about 100 ms on the desktop, 200 ms
   *  on Android and the web). */
  fadeMs: number | null;
  /** `firstStart`: only while Electron downloads. */
  show: "always" | "firstStart";
  /** The ✕ during a download. */
  cancel: boolean;
  /** The bar's height in logical px; null: `bar.style`'s (6 or 3 pt). */
  barHeight: number | null;
  /** Under the text (inside the margins), or along the window's bottom
   *  edge, full width. */
  barPosition: "under-text" | "bottom-edge";
  /** The bar's corner radius; null: the OS's (Windows square, macOS and
   *  Linux round). */
  barRadius: number | null;
  /** `position: "window"`: once the app's window shows, the splash moves
   *  onto where it REALLY is (a window manager, a DPI change or Electron
   *  itself may put it elsewhere than aio placed it). Absent (a spec an
   *  earlier aio baked): on. */
  followWindow?: boolean;
};

/** The look as a native helper reads it (one JSON argument): every "not
 *  set" resolved to that OS's own default — how it looked before the key
 *  existed. `sized`: `size` was set (else the helper keeps its old path, the
 *  image at its own size). Pure. */
export function helperLook(
  spec: SplashSpec,
  os: "windows" | "darwin" | "linux",
  target: Bounds | null = null,
) {
  const l = lookOf(spec);
  const iw = Math.round(spec.image.w / spec.image.scale);
  const ih = Math.round(spec.image.h / spec.image.scale);
  return {
    sized: l.size !== null,
    w: l.size?.width ?? iw,
    h: l.size?.height ?? ih,
    iw,
    ih,
    fit: l.fit,
    mode: l.position,
    // Where the app's window opens (splash-place.ts `windowRect`): its saved
    // position — null without one — and its size.
    target: target &&
      [target.x ?? null, target.y ?? null, target.width, target.height],
    below: l.textPosition === "below",
    align: l.align ?? SPLASH_DEFAULTS.align,
    side: l.margin ?? 24,
    bottom: l.margin ?? 18,
    barHeight: l.barHeight,
    barEdge: l.barPosition === "bottom-edge",
    barRadius: l.barRadius,
    radius: l.radius,
    border: l.border,
    shadow: l.shadow ?? os !== "windows",
    windowShadow: l.windowShadow ?? os === "darwin",
    fadeMs: l.fadeMs ?? SPLASH_DEFAULTS.fadeMs,
    cancel: l.cancel,
  };
}

/** The look keys the app SET that `helper` cannot draw — said once in the
 *  log when the splash opens (and named in docs/build/targets.md), never
 *  dropped silently. Pure. */
export function splashNotDrawn(
  spec: SplashSpec,
  helper: "windows" | "cocoa" | "gtk" | "yad" | "zenity" | "web" | "android",
): string[] {
  const l = lookOf(spec);
  const set = (k: keyof typeof l, dflt: unknown) => l[k] !== dflt;
  if (helper === "windows") {
    return [
      ...(l.shadow === true ? ["shadow"] : []),
      ...(l.windowShadow === true ? ["windowShadow"] : []),
    ];
  }
  if (helper === "cocoa") return [];
  if (helper === "gtk") return l.windowShadow !== null ? ["windowShadow"] : [];
  const keys: Array<[keyof typeof l, unknown, string]> = [
    ["size", null, "size"],
    ["textPosition", "over", "textPosition"],
    ["align", null, "align"],
    ["margin", null, "margin"],
    ["shadow", null, "shadow"],
    ["radius", SPLASH_DEFAULTS.radius, "radius"],
    ["border", null, "border"],
    ["windowShadow", null, "windowShadow"],
    ["barHeight", null, "bar.height"],
    ["barPosition", "under-text", "bar.position"],
    ["barRadius", null, "bar.radius"],
    ["fadeMs", null, "fadeMs"],
  ];
  const out = keys.filter(([k, d]) => set(k, d)).map(([, , n]) => n)
    // Square corners (a spec an earlier aio baked) every helper draws.
    .filter((n) => !(n === "radius" && l.radius === 0));
  // No window and no download there: the text is always under the image,
  // and the window's and the bar's keys have nothing to apply to.
  if (helper === "web" || helper === "android") {
    const drawn = helper === "web"
      ? ["shadow", "radius", "border", "fadeMs"]
      : ["fadeMs"];
    return [
      ...out.filter((k) => !drawn.includes(k)),
      ...(l.position !== "window" ? ["position"] : []),
      ...(!l.cancel ? ["cancel"] : []),
    ];
  }
  if (helper === "yad") {
    return [
      ...(spec.image.scale === 2 ? ["the @2x scale"] : []),
      ...out,
      ...(spec.progress && l.cancel ? ["cancel (no ✕)"] : []),
    ];
  }
  return out; // zenity: its note already says the image cannot be shown
}

/** The splash a build for `target` draws — none with `show: "firstStart"`
 * (nothing downloads there) — and the line that names what the app set and
 * it cannot draw, or null. Pure. */
export function targetSplash(
  spec: SplashSpec | null | undefined,
  target: "web" | "android",
): { splash: SplashSpec | null; note: string | null } {
  if (!spec) return { splash: null, note: null };
  if (lookOf(spec).show === "firstStart") {
    return {
      splash: null,
      note: `build.splash: show is "firstStart" — nothing downloads on ` +
        `${target === "web" ? "the web" : "Android"}, so there is no splash`,
    };
  }
  const n = splashNotDrawn(spec, target);
  return {
    splash: spec,
    note: n.length
      ? `build.splash: ${n.join(", ")} not drawn on ${
        target === "web" ? "the web" : "Android"
      } (docs/build/targets.md)`
      : null,
  };
}

/** The look of `spec`, defaults filled for a spec baked without one. Pure. */
export function lookOf(spec: SplashSpec): SplashLook {
  return spec.look ?? {
    size: null,
    fit: "cover",
    position: "window",
    textPosition: "over",
    // As it looked when it was baked (1.0.22): left-aligned, the 100 ms fade.
    align: "left",
    margin: null,
    shadow: null,
    radius: 0,
    border: null,
    windowShadow: null,
    maxMs: SPLASH_CAP_MS,
    fadeMs: 100,
    show: "always",
    cancel: true,
    barHeight: null,
    barPosition: "under-text",
    barRadius: null,
    followWindow: true,
  };
}

/** What a `build.splash` key left out means (1.0.23): the app's title; the
 *  download's own line while Electron downloads; the text centred, over the
 *  image's lower part; small rounded corners; a 200 ms fade; the text's and
 *  the window's shadow where the OS draws them; the bar's ends round on every
 *  OS. A key the app set is exactly what it set. */
export const SPLASH_DEFAULTS = {
  text: "{title}",
  downloadText: "Getting {title} ready · {got} of {total} MB",
  align: "center",
  radius: 8,
  fadeMs: 200,
} as const;

/** Bar thickness in points: small, at the bottom of the image. */
export const BAR_PT = { solid: 6, thin: 3 } as const;

/** No ready signal within this long of the last download: the splash goes,
 *  and the log says so once. */
export const SPLASH_CAP_MS = 30_000;

/** The spec baked into `<distDir>/electron.json`, or null (none). */
export async function bakedSplash(
  distDir: string | undefined,
): Promise<SplashSpec | null> {
  if (!distDir) return null;
  try {
    const rec = JSON.parse(
      await Deno.readTextFile(join(distDir, ELECTRON_VERSION_FILE)),
    ) as { splash?: SplashSpec };
    return rec.splash && typeof rec.splash === "object" ? rec.splash : null;
  } catch {
    return null; // aio-ok: no record is no splash
  }
}

/** A label is drawn: there is a text, at least while a download runs. Pure. */
export function splashHasText(spec: SplashSpec): boolean {
  return spec.text !== null || (spec.downloadText ?? null) !== null;
}

/** The spec with `{version}` filled in its texts — the app version the build
 *  (or a run from source) resolved, the string `--version` prints. Pure. */
export function splashWithVersion(
  spec: SplashSpec,
  version: string,
): SplashSpec {
  const fill = (t: string | null | undefined) =>
    typeof t === "string" ? t.replaceAll("{version}", version) : t;
  return {
    ...spec,
    text: fill(spec.text) as string | null,
    ...(spec.downloadText != null
      ? { downloadText: fill(spec.downloadText) as string }
      : {}),
  };
}

/** The splash text, filled: `{got}`/`{total}` in MB, `{pct}` percent (`?`
 *  while the size is unknown). Pure. */
export function splashText(
  template: string,
  title: string,
  got = 0,
  total = 0,
): string {
  const mb = (n: number) => (n / 1e6).toFixed(0);
  const vars: Record<string, string> = {
    title,
    got: mb(got),
    total: total > 0 ? mb(total) : "?",
    pct: total > 0 ? String(Math.floor((got / total) * 100)) : "?",
  };
  return template.replace(
    /\{(\w+)\}/g,
    (m, k: string) => (Object.hasOwn(vars, k) ? vars[k]! : m),
  );
}

// ── the lifetime ───────────────────────────────────────────────────────────

/** Why the splash went. */
export type SplashClose =
  | "ready" // the app is ready and the splash has been visible for minMs
  | "exit" // Electron exited, or never started
  | "cap" // no ready signal within maxMs
  | "shutdown" // the app is stopping
  | "dismissed" // the user closed it (its ✕ during a download)
  | "failed" // the download failed: the plain Retry / Quit question takes over
  | "lost"; // the helper never showed a window

/** The splash's own timeline. Nothing else waits on it: the app's window
 *  shows the moment it is ready, whatever the splash does. */
export type SplashState = {
  closed: SplashClose | null;
  /** When the window was on screen; null until then. */
  shownAt: number | null;
  /** When the ready signal came. */
  readyAt: number | null;
  downloading: boolean;
  /** The cap counts from here: the open, or the end of the last download. */
  capFrom: number;
};

export type SplashEvent =
  | { type: "shown"; at: number }
  | { type: "ready"; at: number }
  | { type: "tick"; at: number }
  | { type: "download"; on: boolean; at: number }
  | { type: "exit" | "shutdown" | "dismissed" | "failed" | "lost" };

/** A splash opened at `at`. Pure. */
export function splashOpened(at: number): SplashState {
  return {
    closed: null,
    shownAt: null,
    readyAt: null,
    downloading: false,
    capFrom: at,
  };
}

/** The splash's next state. It goes ("ready") once the app is ready and it
 *  has been VISIBLE for `minMs` — the app's window is up by then, under it:
 *  two timelines, the splash's end gates nothing. Ready before the splash
 *  is on screen: there is nothing to cover any more, it goes at once. Exit,
 *  shutdown, a dismissal, a failed download, a lost helper and the cap
 *  (which never runs during a download) close it at once. Pure. */
export function splashStep(
  s: SplashState,
  e: SplashEvent,
  o: { minMs: number; capMs: number },
): SplashState {
  const settle = (n: SplashState, at: number): SplashState =>
    n.closed || n.readyAt === null
      ? n
      : n.shownAt === null || at - n.shownAt >= o.minMs
      ? { ...n, closed: "ready" }
      : n;
  switch (e.type) {
    case "ready":
      return settle(s.readyAt === null ? { ...s, readyAt: e.at } : s, e.at);
    case "tick": {
      const n = settle(s, e.at);
      if (n !== s || s.closed) return n;
      return !s.downloading && e.at - s.capFrom >= o.capMs
        ? { ...s, closed: "cap" }
        : s;
    }
  }
  if (s.closed) return s;
  switch (e.type) {
    case "shown":
      return { ...s, shownAt: e.at };
    case "download":
      return e.on
        ? { ...s, downloading: true }
        : { ...s, downloading: false, capFrom: e.at };
    default:
      return { ...s, closed: e.type };
  }
}
