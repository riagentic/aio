// send-pacer.ts — ONE writer per socket, held to the budget the server
// advertised.
//
// The server counts every inbound frame against a per-connection budget
// (`wsLimits.messagesPerSec`, 100 by default) and, since alpha77, says what it
// is in its hello (`ProtoHello.rate`). Only the sync engine read it. The path
// every button uses — `await cell.method()` — wrote each frame the instant it
// was called, so an ordinary `Promise.all` over 150 items put 150 frames into
// one second: 50 were dropped, fifty drops in a row closed the socket with
// 1008 and denylisted the page's address for a minute. The final count was 99,
// and the tab was gone from `am clients` until the block expired.
//
// A token bucket, FIFO, arrival-ordered. It holds FRAMES; what a waiting frame
// means when its socket dies (an action to re-queue, a log line to drop) is the
// transport's call, so `take()` hands them back rather than deciding.
//
// Pure of any socket or global: the clock and the timer are injectable, so the
// bound it promises is testable without a server.

/** What a pacer holds: a frame plus its place in line. `seq` orders the queue
 *  — a frame handed back for a retry lands where it was, not at the back. */
export type PacedFrame = { frame: string; seq: number };

/** Used when the peer advertises nothing (an older server): the server's own
 *  default, so an unaware peer is paced as if it were a default one. */
export const PACE_FALLBACK_RATE = 100;

/** The budget a client allows itself out of an advertised `rate`.
 *
 *  A bucket that refills at `perSec` and holds at most `burst` can put no more
 *  than `burst + perSec × T` frames into ANY interval of T seconds. The server
 *  counts in one-second windows, so the ceiling this client can reach in one
 *  of them is `burst + perSec` = 80% of the advertised budget. The 20% left is
 *  not waste: the server counts a frame when its event loop READS it, and a
 *  server that stalls for a moment reads a backlog in one go. What still gets
 *  through that gap is answered with a retry hint, never lost (see
 *  `server-ws.ts` `retryAfterMs`). */
export function paceBudget(
  advertised: number | undefined,
): { perSec: number; burst: number } {
  const rate = typeof advertised === "number" && Number.isFinite(advertised) &&
      advertised >= 1
    ? advertised
    : PACE_FALLBACK_RATE;
  return {
    perSec: Math.max(0.5, rate * 0.6),
    burst: Math.max(1, Math.floor(rate * 0.2)),
  };
}

export interface SendPacer<E extends PacedFrame> {
  /** Write `entry` now when the budget allows and nothing is waiting ahead of
   *  it; otherwise queue it. An immediate write that THROWS propagates — the
   *  caller still holds the entry and decides (queue offline, report). */
  push(entry: E): "sent" | "queued";
  /** Write nothing before `ms` from now — the server said its window is
   *  closed, and every frame sent into it would only be refused again. */
  hold(ms: number): void;
  /** Empty the queue, in order, and disarm the timer. */
  take(): E[];
  readonly length: number;
}

export type SendPacerOptions<E extends PacedFrame> = {
  /** Put the frame on the wire. Throwing means the transport refused it. */
  write: (entry: E) => void;
  /** A queued write was refused while draining. The pacer has already emptied
   *  itself: `entries` is the refused frame followed by everything behind it,
   *  in order — the caller owns every one of them now. */
  onRefused: (entries: E[], err: unknown) => void;
  /** The peer's advertised budget, read at every refill (the hello can arrive
   *  after the first frames went out). */
  rate: () => number | undefined;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
};

export function createSendPacer<E extends PacedFrame>(
  opts: SendPacerOptions<E>,
): SendPacer<E> {
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ??
    ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ??
    ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const queue: E[] = [];
  let tokens = paceBudget(opts.rate()).burst;
  let last = now();
  let holdUntil = 0;
  let timer: unknown = undefined;

  const refill = (): void => {
    const t = now();
    const { perSec, burst } = paceBudget(opts.rate());
    tokens = Math.min(burst, tokens + ((t - last) / 1000) * perSec);
    last = t;
  };

  /** Timer armed ONLY while something waits — an idle socket holds no handle
   *  open (the op sanitizers catch exactly that). */
  const arm = (): void => {
    if (timer !== undefined || queue.length === 0) return;
    const t = now();
    const { perSec } = paceBudget(opts.rate());
    const untilToken = tokens >= 1 ? 0 : ((1 - tokens) / perSec) * 1000;
    const wait = Math.max(untilToken, holdUntil - t, 0);
    timer = setTimer(() => {
      timer = undefined;
      drain();
    }, Math.ceil(wait) + 1);
  };

  const drain = (): void => {
    refill();
    while (queue.length > 0 && tokens >= 1 && now() >= holdUntil) {
      const entry = queue[0]!;
      try {
        opts.write(entry);
      } catch (err) {
        const refused = queue.splice(0);
        opts.onRefused(refused, err);
        return;
      }
      queue.shift();
      tokens -= 1;
    }
    arm();
  };

  return {
    push(entry) {
      refill();
      if (queue.length === 0 && tokens >= 1 && now() >= holdUntil) {
        opts.write(entry); // a throw propagates: the caller still has it
        tokens -= 1;
        return "sent";
      }
      // Arrival order: a frame handed back for a retry carries its original
      // seq and goes back where it was.
      let i = queue.length;
      while (i > 0 && queue[i - 1]!.seq > entry.seq) i--;
      queue.splice(i, 0, entry);
      arm();
      return "queued";
    },
    hold(ms) {
      if (!(ms > 0)) return;
      holdUntil = Math.max(holdUntil, now() + ms);
      // Re-arm against the new horizon: a timer set for the next token would
      // fire into the closed window.
      if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
      }
      arm();
    },
    take() {
      if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
      }
      return queue.splice(0);
    },
    get length() {
      return queue.length;
    },
  };
}
