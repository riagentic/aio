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

/** Listener set — O(1) add/delete */
let _listeners: Set<DiagnosticListener> = new Set();

/** Dedup map: event type → last-emitted timestamp (ms) */
let _dedup: Map<string, number> = new Map();
/** Per-type count of events the window swallowed since the last one emitted.
 *  Reported on the next event of that type, then cleared — so nothing new is
 *  emitted (the volume control stays exactly as strict) and nothing is lost. */
let _suppressed: Map<string, number> = new Map();

const DEDUP_WINDOW_MS = 5_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reset all state and set dev mode.
 * Must be called before any other diagnostic function.
 */
export function initDiagnosticBus(dev: boolean): void {
  _dev = dev;
  _ring = new Array(RING_CAP);
  _head = 0;
  _count = 0;
  _listeners = new Set();
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
  if (!_dev) return;

  const now = Date.now();

  // Dedup check — suppress if same type seen within window
  const last = _dedup.get(event.type);
  if (last !== undefined && now - last < DEDUP_WINDOW_MS) {
    // Suppressed — but REMEMBER it. The next one through carries the count.
    _suppressed.set(event.type, (_suppressed.get(event.type) ?? 0) + 1);
    return;
  }
  _dedup.set(event.type, now);
  const swallowed = _suppressed.get(event.type) ?? 0;
  if (swallowed > 0) _suppressed.delete(event.type);

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
      } catch { /* the reporter's own sink is down — the fan-out still runs */ }
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

/**
 * Subscribe to diagnostic events.
 * Returns an unsubscribe function.
 */
export function diagSubscribe(fn: DiagnosticListener): () => void {
  _listeners.add(fn);
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
  return out;
}
