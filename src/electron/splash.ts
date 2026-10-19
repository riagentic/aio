/**
 * @module
 * The SPLASH: deno.json `build.splash`, the desktop app's introduction image,
 * shown from the very start of the app until its main window has loaded —
 * and, in an online app, the screen its Electron downloads behind.
 *
 * The build resolves the config (`build/splash.ts`) into the plain
 * {@linkcode SplashSpec} below and bakes it into `dist/electron.json`; the
 * window is drawn by the OS's own helper (runtime-dialog.ts), never by
 * Electron, because it is up before Electron is started — or even on disk.
 * Its lifetime is the pure {@linkcode splashStep}; splash-session.ts runs it.
 */
import { join } from "@std/path";
import { ELECTRON_VERSION_FILE } from "./electron-runtime-fetch.ts";

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
  /** Drawn over the image; `{title} {got} {total} {pct}`. Null: image only. */
  text: string | null;
  /** A bar under the text while Electron downloads. */
  progress: boolean;
  /** The splash stays at least this long once it is on screen. */
  minMs: number;
  /** The text's font; `family` null = the system's. Size in points. */
  font: { family: string | null; size: number; weight: "normal" | "bold" };
  bar: "solid" | "thin";
  light: SplashColors;
  dark: SplashColors;
};

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
  | "ready" // the main window has loaded (and minMs has passed)
  | "exit" // Electron exited, or never started
  | "cap" // no ready signal within SPLASH_CAP_MS
  | "shutdown" // the app is stopping
  | "dismissed" // the user closed it (its ✕ during a download)
  | "failed" // the download failed: the plain Retry / Quit question takes over
  | "lost"; // the helper never showed a window

export type SplashState = {
  closed: SplashClose | null;
  /** The app's main window may be shown (it is created hidden while a
   *  splash is baked): true from the moment the splash goes on ready, or —
   *  once the app is ready — whenever there is no splash to wait for. */
  showMain: boolean;
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
  | { type: "exit" | "shutdown" | "dismissed" | "failed" | "lost" }
  /** The main window showed by itself (Electron's own cap): the splash goes
   *  now, whatever minMs says — never both on screen. */
  | { type: "mainShown" };

/** A splash opened at `at`. Pure. */
export function splashOpened(at: number): SplashState {
  return {
    closed: null,
    showMain: false,
    shownAt: null,
    readyAt: null,
    downloading: false,
    capFrom: at,
  };
}

/** The splash's next state. Once the app is ready and the splash has been
 *  VISIBLE for `minMs`, it closes on "ready" and the main window shows in the
 *  same step — no gap, no overlap. A splash that is not up yet is waited for
 *  (it always shows). Exit, shutdown, a dismissal, a failed download, a lost
 *  helper and the cap (which never runs during a download) close it at once;
 *  after those the main window shows as soon as the app is ready. Pure. */
export function splashStep(
  s: SplashState,
  e: SplashEvent,
  o: { minMs: number; capMs: number },
): SplashState {
  const settle = (n: SplashState, at: number): SplashState => {
    if (n.readyAt === null) return n;
    if (n.closed) return n.showMain ? n : { ...n, showMain: true };
    return n.shownAt !== null && at - n.shownAt >= o.minMs
      ? { ...n, closed: "ready", showMain: true }
      : n;
  };
  switch (e.type) {
    case "ready":
      return settle(s.readyAt === null ? { ...s, readyAt: e.at } : s, e.at);
    case "tick": {
      const n = settle(s, e.at);
      if (n !== s || s.closed) return n;
      return !s.downloading && e.at - s.capFrom >= o.capMs
        ? settle({ ...s, closed: "cap" }, e.at)
        : s;
    }
  }
  if (s.closed) return s;
  switch (e.type) {
    case "shown":
      return { ...s, shownAt: e.at };
    case "mainShown":
      return { ...s, closed: "ready", showMain: true };
    case "download":
      return e.on
        ? { ...s, downloading: true }
        : { ...s, downloading: false, capFrom: e.at };
    default:
      return settle({ ...s, closed: e.type }, s.readyAt ?? 0);
  }
}
