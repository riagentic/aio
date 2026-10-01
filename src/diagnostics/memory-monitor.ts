// Memory Pressure Monitor — threshold alerts + trend detection
import { teachableError } from "./error.ts";
import { removalFor, removalMessage } from "../state/removals-core.ts";
import { nearestOf } from "../state/cell-helpers.ts";
import { capDelay, MIN_INTERVAL_MS } from "../state/timer-ceiling.ts";
import { log } from "./logger-api.ts";
import type { GaugeReading } from "./memory-ledger.ts";

/** Heap usage report — per-cell breakdown, trend, and WHY it fired. */
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
  /** WHY this report exists. Three different problems wear the same symptom,
   *  and the fix differs for each:
   *
   *  • `pressure` — near the V8 ceiling. The app is about to OOM.
   *  • `machine` — a large share of the WHOLE machine, even though the ceiling
   *    is not close. This is the one that freezes a desktop: on a 47 GB
   *    ceiling, 75%-of-ceiling is 35 GB, and by then the machine is already
   *    swapping. Ceiling-relative thresholds cannot see it.
   *  • `growth` — climbing steadily with nothing near a threshold. A leak
   *    announces itself here, hours before either of the above.
   *
   *  A NATIVE leak (the heap flat while `rss`/`external` climb — outside V8,
   *  where these thresholds cannot look) reports as `growth` with
   *  {@linkcode MemoryReport.nativeLeak} set: `reason` is frozen public
   *  surface and a fourth member would break callers, so the fourth case
   *  gained its own additive spelling instead. */
  reason: "pressure" | "machine" | "growth";
  /** Heap as a fraction of PHYSICAL RAM (0 when the machine is unmeasurable) —
   *  the number that matters for the machine's health, as opposed to the app's. */
  machinePct: number;
  /** Native memory — the half `heapUsed` never covered. `rssGrowth` is the
   *  change across the trend window, so a report says HOW FAST, not just that
   *  it happened. Optional: the public shape is frozen, and a reader that
   *  never looks here compiles unchanged. */
  native?: { rss: number; external: number; rssGrowth: number };
  /** The JS heap was FLAT while RSS climbed — a leak the heap-relative
   *  thresholds above cannot see. The additive spelling of the case `reason`
   *  is too frozen to name (see its doc). */
  nativeLeak?: boolean;
  /** Every watched series at report time, from the memory ledger. Absent when
   *  the host wired no `getGauges`. */
  gauges?: {
    name: string;
    owner: string;
    unit: "bytes" | "count";
    kind: "level" | "counter";
    value: number;
    bound?: number;
  }[];
  /** The fastest-growing LEVEL series — the answer to "which subsystem". Only
   *  a `level` gauge can be a grower; a `counter` only ever rises by design
   *  and its ceiling, not its slope, is what matters (see `memory-ledger.ts`).
   *  Absent when no level gauge grew. */
  topGrower?: {
    name: string;
    owner: string;
    unit: "bytes" | "count";
    value: number;
    delta: number;
  };
};

/** Per-cell memory size entry — name, serialized byte size, and largest field info. */
export type CellStateSize = {
  name: string;
  bytes: number;
  largestField?: { key: string; entries?: number };
};

/** Configuration for the memory pressure monitor — thresholds, polling
 *  interval, and callback. Every key here is READ by the monitor: a key it
 *  accepted and never consumed (`gcStressRatio`, alpha70) is refused by name
 *  at boot — see {@linkcode validateMemoryConfig}. */
export type MemoryConfig = {
  enabled?: boolean;
  interval?: number;
  warnThreshold?: number;
  criticalThreshold?: number;
  trendWindow?: number; // number of samples for trend detection (default: 10)
  /** Report when the heap passes this fraction of PHYSICAL RAM, whatever the
   *  V8 ceiling says. Default 0.5. The ceiling protects the app; this protects
   *  the machine, and on a big-ceiling build they are nowhere near each other. */
  machineWarnFraction?: number;
  /** Report sustained growth once the heap has risen by at least this fraction
   *  of the ceiling across the trend window while still below every threshold.
   *  Default 0.15. This is the leak signal: silence until 75% means a leak is
   *  only ever reported as an emergency. */
  growthReportRatio?: number;
  onMemoryPressure?: (report: MemoryReport) => void;
};

/** The keys `memory: {}` accepts — ONE list, read by the boot gate. A key the
 *  monitor does not consume is not on it, so it cannot be accepted quietly. */
export const MEMORY_CONFIG_KEYS: ReadonlySet<string> = new Set<
  keyof MemoryConfig
>([
  "enabled",
  "interval",
  "warnThreshold",
  "criticalThreshold",
  "trendWindow",
  "machineWarnFraction",
  "growthReportRatio",
  "onMemoryPressure",
]);

/** Refuse a `memory: {}` the monitor would not honour.
 *
 *  A REMOVED key (src/state/removals.ts — `memory.gcStressRatio`) is named
 *  with the registry's message: what happened, the migration, and the pin
 *  that still runs it. Any other unknown key is refused with a did-you-mean,
 *  the same sentence `cell()` and `aio.run()` use. Throws (fail loud, dev and
 *  prod alike) — a heap threshold that is silently ignored is a monitor that
 *  reports nothing on the day it matters. */
export function validateMemoryConfig(memory: Record<string, unknown>): void {
  for (const key of Object.keys(memory)) {
    if (MEMORY_CONFIG_KEYS.has(key)) continue;
    const removed = removalFor(`memory.${key}`);
    if (removed) {
      throw new Error(`[aio] ${removalMessage(removed, "memory config")}`);
    }
    const near = nearestOf(key, MEMORY_CONFIG_KEYS);
    throw teachableError(
      `unknown memory config key: ${key}` +
        (near ? ` (did you mean "${near}"?)` : ""),
      `remove it, or use one of ${[...MEMORY_CONFIG_KEYS].join(", ")}`,
      "docs/basics/api-reference.md",
    );
  }
}

type MemoryUsage = {
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
};
type CellEntry = { name: string; state: unknown };

/** The memory monitor's default sampling period. */
export const MEMORY_INTERVAL_MS = 10_000;

type MonitorDeps = {
  enabled: boolean;
  interval: number;
  warnThreshold: number;
  criticalThreshold: number;
  trendWindow?: number;
  machineWarnFraction?: number;
  growthReportRatio?: number;
  onReport: (report: MemoryReport) => void;
  getMemoryUsage: () => MemoryUsage;
  getHeapLimit: () => number; // V8 heap_size_limit — the actual max, not lazily-allocated heapTotal
  /** Physical RAM in bytes, or 0 when unmeasurable. Ceiling-relative thresholds
   *  say nothing about the machine, and the machine is what freezes. */
  getTotalMemory?: () => number;
  getCellStates: () => CellEntry[];
  /** Read every watched series (usual wiring: `memory-ledger.ts`'s
   *  `readGauges`). Absent ⇒ reports carry `gauges: []` and no `topGrower`,
   *  exactly as before this existed. */
  getGauges?: () => GaugeReading[];
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
  const usedSamples: number[] = []; // …and of absolute bytes, for growth
  // …and of RSS, for the NATIVE leak the heap windows above cannot see. A
  // native leak is `rss` climbing while `usedSamples` stays flat — the
  // signature that ran to 40 GB unannounced before this window existed.
  const rssSamples: number[] = [];
  // Last tick's reading per level gauge, so this tick can say which series
  // moved — the difference between "something grew" and "the sync buffer grew".
  const prevGauge = new Map<string, number>();

  // NaN (`Number(env)` unset), 0 or a negative period was a ~1 ms loop, each
  // tick a recursive sizeof over every cell's state.
  const period = capDelay(
    "memory.interval",
    deps.interval,
    (m) => log.warn("memory", m),
    MEMORY_INTERVAL_MS,
    MIN_INTERVAL_MS,
  );
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

    // Absolute samples too: the growth check must not be expressed as a
    // fraction of the ceiling, or a leak on a 47 GB ceiling stays "0.02 →
    // 0.04" and reads as noise while it eats 20 GB.
    usedSamples.push(mem.heapUsed);
    if (usedSamples.length > windowSize) usedSamples.shift();

    // …and native. RSS is the number the machine feels; the heap is inside it.
    rssSamples.push(mem.rss);
    if (rssSamples.length > windowSize) rssSamples.shift();

    // Read the ledger every tick (O(#gauges), never a state walk) so a report
    // can name the fastest-moving series, and so `prevGauge` is current even
    // on ticks that do not speak.
    const gauges = deps.getGauges?.() ?? [];
    const grower = fastestGrower(gauges, prevGauge);

    const total = deps.getTotalMemory?.() ?? 0;
    // The machine's share is RSS over RAM, not heap over RAM: RSS is what the
    // OS must find room for, and a native leak lives entirely inside it while
    // `heapUsed` stays flat.
    const machinePct = total > 0 ? mem.rss / total : 0;

    // FOUR reasons to speak, and they are genuinely different problems.
    const pressure = heapPct >= deps.warnThreshold;
    // …a large share of the whole machine, whatever the ceiling allows. On a
    // 47 GB ceiling the pressure threshold is 35 GB, by which point a 64 GB
    // desktop is already swapping — this is the check that sees it first.
    const machine = machinePct >= (deps.machineWarnFraction ?? 0.5);
    const heapRising = detectTrend(usedSamples) === "rising";
    const rssGrowth = rssSamples.length >= 3
      ? rssSamples[rssSamples.length - 1]! - rssSamples[0]!
      : 0;
    // …or the JS heap FLAT while RSS climbs. Requiring a flat heap is what
    // keeps an ordinary heap climb reported as `growth` rather than relabelled
    // `native`; the two want different fixes.
    const native = !pressure && !machine && !heapRising &&
      rssSamples.length >= windowSize &&
      detectTrend(rssSamples) === "rising" &&
      rssGrowth >
        Math.max(
          NATIVE_GROWTH_FLOOR_BYTES,
          rssSamples[0]! * NATIVE_GROWTH_RATIO,
        );
    // …or the heap climbing steadily while comfortably below a threshold. That
    // is a leak, and reporting it only at 75% turns a slow diagnosis into an
    // emergency.
    const growth = !pressure && !machine && !native &&
      usedSamples.length >= windowSize && heapRising &&
      (usedSamples[usedSamples.length - 1]! - usedSamples[0]!) >
        (heapLimit > 0 ? heapLimit : mem.heapTotal) *
          (deps.growthReportRatio ?? 0.15);

    for (const g of gauges) prevGauge.set(g.name, g.value);

    if (!pressure && !machine && !growth && !native) return;
    // Once a growth report has gone out, do not repeat it every interval — the
    // window has to climb again by the same amount to earn a second one.
    if (growth) usedSamples.length = 0;
    if (native) rssSamples.length = 0;

    // Measure cell states
    const entries = deps.getCellStates();
    const cellStates = entries
      .map((e) => measureCellState(e.name, e.state))
      .sort((a, b) => b.bytes - a.bytes);

    const level: "warn" | "critical" = heapPct >= deps.criticalThreshold
      ? "critical"
      : "warn";
    const trend = detectTrend(samples);
    // `reason` is frozen public surface: a native leak reports as `growth`
    // (it IS climbing steadily) with `nativeLeak` set, rather than a fourth
    // member that would break every existing reader.
    const reason: MemoryReport["reason"] = pressure
      ? "pressure"
      : machine
      ? "machine"
      : "growth";

    deps.onReport({
      reason,
      machinePct,
      level,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      heapLimit: heapLimit,
      heapPct,
      gcReclaimed,
      gcReclaimedPct,
      cellStates,
      trend,
      native: { rss: mem.rss, external: mem.external, rssGrowth },
      ...(native ? { nativeLeak: true } : {}),
      gauges,
      ...(grower ? { topGrower: grower } : {}),
    });
  }, period);

  return {
    stop: () => clearInterval(id),
  };
}

/** A native leak must clear BOTH an absolute floor — so a quiet app's RSS
 *  jitter never reads as a leak — and a share of the window's starting RSS.
 *  Sized off the real incident: ~10 GB and climbing across a 10-sample window
 *  clears both by orders of magnitude, while a warm-up bump does not. */
const NATIVE_GROWTH_FLOOR_BYTES = 256 * 1024 * 1024;
const NATIVE_GROWTH_RATIO = 0.25;

/** The fastest-rising LEVEL series between two ticks, or `undefined` when none
 *  rose. Only `level` gauges qualify: a `counter` (cumulative work) rises by
 *  design, and calling that a leak would bury the real one. */
function fastestGrower(
  gauges: GaugeReading[],
  prev: Map<string, number>,
): MemoryReport["topGrower"] {
  let top: MemoryReport["topGrower"];
  for (const g of gauges) {
    if (g.kind !== "level") continue;
    const before = prev.get(g.name);
    if (before === undefined) continue;
    const delta = g.value - before;
    if (delta <= 0) continue;
    if (!top || delta > top.delta) {
      top = {
        name: g.name,
        owner: g.owner,
        unit: g.unit,
        value: g.value,
        delta,
      };
    }
  }
  return top;
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
