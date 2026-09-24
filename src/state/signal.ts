import { log } from "../diagnostics/logger-api.ts";
import { count } from "../diagnostics/fmt.ts";
import { isDevMode } from "./dev-flag.ts";
import { outsideServerOrigin } from "./call-origin.ts";

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

// ── Read scope ───────────────────────────────────────────────────────
// An opaque object naming WHOSE values a read may see right now — null
// everywhere but inside a server render given its own route (air/vdom-ssr.ts
// `_ssrIn`), where the route signals answer with that render's route.
//
// A read under a scope NEVER touches the global state of what it reads: a
// computed read there evaluates its function in a tracking frame of its own
// and caches the result PER SCOPE (`_scopedValue`) — its global cache, its
// dependency links, its dirty flag and its version are the global's alone. So
// a module-level `computed(() => routePath.value)` can neither leak one
// render's route into the next render or the global, nor serve the global
// into a render, nor lose (to a render that branched differently) a link an
// effect over it depends on. The flush runs subscribers with no scope: an
// effect is never part of a render. With no scope ever entered (every browser,
// every render without a route) the cost is one comparison per computed read.
let _readScope: object | null = null;

/** @internal Enter a read scope; returns the previous one, which the caller
 *  MUST restore in a `finally`. */
export function _enterReadScope(scope: object | null): object | null {
  const prev = _readScope;
  _readScope = scope;
  return prev;
}

/** @internal The read scope in effect (null: the globals). */
export function _readScopeNow(): object | null {
  return _readScope;
}

/** A value derived under one read scope, with what it read: plain signals by
 *  version, computeds by the `stamp` of their own entry in the same scope. An
 *  evaluation that THREW is an entry too — never fresh (re-evaluated on every
 *  read, as a global computed that threw is), but holding what it read before
 *  the throw: the sources whose change can make it succeed. */
type ScopedEntry = {
  value: unknown;
  error?: { thrown: unknown };
  deps: SignalImpl<unknown>[];
  versions: number[];
  stamp: number;
};
let _scopedStamps = 0;

/** The entry's value — or what its evaluation threw, rethrown. */
function _scopedValue(e: ScopedEntry): unknown {
  if (e.error) throw e.error.thrown;
  return e.value;
}

/** A dependency's freshness mark within `scope` — settling a computed's own
 *  scoped entry first, so the mark compared is the one a re-read would see
 *  (one that threw is re-evaluated, so its mark is new every time). */
function _scopedMark(d: SignalImpl<unknown>, scope: object): number {
  return d instanceof ComputedImpl
    ? (d as ComputedImpl<unknown>)._scopedEntry(scope).stamp
    : d._version;
}

/** Still what a re-evaluation in `scope` would produce? */
function _scopedFresh(e: ScopedEntry, scope: object): boolean {
  if (e.error) return false;
  for (let i = 0; i < e.deps.length; i++) {
    let mark: number;
    try {
      mark = _scopedMark(e.deps[i]!, scope);
    } catch {
      return false; // a cycle found on the way: re-evaluate (and throw)
    }
    if (mark !== e.versions[i]) return false;
  }
  return true;
}

/** Evaluate `fn` in `scope` in a tracking frame of its own; the entry — a
 *  throw included (see `ScopedEntry`). */
function _scopedEval(fn: () => unknown, scope: object): ScopedEntry {
  const deps = _trackStart();
  _scopedFrames.add(deps);
  let value: unknown;
  let error: ScopedEntry["error"];
  try {
    value = fn();
  } catch (thrown) {
    error = { thrown };
  } finally {
    _trackEnd(deps);
  }
  const list = [...deps];
  return {
    value,
    error,
    deps: list,
    versions: error ? [] : list.map((d) => _scopedMark(d, scope)),
    stamp: ++_scopedStamps,
  };
}

/** The tracking frames `_scopedEval` opened — a read tracked by one of these
 *  is a scoped derivation's, never a subscriber's. */
const _scopedFrames = new WeakSet<Set<SignalImpl<unknown>>>();

/** Per subscriber frame: the scoped entries already walked into it. An entry
 *  is one evaluation in one scope, so a re-evaluation (a write mid-render) is
 *  a new entry and is walked again; a frame is a fresh Set per run. */
const _walked = new WeakMap<Set<SignalImpl<unknown>>, WeakSet<ScopedEntry>>();
let _walks = 0;

/** @internal How many scoped entries `_trackScoped` has walked (a test pins
 *  that each is walked once per subscriber frame). */
// aio-ok: test seam — tests/signal-scope-differential.test.ts pins one walk per entry per frame
export function _scopedWalksNow(): number {
  return _walks;
}

/** Put a scoped read's entry `e` into the tracking frame open now. A scoped
 *  derivation's frame takes its deps as they are. A SUBSCRIBER's frame (an
 *  effect or a component tracking from inside a render — `renderToString(v,
 *  {route})` called from one) takes, transitively, every SOURCE this scope's
 *  evaluation read: the global computed it also holds may branch elsewhere
 *  (on the route), be unsettled, or have thrown, and would never pass on the
 *  write that changes what this scope saw. Each entry is walked once per
 *  frame — a frame reading many computeds over one shared subtree walks the
 *  subtree once. */
function _trackScoped(
  tracker: Set<SignalImpl<unknown>>,
  e: ScopedEntry,
  scope: object,
): void {
  if (_scopedFrames.has(tracker)) {
    for (const d of e.deps) tracker.add(d);
    return;
  }
  let seen = _walked.get(tracker);
  if (seen === undefined) {
    seen = new WeakSet();
    _walked.set(tracker, seen);
  }
  const todo = [e];
  for (let next = todo.pop(); next !== undefined; next = todo.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    _walks++;
    for (const d of next.deps) {
      tracker.add(d);
      const child = d instanceof ComputedImpl
        ? _scopedComputeds.get(scope)?.get(d)
        : undefined;
      if (child !== undefined) todo.push(child);
    }
  }
}

/** Told of each effect whose first run happened for a caller inside a read
 *  scope (the effect itself ran on the global route), with `reads(targets)`:
 *  did that run depend on one of `targets` — directly, or through the
 *  computeds (and trackedMemos) it read? air/router-core.ts names one that
 *  read the route there. Observe-only. */
type ScopedEffectHook = (
  reads: (targets: readonly object[]) => boolean,
) => void;
let _scopedEffectHook: ScopedEffectHook | null = null;

/** @internal Install the hook above (router-core, once). */
export function _setScopedEffectHook(fn: ScopedEffectHook | null): void {
  _scopedEffectHook = fn;
}

/** Does `deps` reach one of `targets` through the global computed graph? A
 *  signal is matched by its subscriber set (a callable shares its instance's).
 *  A computed is known by its `_deps` set, never by `instanceof ComputedImpl`:
 *  this runs from `effect()`, and naming the class here would pull all of
 *  `computed` into every bundle that uses only signals and effects. */
function _reaches(
  deps: Iterable<SignalImpl<unknown>>,
  targets: readonly object[],
): boolean {
  const want = new Set(
    targets.map((s) => (s as { _subscribers?: unknown })._subscribers),
  );
  const seen = new Set<unknown>();
  const todo = [...deps];
  for (let d = todo.pop(); d !== undefined; d = todo.pop()) {
    if (seen.has(d)) continue;
    seen.add(d);
    if (want.has(d._subscribers)) return true;
    const inner = (d as { _deps?: unknown })._deps;
    if (inner instanceof Set) {
      for (const x of inner as Set<SignalImpl<unknown>>) todo.push(x);
    }
  }
  return false;
}

/** Per scope: each computed's entry. Weak on the scope — a render's entries
 *  go with the render. */
const _scopedComputeds = new WeakMap<object, Map<object, ScopedEntry>>();

/** Read signals without tracking — reads inside fn() will NOT create
 *  subscriptions in the current tracking context. */
export function untrack<T>(fn: () => T): T {
  const savedLen = _trackStack.length;
  const throwaway = new Set<SignalImpl<unknown>>();
  // Under a read scope nobody subscribes through it: a derivation's frame.
  if (_readScope !== null) _scopedFrames.add(throwaway);
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

/** @internal Run `fn` as if no render or effect were tracking: the open
 *  scopes are set ASIDE (the stack is empty while `fn` runs), not covered by
 *  a throwaway frame the way {@link untrack} does. A cell method's dispatch
 *  uses this — a method body is not UI code, and code that asks "is a render
 *  tracking right now?" (the in-process worker-cell refusals) must hear "no"
 *  inside it, which a pushed frame would answer wrongly. Renders the commit
 *  triggers push and pop their own scopes on the empty stack. */
export function _outsideTracking<T>(fn: () => T): T {
  if (_trackStack.length === 0) return fn();
  const saved = _trackStack.splice(0);
  let result: T;
  try {
    result = fn();
  } catch (err) {
    _trackStack.splice(0, _trackStack.length, ...saved);
    throw err;
  }
  const leftOver = _trackStack.length;
  _trackStack.splice(0, _trackStack.length, ...saved);
  if (leftOver !== 0) {
    throw new Error("Signal tracking stack corrupted in _outsideTracking()");
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

/** Dev-mode signal tracing follows the one runtime flag — see dev-flag.ts. */

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
  // A subscriber is not its writer's continuation. Effects here are arbitrary
  // code — above all the RENDERER, which queues a component's re-render from
  // inside this loop — and the writer may be a cell method body, which the
  // framework runs inside a continuation-local server-origin scope so that a
  // sibling called after an `await` still counts as the server calling itself
  // (call-origin.ts). That scope reaches every continuation opened inside it,
  // so the queued re-render inherited it and a component body — client code in
  // every runtime — ran as "the server": a `<div>` calling a sealed cell
  // straight from a render was ALLOWED what the identical call from a click
  // handler is refused, and only when an ASYNC body happened to drive the
  // render. Leaving the scope here is the door back out, for the flush and for
  // everything it queues; a subscriber that really is server code re-enters
  // through the front door, because its dispatch runs the method body inside
  // `inServerOrigin` again. (tests/access-origin-boundaries.test.tsx)
  if (_readScope === null) outsideServerOrigin(_flushSubscribers);
  else {
    // …and out of any read scope, for the same reason: a subscriber is not
    // part of the render whose component wrote the signal ("Read scope").
    const scope = _enterReadScope(null);
    try {
      outsideServerOrigin(_flushSubscribers);
    } finally {
      _enterReadScope(scope);
    }
  }
}

function _flushSubscribers(): void {
  _flushing = true;
  _flushIterations = 0;
  try {
    while (_pendingSubscribers.size > 0) {
      if (++_flushIterations > _FLUSH_MAX_ITERATIONS) {
        log.warn(
          "signal",
          `_flush exceeded ${_FLUSH_MAX_ITERATIONS} iterations — possible infinite loop. ` +
            `${count(_pendingSubscribers.size, "subscriber")} still pending. ` +
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
          log.error(
            "signal",
            "an effect threw while re-running:",
            {
              detail: String(e),
            },
          );
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

  /** `.value` is read-only. Without this setter the write failed with the
   *  engine's "Cannot set property value … which has only a getter" — true,
   *  and silent about the fix (a field report: "Signal.value is read-only"
   *  cost a cycle). Same throw, in dev and prod; it just names the door. */
  set value(_next: T) {
    throw new TypeError(
      `[aio] signal${
        this._name ? ` "${this._name}"` : ""
      }.value is read-only — use .set(v) or .update((v) => next)`,
    );
  }

  /** Tracked read — the method spelling of `.value` (see the interface). */
  get(): T {
    return this.value;
  }

  set(next: T, opts?: { force?: boolean }): void {
    const resolved = next;
    if (!opts?.force && Object.is(this._value, resolved)) {
      // Only an OBJECT set to itself is worth a word: that is the
      // mutate-then-set bug, where the change never reaches a reader. A
      // primitive set to its current value (`count.set(0)` on reset) is an
      // ordinary idiom and already a no-op — warning taught apps to wrap every
      // set in `if (s.peek() !== v)` for nothing (a field report).
      if (
        this._name && isDevMode() &&
        typeof resolved === "object" && resolved !== null
      ) {
        // The logger prints the category it infers from the call site, so a
        // hand-written `[aio]` is a second prefix beside the real one.
        log.warn(
          `signal "${this._name}" update skipped (identical reference — ` +
            `mutating an object and setting the same one notifies nobody; ` +
            `set a copy)`,
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
      if (this._name && isDevMode()) {
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
  /** The last recompute THREW. A dirty computed ignores invalidation (it is
   *  already dirty), which is right after a clean run and wrong after a failed
   *  one: nothing downstream was told the value it read is now obtainable. */
  private _errored = false;
  private _deps = new Set<SignalImpl<unknown>>();
  private _unsubs: CleanupFn[] = [];
  readonly _subscribers = new Set<Subscriber>();
  /** Bumped when a recompute produces a different value — the same freshness
   *  stamp a signal carries, so a `trackedMemo` whose read set contains a
   *  computed can tell a moved dependency from an unmoved one. */
  _version = 0;
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

  /** A computed is derived: it has no value of its own to set. */
  set value(_next: T) {
    throw new TypeError(
      "[aio] computed(…).value is read-only — it is derived; change the " +
        "signals or cell state it reads",
    );
  }

  get value(): T {
    if (this._disposed) return this._cached as T;
    const tracker = _currentTracker();
    if (tracker) tracker.add(this as unknown as SignalImpl<unknown>);
    if (_readScope !== null) {
      const scope = _readScope;
      const e = this._scopedEntry(scope);
      // A SUBSCRIBER tracking it from inside a render must hear every write
      // that changes what the render read (`_trackScoped`).
      if (tracker && !_scopedFrames.has(tracker)) {
        _trackScoped(tracker, e, scope);
      }
      return _scopedValue(e) as T;
    }
    if (this._dirty) this._recompute();
    return this._cached as T;
  }

  /** Tracked read — the method spelling of `.value` (see the interface). */
  get(): T {
    return this.value;
  }

  peek(): T {
    if (this._disposed) return this._cached as T;
    if (_readScope !== null) {
      return _scopedValue(this._scopedEntry(_readScope)) as T;
    }
    if (this._dirty) this._recompute();
    return this._cached as T;
  }

  /** @internal This computed's value in read scope `scope` — evaluated once
   *  per scope while what it read is unchanged, and never through the global
   *  slot (see "Read scope"). */
  _scopedEntry(scope: object): ScopedEntry {
    let byScope = _scopedComputeds.get(scope);
    if (byScope === undefined) {
      byScope = new Map();
      _scopedComputeds.set(scope, byScope);
    }
    const hit = byScope.get(this);
    if (hit !== undefined && _scopedFresh(hit, scope)) return hit;
    const self = this as unknown as ComputedImpl<unknown>;
    if (_computing.has(self)) {
      throw new Error(
        "[aio:signal] Circular dependency in computed — it (directly or via other computeds) reads its own value. Break the cycle by deriving from source signals only.",
      );
    }
    _computing.add(self);
    let entry: ScopedEntry;
    try {
      entry = _scopedEval(this._fn, scope);
    } finally {
      _computing.delete(self);
    }
    byScope.set(this, entry);
    return entry;
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
    let ok = false;
    try {
      const next = this._fn();
      ok = true;
      if (!Object.is(this._cached, next) || this._version === 0) {
        this._version++;
      }
      this._cached = next;
    } finally {
      // AIO-258: delete first — if _trackEnd throws, _computing must still be cleaned
      _computing.delete(this as unknown as ComputedImpl<unknown>);
      _trackEnd(deps);
      // Link on EVERY exit path, the throw included — the same rule `effect`
      // follows. The links used to be made only after a successful compute,
      // so a computed whose fn threw once (a guard on a not-yet-loaded value,
      // say) had already dropped every old link and took no new one: it sat
      // dirty with ZERO upstream edges, and when its source recovered nothing
      // reached it, so no effect downstream ever re-ran. The reads collected
      // before the throw are exactly the signals whose change could make it
      // succeed; keeping them means the next write retries it.
      this._dirty = !ok;
      this._errored = !ok;
      this._link(deps);
    }
  }

  /** Eager dependency link: when a dep changes, mark this computed dirty and
   *  propagate *synchronously* — recursing into dependent computeds and
   *  queueing dependent effects. This guarantees a same-batch read after the
   *  write never sees a stale-clean computed (B-2). Recompute stays lazy. */
  private _link(deps: Set<SignalImpl<unknown>>): void {
    this._deps = deps;
    const link: Subscriber = {
      execute: () => {}, // never queued — invalidation is eager
      invalidate: () => {
        // An errored computed is dirty already, and still has to propagate:
        // its dependents hold a THROW, not a stale value, and this write is
        // what may turn the throw into a value.
        if (!this._dirty || this._errored) {
          this._dirty = true;
          this._errored = false;
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
  /** Set only for a first run created inside a read scope: what it read. */
  let firstDeps: Set<SignalImpl<unknown>> | null | undefined;

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

      // The body runs inside a batch — ONE rule for the first run and every
      // re-run. A re-run already sits inside `_flush`, where a write it makes
      // is queued until the flush loop comes round again. The first run had
      // no such shelter: outside a batch, its first write flushed
      // SYNCHRONOUSLY, mid-body, before this effect had subscribed to
      // anything — so an effect that ran in that nested flush and wrote one
      // of THIS effect's dependencies wrote to a subscriber list this effect
      // was not on yet. It finished holding the old value, subscribed too
      // late to hear about the new one, and no later write would fix it
      // unless that dependency happened to move again. The batch defers the
      // flush to just after the subscriptions below are in place, which is
      // exactly when a re-run's writes are seen.
      batch(() => {
        const deps = _trackStart();
        try {
          cleanup = fn();
          // AIO-188: fn() may have called dispose() on itself — and then
          // RETURNED a cleanup. `dispose()` ran before that cleanup existed,
          // so it was stored into a dead effect and never invoked: a
          // subscription, a timer, a listener leaked by the one effect that
          // asked to be torn down. Nothing will ever call it later; call it
          // now.
          if (disposed && cleanup) {
            const c = cleanup;
            cleanup = undefined;
            c();
          }
        } finally {
          _trackEnd(deps);
          if (firstDeps === null) firstDeps = deps;
          // Re-subscribe on EVERY exit path, including the throw. This used
          // to sit after the try, so an effect body that threw once had
          // already dropped every old subscription and never took a new one:
          // it was silently unlinked from the graph and could not run again
          // for the life of the page (the throw itself is reported by
          // `_flush`, which made it look survivable). The deps collected
          // before the throw are the ones it read; keeping them means the
          // next change re-runs it.
          // AIO-188: fn() may have called dispose() (self-dispose) — an
          // effect that disposed itself must not re-subscribe.
          if (!disposed) {
            for (const dep of deps) {
              dep._subscribers.add(sub);
              unsubs.push(() => dep._subscribers.delete(sub));
            }
          }
        }
      });
    },
  };

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

  // Initial run (no prepare needed). A body that throws HERE throws out of
  // `effect()` itself, so the caller never receives a dispose handle and the
  // collector never sees one — yet the `finally` above had already subscribed
  // it to everything it read before throwing. That was a zombie: no handle
  // anywhere, re-running on every write for the life of the page, and the
  // renderer's teardown of the failed render could not reach it. An effect
  // nobody can dispose must not outlive the call that failed to create it.
  try {
    if (_readScope === null) sub.execute();
    else {
      // An effect is never part of a render — its FIRST run included. Run
      // under a render's route, it would subscribe to what the RENDER's route
      // reads (another branch of a conditional), and a write to what the
      // global route reads would never reach it ("Read scope").
      const scope = _enterReadScope(null);
      firstDeps = null;
      try {
        sub.execute();
      } finally {
        _enterReadScope(scope);
      }
      const deps = firstDeps ?? new Set<SignalImpl<unknown>>();
      firstDeps = undefined;
      _scopedEffectHook?.((targets) => _reaches(deps, targets));
    }
  } catch (e) {
    dispose();
    throw e;
  }

  // Register with effect collector if active (renderer auto-dispose)
  if (_effectCollectors.length > 0) {
    _effectCollectors[_effectCollectors.length - 1]!.push(dispose);
  }

  return dispose;
}

// ── trackedMemo ─────────────────────────────────────────────────────

/** A cache whose HITS still subscribe — the correct version of the memo every
 *  app hand-rolls wrong.
 *
 *  The trap it closes: a component re-renders only for signals it touched
 *  **while rendering**, and one cell is one signal, so any app with a list
 *  large enough to matter memoizes. A plain cache that returns a hit without
 *  touching the cell therefore subscribes to NOTHING — permanently, for that
 *  component instance. The consequence is worse than "stale": the instance
 *  that got the MISS works forever and the one that got the HIT is dead
 *  forever, from the same cache, in the same frame. Right data, stale DOM, and
 *  nothing to see — a component that subscribes to nothing renders fine, once.
 *
 *  So a hit REPLAYS the read set the miss recorded, into whatever tracking
 *  scope is open now. The caller subscribes to exactly what computing the
 *  value would have read.
 *
 *  Freshness comes from the same recorded set: every dependency's version is
 *  captured at compute time, and a hit whose dependencies have moved
 *  recomputes. No dependency array — the reads ARE the dependencies.
 *
 * ```ts
 * // module scope — shared across every component that asks
 * const visibleRows = trackedMemo((filter: string) =>
 *   accounts.list.filter((a) => a.name.includes(filter))
 * );
 *
 * function Panel({ filter }: { filter: string }) {
 *   return <List rows={visibleRows(filter)} />; // hit or miss, it subscribes
 * }
 * ```
 *
 *  `key` maps the argument to a cache key (default: the argument itself, by
 *  `Map` identity). `max` bounds the cache, evicting least-recently-used —
 *  unbounded is the other way an app-level cache goes wrong. */
export function trackedMemo<K, V>(
  compute: (key: K) => V,
  opts?: { key?: (arg: K) => unknown; max?: number },
): (arg: K) => V {
  type Entry = {
    value: V;
    deps: SignalImpl<unknown>[];
    versions: number[];
  };
  const cache = new Map<unknown, Entry>();
  const keyOf = opts?.key ?? ((a: K) => a as unknown);
  const max = opts?.max ?? 0;

  const fresh = (e: Entry): boolean => {
    for (let i = 0; i < e.deps.length; i++) {
      const d = e.deps[i]!;
      // A computed's stamp moves only when it RECOMPUTES, and recompute is
      // lazy: a dirty one still carries the stamp of the value it last
      // produced. Settle it first (an untracked read — the caller's scope
      // must see the recorded set, not the computed's inputs), so the
      // comparison is against the value a miss would read now. Without this
      // — and before a computed carried a stamp at all — a hit over a
      // computed compared `undefined` to `undefined` and was fresh forever.
      // …and a dependency that THROWS now is not fresh: the miss recomputes,
      // throws, and still subscribes the caller to what it read (a hit that
      // threw from here subscribed it to nothing, for good).
      if (d instanceof ComputedImpl) {
        try {
          d.peek();
        } catch {
          return false;
        }
      }
      if (d._version !== e.versions[i]) return false;
    }
    return true;
  };

  /** Per read scope: its own entries, never the global cache's. */
  const scoped = new WeakMap<object, Map<unknown, ScopedEntry>>();

  return (arg: K): V => {
    const k = keyOf(arg);
    if (_readScope !== null) {
      const scope = _readScope;
      let byKey = scoped.get(scope);
      if (byKey === undefined) {
        byKey = new Map();
        scoped.set(scope, byKey);
      }
      let e = byKey.get(k);
      if (e === undefined || !_scopedFresh(e, scope)) {
        // A throw is an entry that is never fresh; what it read before the
        // throw still subscribes the caller (the global miss below does too).
        e = _scopedEval(() => compute(arg), scope);
        byKey.set(k, e);
      }
      const tracker = _currentTracker();
      if (tracker) _trackScoped(tracker, e, scope);
      return _scopedValue(e) as V;
    }
    const hit = cache.get(k);
    if (hit && fresh(hit)) {
      // THE point of this function: put the recorded reads into the scope that
      // is open NOW, so a hit subscribes exactly as a miss would have.
      const tracker = _currentTracker();
      if (tracker) { for (const d of hit.deps) tracker.add(d); }
      if (max > 0) {
        // Touch for LRU — re-inserting moves the key to the end.
        cache.delete(k);
        cache.set(k, hit);
      }
      return hit.value;
    }
    // Miss: compute in a scope of its OWN, so the reads are recorded exactly
    // once and replayed deliberately — never leaked into the caller's scope
    // twice, and never lost if `compute` throws: a throw caches nothing, and
    // the reads made before it are replayed into the caller's scope, so the
    // caller re-runs when one of them changes. (Until 1.0.11 a throw dropped
    // them: an effect or a component whose memo threw once never ran again.)
    const deps = _trackStart();
    let value: V;
    let ok = false;
    try {
      value = compute(arg);
      ok = true;
    } finally {
      _trackEnd(deps);
      if (!ok) {
        const tracker = _currentTracker();
        if (tracker) { for (const d of deps) tracker.add(d); }
      }
    }
    const list = [...deps];
    const entry: Entry = {
      value,
      deps: list,
      versions: list.map((d) => d._version),
    };
    cache.delete(k);
    cache.set(k, entry);
    if (max > 0) {
      while (cache.size > max) {
        const oldest = cache.keys().next();
        if (oldest.done) break;
        cache.delete(oldest.value);
      }
    }
    const tracker = _currentTracker();
    if (tracker) { for (const d of list) tracker.add(d); }
    return value;
  };
}
