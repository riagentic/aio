// `crashWorker` under bootCells/testUI must refuse EVERY later call into the
// dead cell, as production's closed worker does — not only calls made through
// the bound method. A schedule tick dispatches the raw action: before, the
// in-process stand-in ran the "dead" cell's method on every tick (15 writes
// after the crash, measured), while production refuses each one and the
// schedule stops with one error (tests/schedule-stops-on-dead-worker.test.ts).
import { assert, assertEquals } from "@std/assert";
import { bootCells, crashWorker } from "../src/cell-test.ts";
import { setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";
import { wff } from "./fixtures/worker-fire-forget-app.ts";

const W = wff as unknown as { arm(): Promise<void>; n: number };

Deno.test("crashWorker under bootCells: a schedule tick into the dead cell is refused, and the schedule stops", async () => {
  const lines: string[] = [];
  setLogger(
    {
      pub: (lvl: string, _cat: string, msg: string) => {
        if (lvl === "error" && msg.includes("schedule")) lines.push(msg);
      },
    } as unknown as LogSink,
  );
  try {
    await using h = await bootCells([wff]);
    await W.arm();
    await h.advance(100);
    const before = W.n;
    assert(before > 0, "the schedule ran while the worker lived");
    crashWorker(wff);
    await h.advance(300);
    assertEquals(W.n, before, "no write after the crash");
    assertEquals(lines.length, 1, lines.join("\n"));
    assert(lines[0]!.includes("stopped"), lines[0]);
  } finally {
    setLogger(null);
  }
});
