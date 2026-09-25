// `/__aio/vitals` gauges: the capacity a gauge is drawn against must be the
// app's CONFIGURED threshold. It was a pair of constants (1000 actions, 100ms)
// — so an app that set `diagnostics.dev.vitals.thresholds.queue.frozen: 100` saw its queue at
// 10% on amui's gauge at the very moment the server declared it frozen.
import { assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";

type Gauge = { current: number; capacity: number; percent: number };

Deno.test("vitals dashboard: gauge capacities are the configured frozen thresholds", async () => {
  const c = cell("vitals-gauges", { state: { n: 0 }, methods: {} });
  await using srv = await testServer({
    cells: [c],
    diagnostics: {
      dev: {
        vitals: {
          thresholds: {
            queue: { degraded: 10, warning: 50, frozen: 100 },
            loop: { degraded: 20, warning: 200, frozen: 750 },
          },
        },
      },
    },
  });
  const body = await (await srv.fetch("/__aio/vitals")).json() as {
    gauges: Record<string, Gauge>;
  };
  const names = Object.keys(body.gauges).sort();
  assertEquals(names, ["server.queueDepth", "server.reduceTime"]);
  assertEquals(body.gauges["server.queueDepth"]!.capacity, 100);
  assertEquals(body.gauges["server.reduceTime"]!.capacity, 750);
});

Deno.test("vitals dashboard: with no thresholds configured, the defaults are the capacities", async () => {
  const c = cell("vitals-gauges-default", { state: { n: 0 }, methods: {} });
  await using srv = await testServer({ cells: [c] });
  const { DEFAULT_THRESHOLDS } = await import("../src/vitals/types.ts");
  const body = await (await srv.fetch("/__aio/vitals")).json() as {
    gauges: Record<string, Gauge>;
  };
  assertEquals(
    body.gauges["server.queueDepth"]!.capacity,
    DEFAULT_THRESHOLDS.queue.frozen,
  );
  assertEquals(
    body.gauges["server.reduceTime"]!.capacity,
    DEFAULT_THRESHOLDS.loop.frozen,
  );
});
