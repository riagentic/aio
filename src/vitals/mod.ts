// ─── Vital Signs — Public API ────────────────────────────────────────────────
// Wires all probes together into a single VitalsSystem.

import { getLogger, log } from "../diagnostics/logger-api.ts";
import type {
  VitalAlert,
  VitalLayer,
  VitalsConfig,
  VitalsSnapshot,
  VitalStatus,
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
import { generateCorrelationId } from "../diagnostics/error.ts";
import { diagEmit } from "../diagnostics/diagnostic-bus.ts";

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
  computeCellSizes: (
    state: Record<string, unknown>,
  ) => Record<string, number>;
  pressureMonitor: PressureMonitorAPI | null;
  /** Whether per-client send throttling is active (`vitals.backpressure`,
   *  default on). This flag is the ONLY reader of that option — it used to
   *  have none at all: the switch type-checked, was accepted, and changed
   *  nothing, while `hints.ts` advised "if backpressure is off, enable it". */
  backpressureEnabled: boolean;
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
    // `unreachableFor` is the ping gap the probe just measured — the number
    // the threshold was compared against. It used to be recomputed here as
    // `Date.now() - c.frozenSince`, and `frozenSince` is stamped AT this
    // transition, so the answer was ~0 every single time: every disconnect
    // alert carried `measured: 0` and the reporter printed "DISCONNECTED —
    // client unreachable for 0.0s". A diagnostic whose one number can only
    // ever be zero says less than no number at all.
    onClientFrozen: (clientId, unreachableFor) => {
      void clientId;
      fireAlert(
        "transport",
        "frozen",
        unreachableFor,
        thresholds.transport.frozen,
      );
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
      getTransportSnapshot: () => ({ clients: clientRows() }),
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
    // NOTE: no early return on "no user callbacks". The diagnostic-bus emit
    // below is what feeds the logger, amui and `am`, so bailing out here made
    // every vitals alert invisible under the DEFAULT config (no onVitalAlert,
    // no reporter) — the exact setup where a freeze most needs to be seen.
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
    // The STRUCTURED LOG, first — `logger.vitals()` is the only writer of a
    // vitals measurement into `perf.log`/`debug.log`, and it had no caller:
    // the whole `vitals:<layer>` category was dead, so `perf.log` carried only
    // `perf:reduce` budget lines and never a vitals one. It is also the sink
    // that survives when the diagnostic bus is a no-op (prod).
    try {
      getLogger()?.vitals?.(
        layer,
        status,
        measured,
        threshold,
        hint ?? undefined,
      );
    } catch (e) {
      log.error("vitals", `writing the vitals line threw — ${e}`);
    }
    // User callbacks run on the heartbeat timer: a throwing hook here was an
    // unhandled exception in a bare timer callback → server down. Report and
    // keep the heartbeat alive; a broken hook must not take the app with it.
    try {
      onAlert?.(alert);
    } catch (e) {
      log.error("vitals", `onVitalAlert hook threw — ${e}`);
    }
    try {
      reporter?.onAlert(alert);
    } catch (e) {
      log.error("vitals", `reporter.onAlert threw — ${e}`);
    }
    diagEmit({
      type: "vitals-alert",
      severity: status === "frozen" ? "error" : "warning",
      source: "vitals",
      message:
        `[${layer}] ${status} — measured: ${measured}, threshold: ${threshold}`,
      hint: hint?.suggestion,
    });
  }

  /** The client rows every consumer of transport liveness reads.
   *
   *  ONE decider, because "how long has this client been unreachable" was
   *  computed in three places and all three computed it from `frozenSince` —
   *  which is stamped at the moment the client is declared frozen, so the
   *  answer was zero by construction, forever.
   *
   *  The honest measurement is the gap since the last sign of life, which is
   *  also exactly what the freeze threshold is compared against. */
  function clientRows(): Array<
    { id: string; status: string; frozenFor?: number; gap: number }
  > {
    const at = Date.now();
    return serverTransport.getAllClients().map((c) => ({
      id: c.clientId,
      status: c.status,
      gap: at - c.lastPing,
      frozenFor: c.status === "frozen" ? at - c.lastPing : undefined,
    }));
  }

  function buildSnapshot(): VitalsSnapshot {
    const loopVitals = loopProbe.getVitals();
    const rows = clientRows();
    // The transport layer of the snapshot, from the probe that actually
    // measures it. It used to be hardcoded `healthy / 0`, which made THREE of
    // the hint engine's rules structurally unreachable on the server — rule 3
    // among them, the one written for exactly the alert this snapshot is
    // built for ("Network connection stalled. No pong in Nms"). So every
    // client-freeze alert went out with `hint: null` and the reporter fell
    // back to its generic string, while the rule that had the answer sat
    // one field away.
    //
    // The WORST client speaks for the layer: a freeze alert is raised per
    // client, and the layer is degraded exactly when some client is.
    const worst = rows.reduce<{ status: string; gap: number } | null>(
      (m, r) => (m === null || r.gap > m.gap ? r : m),
      null,
    );
    const frozenSince = serverTransport.getAllClients()
      .map((c) => c.frozenSince)
      .filter((t): t is number => typeof t === "number")
      .sort((a, b) => a - b)[0] ?? null;
    return {
      // The server has NO render probe — render is a browser-side measurement
      // (`render-meter.ts`) and never reaches this snapshot. Reported as
      // healthy because the server genuinely has nothing to say about it, not
      // because it measured anything; the hint rules that read it (1, 4, 5, 6)
      // are client-side rules and cannot fire here. Said out loud so the next
      // reader does not mistake this for a measurement.
      render: {
        status: "healthy",
        measured: 0,
        lastActionBefore: null,
        firstDegradedAt: null,
        visible: true,
      },
      transport: {
        status: (worst?.status as VitalStatus) ?? "healthy",
        measured: worst?.gap ?? 0,
        firstDegradedAt: frozenSince,
      },
      loop: {
        ...loopVitals,
        status: loopProbe.getStatus(),
        firstDegradedAt: loopProbe.getFirstDegradedAt(),
      },
    };
  }

  function checkAndAlert() {
    const { status: loopStatus, driver } = loopProbe.getStatusDetail();
    if (loopStatus !== "healthy") {
      const loopVitals = loopProbe.getVitals();
      // measured and threshold must come from the SAME layer: the queue is an
      // action count, the loop is milliseconds. `max(ms, count)` against a
      // loop threshold reported incoherent numbers (e.g. "degraded —
      // measured: 60, threshold: 100" for a queue flood of fast reduces).
      const tiers = driver === "queue" ? thresholds.queue : thresholds.loop;
      const measured = driver === "queue"
        ? loopVitals.queueDepth
        : loopVitals.lastReduceTime;
      const threshold = loopStatus === "frozen"
        ? tiers.frozen
        : loopStatus === "warning"
        ? tiers.warning
        : tiers.degraded;
      fireAlert("loop", loopStatus, measured, threshold);
    }
    serverTransport.checkAllClients();
  }

  return {
    loopProbe,
    serverTransport,
    pressureMonitor,
    backpressureEnabled: config.backpressure !== false,
    checkAndAlert,
    getEndpointData: () => ({
      server: { loop: loopProbe.getVitals() },
      clients: clientRows(),
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
    computeCellSizes: (
      state: Record<string, unknown>,
    ): Record<string, number> => {
      const enc = new TextEncoder();
      const sizes: Record<string, number> = {};
      for (const [name, cellState] of Object.entries(state)) {
        sizes[name] = enc.encode(JSON.stringify(cellState)).byteLength;
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
export {
  createTransportProbeClient,
  createTransportProbeServer,
} from "./transport-probe.ts";
export { classifySeverity, evaluateHints } from "./hints.ts";
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
