// Disabling / enabling a `worker: true` cell runs its lifecycle IN ITS WORKER,
// with the same observable results as the identical cell on the main isolate.
//
// `app.cells.disable` (and the circuit breaker, which calls it) ran the cell's
// `onDestroy` and its state reset on the MAIN isolate's copy only — the
// worker's copy kept the old slice, so the first call after `enable` streamed
// home a write on top of it (n=3 → reset to 0 → one increment read 4), and
// `onDestroy`/`onInit` ran on a thread that never owned the cell's resources.
import { assertEquals } from "@std/assert";
import { testServer } from "../src/testing/server-test.ts";
import { ran, wlc } from "./fixtures/worker-lifecycle-app.ts";

const ENTRY = import.meta.resolve("./fixtures/worker-lifecycle-app.ts");
const C = wlc as unknown as Record<"ok" | "boom", () => Promise<unknown>>;
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(real: boolean) {
  const before = { ...ran };
  await using srv = await testServer({
    cells: [wlc],
    ...(real ? { workers: "real" as const, workerEntry: ENTRY } : {}),
    circuitBreaker: { maxErrors: 2 },
  });
  const cells = (srv.app as unknown as {
    cells: {
      health(): { name: string; enabled: boolean }[];
      enable(name: string): void;
      disable(name: string): void;
    };
  }).cells;
  const snap = () => ({
    ...(srv.state() as { wlc: Record<string, unknown> }).wlc,
    enabled: cells.health().find((h) => h.name === "wlc")!.enabled,
  });
  const steps: Record<string, unknown>[] = [];
  await tick(50);
  steps.push(snap()); // booted: onInit ran once
  for (let i = 0; i < 3; i++) await C.ok();
  await tick(50);
  steps.push(snap());
  cells.disable("wlc");
  await tick(50);
  steps.push(snap()); // reset, disabled
  await C.ok().catch(() => {}); // refused while disabled
  await tick(50);
  steps.push(snap());
  cells.enable("wlc");
  await tick(50);
  steps.push(snap()); // onInit ran again, fresh state
  await C.ok();
  await tick(50);
  steps.push(snap()); // ONE increment on the fresh slice
  // The breaker takes the same path.
  await C.boom().catch(() => {});
  await C.boom().catch(() => {});
  await tick(50);
  steps.push(snap());
  cells.enable("wlc");
  await C.ok();
  await tick(50);
  steps.push(snap());
  // "Restart the cell": disable and enable in one tick — the owner's reply to
  // the disable lands after the enable here.
  await C.ok();
  cells.disable("wlc");
  cells.enable("wlc");
  await tick(50);
  steps.push(snap());
  await C.ok();
  await tick(50);
  steps.push(snap());
  return {
    steps,
    onMain: {
      inits: ran.inits - before.inits,
      destroys: ran.destroys - before.destroys,
    },
  };
}

Deno.test("worker disable/enable: lifecycle runs in the worker, same results as main", async () => {
  const inIsolate = await run(false);
  assertEquals(inIsolate.steps.length, 10);
  assertEquals(inIsolate.steps[5], { n: 1, inits: 1, enabled: true });
  assertEquals(inIsolate.onMain, { inits: 4, destroys: 3 });
  const real = await run(true);
  assertEquals(real.steps, inIsolate.steps);
  // …and never on the main isolate, which does not own the cell.
  assertEquals(real.onMain, { inits: 0, destroys: 0 });
});
