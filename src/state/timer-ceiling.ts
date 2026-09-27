// The timer ceiling, in a LEAF module (no imports): `cell-impl`,
// `async-helpers` and `schedule` all need it, and taking it from `schedule`
// closed an import cycle back into `cell-impl` — harmless until a bundler
// orders the evaluation differently and a read lands in the TDZ.

/** setTimeout's int32 ceiling. A delay past it is truncated to ~1 ms — the
 *  timer fires at once instead of in N days. See `schedule.ts` for the long
 *  story. @internal */
export const MAX_TIMER_DELAY = 2_147_483_647; // 2^31-1 ms ≈ 24.85 days

/** `setTimeout` that really waits `ms`, even past its int32 ceiling — which
 *  it truncates to ~1 ms, so `sleep(30 days)` returned at once. Re-arms in
 *  ceiling-sized steps. Returns the disarm.
 *  @internal */
export function armLong(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout>;
  const arm = (left: number): void => {
    t = left > MAX_TIMER_DELAY
      ? setTimeout(() => arm(left - MAX_TIMER_DELAY), MAX_TIMER_DELAY)
      : setTimeout(fn, left);
  };
  arm(ms);
  return () => clearTimeout(t);
}

/** An app-supplied delay for a timer that must NOT re-arm (an interval, a
 *  debounce, a request ceiling), capped at the ceiling — past it the timer
 *  fires in ~1 ms, so a 30-day heartbeat ran every millisecond. NaN (a
 *  `Number(env)` left unset), or a value under `min`, is not a delay: the
 *  platform reads it as ~0, a hot loop or an instant failure, so `fallback`
 *  (the key's default) is used instead. `warn` hears which `key` was
 *  replaced. @internal */
export function capDelay(
  key: string,
  ms: number,
  warn: (msg: string) => void,
  fallback: number,
  min = -Infinity,
): number {
  if (!(ms >= min)) {
    warn(
      `${key}: ${ms} is not a usable delay (it must be a number of ` +
        `milliseconds${min > -Infinity ? `, at least ${min}` : ""}); ` +
        `using ${fallback}ms`,
    );
    return fallback;
  }
  if (!(ms > MAX_TIMER_DELAY)) return ms;
  warn(
    `${key}: ${ms}ms — longer than a timer can wait (${MAX_TIMER_DELAY}ms ≈ ` +
      `24.8 days), which would fire in ~1 ms; using ${MAX_TIMER_DELAY}ms`,
  );
  return MAX_TIMER_DELAY;
}

/** The shortest period an app-configured INTERVAL may have (the same floor
 *  as `schedule.every`): under it a sampler is a busy loop. @internal */
export const MIN_INTERVAL_MS = 10;
