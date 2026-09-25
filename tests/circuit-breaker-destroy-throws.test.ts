// A circuit-breaker trip whose `onDestroy` throws rolls back ONCE — it does
// not trip again from inside its own trip.
//
// The rollback counts the DESTROY_ERROR, and at or over `maxErrors` that count
// tripped the breaker again, recursively: `onDestroy` ran ~10 000 times, each
// run reported to `onError`, until the stack overflowed and the method that
// tripped it failed with "Maximum call stack size exceeded". And a rolled-back
// trip still called `onTrip` and reported "auto-disabled" for a cell that was
// still enabled.
import { assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";

let destroys = 0;
const dt = cell("destroyThrows", {
  state: { n: 0 },
  onDestroy() {
    destroys++;
    throw new Error("resource already closed");
  },
  methods: {
    boom(_s: { n: number }) {
      throw new Error("boom");
    },
  },
});
const D = dt as unknown as { boom(): Promise<void> };

Deno.test("circuit breaker: a trip whose onDestroy throws rolls back once", async () => {
  const trips: number[] = [];
  const failures: string[] = [];
  await using srv = await testServer({
    cells: [dt],
    circuitBreaker: { maxErrors: 2, onTrip: (_n, c) => trips.push(c) },
  });
  for (let i = 0; i < 4; i++) {
    await D.boom().catch((e) => failures.push((e as Error).message));
  }
  assertEquals(failures, ["boom", "boom", "boom", "boom"]);
  // booms 2, 3 and 4 each tried to trip it: one onDestroy each.
  assertEquals(destroys, 3);
  assertEquals(trips, [], "a rolled-back trip is not a trip");
  const h = (srv.app as unknown as {
    cells: { health(): { name: string; enabled: boolean; errors: number }[] };
  }).cells.health().find((h) => h.name === "destroyThrows")!;
  // 4 method throws + 3 DESTROY_ERRORs.
  assertEquals({ enabled: h.enabled, errors: h.errors }, {
    enabled: true,
    errors: 7,
  });
});
