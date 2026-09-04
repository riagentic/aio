// logger-types.ts — Types, constants, and pure helpers for structured logging

import { dur } from "./fmt.ts";

/** Default log directory — dot-dir so project watchers/scanners skip it. */
// Only reached by a logger created WITHOUT an app (a standalone script, or a
// log call before boot wires `dir: <appDirs>.logs`). An app's logs live in
// `~/.<appId>/logs` — see src/server/app-dirs.ts.
export const DEFAULT_LOG_DIR = ".aio/log";

/** Log severity levels — the word in every line, and what it asks of you:
 *  info = nothing to do · warn = should be fixed · error = must be fixed. */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

/** Logger configuration — passed to aio.run({ logging: {...} }) */
export type LogConfig = {
  /** Minimum level for EVERY sink — debug.log, app.log, error.log,
   *  warning.log and the console (default: 'info' — set 'trace' or 'debug' to
   *  opt into verbose file logging; every dispatch logged at debug amplifies
   *  watcher feedback loops — 2026-07-08 field report). It used to gate
   *  debug.log alone, so `level: "warn"` silenced nothing a user could see. */
  level?: LogLevel;
  /** Log directory. An app defaults to `~/.<appId>/logs` (tier ② — regenerable,
   *  outside the backup); a standalone logger with no app falls back to
   *  `.aio/log` in the cwd. */
  dir?: string;
  /** Pretty console output in dev (default: auto-detected) */
  console?: boolean;
  /** app.log heartbeat interval in seconds — 0 to disable (default: 3600 = 1h) */
  heartbeat?: number;
  /** Action types to suppress entirely — even from debug.log */
  suppressTypes?: string[];
  /** Keep previous logs on restart — rotates to .1, .2, … (default: TRUE).
   *
   *  It defaulted to wipe-on-start, which destroyed the logs of the run you
   *  restarted BECAUSE of — and in dev, where every cell-file save respawns the
   *  process (`src/server/dev-restart.ts`), that meant the crash you just
   *  reproduced was erased by the reload that followed it. Set `false` for the
   *  old clean-slate behaviour (`--no-backup-logs`). */
  backupLogs?: boolean;
  /** How many backup archives to keep when backupLogs is enabled (default: 7, 0 = unlimited) */
  backupKeep?: number;
  /** Byte ceiling for the WHOLE log directory (default: 200 MB, 0 = unlimited).
   *
   *  Enforced at boot, right after rotation: archives are evicted oldest-run
   *  first until the directory fits, and what went is logged. Nothing rotates a
   *  log mid-run, so retention alone would multiply an unbounded `client.log`
   *  by `backupKeep + 1`; this is the bound that makes the default safe. Live
   *  files are counted but never evicted — if they alone exceed the budget the
   *  logger warns rather than deleting this run's evidence. */
  logBudget?: number;
};

/** What the public `log` API needs from a logger.
 *
 *  `AioLogger` satisfies this structurally, and typing the singleton against
 *  the INTERFACE is what keeps `logger-api.ts` free of any reference to
 *  `logger-core.ts` — the core is Deno-only (`@std/path`, file writes), and a
 *  single `import type` of it followed `log` into the browser bundle, where an
 *  unmapped bare import is a blank screen. The API depends on the shape; only
 *  the server ever depends on the class. */
export interface LogSink {
  /** A vitals measurement, into `perf.log`/`debug.log` under the
   *  `vitals:<layer>` category.
   *
   *  Optional because a sink is free not to have one — but it is the ONLY
   *  writer of vitals measurements into a log file, and it had no caller at
   *  all: a producer with no caller, a consumer with no caller, and a green
   *  test proving the producer worked. `check:dead-wiring` cannot see it
   *  because these are class methods, not module exports. */
  vitals?: (
    layer: "render" | "transport" | "loop",
    status: string,
    measured: number,
    threshold: number,
    hint?: { cause: string; suggestion: string; severity: string },
  ) => void;

  readonly logDir: string;
  pub(
    lvl: LogLevel,
    cat: string,
    msg: string,
    data?: Record<string, unknown>,
  ): void;
  /** A budget violation — its own sink (perf.log), not a level. */
  perf(
    source: "reduce" | "effect",
    type: string,
    duration: number,
    budget: number,
    breakdown?: {
      produce: number;
      clone: number;
      spread: number;
      routing: number;
      listeners: number;
    },
  ): void;
  /** Wait for buffered lines to reach disk (shutdown, and tests). */
  flush(timeoutMs?: number): Promise<void>;
}

export type LogEntry = {
  ts: string;
  lvl: LogLevel | "perf";
  cat: string;
  msg: string;
  src?: string;
  data?: Record<string, unknown>;
  dur?: number;
};

export const LEVELS: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

// What counts as framework noise lives in action-kind.ts — ONE decider for
// every sink. The copy that used to sit here dropped `:__set` types, so
// debug.log ("all actions dispatched") held an async method's call and never
// the write-set that says what it wrote.

// ── Pure helpers ─────────────────────────────────────────────────────

export function callerFile(): string | undefined {
  const frames = new Error().stack?.split("\n") ?? [];
  for (const f of frames) {
    if (f.includes("logger")) continue;
    const m = f.match(/[/\\]([\w.-]+\.ts):(\d+):\d+/);
    if (m) return `${m[1]}:${m[2]}`;
  }
}

/** THE timestamp on every aio log line — console and file, one spelling.
 *
 *  It used to be `toISOString()` with the `T` swapped for a space and the `Z`
 *  sliced off: UTC, wearing no marker at all. So the terminal read `21:11`
 *  while the clock on the wall said `23:11`, and a line pasted into an issue
 *  carried no way to tell which it was. Both halves of that are fixed by the
 *  same choice — LOCAL time, with the offset attached: it matches the wall
 *  clock of whoever is watching, and it still says exactly which instant it
 *  means to a reader in another zone. UTC hosts print `+00:00`, which is the
 *  honest way to say Z. */
export function now(d: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  // getTimezoneOffset is minutes to ADD to local to get UTC — the sign a
  // human writes is the other one.
  const offset = -d.getTimezoneOffset();
  const abs = Math.abs(offset);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.` +
    `${p(d.getMilliseconds(), 3)}` +
    `${offset < 0 ? "-" : "+"}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

export function elapsed(start?: number): number | undefined {
  return start !== undefined ? Date.now() - start : undefined;
}

/** How long this logger has been up — ONE spelling of a duration, shared with
 *  every other one aio prints (`fmt.dur`). Three of these existed and all three
 *  disagreed: this one rounded 90 minutes to `2h`, `am` said `1h 30m`, and
 *  amui said `1h 30m` from its own fourth copy. */
export const fmtUptime: (ms: number) => string = dur;

export function filterInternal(
  p: Record<string, unknown>,
): Record<string, unknown> | null {
  const out = Object.fromEntries(
    Object.entries(p).filter(([k]) => !k.startsWith("_")),
  );
  return Object.keys(out).length ? out : null;
}

export function isDevMode(): boolean {
  return import.meta.url.startsWith("file:///");
}
