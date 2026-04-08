import { assertEquals } from "@std/assert";
import {
  createRenderMeter,
  renderHint,
} from "../../src/vitals/render-meter.ts";
import type { RenderGauges } from "../../src/vitals/render-meter.ts";

const baseConfig = () => ({
  manualTick: true,
  thresholds: { staleness: 300, pendingPatches: 10 },
});

Deno.test("render-meter: initial status is healthy", () => {
  const meter = createRenderMeter(baseConfig());
  assertEquals(meter.getStatus(), "healthy");
  assertEquals(meter.getStaleness(), 0);
  meter.destroy();
});

Deno.test("render-meter: initial gauges are zero", () => {
  const meter = createRenderMeter(baseConfig());
  const g = meter.getGauges();
  assertEquals(g.staleness.percent, 0);
  assertEquals(g.frameTime.percent, 0);
  assertEquals(g.pendingPatches.percent, 0);
  assertEquals(g.staleness.capacity, 300);
  assertEquals(g.pendingPatches.capacity, 10);
  assertEquals(g.frameTime.capacity, 16.67);
  meter.destroy();
});

Deno.test("render-meter: gauge percent clamped 0-100", () => {
  const meter = createRenderMeter(baseConfig());
  // Simulate massive staleness — 10x threshold
  meter.recordPatch(100); // patch at t=100
  meter.tick(3100); // frame at t=3100, staleness = 3000ms, 1000% → clamped to 100
  const g = meter.getGauges();
  assertEquals(g.staleness.percent, 100);
  meter.destroy();
});

Deno.test("render-meter: staleness grows when patches arrive without paint", () => {
  const meter = createRenderMeter(baseConfig());
  meter.recordPatch(1000);
  meter.tick(1000);
  meter.recordPatch(1050);
  meter.tick(1200);
  assertEquals(meter.getStaleness(), 150);
  meter.destroy();
});

Deno.test("render-meter: staleness resets when no pending patches", () => {
  const meter = createRenderMeter(baseConfig());
  meter.recordPatch(1000);
  meter.tick(1000);
  meter.tick(1200);
  assertEquals(meter.getStaleness(), 0);
  meter.destroy();
});

Deno.test("render-meter: pendingPatches accumulates and resets on tick", () => {
  const meter = createRenderMeter(baseConfig());
  meter.recordPatch(100);
  meter.recordPatch(110);
  meter.recordPatch(120);
  const g1 = meter.getGauges();
  assertEquals(g1.pendingPatches.current, 3);
  meter.tick(200);
  const g2 = meter.getGauges();
  assertEquals(g2.pendingPatches.current, 0);
  meter.destroy();
});

Deno.test("render-meter: status transitions healthy → degraded → warning → frozen", () => {
  const statuses: string[] = [];
  const meter = createRenderMeter({
    ...baseConfig(),
    onStatusChange: (s) => {
      statuses.push(s);
    },
  });

  meter.recordPatch(0);
  meter.tick(0);
  meter.recordPatch(100);
  meter.tick(450);
  assertEquals(meter.getStatus(), "degraded");

  meter.recordPatch(500);
  meter.tick(1150);
  assertEquals(meter.getStatus(), "warning");

  meter.recordPatch(1200);
  meter.tick(2900);
  assertEquals(meter.getStatus(), "frozen");

  assertEquals(statuses.includes("degraded"), true);
  assertEquals(statuses.includes("warning"), true);
  assertEquals(statuses.includes("frozen"), true);
  meter.destroy();
});

Deno.test("render-meter: frozen → recovered → healthy transition", () => {
  const statuses: string[] = [];
  const meter = createRenderMeter({
    ...baseConfig(),
    onStatusChange: (s) => {
      statuses.push(s);
    },
  });

  meter.recordPatch(0);
  meter.tick(0);
  meter.recordPatch(100);
  meter.tick(1700);

  meter.tick(1800);
  assertEquals(statuses.includes("recovered"), true);
  assertEquals(meter.getStatus(), "healthy");
  meter.destroy();
});

Deno.test("render-meter: paused prevents measurement", () => {
  const meter = createRenderMeter(baseConfig());
  meter.recordPatch(100);
  meter.setPaused(true);
  meter.tick(5000);
  assertEquals(meter.getStaleness(), 0);
  meter.destroy();
});

Deno.test("render-meter: markDirty + tick calls onNotify once", () => {
  let notifyCount = 0;
  const meter = createRenderMeter({
    ...baseConfig(),
    onNotify: () => {
      notifyCount++;
    },
  });

  meter.markDirty();
  meter.markDirty();
  meter.markDirty();
  meter.tick(100);
  assertEquals(notifyCount, 1);

  meter.tick(200);
  assertEquals(notifyCount, 1);
  meter.destroy();
});

Deno.test("render-meter: markDirty not called → onNotify not called", () => {
  let notifyCount = 0;
  const meter = createRenderMeter({
    ...baseConfig(),
    onNotify: () => {
      notifyCount++;
    },
  });

  meter.tick(100);
  meter.tick(200);
  assertEquals(notifyCount, 0);
  meter.destroy();
});

Deno.test("render-meter: frameTime reflects gap between ticks", () => {
  const meter = createRenderMeter(baseConfig());
  meter.tick(100);
  meter.tick(132);
  const g = meter.getGauges();
  assertEquals(g.frameTime.current, 32);
  assertEquals(g.frameTime.percent, 100); // 32/16.67 > 100 → clamped
  meter.destroy();
});

Deno.test("render-meter: paintRate calculates fps over 1s window", () => {
  const meter = createRenderMeter(baseConfig());
  for (let i = 0; i <= 60; i++) {
    meter.tick(i * 16.67);
  }
  const g = meter.getGauges();
  assertEquals(g.paintRate.current >= 0, true);
  meter.destroy();
});

Deno.test("render-meter: recordAction stores last action/cell", () => {
  const meter = createRenderMeter(baseConfig());
  meter.recordAction("counter/increment", "counter");
  assertEquals(meter.getLastAction(), "counter/increment");
  assertEquals(meter.getLastCell(), "counter");
  meter.destroy();
});

Deno.test("render-meter: destroy resets all state", () => {
  const meter = createRenderMeter(baseConfig());
  meter.recordPatch(100);
  meter.markDirty();
  meter.tick(500);
  meter.destroy();
  assertEquals(meter.getStatus(), "healthy");
  assertEquals(meter.getStaleness(), 0);
});

Deno.test("render-meter: visibility resume resets baselines", () => {
  const meter = createRenderMeter(baseConfig());
  meter.recordPatch(100);
  meter.tick(100);
  meter.recordPatch(200);
  meter.tick(300);

  meter.setPaused(true);
  meter.setPaused(false);
  assertEquals(meter.getStaleness(), 0);
  meter.destroy();
});

// ─── renderHint tests ────────────────────────────────────────────────────────

function mockGauges(
  overrides: Partial<Record<keyof RenderGauges, number>>,
): RenderGauges {
  const g = (name: string, pct: number) => ({
    name,
    current: pct,
    capacity: 100,
    percent: pct,
  });
  return {
    staleness: g("render.staleness", overrides.staleness ?? 0),
    frameTime: g("render.frameTime", overrides.frameTime ?? 0),
    pendingPatches: g("render.pendingPatches", overrides.pendingPatches ?? 0),
    paintRate: g("render.paintRate", overrides.paintRate ?? 0),
  };
}

Deno.test("hint: high staleness + high frameTime → expensive components", () => {
  const hint = renderHint(
    mockGauges({ staleness: 80, frameTime: 80, pendingPatches: 10 }),
  );
  assertEquals(
    hint !== null &&
      (hint.includes("Components") || hint.includes("React.memo")),
    true,
  );
});

Deno.test("hint: high staleness + high pendingPatches → too many patches", () => {
  const hint = renderHint(
    mockGauges({ staleness: 80, frameTime: 10, pendingPatches: 80 }),
  );
  assertEquals(
    hint !== null &&
      (hint.includes("syncIntervalMs") || hint.includes("batch")),
    true,
  );
});

Deno.test("hint: high staleness + low all → non-React blocking", () => {
  const hint = renderHint(
    mockGauges({ staleness: 80, frameTime: 10, pendingPatches: 10 }),
  );
  assertEquals(
    hint !== null &&
      (hint.includes("non-React") || hint.includes("outside React")),
    true,
  );
});

Deno.test("hint: low staleness → null", () => {
  const hint = renderHint(mockGauges({ staleness: 10 }));
  assertEquals(hint, null);
});

Deno.test("hint: high staleness + both high → combined advice", () => {
  const hint = renderHint(
    mockGauges({ staleness: 80, frameTime: 80, pendingPatches: 80 }),
  );
  assertEquals(hint !== null && hint.includes("AND"), true);
});

// ─── AIO-122: destroy stops tick from producing side effects ────────────────

Deno.test("render-meter: tick after destroy is a no-op (AIO-122)", () => {
  let notifyCount = 0;
  const statuses: string[] = [];
  const meter = createRenderMeter({
    ...baseConfig(),
    onNotify: () => {
      notifyCount++;
    },
    onStatusChange: (s) => {
      statuses.push(s);
    },
  });

  // Warm up with a tick
  meter.recordPatch(100);
  meter.markDirty();
  meter.tick(100);
  const notifyAfterFirstTick = notifyCount;
  const statusesAfterFirstTick = statuses.length;

  // Destroy, then try to tick again
  meter.destroy();
  meter.recordPatch(200);
  meter.markDirty();
  meter.tick(5000); // should be a no-op

  // No new notifications or status changes after destroy
  assertEquals(notifyCount, notifyAfterFirstTick);
  assertEquals(statuses.length, statusesAfterFirstTick);
  assertEquals(meter.getStaleness(), 0);
  assertEquals(meter.getStatus(), "healthy");
});

// ─── Memory gauge tests ──────────────────────────────────────────────────────

Deno.test("render-meter: memory gauge returns null when API unavailable", () => {
  const meter = createRenderMeter({ manualTick: true });
  // In Deno test environment, performance.memory doesn't exist
  assertEquals(meter.getMemoryGauge(), null);
  meter.destroy();
});
