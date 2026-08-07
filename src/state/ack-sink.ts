// ack-sink.ts — late-bound seam to the browser's pending-ack registry.
//
// state/ owns the cell binding (`bindCellReactive`) and the shared offline
// queue (`offline-queue.ts`), and both must settle a method call's promise
// through the browser's ack singleton (`src/browser/browser-ack.ts`) — but the
// boundary matrix forbids `state` importing `browser`. So the dependency is
// inverted (precedent: `_cfgSink` in browser-shared.ts): browser-ack.ts
// installs its implementation here at module-load time, and every transport
// that can carry a cell method imports browser-ack, so by the time a
// sendFn-bound method runs the sink is present. A missing sink at that point
// is a framework wiring bug and fails LOUD at the call site (cell-reactive.ts)
// instead of returning a promise nothing can ever settle.

/** The exact browser-ack surface state/ needs — see browser-ack.ts for the
 *  semantics of each member. */
export type AckSinkImpl = {
  /** `_registerAck` — register a pending ack, promise settles on ack/timeout. */
  register(
    cid: string,
    opts?: { methodKey?: string; deferTimer?: boolean },
  ): Promise<unknown>;
  /** `_armAckTimer` — the frame is on the wire, start the call's clock. */
  armTimer(cid: string): void;
  /** `_rejectAck` — settle one pending ack with an error (e.g. queue drop). */
  reject(cid: string, err: Error): boolean;
  /** `armsAckTimer` — does this transport arm ack clocks itself? */
  // deno-lint-ignore ban-types
  armsAckTimer(fn: Function | undefined): boolean;
};

/** Installed by browser-ack.ts on module load; null until then. */
export const _ackSink: { impl: AckSinkImpl | null } = { impl: null };
