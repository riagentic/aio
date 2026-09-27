// The loop guard is documented as "the same bound as the queue" (dispatch.ts:
// DISPATCH_MAX = QUEUE_MAX — "whatever the queue is allowed to hold, the drain
// must be allowed to process"). But the guard counts the action that STARTED
// the drain as well: one action fanning out to a queue-full of follow-ups (a
// bulk import dispatching per row) has every row ACCEPTED by the queue and
// then the last one REJECTED as DISPATCH_LOOP — the exact "queue said yes,
// loop guard said no" split the 1000 → 10 000 change was made to remove.
import { assertEquals } from "@std/assert";
import { createDispatch } from "../src/state/dispatch.ts";
import type { AioError } from "../src/diagnostics/error.ts";

const noop = { debug: () => {}, warn: () => {}, error: () => {} };

Deno.test("dispatch: a fan-out the queue accepts is fully processed", async () => {
  const ROWS = 10_000; // QUEUE_MAX — every one of these is accepted
  let n = 0;
  const rows: Promise<unknown>[] = [];
  const dispatch = createDispatch<
    { n: number },
    { type: string },
    { type: string }
  >({
    reduce: (s, a) => {
      if (a.type === "import") {
        for (let i = 0; i < ROWS; i++) rows.push(dispatch({ type: "row" }));
        return { state: s, effects: [] };
      }
      return { state: { n: s.n + 1 }, effects: [] };
    },
    execute: () => {},
    getState: () => ({ n }),
    setState: (s) => {
      n = s.n;
    },
    onDone: () => {},
    log: noop,
    debug: false,
    reportOpts: { logger: { error: () => {}, warn: () => {} } },
  });
  await dispatch({ type: "import" });
  const results = await Promise.allSettled(rows);
  const rejected = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => (r.reason as AioError).code);
  assertEquals(rejected, [], "every row the queue accepted must be applied");
  assertEquals(n, ROWS);
});
