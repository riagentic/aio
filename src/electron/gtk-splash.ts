/**
 * @module
 * The Linux splash drawn by aio itself: GTK 3 over FFI (`libgtk-3.so.0`,
 * which every machine that runs Electron has — Electron links it), on a
 * worker thread (gtk-splash-worker.ts) so its drawing never holds up the
 * app's event loop. Borderless, above other windows, no taskbar entry,
 * where the app's window will open (`position`), never takes focus; the
 * image at its point size (`@2x` halved) or fitted to `size`, the text and
 * the bar placed as Windows and macOS place them, in the spec's font and
 * colours; a ✕ cancels a download.
 *
 * {@linkcode gtkSplash} answers whether GTK can draw here at all (the
 * library opens, the display opens) before anything is promised, so a
 * failure falls back to yad / zenity with its reason said.
 */
import type { ProgressDialog, SplashOpener } from "./runtime-dialog.ts";
import {
  BAR_PT,
  helperLook,
  type SplashColors,
  splashHasText,
  type SplashSpec,
} from "./splash.ts";
import type { Bounds } from "./splash-place.ts";
import type { WindowAt } from "./electron-renderer-log.ts";
import type {
  GtkLook,
  GtkSplashIn,
  GtkSplashOut,
} from "./gtk-splash-worker.ts";

/** How long GTK has to say whether it can draw. */
export const GTK_INIT_MS = 5_000;

/** The GTK splash's look (`helperLook` for Linux) and the bar's height in
 *  logical px (`bar.height`, else `bar.style`'s points at 96 dpi). The parts'
 *  places follow from it (`splashFrame`, splash-place.ts). Pure. */
export function gtkSplashLayout(
  spec: SplashSpec,
  target: Bounds | null = null,
): GtkLook {
  const L = helperLook(spec, "linux", target);
  const bp = spec.progress
    ? L.barHeight ?? Math.max(2, Math.round(BAR_PT[spec.bar] * 96 / 72))
    : 0;
  return { ...L, bp };
}

/** One colour mode's style sheet. Pure. */
export function gtkSplashCss(
  c: SplashColors,
  spec: SplashSpec,
  look: Pick<GtkLook, "bp" | "barRadius" | "shadow" | "radius" | "border">,
): string {
  const f = spec.font;
  const family = f.family === null
    ? ""
    : `font-family:"${
      f.family.replace(/[\\"]/g, "\\$&").replace(/\s+/g, " ")
    }";`;
  const bp = look.bp;
  const r = `border-radius:${look.barRadius ?? bp / 2}px;`;
  return `#aio-splash{background-color:${c.background};}` +
    `#aio-splash-text{color:${c.text};${family}font-size:${f.size}pt;` +
    `font-weight:${f.weight};text-shadow:${
      look.shadow ? "0 1px 2px rgba(0,0,0,0.45)" : "none"
    };}` +
    `#aio-splash-track{background-color:${c.track};${r}min-height:${bp}px;}` +
    `#aio-splash-fill{background-color:${c.bar};${r}min-height:${bp}px;}` +
    (look.border
      ? `#aio-splash-border{border:1px solid ${look.border};` +
        `border-radius:${look.radius}px;background:none;}`
      : "") +
    `#aio-splash-close,#aio-splash-close label{color:${c.text};` +
    `background:none;border:none;box-shadow:none;text-shadow:none;` +
    `padding:0 4px;min-width:0;min-height:0;}`;
}

/** The download window's and the question's look in one colour mode: the
 *  app's identity colours (`build/app-theme.ts`, the splash's own) — page
 *  background and text, the bar's fill and ground, buttons on the ground.
 *  Pure. */
export function gtkDialogCss(c: SplashColors): string {
  const flat = "background-image:none;box-shadow:none;text-shadow:none;";
  return `#aio-dialog{background-color:${c.background};color:${c.text};}` +
    `#aio-dialog label{color:${c.text};}` +
    `#aio-dialog progressbar trough{${flat}background-color:${c.track};` +
    `border:none;border-radius:3px;min-height:6px;}` +
    `#aio-dialog progressbar progress{${flat}background-color:${c.bar};` +
    `border:none;border-radius:3px;min-height:6px;}` +
    `#aio-dialog button{${flat}background-color:${c.track};color:${c.text};` +
    `border:1px solid ${c.track};}` +
    `#aio-dialog button:hover,#aio-dialog button:focus{border-color:${c.bar};}` +
    `#aio-dialog button label{color:${c.text};}`;
}

const dialogCss = (c?: { light: SplashColors; dark: SplashColors } | null) =>
  c ? { light: gtkDialogCss(c.light), dark: gtkDialogCss(c.dark) } : null;

/** The progress protocol's fraction as the worker reads it: -1 hides the
 *  bar. Pure. */
const pctOf = (f: number | null) =>
  f === null || !Number.isFinite(f)
    ? -1
    : Math.max(0, Math.min(100, Math.floor(f * 100)));

const colorArg = (c: SplashColors) =>
  `${c.background} ${c.text} ${c.bar} ${c.track}`;

/** A worker thread with GTK up and the display open, or why GTK cannot draw
 *  here (no library, no FFI permission, no display, no answer within
 *  {@linkcode GTK_INIT_MS}). */
async function gtkWorker(initMs = GTK_INIT_MS): Promise<
  {
    send(m: GtkSplashIn): void;
    listen(l: (m: GtkSplashOut) => void): void;
    onFail(f: ((why: string) => void) | null): void;
    terminate(): void;
  } | { why: string }
> {
  let w: Worker;
  try {
    w = new Worker(new URL("./gtk-splash-worker.ts", import.meta.url), {
      type: "module",
      name: "aio-gtk-splash",
    });
  } catch (e) {
    return {
      why: `its worker did not start (${e instanceof Error ? e.message : e})`,
    };
  }
  const listeners = new Set<(m: GtkSplashOut) => void>();
  let failed: ((why: string) => void) | null = null;
  w.onmessage = (e: MessageEvent<GtkSplashOut>) => {
    for (const l of [...listeners]) l(e.data);
  };
  w.onerror = (e) => {
    e.preventDefault();
    failed?.(`its worker failed: ${e.message}`);
  };
  const send = (m: GtkSplashIn) => w.postMessage(m);
  const init = await new Promise<string | null>((resolve) => {
    const t = setTimeout(
      () => resolve(`GTK did not answer within ${initMs / 1000} s`),
      initMs,
    );
    const done = (why: string | null) => {
      clearTimeout(t);
      listeners.clear();
      failed = null;
      resolve(why);
    };
    failed = done;
    listeners.add((m) => m.type === "init" && done(m.ok ? null : m.why));
    send({ type: "init" });
  });
  if (init !== null) {
    w.terminate();
    return { why: init };
  }
  return {
    send,
    listen: (l) => void listeners.add(l),
    onFail: (f) => void (failed = f),
    terminate: () => w.terminate(),
  };
}

/** One GTK window's life on its worker: shown / what / lost / closed, and a
 *  close that waits for the window to go (2 s at most), then ends the
 *  thread. */
function windowLife(
  k: Exclude<Awaited<ReturnType<typeof gtkWorker>>, { why: string }>,
) {
  let resolveShown!: () => void, resolveLost!: (why: string) => void;
  let resolveWhat!: (s: string) => void, resolveClosed!: () => void;
  const shown = new Promise<void>((r) => (resolveShown = r));
  const what = new Promise<string>((r) => (resolveWhat = r));
  const lost = new Promise<string>((r) => (resolveLost = r));
  const closed = new Promise<void>((r) => (resolveClosed = r));
  const life = {
    closing: false,
    shown,
    what,
    lost,
    async close() {
      if (life.closing) return;
      life.closing = true;
      k.send({ type: "close" });
      let t: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        closed,
        new Promise((r) => (t = setTimeout(r, 2_000))),
      ]);
      clearTimeout(t);
      k.terminate();
    },
  };
  k.onFail((why) => !life.closing && resolveLost(why));
  k.listen((m) => {
    if (m.type === "shown") {
      resolveWhat(m.what);
      resolveShown();
    } else if (m.type === "lost") {
      if (!life.closing) resolveLost(m.why);
    } else if (m.type === "closed") resolveClosed();
  });
  return life;
}

/** The GTK splash opener, or why GTK cannot draw here. */
export async function gtkSplash(
  spec: SplashSpec,
  opts: { initMs?: number; target?: Bounds | null } = {},
): Promise<
  (SplashOpener & { open(t: string, x: string): Promise<GtkDialog> }) | {
    why: string;
  }
> {
  const k = await gtkWorker(opts.initMs);
  if ("why" in k) return k;
  const look = gtkSplashLayout(spec, opts.target ?? null);
  return {
    name: "gtk splash",
    open(title, text) {
      const life = windowLife(k);
      let resolveCancel!: () => void;
      const cancelled = new Promise<void>((r) => (resolveCancel = r));
      k.listen((m) => m.type === "cancel" && !life.closing && resolveCancel());
      k.send({
        type: "open",
        title,
        text,
        hasText: splashHasText(spec),
        png: Uint8Array.from(atob(spec.image.png), (ch) => ch.charCodeAt(0)),
        scale: spec.image.scale,
        look,
        css: {
          light: gtkSplashCss(spec.light, spec, look),
          dark: gtkSplashCss(spec.dark, spec, look),
        },
        colors: { light: colorArg(spec.light), dark: colorArg(spec.dark) },
      });
      return Promise.resolve({
        shown: life.shown,
        what: life.what,
        click: () => k.send({ type: "click" }),
        cancelled,
        lost: life.lost,
        move(at: WindowAt) {
          if (!life.closing) {
            k.send({
              type: "move",
              target: [at.x, at.y, at.width, at.height],
            });
          }
        },
        update(f, detail) {
          if (!life.closing) {
            k.send({
              type: "update",
              pct: pctOf(f),
              text: detail.replace(/[\r\n\t]+/g, " "),
            });
          }
        },
        close: () => life.close(),
      });
    },
  };
}

/** The download window drawn by aio over GTK — titled, the heading, the
 *  detail and a bar (pulsing while the size is unknown), centred where the
 *  app's window opens (`target`, splash-place.ts) — or why GTK cannot draw
 *  here. Closing it is the cancel. */
export async function gtkProgress(
  title: string,
  heading: string,
  opts: {
    target?: Bounds | null;
    initMs?: number;
    /** The app's colours, light and dark; absent: the desktop theme's. */
    colors?: { light: SplashColors; dark: SplashColors } | null;
    /** Its Cancel button; the close cancels either way. Default: true. */
    cancel?: boolean;
  } = {},
): Promise<GtkDialog | { why: string }> {
  const k = await gtkWorker(opts.initMs);
  if ("why" in k) return k;
  const life = windowLife(k);
  let resolveCancel!: () => void;
  const cancelled = new Promise<void>((r) => (resolveCancel = r));
  k.listen((m) => m.type === "cancel" && !life.closing && resolveCancel());
  k.send({
    type: "progress",
    title,
    heading,
    target: opts.target ?? null,
    css: dialogCss(opts.colors),
    cancel: opts.cancel !== false,
  });
  return {
    shown: life.shown,
    what: life.what,
    click: () => k.send({ type: "click", index: 0 }), // its Cancel
    cancelled,
    lost: life.lost,
    update(f, detail) {
      if (!life.closing) {
        k.send({
          type: "update",
          pct: pctOf(f),
          text: detail.replace(/[\r\n\t]+/g, " "),
        });
      }
    },
    close: () => life.close(),
  };
}

/** The Retry / Quit question drawn by aio over GTK, centred where the app's
 *  window opens: `answer` is the button's index (-1: the window was closed),
 *  and the window goes once answered. `click(i)` clicks a button through
 *  GTK's own signal (tests). Or why GTK cannot draw here. */
export async function gtkAsk(
  title: string,
  message: string,
  buttons: string[],
  opts: {
    target?: Bounds | null;
    initMs?: number;
    colors?: { light: SplashColors; dark: SplashColors } | null;
  } = {},
): Promise<
  {
    answer: Promise<number>;
    shown: Promise<void>;
    what: Promise<string>;
    lost: Promise<string>;
    click(i: number): void;
  } | { why: string }
> {
  const k = await gtkWorker(opts.initMs);
  if ("why" in k) return k;
  const life = windowLife(k);
  const answer = new Promise<number>((resolve) =>
    k.listen((m) => {
      if (m.type === "answer") {
        resolve(m.index);
        void life.close();
      }
    })
  );
  k.send({
    type: "ask",
    title,
    message,
    buttons,
    target: opts.target ?? null,
    css: dialogCss(opts.colors),
  });
  return {
    answer,
    shown: life.shown,
    what: life.what,
    lost: life.lost,
    click: (i) => k.send({ type: "click", index: i }),
  };
}

/** The GTK splash's dialog; `what` is the worker's account of what it drew
 *  (size, scale, mode, colours, where) once it is on screen. `click` clicks
 *  its ✕ through GTK's own signal (tests: there is no pointer to click
 *  with). */
export type GtkDialog = ProgressDialog & {
  readonly shown: Promise<void>;
  readonly what: Promise<string>;
  click(): void;
};
