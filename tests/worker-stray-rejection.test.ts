// A floating rejected promise in a `worker: true` cell's method is survived,
// as the same rejection is on the main isolate (`guardDispatches`, default
// on: logged loudly, the process lives — a wallet's field report). The worker
// thread used to die of it: the cell answered every later call with "crashed"
// for the life of the process — the designated heavy cell, the one most
// likely to hold such a `void poll()`.
import { assertEquals, assertRejects } from "@std/assert";
import { testServer } from "../src/testing/server-test.ts";
import { wstray } from "./fixtures/worker-stray-rejection-app.ts";

const ENTRY = import.meta.resolve("./fixtures/worker-stray-rejection-app.ts");
const W = wstray as unknown as {
  floating(): Promise<number>;
  inc(): Promise<number>;
};
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(real: boolean, guardDispatches?: boolean) {
  await using srv = await testServer({
    cells: [wstray],
    ...(real ? { workers: "real" as const, workerEntry: ENTRY } : {}),
    ...(guardDispatches === undefined ? {} : { guardDispatches }),
  });
  const first = await W.floating();
  await tick(100); // the stray lands a turn later
  const second = await W.inc();
  return {
    first,
    second,
    n: (srv.state() as { wstray: { n: number } }).wstray.n,
  };
}

Deno.test("worker cell: a floating rejection is survived, as on the main isolate", async () => {
  const inIsolate = await run(false);
  const real = await run(true);
  assertEquals(inIsolate, { first: 1, second: 2, n: 2 });
  assertEquals(real, inIsolate);
});

Deno.test("worker cell: guardDispatches: false keeps fail-fast — the thread dies of it", async () => {
  await using _srv = await testServer({
    cells: [wstray],
    workers: "real",
    workerEntry: ENTRY,
    guardDispatches: false,
  });
  await W.floating().catch(() => {}); // may race the crash
  await tick(100);
  await assertRejects(() => W.inc(), Error, "crashed");
});
