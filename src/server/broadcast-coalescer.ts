// broadcast-coalescer.ts — the single coalescing primitive both the WS and the
// UDS broadcasters use, so their throttle/buffer semantics can NEVER diverge.
//
// History: the WS and UDS broadcasters each hand-rolled their own throttle. The
// WS one buffered patches across the window; the UDS one dropped them (set a
// dirty flag, discarded the patch array, then sent a no-arg full state). Under
// the ~50ms throttle the 2nd+ mutation in a burst was silently lost for UDS
// clients — the risoto 2026-07-19 "frozen balance" bug. Two throttles, one
// buffered, one dropped. This primitive removes that asymmetry by construction:
// there is one buffer-and-flush, and each transport supplies only its own
// send.
//
// Semantics: leading-edge flush on the next microtask (coalesces a synchronous
// burst), then a trailing-edge flush after `throttleMs`. Items pushed at any
// point are buffered and flushed — never dropped. A force-full request
// (`forceFull()`, or `add()` with no items) flushes as a full-state send.

/** A coalescer that batches `add`/`forceFull` calls and flushes at most once
 *  per microtask + once per throttle window, never dropping buffered items. */
export interface Coalescer<T> {
  /** Buffer items for the next flush. With no items, requests a full-state
   *  flush (the transports' "something changed, no patch payload" signal). */
  add(items?: T[]): void;
  /** Request a full-state flush on the next tick. */
  forceFull(): void;
  /** INTERACTIVE priority: flush whatever is buffered RIGHT NOW and close the
   *  throttle window, so the next mutation goes leading-edge again. For
   *  client-originated actions — the throttle exists to pace background
   *  churn, not to add up to `throttleMs` of latency to a user's keystroke
   *  (risoto 2026-07-25: every navigation key paid ~50ms here). No-op when
   *  nothing is buffered. */
  flushUrgent(): void;
  /** Cancel any pending throttle timer (for shutdown). */
  dispose(): void;
}

// Interactive-priority registry: every live coalescer registers its urgent
// flush here, so the dispatch layer can flush ALL transports after a
// client-originated action without threading handles through every
// composition layer (WS broadcaster and UDS controller live far apart).
const urgentRegistry = new Set<() => void>();

/** Flush every live coalescer NOW — called after a client action commits so
 *  its patches never wait out the background throttle window. */
export function flushAllUrgent(): void {
  for (const f of urgentRegistry) f();
}

/** Create a coalescer. `flush(buffered, force)` performs the transport-specific
 *  send: `buffered` is every item accumulated since the last flush (possibly
 *  empty); `force` is true when a full-state send was requested. */
export function createCoalescer<T>(
  throttleMs: number,
  flush: (buffered: T[], force: boolean) => void,
): Coalescer<T> {
  let buffer: T[] = [];
  let force = false;
  let queued = false;
  let throttle: ReturnType<typeof setTimeout> | null = null;

  // Drain at flush time (not at schedule time): any item added during the
  // schedule→run gap or the throttle window is still in `buffer` here, so it
  // is flushed rather than stranded.
  const drain = (): void => {
    const f = force;
    const b = buffer;
    force = false;
    buffer = [];
    flush(b, f);
  };

  const schedule = (): void => {
    if (queued) return; // a leading flush is already pending
    if (throttleMs > 0 && throttle) return; // in the throttle window — buffered, flushed on the tail
    queued = true;
    queueMicrotask(() => {
      queued = false;
      // Leading edge — unless an urgent flush already drained the buffer
      // (an empty, unforced drain would read as the full-state signal).
      if (force || buffer.length > 0) drain();
      if (throttleMs > 0) {
        throttle = setTimeout(() => {
          throttle = null;
          if (force || buffer.length > 0) drain(); // trailing edge
        }, throttleMs);
      }
    });
  };

  const flushUrgentImpl = (): void => {
    // Nothing buffered and no pending full → nothing to accelerate. (An
    // empty drain is NOT free: transports treat "flush with no patches" as
    // the full-state signal.)
    if (buffer.length === 0 && !force) return;
    if (throttle) {
      clearTimeout(throttle);
      throttle = null;
    }
    drain();
  };
  urgentRegistry.add(flushUrgentImpl);

  return {
    add(items?: T[]) {
      if (items && items.length > 0) buffer.push(...items);
      else force = true;
      schedule();
    },
    forceFull() {
      force = true;
      schedule();
    },
    flushUrgent: flushUrgentImpl,
    dispose() {
      urgentRegistry.delete(flushUrgentImpl);
      if (throttle) {
        clearTimeout(throttle);
        throttle = null;
      }
    },
  };
}
