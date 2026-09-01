// `schedule.blocking`'s worker pool must not outlive the app that used it.
//
// The pool is a process-global spawned on first use and nothing ever tore it
// down: after an app shut down its idle threads stayed alive, which in
// libraryMode, `testServer()` and any multi-app host means threads accumulating
// for the life of the process. It cannot simply be disposed either — a SECOND
// app in the same isolate shares the pool, and a full dispose rejects ITS
// in-flight tasks. Hence `disposeIdle`: retire the threads only when nobody is
// using the pool, keep the pool itself usable.
import { assert, assertEquals } from "@std/assert";
import { createBlockingPool } from "../src/state/blocking.ts";
import { blocking } from "../src/state/blocking.ts";
import { createShutdownOrchestrator } from "../src/server/shutdown.ts";

/** Counts runs INSIDE the worker: a thread that survives answers 2 on its
 *  second task, a freshly spawned one answers 1. That is the only honest
 *  observation of "was the thread actually terminated". */
const bumpInWorker = () => {
  const g = globalThis as unknown as { __n?: number };
  g.__n = (g.__n ?? 0) + 1;
  return g.__n;
};

Deno.test("blocking: disposeIdle really terminates the idle threads", async () => {
  const pool = createBlockingPool({ size: 1 }); // one thread ⇒ it is reused
  assertEquals(await pool.run("a", bumpInWorker), 1);
  assertEquals(await pool.run("a", bumpInWorker), 2, "the thread is reused");

  assertEquals(pool.disposeIdle(), true, "nothing running ⇒ idle threads go");
  assertEquals(
    await pool.run("a", bumpInWorker),
    1,
    "…and the next task runs on a NEW thread — the old one is gone, not idle",
  );
  await pool.dispose();
});

Deno.test("blocking: disposeIdle refuses while a task is in flight", async () => {
  const pool = createBlockingPool({ size: 1 });
  const slow = pool.run(
    "slow",
    () => new Promise((r) => setTimeout(() => r("done"), 300)),
  );
  await new Promise((r) => setTimeout(r, 60)); // it is running now
  assertEquals(
    pool.disposeIdle(),
    false,
    "a co-hosted app's in-flight work must not be killed by our shutdown",
  );
  assertEquals(await slow, "done");
  assertEquals(pool.disposeIdle(), true);
  await pool.dispose();
});

Deno.test("shutdown: Phase 7 retires the global pool's idle threads", async () => {
  // The wiring, end to end: an app that used schedule.blocking must not leave
  // threads behind when it shuts down.
  assertEquals(await blocking("t", bumpInWorker), 1);
  assertEquals(await blocking("t", bumpInWorker), 2, "same thread so far");

  const noop = () => {};
  const orch = createShutdownOrchestrator({
    flushPersist: () => Promise.resolve(),
    setShuttingDown: noop,
    diagHooks: null,
    getVitalsCheckTimer: () => undefined,
    getVitalsSystem: () => undefined,
    onStopping: undefined,
    onStop: undefined,
    appLock: null,
    scheduleManager: { cancelAll: noop },
    ownManager: { disposeAll: noop },
    dispatch: { close: noop, drain: () => Promise.resolve() },
    getCellNames: () => [],
    getAppId: () => "blocking-dispose-idle",
    getElectronProc: () => null,
    clearElectronProc: noop,
    disposeUds: noop,
    getUdsHandle: () => null,
    getServer: () => ({ shutdown: () => Promise.resolve() }),
    asyncDb: null,
    kvDb: null,
    setRunning: noop,
    log: {
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
    } as unknown as Parameters<typeof createShutdownOrchestrator>[0]["log"],
  });
  await orch.shutdown();

  assertEquals(
    await blocking("t", bumpInWorker),
    1,
    "shutdown must have terminated the idle worker, not just left it there",
  );
  await blocking.dispose();
});

Deno.test("blocking: the global disposeIdle is safe before any pool exists", () => {
  // Shutdown calls this unconditionally; an app that never used
  // schedule.blocking must not pay for (or crash on) a pool it never created.
  assert(blocking.disposeIdle());
});
