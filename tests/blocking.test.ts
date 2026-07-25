// risoto 2026-07-24 #7 — schedule.blocking(): a named, cancellable, backpressured
// worker pool that runs self-contained functions OFF the main isolate so FFI/CPU
// work can't freeze rendering. Tests drive the pool factory directly (each test
// disposes → no leaked workers).
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createBlockingPool } from "../src/state/blocking.ts";

Deno.test("blocking: runs a self-contained fn off-thread and returns its result", async () => {
  const pool = createBlockingPool({ size: 2 });
  try {
    const out = await pool.run<number>("double", (x) => (x as number) * 2, 21);
    assertEquals(out, 42);
  } finally {
    await pool.dispose();
  }
});

Deno.test("blocking: a throwing fn rejects with its message", async () => {
  const pool = createBlockingPool({ size: 1 });
  try {
    await assertRejects(
      () =>
        pool.run("boom", () => {
          throw new Error("kaboom");
        }),
      Error,
      "kaboom",
    );
  } finally {
    await pool.dispose();
  }
});

Deno.test("blocking: backpressure — size 1 serializes tasks, both still complete", async () => {
  const pool = createBlockingPool({ size: 1 });
  try {
    const results = await Promise.all([
      pool.run<number>("a", (x) => (x as number) + 1, 1),
      pool.run<number>("b", (x) => (x as number) + 1, 10),
      pool.run<number>("c", (x) => (x as number) + 1, 100),
    ]);
    assertEquals(results, [2, 11, 101]);
    assertEquals(pool.size, 1);
  } finally {
    await pool.dispose();
  }
});

Deno.test("blocking: cancel a queued task rejects it while the running one finishes", async () => {
  const pool = createBlockingPool({ size: 1 });
  try {
    // 'slow' occupies the single worker; 'queued' waits behind it.
    const slow = pool.run<string>(
      "slow",
      () => new Promise((r) => setTimeout(() => r("done"), 120)),
    );
    const queued = pool.run("queued", () => "never");
    assertEquals(pool.cancel("queued"), true);
    await assertRejects(() => queued, Error, "cancelled");
    assertEquals(await slow, "done"); // the running task is untouched
  } finally {
    await pool.dispose();
  }
});

Deno.test("blocking: cancel a RUNNING task terminates its worker and rejects", async () => {
  const pool = createBlockingPool({ size: 1 });
  try {
    const running = pool.run(
      "long",
      () => new Promise((r) => setTimeout(r, 5000)),
    );
    // let it reach the worker, then cancel
    await new Promise((r) => setTimeout(r, 30));
    assertEquals(pool.cancel("long"), true);
    await assertRejects(() => running, Error, "cancelled");
    // pool still usable afterward (a fresh worker spins up)
    assertEquals(
      await pool.run<number>("after", (x) => (x as number) * 3, 4),
      12,
    );
  } finally {
    await pool.dispose();
  }
});

Deno.test("blocking: dispose rejects in-flight work", async () => {
  const pool = createBlockingPool({ size: 1 });
  const inflight = pool.run("x", () => new Promise((r) => setTimeout(r, 5000)));
  await new Promise((r) => setTimeout(r, 20));
  await pool.dispose();
  await assertRejects(() => inflight, Error, "disposed");
});
