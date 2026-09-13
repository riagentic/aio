// `cancelOn` with a PEER-cell trigger must abort a WORKER cell's in-flight
// method — the same as it does for a main-isolate cell.
//
// The cancel registry (`src/state/method-cancel.ts`) is module-scoped, so each
// isolate has its OWN copy. `notifyMethodCancel` fires in whichever isolate
// ran the reduce. A peer cell lives on main, so `ctl:stop` reduced on main and
// fired main's registry — where the worker cell's AbortController does not
// exist. The worker's registry, which holds it, was never told the action
// happened: the wire (cell-worker-protocol.ts) carries only that cell's OWN
// calls across the thread.
//
// The in-isolate harness cannot see this — there is one registry there, so the
// trigger and the controller are in the same map and it works. Green test,
// broken prod, which is why this test names `workers: "real"`.
import { assertEquals } from "@std/assert";
import { testServer } from "../src/testing/server-test.ts";
import { ctl, job, main } from "./fixtures/worker-cancelon-app.ts";

const ENTRY =
  new URL("./fixtures/worker-cancelon-app.ts", import.meta.url).href;

Deno.test("cancelOn: a peer cell's action aborts a REAL worker cell's method", async () => {
  await using srv = await testServer({
    cells: [ctl, job],
    workers: "real",
    workerEntry: ENTRY,
  });
  void srv;

  const inflight = job.slow();
  // Let the method get past its first await, so it is tracked.
  await new Promise((r) => setTimeout(r, 200));
  await ctl.stop();
  const ret = await inflight;

  assertEquals(ret, "aborted", "the peer's action must abort the worker call");
  assertEquals(job.aborted, true, "…and the abort must be visible in state");
  assertEquals(job.finished, false, "the method must not have run to the end");
});

Deno.test("cancelOn: a REAL worker cell's action aborts a main cell's method", async () => {
  await using srv = await testServer({
    cells: [ctl, job, main],
    workers: "real",
    workerEntry: ENTRY,
  });
  void srv;

  const inflight = main.wait();
  await new Promise((r) => setTimeout(r, 200));
  await job.poke();
  const ret = await inflight;

  assertEquals(ret, "aborted", "the worker's action must abort the main call");
  assertEquals(main.aborted, true, "…and the abort must be visible in state");
  assertEquals(main.finished, false, "the method must not have run to the end");
});

// A framework effect emitted INSIDE a worker isolate is posted home and run on
// main. The pool's effect router hand-wrote its classifier chain — schedule,
// own, then "must be an app action" — so a `notify()` from a worker cell was
// dispatched as an action type no cell answers and vanished with no log at
// all. `__own` had been the same bug one effect kind earlier, which is what
// `route-effect.ts` exists to make impossible; this call site had never been
// converted to it.
//
// Observed with nobody connected, where the CORRECT behaviour is a named warn
// rather than silence — so the assertion distinguishes "handled" from "gone".
Deno.test("a worker cell's notify() reaches the main isolate's notify handler", async () => {
  const lines: string[] = [];
  const orig = { log: console.log, info: console.info, warn: console.warn };
  const push = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  console.log = push;
  console.info = push;
  console.warn = push;
  try {
    await using srv = await testServer({
      cells: [ctl, job, main],
      workers: "real",
      workerEntry: ENTRY,
    });
    void srv;
    await job.ping();
    await new Promise((r) => setTimeout(r, 400));
  } finally {
    console.log = orig.log;
    console.info = orig.info;
    console.warn = orig.warn;
  }
  const hit = lines.filter((l) => l.includes("from-a-worker-cell"));
  assertEquals(
    hit.length > 0,
    true,
    `the notify effect was never handled on main — nothing named it.\n` +
      lines.slice(-8).join("\n"),
  );
});
