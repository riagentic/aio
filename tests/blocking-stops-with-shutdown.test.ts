// A `blocking()` task started from a method body ends when the app's shutdown
// aborts that method (`s.$signal`). It used to run on: the method's caller was
// released at the drain deadline, and the task kept its worker thread — and,
// in libraryMode / `testServer()`, the whole process — alive after close().
import { assert, assertEquals, assertRejects } from "@std/assert";
import { cell } from "../mod.ts";
import { _blockingInFlight, blocking } from "../src/state/blocking.ts";
import { testServer } from "../src/testing/server-test.ts";
import { runWithCallSignal } from "../src/state/call-signal.ts";

/** Yields every 10 ms for ~20 s — stoppable (async), never finishing alone. */
const longJob = async () => {
  for (let i = 0; i < 2000; i++) await new Promise((r) => setTimeout(r, 10));
  return "finished";
};

Deno.test("blocking(): the app's shutdown stops a task its method started", async () => {
  let taskErr: unknown;
  const c = cell("blk-shutdown", {
    state: { n: 0 },
    methods: {
      async crunch(s) {
        s.n++;
        try {
          await blocking("crunch", longJob);
        } catch (e) {
          taskErr = e;
          throw e;
        }
      },
    },
  });
  const srv = await testServer({ cells: [c] });
  const call = c.crunch().catch((e) => e);
  for (let i = 0; i < 100 && _blockingInFlight().length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assertEquals(_blockingInFlight(), ["crunch"], "the task is running");
  const t0 = Date.now();
  await srv.close();
  await call;
  assert(Date.now() - t0 < 10_000, "close() did not wait the task out");
  assertEquals(_blockingInFlight(), [], "no task outlives the app");
  assert(taskErr instanceof Error);
  assertEquals((taskErr as Error).name, "AbortError");
  await blocking.dispose();
});

Deno.test("blocking(): a call signal that is not a shutdown's leaves the task alone", async () => {
  const ac = new AbortController();
  const p = runWithCallSignal(
    ac.signal,
    () =>
      blocking(
        "cancel-on",
        () => new Promise((r) => setTimeout(() => r(7), 100)),
      ),
  );
  ac.abort(); // a cancelOn-style abort: the body may still want its result
  assertEquals(await p, 7);
  await blocking.dispose();
});

Deno.test("blocking(): outside any method body nothing changes", async () => {
  assertEquals(await blocking("plain", () => 3), 3);
  await assertRejects(() =>
    blocking("bad", () => {
      throw new Error("x");
    })
  );
  await blocking.dispose();
});
