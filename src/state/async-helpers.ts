// async-helpers.ts — the method-native replacements for generator workflows
// (perfect-aio D1). A plain `async` method plus these three helpers covers
// everything `yield* ctx.waitFor/race/sleep` could express, in the language
// every JS developer already knows.
//
//   async checkout(s) {
//     s.status = "paying";
//     await api.pay(s.total);
//     await until(() => s.confirmed, { timeoutMs: 30_000 });
//     s.status = "paid";
//   }

import type { ScheduleTimers } from "./schedule.ts";

/** Options for {@linkcode until}. */
export interface UntilOptions {
  /** Give up after this many ms (default 30_000). Throws UntilTimeoutError. */
  timeoutMs?: number;
  /** Poll interval in ms (default 25). */
  intervalMs?: number;
  /** Abort signal — e.g. `s.$signal` so `cancelOn` stops the wait too. */
  signal?: AbortSignal;
  /** Description shown in the timeout error (like expectCell/waitFor). */
  msg?: string;
}

/** Thrown when {@linkcode until} exceeds its timeout. */
export class UntilTimeoutError extends Error {
  constructor(ms: number, msg?: string) {
    super(`until(): condition not met within ${ms}ms${msg ? ` — ${msg}` : ""}`);
    this.name = "UntilTimeoutError";
  }
}

/** Wait until `pred()` returns true (polling). The method-native
 *  `yield* ctx.waitFor` / `ctx.when`: works on any condition over state —
 *  `await until(() => s.status === "ready")`. Fail-loud: times out with a
 *  clear error instead of hanging forever. */
export function until(
  pred: () => boolean,
  opts: UntilOptions = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 25;
  return new Promise((resolve, reject) => {
    if (pred()) return resolve();
    const started = Date.now();
    const timer = setInterval(() => {
      try {
        if (opts.signal?.aborted) {
          clearInterval(timer);
          return reject(
            new DOMException("until(): aborted", "AbortError"),
          );
        }
        if (pred()) {
          clearInterval(timer);
          return resolve();
        }
        if (Date.now() - started >= timeoutMs) {
          clearInterval(timer);
          return reject(new UntilTimeoutError(timeoutMs, opts.msg));
        }
      } catch (e) {
        clearInterval(timer);
        reject(e);
      }
    }, intervalMs);
  });
}

/** Race named branches — the method-native `yield* ctx.race`. Resolves with
 *  `{ winner, value }` of the first branch to settle; other branches keep
 *  running but their results are ignored (pass `s.$signal`-aware work to
 *  make them stop). `timeout: ms` sugar adds a timeout branch:
 *
 *  ```ts
 *  const r = await race({ paid: until(() => s.paid), timeout: 30_000 });
 *  if (r.winner === "timeout") s.status = "expired";
 *  ``` */
export async function race<T extends Record<string, Promise<unknown> | number>>(
  branches: T,
): Promise<RaceResult<T>> {
  // A `timeout: ms` branch is a timer, and a timer that LOST the race used to
  // stay armed until it fired: `race({ paid: until(...), timeout: 30_000 })`
  // won by `paid` in 50 ms kept the process alive for the other 29.95 s —
  // a CLI command that had its answer and would not exit, a test the op
  // sanitizer fails. The promise branches are the app's to stop (`s.$signal`);
  // the timers are ours, and every one is cleared once a winner is known.
  const timers: (() => void)[] = [];
  const entries = Object.entries(branches).map(([key, v]) =>
    typeof v === "number"
      ? new Promise<void>((r) => {
        timers.push(_armSleep(r, v));
      }).then(() => ({ winner: key, value: undefined }))
      : (v as Promise<unknown>).then((value) => ({ winner: key, value }))
  );
  try {
    return await Promise.race(entries) as RaceResult<T>;
  } finally {
    for (const clear of timers) clear();
  }
}

/** What {@linkcode race} resolves to: ONE member per branch, so narrowing on
 *  `winner` narrows `value` with it.
 *
 *  It used to be the flat `{ winner: keyof T & string; value: unknown }`, and
 *  the whole point of naming the branches was lost at the return: every use of
 *  the winner's value needed a cast, and `deno check` reported TS18046
 *  ("'value' is of type 'unknown'") on the shape `mod.ts`'s own module example
 *  teaches. A `sleep`-branch (`timeout: 30_000`) carries no value, so its
 *  member is `undefined`; a branch whose type is not statically a promise
 *  (a record annotated `Record<string, Promise<unknown> | number>`) keeps the
 *  old `unknown` rather than being narrowed to a wrong answer. */
export type RaceResult<T> = {
  [K in keyof T & string]: {
    winner: K;
    value: T[K] extends Promise<infer V> ? V
      : T[K] extends number ? undefined
      : unknown;
  };
}[keyof T & string];

/** Promise sleep — the method-native `yield* ctx.sleep`. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    _armSleep(r, ms);
  });
}

/** The virtual clock a test harness drives with `advance(ms)`. */
export type SleepClock = Pick<ScheduleTimers, "setTimeout" | "clearTimeout">;
let _sleepClock: (() => SleepClock | null) | null = null;

/** Test harness only: the virtual clock `sleep()` and `race`'s `timeout`
 *  branch also answer to. `sleep()` used to take REAL time however far a test
 *  advanced — `await sleep(10_000)` in a method outlived `await h.advance(
 *  10_000)`, so the test waited ten real seconds or asserted on a state that
 *  had not happened yet. Real time still counts (see {@linkcode _armSleep}),
 *  so a test that never advances waits exactly as it always did. Installed by
 *  the harness next to the call ceilings' clock; `null` uninstalls.
 *  @internal */
export function _setSleepClock(get: (() => SleepClock | null) | null): void {
  _sleepClock = get;
}

/** Arm `fn` after `ms` on the real clock and, when a harness installed one, on
 *  its virtual clock too — the first to fire runs `fn` once and disarms the
 *  other (the call ceilings' rule, `_armCallTimer`). Returns the disarm. */
function _armSleep(fn: () => void, ms: number): () => void {
  const v = _sleepClock?.() ?? null;
  let vh: ReturnType<typeof setTimeout> | undefined;
  const clear = (): void => {
    clearTimeout(real);
    if (v && vh !== undefined) v.clearTimeout(vh);
  };
  const fire = (): void => {
    clear();
    fn();
  };
  const real = setTimeout(fire, ms);
  if (v) vh = v.setTimeout(fire, ms);
  return clear;
}
