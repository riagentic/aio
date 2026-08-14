import { assertEquals } from "@std/assert";
import { createPressureMonitor } from "../../src/vitals/pressure-monitor.ts";
import type { DiagEvent } from "../../src/vitals/types.ts";

Deno.test("pressure: payload over threshold emits pressure event", () => {
  const events: DiagEvent[] = [];
  const pm = createPressureMonitor({
    payloadThreshold: 100,
    rateThreshold: 30,
    onDiagnostic: (e) => events.push(e),
  });
  pm.onBroadcast("client-1", 150);
  assertEquals(events.length, 1);
  assertEquals(events[0]!.kind, "pressure");
  assertEquals(events[0]!.detail.payloadBytes, 150);
  assertEquals(events[0]!.detail.trigger, "client-1");
  assertEquals(events[0]!.severity, "possible");
  pm.destroy();
});

Deno.test("pressure: payload under threshold emits nothing", () => {
  const events: DiagEvent[] = [];
  const pm = createPressureMonitor({
    payloadThreshold: 100,
    rateThreshold: 30,
    onDiagnostic: (e) => events.push(e),
  });
  pm.onBroadcast("client-1", 50);
  assertEquals(events.length, 0);
  pm.destroy();
});

Deno.test("pressure: rate over threshold emits pressure event", async () => {
  const events: DiagEvent[] = [];
  const pm = createPressureMonitor({
    payloadThreshold: 512_000,
    rateThreshold: 5,
    onDiagnostic: (e) => events.push(e),
  });
  // The rate counts broadcast ROUNDS (dispatch frequency), not per-client
  // sends — 10 rounds to one client, same as 10 rounds to fifty clients.
  for (let i = 0; i < 10; i++) {
    pm.onBroadcastRound();
    pm.onBroadcast("c1", 100);
  }
  await new Promise((r) => setTimeout(r, 1100));
  const rateEvents = events.filter((e) => e.summary.includes("broadcasts/sec"));
  assertEquals(rateEvents.length, 1);
  assertEquals(rateEvents[0]!.kind, "pressure");
  assertEquals(rateEvents[0]!.severity, "possible");
  pm.destroy();
});

Deno.test("pressure: many clients in ONE round is not a rate", async () => {
  const events: DiagEvent[] = [];
  const pm = createPressureMonitor({
    payloadThreshold: 512_000,
    rateThreshold: 5,
    onDiagnostic: (e) => events.push(e),
  });
  // One dispatch, fifteen sockets — the old per-send counting read this as
  // 15 "broadcasts/sec" and blamed dispatch frequency.
  pm.onBroadcastRound();
  for (let i = 0; i < 15; i++) pm.onBroadcast(`client-${i}`, 100);
  await new Promise((r) => setTimeout(r, 1100));
  assertEquals(
    events.filter((e) => e.summary.includes("broadcasts/sec")).length,
    0,
  );
  pm.destroy();
});

Deno.test("pressure: rate under threshold emits nothing", async () => {
  const events: DiagEvent[] = [];
  const pm = createPressureMonitor({
    payloadThreshold: 512_000,
    rateThreshold: 50,
    onDiagnostic: (e) => events.push(e),
  });
  pm.onBroadcast("c1", 100);
  pm.onBroadcast("c1", 100);
  await new Promise((r) => setTimeout(r, 1100));
  const rateEvents = events.filter((e) => e.summary.includes("broadcasts/sec"));
  assertEquals(rateEvents.length, 0);
  pm.destroy();
});

Deno.test("pressure: console throttling suppresses repeated warnings", () => {
  const events: DiagEvent[] = [];
  const consoleLogs: string[][] = [];
  const pm = createPressureMonitor({
    payloadThreshold: 100,
    rateThreshold: 30,
    onDiagnostic: (e) => events.push(e),
    onConsole: (lines) => consoleLogs.push(lines),
  });
  pm.onBroadcast("c1", 200);
  pm.onBroadcast("c1", 200);
  pm.onBroadcast("c1", 200);
  assertEquals(events.length, 3);
  assertEquals(consoleLogs.length, 1);
  pm.destroy();
});

Deno.test("pressure: destroy clears rate timer", async () => {
  const events: DiagEvent[] = [];
  const pm = createPressureMonitor({
    payloadThreshold: 512_000,
    rateThreshold: 2,
    onDiagnostic: (e) => events.push(e),
  });
  for (let i = 0; i < 10; i++) pm.onBroadcast("c1", 100);
  pm.destroy();
  await new Promise((r) => setTimeout(r, 1100));
  const rateEvents = events.filter((e) => e.summary.includes("broadcasts/sec"));
  assertEquals(rateEvents.length, 0);
});

Deno.test("pressure: custom thresholds override defaults", () => {
  const events: DiagEvent[] = [];
  const pm = createPressureMonitor({
    payloadThreshold: 1_000_000,
    rateThreshold: 100,
    onDiagnostic: (e) => events.push(e),
  });
  pm.onBroadcast("c1", 512_000);
  assertEquals(events.length, 0);
  pm.onBroadcast("c1", 1_100_000);
  assertEquals(events.length, 1);
  pm.destroy();
});

Deno.test("pressure: bandwidth over threshold emits pressure event", async () => {
  const events: DiagEvent[] = [];
  const pm = createPressureMonitor({
    payloadThreshold: 10_000_000, // high to avoid payload events
    rateThreshold: 1000,
    bandwidthThreshold: 1000, // 1KB/s for easy testing
    onDiagnostic: (e) => events.push(e),
  });
  pm.onBroadcast("c1", 500); // first call sets startedAt, no check
  await new Promise((r) => setTimeout(r, 1010)); // wait >1s
  pm.onBroadcast("c1", 2000); // totalBytes=2500, elapsed~1s → ~2500 B/s > 1000
  const bwEvents = events.filter((e) => e.summary.includes("MB/s"));
  assertEquals(bwEvents.length, 1);
  assertEquals(bwEvents[0]!.kind, "pressure");
  assertEquals(bwEvents[0]!.severity, "likely");
  assertEquals(typeof bwEvents[0]!.detail.bytesPerSec, "number");
  assertEquals(bwEvents[0]!.detail.trigger, "c1");
  pm.destroy();
});

Deno.test("pressure: bandwidth under threshold emits nothing", async () => {
  const events: DiagEvent[] = [];
  const pm = createPressureMonitor({
    payloadThreshold: 10_000_000,
    rateThreshold: 1000,
    bandwidthThreshold: 100_000, // 100KB/s
    onDiagnostic: (e) => events.push(e),
  });
  pm.onBroadcast("c1", 10);
  await new Promise((r) => setTimeout(r, 1010));
  pm.onBroadcast("c1", 10); // ~20 B/s, well under 100KB/s
  const bwEvents = events.filter((e) => e.summary.includes("MB/s"));
  assertEquals(bwEvents.length, 0);
  pm.destroy();
});

Deno.test("pressure: getBytesPerSec returns current window average", async () => {
  const pm = createPressureMonitor({
    bandwidthThreshold: 10_000_000, // high to avoid events
    onDiagnostic: () => {},
  });
  pm.onBroadcast("c1", 5000);
  await new Promise((r) => setTimeout(r, 50));
  pm.onBroadcast("c1", 5000); // 10000 bytes in ~50ms
  const bps = pm.getBytesPerSec("c1");
  // Current window rate (AIO-271: window resets after bandwidth check)
  // Should be high since we're in the middle of a window
  assertEquals(bps > 0, true, `expected >0, got ${bps}`);
  assertEquals(pm.getBytesPerSec("unknown"), 0);
  pm.destroy();
});

Deno.test("pressure: onClientDisconnect cleans up bandwidth tracking", () => {
  const pm = createPressureMonitor({
    bandwidthThreshold: 10_000_000,
    onDiagnostic: () => {},
  });
  pm.onBroadcast("c1", 1000);
  assertEquals(pm.getBytesPerSec("c1") >= 0, true);
  pm.onClientDisconnect("c1");
  assertEquals(pm.getBytesPerSec("c1"), 0);
  pm.destroy();
});
