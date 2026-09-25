// A schedule that names a `worker: true` cell's method runs it IN THE WORKER.
//
// The scheduler dispatched its ticks through the raw main-isolate loop, which
// never consults the worker pool — so the MAIN isolate's composed reduce ran
// the method body: off the cell's thread (a scheduled burn froze every other
// cell), against the main isolate's module singletons instead of the handle
// the worker owns, and onto a slice the worker never saw, so the worker's next
// commit overwrote the tick's write. `schedule.every(id, ms, self("poll"))`
// from a worker cell — the everyday poller — took the same path.
import { assertEquals } from "@std/assert";
import {
  createScheduleManager,
  createVirtualTimers,
  schedule,
} from "../src/state/schedule.ts";
import { closedWorkerCall } from "../src/server/cell-worker.ts";
import { testServer } from "../src/testing/server-test.ts";
import {
  isolationProbe,
  moduleCallsHere,
} from "./fixtures/worker-isolation-app.ts";

const ENTRY = import.meta.resolve("./fixtures/worker-isolation-app.ts");

Deno.test("real workers: a scheduled tick runs the worker cell's method in its worker", async () => {
  const before = moduleCallsHere();
  await using srv = await testServer({
    cells: [isolationProbe],
    workers: "real",
    workerEntry: ENTRY,
    schedules: [{
      id: "probe:tick",
      after: 20,
      action: isolationProbe.bump.action(),
    }],
  });
  const st = () =>
    (srv.state() as {
      isolationProbe: { calls: number; ranInWorker: boolean };
    }).isolationProbe;
  for (let i = 0; i < 100 && st().calls === 0; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assertEquals(st().calls, 1, "the tick ran");
  assertEquals(st().ranInWorker, true, "the tick ran on the main isolate");
  assertEquals(moduleCallsHere() - before, 0, "main's module graph ran it");
  // The worker's slice saw the tick's write: its next commit builds on it.
  await isolationProbe.take("x");
  assertEquals(st().calls, 2, "the worker overwrote the tick's write");
});

// …and a tick that reaches a worker cell during shutdown stops quietly. The
// pool closes FIRST (shutdown Phase 0b), so for the rest of the stop a closed
// worker answers every tick — and its refusal carried no code, so the
// scheduler, which stops a schedule silently on DISPATCH_CLOSED, reported each
// one as `ERROR schedule: dispatch '…' failed` inside a clean exit.
Deno.test("closed worker cell: a tick it refuses during shutdown stops its schedule quietly", async () => {
  const errors: string[] = [];
  const log = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (m: string) => void errors.push(m),
  };
  const timers = createVirtualTimers();
  const action = { type: "probe:poll", payload: { args: [] } };
  const mgr = createScheduleManager(
    (a) => closedWorkerCall("probe", null, a as never),
    log as never,
    { timers },
  );
  mgr.handle(schedule.every("probe:poll", 10, action));
  await timers.advance(35);
  assertEquals(errors, [], "a clean stop reported its poller as failing");
  assertEquals(mgr.active(), [], "the schedule kept ticking into the stop");
  // A CRASH is not a shutdown: that one is still an error, said out loud.
  const crashed = await closedWorkerCall("probe", "[aio] boom", action as never)
    .catch((e) => e as Error & { code?: string });
  assertEquals((crashed as { code?: string }).code, undefined);
});
