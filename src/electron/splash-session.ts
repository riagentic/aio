/**
 * @module
 * One splash per start, owned by the aio process: opened before Electron is
 * looked for (never awaited — the launch does not wait for a window), the
 * download's screen in an online app, and closed by the pure
 * {@linkcode splashStep} — on the main window's ready signal once it has been
 * visible for `minMs` (the hidden main window is shown in the same moment:
 * `onShowMain`), Electron's exit, the cap, shutdown, a dismissal, a failed
 * download, or a helper that never showed.
 */
import type { ProgressDialog, SplashOpener } from "./runtime-dialog.ts";
import { splashBackend } from "./runtime-dialog.ts";
import {
  SPLASH_CAP_MS,
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
  /** The main window (created hidden) may show now. Called once. */
  onShowMain?: () => void;
  /** Polled each tick: has the main window shown by itself (Electron's own
   *  cap, `splashHoldCapMs`)? Then the splash goes at once. */
  mainShown?: () => boolean;
}): SplashSession {
  const now = opts.now ?? (() => performance.now());
  const o = { minMs: spec.minMs, capMs: opts.capMs ?? SPLASH_CAP_MS };
  let state = splashOpened(now());
  let dialog: ProgressDialog | null = null;
  let tick: ReturnType<typeof setInterval> | undefined;
  let got = 0, total = 0, fraction: number | null = null, inDownload = false;
  let done!: (c: SplashClose) => void;
  const closed = new Promise<SplashClose>((r) => (done = r));
  const text = () =>
    spec.text === null ? "" : splashText(spec.text, opts.title, got, total);
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
    if (state.showMain && !was.showMain) {
      opts.log.info(
        `electron: splash — the main window shows${
          state.shownAt === null
            ? ""
            : ` ${
              Math.round(now() - state.shownAt)
            } ms after the splash appeared`
        }`,
      );
      opts.onShowMain?.();
    }
    if (state.closed && !was.closed) finish(state.closed);
  };

  return {
    closed,
    open() {
      const t0 = now();
      const id = setInterval(() => {
        if (!state.closed && opts.mainShown?.()) {
          opts.log.info(
            `electron: splash — the main window showed by itself; closing ` +
              `the splash`,
          );
          return step({ type: "mainShown" });
        }
        step({ type: "tick", at: now() });
      }, opts.tickMs ?? 100);
      tick = id;
      Deno.unrefTimer(id);
      void (async () => {
        const opener = await (opts.backend ??
          (() => splashBackend(spec, { log: opts.log.info })))();
        if (!opener) return step({ type: "lost" });
        const d = await opener.open(opts.title, text());
        dialog = d;
        if (state.closed) return void d.close();
        push();
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
          `electron: splash — not shown (${
            e instanceof Error ? e.message : e
          })`,
        );
        step({ type: "lost" });
      });
    },
    download() {
      if (state.closed) return null;
      step({ type: "download", on: true, at: now() });
      inDownload = true;
      fraction = null;
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
    ready: () => step({ type: "ready", at: now() }),
    exit: () => step({ type: "exit" }),
    shutdown: () => step({ type: "shutdown" }),
    fail: () => step({ type: "failed" }),
  };
}
