// logger-types.ts — Types, constants, and pure helpers for structured logging

/** Log severity levels */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

/** Logger configuration — passed to aio.run({ logging: {...} }) */
export type LogConfig = {
  /** Minimum level written to debug.log (default: 'trace' — everything) */
  level?: LogLevel;
  /** Log directory (default: './log') */
  dir?: string;
  /** Pretty console output in dev (default: auto-detected) */
  console?: boolean;
  /** app.log heartbeat interval in seconds — 0 to disable (default: 3600 = 1h) */
  heartbeat?: number;
  /** Action types to suppress entirely — even from debug.log */
  suppressTypes?: string[];
  /** Keep previous logs on restart — rotates to .1, .2, etc. (default: false — wipe on start) */
  backupLogs?: boolean;
  /** How many backup archives to keep when backupLogs is enabled (default: 7, 0 = unlimited) */
  backupKeep?: number;
};

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

// Pure framework internals — never logged anywhere
export const SKIP_SUFFIXES = [":__FlowState", ":__exec", ":__flow"];
export const SKIP_CONTAINS = [":__set"];

// Flow steps — debug.log only (not app.log)
export const FLOW_STEP_RE = /:__flow:(?!done|failed|error)/;

// ── Pure helpers ─────────────────────────────────────────────────────

export function callerFile(): string | undefined {
  const frames = new Error().stack?.split("\n") ?? [];
  for (const f of frames) {
    if (f.includes("logger")) continue;
    const m = f.match(/[/\\]([\w.-]+\.ts):(\d+):\d+/);
    if (m) return `${m[1]}:${m[2]}`;
  }
}

export function now(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 23);
}

export function elapsed(start?: number): number | undefined {
  return start !== undefined ? Date.now() - start : undefined;
}

export function fmtUptime(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

export function stripFlowPrefix(type: string): string {
  const m = type.match(/:__flow:(.+)$/);
  return m ? m[1] ?? type : type;
}

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
