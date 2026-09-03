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
  /** The sender's render staleness (ms behind, from its render meter) — the
   *  server's per-client backpressure input. Absent from a probe that has no
   *  meter. */
  ms?: number;
};

/** "vitals-pong" payload — timestamps and optional loop health. */
export type VitalsPong = {
  t1: number;
  t2: number;
  loop: LoopVitals | null;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Grade an RTT against the transport tiers. ROUND-TRIP TIME ONLY — one client,
 *  one clock, one measurement of how long the wire took. `processPong` is the
 *  only caller, and `thresholds.transport.degraded/warning` exist for it.
 *
 *  Do NOT reach for this from the server watchdog: see `evaluateLiveness`. */
function evaluateStatus(
  measured: number,
  thresholds: { degraded: number; warning: number; frozen: number },
): VitalStatus {
  if (measured >= thresholds.frozen) return "frozen";
  if (measured >= thresholds.warning) return "warning";
  if (measured >= thresholds.degraded) return "degraded";
  return "healthy";
}

/** Grade a HEARTBEAT AGE. Two verdicts, because a heartbeat's age carries
 *  exactly one bit of information: are we still hearing this client?
 *
 *  The server watchdog used to run the ping gap through `evaluateStatus`, i.e.
 *  through RTT tiers (degraded 100ms / warning 500ms / frozen 2000ms). But the
 *  quantity is not a round trip — it is the age of the last beat of a 1s
 *  heartbeat (`DEFAULT_HEARTBEAT_INTERVAL`), sampled by an independent ~1s
 *  grading tick, so for a perfectly healthy client it is uniform over roughly
 *  0–1000ms and lands over the 100ms `degraded` line about 90% of the time.
 *
 *  Measured, real chromium tab on a plain app, 580 samples over 60s:
 *    status  → degraded 83.3% · warning 16.0% · healthy 0.7%
 *    gap(ms) → min 1 · p25 245 · p50 495 · p75 743 · p95 948 · max 999
 *  A live tab was observed reporting `{"status":"degraded","gap":71}`.
 *
 *  Those tiers therefore graded the heartbeat's PHASE, not the client's health:
 *  `am metrics`, `/__aio/vitals` and amui showed a fleet of permanently
 *  degraded clients, which is a field an operator learns to ignore — and the
 *  tiers drove nothing (backpressure reads the client-reported render
 *  staleness; the only alerts fired are frozen/recovered).
 *
 *  Deriving heartbeat-shaped tiers instead ("missed one beat") was the other
 *  option and is worse: it needs the client's beat interval, which the server
 *  cannot know (config drift, a stale build, a throttled background tab), and
 *  a client that missed one 1s beat is normal jitter that nothing acts on.
 *
 *  `frozen` keeps its exact meaning and threshold — `server-broadcast.ts` skips
 *  frozen clients, and a peer that never beats at all must still reach it. */
function evaluateLiveness(
  gap: number,
  frozenAfter: number,
): VitalStatus {
  return gap >= frozenAfter ? "frozen" : "healthy";
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
  /** A client crossed into `frozen`. `unreachableFor` is the ping gap that
   *  triggered it — the measurement the threshold was compared against, handed
   *  to the caller because it is the only place that still has it. Recomputing
   *  it from `frozenSince` (stamped on this very transition) can only ever
   *  yield ~0, which is what every disconnect diagnostic used to report. */
  onClientFrozen?: (clientId: string, unreachableFor: number) => void;
  onClientRecovered?: (clientId: string) => void;
  /** Clock for every timestamp this probe records AND compares. Injectable so
   *  tests can advance time without sleeping — never so a caller can supply a
   *  timestamp from somewhere else (see the invariant below). */
  now?: () => number;
};

/** Create a server-side transport probe that tracks per-client liveness and detects freezes.
 *
 *  VOCABULARY. This probe answers ONE question — "are we still hearing this
 *  client?" — so a liveness row is only ever `healthy`, `frozen`, or (for one
 *  tick after a freeze ends) `recovered`. It reads `thresholds.transport.frozen`
 *  and nothing else; `.degraded`/`.warning` are RTT tiers and belong to
 *  `processPong` on the client, which measures an actual round trip. The two
 *  signals are not interchangeable — `evaluateLiveness` has the measurement.
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
  /** Clients that have sent at least one `vitals-ping`, and can therefore be
   *  judged by the age of the last one. */
  const heartbeats = new Set<string>();

  function ensureClient(clientId: string, at: number): ClientLiveness {
    let c = clients.get(clientId);
    if (!c) {
      c = { clientId, lastPing: at, lastSent: 0, status: "healthy" };
      clients.set(clientId, c);
    }
    return c;
  }

  return {
    /** A client CONNECTED. Registered here, at the upgrade, not on its first
     *  `vitals-ping`.
     *
     *  Registering on the first ping made the watchdog opt-in by the very
     *  behaviour it watches for: a peer that opens a socket and then never
     *  sends anything — no ping, no action — was never in `clients`, so
     *  `checkAllClients()` never evaluated it, `isFrozen()` answered false
     *  forever, and `server-broadcast.ts` (which skips frozen clients) fed it
     *  every round for the life of the socket. (audit a2/W2)
     *
     *  It is registered but NOT yet graded: see `heartbeats`. Grading a peer
     *  that has never sent a heartbeat made the watchdog fire on clients that
     *  simply do not speak the heartbeat protocol — `connectCli`, the dev
     *  reload socket, any third-party client written against the documented
     *  wire — each of which went dark two seconds after connecting and stayed
     *  dark, because the gap only grows. The memory case that motivated
     *  grading-from-connect is answered directly by the `bufferedAmount`
     *  high-water check that now sits beside the frozen check in
     *  `server-broadcast.ts`: that asks "is this peer draining", which is the
     *  actual question about a silent socket. */
    onClientConnected(clientId: string) {
      ensureClient(clientId, now());
    },

    /** A ping ARRIVED. Stamped with the server's clock — the frame's own `t1`
     *  belongs to the client and must never be stored here. */
    onClientPing(clientId: string) {
      const at = now();
      const c = ensureClient(clientId, at);
      c.lastPing = at;
      heartbeats.add(clientId);
    },

    /** A frame of ANY kind arrived. A client that speaks is alive, so this
     *  refreshes liveness exactly as a heartbeat does — but it does not enrol
     *  the client in grading, because one frame at connect time says nothing
     *  about whether more will follow. */
    onClientActivity(clientId: string) {
      const c = clients.get(clientId);
      if (c) c.lastPing = now();
    },

    /** State was SENT to a client. Server clock, same invariant. */
    onClientStateSent(clientId: string) {
      const c = clients.get(clientId);
      if (c) c.lastSent = now();
    },

    checkAllClients() {
      const at = now();
      for (const c of clients.values()) {
        // Only a client that has ever sent a heartbeat can be judged by the
        // age of its last one. For every other client the gap measures how
        // long ago it CONNECTED, which is not a liveness signal at all — and
        // grading it froze every non-heartbeat client after two seconds and
        // silently stopped its state updates for the life of the socket.
        if (!heartbeats.has(c.clientId)) continue;
        // Both operands are server-clock stamps, so this is an elapsed time and
        // can never be negative — see the one-clock invariant above.
        const gap = at - c.lastPing;
        const prev = c.status;
        // A heartbeat age, graded as liveness — NOT through the RTT tiers.
        // See `evaluateLiveness` for the measurement that says why.
        const next = evaluateLiveness(gap, t.frozen);
        c.status = next;

        if (next === "frozen" && prev !== "frozen") {
          c.frozenSince = at;
          onClientFrozen?.(c.clientId, gap);
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
      heartbeats.delete(clientId);
    },

    destroy() {
      clients.clear();
      heartbeats.clear();
    },
  };
}
