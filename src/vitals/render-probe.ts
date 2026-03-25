// ─── Vital Signs — Render Probe ─────────────────────────────────────────────
// Client-side setTimeout drift + freeze detection.
// Measures elapsed time between ticks and classifies render health.

import type {
  RenderFreezeReport,
  VitalStatus,
  VitalThresholds,
} from "./types.ts";

// ─── Config & API Types ─────────────────────────────────────────────────────

export type RenderProbeConfig = {
  thresholds: VitalThresholds;
  interval: number;
  manualTick?: boolean;
  onStatusChange?: (
    status: VitalStatus,
    report: RenderFreezeReport | null,
  ) => void;
};

export type RenderProbeAPI = {
  getStatus: () => VitalStatus;
  getFirstDegradedAt: () => number | null;
  getLastAction: () => string | null;
  getLastFeature: () => string | null;
  getUnprocessedDeltas: () => number;
  getPreviousFreezeCount: () => number;
  getMeasured: () => number;
  recordAction: (action: string, feature: string) => void;
  recordDelta: () => void;
  clearDeltas: () => void;
  tick: (elapsedMs: number) => RenderFreezeReport | null;
  destroy: () => void;
};

// ─── Constants ──────────────────────────────────────────────────────────────

const FREEZE_COUNT_RESET_MS = 30_000;

// ─── Factory ────────────────────────────────────────────────────────────────

export function createRenderProbe(config: RenderProbeConfig): RenderProbeAPI {
  const { thresholds, interval, manualTick, onStatusChange } = config;
  const rt = thresholds.render;

  // ── State ───────────────────────────────────────────────────────────────
  let status: VitalStatus = "healthy";
  let measured = 0;
  let firstDegradedAt: number | null = null;
  let lastAction: string | null = null;
  let lastFeature: string | null = null;
  let unprocessedDeltas = 0;
  let previousFreezeCount = 0;
  let lastFreezeCountResetAt = 0;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let lastTickAt = 0;

  // ── Status evaluation ─────────────────────────────────────────────────

  function classify(elapsedMs: number): VitalStatus {
    if (elapsedMs >= rt.frozen) return "frozen";
    if (elapsedMs >= rt.warning) return "warning";
    if (elapsedMs >= rt.degraded) return "degraded";
    return "healthy";
  }

  function tick(elapsedMs: number): RenderFreezeReport | null {
    measured = elapsedMs;
    const now = Date.now();
    const newStatus = classify(elapsedMs);
    let report: RenderFreezeReport | null = null;

    // Reset freeze count after 30s of non-frozen ticks
    if (
      previousFreezeCount > 0 &&
      lastFreezeCountResetAt > 0 &&
      now - lastFreezeCountResetAt >= FREEZE_COUNT_RESET_MS &&
      newStatus !== "frozen" &&
      status !== "frozen"
    ) {
      previousFreezeCount = 0;
    }

    // Transition logic
    if (newStatus === "frozen") {
      report = {
        frozenFor: elapsedMs,
        lastActionBefore: lastAction,
        lastFeature: lastFeature,
        unprocessedDeltas,
      };
    }

    if (status === "frozen" && newStatus !== "frozen") {
      // Recovery from freeze
      previousFreezeCount++;
      lastFreezeCountResetAt = now;
      status = "recovered";
      onStatusChange?.("recovered", null);
      return report;
    }

    if (status === "recovered" && newStatus === "healthy") {
      status = "healthy";
      onStatusChange?.("healthy", null);
      return report;
    }

    if (newStatus !== status) {
      status = newStatus;
      if (newStatus === "degraded" && firstDegradedAt === null) {
        firstDegradedAt = now;
      }
      onStatusChange?.(newStatus, report);
    }

    return report;
  }

  // ── Auto-tick loop (setTimeout drift measurement) ─────────────────────

  function scheduleLoop() {
    lastTickAt = Date.now();
    timerId = setTimeout(() => {
      const now = Date.now();
      const drift = now - lastTickAt;
      tick(drift - interval);
      scheduleLoop();
    }, interval);
  }

  if (!manualTick) {
    scheduleLoop();
  }

  // ── API ─────────────────────────────────────────────────────────────────

  return {
    getStatus: () => status,
    getFirstDegradedAt: () => firstDegradedAt,
    getLastAction: () => lastAction,
    getLastFeature: () => lastFeature,
    getUnprocessedDeltas: () => unprocessedDeltas,
    getPreviousFreezeCount: () => previousFreezeCount,
    getMeasured: () => measured,

    recordAction(action: string, feature: string) {
      lastAction = action;
      lastFeature = feature;
    },

    recordDelta() {
      unprocessedDeltas++;
    },

    clearDeltas() {
      unprocessedDeltas = 0;
    },

    tick,

    destroy() {
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
      status = "healthy";
      measured = 0;
      firstDegradedAt = null;
      lastAction = null;
      lastFeature = null;
      unprocessedDeltas = 0;
      previousFreezeCount = 0;
      lastFreezeCountResetAt = 0;
      lastTickAt = 0;
    },
  };
}
