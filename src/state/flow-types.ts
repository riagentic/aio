// flow-types.ts — shared types and FlowHistory for flow system

import type { FlowStepRecord } from "../diagnostics/error.ts";

// ── FlowHistory — ring buffer for step tracking ─────────────────────

export class FlowHistory {
  private _entries: FlowStepRecord[] = [];
  private _cap: number;

  constructor(cap = 50) {
    this._cap = cap;
  }

  push(action: string): number {
    const step = this._entries.length > 0
      ? this._entries[this._entries.length - 1]!.step + 1
      : 0;
    this._entries.push({ step, action, status: "pending" });
    if (this._entries.length > this._cap) this._entries.shift();
    return step;
  }

  markOk(stepNum: number): void {
    const e = this._entries.find((e) => e.step === stepNum);
    if (e) e.status = "ok";
  }

  markError(stepNum: number): void {
    const e = this._entries.find((e) => e.step === stepNum);
    if (e) e.status = "error";
  }

  entries(): FlowStepRecord[] {
    return [...this._entries];
  }
}

// ── Types ────────────────────────────────────────────────────────────

export type FlowApp = {
  dispatch: (action: Msg) => void;
  getState: () => Record<string, unknown>;
};

import type { Msg } from "./cell-types.ts";

/** Yielded descriptor — internal protocol between generator and runner */
export type FlowStep =
  | {
    kind: "call";
    name: string;
    fn: () => unknown | Promise<unknown>;
    opts?: { timeout?: number; retries?: number };
  }
  | {
    kind: "step";
    name: string;
    mutate: (draft: Record<string, unknown>) => void;
  }
  | { kind: "done"; mutate?: (draft: Record<string, unknown>) => void }
  | { kind: "fail"; reason: string }
  | { kind: "dispatch"; action: { type: string; payload?: unknown } }
  | { kind: "all"; entries: FlowStep[] }
  | { kind: "race"; entries: Record<string, FlowStep> }
  | { kind: "sleep"; name: string; ms: number }
  | { kind: "waitFor"; actionType: string; timeout?: number }
  | {
    kind: "when";
    predicate: (state: Record<string, unknown>) => boolean;
    timeout?: number;
  };

/** Generator return type for flows */
export type Gen<T = void> = Generator<FlowStep, T, unknown>;

/** Single-step generator — yields exactly one FlowStep then returns.
 *  Returned by ctx.call() and ctx.sleep(). Required by ctx.all() and ctx.race().
 *  Passing a multi-step generator (ctx.mutate, custom generators) causes a compile-time error.
 *  At runtime, a guard still throws if a multi-step generator sneaks through via cast. */
export type SingleStepGen<T = void> = Gen<T> & { readonly __singleStep: true };

/** Action creator with attached .type — as returned by cell.actionKey.
 *  Pass to waitFor() for typed payload inference: `yield* ctx.waitFor(gateway.running)` */
export type TypedCreator<P = unknown> = {
  readonly type: string;
  (...args: unknown[]): { type: string; payload: P };
};

/** Context object passed to flow generators.
 *  S is the cell's state shape — inferred from the `state:` config. */
export type GenCtx<S = Record<string, unknown>> = {
  /** Async call — dispatches action, executes fn, returns result.
   *  Optional opts for timeout (ms) and retries (count).
   *  Returns SingleStepGen — safe to pass to ctx.all() and ctx.race(). */
  call: <T>(
    name: string,
    fn: () => T | Promise<T>,
    opts?: { timeout?: number; retries?: number },
  ) => SingleStepGen<Awaited<T>>;
  /** State mutation — dispatches action, applies Immer draft update */
  mutate: (name: string, mutate: (draft: S) => void) => Gen<void>;
  /** Terminal success — dispatches done action, optional final state update */
  done: (mutate?: (draft: S) => void) => Gen<void>;
  /** Terminal failure — dispatches fail action with reason */
  fail: (reason: string) => Gen<never>;
  /** Dispatch an action to any cell */
  dispatch: (action: { type: string; payload?: unknown }) => Gen<void>;
  /** Shorthand dispatch — pass a bound method (with .type) or plain type string.
   *  @example yield* ctx.send(analytics.log, { msg: 'done' }) */
  send: (
    creatorOrType: { type: string } | string,
    payload?: unknown,
  ) => Gen<void>;
  /** Run multiple calls in parallel, wait for all.
   *  Only single-step generators allowed (ctx.call, ctx.sleep) — enforced at compile time.
   *  Spread form: const [a, b] = yield* ctx.all(gen1, gen2)
   *  Named form:  const { a, b } = yield* ctx.all({ a: gen1, b: gen2 }) */
  all: {
    <T extends readonly SingleStepGen<unknown>[]>(
      ...gens: T
    ): Gen<{ [K in keyof T]: T[K] extends Gen<infer R> ? R : never }>;
    <T extends Record<string, SingleStepGen<unknown>>>(
      entries: T,
    ): Gen<{ [K in keyof T]: T[K] extends Gen<infer R> ? R : never }>;
  };
  /** Race multiple calls — first to complete wins, rest are conceptually cancelled.
   *  Only single-step generators allowed (ctx.call, ctx.sleep) — enforced at compile time. */
  race: <T extends Record<string, SingleStepGen<unknown>>>(
    entries: T,
  ) => Gen<{ [K in keyof T]?: T[K] extends Gen<infer R> ? R : never }>;
  /** Sleep for N ms — dispatches a named action for visibility.
   *  Returns SingleStepGen — safe to pass to ctx.all() and ctx.race(). */
  sleep: (name: string, ms: number) => SingleStepGen<void>;
  /** Wait for an action to be dispatched — pauses flow until matching action arrives.
   *  Pass a bound method (.type) or action creator for typed payload inference.
   *  @example yield* ctx.waitFor(gateway.running)       // bound method — untyped payload
   *  @example yield* ctx.waitFor(gateway.running)     // bound method — typed payload */
  waitFor: {
    <P>(
      creator: TypedCreator<P>,
      timeout?: number,
    ): SingleStepGen<{ type: string; payload: P }>;
    (
      creatorOrType: { type: string } | string,
      timeout?: number,
    ): SingleStepGen<Msg>;
  };
  /** Wait until a state condition is true. Checks immediately, then after every dispatch.
   *  Returns SingleStepGen — safe to pass to ctx.all() and ctx.race().
   *  @param predicate — receives full app state, returns boolean
   *  @param opts.timeout — ms before the wait fails (default: no timeout) */
  when: (
    predicate: (appState: Record<string, unknown>) => boolean,
    opts?: { timeout?: number },
  ) => SingleStepGen<void>;
  /** Read current cell state (fresh after each step) */
  getState: () => S;
  /** Read full app state tree (all cells). Fresh after each flow step. */
  getFullState: () => Record<string, unknown>;
};

/** Flow options — kept for internal use */
export type FlowOptions = {
  cancelOn?: string[];
};

/** Flow definition — internal, consumed by cell() */
export type FlowDef = {
  trigger: string;
  // deno-lint-ignore no-explicit-any
  generator: (ctx: GenCtx<any>, ...args: unknown[]) => Gen<unknown>;
  /** Auto-generated action types from yield point names */
  _stepNames: string[];
  /** Action keys that cancel this flow */
  cancelOn?: string[];
  /** How to unpack the triggering action's payload into generator args:
   *  'spread' — payload.args array is spread (methods-style: item, qty, ...)
   *  'payload' — payload object is passed directly (actions-style: { item, qty }) */
  argsStyle: "spread" | "payload";
};

/** Internal: status for a running flow instance */
export type FlowInstance = {
  generator: Gen<unknown>;
  cellName: string;
  flowName: string;
  prefix: string;
  aborted: boolean;
  /** AbortController for waitFor — cancellation is instant via signal, no polling */
  abortController?: AbortController;
  /** Active state listeners for ctx.when — tracked for abort cleanup (AIO-263: Set for parallel when()) */
  stateListeners: Set<StateListener>;
};

export type ActionListener = {
  actionType: string;
  resolve: (action: Msg) => void;
};
export type StateListener = {
  predicate: (state: Record<string, unknown>) => boolean;
  resolve: () => void;
};

// ── Internal sentinel thrown by ctx.fail() ────────────────────────────

/** Thrown by executeStep("fail") so generator finally blocks run cleanly.
 *  Caught in runFlow to exit without logging (AIO-253). */
export class FlowFailError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "FlowFailError";
  }
}
