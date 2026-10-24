// output.ts — the `aio/cli` half of the presentation layer: the pieces that
// need a live stream (progress, spinner). The pure formatters —
// `style`/`table`/`plainWidth` and the whole house vocabulary — live in
// src/diagnostics/fmt.ts and are re-exported here unchanged.
//
// Why they live there and not here: `cli` is a LEAF in the boundary matrix, so
// `am`, `build`, `server` and `diagnostics` may NOT import it. Those are
// exactly the surfaces that must format the same way as `aio/cli` does, and a
// second copy of `style()`/`table()` for them is how two vocabularies start.
// One implementation, two doors.
//
// Everything decorative asks `io.color` / `io.tty` — the framework's ONE
// colour decider (`colorEnabled`, src/diagnostics/color.ts; `defaultIO()`
// carries the same value) — and degrades to plain lines that say the same
// thing. Turning colour off changes no character of a message, only whether
// escapes surround it.

import { type CliIO, defaultIO } from "./io.ts";

/** The ONE decider for where progress/spinner text goes: stderr by default —
 *  the unix convention, so `tool --json | jq` gets only the program's output
 *  on stdout; `stream: "out"` keeps the old stdout. On a terminal both
 *  streams are the screen, so nothing looks different there. Redraw follows
 *  the chosen stream's terminal fact (`tool 2>log` gets plain lines); a
 *  custom io without `errTty` keeps `tty` deciding. */
function progressOut(io: CliIO, stream: "err" | "out" = "err") {
  if (stream === "out") {
    return { write: (t: string) => io.out(t), redraw: io.tty };
  }
  if (stream === "err") {
    return {
      write: (t: string) => io.err(t),
      redraw: io.errTty ?? io.tty,
    };
  }
  throw new TypeError(
    `progress/spinner: stream must be "err" or "out", got ${
      JSON.stringify(stream)
    }`,
  );
}

export {
  type Column,
  plainWidth,
  type Style,
  style,
  styleWith,
  table,
  type TableOptions,
} from "../diagnostics/fmt.ts";

/** A progress bar handle. */
export type Progress = {
  /** Advance by `n` (default 1). */
  tick(n?: number): void;
  /** Jump to `n`. */
  set(n: number): void;
  /** Finish: prints the final state and a newline. Idempotent. */
  done(): void;
};

/** Options for {@link progress}. */
export type ProgressOptions = {
  /** Text before the bar. */
  label?: string;
  /** Bar width in characters (TTY only) — default 24. */
  width?: number;
  /** Injected streams (tests). */
  io?: CliIO;
  /** Stream to draw on — default `"err"`; `"out"` = stdout (before 1.0.25). */
  stream?: "err" | "out";
};

/** A progress bar over `total` steps, on stderr. TTY: one line redrawn in place.
 *  Otherwise: a plain `label 3/10 (30%)` line at every 10% and at the end. */
export function progress(total: number, opts: ProgressOptions = {}): Progress {
  const io = opts.io ?? defaultIO();
  const { write: out, redraw } = progressOut(io, opts.stream);
  const width = opts.width ?? 24;
  const label = opts.label ? `${opts.label} ` : "";
  let n = 0, finished = false, lastDecile = -1;
  const pct = () =>
    total > 0 ? Math.min(100, Math.floor(n / total * 100)) : 100;
  const text = () => `${label}${n}/${total} (${pct()}%)`;
  const draw = () => {
    if (finished) return;
    if (redraw) {
      const filled = Math.round(width * pct() / 100);
      out(
        `\r\x1b[2K${label}[${"#".repeat(filled)}${
          "-".repeat(width - filled)
        }] ${n}/${total} ${pct()}%`,
      );
    } else {
      const decile = Math.floor(pct() / 10);
      if (decile !== lastDecile) out(text() + "\n");
      lastDecile = decile;
    }
  };
  draw();
  return {
    tick(k = 1) {
      n = Math.min(total, n + k);
      draw();
    },
    set(k) {
      n = Math.max(0, Math.min(total, k));
      draw();
    },
    done() {
      if (finished) return;
      n = total;
      draw();
      finished = true;
      if (redraw) out("\n");
    },
  };
}

/** A spinner handle. */
export type Spinner = {
  /** Change the label while spinning. */
  update(label: string): void;
  /** Stop; `final` replaces the label on the last line (default: the label). */
  stop(final?: string): void;
};

/** Options for {@link spinner}. */
export type SpinnerOptions = {
  /** Frame interval in ms (TTY only) — default 80. */
  intervalMs?: number;
  /** Injected streams (tests). */
  io?: CliIO;
  /** Stream to draw on — default `"err"`; `"out"` = stdout (before 1.0.25). */
  stream?: "err" | "out";
};

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** An animated spinner with a label, on stderr. TTY: animates in place. Otherwise: prints
 *  `label...` once, then the final line on `stop()`. Never keeps the process
 *  alive (the timer is unref'd). */
export function spinner(label: string, opts: SpinnerOptions = {}): Spinner {
  const io = opts.io ?? defaultIO();
  const { write: out, redraw } = progressOut(io, opts.stream);
  let text = label, stopped = false, frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  if (redraw) {
    const draw = () => {
      out(`\r\x1b[2K${FRAMES[frame++ % FRAMES.length]} ${text}`);
    };
    draw();
    timer = setInterval(draw, opts.intervalMs ?? 80);
    Deno.unrefTimer?.(timer as unknown as number);
  } else out(`${text}...\n`);
  return {
    update(l) {
      text = l;
      if (!redraw && !stopped) out(`${text}...\n`);
    },
    stop(final) {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      out(redraw ? `\r\x1b[2K${final ?? text}\n` : `${final ?? text}\n`);
    },
  };
}
