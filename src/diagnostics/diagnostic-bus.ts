// src/diagnostic-bus.ts — Lightweight diagnostic event bus
// Works in both Deno (server) and browser — no platform-specific APIs. The one
// import is `logger-api`, the console-fallback facade that `degraded.ts` (same
// folder, same isomorphic constraint) already uses: it pulls in no @std/path
// and no file rotation, so the browser bundle stays intact.

import { log } from "./logger-api.ts";

/** Severity levels for diagnostic events */
export type DiagnosticSeverity = "error" | "warning" | "info";

/** A single diagnostic event record */
export type DiagnosticEvent = {
  /** Namespaced event type, e.g. "feat:load", "dispatch:error" */
  type: string;
  severity: DiagnosticSeverity;
  /** Source module or subsystem that emitted the event */
  source: string;
  message: string;
  /** Arbitrary structured detail (e.g. payload, cell id) */
  detail?: unknown;
  /** Unix ms timestamp — added by diagEmit */
  ts: number;
  /** Short actionable hint for the developer */
  hint?: string;
  /** Link to docs explaining the event */
  docLink?: string;
  /** How many events of this type the dedup window swallowed since the last
   *  one that got through. Present (and > 0) only when something WAS
   *  suppressed. Dedup keys on `type` alone, so a suppressed event may have
   *  carried a DIFFERENT message — a second cell failing while the first is
   *  still inside the window. Suppressing it keeps the volume bounded, which
   *  is the point; losing the fact that it happened is not, and in the
   *  subsystem whose whole job is to surface silent failures it was the one
   *  thing that must not go quiet. */
  suppressed?: number;
};

/** Listener callback type */
export type DiagnosticListener = (event: DiagnosticEvent) => void;

// ---------------------------------------------------------------------------
// Internal state — module-level singletons, reset by initDiagnosticBus()
// ---------------------------------------------------------------------------

const RING_CAP = 200;

/** Circular ring buffer */
let _ring: DiagnosticEvent[] = new Array(RING_CAP);
/** Write pointer (next slot to write into) */
let _head = 0;
/** Number of valid entries stored (0..RING_CAP) */
let _count = 0;

/** Dev mode flag */
let _dev = false;
/** Has an app set the mode since the last full reset? */
let _appJoined = false;

/** Listener set — O(1) add/delete */
let _listeners: Set<DiagnosticListener> = new Set();

/** Dedup map: (app scope +) event type → last-emitted timestamp (ms) */
let _dedup: Map<string, number> = new Map();
/** Per-type count of events the window swallowed since the last one emitted.
 *  Reported on the next event of that type, then cleared — so nothing new is
 *  emitted (the volume control stays exactly as strict) and nothing is lost. */
let _suppressed: Map<string, number> = new Map();

const DEDUP_WINDOW_MS = 5_000;

// ---------------------------------------------------------------------------
// App scope — which app emitted an event
// ---------------------------------------------------------------------------
//
// A process can host several apps, and this bus is one per process. Untagged,
// app B's `reduce-error` was filed by app A's feedback auto-capture (with A's
// state in the report), and — dedup keying on TYPE alone — B's error inside
// the 5 s window swallowed A's own `reduce-error`, so A's auto-capture never
// saw it. The server installs how to ask "whose app is running this code?"
// (the same AsyncLocalStorage the logger uses — this module stays isomorphic
// and imports none); an event emitted outside any app stays unscoped and is
// every subscriber's, exactly as before.

let _scopeGetter: (() => object | undefined) | null = null;
const _eventScope = new WeakMap<DiagnosticEvent, object>();
const _scopeIds = new WeakMap<object, number>();
let _nextScopeId = 1;

/** Install the "which app is running this code" question. Server side, once.
 *  @internal */
export function _setDiagScope(get: (() => object | undefined) | null): void {
  _scopeGetter = get;
}

/** The app scope running this code right now, or `undefined` outside any app.
 *  An opaque identity — compare it, never read it. @internal */
export function _diagScopeNow(): object | undefined {
  return _scopeGetter?.() ?? undefined;
}

/** The app scope `event` was emitted in, or `undefined` when it was emitted
 *  outside any app. @internal */
export function _diagEventScope(event: DiagnosticEvent): object | undefined {
  return _eventScope.get(event);
}

function _dedupKey(type: string, scope: object | undefined): string {
  if (scope === undefined) return type;
  let id = _scopeIds.get(scope);
  if (id === undefined) _scopeIds.set(scope, id = _nextScopeId++);
  return `${id}\u0000${type}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reset all state and set dev mode.
 * Must be called before any other diagnostic function.
 */
export function initDiagnosticBus(
  dev: boolean,
  opts: { keepListeners?: boolean } = {},
): void {
  // The MODE is a process fact, and a process can host several apps (library
  // mode, `testApps`). Last-writer-wins meant a prod app booting beside a dev
  // app switched the DEV app's bus off — its diagnostics stopped with no line
  // anywhere. An app joining (`keepListeners`, the server's call) can only
  // turn the bus ON for the process; a full reset still sets it outright. The
  // bus is observe-only, so a prod app sharing a dev app's process emitting
  // diagnostics too is the harmless direction of the two.
  _dev = opts.keepListeners && _appJoined ? _dev || dev : dev;
  _appJoined = opts.keepListeners === true;
  _ring = new Array(RING_CAP);
  _head = 0;
  _count = 0;
  // `keepListeners` exists because this function does two jobs: it SETS THE
  // MODE (which the server does, late in boot, once it knows `prod`) and it
  // RESETS THE BUS (which a test does, to isolate itself). Doing both
  // unconditionally silently unsubscribed everything registered earlier — and
  // the earliest subscriber is `initDiagnostics`'s bridge to the structured
  // logger, so a vitals alert reached no log file at all: not app.log, not
  // warning.log, only the per-client dev file and the dev WS frame. In
  // production, where `diagEmit` is a no-op anyway, an alert had NO sink.
  //
  // Every bus test called this BEFORE subscribing, which is the reverse of the
  // product's order — so no test could see it.
  if (!opts.keepListeners) _listeners = new Set();
  _dedup = new Map();
  _suppressed = new Map();
  _broken = new WeakSet();
}

/** Returns whether diagnostic bus is in dev mode */
export function isDiagDev(): boolean {
  return _dev;
}

/**
 * Emit a diagnostic event.
 * No-op in prod mode. Applies dedup, inserts into ring buffer, notifies listeners.
 */
export function diagEmit(event: Omit<DiagnosticEvent, "ts">): void {
  if (!_dev) {
    // Prod keeps ONE path: an error, to the listeners that asked for it
    // (`prodErrors`). Feedback auto-capture is built on this bus, and with
    // the early return alone a shipped app — the one nobody watches — never
    // captured a report while the same fault did in dev.
    if (event.severity === "error") _emitProdError(event);
    return;
  }

  const now = Date.now();
  const scope = _diagScopeNow();
  // Per app: one app's event must not suppress another app's of the same type.
  const key = _dedupKey(event.type, scope);

  // Dedup check — suppress if same type seen within window
  const last = _dedup.get(key);
  if (last !== undefined && now - last < DEDUP_WINDOW_MS) {
    // Suppressed — but REMEMBER it. The next one through carries the count.
    _suppressed.set(key, (_suppressed.get(key) ?? 0) + 1);
    return;
  }
  _dedup.set(key, now);
  const swallowed = _suppressed.get(key) ?? 0;
  if (swallowed > 0) _suppressed.delete(key);

  // Prune stale entries when Map grows beyond threshold
  if (_dedup.size > 50) {
    for (const [t, ts] of _dedup) {
      if (now - ts > DEDUP_WINDOW_MS) {
        _dedup.delete(t);
        // A type nobody has emitted for a full window has no "next event" to
        // report on; drop its tally rather than leak the entry.
        _suppressed.delete(t);
      }
    }
  }

  const full: DiagnosticEvent = swallowed > 0
    ? { ...event, ts: now, suppressed: swallowed }
    : { ...event, ts: now };
  if (scope !== undefined) _eventScope.set(full, scope);

  // O(1) ring buffer insert
  _ring[_head] = full;
  _head = (_head + 1) % RING_CAP;
  if (_count < RING_CAP) _count++;

  // Notify listeners
  // AIO-273: snapshot before iteration to prevent skip/duplicate on subscribe/unsubscribe during notification
  const snapshot = [..._listeners];
  for (const fn of snapshot) {
    // Guarded per subscriber, for the same reason `mod.ts` guards each log
    // writer: one failing writer must not take out the others. Unguarded, a
    // throwing subscriber did BOTH the things this bus exists to prevent —
    // it escaped to diagEmit's caller (which is usually framework
    // error-handling code, so the report became a second failure), and it
    // skipped every subscriber registered after it. The live subscribers are
    // the structured logger, feedback auto-capture and the WS relay (file I/O
    // per connection), so one `writeClientLog` throw meant the diagnostic
    // reached neither app.log nor feedback.
    try {
      fn(full);
    } catch (err) {
      try {
        _reportBrokenListener(fn, err);
      } catch {
        // aio-ok: the reporter's own sink is down — the fan-out still runs
      }
    }
  }
}

/** Subscribers whose failure has already been reported. A permanently broken
 *  subscriber fails on EVERY event, so reporting per event would turn one
 *  defect into a log flood — the noise that hides the next real diagnostic. */
let _broken = new WeakSet<DiagnosticListener>();

function _reportBrokenListener(fn: DiagnosticListener, err: unknown): void {
  if (_broken.has(fn)) return;
  _broken.add(fn);
  const what = err instanceof Error ? (err.stack ?? err.message) : String(err);
  // Through the logger, at ERROR: a subscriber that silently stops receiving
  // diagnostics is exactly the failure this bus exists to surface, so the line
  // has to carry a level and reach error.log — not just a terminal someone
  // may or may not be watching (`tests/every-message-has-a-level.test.ts`).
  log.error(
    `[aio] a diagnostic subscriber threw and was skipped for this and every ` +
      `later event (reported once): ${what}\n` +
      `Cause: diagSubscribe() callbacks run inside diagEmit, on the emitter's ` +
      `stack. Fix: make the subscriber total — wrap its own I/O in try/catch ` +
      `— or unsubscribe it; the events it drops are not replayed.`,
  );
}

/** Listeners that receive `severity: "error"` events in prod too. */
const _prodErrorListeners = new WeakSet<DiagnosticListener>();

/** The prod path of `diagEmit`: no ring, no dedup (the one caller dedups
 *  itself), only the listeners that opted in — each guarded, as in dev. */
function _emitProdError(event: Omit<DiagnosticEvent, "ts">): void {
  const full: DiagnosticEvent = { ...event, ts: Date.now() };
  const scope = _diagScopeNow();
  if (scope !== undefined) _eventScope.set(full, scope);
  for (const fn of [..._listeners]) {
    if (!_prodErrorListeners.has(fn)) continue;
    try {
      fn(full);
    } catch (err) {
      try {
        _reportBrokenListener(fn, err);
      } catch {
        // aio-ok: the reporter's own sink is down — the fan-out still runs
      }
    }
  }
}

/**
 * Subscribe to diagnostic events.
 * Returns an unsubscribe function.
 *
 * `prodErrors`: also receive `severity: "error"` events in prod, where the
 * bus is otherwise off.
 */
export function diagSubscribe(
  fn: DiagnosticListener,
  opts: { prodErrors?: boolean } = {},
): () => void {
  _listeners.add(fn);
  if (opts.prodErrors) _prodErrorListeners.add(fn);
  return () => {
    _listeners.delete(fn);
  };
}

/** Expose dedup map size for testing (not part of public API) */
export function _diagDedupSize(): number {
  return _dedup.size;
}

/**
 * Return all stored events in chronological order (oldest → newest).
 * Reconstructs order from ring buffer in O(n).
 *
 * Asked from inside an app, only that app's events and the unscoped ones: a
 * feedback report (the reader of this) attached another app's crash to this
 * app's report, beside this app's state.
 */
export function diagRecent(): DiagnosticEvent[] {
  if (_count === 0) return [];

  const out: DiagnosticEvent[] = new Array(_count);
  if (_count < RING_CAP) {
    // Buffer not yet full — events are at indices 0.._count-1 in order
    for (let i = 0; i < _count; i++) {
      out[i] = _ring[i]!;
    }
  } else {
    // Buffer full — oldest entry is at _head, wraps around
    for (let i = 0; i < RING_CAP; i++) {
      out[i] = _ring[(_head + i) % RING_CAP]!;
    }
  }
  const now = _diagScopeNow();
  if (now === undefined) return out;
  return out.filter((e) => {
    const from = _eventScope.get(e);
    return from === undefined || from === now;
  });
}
