// cell-test.ts — testCell() harness for isolated cell testing

// One-stop test surface: component harness re-exported so all test APIs share
// a single import (`aio/testing`) — additive, A1 audit.
export {
  setDocument,
  testComponent,
  type TestComponentHandle,
  type TestComponentOptions,
} from "./test-component.ts";

import type { ScheduleEffect } from "../state/schedule.ts";
import type { OwnEffect } from "../state/own.ts";
import { registerCall } from "../state/cell-impl.ts";
import {
  _inflightMethodKeys,
  _pendingCallPromises,
} from "../state/method-cancel.ts";
import { _resetAioRuntime } from "../state/runtime-reset.ts";
import { routeEffect } from "../state/route-effect.ts";
import { assertionFailure, formatCellState } from "./test-format.ts";
import { frozenWriteMessage, isFrozenWriteError } from "../state/immutable.ts";
import { _armTestStrict, _watchUnobservedCalls } from "./test-strict.ts";
// Server-touching, so NOT in test-strict.ts — see boot-refusals.ts.
import {
  _refuseUnsafeCells,
  type HarnessBootOptions,
} from "./boot-refusals.ts";
import { attachMeta } from "../state/cell-catalog.ts";
import { runWithUser } from "../server/auth-context.ts";
import type { AioUser } from "../server/aio-types.ts";
import type { Catalog, CellDef, Creators, Msg } from "../state/cell-types.ts";
import { composeCells } from "../state/cell-compose.ts";

// Dev-strict arming lives in its own module so every harness can call it
// without an import cycle (see test-strict.ts). Re-exported here because this
// is the file `aio/testing` resolves to.
export { _armTestStrict } from "./test-strict.ts";

/** Context object provided to testCell() callbacks */
export type TestContext<
  S = Record<string, unknown>,
  // deno-lint-ignore no-explicit-any
  A = Record<string, (...args: any[]) => any>,
> = {
  /** Reset the cell to its initial state — optionally SEEDED.
   *
   *  `t.init({ scanning: true })` shallow-merges over the declared initial
   *  state, so a test can start at the state under test instead of driving the
   *  cell there through real methods. That mattered: for a cell whose methods
   *  shell out or hit the disk, "reach this state first" is the expensive
   *  part, and one field report moved logic OUT of its cell into plain
   *  functions purely so it could be tested from a known state. Good practice
   *  anyway — but it should not be the only route.
   *
   *  An unknown key throws, listing the real ones: a silently-ignored seed
   *  looks like a pinned fixture while pinning nothing, which is the failure
   *  mode that makes seeding worse than not having it. (`testUI`'s `seed`
   *  option is the same idea for a mounted app.) */
  init: (seed?: Partial<S>) => void;
  /** Destroy cell (reset to initial + 'uninitialized' status) */
  destroy: () => void;
  /** Typed action senders — one per declared action, arguments inferred from action creators.
   *
   *  Ordering is production's: the call STARTS when you make it, awaited or
   *  not, exactly like `cell.method()` in an app. So a second action can land
   *  while the first is still in flight — which is how you test supersession
   *  and cancel-in-flight:
   *
   *  ```ts
   *  const scanning = t.send.open("/");   // running now — sync prefix already ran
   *  await t.send.cancel();               // lands mid-flight, aborts it
   *  await scanning;
   *  ```
   *
   *  AIO-379: **awaiting** resolves when the method (and all its state writes)
   *  have been applied; `t.settle()` awaits every call started so far,
   *  un-awaited ones included:
   *
   *  ```ts
   *  await t.send.load()              // async method fully done here
   *  t.expect.state(s => s.data !== null)
   *  ```
   *
   *  AIO-427: the resolved value is the method's transported RETURN — awaiting
   *  `t.send.create(...)` yields whatever the method returned (like production
   *  `await cell.create(...)`), or `undefined` for a void/effect-only method.
   */
  send: {
    [K in keyof A & string]: A[K] extends (...args: infer P) => unknown
      ? (...args: P) => Promise<unknown>
      : never;
  };
  /** Assertions */
  expect: {
    /** Assert on cell state slice (typed — `s` is the cell's state).
     *
     *  `msg` is folded into the failure, like every other assertion in the
     *  ecosystem takes one. Without it a failure printed only the state dump
     *  and the reader had to reverse-engineer the predicate's intent — and a
     *  field report hit the missing argument at ~12 call sites at once, because
     *  `assertEquals`-shaped calls are what everyone writes first. */
    // deno-lint-ignore no-explicit-any
    state: (fn: (s: S, ...args: any[]) => boolean, msg?: string) => void;
    /** Assert current machine status */
    status: (expected: string) => void;
    /** Assert effect types returned by last action (full type strings, e.g. 'counter:persist') */
    effects: (types: string[]) => void;
    /** Assert number of effects returned by last action */
    effectCount: (n: number) => void;
    /** Assert a predicate holds for current state */
    invariant: (fn: (s: S) => boolean) => void;
    /** Assert an async call REFUSES — the shape a validating method has.
     *
     *  "Validation lives with the data … a method that refuses does so by
     *  throwing" is documented behaviour with a worked example, and its harness
     *  had no first-class assertion for it. A field report reached for
     *  `t.expect.rejects(...)` by analogy with `.state` / `.effects` /
     *  `.invariant`, got `TS2339: Property 'rejects' does not exist`, and
     *  imported `assertRejects` instead. The analogy was right; the member was
     *  missing.
     *
     *  ```ts
     *  await t.expect.rejects(() => t.send.add(""), /name is required/);
     *  ```
     *  `match` narrows to the message, so a test cannot pass on the WRONG
     *  refusal — which is the failure a bare "it threw" assertion allows. */
    rejects?: (
      fn: () => unknown,
      match?: string | RegExp,
      msg?: string,
    ) => Promise<Error>;
    /** The synchronous half of {@link rejects} — a sync method that refuses. */
    throws?: (
      fn: () => unknown,
      match?: string | RegExp,
      msg?: string,
    ) => Error;
  };
  /** Run `fn` with `user` as the ambient caller identity, so `serverUser()`
   *  inside a method answers with it — the supported way to test an
   *  identity-dependent method.
   *
   *  Reading the caller from the ambient rather than an argument is the right
   *  design (a username passed as a parameter is a forgery waiting to happen),
   *  but it left no way to test such a method: the mechanism (`runWithUser`)
   *  is framework-internal, so a field report's 35 relay tests all reached
   *  past the public surface into `src/server/auth-context.ts`. This is that
   *  affordance, without publishing the ALS plumbing.
   *
   *  ```ts
   *  await t.as({ id: "alice", role: "member" }, () => t.send.post("hi"))
   *  ```
   *  Omit `user` (or pass undefined) to assert the anonymous path. */
  as: <T>(user: AioUser | undefined, fn: () => T) => T;
  /** The cell's current state.
   *
   *  An ALIAS for {@link getState}, and the spelling people reach for first:
   *  a field walk-through hit `t.state` and got a six-line
   *  `Omit<TestContext<…>>` type error that named nothing available, then had
   *  to read framework source to find `t.getState()`. Two names for one fact
   *  is a smaller cost than a type error that teaches nothing. */
  readonly state: S;
  /** Get current cell state */
  getState: () => S;
  /** Get effects from last dispatched action */
  getEffects: () => (Msg | ScheduleEffect | OwnEffect)[];
  /** Dispatch N random valid actions (for property-based testing).
   *
   *  Unseeded and unfiltered. {@link fuzz} is the same thing with the two
   *  things a property test needs — a replayable seed and a skip list — and is
   *  what to reach for in new tests; this stays exactly as it is. */
  randomActions: (n: number) => void;
  /** {@link randomActions}, replayable and filterable.
   *
   *  TWO field findings, one call.
   *
   *  A SEED, because an unseeded fuzzer that fails cannot be re-run. When one
   *  did, the author "spent a worktree and ten runs establishing whether it was
   *  mine" — a printed seed answers that in one. Property-based testing solved
   *  this twenty years ago; `fast-check` prints `Seed: 1234` and you replay it
   *  exactly. Omit it and one is generated and returned, so a failing run can
   *  always name the seed that produced it.
   *
   *  A SKIP LIST, because a uniform pick over every action key includes the
   *  boot-only ones. A cell whose 32 methods include one whose whole body is
   *  `s.$do?.(schedule.every(…))` cannot be fuzzed at all: `testCell` owns no
   *  clock, so the executor correctly refuses the effect and the test fails on
   *  that rather than on any invariant. With 32 keys and 120 picks, missing it
   *  has probability ~2% — so the test does not "sometimes fail", it sometimes
   *  PASSES. Measured: 10/10 red alone, 5/5 red in the full suite, 0/12 red
   *  once the boot-only key was excluded.
   *
   *  ```ts
   *  const run = t.fuzz({ n: 120, skip: ["armFolderWatch"] });
   *  t.expect.invariant((s) => s.total >= 0);
   *  // on failure: `seed ${run.seed}` replays this exact sequence
   *  ```
   */
  fuzz?: (opts?: {
    /** How many actions to dispatch. Default 100. */
    n?: number;
    /** Replay a previous run exactly. Omitted → generated and returned. */
    seed?: number;
    /** Action keys to leave out — boot-only methods, anything that needs a
     *  clock this harness does not have. Bare method names or full
     *  `cell:method` keys both work. */
    skip?: readonly string[];
  }) => { seed: number; actions: string[] };
  /** Run pending effects (executor). Deprecated — `settle()` now auto-runs effects. */
  runEffects: () => void;
  /** Run effects + wait for async to complete. Replaces `runEffects() + settle()`.
   *  AIO-379: async method triggers are tracked to real completion — no-arg
   *  settle() is deterministic even when the method does slow work (dynamic
   *  imports, file IO). Pass ms only to wait out real timers (setTimeout chains). */
  settle: (ms?: number) => Promise<void>;
};

/** Typed senders derived from the cell's bound method surface (DirectCalling):
 *  every promise-returning callable on the cell ref — i.e. its methods —
 *  becomes a sender with the SAME args and resolved RETURN type, so
 *  `await t.send.create(...)` yields what `await cell.create(...)` yields
 * . Selector accessors (plain returns) and actions-form
 *  creators (action objects) don't return promises and are excluded. */
type SendSurface<F> = {
  [
    K in keyof F & string as F[K] extends (...a: never[]) => Promise<unknown>
      ? K
      : never
  ]: F[K] extends (...args: infer P) => Promise<infer R>
    ? (...args: P) => Promise<R>
    : never;
};

/** Extract a cell ref's state / name / actions from its CellDef part. */
type CellStateOf<F> = F extends
  CellDef<string, Creators, Creators, infer S extends Record<string, unknown>>
  ? S
  : Record<string, unknown>;
type CellNameOf<F> = F extends
  CellDef<infer N extends string, Creators, Creators, Record<string, unknown>>
  ? N
  : string;
type CellActionsOf<F> = F extends
  CellDef<string, infer A extends Creators, Creators, Record<string, unknown>>
  ? A
  : Creators;

/** TestContext for a concrete cell ref: `send` is REPLACED by the cell's
 *  typed method surface when one exists (methods-form) — sender args AND
 *  resolved return types mirror production `await cell.method(...)`. Actions-form cells (empty SendSurface) keep the loose senders.
 *  (A plain intersection can't narrow: `Promise<unknown> & Promise<R>` awaits
 *  to unknown.) */
/** Every field optional, all the way down — arrays and non-objects kept whole.
 *
 *  `Partial<S>` only reaches the TOP level, so any nested object had to be
 *  supplied entire. A field report wrote a local `cfg()` helper in two test
 *  files purely to work around it, and every test that touched config then
 *  carried five fields it did not care about — exactly the noise that makes a
 *  test hard to read.
 *
 *  An array stays whole on purpose: a "partial array" is not a thing anyone
 *  means, and merging one index-wise would silently keep elements a fixture
 *  meant to replace. */
type DeepPartial<T> = T extends readonly unknown[] ? T
  : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> }
  : T;

/** Merge `seed` into `base`, recursing into PLAIN objects only.
 *
 *  Safe to adopt under the freeze, and the reason is precise: today `init`
 *  takes `Partial<S>`, so a nested object must be supplied whole — and when it
 *  is whole, a deep merge and a replace produce the same result. No test that
 *  COMPILES today can observe the difference. Anything that is not a plain
 *  object (an array, a Date, a Map, a class instance) replaces, because
 *  merging into one is how a fixture silently keeps what it meant to drop. */
function _deepMergeSeed(
  base: Record<string, unknown>,
  seed: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(seed)) {
    const prev = out[k];
    const bothPlain = _isPlainObject(prev) && _isPlainObject(v);
    out[k] = bothPlain
      ? _deepMergeSeed(
        prev as Record<string, unknown>,
        v as Record<string, unknown>,
      )
      : v;
  }
  return out;
}

function _isPlainObject(v: unknown): boolean {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** What the harness ALWAYS provides, made required.
 *
 *  `TestContext` declares `fuzz`, `expect.rejects` and `expect.throws`
 *  OPTIONAL, and that is not a hedge — the public surface is frozen, and adding
 *  a REQUIRED member to a published interface breaks anyone who constructs one
 *  by hand. That is a break `am fix` cannot repair, so it is not available.
 *
 *  The harness does provide them, always, so the type the CALLBACK receives
 *  says so and nobody has to write `t.fuzz?.(…)` or `t.expect.rejects!(…)`.
 *  `TestCtxOf` is not exported, so tightening it costs the surface nothing —
 *  which is the whole shape of "additive under a freeze": the promise stays as
 *  weak as it was, the thing you actually hold is as strong as it can be. */
type Provided<T extends { expect: unknown; init: unknown }> =
  & Omit<T, "expect" | "fuzz" | "init">
  & { expect: Required<T["expect"]> }
  & { fuzz: NonNullable<TestContext<never, never>["fuzz"]> }
  // `init` is DEEP here and shallow on the published `TestContext`. The public
  // type is frozen — widening a parameter is a signature change the gate
  // refuses, and rightly, since it cannot prove assignability from a digest.
  // `TestCtxOf` is private, so the callback holds the better type and the
  // promise stays exactly as weak as it was.
  & { init: (seed?: DeepPartial<CellStateOf<T>>) => void };

type TestCtxOf<F> = keyof SendSurface<F> extends never ? Provided<
    TestContext<CellStateOf<F>, Catalog<CellNameOf<F>, CellActionsOf<F>>>
  >
  :
    & Omit<
      Provided<
        TestContext<CellStateOf<F>, Catalog<CellNameOf<F>, CellActionsOf<F>>>
      >,
      "send"
    >
    & { send: SendSurface<F> };

/** Test harness for isolated cell testing — wraps Deno.test with typed
 *  helpers. Everything is inferred from the cell ref: state (`t.getState()`,
 *  `t.expect.state`), sender args, and sender RETURN types. */
/** The refusal an `expect.rejects`/`expect.throws` caught, checked against
 *  `match` and returned so a test can assert further on it.
 *
 *  `match` is what stops the assertion being vacuous. "It threw" passes for the
 *  WRONG refusal just as happily as for the right one — a typo in a field name
 *  throwing `TypeError: cannot read x of undefined` looks identical to the
 *  validation the test was written for, and the test goes green having proved
 *  the opposite of what it claims. */
function _matchRefusal(
  thrown: unknown,
  match: string | RegExp | undefined,
  msg: string | undefined,
): Error {
  const err = thrown instanceof Error ? thrown : new Error(String(thrown));
  if (match !== undefined) {
    const ok = typeof match === "string"
      ? err.message.includes(match)
      : match.test(err.message);
    if (!ok) {
      throw assertionFailure(
        `${msg ?? "the call was refused"}, but for a different reason than ` +
          `expected.\n  expected to match: ${match}\n  actual message:    ${err.message}`,
      );
    }
  }
  return err;
}

export function testCell<
  F extends CellDef<string, Creators, Creators, Record<string, unknown>>,
>(
  f: F,
  testName: string,
  fn: (t: TestCtxOf<F>) => void | Promise<void>,
): void;
/** Legacy explicit-state form: `testCell<{ count: number }>(cell, …)`. */
export function testCell<
  S extends Record<string, unknown>,
  N extends string = string,
  // deno-lint-ignore no-explicit-any
  A extends Creators = any,
  // deno-lint-ignore no-explicit-any
  E extends Creators = any,
>(
  f: CellDef<N, A, E, S>,
  testName: string,
  fn: (t: TestContext<S, Catalog<N, A>>) => void | Promise<void>,
): void;
/** Implementation — loose; the overloads carry the public typing. */
export function testCell(
  // deno-lint-ignore no-explicit-any
  f: CellDef<string, any, any, Record<string, unknown>>,
  testName: string,
  // deno-lint-ignore no-explicit-any
  fn: (t: any) => void | Promise<void>,
): void {
  _armTestStrict();
  Deno.test(`[${f.__aio.id}] ${testName}`, async () => {
    // Reset shared runtime state for test isolation — prevents bleed from prior runs
    _resetAioRuntime();

    // Compose a single-cell system
    const composed = composeCells([f]);
    const machine = f.__aio.machine;

    let state = { ...composed.initialState };
    let lastEffects: (Msg | ScheduleEffect | OwnEffect)[] = [];

    // AIO-379: effects already run by an awaited send (or a previous settle) —
    // settle()/runEffects() skip these so nothing executes twice.
    const executed = new WeakSet<object>();
    // Every async-method call started by this test, awaited or not. `settle()`
    // drains it, so a fire-and-forget send is still deterministic even though
    // its trigger already ran at call time (see the ordering note on `send`).
    const inFlight: Promise<unknown>[] = [];
    // Failures NOBODY LOOKED AT.
    //
    // `settle()` used to `allSettled` everything, so `t.send.boom(); await
    // t.settle();` passed while the method threw — the harness reporting
    // success for the exact case it was there to catch. But a test that
    // awaits the send itself (`assertRejects(() => t.send.boom())`) has
    // handled the failure and must not be told twice. So the rule is the one
    // the language already uses for promises: an error the test never observed
    // is an unhandled error, and it surfaces — at the next `settle()`, or at
    // the end of the test if `settle()` is never called.
    const NEVER = () => false;
    const unobserved: { err: unknown; seen: () => boolean }[] = [];
    const raiseUnobserved = (): void => {
      const first = unobserved.find((f) => !f.seen());
      if (!first) return;
      unobserved.length = 0;
      throw first.err;
    };
    // EFFECTS NOBODY RAN.
    //
    // Same rule as `unobserved`, for the other half of a dispatch. `testCell`
    // drives `composed.execute` directly, so a framework effect
    // (`schedule.*`, `own()`) has no clock and no resource table here — the
    // root executor throws and names `bootCells`/`testUI`. But it only throws
    // when something EXECUTES the effect, and a test that asserts on state and
    // never calls `settle()` executes nothing: `s.$do(schedule.after(…))` then
    // passed GREEN having armed no timer, which is the harness being more
    // permissive than production, the one direction this project forbids.
    //
    // Observed-or-raised, exactly like a failure: a test that READ the effects
    // (`t.getEffects()`) is asserting on the shape and is left alone.
    const observedEffects = new WeakSet<object>();
    const isFrameworkEffect = (e: unknown): boolean => {
      let fw = false;
      routeEffect(e as never, {
        schedule: () => {
          fw = true;
        },
        own: () => {
          fw = true;
        },
        app: () => {},
      });
      return fw;
    };
    /** Framework effects emitted by ANY dispatch, not just the last.
     *  `lastEffects` is overwritten every dispatch, so
     *  `t.send.increment(); t.send.reset();` — a method that schedules
     *  followed by one that does not — dropped the schedule effect out of
     *  view before the end-of-test check could see it. That is the ordinary
     *  multi-dispatch test, so it was most of them. Measured on a scaffolded
     *  app: the starter test passed with a `schedule.after` that never armed.
     */
    const emittedFramework: (Msg | ScheduleEffect | OwnEffect)[] = [];
    /** THE effects accessor. Every door a test can read effects through marks
     *  them here — `getEffects()`, `expect.effects`, `expect.effectCount` —
     *  so "the test looked at it" is one fact with one definition, not three.
     *  Per EFFECT, not per test: an early read must not silence a LATER
     *  dispatch's dropped effect, the same rule `unobserved` uses. */
    const readEffects = (): (Msg | ScheduleEffect | OwnEffect)[] => {
      for (const e of lastEffects) observedEffects.add(e);
      return lastEffects;
    };
    /** Hand the first un-run framework effect to the executor, whose refusal
     *  is the ONE place that message lives. No-op when there is none. */
    const raiseUnrunFrameworkEffect = (): void => {
      const eff = emittedFramework.find((e) =>
        !executed.has(e) && !observedEffects.has(e)
      );
      if (!eff) return;
      executed.add(eff);
      composed.execute(app, eff as { type: string; payload: unknown });
    };

    const prefix = f.__aio.id;
    const execType = `${prefix}:__exec`;
    const asyncMethods: Set<string> = f.__aio.asyncMethods ?? new Set();

    const app = {
      dispatch,
      getState: () => state,
    };

    // Bind SELECTORS against this harness's state. A selector is a pure function
    // of the cell's own slice — exactly what `t.getState()` already exposes — so
    // `models.visible()` throwing "not a function" here while working in every
    // other harness was an inconsistency, not a design. It
    // pushed any test that touched a selector out of the unit-level tool and into
    // `bootCells`, for no reason a reader of that test could see.
    const selectors = f.__aio.selectors as
      | Record<string, (s: unknown, full?: unknown) => unknown>
      | undefined;
    const restoreSelectors: (() => void)[] = [];
    if (selectors) {
      for (const [key, fn] of Object.entries(selectors)) {
        const had = Object.getOwnPropertyDescriptor(f, key);
        Object.defineProperty(f, key, {
          value: (...args: unknown[]) => {
            const own = (state as Record<string, unknown>)[prefix];
            return args.length > 0
              ? (fn as (s: unknown, ...a: unknown[]) => unknown)(own, ...args)
              : fn(own, state as unknown);
          },
          enumerable: false,
          configurable: true,
          writable: true,
        });
        restoreSelectors.push(() => {
          if (had) Object.defineProperty(f, key, had);
          else delete (f as Record<string, unknown>)[key];
        });
      }
    }

    function dispatch(action: Msg): unknown {
      const result = composed.reduce(state, action);
      state = { ...result.state };
      lastEffects = result.effects;
      for (const e of result.effects) {
        if (isFrameworkEffect(e)) emittedFramework.push(e);
      }
      // AIO-427: surface the sync method's transported return value.
      return (result as { ret?: unknown }).ret;
    }

    /** Execute an async-method trigger effect and return a promise that
     *  resolves when the method (and its batched writes) completed. */
    function runExec(eff: Msg, fromSend = false): Promise<unknown> {
      executed.add(eff);
      const payload = eff.payload as Record<string, unknown>;
      const callId = (payload._callId as string | undefined) ??
        (payload._callId = crypto.randomUUID()) as string;
      // `eff.type` is the internal "<cell>:__exec" trigger — the ceiling is
      // keyed by the METHOD the app wrote.
      const method = `${eff.type.split(":")[0]}:${
        String(payload._method ?? "")
      }`;
      const done = registerCall(callId, method);
      done.catch(() => {}); // mark handled — fire-and-forget callers must not surface unhandled rejections
      inFlight.push(done);
      composed.execute(app, eff as { type: string; payload: unknown });
      // Nothing can await a trigger settle() ran on its own, so if it fails,
      // this is the only place that will ever know.
      if (!fromSend) done.catch((err) => unobserved.push({ err, seen: NEVER }));
      // Propagate rejection to awaiters — matches production `await cell.method()`.
      // AIO-427: resolve with the async method's transported return value.
      return done;
    }

    async function drainMicrotasks(): Promise<void> {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }

    // Build send proxy from action creators (cast to typed form — runtime matches compile-time shape)
    const send = {} as TestContext["send"];
    for (const key of f.__aio.actionKeys) {
      const creator = (f.__aio.actions as Record<string, unknown>)[key];
      if (typeof creator !== "function") continue;
      // deno-lint-ignore no-explicit-any
      (send as Record<string, (...args: any[]) => Promise<unknown>>)[key] = (
        ...args: unknown[]
      ) => {
        const msg = (creator as (...a: unknown[]) => Msg)(...args);
        if (!asyncMethods.has(key)) {
          // Sync method: dispatch runs the reducer now; resolve with its
          // return — and REJECT if it threw, rather than letting the throw
          // escape synchronously. Production always rejects (dispatch turns a
          // reducer throw into a reported REDUCE_ERROR and rejects the
          // caller's promise), so a harness that throws instead forces every
          // validation test to be written differently from the code it covers
          // (`assertThrows` here, `assertRejects` in the app).
          try {
            return Promise.resolve(dispatch(msg));
          } catch (e) {
            return Promise.reject(e);
          }
        }
        // Async method: tag the dispatch with a callId so completion is
        // observable, and capture this send's own trigger effects.
        const callId = crypto.randomUUID();
        (msg.payload as Record<string, unknown>)._callId = callId;
        dispatch(msg);
        const myExecs = lastEffects.filter((e): e is Msg =>
          (e as Msg).type === execType &&
          ((e as Msg).payload as Record<string, unknown>)?._callId === callId
        );
        // PRODUCTION ORDERING: the trigger runs NOW, at call time —
        // exactly like `cell.method()` in production, where dispatch executes
        // the effect synchronously and the method's sync prefix has already run
        // by the time the call returns. It used to start lazily on the first
        // `await`, which made an un-awaited send a no-op until a later
        // `settle()` — so a test that fires a long call and then a second action
        // observed the two in the INVERSE of production order, and the class of
        // bug you write such a test for (supersession, cancel-in-flight) became
        // inexpressible. Neither stricter nor more lenient than production, just
        // differently ordered: the one divergence that makes a green test
        // meaningless.
        const pending = myExecs.filter((e) => !executed.has(e));
        const started: Promise<unknown> = pending.length === 0
          ? Promise.resolve(undefined) // machine-blocked (no trigger emitted)
          // AIO-427: resolve with the method's transported return value (the
          // last trigger's, matching production single-method dispatch).
          : Promise.all(pending.map((e) => runExec(e, true))).then(
            async (vals) => {
              await drainMicrotasks();
              return vals[vals.length - 1];
            },
          );
        // Fire-and-forget parity: an un-awaited failing call must not blow up
        // the test run as an unhandled rejection (production logs it too) —
        // but it must not vanish either. Whether the test ever LOOKED at this
        // call decides which: attaching a handler (await, .then, .catch,
        // Promise.all) counts as looking.
        let observed = false;
        started.catch((err) => unobserved.push({ err, seen: () => observed }));
        const mark = <T>(v: T): T => (observed = true, v);
        return {
          then: (onF, onR) => mark(started).then(onF, onR),
          catch: (onR) => mark(started).catch(onR),
          finally: (onC) => mark(started).finally(onC),
          [Symbol.toStringTag]: "Promise",
        } as Promise<unknown>;
      };
    }

    // Bind the cell's own method functions to the harness send — mirrors what
    // aio.run() does on bind. Without this, code that self-dispatches (a
    // cell.method() call inside a method, or a deferred setTimeout self-call)
    // hits the "called before aio.run()" unbound guard and logs a spurious
    // warning even though the harness IS driving the cell. Scoped to this def;
    // each testCell() rebinds, so guard-assertion tests on other cells are
    // unaffected.
    for (const key of f.__aio.actionKeys) {
      const dispatcher = (send as Record<string, unknown>)[key];
      if (typeof dispatcher !== "function") continue;
      // Preserve the public `.type` / `.action()` accessors on the rebound
      // surface so self-dispatch and `cell.method.action()` work in tests too.
      const creator = (f.__aio.actions as Record<string, unknown>)[key];
      if (creator) attachMeta(dispatcher, creator);
      (f as Record<string, unknown>)[key] = dispatcher;
    }

    const ctx: TestContext = {
      init: (seed?: Record<string, unknown>) => {
        state = { ...composed.initialState };
        if (seed) {
          const own = (state as Record<string, unknown>)[prefix] as
            | Record<string, unknown>
            | undefined;
          const known = own ?? {};
          const unknown = Object.keys(seed).filter((k) => !(k in known));
          if (unknown.length > 0) {
            throw new Error(
              `[${f.__aio.id}] t.init(): unknown state key(s) ${
                unknown.map((k) => `"${k}"`).join(", ")
              } — this cell's state is { ${Object.keys(known).join(", ")} }. ` +
                `A seed that lands nowhere looks like a fixture and pins ` +
                `nothing.`,
            );
          }
          (state as Record<string, unknown>)[prefix] = _deepMergeSeed(
            known,
            seed,
          );
        }
        lastEffects = [];
        emittedFramework.length = 0;
      },
      destroy: () => {
        const base = machine === false
          ? { ...f.__aio.state }
          : { ...f.__aio.state, __aio_status: machine.initial };
        state = { [f.__aio.id]: base };
        lastEffects = [];
        emittedFramework.length = 0;
      },
      send,
      expect: {
        state: (check, msg) => {
          const fs = state[f.__aio.id] as Record<string, unknown>;
          if (!check(fs)) {
            throw assertionFailure(
              `${msg ?? "state assertion failed"}: ${formatCellState(fs)}`,
            );
          }
        },
        status: (expected) => {
          const fs = state[f.__aio.id] as Record<string, unknown>;
          const actual = fs.__aio_status;
          if (actual !== expected) {
            throw assertionFailure(
              `expected status '${expected}', got '${actual}'`,
            );
          }
        },
        effects: (types) => {
          const actual = readEffects().map((e) => e.type as string).sort();
          const expected = [...types].sort();
          if (JSON.stringify(expected) !== JSON.stringify(actual)) {
            throw assertionFailure(
              `expected effects [${expected}], got [${actual}]`,
            );
          }
        },
        effectCount: (n) => {
          if (readEffects().length !== n) {
            throw assertionFailure(
              `expected ${n} effects, got ${lastEffects.length}`,
            );
          }
        },
        invariant: (check) => {
          const fs = state[f.__aio.id] as Record<string, unknown>;
          if (!check(fs)) {
            throw assertionFailure(
              `invariant violation: ${formatCellState(fs)}`,
            );
          }
        },
        rejects: async (fn, match, msg) => {
          let thrown: unknown;
          let returned = false;
          try {
            await fn();
            returned = true;
          } catch (e) {
            thrown = e;
          }
          if (returned) {
            throw assertionFailure(
              `${msg ?? "expected the call to be REFUSED"}, and it resolved. ` +
                `A validating method refuses by throwing — if this one now ` +
                `returns instead, the guard is gone. State: ${
                  formatCellState(state[f.__aio.id] as Record<string, unknown>)
                }`,
            );
          }
          return _matchRefusal(thrown, match, msg);
        },
        throws: (fn, match, msg) => {
          let thrown: unknown;
          let returned = false;
          let value: unknown;
          try {
            value = fn();
            returned = true;
          } catch (e) {
            thrown = e;
          }
          // EVERY cell method is a sender and returns a promise, so a method
          // that refuses rejects rather than throwing — and a `throws` here
          // would report "it returned" while leaving an unhandled rejection to
          // kill the whole test FILE from outside any test. Naming the right
          // assertion is the only useful answer.
          if (
            returned && value !== null && typeof value === "object" &&
            typeof (value as { then?: unknown }).then === "function"
          ) {
            // Adopt the rejection so it cannot surface as an uncaught error
            // after this assertion has already failed.
            (value as Promise<unknown>).catch(() => {});
            throw assertionFailure(
              `${
                msg ?? "expect.throws"
              } was given a call that returned a PROMISE. Every cell method ` +
                `is async, so a refusal REJECTS rather than throws — use ` +
                `\`await t.expect.rejects(...)\`. (\`throws\` is for a ` +
                `synchronous helper.)`,
            );
          }
          if (returned) {
            throw assertionFailure(
              `${msg ?? "expected the call to throw"}, and it returned. ` +
                `State: ${
                  formatCellState(state[f.__aio.id] as Record<string, unknown>)
                }`,
            );
          }
          return _matchRefusal(thrown, match, msg);
        },
      },
      as: <T>(user: AioUser | undefined, body: () => T): T =>
        runWithUser(user, body),
      // `t.state` and `t.getState()` read the SAME live slice — a getter, not
      // a snapshot taken at construction, so it tracks dispatches like the
      // function does.
      get state() {
        return state[f.__aio.id] as Record<string, unknown>;
      },
      getState: () => state[f.__aio.id] as Record<string, unknown>,
      getEffects: readEffects,
      fuzz: (opts) => {
        const n = opts?.n ?? 100;
        const seed = opts?.seed ?? (Math.random() * 0x7fffffff) | 0;
        // `actionKeys` are bare method names; a caller reasonably writes
        // either that or the `cell:method` key they see in `am dispatch` and
        // in error messages. Normalise BOTH sides — a skip entry that silently
        // matches nothing puts the boot-only method back in the fuzz, which is
        // the exact 2%-flake this option exists to remove, and the caller would
        // have no way to tell.
        const bare = (k: string) => k.split(":").pop() ?? k;
        const skip = new Set((opts?.skip ?? []).map(bare));
        const keys = (f.__aio.actionKeys as string[]).filter((k) =>
          !skip.has(bare(k))
        );
        if (keys.length === 0) {
          throw assertionFailure(
            `fuzz: every action was skipped (${
              (opts?.skip ?? []).join(", ")
            }) — there is nothing left to dispatch, so the run would assert ` +
              `an invariant over a cell nothing touched.`,
          );
        }
        // A tiny deterministic PRNG (mulberry32). The point is REPLAY, not
        // statistical quality: the same seed must produce the same sequence in
        // every process, which `Math.random()` cannot promise and which is the
        // whole difference between "it sometimes fails" and a bug you can look
        // at twice.
        let a = (seed >>> 0) || 1;
        const next = () => {
          a = (a + 0x6D2B79F5) >>> 0;
          let t = Math.imul(a ^ (a >>> 15), 1 | a);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        const actions: string[] = [];
        for (let i = 0; i < n; i++) {
          const key = keys[Math.floor(next() * keys.length)]!;
          actions.push(key);
          try {
            send[key]!();
          } catch {
            // aio-ok: see `randomActions` below — a refused transition is the
            // designed outcome of a fuzz, not a fault to report.
          }
        }
        return { seed, actions };
      },
      randomActions: (n) => {
        const keys = f.__aio.actionKeys;
        for (let i = 0; i < n; i++) {
          const key = keys[Math.floor(Math.random() * keys.length)];
          if (key) {
            try {
              send[key]!();
            } catch {
              // aio-ok: this IS the fuzzer. `randomActions` calls methods in
              // random order, from whatever state the previous one left, and
              // with no payload — a guard refusing the transition and a
              // method reading a field off an absent payload are both the
              // designed outcome, not a fault to report. What the caller
              // asserts is the invariant AFTER the run (`t.invariant`), which
              // a thrown-away action cannot make true; a throw here that
              // stopped the run would only shorten the fuzz.
            }
          }
        }
      },
      runEffects: () => {
        for (const eff of lastEffects) {
          if (executed.has(eff)) continue;
          executed.add(eff);
          composed.execute(app, eff as { type: string; payload: unknown });
        }
      },
      settle: async (ms?: number): Promise<void> => {
        // Auto-run pending effects first (eliminates need to call runEffects
        // separately). AIO-379: async method triggers are awaited to real
        // completion — settle() is deterministic regardless of how long the
        // method takes. Each effect runs at most once across awaits/settles.
        for (const eff of lastEffects) {
          if (executed.has(eff)) continue;
          if ((eff as Msg).type === execType) {
            runExec(eff as Msg); // pushes into inFlight
          } else {
            executed.add(eff);
            composed.execute(app, eff as { type: string; payload: unknown });
          }
        }
        // Drain EVERY call started so far, not just this batch: a send that was
        // never awaited already started (production ordering), and settle() is
        // the promise that "everything the test set in motion has landed".
        // Looped, because a settling method can dispatch follow-ups.
        while (inFlight.length > 0) {
          await Promise.allSettled(inFlight.splice(0));
        }
        // Timer wait if ms given (for real setTimeout chains), else drain microtasks
        if (ms !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, ms));
        } else {
          await drainMicrotasks();
        }
        // "Everything has landed" includes "and here is what went wrong".
        raiseUnobserved();
      },
    };

    try {
      try {
        await fn(ctx);
      } catch (e) {
        // A frozen-state write from OUTSIDE a method (`t.state.items.push(…)`,
        // a callback holding a value it read) surfaces as raw engine text —
        // `TypeError: Cannot add property 1, object is not extensible` — which
        // names neither the cell nor the rule nor the fix. Inside a method the
        // reducer already teaches this; everywhere else nobody did.
        const raw = e instanceof Error ? e.message : String(e);
        if (e instanceof Error && isFrozenWriteError(raw)) {
          e.message = frozenWriteMessage(raw, f.__aio.id);
        }
        throw e;
      }
      // A test may never call settle() at all — a method that failed with
      // nobody watching still must not pass for silence.
      //
      // DRAIN FIRST. The ledger entry is pushed from `started.catch(...)`, a
      // microtask that has not run when a synchronous `raiseUnobserved()`
      // executes — so a fire-and-forget failure passed GREEN whenever the test
      // never called `settle()`, and it passed even for a method that threw
      // SYNCHRONOUSLY on entry. The one test named for this claim
      // (`tests/testcell-async.test.ts`, "a failure nobody awaited fails the
      // test even without settle()") calls `await t.settle()` in its body, so
      // nothing covered it.
      while (inFlight.length > 0) {
        await Promise.allSettled(inFlight.splice(0));
      }
      await drainMicrotasks();
      raiseUnobserved();
      raiseUnrunFrameworkEffect();
    } finally {
      // Cells are module singletons: leave the def exactly as it was found, so
      // a later `bootCells`/`testUI` in the same file binds its own selectors.
      for (const restore of restoreSelectors) restore();
    }
  });
}

/** Handle returned by {@linkcode bootCells}. */
export interface BootHandle {
  /** Advance the virtual schedule clock by `ms` and fire everything now due
   *  (`schedule.after`/`every`), then settle — deterministic effect testing. */
  advance(ms: number): Promise<void>;
  /** Wait for async method work (batched writes, executor) to settle. */
  settle(): Promise<void>;
  /** Reset the booted cells to their declared initials + clear schedules. */
  dispose(): void;
  [Symbol.dispose](): void;
}

/**
 * Boot several cells on the local runtime for a pure-logic (no-DOM) test —
 * the multi-cell counterpart to {@linkcode testCell}. Methods dispatch for
 * real, reactive reads work, and `handle.advance(ms)` fires due schedules. Use
 * it when you want to drive several cells' logic without a component + settle
 * dance.
 *
 * @example
 * ```ts
 * const h = await bootCells([network, nav]);
 * await network.setCluster("devnet");
 * assertEquals(network.cluster, "devnet");
 * await h.advance(3000);        // fire a scheduled auto-dismiss
 * h.dispose();
 * ```
 */
export async function bootCells(
  cells: CellDef[],
  /** The app-level options `aio.run` takes that change how cells compose —
   *  pass the same ones the app passes, or the harness boots a different app. */
  opts: HarnessBootOptions = {},
): Promise<BootHandle> {
  _armTestStrict();
  // Every boot refusal a real `aio.run()` performs, BEFORE anything boots —
  // bootCells composes on the standalone runtime, which is not the server's
  // boot path, so a cell exposing a credential to the UI used to boot green
  // here and be refused in dev AND prod.
  _refuseUnsafeCells(cells, opts);
  const standalone = await import("../standalone-air.ts");
  // Virtual time is opt-in: the same runtime ships in an Android APK, where a
  // clock nothing advances means no schedule ever fires. Tests want the
  // virtual clock (that is what `advance(ms)` drives); an app must not get it.
  standalone._useVirtualSchedules();
  // Hermetic: reset any prior runtime state so these cells start pristine —
  // including module-level `signal()`s, which are state a test writes just as
  // easily as a cell and which nothing used to restore.
  standalone._resetState();
  // The PROCESS-GLOBAL half of the runtime, which `_resetState()` does not own:
  // `_pending` (in-flight calls), the degraded registry, the cancel registry,
  // subscriptions, warn-dedup sets. `testCell` has always reset these; bootCells
  // never did, so one hung method leaked into `_pending` for the rest of the
  // process and every later `settle()` burned its whole budget on a promise that
  // could not resolve — and then returned as if the app had quiesced. It
  // subsumes `_resetRootSignals()`, which used to be the only piece reset here.
  // AFTER `_resetState()`: that call destroys any previously booted cells, whose
  // onDestroy hooks must still find their methods bound.
  _resetAioRuntime();
  await standalone.aio.run({
    appId: "bootcells",
    // deno-lint-ignore no-explicit-any
    cells: cells as any,
    persist: false,
    cellDefaults: opts.cellDefaults,
    localFirst: opts.localFirst,
    // The app's budgets, so the harness measures what production measures.
    perfBudget: opts.perfBudget,
  });
  // A failing async method NOBODY awaited must not pass for silence — the same
  // ledger `testCell` keeps, so the same app code cannot pass one harness and
  // fail the other (see test-strict.ts). Installed after the boot, because it
  // wraps the bound methods the boot just installed.
  const ledger = _watchUnobservedCalls(cells);
  /** Drain until nothing is in flight.
   *
   *  Microtask ticks alone were not enough, and `advance()` is where that
   *  showed: firing a timer STARTS the method, but its real work — a dynamic
   *  import, a subprocess, a file read — lands on macrotasks the virtual clock
   *  does not own, so `await h.advance(ms)` returned before anything had
   *  happened. A field report ended up with a hand-rolled
   *  `for (i<100) { sleep(10); await h.settle() }` poll, which is the tell that
   *  a clock sold as deterministic is not.
   *
   *  So this awaits the tracked in-flight CALLS (the same registry `testUI`'s
   *  settle drains), re-checking after each round because a settled method can
   *  start another. Bounded, so a method that genuinely never finishes fails
   *  the test's own timeout instead of hanging here forever. */
  const ROUNDS = 50;
  const settle = async () => {
    // What the last few rounds saw in flight. A set that keeps CHANGING means
    // dispatch is still producing work; a set that has not moved means the
    // remaining calls are parked on something the test holds.
    let lastKeys = "";
    let stableRounds = 0;
    for (let round = 0; round < ROUNDS; round++) {
      for (let i = 0; i < 10; i++) await Promise.resolve();
      const pending = _pendingCallPromises();
      if (pending.length === 0) {
        // Quiesced — and "everything has landed" includes "and here is what
        // went wrong".
        ledger.raise();
        return;
      }
      const keys = _inflightMethodKeys().slice().sort().join(",");
      stableRounds = keys === lastKeys ? stableRounds + 1 : 0;
      lastKeys = keys;
      await Promise.race([
        Promise.allSettled(pending),
        new Promise((r) => setTimeout(r, 5)),
      ]);
    }
    // Budget exhausted. Two very different things look the same here, and
    // conflating them is what made the old silent `return` dangerous:
    //
    //   • DISPATCH never quiesced — the queue keeps producing work, so state
    //     is still moving and any assertion after this point is unguarded.
    //     That is a real failure and it throws.
    //   • Dispatch IS quiet, and what remains is a method PARKED on something
    //     the test holds — the `s.a = 5; await gate; s.b = s.a` shape that
    //     every incremental-commit and every conflict test is built on. The
    //     test is deliberately mid-flight and about to release the gate; the
    //     committed state it is about to assert is settled. Throwing here
    //     would make the harness refuse its own documented pattern.
    //
    // So: quiet dispatch + parked calls is a normal return (the ledger still
    // raises, so a failure inside one of those calls is never swallowed), and
    // only a still-churning queue is the error.
    ledger.raise();
    const stillRunning = _inflightMethodKeys();
    // Unchanged for the whole budget ⇒ nothing is being produced. These calls
    // are PARKED — the `s.a = 5; await gate; s.b = s.a` shape every
    // incremental-commit and conflict test is built on, where the test holds
    // the gate and is about to release it. Dispatch is quiet and the committed
    // state the test is about to assert IS settled, so throwing here would
    // make the harness refuse its own documented pattern.
    //
    // But it must not be SILENT either: "quiesced" and "gave up waiting" have
    // to stay distinguishable. So it says so and returns, and the hard gate
    // moves to `dispose()`, where a call still in flight is a genuine leak
    // with nobody left to release it.
    if (stableRounds >= ROUNDS - 2) {
      if (stillRunning.length > 0) {
        console.warn(
          `[aio:test] settle() returned with ${
            count(stillRunning.length, "call")
          } ` +
            `still in flight: ${stillRunning.join(", ")}. Dispatch is quiet, ` +
            `so committed state is settled — but if you did not park these ` +
            `deliberately, await the call itself instead of settle().`,
        );
      }
      return;
    }
    throw new Error(
      `bootCells: settle() gave up after ${ROUNDS} rounds — dispatch is still ` +
        `producing work, so the app has NOT quiesced and any assertion after ` +
        `this point is unguarded.\n` +
        `  still running: ${stillRunning.join(", ") || "(unnamed calls)"}\n` +
        `  fix: await the call itself instead of settle(); drive time with ` +
        `\`await h.advance(ms)\` if it is waiting on a schedule; or give the ` +
        `method an abort path (\`s.$signal\`) if it genuinely never finishes.`,
    );
  };
  const dispose = () => {
    ledger.restore();
    standalone._resetState();
    // The process-global half — without this a hung call sits in `_pending`
    // for the rest of the process and every later settle() burns its whole
    // budget on it (see the boot note above).
    _resetAioRuntime();
    ledger.raise();
  };
  return {
    async advance(ms: number) {
      await standalone._advanceSchedules(ms);
      await settle();
    },
    settle,
    dispose,
    [Symbol.dispose]: dispose,
  };
}

// Semantic UI testing — first-class, selector-free (see
// docs/specs/2026-07-10-semantic-ui-testing.md).
export {
  type TestUI,
  testUI,
  type TestUIOptions,
  type UIComponentHandle,
  type UIElementHandle,
} from "./ui-test.ts";
export { generateUITypes, testGen } from "./ui-testgen.ts";
export {
  findChromium,
  freePort,
  type TestBrowser,
  testBrowser,
  type TestServer,
  testServer,
} from "./server-test.ts";
import { count } from "../diagnostics/fmt.ts";
