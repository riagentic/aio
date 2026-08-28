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
  draw();
  const unsub = source.subscribe(schedule);
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      unsub();
      if (io.tty) io.out("\x1b[?25h");
    },
    refresh: draw,
  };
}
