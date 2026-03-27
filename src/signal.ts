// Reactive signal system for AIO renderer.
// Provides: signal, computed, effect, batch — auto-tracked dependencies.

// ── Types ───────────────────────────────────────────────────────────

export interface Signal<T> {
  readonly value: T;
  set(next: T): void;
  peek(): T;
  subscribe(fn: () => void): () => void;
  /** @internal */ readonly _subscribers: Set<Subscriber>;
  /** @internal */ readonly _version: number;
}

export interface Computed<T> {
  readonly value: T;
  peek(): T;
  /** @internal */ readonly _subscribers: Set<Subscriber>;
}

/** @internal two-phase subscriber: prepare (cleanup) then execute (re-run) */
interface Subscriber {
  prepare?: () => void;
  execute: () => void;
}

type CleanupFn = () => void;

// ── Tracking context ────────────────────────────────────────────────

const _trackStack: Set<SignalImpl<unknown>>[] = [];

export function _trackStart(): Set<SignalImpl<unknown>> {
  const deps = new Set<SignalImpl<unknown>>();
  _trackStack.push(deps);
  return deps;
}

export function _trackEnd(
  deps: Set<SignalImpl<unknown>>,
): Set<SignalImpl<unknown>> {
  const popped = _trackStack.pop();
  if (popped !== deps) throw new Error("Signal tracking stack mismatch");
  return deps;
}

function _currentTracker(): Set<SignalImpl<unknown>> | undefined {
  return _trackStack[_trackStack.length - 1];
}

// ── Batching ────────────────────────────────────────────────────────

let _batchDepth = 0;
const _pendingSubscribers = new Set<Subscriber>();

export function batch(fn: () => void): void {
  _batchDepth++;
  try {
    fn();
  } finally {
    _batchDepth--;
    if (_batchDepth === 0) _flush();
  }
}

function _flush(): void {
  while (_pendingSubscribers.size > 0) {
    const pending = [..._pendingSubscribers];
    _pendingSubscribers.clear();
    // Phase 1: prepare (cleanup) — all subscribers
    for (const sub of pending) {
      if (sub.prepare) sub.prepare();
    }
    // Phase 2: execute (re-run) — all subscribers
    for (const sub of pending) {
      sub.execute();
    }
  }
}

function _notify(subscribers: Set<Subscriber>): void {
  const snapshot = [...subscribers];
  for (const sub of snapshot) {
    _pendingSubscribers.add(sub);
  }
  if (_batchDepth === 0) _flush();
}

// ── Signal ──────────────────────────────────────────────────────────

class SignalImpl<T> implements Signal<T> {
  _value: T;
  readonly _subscribers = new Set<Subscriber>();
  _version = 0;

  constructor(initial: T) {
    this._value = initial;
  }

  get value(): T {
    const tracker = _currentTracker();
    if (tracker) tracker.add(this as SignalImpl<unknown>);
    return this._value;
  }

  set(next: T): void {
    if (Object.is(this._value, next)) return;
    if (_batchDepth > 0) {
      // Inside batch: just update value and queue subscribers for later
      this._value = next;
      this._version++;
      const snapshot = [...this._subscribers];
      for (const sub of snapshot) {
        _pendingSubscribers.add(sub); // Set deduplicates by identity
      }
    } else {
      // Outside batch: run prepare (cleanup) BEFORE value update
      const snapshot = [...this._subscribers];
      for (const sub of snapshot) {
        if (sub.prepare) sub.prepare();
      }
      // Update value
      this._value = next;
      this._version++;
      // Run executions
      for (const sub of snapshot) {
        sub.execute();
      }
    }
  }

  peek(): T {
    return this._value;
  }

  subscribe(fn: () => void): () => void {
    const sub: Subscriber = { execute: fn };
    this._subscribers.add(sub);
    return () => {
      this._subscribers.delete(sub);
    };
  }
}

export function signal<T>(initial: T): Signal<T> {
  return new SignalImpl(initial);
}

// ── Computed ────────────────────────────────────────────────────────

class ComputedImpl<T> implements Computed<T> {
  private _fn: () => T;
  private _cached: T | undefined;
  private _dirty = true;
  private _deps = new Set<SignalImpl<unknown>>();
  private _unsubs: CleanupFn[] = [];
  readonly _subscribers = new Set<Subscriber>();
  private _disposed = false;

  constructor(fn: () => T) {
    this._fn = fn;
    // Register with active computed collector (for renderer cleanup)
    if (_computedCollector) _computedCollector.push(this);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    for (const unsub of this._unsubs) unsub();
    this._unsubs = [];
    this._deps.clear();
    this._subscribers.clear();
  }

  get value(): T {
    const tracker = _currentTracker();
    if (tracker) tracker.add(this as unknown as SignalImpl<unknown>);
    if (this._dirty) this._recompute();
    return this._cached as T;
  }

  peek(): T {
    if (this._dirty) this._recompute();
    return this._cached as T;
  }

  private _recompute(): void {
    for (const unsub of this._unsubs) unsub();
    this._unsubs = [];
    this._deps.clear();

    const deps = _trackStart();
    try {
      this._cached = this._fn();
    } finally {
      _trackEnd(deps);
    }

    this._dirty = false;
    this._deps = deps;

    const markDirtySub: Subscriber = {
      execute: () => {
        if (!this._dirty) {
          this._dirty = true;
          _notify(this._subscribers);
        }
      },
    };
    for (const dep of deps) {
      dep._subscribers.add(markDirtySub);
      this._unsubs.push(() => dep._subscribers.delete(markDirtySub));
    }
  }
}

export function computed<T>(fn: () => T): Computed<T> {
  return new ComputedImpl(fn);
}

// ── Computed collector (for renderer cleanup) ────────────────────────

/** Opaque disposable handle returned by the collector. */
export type Disposable = { dispose(): void };

let _computedCollector: Disposable[] | null = null;

/** Start collecting computed instances created during a render pass. */
export function _computedCollectStart(): Disposable[] {
  const list: Disposable[] = [];
  _computedCollector = list;
  return list;
}

/** Stop collecting and return the collected computeds. */
export function _computedCollectEnd(list: Disposable[]): void {
  if (_computedCollector === list) _computedCollector = null;
}

/** Dispose all computeds in a list (cleanup on re-render). */
export function _computedDisposeAll(list: Disposable[]): void {
  for (const c of list) c.dispose();
  list.length = 0;
}

// ── Effect ──────────────────────────────────────────────────────────

export function effect(fn: () => void | CleanupFn): CleanupFn {
  let cleanup: CleanupFn | void;
  let unsubs: CleanupFn[] = [];
  let disposed = false;

  const sub: Subscriber = {
    prepare: () => {
      if (disposed) return;
      if (cleanup) {
        cleanup();
        cleanup = undefined;
      }
    },
    execute: () => {
      if (disposed) return;
      // Unsubscribe old deps
      for (const unsub of unsubs) unsub();
      unsubs = [];

      const deps = _trackStart();
      try {
        cleanup = fn();
      } finally {
        _trackEnd(deps);
      }

      for (const dep of deps) {
        dep._subscribers.add(sub);
        unsubs.push(() => dep._subscribers.delete(sub));
      }
    },
  };

  // Initial run (no prepare needed)
  sub.execute();

  return () => {
    disposed = true;
    if (cleanup) {
      cleanup();
      cleanup = undefined;
    }
    for (const unsub of unsubs) unsub();
    unsubs = [];
  };
}
