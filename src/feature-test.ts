// feature-test.ts — testFeature() harness for isolated feature testing

import type { ScheduleEffect } from './schedule.ts'
import { resetFlows } from './flow.ts'
import { resetPending } from './feature-impl.ts'
import type { Creators, Msg, Catalog, FeatureDef } from './feature-types.ts'
import { composeFeatures } from './feature-compose.ts'

/** Context object provided to testFeature() callbacks */
export type TestContext<
  S = Record<string, unknown>,
  // deno-lint-ignore no-explicit-any
  A = Record<string, (...args: any[]) => any>,
> = {
  /** Initialize/reset feature to initial state */
  init: () => void
  /** Destroy feature (reset to initial + 'uninitialized' status) */
  destroy: () => void
  /** Typed action senders — one per declared action, arguments inferred from action creators */
  send: { [K in keyof A & string]: A[K] extends (...args: infer P) => unknown ? (...args: P) => void : never }
  /** Assertions */
  expect: {
    /** Assert on feature state slice */
    // deno-lint-ignore no-explicit-any
    state: (fn: (s: any, ...args: any[]) => boolean) => void
    /** Assert current machine status */
    status: (expected: string) => void
    /** Assert effect types returned by last action (full type strings, e.g. 'counter:persist') */
    effects: (types: string[]) => void
    /** Assert number of effects returned by last action */
    effectCount: (n: number) => void
    /** Assert a predicate holds for current state */
    invariant: (fn: (s: S) => boolean) => void
  }
  /** Get current feature state */
  getState: () => S
  /** Get effects from last dispatched action */
  getEffects: () => (Msg | ScheduleEffect)[]
  /** Dispatch N random valid actions (for property-based testing) */
  randomActions: (n: number) => void
  /** Run pending effects (executor). Deprecated — `settle()` now auto-runs effects. */
  runEffects: () => void
  /** Run effects + wait for async to complete. Replaces `runEffects() + settle()`.
   *  No arg: drain microtasks (fast, for in-memory async). With ms: timer-based wait. */
  settle: (ms?: number) => Promise<void>
}

/** Test harness for isolated feature testing — wraps Deno.test with typed helpers */
export function testFeature<
  S extends Record<string, unknown> = Record<string, unknown>,
  N extends string = string,
  // deno-lint-ignore no-explicit-any
  A extends Creators = any,
  // deno-lint-ignore no-explicit-any
  E extends Creators = any,
>(
  f: FeatureDef<N, A, E, S>,
  testName: string,
  fn: (t: TestContext<S, Catalog<N, A>>) => void | Promise<void>,
): void {
  Deno.test(`[${f.__aio.id}] ${testName}`, async () => {
    // Reset shared runtime state for test isolation — prevents bleed from prior runs
    resetFlows()
    resetPending()

    // Compose a single-feature system
    const composed = composeFeatures([f])
    const machine = f.__aio.machine

    let state = { ...composed.initialState }
    let lastEffects: (Msg | ScheduleEffect)[] = []

    const app = {
      dispatch,
      getState: () => state,
    }

    function dispatch(action: Msg): void {
      const result = composed.reduce(state, action)
      state = { ...result.state }
      lastEffects = result.effects
    }

    // Build send proxy from action creators (cast to typed form — runtime matches compile-time shape)
    const send = {} as TestContext<S, Catalog<N, A>>['send']
    for (const key of f.__aio.actionKeys) {
      const creator = (f.__aio.actions as Record<string, unknown>)[key]
      if (typeof creator === 'function') {
        // deno-lint-ignore no-explicit-any
        ;(send as Record<string, (...args: any[]) => void>)[key] = (...args: unknown[]) => dispatch((creator as (...a: unknown[]) => Msg)(...args))
      }
    }

    const ctx: TestContext<S, Catalog<N, A>> = {
      init: () => {
        state = { ...composed.initialState }
        lastEffects = []
      },
      destroy: () => {
        const base = machine === false
          ? { ...f.__aio.state }
          : { ...f.__aio.state, _status: 'uninitialized' }
        state = { [f.__aio.id]: base }
        lastEffects = []
      },
      send,
      expect: {
        state: (check) => {
          const fs = state[f.__aio.id] as S
          if (!check(fs)) {
            throw new Error(`state assertion failed: ${JSON.stringify(fs)}`)
          }
        },
        status: (expected) => {
          const fs = state[f.__aio.id] as Record<string, unknown>
          const actual = fs._status
          if (actual !== expected) {
            throw new Error(`expected status '${expected}', got '${actual}'`)
          }
        },
        effects: (types) => {
          const actual = lastEffects.map(e => e.type as string).sort()
          const expected = [...types].sort()
          if (JSON.stringify(expected) !== JSON.stringify(actual)) {
            throw new Error(`expected effects [${expected}], got [${actual}]`)
          }
        },
        effectCount: (n) => {
          if (lastEffects.length !== n) {
            throw new Error(`expected ${n} effects, got ${lastEffects.length}`)
          }
        },
        invariant: (check) => {
          const fs = state[f.__aio.id] as S
          if (!check(fs)) {
            throw new Error(`invariant violation: ${JSON.stringify(fs)}`)
          }
        },
      },
      getState: () => state[f.__aio.id] as S,
      getEffects: () => lastEffects,
      randomActions: (n) => {
        const keys = f.__aio.actionKeys
        for (let i = 0; i < n; i++) {
          const key = keys[Math.floor(Math.random() * keys.length)]
          if (key) try { send[key]!() } catch { /* invalid transitions are expected */ }
        }
      },
      runEffects: () => {
        for (const eff of lastEffects) {
          composed.execute(app, eff as { type: string; payload: unknown })
        }
      },
      settle: async (ms?: number): Promise<void> => {
        // Auto-run pending effects first (eliminates need to call runEffects separately)
        for (const eff of lastEffects) {
          composed.execute(app, eff as { type: string; payload: unknown })
        }
        // Wait for async to complete — timer if ms given, otherwise drain microtasks
        if (ms !== undefined) {
          await new Promise(resolve => setTimeout(resolve, ms))
        } else {
          for (let i = 0; i < 10; i++) await Promise.resolve()
        }
      },
    }

    await fn(ctx)
  })
}

/** @deprecated bridge() removed in v0.8 — use call({ timeout, retries }, ...) instead */
export function testBridge(_b: FeatureDef, _testName: string, _fn: (t: never) => void): void {
  throw new Error('testBridge() removed in v0.8 — use call({ timeout, retries }) and testFeature() instead')
}
