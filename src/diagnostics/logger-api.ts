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

// ── Call-site tag inference ───────────────────────────────────────────
//
// `log.error("bridge: …")` from APP code printed the module `aio`, so a line
// the app wrote read as a framework fault. When no tag is given, the tag is
// now read off the first non-logger stack frame: inside the framework's own
// `src/` → `aio`, anywhere else → `app`. Observe-only (a label), and cheap:
// one regex per NEW call site, cached by the frame line.
//
// The framework root is this module's own location, so the same rule holds
// for a checkout (`file:///…/aio/src/`), the `dep/aio` symlink an app imports
// through, and the jsr package cache (`https://jsr.io/@…/aio/<v>/src/`) —
// wherever aio is, its `src/` is one prefix away from this file. Inference is
// disabled (tag stays `aio`) when the URL is not that shape, i.e. inside a
// browser bundle where every frame is the bundle.
// Resolved on FIRST use, never at module load: this module is client-reachable
// and a bundle that merely links it must not touch `import.meta` while it
// evaluates (tests/bundle-load-time-throw.test.ts).
let _frameworkSrc: string | null | undefined;
function frameworkSrc(): string | null {
  if (_frameworkSrc !== undefined) return _frameworkSrc;
  let url = "";
  try {
    url = import.meta.url;
  } catch { /* no module URL (inline script) → nothing is "the framework" */ }
  _frameworkSrc = /[/\\]src[/\\]diagnostics[/\\]logger-api\.ts$/.test(url)
    ? url.slice(0, url.lastIndexOf("/diagnostics/") + 1)
    : null;
  return _frameworkSrc;
}

/** Pure: is a stack-frame line one of the framework's own? */
export function frameIsFramework(line: string): boolean {
  const src = frameworkSrc();
  return src !== null && line.includes(src);
}

const _tagCache = new Map<string, "aio" | "app">();
const TAG_CACHE_MAX = 4096;

/** The tag for an untagged call: `app` when the first frame outside the
 *  logger is not framework code, else `aio`. `stack` is injectable for tests. */
export function inferTag(stack?: string): "aio" | "app" {
  if (frameworkSrc() === null) return "aio";
  const frames = (stack ?? new Error().stack ?? "").split("\n");
  const site = frames.find((f) =>
    f.includes("    at ") && !f.includes("/diagnostics/logger-")
  );
  if (!site) return "aio";
  const hit = _tagCache.get(site);
  if (hit) return hit;
  const tag = frameIsFramework(site) ? "aio" : "app";
  if (_tagCache.size >= TAG_CACHE_MAX) _tagCache.clear();
  _tagCache.set(site, tag);
  return tag;
}

/** Resolve overloaded args: (msg) or (cat, msg) or (cat, msg, data) */
function resolveArgs(
  a: string,
  b?: string | Record<string, unknown>,
  c?: Record<string, unknown>,
): [string, string, Record<string, unknown> | undefined] {
  if (typeof b === "string") return [a, b, c];
  return [inferTag(), a, b as Record<string, unknown> | undefined];
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
