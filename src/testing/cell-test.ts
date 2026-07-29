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
import { _resetAioRuntime } from "../state/runtime-reset.ts";
import { attachMeta } from "../state/cell-catalog.ts";
import type { Catalog, CellDef, Creators, Msg } from "../state/cell-types.ts";
import { composeCells } from "../state/cell-compose.ts";

/** Arm dev-strict checks for every test harness (risoto 2026-07-18). Tests
 *  must be the STRICTEST environment, not the most permissive — the runtime
 *  freezes committed state in dev + prod so an illegal in-place mutation
 *  throws loudly, but the harness historically ran with `__aioDev` unset, so
 *  the same mutation silently succeeded in a green test (harness lied). Arming
 *  it here makes a passing test mean what production means. Idempotent; a test
 *  that specifically needs prod-lenient behavior can set the flag false itself.
 *  @internal */
export function _armTestStrict(): void {
  (globalThis as Record<string, unknown>).__aioDev = true;
  _sandboxAppDirs();
}

// A harness must not be able to write into the user's home — not by design, and
// not by accident. App code legitimately asks `appDirs(appId)` where its files
// live (`<data>/files`, `<data>/tls`, …), and under a test that resolved to the
// developer's REAL `~/.<appId>`: one field report's server tests installed a
// fixture binary into the real install for the whole project, and the pollution
// then HID a second bug by making two tests pass against an artefact that only
// existed on that machine ("not a footgun — a loaded gun pointed at data the
// developer cares about", llama.md).
//
// So the first harness use of the process pins every app directory into a temp
// sandbox, unless the runner already pinned one (aio's own suite does, in its
// `deno test` task). An explicit `registerAppDirs()` still wins per app — that is
// the escape hatch for a test that wants a specific fixture directory.
let _sandboxed = false;
function _sandboxAppDirs(): void {
  if (_sandboxed) return;
  _sandboxed = true;
  try {
    if (Deno.env.get("AIO_APPS_DIR")) return; // runner already pinned it
    const dir = Deno.makeTempDirSync({ prefix: "aio-test-apps-" });
    Deno.env.set("AIO_APPS_DIR", dir);
    globalThis.addEventListener("unload", () => {
      try {
        Deno.removeSync(dir, { recursive: true });
      } catch { /* best effort — it is a temp dir */ }
    });
  } catch { /* no env/tmp permission: leave resolution as-is */ }
}

/** Context object provided to testCell() callbacks */
export type TestContext<
  S = Record<string, unknown>,
  // deno-lint-ignore no-explicit-any
  A = Record<string, (...args: any[]) => any>,
> = {
  /** Initialize/reset cell to initial state */
  init: () => void;
  /** Destroy cell (reset to initial + 'uninitialized' status) */
  destroy: () => void;
  /** Typed action senders — one per declared action, arguments inferred from action creators.
   *
   *  Fire-and-forget by default (sync dispatch, like production `cell.method()`).
   *  AIO-379: **awaiting** the returned promise runs the method to completion —
   *  for async methods this executes the trigger and resolves when the method
   *  (and all its state writes) have been applied:
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
    /** Assert on cell state slice (typed — `s` is the cell's state, tbd B8) */
    // deno-lint-ignore no-explicit-any
    state: (fn: (s: S, ...args: any[]) => boolean) => void;
    /** Assert current machine status */
    status: (expected: string) => void;
    /** Assert effect types returned by last action (full type strings, e.g. 'counter:persist') */
    effects: (types: string[]) => void;
    /** Assert number of effects returned by last action */
    effectCount: (n: number) => void;
    /** Assert a predicate holds for current state */
    invariant: (fn: (s: S) => boolean) => void;
  };
  /** Get current cell state */
  getState: () => S;
  /** Get effects from last dispatched action */
  getEffects: () => (Msg | ScheduleEffect | OwnEffect)[];
  /** Dispatch N random valid actions (for property-based testing) */
  randomActions: (n: number) => void;
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
 *  (tbd B8 / inews #8). Selector accessors (plain returns) and actions-form
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
 *  resolved return types mirror production `await cell.method(...)` (tbd B8 /
 *  inews #8). Actions-form cells (empty SendSurface) keep the loose senders.
 *  (A plain intersection can't narrow: `Promise<unknown> & Promise<R>` awaits
 *  to unknown.) */
type TestCtxOf<F> = keyof SendSurface<F> extends never
  ? TestContext<CellStateOf<F>, Catalog<CellNameOf<F>, CellActionsOf<F>>>
  :
    & Omit<
      TestContext<CellStateOf<F>, Catalog<CellNameOf<F>, CellActionsOf<F>>>,
      "send"
    >
    & { send: SendSurface<F> };

/** Test harness for isolated cell testing — wraps Deno.test with typed
 *  helpers. Everything is inferred from the cell ref: state (`t.getState()`,
 *  `t.expect.state`), sender args, and sender RETURN types. */
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
    // other harness was an inconsistency, not a design (llama-master #4). It
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
      // AIO-427: surface the sync method's transported return value.
      return (result as { ret?: unknown }).ret;
    }

    /** Execute an async-method trigger effect and return a promise that
     *  resolves when the method (and its batched writes) completed. */
    function runExec(eff: Msg): Promise<unknown> {
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
      composed.execute(app, eff as { type: string; payload: unknown });
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
          // Sync method: dispatch runs the reducer now; resolve with its return.
          return Promise.resolve(dispatch(msg));
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
        // Lazy completion: dispatching stays synchronous (legacy tests see the
        // exact old behavior — no timers, no executor runs). Awaiting the
        // promise executes the trigger and resolves on real method completion.
        let started: Promise<unknown> | null = null;
        const start = (): Promise<unknown> => {
          if (started) return started;
          const pending = myExecs.filter((e) => !executed.has(e));
          started = pending.length === 0
            ? Promise.resolve(undefined) // machine-blocked, or already run via settle()
            // AIO-427: resolve with the method's transported return value (the
            // last trigger's, matching production single-method dispatch).
            : Promise.all(pending.map(runExec)).then(async (vals) => {
              await drainMicrotasks();
              return vals[vals.length - 1];
            });
          return started;
        };
        return {
          then: (onF, onR) => start().then(onF, onR),
          catch: (onR) => start().catch(onR),
          finally: (onC) => start().finally(onC),
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
      init: () => {
        state = { ...composed.initialState };
        lastEffects = [];
      },
      destroy: () => {
        const base = machine === false
          ? { ...f.__aio.state }
          : { ...f.__aio.state, __aio_status: machine.initial };
        state = { [f.__aio.id]: base };
        lastEffects = [];
      },
      send,
      expect: {
        state: (check) => {
          const fs = state[f.__aio.id] as Record<string, unknown>;
          if (!check(fs)) {
            throw new Error(`state assertion failed: ${JSON.stringify(fs)}`);
          }
        },
        status: (expected) => {
          const fs = state[f.__aio.id] as Record<string, unknown>;
          const actual = fs.__aio_status;
          if (actual !== expected) {
            throw new Error(`expected status '${expected}', got '${actual}'`);
          }
        },
        effects: (types) => {
          const actual = lastEffects.map((e) => e.type as string).sort();
          const expected = [...types].sort();
          if (JSON.stringify(expected) !== JSON.stringify(actual)) {
            throw new Error(`expected effects [${expected}], got [${actual}]`);
          }
        },
        effectCount: (n) => {
          if (lastEffects.length !== n) {
            throw new Error(`expected ${n} effects, got ${lastEffects.length}`);
          }
        },
        invariant: (check) => {
          const fs = state[f.__aio.id] as Record<string, unknown>;
          if (!check(fs)) {
            throw new Error(`invariant violation: ${JSON.stringify(fs)}`);
          }
        },
      },
      getState: () => state[f.__aio.id] as Record<string, unknown>,
      getEffects: () => lastEffects,
      randomActions: (n) => {
        const keys = f.__aio.actionKeys;
        for (let i = 0; i < n; i++) {
          const key = keys[Math.floor(Math.random() * keys.length)];
          if (key) {
            try {
              send[key]!();
            } catch { /* invalid transitions are expected */ }
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
        const completions: Promise<unknown>[] = [];
        for (const eff of lastEffects) {
          if (executed.has(eff)) continue;
          if ((eff as Msg).type === execType) {
            completions.push(runExec(eff as Msg));
          } else {
            executed.add(eff);
            composed.execute(app, eff as { type: string; payload: unknown });
          }
        }
        if (completions.length > 0) await Promise.allSettled(completions);
        // Timer wait if ms given (for real setTimeout chains), else drain microtasks
        if (ms !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, ms));
        } else {
          await drainMicrotasks();
        }
      },
    };

    try {
      await fn(ctx);
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
 * dance (risoto).
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
export async function bootCells(cells: CellDef[]): Promise<BootHandle> {
  _armTestStrict();
  const standalone = await import("../standalone-air.ts");
  // Hermetic: reset any prior runtime state so these cells start pristine.
  standalone._resetState();
  await standalone.aio.run({
    appId: "bootcells",
    // deno-lint-ignore no-explicit-any
    cells: cells as any,
    persist: false,
  });
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const dispose = () => standalone._resetState();
  return {
    async advance(ms: number) {
      standalone._advanceSchedules(ms);
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
export { generateUITypes, testgen } from "./ui-testgen.ts";
export {
  findChromium,
  freePort,
  type TestBrowser,
  testBrowser,
  type TestServer,
  testServer,
} from "./server-test.ts";
