import { assertEquals } from "@std/assert";
import { createRenderProbe } from "../../src/vitals/render-probe.ts";
import { DEFAULT_THRESHOLDS } from "../../src/vitals/types.ts";

const baseConfig = () => ({
  thresholds: DEFAULT_THRESHOLDS,
  interval: 1000,
  manualTick: true,
});

Deno.test("render-probe: initial status is healthy", () => {
  const probe = createRenderProbe(baseConfig());
  assertEquals(probe.getStatus(), "healthy");
  probe.destroy();
});

Deno.test("render-probe: records last action", () => {
  const probe = createRenderProbe(baseConfig());
  probe.recordAction("click", "ui");
  assertEquals(probe.getLastAction(), "click");
  assertEquals(probe.getLastFeature(), "ui");
  probe.destroy();
});

Deno.test("render-probe: detect simulated freeze via manual tick (3000ms → frozen)", () => {
  let reportSeen: unknown = null;
  const probe = createRenderProbe({
    ...baseConfig(),
    onStatusChange: (_s, r) => {
      reportSeen = r;
    },
  });

  const report = probe.tick(3000);

  assertEquals(probe.getStatus(), "frozen");
  assertEquals(report !== null, true);
  assertEquals(report!.frozenFor, 3000);
  assertEquals(reportSeen !== null, true);
  probe.destroy();
});

Deno.test("render-probe: no freeze within threshold (49ms → healthy)", () => {
  const probe = createRenderProbe(baseConfig());
  const report = probe.tick(49);
  assertEquals(probe.getStatus(), "healthy");
  assertEquals(report, null);
  probe.destroy();
});

Deno.test("render-probe: degraded status (80ms > degraded threshold 50ms)", () => {
  const probe = createRenderProbe(baseConfig());
  const report = probe.tick(80);
  assertEquals(probe.getStatus(), "degraded");
  assertEquals(report, null);
  assertEquals(probe.getFirstDegradedAt() !== null, true);
  probe.destroy();
});

Deno.test("render-probe: recovery increments freeze count", () => {
  const probe = createRenderProbe(baseConfig());

  // Freeze
  probe.tick(3000);
  assertEquals(probe.getStatus(), "frozen");

  // Recover
  probe.tick(10);
  assertEquals(probe.getStatus(), "recovered");
  assertEquals(probe.getPreviousFreezeCount(), 1);

  // Back to healthy on next good tick
  probe.tick(10);
  assertEquals(probe.getStatus(), "healthy");

  probe.destroy();
});

Deno.test("render-probe: unprocessed deltas counter", () => {
  const probe = createRenderProbe(baseConfig());
  assertEquals(probe.getUnprocessedDeltas(), 0);
  probe.recordDelta();
  probe.recordDelta();
  probe.recordDelta();
  assertEquals(probe.getUnprocessedDeltas(), 3);
  probe.clearDeltas();
  assertEquals(probe.getUnprocessedDeltas(), 0);
  probe.destroy();
});

Deno.test("render-probe: destroy clears state", () => {
  const probe = createRenderProbe(baseConfig());
  probe.recordAction("click", "ui");
  probe.recordDelta();
  probe.tick(3000);

  probe.destroy();

  assertEquals(probe.getStatus(), "healthy");
  assertEquals(probe.getLastAction(), null);
  assertEquals(probe.getLastFeature(), null);
  assertEquals(probe.getUnprocessedDeltas(), 0);
  assertEquals(probe.getPreviousFreezeCount(), 0);
  assertEquals(probe.getFirstDegradedAt(), null);
  assertEquals(probe.getMeasured(), 0);
});
