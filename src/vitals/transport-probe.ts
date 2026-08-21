// ─── Vital Signs — Transport Probe ──────────────────────────────────────────
// Client-side: ping/pong RTT measurement.
// Server-side: client liveness watchdog.

import type {
  ClientLiveness,
  LoopVitals,
  VitalStatus,
  VitalThresholds,
} from "./types.ts";

// ─── Wire Protocol ───────────────────────────────────────────────────────────

/** "vitals-ping" payload — departure timestamp (v2: the envelope kind is
 *  the discriminator; no type field on the wire). */
export type VitalsPing = {
  t1: number;
};

/** "vitals-pong" payload — timestamps and optional loop health. */
export type VitalsPong = {
  t1: number;
  t2: number;
  loop: LoopVitals | null;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function evaluateStatus(
  measured: number,
  thresholds: { degraded: number; warning: number; frozen: number },
): VitalStatus {
  if (measured >= thresholds.frozen) return "frozen";
  if (measured >= thresholds.warning) return "warning";
  if (measured >= thresholds.degraded) return "degraded";
  return "healthy";
}

// ─── Client Probe ────────────────────────────────────────────────────────────

/** Configuration for the client-side transport probe — thresholds, ping interval, and status callback. */
export type TransportProbeClientConfig = {
  thresholds: VitalThresholds;
  interval: number;
  onStatusChange?: (status: VitalStatus) => void;
};

/** Create a client-side transport probe that measures RTT via ping/pong and classifies connection health. */
export function createTransportProbeClient(config: TransportProbeClientConfig) {
  const { thresholds, onStatusChange } = config;
  const t = thresholds.transport;

  let status: VitalStatus = "healthy";
  let rtt = 0;
  let firstDegradedAt: number | null = null;
  let lastLoop: LoopVitals | null = null;

  function setStatus(next: VitalStatus) {
    if (next !== status) {
      if (next !== "healthy" && firstDegradedAt === null) {
        firstDegradedAt = Date.now();
      }
      status = next;
      onStatusChange?.(next);
    }
  }

  return {
    createPing(): VitalsPing {
      return { t1: Date.now() };
    },

    processPong(pong: VitalsPong) {
      rtt = Date.now() - pong.t1;
      lastLoop = pong.loop;
      setStatus(evaluateStatus(rtt, t));
    },

    getStatus(): VitalStatus {
      return status;
    },

    getRTT(): number {
      return rtt;
    },

    getFirstDegradedAt(): number | null {
      return firstDegradedAt;
    },

    getLastLoop(): LoopVitals | null {
      return lastLoop;
    },

    destroy() {
      status = "healthy";
      rtt = 0;
      firstDegradedAt = null;
      lastLoop = null;
    },
  };
}

// ─── Server Probe ────────────────────────────────────────────────────────────

/** Configuration for the server-side transport probe — thresholds and freeze/recovery callbacks. */
export type TransportProbeServerConfig = {
  thresholds: VitalThresholds;
  onClientFrozen?: (clientId: string) => void;
  onClientRecovered?: (clientId: string) => void;
  /** Clock for every timestamp this probe records AND compares. Injectable so
   *  tests can advance time without sleeping — never so a caller can supply a
   *  timestamp from somewhere else (see the invariant below). */
  now?: () => number;
};

/** Create a server-side transport probe that tracks per-client liveness and detects freezes.
 *
 *  ONE-CLOCK INVARIANT — load-bearing, do not weaken.
 *
 *  Every timestamp this probe stores and every timestamp it subtracts comes
 *  from `now()`, i.e. the SERVER's clock. No method takes a timestamp, because
 *  the only timestamps available at the call sites are the CLIENT's: a ping
 *  frame carries `t1` produced by `Date.now()` in a browser.
 *
 *  That is exactly the bug this shape prevents. `lastPing` used to be stamped
 *  with the client's `ping.t1` while `checkAllClients()` subtracted it from the
 *  server's `Date.now()`. The difference is not a latency — it is a latency
 *  PLUS the two machines' clock offset, which is constant and never recovers:
 *  a client 2s behind was classified `frozen` forever, and
 *  `server-broadcast.ts` skips frozen clients in every broadcast, so it never
 *  received another state update while its socket stayed open and its pings
 *  kept being answered. A client AHEAD made the gap negative and silently
 *  disabled the watchdog instead.
 *
 *  RTT is measured on the CLIENT (`processPong`: `Date.now() - pong.t1`, both
 *  from the browser's clock) for the same reason. `pong.t2` is the server's
 *  stamp and is carried for display only — it is never subtracted from a
 *  client-side timestamp. */
export function createTransportProbeServer(config: TransportProbeServerConfig) {
  const { thresholds, onClientFrozen, onClientRecovered } = config;
  const now = config.now ?? (() => Date.now());
  const t = thresholds.transport;
  const clients = new Map<string, ClientLiveness>();

  function ensureClient(clientId: string, at: number): ClientLiveness {
    let c = clients.get(clientId);
    if (!c) {
      c = { clientId, lastPing: at, lastSent: 0, status: "healthy" };
      clients.set(clientId, c);
    }
    return c;
  }

  return {
    /** A ping ARRIVED. Stamped with the server's clock — the frame's own `t1`
     *  belongs to the client and must never be stored here. */
    onClientPing(clientId: string) {
      const at = now();
      const c = ensureClient(clientId, at);
      c.lastPing = at;
    },

    /** State was SENT to a client. Server clock, same invariant. */
    onClientStateSent(clientId: string) {
      const c = clients.get(clientId);
      if (c) c.lastSent = now();
    },

    checkAllClients() {
      const at = now();
      for (const c of clients.values()) {
        // Both operands are server-clock stamps, so this is an elapsed time and
        // can never be negative — see the one-clock invariant above.
        const gap = at - c.lastPing;
        const prev = c.status;
        const next = evaluateStatus(gap, t);
        c.status = next;

        if (next === "frozen" && prev !== "frozen") {
          c.frozenSince = at;
          onClientFrozen?.(c.clientId);
        } else if (prev === "frozen" && next !== "frozen") {
          delete c.frozenSince;
          c.status = "recovered";
          onClientRecovered?.(c.clientId);
        }
      }
    },

    getClientLiveness(clientId: string): ClientLiveness | undefined {
      return clients.get(clientId);
    },

    getAllClients(): ClientLiveness[] {
      return [...clients.values()];
    },

    isFrozen(clientId: string): boolean {
      const c = clients.get(clientId);
      return c?.status === "frozen";
    },

    removeClient(clientId: string) {
      clients.delete(clientId);
    },

    destroy() {
      clients.clear();
    },
  };
}
