// schedule.blocking(): two wrong answers found by running the pool.
//
// 1. A task that left a floating rejection behind RESOLVED (its result was
//    posted first) — and the stray, landing a turn later, was charged to the
//    NEXT task the worker had been handed: an unrelated caller rejected with
//    "blocking worker crashed: … <someone else's error>". A stray after its
//    task settled now kills nobody's task: it is logged, and the worker lives.
// 2. A method-shorthand function (`const jobs = { hash(a) {…} }`,
//    `blocking("h", jobs.hash, x)`) is a self-contained function, but its
//    source (`hash(a) {…}`) is not an expression — it failed in the worker
//    with a bare "Unexpected token '{'".
import { assertEquals, assertRejects } from "@std/assert";
import { createBlockingPool } from "../src/state/blocking.ts";

Deno.test("blocking: a stray rejection after a task settled is not charged to the next task", async () => {
  const pool = createBlockingPool({ size: 1 });
  try {
    const first = await pool.run("leaky", () => {
      void Promise.reject(new Error("stray from leaky"));
      return 5;
    });
    assertEquals(first, 5);
    // Same worker (size 1), handed out the moment `leaky` answered.
    assertEquals(await pool.run("innocent", (a) => a, 7), 7);
    assertEquals(await pool.run("after", (a) => a, 8), 8);
  } finally {
    await pool.dispose();
  }
});

Deno.test("blocking: a crash DURING a task still rejects that task", async () => {
  const pool = createBlockingPool({ size: 1 });
  try {
    await assertRejects(
      () =>
        pool.run("dies", () =>
          new Promise(() => {
            void Promise.reject(new Error("mid-task"));
          })),
      Error,
      "blocking worker crashed",
    );
    assertEquals(await pool.run("next", (a) => a, 1), 1);
  } finally {
    await pool.dispose();
  }
});

Deno.test("blocking: a method-shorthand function runs", async () => {
  const pool = createBlockingPool({ size: 1 });
  const jobs = {
    double(a: unknown) {
      return (a as number) * 2;
    },
    async triple(a: unknown) {
      await Promise.resolve();
      return (a as number) * 3;
    },
  };
  try {
    assertEquals(await pool.run("d", jobs.double, 2), 4);
    assertEquals(await pool.run("t", jobs.triple, 2), 6);
  } finally {
    await pool.dispose();
  }
});
