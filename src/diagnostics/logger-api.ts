// logger-api.ts — Public log singleton and API

import type { LogLevel, LogSink } from "./logger-types.ts";
import { DEFAULT_LOG_DIR, now } from "./logger-types.ts";
import { printConsole } from "./logger-format.ts";
import { frozenWriteMessage, isFrozenWriteError } from "../state/immutable.ts";

// ── Public singleton ──────────────────────────────────────────────────
//
// ONE PROCESS CAN RUN SEVERAL APPS (library mode, `testApps`), and each has
// its own logger writing to its own directory. This used to be a single slot:
// the last app to boot took it, and the first app to CLOSE emptied it. So with
// app B up, app A's errors were written into B's `error.log`; after B closed,
// A's errors reached no file at all and `reportError` crashed on the null.
//
// Three tiers now, resolved per call by `getLogger()`:
//   1. an explicit `setLogger(sink)` — a test's capture sink, `am`'s stderr
//      sink, the data-contract query. The most specific instruction wins.
//   2. the logger of the app whose code is running (`setLoggerScope` — each
//      `aio.run()` runs as its app, so everything its boot starts — routes,
//      timers, sockets, dispatch — carries the scope). An app whose logger
//      does not exist YET (early boot, or `logging: false`) is console-only:
//      never another app's files.
//   3. the most recently installed app logger that is still running — module
//      code outside any app. Never null while any app with a logger runs.

let _override: LogSink | null = null;

/** App loggers, oldest first. `up` flips when the app has started, which is
 *  what `setLogger(null)` needs to tell a refused boot's logger (detach it)
 *  from a running app's (never). */
const _apps: { sink: LogSink; up: boolean }[] = [];
/** Loggers whose app has stopped. An override pointing at one is stale — the
 *  `prev = getLogger(); …; setLogger(prev)` idiom captures an app's logger
 *  and would otherwise pin a closed app's sink as the process logger. */
const _retired = new WeakSet<LogSink>();

/** `undefined` — no app is running this code; `null` — an app is, and it has
 *  no logger (yet): console only. */
let _scope: (() => LogSink | null | undefined) | null = null;

/** Wire the framework logger instance into the public singleton.
 *
 *  A sink is an explicit override and wins over every app's own logger.
 *  `null` clears the override, and also detaches any app logger whose app
 *  never came up (a refused boot's teardown calls exactly this) — a RUNNING
 *  app's logger is only ever detached by that app's own stop. */
export function setLogger(l: LogSink | null): void {
  _override = l;
  if (l !== null) return;
  for (const e of _apps.filter((a) => !a.up)) releaseAppLogger(e.sink);
}

/** Install one app's logger (at its boot). It becomes the fallback for code
 *  outside any app until a later app installs its own. */
export function installAppLogger(l: LogSink): void {
  releaseAppLogger(l);
  _retired.delete(l);
  _apps.push({ sink: l, up: false });
}

/** The app is up: from here only `releaseAppLogger` detaches its logger. */
export function markAppLoggerUp(l: LogSink): void {
  const e = _apps.find((a) => a.sink === l);
  if (e) e.up = true;
}

/** Detach exactly this app's logger — its app stopped. Every other app's
 *  logger stays where it was. */
export function releaseAppLogger(l: LogSink): void {
  const i = _apps.findIndex((a) => a.sink === l);
  if (i >= 0) _apps.splice(i, 1);
  _retired.add(l);
}

/** How to ask "whose app is running this code?". Installed once by the
 *  server side (an AsyncLocalStorage, which this client-reachable module must
 *  not import). */
export function setLoggerScope(
  get: () => LogSink | null | undefined,
): void {
  _scope = get;
}

/** Get the active logger instance (null if not configured) */
export function getLogger(): LogSink | null {
  if (_override && !_retired.has(_override)) return _override;
  const scoped = _scope?.();
  // An app with no logger of its own is NOT the last app's: its early boot
  // lines went into the other app's files.
  if (scoped === null) return null;
  if (scoped && _apps.some((a) => a.sink === scoped)) return scoped;
  return _apps.at(-1)?.sink ?? null;
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
  return getLogger()?.logDir ?? _fallbackLogDir ?? DEFAULT_LOG_DIR;
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
  const active = getLogger();
  if (active) {
    active.pub(lvl, cat, msg, data);
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
  // The engine's own property phrasings, and only those — see immutable.ts.
  // (The cheap prefilter that sat here was `read.only`, which is how an EROFS
  // "Read-only file system" error came to be explained as frozen state.)
  if (!isFrozenWriteError(line)) return;
  _saidFrozen = true;
  emit("error", frozenWriteMessage("state is frozen"), undefined, undefined);
}
