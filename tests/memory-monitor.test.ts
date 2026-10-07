import { assertEquals, assertExists } from "@std/assert";
import {
  createMemoryMonitor,
  describeMemoryReport,
  detectTrend,
  measureCellState,
  type MemoryReport,
  sizeof,
} from "../src/diagnostics/memory-monitor.ts";

// ── sizeof ─────────────────────────────────────────────────────────

Deno.test("sizeof: null and undefined return 0", () => {
  assertEquals(sizeof(null), 0);
  assertEquals(sizeof(undefined), 0);
});

Deno.test("sizeof: string is length * 2", () => {
  assertEquals(sizeof("abc"), 6);
  assertEquals(sizeof(""), 0);
  assertEquals(sizeof("x"), 2);
});

Deno.test("sizeof: number and boolean return 8", () => {
  assertEquals(sizeof(42), 8);
  assertEquals(sizeof(0), 8);
  assertEquals(sizeof(true), 8);
  assertEquals(sizeof(false), 8);
});

Deno.test("sizeof: flat object sums key + value sizes", () => {
  // { a: 1 } => key "a" = 2, value 1 = 8 => total 10
  assertEquals(sizeof({ a: 1 }), 10);
});

Deno.test("sizeof: array sums element sizes", () => {
  // [1, 2, 3] => 3 * 8 = 24
  assertEquals(sizeof([1, 2, 3]), 24);
});

Deno.test("sizeof: nested object", () => {
  // { a: { b: 1 } }
  // outer key "a" = 2, inner object: key "b" = 2 + value 1 = 8 => inner = 10
  // total = 2 + 10 = 12
  assertEquals(sizeof({ a: { b: 1 } }), 12);
});

Deno.test("sizeof: circular reference returns 0 for revisited node", () => {
  const obj: Record<string, unknown> = { x: 1 };
  obj.self = obj;
  // key "x" = 2, value = 8, key "self" = 8, value = 0 (circular) => 18
  assertEquals(sizeof(obj), 18);
});

Deno.test("sizeof: ArrayBuffer returns byteLength", () => {
  assertEquals(sizeof(new ArrayBuffer(64)), 64);
});

Deno.test("sizeof: TypedArray returns byteLength", () => {
  assertEquals(sizeof(new Uint8Array(16)), 16);
  assertEquals(sizeof(new Float64Array(4)), 32);
});

// ── measureCellState ────────────────────────────────────────────

Deno.test("measureCellState: simple state returns name and bytes", () => {
  const result = measureCellState("counter", { count: 0 });
  assertEquals(result.name, "counter");
  // key "count" = 10, value 0 = 8 => 18
  assertEquals(result.bytes, 18);
});

Deno.test("measureCellState: finds largest field", () => {
  const state = { small: 1, big: "a]long string here!!" };
  const result = measureCellState("test", state);
  assertExists(result.largestField);
  assertEquals(result.largestField!.key, "big");
});

Deno.test("measureCellState: counts array entries on largest field", () => {
  const state = { items: [1, 2, 3, 4, 5], flag: true };
  const result = measureCellState("list", state);
  assertExists(result.largestField);
  assertEquals(result.largestField!.key, "items");
  assertEquals(result.largestField!.entries, 5);
});

Deno.test("measureCellState: counts object entries on largest field", () => {
  const state = { meta: { a: 1, b: 2, c: 3 }, x: 1 };
  const result = measureCellState("obj", state);
  assertExists(result.largestField);
  assertEquals(result.largestField!.key, "meta");
  assertEquals(result.largestField!.entries, 3);
});

// ── detectTrend ────────────────────────────────────────────────────

Deno.test("detectTrend: short array (< 3) returns stable", () => {
  assertEquals(detectTrend([]), "stable");
  assertEquals(detectTrend([0.5]), "stable");
  assertEquals(detectTrend([0.5, 0.6]), "stable");
});

Deno.test("detectTrend: rising samples", () => {
  assertEquals(detectTrend([0.1, 0.2, 0.3, 0.4, 0.5]), "rising");
});

Deno.test("detectTrend: falling samples", () => {
  assertEquals(detectTrend([0.5, 0.4, 0.3, 0.2, 0.1]), "falling");
});

Deno.test("detectTrend: flat samples are stable", () => {
  assertEquals(detectTrend([0.5, 0.5, 0.5, 0.5, 0.5]), "stable");
});

Deno.test("detectTrend: noisy but mostly flat is stable", () => {
  // slight oscillation within threshold
  assertEquals(
    detectTrend([0.50, 0.501, 0.499, 0.502, 0.498, 0.501, 0.500]),
    "stable",
  );
});

Deno.test("detectTrend: slope exactly at threshold boundary is stable", () => {
  // Construct samples where slope = exactly 0.005 per sample index
  // With n=5 samples [0, 1, 2, 3, 4], slope must be > 0.005 to be 'rising'
  // slope = 0.005 exactly → stable (uses strict >)
  // y = base + 0.005 * x  → slope = 0.005
  const base = 0.5;
  const samples = [0, 1, 2, 3, 4].map((i) => base + 0.005 * i);
  assertEquals(detectTrend(samples), "stable");
});

// ── createMemoryMonitor ────────────────────────────────────────────

Deno.test("createMemoryMonitor: disabled returns noop stop", () => {
  const monitor = createMemoryMonitor({
    enabled: false,
    interval: 100,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    onReport: () => {
      throw new Error("should not fire");
    },
    getMemoryUsage: () => ({ heapUsed: 0, heapTotal: 1, rss: 0, external: 0 }),
    getHeapLimit: () => 0,
    getCellStates: () => [],
  });
  assertExists(monitor.stop);
  monitor.stop(); // should not throw
});

Deno.test("createMemoryMonitor: fires callback when above warn threshold", async () => {
  const reports: { level: string; heapPct: number; trend: string }[] = [];

  const monitor = createMemoryMonitor({
    enabled: true,
    interval: 20,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    onReport: (r) =>
      reports.push({ level: r.level, heapPct: r.heapPct, trend: r.trend }),
    getMemoryUsage: () => ({
      heapUsed: 80,
      heapTotal: 100,
      rss: 120,
      external: 0,
    }),
    getHeapLimit: () => 100,
    getCellStates: () => [{ name: "f1", state: { x: 1 } }],
  });

  await new Promise((r) => setTimeout(r, 80));
  monitor.stop();

  assertEquals(reports.length > 0, true);
  assertEquals(reports[0]!.level, "warn");
  assertEquals(reports[0]!.heapPct, 0.8);
});

Deno.test("createMemoryMonitor: critical level when above criticalThreshold", async () => {
  const reports: { level: string }[] = [];

  const monitor = createMemoryMonitor({
    enabled: true,
    interval: 20,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    onReport: (r) => reports.push({ level: r.level }),
    getMemoryUsage: () => ({
      heapUsed: 95,
      heapTotal: 100,
      rss: 120,
      external: 0,
    }),
    getHeapLimit: () => 100,
    getCellStates: () => [],
  });

  await new Promise((r) => setTimeout(r, 60));
  monitor.stop();

  assertEquals(reports.length > 0, true);
  assertEquals(reports[0]!.level, "critical");
});

Deno.test("createMemoryMonitor: does not fire when below warnThreshold", async () => {
  let fired = false;

  const monitor = createMemoryMonitor({
    enabled: true,
    interval: 20,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    onReport: () => {
      fired = true;
    },
    getMemoryUsage: () => ({
      heapUsed: 50,
      heapTotal: 100,
      rss: 80,
      external: 0,
    }),
    getHeapLimit: () => 100,
    getCellStates: () => [],
  });

  await new Promise((r) => setTimeout(r, 80));
  monitor.stop();

  assertEquals(fired, false);
});

Deno.test("createMemoryMonitor: respects trendWindow config", async () => {
  const reports: { trend: string }[] = [];
  let tick = 0;

  const monitor = createMemoryMonitor({
    enabled: true,
    interval: 15,
    warnThreshold: 0.5,
    criticalThreshold: 0.9,
    trendWindow: 3,
    onReport: (r) => reports.push({ trend: r.trend }),
    getMemoryUsage: () => {
      tick++;
      // Rising heap pct: 0.6, 0.7, 0.8, 0.9 ...
      const pct = 0.5 + tick * 0.1;
      return { heapUsed: pct * 100, heapTotal: 100, rss: 120, external: 0 };
    },
    getHeapLimit: () => 100,
    getCellStates: () => [],
  });

  await new Promise((r) => setTimeout(r, 120));
  monitor.stop();

  // After 3+ samples with strong upward slope, trend should be rising
  const risingReport = reports.find((r) => r.trend === "rising");
  assertExists(risingReport);
});

Deno.test("createMemoryMonitor: stop() clears interval", async () => {
  let count = 0;

  const monitor = createMemoryMonitor({
    enabled: true,
    interval: 15,
    warnThreshold: 0.5,
    criticalThreshold: 0.9,
    onReport: () => {
      count++;
    },
    getMemoryUsage: () => ({
      heapUsed: 80,
      heapTotal: 100,
      rss: 120,
      external: 0,
    }),
    getHeapLimit: () => 100,
    getCellStates: () => [],
  });

  await new Promise((r) => setTimeout(r, 60));
  monitor.stop();
  const countAfterStop = count;

  await new Promise((r) => setTimeout(r, 60));
  assertEquals(count, countAfterStop); // no more callbacks after stop
});

// ── three different problems, three different signals ────────────────────────
// The ceiling protects the APP; it says nothing about the MACHINE, and neither
// notices a leak that is still far from any threshold. Ceiling-relative
// thresholds alone report all three as one thing, too late.

/** Drive the monitor deterministically: no timers, no real memory. */
function drive(
  heapSeries: number[],
  opts: {
    heapLimit: number;
    total?: number;
    warn?: number;
    critical?: number;
    machineWarnFraction?: number;
    growthReportRatio?: number;
    trendWindow?: number;
  },
): Array<{ reason: string; level: string; machinePct: number }> {
  const out: Array<{ reason: string; level: string; machinePct: number }> = [];
  let i = 0;
  const timers: Array<() => void> = [];
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).setInterval = (fn: () => void) => {
    timers.push(fn);
    return 1;
  };
  // deno-lint-ignore no-explicit-any
  (globalThis as any).clearInterval = () => {};
  try {
    const m = createMemoryMonitor({
      enabled: true,
      interval: 1,
      warnThreshold: opts.warn ?? 0.75,
      criticalThreshold: opts.critical ?? 0.9,
      trendWindow: opts.trendWindow ?? 4,
      machineWarnFraction: opts.machineWarnFraction,
      growthReportRatio: opts.growthReportRatio,
      onReport: (r) =>
        out.push({
          reason: r.reason,
          level: r.level,
          machinePct: r.machinePct,
        }),
      getMemoryUsage: () => ({
        heapUsed: heapSeries[i]!,
        heapTotal: heapSeries[i]!,
        rss: heapSeries[i]!,
        external: 0,
      }),
      getHeapLimit: () => opts.heapLimit,
      getTotalMemory: () => opts.total ?? 0,
      getCellStates: () => [],
    });
    for (; i < heapSeries.length; i++) timers.forEach((t) => t());
    m.stop();
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
  return out;
}

const GB_ = 1024 * 1024 * 1024;
const MB_ = 1024 * 1024;

Deno.test("monitor: near the ceiling → pressure (the app is about to OOM)", () => {
  const reports = drive([7.6 * GB_, 7.9 * GB_], {
    heapLimit: 8 * GB_,
    total: 32 * GB_,
  });
  assertEquals(reports.map((r) => r.reason), ["pressure", "pressure"]);
  assertEquals(reports[1]!.level, "critical");
});

Deno.test("monitor: a big share of the MACHINE reports, ceiling nowhere near", () => {
  // The desktop-freezing case. On a 47 GB ceiling, 75%-of-ceiling is 35 GB —
  // a 64 GB machine is already swapping long before that fires.
  // 33 GB: 70% of the ceiling (under the pressure threshold, so THAT check
  // stays quiet) but 52% of the machine — which is the problem.
  const reports = drive([33 * GB_], {
    heapLimit: 47 * GB_,
    total: 64 * GB_,
    machineWarnFraction: 0.5,
  });
  assertEquals(reports.length, 1);
  assertEquals(reports[0]!.reason, "machine");
  assertEquals(reports[0]!.machinePct > 0.5, true, "over half the machine");
});

Deno.test("monitor: steady growth reports as a LEAK, long before any threshold", () => {
  // 1 → 9 GB against a 47 GB ceiling: every sample is under 20% of the ceiling
  // and under 20% of the machine, so both other checks stay silent. Reporting
  // this only at 75% turns a slow diagnosis into an emergency.
  const series = [1, 3, 5, 7, 9].map((g) => g * GB_);
  const reports = drive(series, {
    heapLimit: 47 * GB_,
    total: 192 * GB_,
    growthReportRatio: 0.1,
  });
  assertEquals(reports.length >= 1, true, "a steady climb must be reported");
  assertEquals(reports[0]!.reason, "growth");
});

Deno.test("monitor: flat usage says nothing at all", () => {
  // The whole value of a leak signal is that it is quiet when there is no leak.
  const flat = [2 * GB_, 2 * GB_, 2 * GB_, 2 * GB_, 2 * GB_, 2 * GB_];
  assertEquals(drive(flat, { heapLimit: 47 * GB_, total: 192 * GB_ }), []);
});

Deno.test("monitor: an unmeasurable machine disables only the machine check", () => {
  // total = 0 → machinePct 0 → never fires, and nothing throws.
  const reports = drive([20 * GB_], { heapLimit: 47 * GB_, total: 0 });
  assertEquals(reports, []);
});

// ── native (RSS) leaks — the half `heapUsed` cannot see ────────────

/** Drive with SEPARATE heap and RSS series — the only way to express "the heap
 *  is flat while native memory climbs", which is the signature the old
 *  heap-only monitor reported as a healthy app. */
function driveNative(
  heapSeries: number[],
  rssSeries: number[],
  opts: {
    heapLimit: number;
    total?: number;
    trendWindow?: number;
    growthReportRatio?: number;
    gauges?: () => import("../src/diagnostics/memory-ledger.ts").GaugeReading[];
    /** Every full report, for the cases that read more than the summary. */
    full?: MemoryReport[];
    /** Counts the per-report state walk (`getCellStates`). */
    walks?: { n: number };
  },
): Array<
  {
    reason: string;
    nativeLeak: boolean;
    rssGrowth: number;
    tick: number;
    topGrower?: { name: string };
  }
> {
  const out: Array<
    {
      reason: string;
      nativeLeak: boolean;
      rssGrowth: number;
      tick: number;
      topGrower?: { name: string };
    }
  > = [];
  let i = 0;
  const timers: Array<() => void> = [];
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).setInterval = (fn: () => void) => {
    timers.push(fn);
    return 1;
  };
  // deno-lint-ignore no-explicit-any
  (globalThis as any).clearInterval = () => {};
  try {
    createMemoryMonitor({
      enabled: true,
      interval: 1,
      warnThreshold: 0.75,
      criticalThreshold: 0.9,
      trendWindow: opts.trendWindow ?? 4,
      growthReportRatio: opts.growthReportRatio,
      onReport: (r) => {
        opts.full?.push(r);
        out.push({
          reason: r.reason,
          nativeLeak: r.nativeLeak === true,
          rssGrowth: r.native?.rssGrowth ?? 0,
          tick: i,
          ...(r.topGrower ? { topGrower: { name: r.topGrower.name } } : {}),
        });
      },
      getMemoryUsage: () => ({
        heapUsed: heapSeries[i]!,
        heapTotal: heapSeries[i]!,
        rss: rssSeries[i]!,
        external: 0,
      }),
      getHeapLimit: () => opts.heapLimit,
      getTotalMemory: () => opts.total ?? 0,
      getCellStates: () => {
        if (opts.walks) opts.walks.n++;
        return [];
      },
      ...(opts.gauges ? { getGauges: opts.gauges } : {}),
    });
    for (; i < heapSeries.length; i++) timers.forEach((t) => t());
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
  return out;
}

Deno.test("monitor: heap FLAT while RSS climbs → native (the leak that hid)", () => {
  // The real incident: ~10 GB of RSS against a heap that never moved. Every
  // heap-relative check stays silent; only a native window can name it.
  // Two windows of four: one window of climb is a warm-up, two is a leak.
  const heap = [200, 205, 198, 202, 200, 203, 199, 201].map((m) => m * MB_);
  const rss = [1, 2, 4, 8, 12, 16, 20, 24].map((g) => g * GB_);
  const reports = driveNative(heap, rss, {
    heapLimit: 47 * GB_,
    total: 192 * GB_,
  });
  assertEquals(reports.length >= 1, true, "a native climb must be reported");
  assertEquals(reports[0]!.nativeLeak, true, "named as a native leak");
  assertEquals(
    reports[0]!.rssGrowth > 0,
    true,
    "the report says how fast, not just that it happened",
  );
});

Deno.test("monitor: heap rising AND rss rising is `growth`, not relabelled `native`", () => {
  // Both move → the fix is a heap fix; calling it native would send the reader
  // looking in the wrong place.
  const both = [1, 3, 5, 7, 9].map((g) => g * GB_);
  const reports = driveNative(both, both, {
    heapLimit: 47 * GB_,
    total: 192 * GB_,
    growthReportRatio: 0.1,
  });
  assertEquals(reports[0]!.reason, "growth");
});

Deno.test("monitor: RSS steady says nothing — quiet when there is no leak", () => {
  const heap = [200, 200, 200, 200].map((m) => m * 1024 * 1024);
  const rss = [2, 2, 2, 2].map((g) => g * GB_);
  assertEquals(
    driveNative(heap, rss, { heapLimit: 47 * GB_, total: 192 * GB_ }),
    [],
  );
});

Deno.test("monitor: report names the fastest-growing LEVEL series", () => {
  // Two series move; the report must name the faster one — the answer to
  // "which subsystem", which is the whole point of the ledger.
  let tick = 0;
  const heap = Array(8).fill(200 * MB_);
  const rss = [1, 3, 6, 12, 15, 18, 24, 30].map((g) => g * GB_);
  const reports = driveNative(heap, rss, {
    heapLimit: 47 * GB_,
    total: 192 * GB_,
    gauges: () => {
      tick++;
      return [
        {
          name: "broadcast.bufferedBytes",
          owner: "broadcast",
          unit: "bytes",
          kind: "level",
          value: tick * 1024 * 1024,
        },
        {
          name: "sync.opBufferBytes",
          owner: "sync",
          unit: "bytes",
          kind: "level",
          value: tick * 8 * 1024 * 1024,
        },
      ];
    },
  });
  assertEquals(reports.length >= 1, true);
  assertEquals(reports[0]!.topGrower?.name, "sync.opBufferBytes");
});

// ── "flat" is relative to the RSS climb ──────────────────────────────────────
// `detectTrend`'s threshold (0.005) was written for fractions and is fed
// bytes, so a heap gaining ONE BYTE a tick was "rising" — and a rising heap
// switched the native check off. Every live heap drifts upward by more than
// a byte; the check could not fire on a real process.

const ticks = (n: number, at: (t: number) => number) =>
  Array.from({ length: n }, (_, t) => at(t));

for (
  const [label, step] of [
    ["+1 byte/tick", 1],
    ["+64 KB/tick", 64 * 1024],
  ] as const
) {
  Deno.test(`monitor: RSS +1 GB/tick with the heap drifting ${label} is a NATIVE leak`, () => {
    const reports = driveNative(
      ticks(30, (t) => 200 * MB_ + t * step),
      ticks(30, (t) => (1 + t) * GB_),
      { heapLimit: 46 * GB_, total: 186 * GB_, trendWindow: 10 },
    );
    assertEquals(
      reports.map((r) => [r.reason, r.nativeLeak, r.tick]),
      // The second full window, and every one after it.
      [["growth", true, 19], ["growth", true, 29]],
    );
    assertEquals(reports[0]!.rssGrowth, 9 * GB_, "across that window");
  });
}

Deno.test("monitor: heap and RSS rising TOGETHER is never named a native leak", () => {
  // A JS leak drags RSS up with it. Through every window, and through the
  // growth reports that restart them, the heap explains the climb.
  const both = ticks(40, (t) => (1 + t) * GB_);
  const reports = driveNative(both, both.map((b) => b + 300 * MB_), {
    heapLimit: 400 * GB_,
    total: 2000 * GB_,
    trendWindow: 10,
    growthReportRatio: 0.01,
  });
  assertEquals(reports.length >= 2, true, "the heap climb is reported");
  assertEquals(reports.map((r) => r.reason), reports.map(() => "growth"));
  assertEquals(
    reports.filter((r) => r.nativeLeak),
    [],
    "…as a HEAP leak — calling it native sends the reader to the wrong place",
  );
});

Deno.test("monitor: a warm-up is not a leak — one window of climb that stops says nothing", () => {
  // 300 → 630 MB across the first window (over the 256 MB floor), then flat:
  // a page cache filling, a first large buffer.
  const rss = ticks(40, (t) => (t < 12 ? 300 + t * 30 : 640) * MB_);
  assertEquals(
    driveNative(ticks(40, () => 100 * MB_), rss, {
      heapLimit: 16 * GB_,
      total: 64 * GB_,
      trendWindow: 10,
    }),
    [],
  );
});

Deno.test("monitor: a native climb under the absolute floor says nothing", () => {
  // +20 MB a tick is +180 MB a window: steady, real, and under 256 MB — the
  // band a quiet app's RSS wanders in.
  assertEquals(
    driveNative(
      ticks(60, () => 100 * MB_),
      ticks(60, (t) => (300 + t * 20) * MB_),
      { heapLimit: 16 * GB_, total: 640 * GB_, trendWindow: 10 },
    ),
    [],
  );
});

Deno.test("monitor: a native climb under a quarter of where it started says nothing", () => {
  // +50 MB a tick is +450 MB a window — over the floor, but 2% of a process
  // that was already 20 GB.
  assertEquals(
    driveNative(
      ticks(60, () => 100 * MB_),
      ticks(60, (t) => 20 * GB_ + t * 50 * MB_),
      { heapLimit: 16 * GB_, total: 640 * GB_, trendWindow: 10 },
    ),
    [],
  );
});

// ── a steady leak is confirmed; a step is not ────────────────────────────────

Deno.test("monitor: a steady LINEAR native leak is confirmed by its second window", () => {
  // 1 GB, +30 MB a tick, the heap flat: +270 MB a window, for ever. The
  // second window was measured against its OWN first sample (1.3 GB → a
  // 325 MB bar the same +270 MB can never clear), so a leak that adds the
  // same bytes every window was never confirmed and never reported.
  const reports = driveNative(
    ticks(40, () => 200 * MB_),
    ticks(40, (t) => 1 * GB_ + t * 30 * MB_),
    { heapLimit: 4 * GB_, total: 64 * GB_, trendWindow: 10 },
  );
  assertEquals(
    reports.map((r) => [r.reason, r.nativeLeak, r.tick]),
    // Confirmed by the second window, and said again for each one after it.
    [["growth", true, 19], ["growth", true, 29], ["growth", true, 39]],
  );
  assertEquals(reports[0]!.rssGrowth, 270 * MB_);
});

// A sawtooth — native memory that climbs and is given back, over and over —
// is an unbroken run of climbing windows whenever its period lines up with
// the window, and RSS is back at its base after each. It is said while it
// reaches somewhere new, and not again for coming back to where it has been.
for (
  const [label, period, step, want] of [
    ["the window", 10, 40, [19]],
    ["twice the window", 20, 40, [19]],
    ["three windows", 30, 60, [19, 29]],
  ] as const
) {
  Deno.test(`monitor: a native sawtooth with a period of ${label} is not reported every window`, () => {
    const reports = driveNative(
      ticks(2000, () => 200 * MB_),
      ticks(2000, (t) => 1 * GB_ + (t % period) * step * MB_),
      { heapLimit: 4 * GB_, total: 640 * GB_, trendWindow: 10 },
    );
    assertEquals(reports.map((r) => r.tick), [...want]);
  });
}

Deno.test("monitor: a linear native leak is still said once per window, however long it runs", () => {
  // Just over the floor (+261 MB a window), and one that starts after RSS fell.
  const slow = driveNative(
    ticks(400, () => 200 * MB_),
    ticks(400, (t) => 1 * GB_ + t * 29 * MB_),
    { heapLimit: 4 * GB_, total: 640 * GB_, trendWindow: 10 },
  );
  assertEquals(slow.map((r) => r.tick), ticks(39, (n) => 19 + n * 10));
  assertEquals(slow.every((r) => r.nativeLeak), true);
  const afterFall = driveNative(
    ticks(200, () => 200 * MB_),
    ticks(200, (t) => t < 20 ? 3 * GB_ : 1 * GB_ + (t - 20) * 30 * MB_),
    { heapLimit: 4 * GB_, total: 640 * GB_, trendWindow: 10 },
  );
  assertEquals(afterFall.map((r) => r.tick), ticks(17, (n) => 39 + n * 10));
});

Deno.test("monitor: a leak that follows, or hides under, a sawtooth is still said", () => {
  // 1000 ticks of sawtooth, then +30 MB a tick: said from the first window
  // that stands a bar above the sawtooth's peak, and every window after.
  const after = driveNative(
    ticks(1200, () => 200 * MB_),
    ticks(
      1200,
      (t) => 1 * GB_ + (t < 1000 ? (t % 10) * 40 : (t - 1000) * 30) * MB_,
    ),
    { heapLimit: 4 * GB_, total: 640 * GB_, trendWindow: 10 },
  );
  assertEquals(
    after.map((r) => r.tick),
    [19, ...ticks(18, (n) => 1029 + n * 10)],
  );
  // The same sawtooth on a +5 MB a tick leak: said at every 256 MB it gains.
  const under = driveNative(
    ticks(400, () => 200 * MB_),
    ticks(400, (t) => 1 * GB_ + ((t % 10) * 40 + t * 5) * MB_),
    { heapLimit: 4 * GB_, total: 640 * GB_, trendWindow: 10 },
  );
  assertEquals(under.map((r) => r.tick), [19, 79, 139, 199, 259, 319, 379]);
  // A leak that stopped for a window and came back is a new run.
  const again = driveNative(
    ticks(400, () => 200 * MB_),
    ticks(
      400,
      (t) =>
        1 * GB_ +
        (t < 100 ? t * 30 : t < 200 ? 0 : (t - 200) * 30) * MB_,
    ),
    { heapLimit: 4 * GB_, total: 640 * GB_, trendWindow: 10 },
  );
  assertEquals(again.map((r) => r.tick), [
    ...ticks(9, (n) => 19 + n * 10),
    ...ticks(19, (n) => 219 + n * 10),
  ]);
});

Deno.test("monitor: a one-off STEP up in RSS is not a leak", () => {
  // A cache loaded once: +2 GB inside one window, then nothing.
  const rss = ticks(60, (t) => 1 * GB_ + Math.min(t, 8) * 256 * MB_);
  assertEquals(
    driveNative(ticks(60, () => 200 * MB_), rss, {
      heapLimit: 4 * GB_,
      total: 64 * GB_,
      trendWindow: 10,
    }),
    [],
  );
});

// What makes two climbing windows ONE leak is not that they touch: it is that
// the gain of the first is still there when the second comes. A leak that
// grows in bursts, flat in between, was never confirmed while the windows had
// to be back to back.
const nativeTicks = (rss: number[]) =>
  driveNative(ticks(rss.length, () => 200 * MB_), rss, {
    heapLimit: 4 * GB_,
    total: 640 * GB_,
    trendWindow: 10,
  }).map((r) => r.tick);

Deno.test("monitor: climb, a flat window that KEEPS the gain, climb — one leak, confirmed by the second climb", () => {
  assertEquals(
    nativeTicks(ticks(
      30,
      (t) =>
        (t < 10 ? 1000 + t * 40 : t < 20 ? 1360 : 1360 + (t - 20) * 60) * MB_,
    )),
    [25],
  );
});

Deno.test("monitor: climb, the gain GIVEN BACK, climb — two warm-ups, nothing said", () => {
  assertEquals(
    nativeTicks(ticks(
      40,
      (t) => (1000 + (t < 10 || (t >= 20 && t < 30) ? (t % 10) * 40 : 0)) * MB_,
    )),
    [],
  );
});

// "Keeps the gain": the quiet window still stands a bar (256 MB from a 1 GB
// start) above where the run began — exactly on it counts.
for (
  const [label, short, want] of [["a bar", 0, [25]], [
    "one byte under a bar",
    1,
    [],
  ]] as const
) {
  Deno.test(`monitor: climb, a flat window ${label} above the start, climb`, () => {
    assertEquals(
      nativeTicks(ticks(
        30,
        (t) =>
          t < 10
            ? (1024 + t * 40) * MB_
            : t < 20
            ? (1024 + 256) * MB_ - short
            : (1024 + 256 + (t - 20) * 60) * MB_,
      )),
      [...want],
    );
  });
}

Deno.test("monitor: a leak after an earlier run that ended is confirmed by its own second window", () => {
  // A step whose gain is kept for 195 samples and then given back; a steady
  // leak later. How long the first run sat still says nothing about the second.
  assertEquals(
    nativeTicks(ticks(
      260,
      (t) =>
        t < 5
          ? 1 * GB_
          : t < 200
          ? 2 * GB_
          : t < 220
          ? 1 * GB_
          : 1 * GB_ + (t - 220) * 30 * MB_,
    )),
    [239, 249, 259],
  );
});

Deno.test("monitor: a staircase — bursts shorter than a window, minutes apart — is a native leak", () => {
  // +300 MB in 3 samples every 60: said at the second burst, and at each one
  // after it.
  const burst = (t: number) =>
    Math.floor(t / 60) * 300 + Math.min(t % 60, 3) * 100;
  assertEquals(
    nativeTicks(ticks(360, (t) => 1 * GB_ + burst(t) * MB_)),
    [63, 123, 183, 243, 303],
  );
});

// Two steps far apart are two warm-ups (a second cache, loaded hours later);
// a third is a pattern. "Far" is more than ten windows between them.
for (
  const [label, second, third, want] of [
    ["100 samples after the first: near", 110, 9999, [110]],
    ["101 samples after it: far, so nothing yet", 111, 9999, []],
    ["far apart, and a third step", 300, 600, [600]],
  ] as const
) {
  Deno.test(`monitor: two steps up in RSS, the second ${label}`, () => {
    // The first step is confirmed as a climbing window at sample 9.
    assertEquals(
      nativeTicks(ticks(
        700,
        (t) =>
          (1 + (t >= 5 ? 1 : 0) + (t >= second ? 1 : 0) +
            (t >= third ? 1 : 0)) * GB_,
      )),
      [...want],
    );
  });
}

// Said again only once RSS stands a bar (256 MB from a 1 GB start) above where
// it was last said — exactly on the bar counts.
for (
  const [label, short, want] of [["on", 0, [25, 45]], ["one byte under", 1, [
    25,
  ]]] as const
) {
  Deno.test(`monitor: a native climb that ends ${label} the bar above the last report`, () => {
    // Said at 3 GB (sample 25); a dip that keeps the run, then a climb of
    // 356 MB to 3 GB + 256 MB.
    assertEquals(
      nativeTicks(ticks(
        60,
        (t) =>
          t < 5
            ? 1 * GB_
            : t < 25
            ? 2 * GB_
            : t < 35
            ? 3 * GB_
            : t < 45
            ? 3 * GB_ - 100 * MB_
            : 3 * GB_ + 256 * MB_ - short,
      )),
      [...want],
    );
  });
}

Deno.test("monitor: the FIRST native window says nothing — not even as a heap `growth` report", () => {
  // The heap gains 160 MB of a 1 GB ceiling (over the 15% growth bar) while
  // RSS gains 9 GB: by subtraction a native climb, so it waits for its
  // second window instead of being reported as a heap leak after one.
  const reports = driveNative(
    ticks(10, (t) => (100 + t * 18) * MB_),
    ticks(10, (t) => (1 + t) * GB_),
    { heapLimit: 1 * GB_, total: 640 * GB_, trendWindow: 10 },
  );
  assertEquals(reports, []);
});

// ── `machine` is about RSS, and is said once ─────────────────────────────────

Deno.test("monitor: a steady app on a small machine is reported ONCE, not every interval", () => {
  // 280 MB of RSS on a 512 MB host: over half the machine for as long as the
  // app runs. It was reported every 10 s, forever — a state walk and the
  // app's hook each time, about nothing new.
  const walks = { n: 0 };
  const full: MemoryReport[] = [];
  const reports = driveNative(
    ticks(50, () => 40 * MB_),
    ticks(50, () => 280 * MB_),
    { heapLimit: 4096 * MB_, total: 512 * MB_, full, walks },
  );
  assertEquals(reports.map((r) => [r.reason, r.tick]), [["machine", 0]]);
  assertEquals(walks.n, 1, "one report, one state walk");
  // `machinePct` is RSS over RAM — the heap (40 MB) is 8% of this machine.
  assertEquals(full[0]!.machinePct, 280 / 512);
  // 40 MB of heap inside 280 MB of RSS is what an idle process looks like —
  // a share of the machine, not a leak. The text still carries both numbers.
  assertEquals(full[0]!.nativeLeak, undefined);
  assertEquals(
    describeMemoryReport(full[0]!),
    "RSS 294 MB is 55% of this machine's memory (JS heap 42 MB)",
  );
});

Deno.test("monitor: pressure and machine together — the machine condition is still said once pressure is gone", () => {
  // Tick 0 is over the heap threshold AND over half the machine: it reports
  // as `pressure`, and the machine condition has not been said. When the
  // heap falls back it still has to be.
  const reports = driveNative(
    [3500, 400, 400, 400].map((m) => m * MB_),
    ticks(4, () => 3600 * MB_),
    { heapLimit: 4096 * MB_, total: 6000 * MB_, trendWindow: 100 },
  );
  assertEquals(
    reports.map((r) => [r.reason, r.tick]),
    [["pressure", 0], ["machine", 1]],
  );
});

Deno.test("monitor: a machine condition that gets WORSE speaks again, a tenth of RAM at a time", () => {
  const total = 1000 * MB_;
  // 520 → 610 MB in 10 MB steps, then steady.
  const rss = ticks(30, (t) => (520 + Math.min(t, 9) * 10) * MB_);
  const reports = driveNative(ticks(30, () => 400 * MB_), rss, {
    heapLimit: 4096 * MB_,
    total,
    trendWindow: 100,
  });
  // 520 MB (first), then 620 would be the next tenth — 610 never gets there.
  assertEquals(reports.map((r) => [r.reason, r.tick]), [["machine", 0]]);

  const worse = driveNative(
    ticks(30, () => 400 * MB_),
    ticks(30, (t) => (520 + t * 10) * MB_),
    { heapLimit: 4096 * MB_, total, trendWindow: 100 },
  );
  assertEquals(
    worse.map((r) => [r.reason, r.tick]),
    [["machine", 0], ["machine", 10], ["machine", 20]],
  );
  // The heap holds most of it (400 of 520+ MB): not a native problem.
  assertEquals(worse.map((r) => r.nativeLeak), [false, false, false]);
});

Deno.test("monitor: a machine condition that went away and came back is said again", () => {
  const rss = [600, 600, 390, 600, 600, 490, 600].map((m) => m * MB_);
  const reports = driveNative(rss.map(() => 400 * MB_), rss, {
    heapLimit: 4096 * MB_,
    total: 1000 * MB_,
    trendWindow: 100,
  });
  // Re-armed by 390 (a tenth below the threshold) — not by 490, which is
  // the same condition wobbling around its edge.
  assertEquals(reports.map((r) => r.tick), [0, 3]);
});

// ── `pressure` below critical is SAID once too ──────────────────────────────
//
// The same rule, on the heap: an app that sits at 80% of its ceiling logged
// the same error every interval for as long as it ran. Only what is said
// changes: the report is still made each interval, because the app's
// `onMemoryPressure` is how memory gets shed. `critical` is said every time.

/** One monitor over `heap` (MB of a 1000 MB ceiling): per report, its tick,
 *  level, and whether it is `said`. */
function driveSaid(
  heap: number[],
  /** RSS per tick in MB (default: the heap) and the machine's RAM. */
  rss: number[] = heap,
  total = 64 * GB_,
): [tick: number, level: string, said: boolean][] {
  const out: [number, string, boolean][] = [];
  let i = 0;
  const timers: Array<() => void> = [];
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).setInterval = (fn: () => void) => {
    timers.push(fn);
    return 1;
  };
  // deno-lint-ignore no-explicit-any
  (globalThis as any).clearInterval = () => {};
  try {
    createMemoryMonitor({
      enabled: true,
      interval: 1,
      warnThreshold: 0.75,
      criticalThreshold: 0.9,
      trendWindow: 100,
      onReport: (r, said) => {
        assertEquals(r.reason, "pressure");
        out.push([i, r.level, said]);
      },
      getMemoryUsage: () => ({
        heapUsed: heap[i]! * MB_,
        heapTotal: heap[i]! * MB_,
        rss: rss[i]! * MB_,
        external: 0,
      }),
      getHeapLimit: () => 1000 * MB_,
      getTotalMemory: () => total,
      getCellStates: () => [],
    });
    for (; i < heap.length; i++) timers.forEach((t) => t());
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
  return out;
}
const saidAt = (heap: number[]) =>
  driveSaid(heap).filter((r) => r[2]).map((r) => r[0]);

Deno.test("monitor: half the machine reached DURING quiet pressure is said — once", () => {
  // The heap sits at 800 MB (said at tick 0). At tick 10 RSS passes half of
  // a 2 GB machine: the report is still `pressure`, and it must be said —
  // quiet pressure silences its own repeat, not other news.
  const reports = driveSaid(
    ticks(30, () => 800),
    ticks(30, (t) => (t < 10 ? 800 : 1200)),
    2000 * MB_,
  );
  assertEquals(reports.length, 30);
  assertEquals(reports.filter((r) => r[2]).map((r) => r[0]), [0, 10]);
});

Deno.test("monitor: a steady heap over the warn threshold is SAID once — and reported to the hook every interval", () => {
  const reports = driveSaid(ticks(50, () => 800));
  assertEquals(reports.length, 50, "the hook's turn, every interval");
  assertEquals(reports.filter((r) => r[2]).map((r) => r[0]), [0]);
});

Deno.test("monitor: pressure that gets WORSE is said again, a tenth of the ceiling at a time — and at critical", () => {
  // 760 → 890 MB in 10 MB steps, then steady: said at 760 and at 860.
  assertEquals(saidAt(ticks(30, (t) => 760 + Math.min(t, 13) * 10)), [0, 10]);
  // …and 900 MB is `critical`, whatever was said a tick before.
  assertEquals(
    driveSaid([760, 890, 900]),
    [[0, "warn", true], [1, "warn", true], [2, "critical", true]],
  );
});

Deno.test("monitor: critical pressure is said EVERY interval — and falling back under it is not news", () => {
  assertEquals(
    driveSaid([950, 950, 950, 800, 800, 950]).map((r) => [r[1], r[2]]),
    [
      ["critical", true],
      ["critical", true],
      ["critical", true],
      ["warn", false],
      ["warn", false],
      ["critical", true],
    ],
  );
});

Deno.test("monitor: pressure that went away and came back is said again", () => {
  // Re-armed by 640 (a tenth of the ceiling under the threshold) — not by
  // 740, which is the same condition wobbling around its edge.
  assertEquals(saidAt([800, 800, 640, 800, 800, 740, 800]), [0, 3]);
});

Deno.test("report text: each reason names the number that fired it", () => {
  const base: MemoryReport = {
    level: "warn",
    heapUsed: 40e6,
    heapTotal: 60e6,
    heapLimit: 4000e6,
    heapPct: 0.01,
    gcReclaimed: 0,
    gcReclaimedPct: 0,
    cellStates: [],
    trend: "stable",
    reason: "machine",
    machinePct: 0.547,
    native: { rss: 280e6, external: 0, rssGrowth: 0 },
  };
  // It printed "heap at 1% (40 MB / 4000 MB)" — for a report about RSS.
  assertEquals(
    describeMemoryReport(base),
    "RSS 280 MB is 55% of this machine's memory (JS heap 40 MB)",
  );
  assertEquals(
    describeMemoryReport({ ...base, heapUsed: 200e6 }),
    "RSS 280 MB is 55% of this machine's memory (JS heap 200 MB)",
  );
  assertEquals(
    describeMemoryReport({
      ...base,
      reason: "growth",
      nativeLeak: true,
      native: { rss: 9216e6, external: 0, rssGrowth: 3072e6 },
      heapUsed: 200e6,
    }),
    "native memory rising — RSS 9216 MB (+3072 MB this window) while the " +
      "JS heap stayed flat at 200 MB",
  );
  assertEquals(
    describeMemoryReport({ ...base, reason: "pressure", heapPct: 0.8 }),
    "heap at 80% (40 MB / 4000 MB)",
  );
  assertEquals(
    describeMemoryReport({ ...base, reason: "growth", heapPct: 0.004 }),
    "heap at 0.40% (40 MB / 4000 MB)",
  );
});
