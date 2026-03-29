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

const _FLUSH_MAX_ITERATIONS = 100;
let _flushing = false;
let _flushIterations = 0;

function _flush(): void {
  if (_flushing) return; // re-entrant call — outer _flush will pick up new pending
  _flushing = true;
  _flushIterations = 0;
  while (_pendingSubscribers.size > 0) {
    if (++_flushIterations > _FLUSH_MAX_ITERATIONS) {
      console.warn(
        "[aio:signal] _flush exceeded 100 iterations — possible infinite loop. Remaining subscribers cleared.",
      );
      _pendingSubscribers.clear();
      break;
    }
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
  _flushing = false;
}

function _notify(subscribers: Set<Subscriber>): void {
  const snapshot = [...subscribers];
  for (const sub of snapshot) {
    _pendingSubscribers.add(sub);
  }
  if (_batchDepth === 0) _flush();
}

// ── Shallow equality (AIO-59) ──────────────────────────────────────

/** Shallow comparison for plain objects/arrays. Returns true if all keys/values
 *  match by ===. Used by signal.set() to skip no-op updates that create new
 *  references but contain identical data (e.g. `{...state, count: 0}` when count
 *  was already 0). */
function _shallowEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    a === null || b === null || typeof a !== "object" || typeof b !== "object"
  ) return false;
  const isArrA = Array.isArray(a);
  const isArrB = Array.isArray(b);
  if (isArrA !== isArrB) return false;
  if (isArrA) {
    const aa = a as unknown[], bb = b as unknown[];
    if (aa.length !== bb.length) return false;
    for (let i = 0; i < aa.length; i++) {
      if (aa[i] !== bb[i]) return false;
    }
    return true;
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  for (const k of ka) {
    if (objA[k] !== objB[k]) return false;
  }
  return true;
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
    // AIO-59: shallow equality for objects/arrays — skip notification when all
    // values are identical by ===. Prevents infinite re-render loops when
    // signal.set({...same values...}) is called from rAF/effect callbacks.
    if (
      next !== null && typeof next === "object" && _shallowEq(this._value, next)
    ) return;
    this._value = next;
    this._version++;
    for (const sub of this._subscribers) {
      _pendingSubscribers.add(sub);
    }
    if (_batchDepth === 0) _flush();
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

const _computing = new Set<ComputedImpl<unknown>>();

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
    if (_computing.has(this as unknown as ComputedImpl<unknown>)) {
      throw new Error("[aio:signal] Circular dependency detected in computed");
    }
    _computing.add(this as unknown as ComputedImpl<unknown>);

    for (const unsub of this._unsubs) unsub();
    this._unsubs = [];
    this._deps.clear();

    const deps = _trackStart();
    try {
      this._cached = this._fn();
    } finally {
      _trackEnd(deps);
      _computing.delete(this as unknown as ComputedImpl<unknown>);
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
