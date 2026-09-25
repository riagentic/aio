// A `worker: true` cell streaming commits is never dropped by the
// dispatch-storm breaker — its patch batches record writes the worker already
// made — and is named by its cell, not by the internal batch type.
//
// Tracked under the one type every worker cell's batches share
// (`__aioWorkerPatch`), a progress loop was reported as a storm of an action
// nobody wrote and, with `breaker: true`, its batches were dropped: the method
// returned 603 rows while the app's state held 472, and the two copies never
// agreed again.
import { assertEquals } from "@std/assert";
import { testServer } from "../src/testing/server-test.ts";
import { log } from "../src/diagnostics/logger-api.ts";
import { wdiff } from "./fixtures/worker-differential-app.ts";

const ENTRY = import.meta.resolve("./fixtures/worker-differential-app.ts");
const W = wdiff as unknown as { stream(n: number): Promise<number> };

Deno.test("worker dispatch storm: a streaming worker cell keeps every commit", async () => {
  await using srv = await testServer({
    cells: [wdiff],
    workers: "real",
    workerEntry: ENTRY,
    dispatchStorm: { rate: 50, sustain: 1, breaker: true },
  });
  const warned: string[] = [];
  const orig = log.warn;
  log.warn = ((...a: unknown[]) => {
    warned.push(a.map(String).join(" "));
    return (orig as (...x: unknown[]) => unknown)(...a);
  }) as typeof log.warn;
  try {
    const rows = await W.stream(600);
    await new Promise((r) => setTimeout(r, 100));
    const st = (srv.state() as { wdiff: { list: number[] } }).wdiff;
    assertEquals(rows, 603);
    assertEquals(st.list.length, rows, "state lost worker commits");
  } finally {
    log.warn = orig;
  }
  const storms = warned.filter((w) => w.includes("DISPATCH_STORM"));
  assertEquals(storms.length, 1, warned.join("\n"));
  assertEquals(storms[0]!.includes("wdiff:__worker"), true, storms[0]);
  assertEquals(storms[0]!.includes("dropping"), false, storms[0]);
});
