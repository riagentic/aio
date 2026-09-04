// within — race a promise against a deadline WITHOUT leaving the deadline
// behind.
//
// `Promise.race([work, new Promise((r) => setTimeout(r, ms))])` is the shape
// every "did it hang?" assertion in this suite reaches for, and it has a
// leak built in: when `work` wins, the deadline timer is still armed, and the
// op sanitizer names it — correctly — as a timer the test started and never
// completed. Fifteen tests carried that copy. This is the one copy, and it
// clears the loser.

/** Resolve with `work`'s outcome, or with `onTimeout` after `ms`. The timer is
 *  cleared either way, so a winning `work` leaves nothing armed. */
export function within<T, U>(
  work: Promise<T>,
  ms: number,
  onTimeout: U,
): Promise<T | U> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<U>((r) => {
    timer = setTimeout(() => r(onTimeout), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** A cancellable sleep for a race branch: `sleep.cancel()` clears the timer
 *  when the other branch won. Plain `await sleep(ms)` still works. */
export function sleepFor(ms: number): Promise<void> & { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const p = new Promise<void>((r) => {
    timer = setTimeout(r, ms);
  }) as Promise<void> & { cancel(): void };
  p.cancel = () => clearTimeout(timer);
  return p;
}
