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

export type VitalsPing = {
  type: "__vitals:ping";
  t1: number;
};

export type VitalsPong = {
  type: "__vitals:pong";
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

export type TransportProbeClientConfig = {
  thresholds: VitalThresholds;
  interval: number;
  onStatusChange?: (status: VitalStatus) => void;
};

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
      return { type: "__vitals:ping", t1: Date.now() };
    },

    processPong(pong: VitalsPong) {
      rtt = Date.now() - pong.t1;
      lastLoop = pong.loop;
      setStatus(evaluateStatus(rtt, t));
    },

    checkLiveness() {
      // Called periodically — if no pong was received, RTT stays stale.
      // The caller should use createPing + processPong cycle.
      return status;
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

export type TransportProbeServerConfig = {
  thresholds: VitalThresholds;
  onClientFrozen?: (clientId: string) => void;
  onClientRecovered?: (clientId: string) => void;
};

export function createTransportProbeServer(config: TransportProbeServerConfig) {
  const { thresholds, onClientFrozen, onClientRecovered } = config;
  const t = thresholds.transport;
  const clients = new Map<string, ClientLiveness>();

  function ensureClient(clientId: string, now: number): ClientLiveness {
    let c = clients.get(clientId);
    if (!c) {
      c = { clientId, lastPing: now, lastSent: 0, status: "healthy" };
      clients.set(clientId, c);
    }
    return c;
  }

  return {
    onClientPing(clientId: string, ts: number) {
      const c = ensureClient(clientId, ts);
      c.lastPing = ts;
    },

    onClientStateSent(clientId: string, ts: number) {
      const c = clients.get(clientId);
      if (c) c.lastSent = ts;
    },

    checkAllClients() {
      const now = Date.now();
      for (const c of clients.values()) {
        const gap = now - c.lastPing;
        const prev = c.status;
        const next = evaluateStatus(gap, t);
        c.status = next;

        if (next === "frozen" && prev !== "frozen") {
          c.frozenSince = now;
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
