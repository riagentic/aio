// watch.ts — re-render a text view every time a source changes.
//
// The source is anything with `subscribe(fn) → unsubscribe`: the handle
// `connectCli()` returns (a `cli-client` watching live server state), a
// signal, a cell signal from `aio/state-core`. Structural on purpose — the
// toolkit needs no import from the state layer to draw it.

import { type CliIO, defaultIO } from "./io.ts";

/** Anything that can say "I changed": the `connectCli()` handle, a signal. */
export type Watchable = {
  /** Subscribe to changes — returns unsubscribe. */
  subscribe(fn: () => void): () => void;
};

/** A live view handle. */
export type Watch = {
  /** Unsubscribe, restore the cursor, print nothing more. Idempotent. */
  stop(): void;
  /** Force a redraw now. */
  refresh(): void;
};

/** Options for {@link watch}. */
export type WatchOptions = {
  /** Injected streams (tests). */
  io?: CliIO;
};

/** Draw `render()` now and again on every change of `source`. TTY: a clean
 *  full redraw (clear screen, cursor hidden). Otherwise: each frame appended
 *  as plain lines. Changes in the same tick are coalesced into one frame. */
export function watch(
  source: Watchable,
  render: () => string,
  opts: WatchOptions = {},
): Watch {
  const io = opts.io ?? defaultIO();
  let stopped = false, queued = false;
  const draw = () => {
    if (stopped) return;
    const frame = render();
    io.out(io.tty ? `\x1b[2J\x1b[H${frame}\n` : `${frame}\n`);
  };
  const schedule = () => {
    if (queued || stopped) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      draw();
    });
  };
  if (io.tty) io.out("\x1b[?25l");
  // Ctrl+C while the cursor is hidden: with no SIGINT handler of the app's
  // own, the process died and left the terminal with no cursor. The listener
  // ALWAYS shows it again; it exits 130 (what the signal meant) only when the
  // app registered no SIGINT listener of its own — an app that handles Ctrl+C
  // keeps its exit and its cleanup, exactly as before. Removed on stop().
  const onInt = () => {
    io.out("\x1b[?25h");
    if (_appSigint.size === 0) io.exit(130);
  };
  const listens = io.tty && addSigint(onInt);
  // A call made INSIDE `subscribe` is the source replaying what it already
  // has (`connectCli().subscribe` "fires immediately if state exists") — the
  // frame drawn below. Scheduled, it was a second identical frame: invisible
  // on a terminal, a duplicated block in `todo list --watch | tee log`.
  let subscribing = true;
  const unsub = source.subscribe(() => {
    if (!subscribing) schedule();
  });
  subscribing = false;
  try {
    draw();
  } catch (e) {
    unsub(); // a first frame that throws leaves nothing subscribed
    if (listens) _remove("SIGINT", onInt);
    if (io.tty) io.out("\x1b[?25h");
    throw e;
  }
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      unsub();
      if (listens) _remove("SIGINT", onInt);
      if (io.tty) io.out("\x1b[?25h");
    },
    refresh: draw,
  };
}

/** The app's own SIGINT listeners, seen through the two Deno calls that add
 *  and remove them — wrapped once, at module load (before app code runs: an
 *  import evaluates first). `watch()`'s own listener goes through the
 *  originals and is never counted.
 *
 *  Why a wrapper: Deno has no "which listeners are registered" query, and
 *  every other route is worse — re-raising the signal after showing the
 *  cursor delivers a second Ctrl+C to an app that handles it, and a timed
 *  exit kills an app whose handler cancels work and keeps running.
 *  `node:process`'s `process.on("SIGINT")` goes through the same global, so
 *  it is counted too.
 *
 *  Transparent: same name/arity, `this` and arguments forwarded, the
 *  original's return value returned, and its throw propagates BEFORE
 *  anything is counted. Once per process: a second copy of this module
 *  (two aio versions in one app) reuses the first one's count and originals
 *  instead of wrapping the wrapper — which would have counted the other
 *  copy's own listener as the app's, so neither view would ever exit. */
type SigFn = typeof Deno.addSignalListener;
const _SHARED = Symbol.for("aio.cli.watch.sigint");
const _shared = ((globalThis as Record<symbol, unknown>)[_SHARED] ??= (() => {
  const seen = new Set<unknown>();
  const add: SigFn = Deno.addSignalListener;
  const remove: SigFn = Deno.removeSignalListener;
  try {
    Deno.addSignalListener = function addSignalListener(
      this: unknown,
      signal,
      handler,
    ) {
      const r = add.call(this, signal, handler);
      if (signal === "SIGINT") seen.add(handler);
      return r;
    };
    Deno.removeSignalListener = function removeSignalListener(
      this: unknown,
      signal,
      handler,
    ) {
      const r = remove.call(this, signal, handler);
      if (signal === "SIGINT") seen.delete(handler);
      return r;
    };
  } catch (e) {
    // A frozen Deno namespace: nothing to count — then never exit for the app.
    if (!(e instanceof TypeError)) throw e;
    seen.add(null);
  }
  return { seen, add, remove };
})()) as { seen: Set<unknown>; add: SigFn; remove: SigFn };
const _appSigint = _shared.seen;
const _add = _shared.add;
const _remove = _shared.remove;

/** Listen for SIGINT where the runtime can (not in a Worker without the
 *  permission, nor on a platform without it) — false when it could not. */
function addSigint(fn: () => void): boolean {
  try {
    _add("SIGINT", fn);
    return true;
  } catch (e) {
    if (e instanceof TypeError || e instanceof Deno.errors.NotCapable) {
      return false;
    }
    throw e;
  }
}
