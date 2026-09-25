// A crashed `worker: true` cell makes `/__aio/health` say so.
//
// The crash rejected every call from then on, until a restart — while the
// health endpoint answered `"status": "healthy"` with the cell `active`,
// `errors: 0`: the one surface a monitor alerts on vouched for a dead cell.
import { assert, assertEquals } from "@std/assert";
import { testServer } from "../src/testing/server-test.ts";
import { wdiff } from "./fixtures/worker-differential-app.ts";

const ENTRY = import.meta.resolve("./fixtures/worker-differential-app.ts");
const W = wdiff as unknown as {
  crash(): Promise<void>;
  inc(k: number): Promise<number>;
};

Deno.test("worker crash: /__aio/health reports the dead cell as degraded", async () => {
  await using srv = await testServer({
    cells: [wdiff],
    workers: "real",
    workerEntry: ENTRY,
  });
  const health = async () =>
    await (await fetch(`${srv.url}/__aio/health`)).json();
  assertEquals((await health()).status, "healthy");
  await W.crash();
  let err = "";
  for (let i = 0; i < 100 && !err; i++) {
    await new Promise((r) => setTimeout(r, 20));
    err = await W.inc(1).then(() => "", (e: Error) => e.message);
  }
  assert(err.includes("crashed"), `the cell never crashed: ${err}`);
  const h = await health();
  assertEquals(h.status, "degraded");
  const entry = (h.degraded as { name: string; lastError: string }[])
    .find((d) => d.name === "cell-worker:wdiff");
  assert(entry, JSON.stringify(h.degraded));
  assert(entry.lastError.includes("worker loop died"), entry.lastError);
});
