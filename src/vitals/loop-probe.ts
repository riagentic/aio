// ─── Vital Signs — Loop Probe ─────────────────────────────────────────────────
// Server-side dispatch metrics probe: tracks reduce timings, queue depth,
// effect backlog, circuit breakers, and computes health status.

import type { LoopVitals, VitalStatus, VitalThresholds } from "./types.ts";
import type { PerfTiming } from "../dispatch.ts";

/** Public API returned by createLoopProbe */
export type LoopProbeAPI = {
  onPerf: (timing: PerfTiming) => void;
  updateQueueDepth: (depth: number) => void;
  updateEffectBacklog: (count: number) => void;
  updateCircuitBreakers: (names: string[]) => void;
  getVitals: () => LoopVitals;
  getStatus: () => VitalStatus;
  getFirstDegradedAt: () => number | null;
  reset: () => void;
};

const P95_WINDOW = 100;
const DRAIN_WINDOW_MS = 5_000;

/** Extract feature name from "feature/ACTION" or "feature:ACTION" patterns */
function extractFeature(actionType: string): string {
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
export function createLoopProbe(thresholds: VitalThresholds): LoopProbeAPI {
  // Sliding window of reduce durations for p95
  let reduceTimes: number[] = [];
  // Drain rate tracking: timestamps of recent actions
  let actionTimestamps: number[] = [];

  // Current vitals state
  let queueDepth = 0;
  let effectBacklog = 0;
  let lastReduceTime = 0;
  let lastReduceAction = "";
  let lastReduceFeature = "";
  let p95ReduceTime = 0;
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

  function evaluateStatus(): VitalStatus {
    const qt = thresholds.queue;
    const lt = thresholds.loop;

    // Check queue thresholds (higher priority)
    if (queueDepth >= qt.frozen) return "frozen";
    if (queueDepth >= qt.warning) return "warning";
    if (queueDepth >= qt.degraded) return "degraded";

    // Check loop (reduce time) thresholds
    if (lastReduceTime >= lt.frozen) return "frozen";
    if (lastReduceTime >= lt.warning) return "warning";
    if (lastReduceTime >= lt.degraded) return "degraded";

    return "healthy";
  }

  function onPerf(timing: PerfTiming): void {
    lastReduceTime = timing.reduce;
    lastReduceAction = timing.actionType;
    lastReduceFeature = extractFeature(timing.actionType);

    // Update p95 sliding window
    reduceTimes.push(timing.reduce);
    if (reduceTimes.length > P95_WINDOW) {
      reduceTimes = reduceTimes.slice(-P95_WINDOW);
    }
    const sorted = [...reduceTimes].sort((a, b) => a - b);
    p95ReduceTime = computeP95(sorted);

    // Track action timestamp for drain rate
    actionTimestamps.push(Date.now());
    pruneTimestamps(Date.now());

    // Track first degraded
    const status = evaluateStatus();
    if (status !== "healthy" && firstDegradedAt === null) {
      firstDegradedAt = Date.now();
    }
  }

  function updateQueueDepth(depth: number): void {
    queueDepth = depth;
    const status = evaluateStatus();
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

  function getVitals(): LoopVitals {
    return {
      queueDepth,
      drainRate: computeDrainRate(),
      lastReduceTime,
      lastReduceAction,
      lastReduceFeature,
      p95ReduceTime,
      effectBacklog,
      circuitBreakers: [...circuitBreakers],
    };
  }

  function getStatus(): VitalStatus {
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
    lastReduceAction = "";
    lastReduceFeature = "";
    p95ReduceTime = 0;
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
    getFirstDegradedAt,
    reset,
  };
}
