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
  const entries = Object.entries(branches).map(([key, v]) =>
    typeof v === "number"
      ? sleep(v).then(() => ({ winner: key, value: undefined }))
      : (v as Promise<unknown>).then((value) => ({ winner: key, value }))
  );
  return await Promise.race(entries) as RaceResult<T>;
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
  return new Promise((r) => setTimeout(r, ms));
}
