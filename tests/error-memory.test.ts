import { assertEquals } from "@std/assert";
import {
  createMemoryMonitor,
  type MemoryReport,
  sizeof,
} from "../src/memory-monitor.ts";

Deno.test("sizeof — strings counted as length * 2", () => {
  assertEquals(sizeof("hello"), 10);
});

Deno.test("sizeof — numbers are 8 bytes", () => {
  assertEquals(sizeof(42), 8);
});

Deno.test("sizeof — handles circular refs", () => {
  const obj: Record<string, unknown> = { a: 1 };
  obj.self = obj;
  const size = sizeof(obj);
  assertEquals(typeof size, "number");
  assertEquals(size > 0, true);
});

Deno.test("sizeof — ArrayBuffer reports byteLength", () => {
  assertEquals(sizeof(new ArrayBuffer(1024)), 1024);
});

Deno.test("memory monitor — no report when heap below threshold", async () => {
  const reports: MemoryReport[] = [];
  const monitor = createMemoryMonitor({
    enabled: true,
    interval: 50,
    warnThreshold: 0.75,
    criticalThreshold: 0.90,
    onReport: (r) => reports.push(r),
    getMemoryUsage: () => ({
      heapUsed: 100,
      heapTotal: 1000,
      rss: 1200,
      external: 0,
    }),
    getHeapLimit: () => 1000,
    getCellStates: () => [],
  });
  await new Promise((r) => setTimeout(r, 120));
  monitor.stop();
  assertEquals(reports.length, 0);
});

Deno.test("memory monitor — MEMORY_PRESSURE when heap >= warn threshold", async () => {
  const reports: MemoryReport[] = [];
  const monitor = createMemoryMonitor({
    enabled: true,
    interval: 50,
    warnThreshold: 0.75,
    criticalThreshold: 0.90,
    onReport: (r) => reports.push(r),
    getMemoryUsage: () => ({
      heapUsed: 800,
      heapTotal: 1000,
      rss: 1200,
      external: 0,
    }),
    getHeapLimit: () => 1000,
    getCellStates: () => [{ name: "test", state: { items: new Array(1000) } }],
  });
  await new Promise((r) => setTimeout(r, 120));
  monitor.stop();
  assertEquals(reports.length > 0, true);
  assertEquals(reports[0]!.level, "warn");
});

Deno.test("memory monitor — MEMORY_CRITICAL when heap >= critical threshold", async () => {
  const reports: MemoryReport[] = [];
  const monitor = createMemoryMonitor({
    enabled: true,
    interval: 50,
    warnThreshold: 0.75,
    criticalThreshold: 0.90,
    onReport: (r) => reports.push(r),
    getMemoryUsage: () => ({
      heapUsed: 950,
      heapTotal: 1000,
      rss: 1200,
      external: 0,
    }),
    getHeapLimit: () => 1000,
    getCellStates: () => [],
  });
  await new Promise((r) => setTimeout(r, 120));
  monitor.stop();
  assertEquals(reports[0]!.level, "critical");
});

Deno.test("memory monitor — cellStates sorted largest first", async () => {
  const reports: MemoryReport[] = [];
  const monitor = createMemoryMonitor({
    enabled: true,
    interval: 50,
    warnThreshold: 0.75,
    criticalThreshold: 0.90,
    onReport: (r) => reports.push(r),
    getMemoryUsage: () => ({
      heapUsed: 800,
      heapTotal: 1000,
      rss: 1200,
      external: 0,
    }),
    getHeapLimit: () => 1000,
    getCellStates: () => [
      { name: "small", state: { x: 1 } },
      { name: "big", state: { items: new Array(10000).fill("data") } },
    ],
  });
  await new Promise((r) => setTimeout(r, 120));
  monitor.stop();
  assertEquals(reports[0]!.cellStates[0]!.name, "big");
});

Deno.test("memory monitor — stop clears interval", async () => {
  const monitor = createMemoryMonitor({
    enabled: true,
    interval: 50,
    warnThreshold: 0.75,
    criticalThreshold: 0.90,
    onReport: () => {},
    getMemoryUsage: () => ({
      heapUsed: 100,
      heapTotal: 1000,
      rss: 1200,
      external: 0,
    }),
    getHeapLimit: () => 1000,
    getCellStates: () => [],
  });
  monitor.stop();
  await new Promise((r) => setTimeout(r, 100));
});

Deno.test("memory monitor — disabled does nothing", async () => {
  const reports: MemoryReport[] = [];
  const monitor = createMemoryMonitor({
    enabled: false,
    interval: 50,
    warnThreshold: 0.75,
    criticalThreshold: 0.90,
    onReport: (r) => reports.push(r),
    getMemoryUsage: () => ({
      heapUsed: 950,
      heapTotal: 1000,
      rss: 1200,
      external: 0,
    }),
    getHeapLimit: () => 1000,
    getCellStates: () => [],
  });
  await new Promise((r) => setTimeout(r, 120));
  monitor.stop();
  assertEquals(reports.length, 0);
});
