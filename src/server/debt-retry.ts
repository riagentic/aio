// Owed rounds are PAID, not merely remembered — the ONE retry scheduler both
// state transports use.
//
// A round lost for a client (a socket not draining, a backpressure window, a
// view that could not be built, a round that threw) marks it `needsFull`, and
// only a LATER round honoured the mark. An app that goes idle after the loss
// has no later round, so the client sat on the state from before it for as
// long as nothing changed — server idle, health green. The WS broadcaster
// grew a retry for that first (tests/ws-backlog-debt-paid-when-idle.test.ts);
// the UDS transport, where every desktop client lives, had none. Both arm THIS
// scheduler now, so the timing rule — retry soon, back off to a slow poll for
// a peer that never recovers, never keep the process alive — cannot drift
// between them. What "paying" means stays with each transport.

/** Retry timing — exported for tests; not configuration. */
export const DEBT_RETRY_MAX_MS = 1000;

export type DebtRetry = {
  /** A round left a debt: make sure a payment is scheduled. `fresh` (a NEW
   *  debt) restarts the backoff at its shortest delay. */
  arm(fresh: boolean): void;
  /** Stop for good — clears the timer; later `arm` calls are no-ops. */
  dispose(): void;
};

/** `pay` runs on the timer and answers whether anything is STILL owed; a
 *  `true` re-arms it with a doubled delay (capped at {@linkcode
 *  DEBT_RETRY_MAX_MS}). A throw from `pay` counts as still owed — `onError`
 *  hears it — so a failing payer backs off rather than going quiet. */
export function createDebtRetry(opts: {
  minMs: number;
  pay: () => boolean;
  onError: (e: unknown) => void;
}): DebtRetry {
  const minMs = Math.max(opts.minMs, 50);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = minMs;
  let disposed = false;
  const run = (): void => {
    timer = undefined;
    let owed: boolean;
    try {
      owed = opts.pay();
    } catch (e) {
      owed = true;
      opts.onError(e);
    }
    if (owed) {
      delay = Math.min(delay * 2, DEBT_RETRY_MAX_MS);
      arm(false);
    }
  };
  function arm(fresh: boolean): void {
    if (disposed) return;
    if (fresh) delay = minMs;
    if (timer !== undefined) return;
    timer = setTimeout(run, delay);
    // Never why a process stays alive — dispose clears it regardless.
    Deno.unrefTimer?.(timer as unknown as number);
  }
  return {
    arm,
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
