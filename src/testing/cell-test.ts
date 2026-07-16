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
import { resetFlows } from "../state/flow.ts";
import { registerCall, resetPending } from "../state/cell-impl.ts";
import { attachMeta } from "../state/cell-catalog.ts";
import type { Catalog, CellDef, Creators, Msg } from "../state/cell-types.ts";
import { composeCells } from "../state/cell-compose.ts";

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
   */
  send: {
    [K in keyof A & string]: A[K] extends (...args: infer P) => unknown
      ? (...args: P) => Promise<void>
      : never;
  };
  /** Assertions */
  expect: {
    /** Assert on cell state slice */
    // deno-lint-ignore no-explicit-any
    state: (fn: (s: any, ...args: any[]) => boolean) => void;
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

/** Test harness for isolated cell testing — wraps Deno.test with typed helpers */
export function testCell<
  S extends Record<string, unknown> = Record<string, unknown>,
  N extends string = string,
  // deno-lint-ignore no-explicit-any
  A extends Creators = any,
  // deno-lint-ignore no-explicit-any
  E extends Creators = any,
>(
  f: CellDef<N, A, E, S>,
  testName: string,
  fn: (t: TestContext<S, Catalog<N, A>>) => void | Promise<void>,
): void {
  Deno.test(`[${f.__aio.id}] ${testName}`, async () => {
    // Reset shared runtime state for test isolation — prevents bleed from prior runs
    resetFlows();
    resetPending();

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

    function dispatch(action: Msg): void {
      const result = composed.reduce(state, action);
      state = { ...result.state };
      lastEffects = result.effects;
    }

    /** Execute an async-method trigger effect and return a promise that
     *  resolves when the method (and its batched writes) completed. */
    function runExec(eff: Msg): Promise<void> {
      executed.add(eff);
      const payload = eff.payload as Record<string, unknown>;
      const callId = (payload._callId as string | undefined) ??
        (payload._callId = crypto.randomUUID()) as string;
      const done = registerCall(callId);
      done.catch(() => {}); // mark handled — fire-and-forget callers must not surface unhandled rejections
      composed.execute(app, eff as { type: string; payload: unknown });
      // Propagate rejection to awaiters — matches production `await cell.method()`.
      return done.then(() => {});
    }

    async function drainMicrotasks(): Promise<void> {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }

    // Build send proxy from action creators (cast to typed form — runtime matches compile-time shape)
    const send = {} as TestContext<S, Catalog<N, A>>["send"];
    for (const key of f.__aio.actionKeys) {
      const creator = (f.__aio.actions as Record<string, unknown>)[key];
      if (typeof creator !== "function") continue;
      // deno-lint-ignore no-explicit-any
      (send as Record<string, (...args: any[]) => Promise<void>>)[key] = (
        ...args: unknown[]
      ) => {
        const msg = (creator as (...a: unknown[]) => Msg)(...args);
        if (!asyncMethods.has(key)) {
          dispatch(msg);
          return Promise.resolve();
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
        let started: Promise<void> | null = null;
        const start = (): Promise<void> => {
          if (started) return started;
          const pending = myExecs.filter((e) => !executed.has(e));
          started = pending.length === 0
            ? Promise.resolve() // machine-blocked, or already run via settle()
            : Promise.all(pending.map(runExec)).then(drainMicrotasks);
          return started;
        };
        return {
          then: (onF, onR) => start().then(onF, onR),
          catch: (onR) => start().catch(onR),
          finally: (onC) => start().finally(onC),
          [Symbol.toStringTag]: "Promise",
        } as Promise<void>;
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

    const ctx: TestContext<S, Catalog<N, A>> = {
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
          const fs = state[f.__aio.id] as S;
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
          const fs = state[f.__aio.id] as S;
          if (!check(fs)) {
            throw new Error(`invariant violation: ${JSON.stringify(fs)}`);
          }
        },
      },
      getState: () => state[f.__aio.id] as S,
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
        const completions: Promise<void>[] = [];
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

    await fn(ctx);
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
