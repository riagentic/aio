// Reactive signal system for AIO renderer.
// Provides: signal, computed, effect, batch — auto-tracked dependencies.

// ── Types ───────────────────────────────────────────────────────────

export interface Signal<T> {
  readonly value: T;
  set(next: T): void;
  update(fn: (prev: T) => T): void;
  peek(): T;
  subscribe(fn: () => void): () => void;
  /** @internal */ readonly _subscribers: Set<Subscriber>;
  /** @internal */ readonly _version: number;
  /** Debug name for devtools (optional). */
  readonly _name?: string;
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

/** Read signals without tracking — reads inside fn() will NOT create
 *  subscriptions in the current tracking context. */
export function untrack<T>(fn: () => T): T {
  const savedLen = _trackStack.length;
  const throwaway = new Set<SignalImpl<unknown>>();
  _trackStack.push(throwaway);
  let result: T;
  try {
    result = fn();
  } catch (err) {
    _trackStack.pop();
    throw err;
  }
  _trackStack.pop();
  if (_trackStack.length !== savedLen) {
    throw new Error("Signal tracking stack corrupted in untrack()");
  }
  return result;
}

function _currentTracker(): Set<SignalImpl<unknown>> | undefined {
  return _trackStack[_trackStack.length - 1];
}

// ── Batching ────────────────────────────────────────────────────────

let _batchDepth = 0;
const _pendingSubscribers = new Set<Subscriber>();

/** Group multiple signal writes into one flush — subscribers notified once at the end. */
export function batch(fn: () => void): void {
  _batchDepth++;
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
    throw e;
  } finally {
    _batchDepth--;
    if (!threw && _batchDepth === 0) _flush();
  }
}

const _FLUSH_MAX_ITERATIONS = 1000;
let _flushing = false;
let _flushIterations = 0;
const _inFlight = new Set<Subscriber>();

function _flush(): void {
  if (_flushing) return; // re-entrant call — outer _flush will pick up new pending
  _flushing = true;
  _flushIterations = 0;
  try {
    while (_pendingSubscribers.size > 0) {
      if (++_flushIterations > _FLUSH_MAX_ITERATIONS) {
        console.warn(
          `[aio:signal] _flush exceeded ${_FLUSH_MAX_ITERATIONS} iterations — possible infinite loop. ` +
            `${_pendingSubscribers.size} subscriber(s) still pending. ` +
            `Use signal(value, "name") for easier debugging. Remaining subscribers cleared.`,
        );
        _pendingSubscribers.clear();
        break;
      }
      const pending = [..._pendingSubscribers];
      _pendingSubscribers.clear();
      // Mark all as in-flight so re-entrant _notify skips them
      for (const sub of pending) _inFlight.add(sub);
      // Phase 1: prepare (cleanup) — track failures
      const phase1Failed = new Set<Subscriber>();
      for (const sub of pending) {
        if (sub.prepare) {
          try {
            sub.prepare();
          } catch (e) {
            console.error("[aio:signal] effect cleanup error:", e);
            phase1Failed.add(sub);
          }
        }
      }
      // Phase 2: execute (re-run) — skip those that failed phase 1
      for (const sub of pending) {
        if (phase1Failed.has(sub)) continue;
        try {
          sub.execute();
        } catch (e) {
          console.error("[aio:signal] effect execute error:", e);
        }
      }
      // Done with this batch
      for (const sub of pending) _inFlight.delete(sub);
    }
  } finally {
    _flushing = false;
  }
}

function _notify(subscribers: Set<Subscriber>): void {
  const snapshot = [...subscribers];
  for (const sub of snapshot) {
    // Skip if already being processed in this flush batch
    if (_inFlight.has(sub)) continue;
    _pendingSubscribers.add(sub);
  }
  if (_batchDepth === 0) _flush();
}

// ── Shallow equality (AIO-59) ──────────────────────────────────────

/** Shallow comparison for plain objects/arrays. Returns true if all keys/values
 *  match by Object.is (handles NaN correctly). Used by signal.set() to skip no-op
 *  updates that create new references but contain identical data (e.g. `{...state, count: 0}`
 *  when count was already 0).
 *
 *  Cross-realm safe: uses duck-typing (own enumerable keys) instead of prototype
 *  checks, so objects from iframes/Workers compare correctly even when their
 *  prototype chain differs from the main realm's Object.prototype. */
function _shallowEq(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
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
      if (!Object.is(aa[i], bb[i])) return false;
    }
    return true;
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  for (const k of ka) {
    if (!Object.hasOwn(objB, k) || !Object.is(objA[k], objB[k])) return false; // AIO-237: key-existence check
  }
  return true;
}

// ── Signal ──────────────────────────────────────────────────────────

class SignalImpl<T> implements Signal<T> {
  _value: T;
  readonly _subscribers = new Set<Subscriber>();
  _version = 0;
  _name?: string;

  constructor(initial: T, name?: string) {
    this._value = initial;
    this._name = name;
  }

  get value(): T {
    const tracker = _currentTracker();
    if (tracker) tracker.add(this as SignalImpl<unknown>);
    return this._value;
  }

  set(next: T): void {
    const resolved = next;
    if (Object.is(this._value, resolved)) return;
    // AIO-59: shallow equality for objects/arrays — skip notification when all
    // values are identical by ===. Prevents infinite re-render loops when
    // signal.set({...same values...}) is called from rAF/effect callbacks.
    if (
      resolved !== null && typeof resolved === "object" &&
      _shallowEq(this._value, resolved)
    ) return;
    this._value = resolved;
    this._version++;
    for (const sub of this._subscribers) {
      _pendingSubscribers.add(sub);
    }
    if (_batchDepth === 0) _flush();
  }

  /** Update value using a function of the previous value. */
  update(fn: (prev: T) => T): void {
    this.set(fn(this._value));
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

/** Create a reactive signal with an initial value. Reads auto-track in effects and computed. */
export function signal<T>(
  initial: T,
  nameOrOpts?: string | { name?: string },
): Signal<T> {
  const name = typeof nameOrOpts === "string" ? nameOrOpts : nameOrOpts?.name;
  return new SignalImpl(initial, name);
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
    if (this._disposed) return this._cached as T;
    const tracker = _currentTracker();
    if (tracker) tracker.add(this as unknown as SignalImpl<unknown>);
    if (this._dirty) this._recompute();
    return this._cached as T;
  }

  peek(): T {
    if (this._disposed) return this._cached as T;
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
      // AIO-258: delete first — if _trackEnd throws, _computing must still be cleaned
      _computing.delete(this as unknown as ComputedImpl<unknown>);
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
  try {
    for (const c of list) {
      try {
        c.dispose();
      } catch (e) {
        console.error("[aio:signal] computed dispose error:", e);
      }
    }
  } finally {
    list.length = 0;
  }
}

// ── Effect collector (for renderer auto-dispose) ─────────────────────

let _effectCollector: (() => void)[] | null = null;

/** Start collecting effect dispose functions created during a render pass. */
export function _effectCollectStart(): (() => void)[] {
  const list: (() => void)[] = [];
  _effectCollector = list;
  return list;
}

/** Stop collecting effect dispose functions. */
export function _effectCollectEnd(list: (() => void)[]): void {
  if (_effectCollector === list) _effectCollector = null;
}

/** Dispose all collected effects (cleanup on unmount or re-render). */
export function _effectDisposeAll(list: (() => void)[]): void {
  try {
    for (const dispose of list) {
      try {
        dispose();
      } catch (e) {
        console.error("[aio:signal] effect dispose error:", e);
      }
    }
  } finally {
    list.length = 0;
  }
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

      // AIO-188: fn() may have called dispose() (self-dispose).
      // Don't re-subscribe to deps if already disposed.
      if (disposed) return;

      for (const dep of deps) {
        dep._subscribers.add(sub);
        unsubs.push(() => dep._subscribers.delete(sub));
      }
    },
  };

  // Initial run (no prepare needed)
  sub.execute();

  const dispose = () => {
    disposed = true;
    if (cleanup) {
      cleanup();
      cleanup = undefined;
    }
    for (const unsub of unsubs) unsub();
    unsubs = [];
  };

  // Register with effect collector if active (renderer auto-dispose)
  if (_effectCollector) _effectCollector.push(dispose);

  return dispose;
}
