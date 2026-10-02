// A memory report's fix hint matches the report.
//
// Three different reports travel under MEMORY_PRESSURE — the heap, a native
// climb, a share of the machine — and all three were followed by the heap's
// advice: "native memory rising … the JS heap stayed flat" then "Heap usage
// rising. Check per-cell state sizes".
import { assertEquals, assertStringIncludes } from "@std/assert";
import { createAioError, generateTip } from "../src/diagnostics/error.ts";
import {
  describeMemoryReport,
  type MemoryReport,
} from "../src/diagnostics/memory-monitor.ts";

const MB = 1e6;
const base: MemoryReport = {
  reason: "pressure",
  machinePct: 0.1,
  level: "warn",
  heapUsed: 40 * MB,
  heapTotal: 60 * MB,
  heapLimit: 100 * MB,
  heapPct: 0.8,
  gcReclaimed: 0,
  gcReclaimedPct: 0,
  cellStates: [],
  trend: "rising",
  native: { rss: 280 * MB, external: 0, rssGrowth: 300 * MB },
  gauges: [],
};
// What the bridge reports: the report's own line, then the fastest series.
const tip = (r: MemoryReport) =>
  generateTip(
    createAioError(
      "MEMORY_PRESSURE",
      describeMemoryReport(r) + "; fastest series: x (y) +1 MB",
      {},
    ),
  ) ?? "";

Deno.test("memory tip: a heap report is told to look at cell state", () => {
  assertStringIncludes(tip(base), "Heap usage rising");
  assertStringIncludes(tip({ ...base, reason: "growth" }), "Heap usage rising");
});

Deno.test("memory tip: a native leak is NOT told its heap is rising", () => {
  const t = tip({ ...base, reason: "growth", nativeLeak: true });
  assertEquals(t.includes("Heap usage rising"), false, t);
  assertStringIncludes(t, "The JS heap is flat");
  assertStringIncludes(t, "am heap");
});

// The fastest series is appended only when a watched series rose; a native
// climb outside every one of them has none, and the tip must not point at
// words that are not in the message.
Deno.test("memory tip: a native leak with no series named does not say the message names one", () => {
  const message = describeMemoryReport({
    ...base,
    reason: "growth",
    nativeLeak: true,
  });
  assertEquals(message.includes("fastest series"), false, message);
  const t = generateTip(createAioError("MEMORY_PRESSURE", message, {})) ?? "";
  assertStringIncludes(t, "The JS heap is flat");
  assertStringIncludes(t, "If the message names a fastest series");
  assertEquals(t.includes("The message names"), false, t);
  assertStringIncludes(t, "`am heap` lists every one");
});

Deno.test("memory tip: a share-of-the-machine report names the setting, not the heap", () => {
  const t = tip({ ...base, reason: "machine", machinePct: 0.55 });
  assertEquals(t.includes("Heap usage rising"), false, t);
  assertStringIncludes(t, "memory.machineWarnFraction");
});
