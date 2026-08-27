import { log } from "../diagnostics/logger-api.ts";

// Reactive signal system for AIO renderer.
// Provides: signal, computed, effect, batch — auto-tracked dependencies.

// ── Types ───────────────────────────────────────────────────────────

/** Reactive value container — reads auto-track in effects and computed. */
export interface Signal<T> {
  /** Tracked read, the call spelling — identical to {@linkcode value} and
   *  {@linkcode get}.
   *
   *  It exists because it is the spelling people write FIRST and the compiler
   *  answered with "Type 'Signal<Tab>' has no call signatures", which names
   *  neither working alternative. That was reported once, answered by adding
   *  `.get()` and documenting both — and then reported again, by a different
   *  app, hitting the identical wall. The second report is the evidence: a
   *  spelling that everybody reaches for is not a mistake to be corrected by
   *  documentation, it is a missing feature. */
  (): T;
  readonly value: T;
  /** Tracked read — the exact same thing as {@linkcode value}, spelled as the
   *  mirror of {@linkcode set}.
   *
   *  Two spellings, one operation, on purpose: `.value` reads best inside JSX
   *  (`{count.value}`), `.get()` reads best in code that also writes
   *  (`count.set(count.get() + 1)`). A field report landed on `.value` only
   *  after `now.get()` and `now()` both failed to compile — "three shapes for
   *  two operations", with the type error naming neither alternative. The read
   *  a developer reaches for first now exists; {@linkcode peek} stays the
   *  UNtracked read. */
  get(): T;
  set(next: T, opts?: { force?: boolean }): void;
  update(fn: (prev: T) => T): void;
  peek(): T;
  subscribe(fn: () => void): () => void;
  /** @internal */ readonly _subscribers: Set<Subscriber>;
  /** @internal */ readonly _version: number;
  /** Debug name for devtools (optional). */
  readonly _name?: string;
}

/** Derived reactive value — recomputes lazily when dependencies change. */
export interface Computed<T> {
  /** Tracked read, the call spelling — identical to {@linkcode value} and
   *  {@linkcode get}. A computed answers every spelling a signal does;
   *  nothing is more surprising than a read API that works on one and not the
   *  other. */
  (): T;
  readonly value: T;
  /** Tracked read — identical to {@linkcode value}, so a computed answers the
   *  same two spellings a signal does (nothing is more surprising than a read
   *  API that works on one and not the other). */
  get(): T;
  peek(): T;
  /** @internal */ readonly _subscribers: Set<Subscriber>;
}

/** @internal two-phase subscriber: prepare (cleanup) then execute (re-run).
 *  A subscriber with `invalidate` is an eager link (a computed's dependency
 *  edge): on a dependency change it is invalidated *synchronously* rather than
 *  queued, so dirty flags propagate through the whole computed graph before any
 *  effect re-runs. Subscribers without `invalidate` (effects, external
 *  subscribers) are queued for the next flush. */
interface Subscriber {
  prepare?: () => void;
  execute: () => void;
  invalidate?: () => void;
  /** Set by every unsubscribe path. A flush SNAPSHOTS the pending set before
   *  running it, so a subscriber that unsubscribed during phase 1 (or during
   *  an earlier subscriber's phase 2) was still run from that snapshot: an
   *  unmounted component's callback firing after it was torn down, reading
   *  state it no longer belongs to. Unsubscribing has to cancel the
   *  notification already in the queue, not just future ones. */
  dead?: boolean;
}

type CleanupFn = () => void;

// ── Tracking context ────────────────────────────────────────────────

const _trackStack: Set<SignalImpl<unknown>>[] = [];

/** @internal Begin dependency tracking — returns the set that collects accessed signals. */
export function _trackStart(): Set<SignalImpl<unknown>> {
  const deps = new Set<SignalImpl<unknown>>();
  _trackStack.push(deps);
  return deps;
}

/** @internal End dependency tracking — validates and pops the tracking stack. */
export function _trackEnd(
  deps: Set<SignalImpl<unknown>>,
): Set<SignalImpl<unknown>> {
  const popped = _trackStack.pop();
  if (popped !== deps) {
    // An INTERNAL invariant of the renderer's dependency tracking: every
    // `_trackStart()` is popped by its own `_trackEnd()`, in order. Nothing an
    // app writes can reach this — it means aio itself unbalanced the stack.
    // The old text ("Signal tracking stack mismatch") sent readers hunting
    // through their own components for a mistake that is not there.
    throw new Error(
      "[aio] internal invariant broken: the signal tracking stack was popped " +
        "out of order (_trackEnd received a frame that is not the one " +
        "_trackStart pushed). This is an aio bug, not yours — please report " +
        "it at https://github.com/riagentic/aio/issues with the component or " +
        "cell method that was rendering when it happened.",
    );
  }
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

/** @internal How many tracking scopes are open. A render that finishes — or
 *  that THROWS and unwinds — must leave this at the depth it started, or the
 *  next component's signal reads are collected into a dead component's
 *  dependency set: one scope silently subscribing on another's behalf.
 *
 *  Exposed only so the invariant can be ASSERTED (tests/scope-isolation).
 *  The discipline itself is real — the throw path unwinds through
 *  `abortComponent` — but it is spread across five render paths that each
 *  have to remember it, and nothing checked that they all do. */
export function _openScopeDepth(): {
  track: number;
  computed: boolean;
  effect: boolean;
} {
  return {
    track: _trackStack.length,
    computed: _computedCollectors.length > 0,
    effect: _effectCollectors.length > 0,
  };
}

function _currentTracker(): Set<SignalImpl<unknown>> | undefined {
  return _trackStack[_trackStack.length - 1];
}

// ── Dev mode ────────────────────────────────────────────────────────

let _devMode = false;
/** Enable dev-mode signal tracing (console warnings for skipped updates). */
export function _setSignalDevMode(v: boolean): void {
  _devMode = v;
}

// ── Batching ────────────────────────────────────────────────────────

let _batchDepth = 0;
const _pendingSubscribers = new Set<Subscriber>();

/** Group multiple signal writes into one flush — subscribers notified once at the end. */
export function batch(fn: () => void): void {
  _batchDepth++;
  try {
    fn();
  } finally {
    _batchDepth--;
    // Flush even when fn() THREW. The writes it made before throwing are
    // already committed — the signals hold the new values — so skipping the
    // flush does not undo anything, it only hides it: subscribers stay queued
    // and the view keeps rendering pre-write state until some unrelated later
    // write happens to flush them. Every DOM event handler and every
    // server-state apply runs inside a batch (vdom-props.ts,
    // state-signals.ts, state-message.ts), and the delta path CATCHES the
    // throw and asks for a resync whose identical values are then skipped by
    // `Object.is` — a permanently stale UI with nothing logged. "Value
    // changed ⇒ subscribers told" must hold on every exit path; subscriber
    // errors are contained inside _flush, so the original exception still
    // propagates.
    if (_batchDepth === 0) _flush();
  }
}

const _FLUSH_MAX_ITERATIONS = 1000;
let _flushing = false;
let _flushIterations = 0;

function _flush(): void {
  if (_flushing) return; // re-entrant call — outer _flush will pick up new pending
  _flushing = true;
  _flushIterations = 0;
  try {
    while (_pendingSubscribers.size > 0) {
      if (++_flushIterations > _FLUSH_MAX_ITERATIONS) {
        log.warn(
          "signal",
          `_flush exceeded ${_FLUSH_MAX_ITERATIONS} iterations — possible infinite loop. ` +
            `${_pendingSubscribers.size} subscriber(s) still pending. ` +
            `Use signal(value, "name") for easier debugging. Remaining subscribers cleared.`,
        );
        _pendingSubscribers.clear();
        break;
      }
      const pending = [..._pendingSubscribers];
      _pendingSubscribers.clear();
      // Phase 1: prepare (cleanup). A cleanup that throws is REPORTED, never
      // allowed to cancel phase 2: skipping the re-run does not undo the
      // partial cleanup, it only leaves the subscriber showing the value from
      // before the write while the signal already holds the new one — the
      // stale-view failure, arrived at silently. (Measured with a
      // consistently-throwing cleanup: the effect ran on every OTHER write.)
      // "Value changed ⇒ subscribers told" holds on every path.
      for (const sub of pending) {
        if (sub.dead) continue;
        if (sub.prepare) {
          try {
            sub.prepare();
          } catch (e) {
            log.error("signal", "effect cleanup error:", {
              detail: String(e),
            });
          }
        }
      }
      // Phase 2: execute (re-run)
      for (const sub of pending) {
        if (sub.dead) continue; // unsubscribed since the snapshot was taken
        try {
          sub.execute();
        } catch (e) {
          log.error("signal", "effect execute error:", {
            detail: String(e),
          });
        }
      }
    }
  } finally {
    _flushing = false;
  }
}

/** Cancel a subscriber's pending notification as well as its future ones.
 *  Both halves, or "unsubscribed" only means "from now on, mostly". */
function _retire(sub: Subscriber): void {
  sub.dead = true;
  _pendingSubscribers.delete(sub);
}

/** Propagate a dependency change to its subscribers. Computed links carry an
 *  `invalidate` and are run *synchronously* (marking the whole computed graph
 *  dirty before any effect reads it — glitch-free, B-2). Plain subscribers
 *  (effects, external) are queued for the next flush. */
function _propagate(subscribers: Set<Subscriber>): void {
  // Snapshot: invalidate()/execute() may mutate the subscriber set.
  for (const sub of [...subscribers]) {
    if (sub.invalidate) sub.invalidate();
    else _pendingSubscribers.add(sub);
  }
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
/** Plain object check that survives cross-realm objects (iframes/Workers):
 *  accepts null prototypes and prototypes constructed by any realm's `Object`. */
function _isPlainObject(o: unknown): boolean {
  const proto = Object.getPrototypeOf(o);
  if (proto === null) return true;
  const ctor = (proto as { constructor?: unknown }).constructor;
  return typeof ctor === "function" &&
    (ctor as { name?: string }).name === "Object";
}

function _shallowEq(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    a === null || b === null || typeof a !== "object" || typeof b !== "object"
  ) return false;
  // AIO-364: Set/Map have no enumerable keys — Object.keys() would always say equal.
  // Treat every Set/Map assignment as potentially different so updates propagate.
  if (
    a instanceof Set || a instanceof Map || b instanceof Set || b instanceof Map
  ) {
    return false;
  }
  // Non-plain objects: Date, RegExp, typed arrays — Object.keys() returns [],
  // so two different instances would incorrectly compare equal.
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  if (a instanceof RegExp && b instanceof RegExp) {
    return a.source === b.source && a.flags === b.flags;
  }
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    if (a.byteLength !== b.byteLength) return false;
    const av = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const bv = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 0; i < av.length; i++) {
      if (av[i] !== bv[i]) return false;
    }
    return true;
  }
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
  // AIO-378: key-based comparison is only meaningful for plain objects. Class
  // instances hold state in private fields / prototype getters that
  // Object.keys() can't see, so two different instances would compare equal
  // and updates would be silently swallowed (same failure class as AIO-364).
  // Cross-realm duck-typing: "plain" = prototype is null or a prototype whose
  // own constructor is named "Object" (realm-independent).
  if (!_isPlainObject(a) || !_isPlainObject(b)) return false;
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

/** The instance side of a signal. Deliberately NOT `implements Signal<T>`:
 *  the public type is CALLABLE and a class cannot be, so the call spelling is
 *  grafted on by `_callable()` at construction. `signal()`'s return type is
 *  the contract; this class is the half of it a prototype can express. */
class SignalImpl<T> implements Omit<Signal<T>, never> {
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

  /** Tracked read — the method spelling of `.value` (see the interface). */
  get(): T {
    return this.value;
  }

  set(next: T, opts?: { force?: boolean }): void {
    const resolved = next;
    if (!opts?.force && Object.is(this._value, resolved)) {
      if (this._name && _devMode) {
        log.warn(
          `[aio] signal "${this._name}" update skipped (identical reference)`,
        );
      }
      return;
    }
    // AIO-59: shallow equality for objects/arrays — skip notification when all
    // values are identical by ===. Prevents infinite re-render loops when
    // signal.set({...same values...}) is called from rAF/effect callbacks.
    if (
      !opts?.force &&
      resolved !== null && typeof resolved === "object" &&
      _shallowEq(this._value, resolved)
    ) {
      if (this._name && _devMode) {
        log.warn(
          `signal "${this._name}" update skipped (shallow-equal)`,
        );
      }
      return;
    }
    this._value = resolved;
    this._version++;
    _propagate(this._subscribers);
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
      _retire(sub);
    };
  }
}

// ── Module-scope signals: the other half of test hermeticity ────────
//
// A cell is reset between tests; a module-level `signal()` was NOT, and the two
// look identical from a test. So the field saw "cells leak state between
// tests": a test that set `zoom`/`orientation` changed the meaning of a later
// test, showing up as an order-dependent failure that passes under --filter —
// the worst way to find anything. The harness is the strictest environment, so
// it has to reset every kind of state a test can write, not most of them.
//
// Only signals born OUTSIDE a render are recorded: a tracking scope is active
// exactly while a component body runs, so `useLocal`/`useRef(signal(…))` — the
// unbounded, per-instance ones — are skipped, and they are re-created by the
// next mount anyway. What remains is the module-level population: bounded by
// how many modules an app has. WeakRefs, so recording retains nothing, plus a
// cap so a pathological creator can never grow it without bound. Recording is
// unconditional (identical in dev and prod); only a test harness ever calls
// the reset.
type RootSignalEntry = { ref: WeakRef<SignalImpl<unknown>>; initial: unknown };
const _rootSignals: RootSignalEntry[] = [];
const ROOT_SIGNAL_CAP = 4096;

/** A fresh copy of a captured initial, so resetting twice cannot hand back an
 *  object a previous test mutated in place. Non-cloneable initials (functions,
 *  DOM nodes, class instances) fall back to the value itself. */
function _freshInitial(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  try {
    return structuredClone(v);
  } catch {
    return v;
  }
}

/** @internal Restore every module-scope signal to the value it was created
 *  with — test isolation for the state that does not live in a cell. Called by
 *  the harnesses (`testCell`, `testUI`, `bootCells`) at test START, so a test
 *  that crashed before teardown still cannot poison the next one. */
export function _resetRootSignals(): void {
  let live = 0;
  for (const entry of _rootSignals) {
    const sig = entry.ref.deref();
    if (!sig) continue;
    _rootSignals[live++] = entry;
    const fresh = _freshInitial(entry.initial);
    if (Object.is(sig._value, fresh)) continue;
    sig.set(fresh as never, { force: true });
  }
  _rootSignals.length = live; // compact away collected entries
}

/** Create a reactive signal with an initial value. Reads auto-track in effects and computed. */
/** Make an already-constructed signal/computed CALLABLE without splitting its
 *  state across two objects.
 *
 *  The instance's own fields are moved onto a function whose prototype is the
 *  original's, so every method and getter still resolves through the class and
 *  `instanceof` still holds — there is exactly one object, and calling it is
 *  the same tracked read as `.value`. */
function _callable<T, I extends object, O>(impl: I): O {
  const fn = function (this: unknown) {
    return (fn as unknown as { value: T }).value;
  } as unknown as O;
  Object.setPrototypeOf(fn, Object.getPrototypeOf(impl));
  for (const key of Reflect.ownKeys(impl)) {
    const d = Object.getOwnPropertyDescriptor(impl, key)!;
    // `name`/`length` exist on every function and are non-writable; redefining
    // is fine, skipping them would drop a real field of the same name.
    Object.defineProperty(fn, key, { ...d, configurable: true });
  }
  return fn;
}

/** Create a reactive value. Reads auto-track (`count()` / `count.value` /
 *  `count.get()` are one tracked read); write with `set`/`update`. A root
 *  (module-scope) signal is registered for test-harness reset, and an
 *  optional name feeds devtools + duplicate-update warnings. */
export function signal<T>(
  initial: T,
  nameOrOpts?: string | { name?: string },
): Signal<T> {
  const name = typeof nameOrOpts === "string" ? nameOrOpts : nameOrOpts?.name;
  const sig = _callable<T, SignalImpl<T>, Signal<T>>(
    new SignalImpl(initial, name),
  );
  if (_trackStack.length === 0 && _rootSignals.length < ROOT_SIGNAL_CAP) {
    _rootSignals.push({
      ref: new WeakRef(sig as unknown as SignalImpl<unknown>),
      initial: _freshInitial(initial),
    });
  }
  return sig;
}

// ── Computed ────────────────────────────────────────────────────────

const _computing = new Set<ComputedImpl<unknown>>();

class ComputedImpl<T> {
  private _fn: () => T;
  private _cached: T | undefined;
  private _dirty = true;
  private _deps = new Set<SignalImpl<unknown>>();
  private _unsubs: CleanupFn[] = [];
  readonly _subscribers = new Set<Subscriber>();
  private _disposed = false;

  constructor(fn: () => T) {
    this._fn = fn;
    // Registration deliberately does NOT happen here — see `computed()`. The
    // object the renderer must be handed is the CALLABLE, not `this`.
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

  /** Tracked read — the method spelling of `.value` (see the interface). */
  get(): T {
    return this.value;
  }

  peek(): T {
    if (this._disposed) return this._cached as T;
    if (this._dirty) this._recompute();
    return this._cached as T;
  }

  private _recompute(): void {
    if (_computing.has(this as unknown as ComputedImpl<unknown>)) {
      throw new Error(
        "[aio:signal] Circular dependency in computed — it (directly or via other computeds) reads its own value. Break the cycle by deriving from source signals only.",
      );
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

    // Eager dependency link: when a dep changes, mark this computed dirty and
    // propagate *synchronously* — recursing into dependent computeds and
    // queueing dependent effects. This guarantees a same-batch read after the
    // write never sees a stale-clean computed (B-2). Recompute stays lazy.
    const link: Subscriber = {
      execute: () => {}, // never queued — invalidation is eager
      invalidate: () => {
        if (!this._dirty) {
          this._dirty = true;
          _propagate(this._subscribers);
        }
      },
    };
    for (const dep of deps) {
      dep._subscribers.add(link);
      this._unsubs.push(() => dep._subscribers.delete(link));
    }
  }
}

/** Create a derived signal that recomputes when its dependencies change. */
export function computed<T>(fn: () => T): Computed<T> {
  const c = _callable<T, ComputedImpl<T>, Computed<T>>(new ComputedImpl(fn));
  // Register the CALLABLE, never the instance. `_callable` COPIES the
  // instance's own fields onto a new function object, and `_recompute`
  // reassigns `_unsubs`/`_deps` on whichever object it runs against — the
  // callable, since that is the only object anyone ever holds. Registering
  // `this` from the constructor (as this did) handed the renderer a hollow
  // twin: `dispose()` walked ITS `_unsubs`, which stayed the empty array from
  // construction, so every dependency link survived the dispose. Measured: 5
  // render rounds left 5 permanent subscribers on the source signal, each
  // retaining its render closure, and every later write walked a set that only
  // ever grows. `_subscribers` is shared by reference (one Set), which is
  // exactly why the leak was invisible from the outside.
  if (_computedCollectors.length > 0) {
    _computedCollectors[_computedCollectors.length - 1]!.push(
      c as unknown as Disposable,
    );
  }
  return c;
}

// ── Computed collector (for renderer cleanup) ────────────────────────

/** Opaque disposable handle returned by the collector. */
export type Disposable = { dispose(): void };

/** A STACK, mirroring `_trackStack`, not a single slot.
 *
 *  Component renders nest: `beforeComponent`/`afterComponent` open and close a
 *  collection scope per component, and a child renders inside its parent's
 *  open scope. With one slot the child's `Start` overwrote the parent's and the
 *  child's `End` set the slot to `null`, so every computed the PARENT created
 *  after its first child was collected by nobody — never disposed, and its
 *  dependency links outlived the component. The dependency tracker next door
 *  has been a stack all along; these two were the odd ones out. */
const _computedCollectors: Disposable[][] = [];

/** Remove `list` from a collector stack, tolerating (but reporting) an
 *  out-of-order close. Unlike `_trackEnd` this repairs rather than throws:
 *  these lists also carry DISPOSAL, so unwinding a render on a bookkeeping
 *  mismatch would leak the very computeds/effects the close exists to free. */
function _popCollector<T>(stack: T[][], list: T[], kind: string): void {
  const top = stack.length - 1;
  if (top >= 0 && stack[top] === list) {
    stack.pop();
    return;
  }
  const i = stack.lastIndexOf(list);
  if (i < 0) return; // already closed — idempotent, nothing to repair
  stack.splice(i, 1);
  log.error(
    "signal",
    `${kind} collector closed out of order — ${
      stack.length - i
    } inner scope(s) were still open. ` +
      `A render path opened a collection scope and did not close it; the ` +
      `stack was repaired, but the inner scopes' computeds/effects may now be ` +
      `attributed to the wrong component. Check that every _${kind}CollectStart ` +
      `has a matching End on BOTH the success and throw paths.`,
  );
}

/** Start collecting computed instances created during a render pass. */
export function _computedCollectStart(): Disposable[] {
  const list: Disposable[] = [];
  _computedCollectors.push(list);
  return list;
}

/** Stop collecting and return the collected computeds. */
export function _computedCollectEnd(list: Disposable[]): void {
  _popCollector(_computedCollectors, list, "computed");
}

/** Dispose all computeds in a list (cleanup on re-render). */
export function _computedDisposeAll(list: Disposable[]): void {
  try {
    for (const c of list) {
      try {
        c.dispose();
      } catch (e) {
        log.error("signal", "computed dispose error:", {
          detail: String(e),
        });
      }
    }
  } finally {
    list.length = 0;
  }
}

// ── Effect collector (for renderer auto-dispose) ─────────────────────

/** A stack, for the same reason as `_computedCollectors`. */
const _effectCollectors: (() => void)[][] = [];

/** Start collecting effect dispose functions created during a render pass. */
export function _effectCollectStart(): (() => void)[] {
  const list: (() => void)[] = [];
  _effectCollectors.push(list);
  return list;
}

/** Stop collecting effect dispose functions. */
export function _effectCollectEnd(list: (() => void)[]): void {
  _popCollector(_effectCollectors, list, "effect");
}

/** Dispose all collected effects (cleanup on unmount or re-render). */
export function _effectDisposeAll(list: (() => void)[]): void {
  try {
    for (const dispose of list) {
      try {
        dispose();
      } catch (e) {
        log.error("signal", "effect dispose error:", { detail: String(e) });
      }
    }
  } finally {
    list.length = 0;
  }
}

// ── Effect ──────────────────────────────────────────────────────────

/** Run a side-effect that re-executes when its tracked signals change; returns a dispose function. */
export function effect(fn: () => void | CleanupFn): CleanupFn {
  let cleanup: CleanupFn | void;
  let unsubs: CleanupFn[] = [];
  let disposed = false;

  const sub: Subscriber = {
    prepare: () => {
      if (disposed) return;
      // Clear FIRST, then run. A cleanup that throws used to leave itself
      // installed: `cleanup = undefined` sat after the call, so the next flush
      // ran the same throwing cleanup again, phase 1 failed again, and the
      // effect's execute was skipped forever — one bad cleanup wedged the
      // effect permanently, with only a log line to show for it.
      const c = cleanup;
      cleanup = undefined;
      if (c) c();
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
        // Re-subscribe on EVERY exit path, including the throw. This used to
        // sit after the try, so an effect body that threw once had already
        // dropped every old subscription and never took a new one: it was
        // silently unlinked from the graph and could not run again for the
        // life of the page (the throw itself is reported by `_flush`, which
        // made it look survivable). The deps collected before the throw are
        // the ones it read; keeping them means the next change re-runs it.
        // AIO-188: fn() may have called dispose() (self-dispose) — an effect
        // that disposed itself must not re-subscribe.
        if (!disposed) {
          for (const dep of deps) {
            dep._subscribers.add(sub);
            unsubs.push(() => dep._subscribers.delete(sub));
          }
        }
      }
    },
  };

  // Initial run (no prepare needed)
  sub.execute();

  const dispose = () => {
    if (disposed) return; // idempotent
    disposed = true;
    _retire(sub);
    const c = cleanup;
    cleanup = undefined;
    try {
      if (c) c();
    } finally {
      // Unlinking is NOT optional. Before this `finally`, a cleanup that threw
      // during dispose skipped the unsubscribe loop entirely, so a disposed
      // effect kept every dependency link — the component was gone and its
      // effect still ran on every write.
      for (const unsub of unsubs) unsub();
      unsubs = [];
    }
  };

  // Register with effect collector if active (renderer auto-dispose)
  if (_effectCollectors.length > 0) {
    _effectCollectors[_effectCollectors.length - 1]!.push(dispose);
  }

  return dispose;
}
