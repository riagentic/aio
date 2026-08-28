// output.ts — table, progress, spinner, style. Everything decorative asks
// `io.color` / `io.tty` — the framework's ONE colour decider
// (`colorEnabled`, src/diagnostics/color.ts; `defaultIO()` carries the same
// value) — and degrades to plain lines that say the same thing. Turning colour off changes no
// character of a message, only whether escapes surround it.

import { colorEnabled } from "../diagnostics/color.ts";
import { type CliIO, defaultIO } from "./io.ts";

/** Colour/emphasis helpers. Each returns `s` untouched when colour is off. */
export type Style = Record<
  | "bold"
  | "dim"
  | "underline"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan",
  (s: string) => string
>;

const CODES: Record<keyof Style, string> = {
  bold: "1",
  dim: "2",
  underline: "4",
  red: "31",
  green: "32",
  yellow: "33",
  blue: "34",
  magenta: "35",
  cyan: "36",
};

/** A {@link Style} bound to an explicit colour decision — for tests, or a
 *  stream that is not stdout. */
export function styleWith(color: boolean): Style {
  const out = {} as Style;
  for (const [k, code] of Object.entries(CODES)) {
    out[k as keyof Style] = color
      ? (s) => `\x1b[${code}m${s}\x1b[0m`
      : (s) => s;
  }
  return out;
}

/** `style.bold("x")`, `style.red("x")`, … — bound to THE process decider
 *  (`colorEnabled`, the same value `defaultIO().color` carries). */
export const style: Style = styleWith(colorEnabled);

/** Strip ANSI escapes — the width a terminal actually shows. */
export function plainWidth(s: string): number {
  // deno-lint-ignore no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Column spec for {@link table}: a key, or a key with a header/alignment. */
export type Column<R> = keyof R & string | {
  key: keyof R & string;
  header?: string;
  align?: "left" | "right";
};

/** Options for {@link table}. */
export type TableOptions<R> = {
  /** Which columns, in order — default: every key of the first row. */
  columns?: readonly Column<R>[];
  /** Styling decision — default: the process decider. */
  color?: boolean;
};

/** Render `rows` as an aligned text table (header bold when colour is on).
 *  Pure: returns the string, no trailing newline. No rows, no columns → "". */
export function table<R extends Record<string, unknown>>(
  rows: readonly R[],
  opts: TableOptions<R> = {},
): string {
  if (rows.length === 0 && !opts.columns) return "";
  const cols = (opts.columns ?? Object.keys(rows[0] ?? {})).map((c) =>
    typeof c === "string" ? { key: c, header: c, align: "left" as const } : {
      key: c.key,
      header: c.header ?? c.key,
      align: c.align ?? "left",
    }
  );
  const cell = (v: unknown): string =>
    v === null || v === undefined ? "" : typeof v === "string" ? v : String(v);
  const body = rows.map((r) => cols.map((c) => cell(r[c.key])));
  const widths = cols.map((c, i) =>
    Math.max(c.header.length, ...body.map((r) => r[i]!.length))
  );
  const pad = (s: string, i: number) =>
    cols[i]!.align === "right" ? s.padStart(widths[i]!) : s.padEnd(widths[i]!);
  const st = styleWith(opts.color ?? defaultIO().color);
  const line = (cells: string[]) => cells.map(pad).join("  ").trimEnd();
  const head = st.bold(line(cols.map((c) => c.header)));
  return [head, ...body.map(line)].join("\n");
}

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
};

/** A progress bar over `total` steps. TTY: one line redrawn in place.
 *  Otherwise: a plain `label 3/10 (30%)` line at every 10% and at the end. */
export function progress(total: number, opts: ProgressOptions = {}): Progress {
  const io = opts.io ?? defaultIO();
  const width = opts.width ?? 24;
  const label = opts.label ? `${opts.label} ` : "";
  let n = 0, finished = false, lastDecile = -1;
  const pct = () =>
    total > 0 ? Math.min(100, Math.floor(n / total * 100)) : 100;
  const text = () => `${label}${n}/${total} (${pct()}%)`;
  const draw = () => {
    if (finished) return;
    if (io.tty) {
      const filled = Math.round(width * pct() / 100);
      io.out(
        `\r\x1b[2K${label}[${"#".repeat(filled)}${
          "-".repeat(width - filled)
        }] ${n}/${total} ${pct()}%`,
      );
    } else {
      const decile = Math.floor(pct() / 10);
      if (decile !== lastDecile) io.out(text() + "\n");
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
      if (io.tty) io.out("\n");
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
};

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** An animated spinner with a label. TTY: animates in place. Otherwise: prints
 *  `label...` once, then the final line on `stop()`. Never keeps the process
 *  alive (the timer is unref'd). */
export function spinner(label: string, opts: SpinnerOptions = {}): Spinner {
  const io = opts.io ?? defaultIO();
  let text = label, stopped = false, frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  if (io.tty) {
    const draw = () => {
      io.out(`\r\x1b[2K${FRAMES[frame++ % FRAMES.length]} ${text}`);
    };
    draw();
    timer = setInterval(draw, opts.intervalMs ?? 80);
    Deno.unrefTimer?.(timer as unknown as number);
  } else io.out(`${text}...\n`);
  return {
    update(l) {
      text = l;
      if (!io.tty && !stopped) io.out(`${text}...\n`);
    },
    stop(final) {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      io.out(io.tty ? `\r\x1b[2K${final ?? text}\n` : `${final ?? text}\n`);
    },
  };
}
