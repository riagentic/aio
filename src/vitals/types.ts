// ─── Vital Signs — Types & Constants ────────────────────────────────────────

/** Health status classification — healthy, degraded, warning, frozen, or recovered. */
export type VitalStatus =
  | "healthy"
  | "degraded"
  | "warning"
  | "frozen"
  | "recovered";

/** Monitoring layer — render (client paint), transport (network), or loop (dispatch queue). */
export type VitalLayer = "render" | "transport" | "loop";

/** Threshold triplet for a single monitoring layer — degraded, warning, frozen (ms). */
export type LayerThreshold = {
  degraded: number;
  warning: number;
  frozen: number;
};

/** Per-layer threshold configuration — render, transport, loop, and queue. */
export type VitalThresholds = {
  render: LayerThreshold;
  transport: LayerThreshold;
  loop: LayerThreshold;
  queue: LayerThreshold;
};

/** Default heartbeat interval in milliseconds for vitals ping/pong cycle. */
export const DEFAULT_HEARTBEAT_INTERVAL = 1000;

/** Built-in threshold defaults (ms) for render, transport, loop, and queue layers. */
export const DEFAULT_THRESHOLDS: VitalThresholds = {
  render: { degraded: 50, warning: 200, frozen: 2000 },
  transport: { degraded: 100, warning: 500, frozen: 2000 },
  loop: { degraded: 100, warning: 500, frozen: 2000 },
  queue: { degraded: 50, warning: 200, frozen: 1000 },
};

/** Root-cause diagnostic hint — cause description, evidence, suggestion, and confidence level. */
export type VitalHint = {
  cause: string;
  evidence: string[];
  suggestion: string;
  severity: "likely" | "possible" | "speculative";
};

/** Alert emitted when a vital crosses a threshold — layer, status, measurement, hint, and timestamp. */
export type VitalAlert = {
  id: string;
  layer: VitalLayer;
  status: VitalStatus;
  duration: number;
  measured: number;
  threshold: number;
  hint: VitalHint | null;
  ts: number;
  correlationId?: string;
};

/** Detail payload for diagnostic events — trigger, timing, queue depth, payload size, etc. */
export type DiagEventDetail = {
  trigger?: string;
  reduceMs?: number;
  p95Ms?: number;
  queueDepth?: number;
  drainRate?: number;
  rtt?: number;
  skipCount?: number;
  frozenFor?: number;
  payloadBytes?: number;
  bytesPerSec?: number;
  hint?: string;
};

/** Structured diagnostic event emitted by the vitals system — freeze, staleness, pressure, etc. */
export type DiagEvent = {
  kind: "freeze" | "stale" | "slow" | "disconnect" | "recovered" | "pressure";
  severity: "likely" | "possible" | "speculative";
  summary: string;
  detail: DiagEventDetail;
  timestamp: number;
};

/** Named metric gauge — current value, capacity, and percentage (0-100). */
export type Gauge = {
  name: string;
  current: number;
  capacity: number;
  percent: number; // Math.min(100, current / capacity * 100), clamped 0-100
};

/** Client-side render budget thresholds — staleness (ms) and pending patch count. */
export type RenderBudget = {
  staleness?: number; // ms — primary threshold (default 300)
  pendingPatches?: number; // count before warning (default 10)
};

/** Server-side dispatch loop health — queue depth, drain rate, reduce timing, and circuit breakers. */
export type LoopVitals = {
  queueDepth: number;
  drainRate: number;
  lastReduceTime: number;
  lastReduceAction: string;
  lastReduceFeature: string;
  p95ReduceTime: number;
  effectBacklog: number;
  circuitBreakers: string[];
};

/** Per-client liveness state — last ping/send timestamps, status, and optional freeze start. */
export type ClientLiveness = {
  clientId: string;
  lastPing: number;
  lastSent: number;
  status: VitalStatus;
  frozenSince?: number;
};

/** Diagnostic report emitted when a client render freeze is detected. */
export type RenderFreezeReport = {
  frozenFor: number;
  lastActionBefore: string | null;
  lastFeature: string | null;
  unprocessedDeltas: number;
  memoryBefore?: number;
  memoryAfter?: number;
};

/** Timeline of status transitions for a single probe layer — first degraded/warning/frozen/recovered timestamps. */
export type ProbeTimeline = {
  probe: VitalLayer;
  firstDegradedAt: number | null;
  firstWarningAt: number | null;
  firstFrozenAt: number | null;
  recoveredAt: number | null;
};

/** Point-in-time snapshot of all three vitals layers — render, transport, and loop. */
export type VitalsSnapshot = {
  render: {
    status: VitalStatus;
    measured: number;
    lastActionBefore: string | null;
    firstDegradedAt: number | null;
    frozenFor?: number;
    memoryBefore?: number;
    memoryAfter?: number;
    previousFreezeCount?: number;
    visible?: boolean;
  };
  transport: {
    status: VitalStatus;
    measured: number;
    firstDegradedAt: number | null;
  };
  loop: LoopVitals & {
    status: VitalStatus;
    firstDegradedAt: number | null;
  };
};

/** Freeze cascade analysis — duration, origin layer, cascade order, and probe snapshots. */
export type FreezeTimeline = {
  totalDuration: number;
  cascadeOrigin: VitalLayer;
  cascadeOrder: ProbeTimeline[];
  hint: VitalHint | null;
  probeSnapshots: VitalsSnapshot;
};

/** Vitals system configuration — heartbeat interval, thresholds, hints, backpressure, and alert callback. */
export type VitalsConfig = {
  heartbeatInterval?: number;
  thresholds?: Partial<VitalThresholds>;
  hints?: boolean;
  backpressure?: boolean;
  pressure?: boolean | { payloadThreshold?: number; rateThreshold?: number };
  onVitalAlert?: (alert: VitalAlert) => void;
  onDiagnostic?: (event: DiagEvent) => void;
};

/** Tracks array reference identity across patch cycles — preserved vs changed counts. */
export type ArrayRefStats = {
  preserved: number;
  changed: number;
  total: number;
  /** Number of patch cycles recorded since last reset */
  cycles: number;
};
