// src/sync/hlc.ts — Hybrid Logical Clock for CRDT sync
import type { HLC } from "./types.ts";
import { SYNC_DEFAULTS } from "./types.ts";

/**
 * Compare two HLCs. Returns <0, 0, or >0.
 * @experimental Excluded from the 1.0 stability guarantee.
 */
export function compareHLC(a: HLC, b: HLC): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0;
}

/**
 * Mutable hybrid logical clock instance bound to a node ID.
 * @experimental Excluded from the 1.0 stability guarantee.
 */
export interface HLClock {
  now(): HLC;
  tick(): HLC;
  receive(remote: HLC): void;
  isDriftExceeded(remote: HLC, maxDrift?: number): boolean;
  restore(hlc: HLC): void;
}

/**
 * Create a hybrid logical clock for the given node.
 * @experimental Excluded from the 1.0 stability guarantee.
 */
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
      const now = wallClock();
      // Reject untrusted values that would break causal ordering.
      // Wall clock must be within ±1 hour of current time and non-negative.
      if (hlc[0] < 0 || hlc[0] > now + SYNC_DEFAULTS.maxDrift) {
        physical = now;
        counter = 0;
        return;
      }
      // Counter must be non-negative to avoid wrap-around issues.
      if (hlc[1] < 0) {
        counter = 0;
      } else {
        counter = hlc[1];
      }
      physical = hlc[0];
    },
  };
}
