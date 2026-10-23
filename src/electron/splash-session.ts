/**
 * @module
 * One splash per start, owned by the aio process: opened before Electron is
 * looked for (never awaited — the launch does not wait for a window), the
 * download's screen in an online app, and closed by the pure
 * {@linkcode splashStep} — once the app is ready and the splash has been
 * visible for `minMs`, Electron's exit, the cap, shutdown, a dismissal, a
 * failed download, or a helper that never showed. Nothing waits for it: the
 * app's window shows the moment it is ready, under the splash while the
 * splash is still up.
 */
import type { ProgressDialog, SplashOpener } from "./runtime-dialog.ts";
import { splashBackend } from "./runtime-dialog.ts";
import type { Bounds } from "./splash-place.ts";
import type { WindowAt } from "./electron-renderer-log.ts";
import {
  lookOf,
  type SplashClose,
  type SplashEvent,
  splashOpened,
  type SplashSpec,
  splashStep,
  splashText,
} from "./splash.ts";

/** The download's view of the splash: the bar (with `progress`) and the
 *  text's `{got}`/`{total}`/`{pct}`. `close` ends the download, not the
 *  splash. */
export interface SplashDownload extends ProgressDialog {
  bytes(got: number, total: number): void;
}

export interface SplashSession {
  /** Starts opening the window and returns at once. */
  open(): void;
  /** The download is starting: its handle, or null when the splash is gone. */
  download(): SplashDownload | null;
  /** The main window has loaded. */
  ready(): void;
  /** Electron exited, or never started. */
  exit(): void;
  /** The app is stopping. */
  shutdown(): void;
  /** The download failed: the plain Retry / Quit question takes over. */
  fail(): void;
  /** Where the app's window really is (its main process says, when it shows
   *  and after it moves): with `position: "window"` and `followWindow`, the
   *  splash re-centres on it. */
  windowAt?(at: WindowAt): void;
  /** Electron is found and no download opened the helper: with
   *  `electronDraws`, the splash is handed to Electron's main process
   *  (electron-splash.ts) — true, and this session is done, silently. */
  handOff?(): boolean;
  /** Why it closed, once it has. */
  readonly closed: Promise<SplashClose>;
}

const never = new Promise<never>(() => {});

export function splashSession(spec: SplashSpec, opts: {
  title: string;
  log: { info: (m: string) => void; error: (m: string) => void };
  /** Injected in tests; default: this machine's helper. */
  backend?: () => Promise<SplashOpener | null>;
  now?: () => number;
  tickMs?: number;
  capMs?: number;
  /** The app window's saved bounds (`position: "window"`). */
  target?: Bounds | null;
  /** Electron's main process draws the splash when Electron is already
   *  here (Windows): the helper opens only for a download. */
  electronDraws?: boolean;
  /** `spec`'s `show` is the app's run-time one (`aio.run({ splash })`). */
  showByApp?: boolean;
}): SplashSession {
  const now = opts.now ?? (() => performance.now());
  const look = lookOf(spec);
  const o = { minMs: spec.minMs, capMs: opts.capMs ?? look.maxMs };
  // `show: "firstStart"`: the window opens only once a download starts; a
  // start without one never shows it.
  let deferred = look.show === "firstStart" || opts.electronDraws === true,
    opened = false;
  let state = splashOpened(now());
  let dialog: ProgressDialog | null = null;
  let tick: ReturnType<typeof setInterval> | undefined;
  let got = 0, total = 0, fraction: number | null = null, inDownload = false;
  // The window's real bounds, once known; said once if the helper cannot
  // move to them.
  let at: WindowAt | null = null, saidStays = false;
  const follow = look.position === "window" && look.followWindow !== false;
  const moveTo = (d: ProgressDialog, w: WindowAt) => {
    if (d.move) return d.move(w);
    if (saidStays) return;
    saidStays = true;
    opts.log.info(
      `electron: splash — this helper cannot move it, so it stays where it ` +
        `opened, not on the window at ${w.x},${w.y} ${w.width}x${w.height}`,
    );
  };
  let done!: (c: SplashClose) => void;
  const closed = new Promise<SplashClose>((r) => (done = r));
  // `downloadText` while a download runs, else `text`.
  const text = () => {
    const t = inDownload ? spec.downloadText ?? spec.text : spec.text;
    return t === null ? "" : splashText(t, opts.title, got, total);
  };
  const push = () =>
    dialog?.update(spec.progress && inDownload ? fraction : null, text());

  const finish = (why: SplashClose) => {
    clearInterval(tick);
    if (why === "cap") {
      opts.log.info(
        `electron: splash — closed after ${o.capMs / 1000} s without the ` +
          `main window's ready signal`,
      );
    } else if (why !== "lost") {
      // "lost" has said why already — one line per splash that never showed
      opts.log.info(`electron: splash — closed (${why})`);
    }
    void dialog?.close();
    done(why);
  };
  const step = (e: SplashEvent) => {
    const was = state;
    state = splashStep(state, e, o);
    if (state.readyAt !== null && was.readyAt === null) {
      opts.log.info(
        `electron: splash — the app is ready${
          state.shownAt === null
            ? ", before the splash was on screen"
            : ` ${
              Math.round(now() - state.shownAt)
            } ms after the splash appeared`
        }; its window shows now`,
      );
    }
    if (state.closed && !was.closed) finish(state.closed);
  };

  const openNow = () => {
    opened = true;
    const t0 = now();
    const id = setInterval(
      () => step({ type: "tick", at: now() }),
      opts.tickMs ?? 100,
    );
    tick = id;
    Deno.unrefTimer(id);
    void (async () => {
      const opener = await (opts.backend ??
        (() =>
          splashBackend(spec, { log: opts.log.info, target: opts.target })))();
      if (!opener) return step({ type: "lost" });
      // Closed while the helper was starting: it never maps.
      if (state.closed) return opener.dispose?.();
      const d = await opener.open(opts.title, text());
      dialog = d;
      if (state.closed) return void d.close();
      push();
      if (at) moveTo(d, at);
      const seen = () => {
        if (state.closed || state.shownAt !== null) return;
        // performance.now() counts from the process's start: both numbers
        // are what a user waits through.
        opts.log.info(
          `electron: splash — visible ${
            Math.round(now() - t0)
          } ms after it was asked for, ${
            Math.round(performance.now())
          } ms after the app started (${opener.name})`,
        );
        step({ type: "shown", at: now() });
      };
      if (d.shown) d.shown.then(seen);
      else seen();
      d.lost.then((why) => {
        if (state.closed) return;
        opts.log.error(`electron: splash — not shown (${why})`);
        step({ type: "lost" });
      });
      d.cancelled.then(() => step({ type: "dismissed" }));
    })().catch((e) => {
      opts.log.error(
        `electron: splash — not shown (${e instanceof Error ? e.message : e})`,
      );
      step({ type: "lost" });
    });
  };

  return {
    closed,
    open() {
      if (!deferred) openNow();
    },
    download() {
      if (state.closed) return null;
      if (deferred && !opened) openNow();
      step({ type: "download", on: true, at: now() });
      inDownload = true;
      fraction = null;
      push(); // `downloadText` from the download's first moment
      return {
        update(f) {
          fraction = f;
          push();
        },
        bytes(g, t) {
          got = g;
          total = t;
        },
        cancelled: closed.then((c) => (c === "dismissed" ? undefined : never)),
        // The helper died before it showed (or could not start): the start
        // opens the plain progress window for the rest of the download.
        lost: closed.then((c) =>
          c === "lost" ? "the splash's helper never showed it" : never
        ),
        close() {
          inDownload = false;
          push();
          step({ type: "download", on: false, at: now() });
          return Promise.resolve();
        },
      };
    },
    ready: () => {
      if (deferred && !opened && !state.closed) {
        // No download ran: nothing to show.
        deferred = false;
        state = { ...state, readyAt: now(), closed: "ready" };
        opts.log.info(
          opts.showByApp
            ? `electron: splash — not shown (the app's run-time show: "firstStart")`
            : `electron: splash — not shown (show: "firstStart", no download)`,
        );
        return done("ready");
      }
      step({ type: "ready", at: now() });
    },
    exit: () => step({ type: "exit" }),
    shutdown: () => step({ type: "shutdown" }),
    fail: () => step({ type: "failed" }),
    handOff() {
      if (
        !opts.electronDraws || opened || state.closed ||
        look.show === "firstStart"
      ) return false;
      deferred = false;
      state = { ...state, readyAt: now(), closed: "ready" }; // nothing to say later
      clearInterval(tick);
      done("ready");
      return true;
    },
    windowAt(w) {
      if (!follow || state.closed) return;
      at = w;
      if (dialog) moveTo(dialog, w);
    },
  };
}
