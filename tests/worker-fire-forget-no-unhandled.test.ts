// A fire-and-forget call to a worker cell's SYNC method that throws must be as
// quiet as the same call on an in-isolate cell: the main door attaches a no-op
// catch (dispatch.ts, B-4), so only an awaiter sees the rejection. The worker
// route returned its own promise bare, so `wff.boom()` unawaited reached the
// process as an `unhandledrejection` (the crash handler's ERROR line) — and so
// did every unawaited call a shutdown closed mid-run.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { testServer } from "../src/testing/server-test.ts";
import { crashWorker } from "../src/cell-test.ts";
import { setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";
import { wff } from "./fixtures/worker-fire-forget-app.ts";

const ENTRY = import.meta.resolve("./fixtures/worker-fire-forget-app.ts");
const W = wff as unknown as { boom(): Promise<void>; inc(): Promise<void> };
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function strays(real: boolean): Promise<string[]> {
  const seen: string[] = [];
  const on = (e: PromiseRejectionEvent) => {
    seen.push(String((e.reason as Error)?.message ?? e.reason));
    e.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", on);
  try {
    await using _srv = await testServer({
      cells: [wff],
      ...(real ? { workers: "real" as const, workerEntry: ENTRY } : {}),
    });
    W.boom(); // fire and forget
    await tick(100);
    // An awaiter still gets the rejection.
    await assertRejects(() => W.boom(), Error, "ff boom");
    await W.inc();
  } finally {
    await tick(50);
    globalThis.removeEventListener("unhandledrejection", on);
  }
  return seen;
}

Deno.test("worker cell: an unawaited sync throw is not an unhandled rejection", async () => {
  assertEquals(await strays(false), [], "in-isolate baseline");
  assertEquals(await strays(true), [], "real worker");
});

// …and quiet must not mean silent: a fire-and-forget call a DEAD worker cell
// refuses is said once per action type, as the main loop's "dispatch after
// close()" is — the caller that never awaits has no other way to learn it.
Deno.test("worker cell: a dead cell's fire-and-forget drop is said once", async () => {
  const lines: string[] = [];
  setLogger(
    {
      pub: (lvl: string, _cat: string, msg: string) => {
        if (lvl === "warn" && msg.includes("dropped")) lines.push(msg);
      },
    } as unknown as LogSink,
  );
  try {
    await using _srv = await testServer({
      cells: [wff],
      workers: "real",
      workerEntry: ENTRY,
    });
    await W.inc();
    crashWorker(wff);
    W.inc();
    W.inc();
    await tick(50);
    assertEquals(lines.length, 1, lines.join("\n"));
    assert(lines[0]!.includes("'wff:inc' dropped"), lines[0]);
  } finally {
    setLogger(null);
  }
});
