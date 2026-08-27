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

/** A queued action plus its ARRIVAL ORDER. The sequence is drawn from one
 *  process-wide counter shared by every queue instance, which is the only way
 *  the two of them can be replayed in the order the user actually acted.
 *
 *  It is deliberately NOT a field on the action: the action is the wire
 *  payload, and bookkeeping has no business travelling to the server. */
export type QueuedEntry = { action: QueuedAction; seq: number };

/** ONE arrival clock for every offline queue in the process.
 *
 *  There are two queues (see the header) and they used to be replayed
 *  back-to-back on reconnect — the core's queue first, then the browser
 *  transport's, each internally in order but with nothing relating them. So
 *  `useCell().send(a)` typed BEFORE a cell method `b` was replayed AFTER it:
 *  reconnect silently reordered user intent, and for two writes to the same
 *  field the loser was whichever the user meant to win. */
let _seq = 0;

/** @internal The next arrival number. Exported so a caller that moves an entry
 *  between queues can preserve its ORIGINAL place in line. */
export function _nextSeq(): number {
  return ++_seq;
}

export interface OfflineQueue {
  /** Queue `action`. The new action is ALWAYS accepted; at cap the OLDEST
   *  queued action is dropped first (its ack rejects, `onDrop` fires).
   *  `seq` re-queues an action at the place in line it already had — a flush
   *  that failed part-way hands its remainder back this way. */
  push(action: QueuedAction, seq?: number): void;
  /** Empty the queue, returning the actions in arrival order — used both to
   *  flush on reconnect and to discard on teardown (the caller decides what
   *  the drained actions mean). */
  drain(): QueuedAction[];
  /** Empty the queue, returning arrival-stamped entries — for a caller that
   *  merges this queue with the other one before replaying. */
  drainEntries(): QueuedEntry[];
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
  const items: QueuedEntry[] = [];
  return {
    push(action: QueuedAction, seq?: number): void {
      const entry: QueuedEntry = { action, seq: seq ?? _nextSeq() };
      // Kept sorted by arrival, so "oldest" means oldest to BOTH the drop
      // policy and the replay — a re-queued entry lands back where it was.
      let i = items.length;
      while (i > 0 && items[i - 1]!.seq > entry.seq) i--;
      items.splice(i, 0, entry);
      while (items.length > cap) {
        const dropped = items.shift()!.action;
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
    },
    drain(): QueuedAction[] {
      return items.splice(0).map((e) => e.action);
    },
    drainEntries(): QueuedEntry[] {
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
