// A repeating schedule whose worker cell died for good (no `workerRespawn`, or
// a crash loop that ended it) must stop with ONE error. Every later tick is
// refused with the same words — "this cell is unreachable for the life of the
// process" — and the scheduler logged each one at ERROR: 20 lines a second for
// `every: 50`, for as long as the app ran.
import { assert, assertEquals } from "@std/assert";
import { testServer } from "../src/testing/server-test.ts";
import { crashWorker } from "../src/cell-test.ts";
import { setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";
import { wff } from "./fixtures/worker-fire-forget-app.ts";

const ENTRY = import.meta.resolve("./fixtures/worker-fire-forget-app.ts");
const W = wff as unknown as { arm(): Promise<void>; n: number };
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("schedule: a dead worker cell's repeating schedule stops with one error", async () => {
  const lines: string[] = [];
  setLogger(
    {
      pub: (lvl: string, _cat: string, msg: string) => {
        if (lvl === "error" && msg.includes("schedule")) lines.push(msg);
      },
    } as unknown as LogSink,
  );
  try {
    await using _srv = await testServer({
      cells: [wff],
      workers: "real",
      workerEntry: ENTRY,
    });
    await W.arm();
    await tick(150);
    assert(W.n > 0, "the schedule ran while the worker lived");
    crashWorker(wff);
    await tick(300);
    assertEquals(lines.length, 1, lines.join("\n"));
    assert(lines[0]!.includes("stopped"), lines[0]);
  } finally {
    setLogger(null);
  }
});
