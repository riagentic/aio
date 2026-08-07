// offline-queue.ts — THE offline action queue: one implementation, ONE drop
// policy, for both instances.
//
// Two instances exist for a structural reason, not by accident: cell-method
// dispatch queues in the browser transport (browser/browser-air-transport.ts,
// cap 1000) while `useCell().send` / `useAio().send` queue in the isomorphic
// core (state/state-transport.ts, cap 100) — and the boundary matrix forbids
// `state` importing `browser`, so the core cannot delegate. They used to be
// two hand-written queues with OPPOSITE drop policies: the core refused the
// NEWEST action (keeping stale intent and dropping fresh) and settled no acks,
// the browser dropped the oldest and rejected its ack. One fact, two deciders.
//
// The one policy, everywhere: at cap the OLDEST queued action is dropped —
// newest data wins — its pending ack (if it has one) is rejected immediately
// through the ack sink so the caller hears "dropped" NOW instead of waiting
// out a 15s timeout for a frame that was discarded locally, and the instance's
// `onDrop` fires so each side keeps its own diagnostics.

import { _ackSink } from "./ack-sink.ts";

/** What both queues hold — a tagged action; `cid` when a pending ack exists. */
export type QueuedAction = { type: string; payload?: unknown; cid?: string };

export interface OfflineQueue {
  /** Queue `action`. The new action is ALWAYS accepted; at cap the OLDEST
   *  queued action is dropped first (its ack rejects, `onDrop` fires). */
  push(action: QueuedAction): void;
  /** Empty the queue, returning the actions in arrival order — used both to
   *  flush on reconnect and to discard on teardown (the caller decides what
   *  the drained actions mean). */
  drain(): QueuedAction[];
  readonly length: number;
  readonly cap: number;
  /** How full, 0..1 — both instances feed `isConnectionDegraded()`. */
  fullness(): number;
}

/** Build an offline queue with the shared drop policy. `onDrop` is the
 *  per-instance diagnostic hook — it runs AFTER the dropped action's ack has
 *  been rejected, and must not throw. */
export function offlineQueue(
  cap: number,
  onDrop?: (dropped: QueuedAction) => void,
): OfflineQueue {
  const items: QueuedAction[] = [];
  return {
    push(action: QueuedAction): void {
      if (items.length >= cap) {
        const dropped = items.shift()!;
        // The dropped action's caller may hold a pending ack with a deferred
        // clock — settle it honestly, right now. (No-op when the browser ack
        // registry isn't loaded; actions on that path carry no cid.)
        if (dropped.cid) {
          _ackSink.impl?.reject(
            dropped.cid,
            new Error("action dropped — offline queue full"),
          );
        }
        onDrop?.(dropped);
      }
      items.push(action);
    },
    drain(): QueuedAction[] {
      return items.splice(0);
    },
    get length(): number {
      return items.length;
    },
    cap,
    fullness(): number {
      return items.length / cap;
    },
  };
}
