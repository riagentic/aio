// logger-api.ts — Public log singleton and API

import type { LogLevel, LogSink } from "./logger-types.ts";
import { DEFAULT_LOG_DIR, now } from "./logger-types.ts";
import { printConsole } from "./logger-format.ts";
import { frozenWriteMessage, isFrozenWriteError } from "../state/immutable.ts";

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

/** Where the app's logs live when no LOGGER is active.
 *
 *  Set at boot from the resolved app dirs. Without it, `logging: false` sent
 *  the crash diagnostics to `.aio/log` RELATIVE TO THE CURRENT DIRECTORY:
 *
 *      ERROR action-log  write failed: NotFound: writefile '.aio/log/actions.jsonl'
 *
 *  once per dispatch — and the action log and the crash checkpoint, the two
 *  artifacts that exist to explain a crash, were silently not written at all.
 *  Turning off the console logger must not turn off the black box. */
let _fallbackLogDir: string | null = null;

/** Tell the diagnostics sinks where this app's logs live, independent of
 *  whether a logger is running. Called once at boot, beside `registerAppDirs`.
 *  Idempotent; the last app to boot in a process wins, which is the same rule
 *  the logger itself follows. */
export function setFallbackLogDir(dir: string | null): void {
  _fallbackLogDir = dir;
}

/** Resolved log directory — the active logger's dir, the app's own log dir, or
 *  the default dot-dir. Single source of truth for the diagnostics +
 *  client-log sinks. */
export function getLogDir(): string {
  return _active?.logDir ?? _fallbackLogDir ?? DEFAULT_LOG_DIR;
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
    explainFrozenWrite(typeof b === "string" ? `${a} ${b}` : a);
  },
};

/** Said once per process — a frozen write in a hot path would otherwise repeat
 *  the same paragraph every tick, which trains people to skip logs. */
let _saidFrozen = false;

/** @internal test seam — re-arm the once-per-process explanation. */
// aio-ok: test-only seam — re-explaining on every tick is the bug it prevents
export function _resetFrozenWriteHint(): void {
  _saidFrozen = false;
}

/**
 * A frozen-state write, explained — wherever it is LOGGED.
 *
 * Committed cell state is frozen (immer's `autoFreeze` is never disabled), so
 * writing to it throws the engine's own sentence:
 *
 *     TypeError: Cannot assign to read only property 'n' of object '#<Object>'
 *
 * which names neither the cell, nor the rule, nor the fix. `immutable.ts` has
 * been the authority for the sentence that DOES since alpha70, wired into the
 * reducer, the test harnesses and a browser-only listener. Everywhere else —
 * an effect, a lifecycle hook, a route handler, an `onStart` — got the raw
 * text, and every one of those paths is CAUGHT by the framework, so no global
 * error listener could ever reach them. What they all share is that they LOG.
 *
 * Observe-only: one extra line beside an error that was already reported. Dev
 * and prod alike, because the write fails identically in both.
 * Found by `scripts/audit-round.ts 24`.
 */
function explainFrozenWrite(line: string): void {
  if (_saidFrozen || !line) return;
  // The cheap test first: the engine's phrasings all contain one of these.
  if (!/read.only|not extensible|Cannot delete property/i.test(line)) return;
  if (!isFrozenWriteError(line)) return;
  _saidFrozen = true;
  emit("error", frozenWriteMessage("state is frozen"), undefined, undefined);
}
