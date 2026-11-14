// A `schedule.blocking()` task that ends its worker THREAD — `Deno.exit()` or
// `self.close()` — raises no error event. The task never settled, the dead
// worker kept its slot (a size-1 pool then hung every later task) and
// `disposeIdle()` refused at shutdown, with nothing in any log. The worker now
// says so before it ends; the pool rejects the task by name and retires the
// worker, as it does for a crash.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createBlockingPool } from "../src/state/blocking.ts";

/** The outcome, or "HUNG" — the bug was a promise that never settles. */
const within = (p: Promise<unknown>, ms = 5000) => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.then((v) => ({ v }), (e) => ({ e: String(e?.message ?? e) })),
    new Promise((r) => t = setTimeout(() => r("HUNG"), ms)),
  ]).finally(() => clearTimeout(t));
};

for (
  const [how, task, said] of [
    ["Deno.exit(3)", () => Deno.exit(3), "Deno.exit(3)"],
    [
      "self.close() after an await",
      async () => {
        await Promise.resolve();
        (globalThis as unknown as { close: () => void }).close();
        await new Promise(() => {});
      },
      "self.close()",
    ],
  ] as const
) {
  Deno.test(`blocking: a task whose worker exits (${how}) is rejected by name, and the pool goes on`, async () => {
    const pool = createBlockingPool({ size: 1 });
    try {
      const r = await within(pool.run("quitter", task)) as { e?: string };
      assert((r as unknown) !== "HUNG", "the exiting task never settled");
      assertStringIncludes(
        r.e ?? "",
        `the worker exited (${said}) in blocking task 'quitter'`,
      );
      // The slot is free again: a size-1 pool runs the next task.
      assertEquals(await within(pool.run("next", () => 42)), { v: 42 });
      assertEquals(pool.inFlight(), []);
      assert(pool.disposeIdle(), "shutdown must find the pool idle");
    } finally {
      await pool.dispose();
    }
  });
}
