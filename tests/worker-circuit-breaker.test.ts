// `circuitBreaker` counts a `worker: true` cell's errors and trips it, exactly
// as it does the same cell on the main isolate.
//
// The breaker lives in the MAIN isolate's composition, and a worker cell's
// method never runs there: its sync throws came home as the caller's
// rejection, its async throws as a reported error, and neither was counted.
// So a worker cell failing on every call was never disabled — while the
// in-isolate harness (where the method does run on main) tripped it on the
// configured count: green in the test, never tripped in production.
import { assertEquals } from "@std/assert";
import { testServer } from "../src/testing/server-test.ts";
import { wcb } from "./fixtures/leftovers-rt-app.ts";

const ENTRY = import.meta.resolve("./fixtures/leftovers-rt-app.ts");
const C = wcb as unknown as Record<
  "boom" | "boomLate" | "ok",
  () => Promise<unknown>
>;
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(real: boolean): Promise<Record<string, unknown>> {
  await using srv = await testServer({
    cells: [wcb],
    ...(real ? { workers: "real" as const, workerEntry: ENTRY } : {}),
    circuitBreaker: { maxErrors: 3 },
  });
  const cells = (srv.app as unknown as {
    cells: {
      health(): { name: string; errors: number; enabled: boolean }[];
      enable(name: string): void;
    };
  }).cells;
  const row = () => {
    const h = cells.health().find((h) => h.name === "wcb")!;
    return { errors: h.errors, enabled: h.enabled };
  };
  const out: Record<string, unknown> = {};
  await C.boom().catch(() => {});
  await C.boomLate().catch(() => {});
  await tick(50);
  out.afterTwo = row();
  await C.boom().catch(() => {});
  await tick(50);
  out.afterThree = row();
  await C.ok().catch(() => {});
  await tick(50);
  const n = () => (srv.state() as { wcb: { n: number } }).wcb.n;
  out.n = n();
  // Re-enabled, one call is one increment. A tripped worker cell whose call
  // still reached its worker ran it there out of sight (main refused the
  // patch), and the next increment then landed on that hidden 1.
  cells.enable("wcb");
  await C.ok();
  await tick(50);
  out.afterEnable = n();
  return out;
}

Deno.test("worker circuitBreaker: a real worker cell trips like the in-isolate one", async () => {
  const inIsolate = await run(false);
  assertEquals(inIsolate.afterTwo, { errors: 2, enabled: true });
  assertEquals(inIsolate.afterThree, { errors: 3, enabled: false });
  assertEquals(inIsolate.n, 0, "a tripped cell still ran a call");
  assertEquals(inIsolate.afterEnable, 1);
  const real = await run(true);
  assertEquals(real, inIsolate);
});
