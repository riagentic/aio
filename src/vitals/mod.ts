// ─── Vital Signs — Public API ────────────────────────────────────────────────
// Wires all probes together into a single VitalsSystem.

import type {
  VitalAlert,
  VitalLayer,
  VitalsConfig,
  VitalsSnapshot,
  VitalThresholds,
} from "./types.ts";
import { DEFAULT_THRESHOLDS } from "./types.ts";
import { createLoopProbe, type LoopProbeAPI } from "./loop-probe.ts";
import { createTransportProbeServer } from "./transport-probe.ts";
import { createServerDiagReporter } from "./diag-reporter.ts";
import {
  createPressureMonitor,
  type PressureMonitorAPI,
} from "./pressure-monitor.ts";
import { evaluateHints } from "./hints.ts";
import { generateCorrelationId } from "../error.ts";
import { diagEmit } from "../diagnostic-bus.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Server-side transport probe API — client liveness tracking and freeze detection. */
export type TransportProbeServerAPI = ReturnType<
  typeof createTransportProbeServer
>;

/** Unified vitals system — wires loop, transport, and pressure probes into a single API. */
export type VitalsSystem = {
  loopProbe: LoopProbeAPI;
  serverTransport: TransportProbeServerAPI;
  checkAndAlert: () => void;
  getEndpointData: () => VitalsEndpointData;
  getLoopVitalsForPong: () => unknown;
  formatTimelineSummary: () => string;
  computeFeatureSizes: (
    state: Record<string, unknown>,
  ) => Record<string, number>;
  pressureMonitor: PressureMonitorAPI | null;
  destroy: () => void;
};

/** Serializable data exposed via the /__aio/vitals HTTP endpoint. */
export type VitalsEndpointData = {
  server: { loop: ReturnType<LoopProbeAPI["getVitals"]> };
  clients: Array<
    { id: string; status: string; rtt?: number; frozenFor?: number }
  >;
};

// ─── Threshold Resolution ───────────────────────────────────────────────────

/** Merge partial user thresholds with built-in defaults, returning a complete VitalThresholds. */
export function resolveThresholds(
  custom?: Partial<VitalThresholds>,
): VitalThresholds {
  if (!custom) return { ...DEFAULT_THRESHOLDS };
  return {
    render: custom.render ?? DEFAULT_THRESHOLDS.render,
    transport: custom.transport ?? DEFAULT_THRESHOLDS.transport,
    loop: custom.loop ?? DEFAULT_THRESHOLDS.loop,
    queue: custom.queue ?? DEFAULT_THRESHOLDS.queue,
  };
}

// ─── Factory ────────────────────────────────────────────────────────────────

/** Create the unified vitals system from config — wires probes, diagnostics, and pressure monitoring. */
export function createVitalsSystem(config: VitalsConfig): VitalsSystem {
  const thresholds = resolveThresholds(config.thresholds);
  const hintsEnabled = config.hints !== false;
  const onAlert = config.onVitalAlert;

  const loopProbe = createLoopProbe(thresholds);
  const serverTransport = createTransportProbeServer({
    thresholds,
    onClientFrozen: (clientId) => {
      const c = serverTransport.getClientLiveness(clientId);
      const frozenFor = c?.frozenSince ? Date.now() - c.frozenSince : 0;
      fireAlert("transport", "frozen", frozenFor, thresholds.transport.frozen);
    },
    onClientRecovered: (_clientId) => {
      fireAlert("transport", "recovered", 0, 0);
    },
  });

  const reporter = config.onDiagnostic || config.onVitalAlert
    ? createServerDiagReporter({
      onDiagnostic: config.onDiagnostic,
      onConsole: undefined,
      getLoopSnapshot: () => ({
        ...loopProbe.getVitals(),
        status: loopProbe.getStatus(),
        firstDegradedAt: loopProbe.getFirstDegradedAt(),
      }),
      getTransportSnapshot: () => ({
        clients: serverTransport.getAllClients().map((c) => ({
          id: c.clientId,
          status: c.status,
          frozenFor: c.frozenSince ? Date.now() - c.frozenSince : undefined,
        })),
      }),
    })
    : null;

  // Note: dev/prod gating is the caller's responsibility. The diagnostics layer
  // in aio.ts resolves VitalsConfig per mode — prod config should set
  // `pressure: false` to disable. Default (undefined) = enabled.
  const pressureCfg = config.pressure;
  const pressureMonitor = pressureCfg !== false
    ? createPressureMonitor({
      payloadThreshold: typeof pressureCfg === "object"
        ? pressureCfg.payloadThreshold
        : undefined,
      rateThreshold: typeof pressureCfg === "object"
        ? pressureCfg.rateThreshold
        : undefined,
      onDiagnostic: config.onDiagnostic,
    })
    : null;

  function fireAlert(
    layer: VitalLayer,
    status: VitalAlert["status"],
    measured: number,
    threshold: number,
  ) {
    if (!onAlert && !reporter) return;
    const snap = buildSnapshot();
    const hint = hintsEnabled ? evaluateHints(snap, thresholds) : null;
    const alert: VitalAlert = {
      id: generateCorrelationId(),
      layer,
      status,
      duration: measured,
      measured,
      threshold,
      hint,
      ts: Date.now(),
    };
    onAlert?.(alert);
    reporter?.onAlert(alert);
    diagEmit({
      type: "vitals-alert",
      severity: status === "frozen" ? "error" : "warning",
      source: "vitals",
      message:
        `[${layer}] ${status} — measured: ${measured}, threshold: ${threshold}`,
      hint: hint?.suggestion,
    });
  }

  function buildSnapshot(): VitalsSnapshot {
    const loopVitals = loopProbe.getVitals();
    return {
      render: {
        status: "healthy",
        measured: 0,
        lastActionBefore: null,
        firstDegradedAt: null,
        visible: true,
      },
      transport: { status: "healthy", measured: 0, firstDegradedAt: null },
      loop: {
        ...loopVitals,
        status: loopProbe.getStatus(),
        firstDegradedAt: loopProbe.getFirstDegradedAt(),
      },
    };
  }

  function checkAndAlert() {
    const loopStatus = loopProbe.getStatus();
    if (loopStatus !== "healthy") {
      const loopVitals = loopProbe.getVitals();
      const measured = Math.max(
        loopVitals.lastReduceTime,
        loopVitals.queueDepth,
      );
      const threshold = loopStatus === "frozen"
        ? thresholds.loop.frozen
        : loopStatus === "warning"
        ? thresholds.loop.warning
        : thresholds.loop.degraded;
      fireAlert("loop", loopStatus, measured, threshold);
    }
    serverTransport.checkAllClients();
  }

  return {
    loopProbe,
    serverTransport,
    pressureMonitor,
    checkAndAlert,
    getEndpointData: () => ({
      server: { loop: loopProbe.getVitals() },
      clients: serverTransport.getAllClients().map((c) => ({
        id: c.clientId,
        status: c.status,
        frozenFor: c.frozenSince ? Date.now() - c.frozenSince : undefined,
      })),
    }),
    getLoopVitalsForPong: () => loopProbe.getVitals(),
    formatTimelineSummary: () => {
      const snap = buildSnapshot();
      const loopVitals = loopProbe.getVitals();
      const hint = hintsEnabled ? evaluateHints(snap, thresholds) : null;
      const parts = ["[vitals:summary]", `loop: ${loopProbe.getStatus()}`];
      if (loopVitals.queueDepth > 0) {
        parts.push(`queue=${loopVitals.queueDepth}`);
      }
      if (loopVitals.lastReduceTime > 0) {
        parts.push(`reduce=${Math.round(loopVitals.lastReduceTime)}ms`);
      }
      if (hint) {
        parts.push(
          `| cause(${hint.severity}): ${hint.cause}`,
          `| fix: ${hint.suggestion}`,
        );
      }
      return parts.join(" ");
    },
    computeFeatureSizes: (
      state: Record<string, unknown>,
    ): Record<string, number> => {
      const enc = new TextEncoder();
      const sizes: Record<string, number> = {};
      for (const [name, featureState] of Object.entries(state)) {
        sizes[name] = enc.encode(JSON.stringify(featureState)).byteLength;
      }
      return sizes;
    },
    destroy: () => {
      loopProbe.reset();
      serverTransport.destroy();
      pressureMonitor?.destroy();
    },
  };
}

// ─── Re-exports ─────────────────────────────────────────────────────────────

export type {
  ClientLiveness,
  DiagEvent,
  DiagEventDetail,
  Gauge,
  LoopVitals,
  RenderBudget,
  VitalAlert,
  VitalHint,
  VitalsConfig,
  VitalsSnapshot,
  VitalStatus,
} from "./types.ts";
export { DEFAULT_HEARTBEAT_INTERVAL, DEFAULT_THRESHOLDS } from "./types.ts";
export { createLoopProbe } from "./loop-probe.ts";
/** @deprecated Use createRenderMeter instead — rAF-based, staleness-driven */
export { createRenderProbe } from "./render-probe.ts";
export {
  createTransportProbeClient,
  createTransportProbeServer,
} from "./transport-probe.ts";
export {
  classifySeverity,
  detectCascadeOrigin,
  evaluateHints,
} from "./hints.ts";
export { createPressureMonitor } from "./pressure-monitor.ts";
export type {
  PressureMonitorAPI,
  PressureMonitorConfig,
} from "./pressure-monitor.ts";
export { createRenderMeter } from "./render-meter.ts";
export type {
  RenderGauges,
  RenderMeterAPI,
  RenderMeterConfig,
} from "./render-meter.ts";
