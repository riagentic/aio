// ─── Vital Signs — Types & Constants ────────────────────────────────────────

export type VitalStatus =
  | "healthy"
  | "degraded"
  | "warning"
  | "frozen"
  | "recovered";

export type VitalLayer = "render" | "transport" | "loop";

export type LayerThreshold = {
  degraded: number;
  warning: number;
  frozen: number;
};

export type VitalThresholds = {
  render: LayerThreshold;
  transport: LayerThreshold;
  loop: LayerThreshold;
  queue: LayerThreshold;
};

export const DEFAULT_HEARTBEAT_INTERVAL = 1000;

export const DEFAULT_THRESHOLDS: VitalThresholds = {
  render: { degraded: 50, warning: 200, frozen: 2000 },
  transport: { degraded: 100, warning: 500, frozen: 2000 },
  loop: { degraded: 100, warning: 500, frozen: 2000 },
  queue: { degraded: 50, warning: 200, frozen: 1000 },
};

export type VitalHint = {
  cause: string;
  evidence: string[];
  suggestion: string;
  severity: "likely" | "possible" | "speculative";
};

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

export type DiagEvent = {
  kind: "freeze" | "stale" | "slow" | "disconnect" | "recovered" | "pressure";
  severity: "likely" | "possible" | "speculative";
  summary: string;
  detail: DiagEventDetail;
  timestamp: number;
};

export type Gauge = {
  name: string;
  current: number;
  capacity: number;
  percent: number; // Math.min(100, current / capacity * 100), clamped 0-100
};

export type RenderBudget = {
  staleness?: number; // ms — primary threshold (default 300)
  pendingPatches?: number; // count before warning (default 10)
};

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

export type ClientLiveness = {
  clientId: string;
  lastPing: number;
  lastSent: number;
  status: VitalStatus;
  frozenSince?: number;
};

export type RenderFreezeReport = {
  frozenFor: number;
  lastActionBefore: string | null;
  lastFeature: string | null;
  unprocessedDeltas: number;
  memoryBefore?: number;
  memoryAfter?: number;
};

export type ProbeTimeline = {
  probe: VitalLayer;
  firstDegradedAt: number | null;
  firstWarningAt: number | null;
  firstFrozenAt: number | null;
  recoveredAt: number | null;
};

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

export type FreezeTimeline = {
  totalDuration: number;
  cascadeOrigin: VitalLayer;
  cascadeOrder: ProbeTimeline[];
  hint: VitalHint | null;
  probeSnapshots: VitalsSnapshot;
};

export type VitalsConfig = {
  heartbeatInterval?: number;
  thresholds?: Partial<VitalThresholds>;
  hints?: boolean;
  backpressure?: boolean;
  pressure?: boolean | { payloadThreshold?: number; rateThreshold?: number };
  onVitalAlert?: (alert: VitalAlert) => void;
  onDiagnostic?: (event: DiagEvent) => void;
};
