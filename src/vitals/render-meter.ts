// ─── Vital Signs — Render Meter ─────────────────────────────────────────────
// Client-side rAF-based measurement. Replaces RenderProbe (setTimeout drift).
// Single rAF loop: coalesced notification + 4 metrics + gauge output.

import type { Gauge, VitalStatus } from "./types.ts";

// ─── Config & API Types ─────────────────────────────────────────────────────

export type RenderMeterConfig = {
  manualTick?: boolean;
  thresholds?: { staleness?: number; pendingPatches?: number };
  onStatusChange?: (status: VitalStatus, gauges: RenderGauges) => void;
  onNotify?: () => void; // called when coalesced dirty flag flushes
};

export type RenderGauges = {
  staleness: Gauge;
  frameTime: Gauge;
  pendingPatches: Gauge;
  paintRate: Gauge;
};

export type RenderMeterAPI = {
  recordPatch(now?: number): void;
  recordAction(type: string, feature: string): void;
  markDirty(): void;
  getGauges(): RenderGauges;
  getMemoryGauge(): Gauge | null;
  getStaleness(): number;
  getStatus(): VitalStatus;
  getLastAction(): string | null;
  getLastFeature(): string | null;
  tick(now: number): void; // manual mode — takes absolute timestamp (not elapsed ms like RenderProbe)
  setPaused(paused: boolean): void;
  destroy(): void;
};

// ─── Hint Engine ────────────────────────────────────────────────────────────

const HINT_THRESHOLD = 50; // gauge percent above which a metric is "high"

export function renderHint(gauges: RenderGauges): string | null {
  if (gauges.staleness.percent < HINT_THRESHOLD) return null;

  const highFrame = gauges.frameTime.percent >= HINT_THRESHOLD;
  const highPending = gauges.pendingPatches.percent >= HINT_THRESHOLD;

  if (highFrame && !highPending) {
    return "Components too expensive — profile with React DevTools, consider React.memo() or simpler renders";
  }
  if (!highFrame && highPending) {
    return "Too many patches arriving — raise syncIntervalMs or batch server-side actions";
  }
  if (highFrame && highPending) {
    return "Both render cost and patch rate are high — simplify components AND reduce update frequency";
  }
  return "Main thread blocked by non-React work — check for heavy JS outside React (timers, workers, third-party scripts)";
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_STALENESS_THRESHOLD = 300;
const DEFAULT_PENDING_THRESHOLD = 10;
const FRAME_BUDGET = 16.67; // 60fps target
const TARGET_FPS = 60;
const LOG_SUPPRESS_SCHEDULE = [0, 2000, 4000, 8000, 16000]; // ms between warnings
const LOG_SUPPRESS_MAX = LOG_SUPPRESS_SCHEDULE.length;

// ─── Factory ────────────────────────────────────────────────────────────────

export function createRenderMeter(config: RenderMeterConfig): RenderMeterAPI {
  const stalenessCapacity = config.thresholds?.staleness ??
    DEFAULT_STALENESS_THRESHOLD;
  const pendingCapacity = config.thresholds?.pendingPatches ??
    DEFAULT_PENDING_THRESHOLD;
  const onStatusChange = config.onStatusChange;
  const onNotify = config.onNotify;

  // ── Metric state ────────────────────────────────────────────────────────
  let staleness = 0;
  let frameTime = 0;
  let pendingPatches = 0;
  let paintRate = 0;
  let status: VitalStatus = "healthy";
  let lastPatchAt = 0;
  let lastFrameAt = 0;
  let frameCountInWindow = 0;
  let windowStart = 0;
  let lastAction: string | null = null;
  let lastFeature: string | null = null;
  let dirty = false;
  let paused = false;
  let destroyed = false;
  let rafId: number | null = null;

  // ── Memory gauge (Chrome/Edge only) ─────────────────────────────────────
  let memoryGauge: Gauge | null = null;

  // ── Log suppression ─────────────────────────────────────────────────────
  let warnCount = 0;
  let lastWarnAt = 0;
  let suppressed = false;

  // ── Gauge builder ───────────────────────────────────────────────────────

  function gauge(name: string, current: number, capacity: number): Gauge {
    return {
      name,
      current,
      capacity,
      percent: capacity > 0 ? Math.min(100, (current / capacity) * 100) : 0,
    };
  }

  function getGauges(): RenderGauges {
    return {
      staleness: gauge("render.staleness", staleness, stalenessCapacity),
      frameTime: gauge("render.frameTime", frameTime, FRAME_BUDGET),
      pendingPatches: gauge(
        "render.pendingPatches",
        pendingPatches,
        pendingCapacity,
      ),
      paintRate: gauge(
        "render.paintRate",
        paintRate > 0 ? Math.max(0, TARGET_FPS - paintRate) : 0,
        TARGET_FPS,
      ),
    };
  }

  // ── Status classification (staleness-driven) ───────────────────────────

  function classify(): VitalStatus {
    if (staleness >= stalenessCapacity * 5) return "frozen";
    if (staleness >= stalenessCapacity * 2) return "warning";
    if (staleness >= stalenessCapacity) return "degraded";
    return "healthy";
  }

  // ── Log suppression check ──────────────────────────────────────────────

  function shouldWarn(now: number): boolean {
    if (suppressed) return false;
    if (warnCount >= LOG_SUPPRESS_MAX) {
      suppressed = true;
      return true; // emit the "suppressing" message
    }
    const delay = LOG_SUPPRESS_SCHEDULE[warnCount] ?? 0;
    if (now - lastWarnAt < delay) return false;
    return true;
  }

  function resetSuppression() {
    warnCount = 0;
    lastWarnAt = 0;
    suppressed = false;
  }

  // ── Core tick (called per rAF or manually) ─────────────────────────────

  function tick(now: number): void {
    if (destroyed || paused) return;

    // Step 1: flush coalesced notification
    if (dirty) {
      dirty = false;
      onNotify?.();
    }

    // Step 2: measure
    const isFirstTick = lastFrameAt === 0;
    if (!isFirstTick) {
      frameTime = now - lastFrameAt;
    }
    lastFrameAt = now;

    // Staleness: age of most recent unpainted patch.
    // On first tick, no prior frame exists — measure age directly.
    if (lastPatchAt > 0) {
      if (isFirstTick || lastPatchAt > (now - frameTime)) {
        staleness = now - lastPatchAt;
      } else {
        staleness = 0;
      }
    } else {
      staleness = 0;
    }

    // Paint rate: frames per second
    frameCountInWindow++;
    if (windowStart === 0) windowStart = now;
    const windowElapsed = now - windowStart;
    if (windowElapsed >= 1000) {
      paintRate = Math.round((frameCountInWindow / windowElapsed) * 1000);
      frameCountInWindow = 0;
      windowStart = now;
      const perf = globalThis.performance as unknown as {
        memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
      };
      if (perf.memory) {
        memoryGauge = gauge(
          "memory",
          perf.memory.usedJSHeapSize,
          perf.memory.jsHeapSizeLimit,
        );
      }
    }

    // Step 3: classify and notify on status change
    const newStatus = classify();

    if (status === "frozen" && newStatus !== "frozen") {
      // Recovery
      status = "recovered";
      resetSuppression();
      onStatusChange?.("recovered", getGauges());
      // Immediately transition to the actual status
      if (newStatus === "healthy") {
        status = "healthy";
        onStatusChange?.("healthy", getGauges());
      } else {
        status = newStatus;
        onStatusChange?.(newStatus, getGauges());
      }
    } else if (status === "recovered" && newStatus === "healthy") {
      status = "healthy";
      onStatusChange?.("healthy", getGauges());
    } else if (newStatus !== status) {
      const prev = status;
      status = newStatus;
      onStatusChange?.(newStatus, getGauges());

      // Log suppression for sustained warnings
      if (newStatus !== "healthy" && prev === "healthy") {
        resetSuppression(); // new incident
      }
      if (
        newStatus === "degraded" || newStatus === "warning" ||
        newStatus === "frozen"
      ) {
        if (shouldWarn(now)) {
          warnCount++;
          lastWarnAt = now;
        }
      }
    }

    // Step 4: reset pending (these have been "painted")
    pendingPatches = 0;
  }

  // ── Auto rAF loop ─────────────────────────────────────────────────────

  function scheduleLoop() {
    if (destroyed) return;
    rafId = requestAnimationFrame(() => {
      if (destroyed) return;
      try {
        tick(performance.now());
      } catch (e) {
        console.error("[aio:render-meter] tick error:", e); // AIO-151
      }
      scheduleLoop();
    });
  }

  if (!config.manualTick) {
    scheduleLoop();
  }

  // ── API ────────────────────────────────────────────────────────────────

  return {
    recordPatch(now?: number) {
      lastPatchAt = now ?? performance.now();
      pendingPatches++;
    },

    recordAction(type: string, feature: string) {
      lastAction = type;
      lastFeature = feature;
    },

    markDirty() {
      dirty = true;
    },

    getGauges,
    getMemoryGauge: () => memoryGauge,
    getStaleness: () => staleness,
    getStatus: () => status,
    getLastAction: () => lastAction,
    getLastFeature: () => lastFeature,

    tick,

    setPaused(p: boolean) {
      paused = p;
      if (!p) {
        // Reset baselines to avoid false spike on resume
        lastFrameAt = config.manualTick ? lastFrameAt : performance.now();
        lastPatchAt = 0;
        staleness = 0;
      }
    },

    destroy() {
      destroyed = true;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      status = "healthy";
      staleness = 0;
      frameTime = 0;
      pendingPatches = 0;
      paintRate = 0;
      lastPatchAt = 0;
      lastFrameAt = 0;
      dirty = false;
      resetSuppression();
    },
  };
}
