import { assertEquals, assertExists } from "@std/assert";
import {
  createMemoryMonitor,
  detectTrend,
  measureFeatureState,
  sizeof,
} from "../src/memory-monitor.ts";

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

// ── measureFeatureState ────────────────────────────────────────────

Deno.test("measureFeatureState: simple state returns name and bytes", () => {
  const result = measureFeatureState("counter", { count: 0 });
  assertEquals(result.name, "counter");
  // key "count" = 10, value 0 = 8 => 18
  assertEquals(result.bytes, 18);
});

Deno.test("measureFeatureState: finds largest field", () => {
  const state = { small: 1, big: "a]long string here!!" };
  const result = measureFeatureState("test", state);
  assertExists(result.largestField);
  assertEquals(result.largestField!.key, "big");
});

Deno.test("measureFeatureState: counts array entries on largest field", () => {
  const state = { items: [1, 2, 3, 4, 5], flag: true };
  const result = measureFeatureState("list", state);
  assertExists(result.largestField);
  assertEquals(result.largestField!.key, "items");
  assertEquals(result.largestField!.entries, 5);
});

Deno.test("measureFeatureState: counts object entries on largest field", () => {
  const state = { meta: { a: 1, b: 2, c: 3 }, x: 1 };
  const result = measureFeatureState("obj", state);
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
    getFeatureStates: () => [],
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
    getFeatureStates: () => [{ name: "f1", state: { x: 1 } }],
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
    getFeatureStates: () => [],
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
    getFeatureStates: () => [],
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
    getFeatureStates: () => [],
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
    getFeatureStates: () => [],
  });

  await new Promise((r) => setTimeout(r, 60));
  monitor.stop();
  const countAfterStop = count;

  await new Promise((r) => setTimeout(r, 60));
  assertEquals(count, countAfterStop); // no more callbacks after stop
});
