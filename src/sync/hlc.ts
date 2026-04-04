// src/sync/hlc.ts — Hybrid Logical Clock for CRDT sync
import type { HLC } from "./types.ts";
import { SYNC_DEFAULTS } from "./types.ts";

/** Compare two HLCs. Returns <0, 0, or >0. */
export function compareHLC(a: HLC, b: HLC): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0;
}

/** Mutable hybrid logical clock instance bound to a node ID. */
export interface HLClock {
  now(): HLC;
  tick(): HLC;
  receive(remote: HLC): void;
  isDriftExceeded(remote: HLC, maxDrift?: number): boolean;
  restore(hlc: HLC): void;
}

/** Create a hybrid logical clock for the given node. */
export function createHLC(
  nodeId: string,
  wallClock: () => number = Date.now,
  maxDrift = SYNC_DEFAULTS.maxDrift,
): HLClock {
  let physical = wallClock();
  let counter = 0;

  return {
    now: () => [physical, counter, nodeId] as HLC,

    tick() {
      const now = wallClock();
      if (now > physical) {
        physical = now;
        counter = 0;
      } else {
        counter++;
      }
      return [physical, counter, nodeId] as HLC;
    },

    receive(remote: HLC) {
      const now = wallClock();
      const remotePhys = remote[0];
      const remoteCnt = remote[1];

      if (now > physical && now > remotePhys) {
        physical = now;
        counter = 0;
      } else if (remotePhys > physical) {
        physical = remotePhys;
        counter = remoteCnt + 1;
      } else if (physical === remotePhys) {
        counter = Math.max(counter, remoteCnt) + 1;
      } else {
        counter++;
      }
    },

    isDriftExceeded(remote: HLC, drift = maxDrift): boolean {
      return Math.abs(remote[0] - wallClock()) > drift;
    },

    restore(hlc: HLC) {
      physical = hlc[0];
      counter = hlc[1];
    },
  };
}
