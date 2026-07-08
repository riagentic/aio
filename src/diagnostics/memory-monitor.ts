// Memory Pressure Monitor — threshold alerts + trend detection

/** Heap usage report emitted when memory exceeds thresholds — includes per-cell breakdown and trend. */
export type MemoryReport = {
  level: "warn" | "critical";
  heapUsed: number;
  heapTotal: number;
  heapLimit: number; // V8 heap_size_limit — the real max
  heapPct: number;
  gcReclaimed: number;
  gcReclaimedPct: number;
  cellStates: CellStateSize[];
  trend: "rising" | "stable" | "falling";
};

/** Per-cell memory size entry — name, serialized byte size, and largest field info. */
export type CellStateSize = {
  name: string;
  bytes: number;
  largestField?: { key: string; entries?: number };
};

/** Configuration for the memory pressure monitor — thresholds, polling interval, and callback. */
export type MemoryConfig = {
  enabled?: boolean;
  interval?: number;
  warnThreshold?: number;
  criticalThreshold?: number;
  gcStressRatio?: number;
  trendWindow?: number; // number of samples for trend detection (default: 10)
  onMemoryPressure?: (report: MemoryReport) => void;
};

type MemoryUsage = {
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
};
type CellEntry = { name: string; state: unknown };

type MonitorDeps = {
  enabled: boolean;
  interval: number;
  warnThreshold: number;
  criticalThreshold: number;
  gcStressRatio?: number;
  trendWindow?: number;
  onReport: (report: MemoryReport) => void;
  getMemoryUsage: () => MemoryUsage;
  getHeapLimit: () => number; // V8 heap_size_limit — the actual max, not lazily-allocated heapTotal
  getCellStates: () => CellEntry[];
};

/** Recursive size estimator for JS values. */
export function sizeof(obj: unknown, seen?: Set<unknown>): number {
  if (obj === null || obj === undefined) return 0;

  const type = typeof obj;
  if (type === "string") return (obj as string).length * 2;
  if (type === "number" || type === "boolean") return 8;

  if (type !== "object" && type !== "function") return 0;

  // Circular ref guard
  if (!seen) seen = new Set();
  if (seen.has(obj)) return 0;
  seen.add(obj);

  if (obj instanceof ArrayBuffer) return obj.byteLength;
  if (ArrayBuffer.isView(obj)) {
    return (obj as { byteLength: number }).byteLength;
  }

  let total = 0;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      total += sizeof(obj[i], seen);
    }
  } else {
    const o = obj as Record<string, unknown>;
    for (const key in o) {
      if (Object.prototype.hasOwnProperty.call(o, key)) {
        total += sizeof(key, seen) + sizeof(o[key], seen);
      }
    }
  }
  return total;
}

/** Measure a single cell's state size + identify largest field. */
export function measureCellState(
  name: string,
  state: unknown,
): CellStateSize {
  const bytes = sizeof(state);
  const result: CellStateSize = { name, bytes };

  if (
    state && typeof state === "object" && !ArrayBuffer.isView(state) &&
    !(state instanceof ArrayBuffer)
  ) {
    let maxKey = "";
    let maxSize = -1;
    const o = state as Record<string, unknown>;
    for (const key in o) {
      if (!Object.prototype.hasOwnProperty.call(o, key)) continue;
      const fieldSize = sizeof(o[key]);
      if (fieldSize > maxSize) {
        maxSize = fieldSize;
        maxKey = key;
      }
    }
    if (maxKey) {
      const val = o[maxKey];
      const field: { key: string; entries?: number } = { key: maxKey };
      if (Array.isArray(val)) {
        field.entries = val.length;
      } else if (val && typeof val === "object") {
        field.entries = Object.keys(val).length;
      }
      result.largestField = field;
    }
  }

  return result;
}

/** Create a memory pressure monitor. Returns { stop }. */
export function createMemoryMonitor(deps: MonitorDeps): { stop: () => void } {
  if (!deps.enabled) return { stop: () => {} };

  const windowSize = deps.trendWindow ?? 10;
  let prevHeapUsed = 0;
  const samples: number[] = []; // sliding window of heapPct samples

  const id = setInterval(() => {
    const mem = deps.getMemoryUsage();
    const heapLimit = deps.getHeapLimit();
    // Use heap_size_limit (actual V8 max) — not heapTotal (lazily-allocated, always near heapUsed)
    const heapPct = heapLimit > 0
      ? mem.heapUsed / heapLimit
      : mem.heapUsed / mem.heapTotal;

    // GC reclaimed
    const gcReclaimed = prevHeapUsed > 0
      ? Math.max(0, prevHeapUsed - mem.heapUsed)
      : 0;
    const gcReclaimedPct = prevHeapUsed > 0 ? gcReclaimed / prevHeapUsed : 0;
    prevHeapUsed = mem.heapUsed;

    // Track samples for trend (sliding window)
    samples.push(heapPct);
    if (samples.length > windowSize) samples.shift();

    if (heapPct < deps.warnThreshold) return;

    // Measure cell states
    const entries = deps.getCellStates();
    const cellStates = entries
      .map((e) => measureCellState(e.name, e.state))
      .sort((a, b) => b.bytes - a.bytes);

    const level: "warn" | "critical" = heapPct >= deps.criticalThreshold
      ? "critical"
      : "warn";
    const trend = detectTrend(samples);

    deps.onReport({
      level,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      heapLimit: heapLimit,
      heapPct,
      gcReclaimed,
      gcReclaimedPct,
      cellStates,
      trend,
    });
  }, deps.interval);

  return {
    stop: () => clearInterval(id),
  };
}

/** Detect trend using linear regression slope over sliding window.
 *  More stable than 3-sample comparison — reduces oscillation on noisy data. */
export function detectTrend(
  samples: number[],
): "rising" | "stable" | "falling" {
  if (samples.length < 3) return "stable";
  const n = samples.length;
  // Simple linear regression: slope = (n*Σxy - Σx*Σy) / (n*Σx² - (Σx)²)
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += samples[i]!;
    sumXY += i * samples[i]!;
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return "stable";
  const slope = (n * sumXY - sumX * sumY) / denom;
  // Threshold: 0.5% per sample to filter noise
  const threshold = 0.005;
  if (slope > threshold) return "rising";
  if (slope < -threshold) return "falling";
  return "stable";
}
