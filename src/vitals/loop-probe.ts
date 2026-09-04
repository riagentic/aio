// ─── Vital Signs — Loop Probe ─────────────────────────────────────────────────
// Server-side dispatch metrics probe: tracks reduce timings, queue depth,
// effect backlog, circuit breakers, and computes health status.

import type { LoopVitals, VitalStatus, VitalThresholds } from "./types.ts";
import type { PerfTiming } from "../state/dispatch.ts";

/** Public API returned by createLoopProbe */
export type LoopProbeAPI = {
  onPerf: (timing: PerfTiming) => void;
  updateQueueDepth: (depth: number) => void;
  updateEffectBacklog: (count: number) => void;
  updateCircuitBreakers: (names: string[]) => void;
  getVitals: () => LoopVitals;
  getStatus: () => VitalStatus;
  /** Status plus WHICH layer produced it — the queue (an action count) and
   *  the loop (milliseconds) have different units, and an alert built from
   *  the wrong pair reports incoherent numbers. */
  getStatusDetail: () => {
    status: VitalStatus;
    driver: "queue" | "loop" | null;
  };
  getFirstDegradedAt: () => number | null;
  reset: () => void;
};

const P95_WINDOW = 100;
const DRAIN_WINDOW_MS = 5_000;

/** Extract cell name from "cell/ACTION" or "cell:ACTION" patterns */
function extractCell(actionType: string): string {
  const slashIdx = actionType.indexOf("/");
  if (slashIdx > 0) return actionType.slice(0, slashIdx);
  const colonIdx = actionType.indexOf(":");
  if (colonIdx > 0) return actionType.slice(0, colonIdx);
  return actionType;
}

/** Compute p95 from a sorted (ascending) array of numbers */
function computeP95(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)]!;
}

/** Create a loop probe that tracks dispatch health metrics */
/** How long a reduce measurement keeps grading the loop.
 *
 *  `lastReduceTime` is a single sample, not a window, so without an expiry one
 *  slow dispatch graded the loop for the life of the process. Several
 *  heartbeats: long enough that a real problem is still degraded while it is
 *  happening, short enough that an idle app returns to healthy. */
export const REDUCE_MEASUREMENT_TTL_MS = 10_000;

export function createLoopProbe(thresholds: VitalThresholds): LoopProbeAPI {
  // Sliding window of reduce durations for p95
  let reduceTimes: number[] = [];
  // Drain rate tracking: timestamps of recent actions
  let actionTimestamps: number[] = [];

  // Current vitals state
  let queueDepth = 0;
  let effectBacklog = 0;
  let lastReduceTime = 0;
  /** When that measurement was taken. Without it, `lastReduceTime` is the last
   *  reduce EVER — never decayed, never windowed — so ONE slow dispatch made
   *  the loop "degraded" for the life of the process: an idle app fired the
   *  same alert every 5 s indefinitely (measured: identical message, ts +5004,
   *  +5002, …, four minutes after the app had gone quiet), `onVitalAlert` and
   *  `reporter.onAlert` ran once per SECOND behind the bus's dedup, each
   *  preceded by a full snapshot + hint evaluation, and hint rule 3 — which
   *  requires a healthy loop — could never fire again, so a later genuine
   *  freeze reported `hint: null` forever. */
  let lastReduceAt = 0;
  let lastReduceAction = "";
  let lastReduceCell = "";
  let p95ReduceTime = 0;
  let p95Dirty = false; // window changed since p95ReduceTime was computed
  let circuitBreakers: string[] = [];
  let firstDegradedAt: number | null = null;

  function pruneTimestamps(now: number): void {
    const cutoff = now - DRAIN_WINDOW_MS;
    while (actionTimestamps.length > 0 && actionTimestamps[0]! < cutoff) {
      actionTimestamps.shift();
    }
  }

  function computeDrainRate(): number {
    const now = Date.now();
    pruneTimestamps(now);
    if (actionTimestamps.length < 2) return actionTimestamps.length;
    const span = (now - actionTimestamps[0]!) / 1000;
    if (span <= 0) return actionTimestamps.length;
    return actionTimestamps.length / span;
  }

  const STATUS_RANK: Record<VitalStatus, number> = {
    healthy: 0,
    recovered: 0, // transitional, never produced by thresholds
    degraded: 1,
    warning: 2,
    frozen: 3,
  };

  function evaluateStatus(): {
    status: VitalStatus;
    driver: "queue" | "loop" | null;
  } {
    const qt = thresholds.queue;
    const lt = thresholds.loop;

    // Both layers are evaluated and the WORSE one wins. Early-returning on
    // the queue tier alone downgraded a frozen loop to "degraded" exactly in
    // the common cascade — a 2.5s reduce that also backed the queue up.
    const queue: VitalStatus = queueDepth >= qt.frozen
      ? "frozen"
      : queueDepth >= qt.warning
      ? "warning"
      : queueDepth >= qt.degraded
      ? "degraded"
      : "healthy";
    // A measurement older than the grading window says nothing about NOW.
    // Kept generous — several heartbeats — so a real problem still grades
    // while it is happening, and a finished one stops grading.
    const fresh = lastReduceAt !== 0 &&
      Date.now() - lastReduceAt <= REDUCE_MEASUREMENT_TTL_MS;
    const reduceNow = fresh ? lastReduceTime : 0;
    const loop: VitalStatus = reduceNow >= lt.frozen
      ? "frozen"
      : reduceNow >= lt.warning
      ? "warning"
      : reduceNow >= lt.degraded
      ? "degraded"
      : "healthy";

    if (queue === "healthy" && loop === "healthy") {
      return { status: "healthy", driver: null };
    }
    // On a tie the queue drives (its number is the more actionable of the two).
    return STATUS_RANK[queue] >= STATUS_RANK[loop]
      ? { status: queue, driver: "queue" }
      : { status: loop, driver: "loop" };
  }

  function onPerf(timing: PerfTiming): void {
    lastReduceTime = timing.reduce;
    lastReduceAt = Date.now();
    lastReduceAction = timing.actionType;
    lastReduceCell = extractCell(timing.actionType);

    // Update the p95 sliding window. The percentile itself is computed when
    // it's READ (once a second, by whoever polls vitals) — not here. This runs
    // on EVERY dispatch, and a copy+sort of the window per action made the
    // measurement a tax on the thing it measures.
    reduceTimes.push(timing.reduce);
    if (reduceTimes.length > P95_WINDOW) {
      reduceTimes = reduceTimes.slice(-P95_WINDOW);
    }
    p95Dirty = true;

    // Track action timestamp for drain rate
    actionTimestamps.push(Date.now());
    pruneTimestamps(Date.now());

    // Track first degraded
    const { status } = evaluateStatus();
    if (status !== "healthy" && firstDegradedAt === null) {
      firstDegradedAt = Date.now();
    }
  }

  function updateQueueDepth(depth: number): void {
    queueDepth = depth;
    const { status } = evaluateStatus();
    if (status !== "healthy" && firstDegradedAt === null) {
      firstDegradedAt = Date.now();
    }
  }

  function updateEffectBacklog(count: number): void {
    effectBacklog = count;
  }

  function updateCircuitBreakers(names: string[]): void {
    circuitBreakers = names;
  }

  /** The percentile, computed on demand and memoized until the window moves. */
  function p95(): number {
    if (p95Dirty) {
      p95ReduceTime = computeP95([...reduceTimes].sort((a, b) => a - b));
      p95Dirty = false;
    }
    return p95ReduceTime;
  }

  function getVitals(): LoopVitals {
    return {
      queueDepth,
      drainRate: computeDrainRate(),
      lastReduceTime,
      lastReduceAction,
      lastReduceCell,
      p95ReduceTime: p95(),
      effectBacklog,
      circuitBreakers: [...circuitBreakers],
    };
  }

  function getStatus(): VitalStatus {
    return evaluateStatus().status;
  }

  function getStatusDetail(): {
    status: VitalStatus;
    driver: "queue" | "loop" | null;
  } {
    return evaluateStatus();
  }

  function getFirstDegradedAt(): number | null {
    return firstDegradedAt;
  }

  function reset(): void {
    reduceTimes = [];
    actionTimestamps = [];
    queueDepth = 0;
    effectBacklog = 0;
    lastReduceTime = 0;
    lastReduceAt = 0;
    lastReduceAction = "";
    lastReduceCell = "";
    p95ReduceTime = 0;
    p95Dirty = false;
    circuitBreakers = [];
    firstDegradedAt = null;
  }

  return {
    onPerf,
    updateQueueDepth,
    updateEffectBacklog,
    updateCircuitBreakers,
    getVitals,
    getStatus,
    getStatusDetail,
    getFirstDegradedAt,
    reset,
  };
}
