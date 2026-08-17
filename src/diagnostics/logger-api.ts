// logger-api.ts — Public log singleton and API

import type { LogLevel, LogSink } from "./logger-types.ts";
import { DEFAULT_LOG_DIR, now } from "./logger-types.ts";
import { printConsole } from "./logger-format.ts";

// ── Public singleton ──────────────────────────────────────────────────

let _active: LogSink | null = null;

/** Wire the framework logger instance into the public singleton */
export function setLogger(l: LogSink | null): void {
  _active = l;
}

/** Get the active logger instance (null if not configured) */
export function getLogger(): LogSink | null {
  return _active;
}

/** Resolved log directory — the active logger's dir, or the default dot-dir.
 *  Single source of truth for the diagnostics + client-log sinks. */
export function getLogDir(): string {
  return _active?.logDir ?? DEFAULT_LOG_DIR;
}

/** Public log API — falls back to console when AioLogger is not active.
 *  Supports both `log.info('cat', 'msg')` and `log.info('msg')` (defaults to 'aio' category). */
export interface Log {
  /** Log at trace level — `log.trace('msg')` or `log.trace('category', 'msg', data?)`. */
  trace(msg: string, data?: Record<string, unknown>): void;
  /** Log at trace level with explicit category. */
  trace(cat: string, msg: string, data?: Record<string, unknown>): void;
  /** Log at debug level — `log.debug('msg')` or `log.debug('category', 'msg', data?)`. */
  debug(msg: string, data?: Record<string, unknown>): void;
  /** Log at debug level with explicit category. */
  debug(cat: string, msg: string, data?: Record<string, unknown>): void;
  /** Log at info level — `log.info('msg')` or `log.info('category', 'msg', data?)`. */
  info(msg: string, data?: Record<string, unknown>): void;
  /** Log at info level with explicit category. */
  info(cat: string, msg: string, data?: Record<string, unknown>): void;
  /** Log at warn level — `log.warn('msg')` or `log.warn('category', 'msg', data?)`. */
  warn(msg: string, data?: Record<string, unknown>): void;
  /** Log at warn level with explicit category. */
  warn(cat: string, msg: string, data?: Record<string, unknown>): void;
  /** Log at error level — `log.error('msg')` or `log.error('category', 'msg', data?)`. */
  error(msg: string, data?: Record<string, unknown>): void;
  /** Log at error level with explicit category. */
  error(cat: string, msg: string, data?: Record<string, unknown>): void;
}

/** Resolve overloaded args: (msg) or (cat, msg) or (cat, msg, data) */
function resolveArgs(
  a: string,
  b?: string | Record<string, unknown>,
  c?: Record<string, unknown>,
): [string, string, Record<string, unknown> | undefined] {
  if (typeof b === "string") return [a, b, c];
  return ["aio", a, b as Record<string, unknown> | undefined];
}

function emit(
  lvl: LogLevel,
  a: string,
  b?: string | Record<string, unknown>,
  c?: Record<string, unknown>,
): void {
  const [cat, msg, data] = resolveArgs(a, b, c);
  if (_active) {
    _active.pub(lvl, cat, msg, data);
    return;
  }
  // Fallback: console mirrors app.log — info, warn + error only
  if (lvl === "info" || lvl === "warn" || lvl === "error") {
    printConsole({ ts: now(), lvl, cat, msg, ...(data ? { data } : {}) });
  }
}

/** Public log singleton — routes to AioLogger when active, console fallback otherwise */
export const log: Log = {
  trace(
    a: string,
    b?: string | Record<string, unknown>,
    c?: Record<string, unknown>,
  ): void {
    emit("trace", a, b, c);
  },
  debug(
    a: string,
    b?: string | Record<string, unknown>,
    c?: Record<string, unknown>,
  ): void {
    emit("debug", a, b, c);
  },
  info(
    a: string,
    b?: string | Record<string, unknown>,
    c?: Record<string, unknown>,
  ): void {
    emit("info", a, b, c);
  },
  warn(
    a: string,
    b?: string | Record<string, unknown>,
    c?: Record<string, unknown>,
  ): void {
    emit("warn", a, b, c);
  },
  error(
    a: string,
    b?: string | Record<string, unknown>,
    c?: Record<string, unknown>,
  ): void {
    emit("error", a, b, c);
  },
};
