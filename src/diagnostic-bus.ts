// src/diagnostic-bus.ts — Lightweight diagnostic event bus
// Works in both Deno (server) and browser — no platform-specific APIs.

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
  /** Arbitrary structured detail (e.g. payload, feature id) */
  detail?: unknown;
  /** Unix ms timestamp — added by diagEmit */
  ts: number;
  /** Short actionable hint for the developer */
  hint?: string;
  /** Link to docs explaining the event */
  docLink?: string;
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
  if (last !== undefined && now - last < DEDUP_WINDOW_MS) return;
  _dedup.set(event.type, now);

  // Prune stale entries when Map grows beyond threshold
  if (_dedup.size > 50) {
    for (const [t, ts] of _dedup) {
      if (now - ts > DEDUP_WINDOW_MS) _dedup.delete(t);
    }
  }

  const full: DiagnosticEvent = { ...event, ts: now };

  // O(1) ring buffer insert
  _ring[_head] = full;
  _head = (_head + 1) % RING_CAP;
  if (_count < RING_CAP) _count++;

  // Notify listeners
  // AIO-273: snapshot before iteration to prevent skip/duplicate on subscribe/unsubscribe during notification
  const snapshot = [..._listeners];
  for (const fn of snapshot) {
    fn(full);
  }
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
