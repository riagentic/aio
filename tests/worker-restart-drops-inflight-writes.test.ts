// `app.cells.disable(x)` then `enable(x)` — a restart — while an async method
// of a `worker: true` cell awaits. The call belongs to the incarnation the
// restart destroyed: its later writes must not land in the fresh state, and
// its caller must be told so — exactly as for the same cell in-isolate
// (tests/cell-restart-drops-inflight-writes.test.ts).
//
// This file is its own worker entry: the real worker re-imports it and boots
// into cell-host mode; the tests register only on the main isolate.
import { assertEquals } from "@std/assert";
import { aio, cell, isCellWorker } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";

export const restartW = cell("restartW", {
  worker: true,
  state: { v: 0, log: [] as string[] },
  methods: {
    async slow(s: { v: number; log: string[] }, v: number) {
      await new Promise((r) => setTimeout(r, 200));
      s.v = v;
      s.log.push("stale");
      return "done";
    },
    async fresh(s: { v: number; log: string[] }) {
      await 0;
      s.log.push("fresh");
    },
  },
});

if (isCellWorker()) {
  await aio.run({
    appId: "worker-restart-inflight",
    cells: [restartW],
    client: "server-only",
    persist: false,
    libraryMode: true,
  });
} else {
  const ENTRY = import.meta.url;
  const W = restartW as unknown as {
    slow(v: number): Promise<unknown>;
    fresh(): Promise<unknown>;
  };
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function observe(real: boolean) {
    await using srv = await testServer({
      cells: [restartW],
      ...(real ? { workers: "real" as const, workerEntry: ENTRY } : {}),
    });
    const cells = (srv.app as unknown as {
      cells: { disable(n: string): void; enable(n: string): void };
    }).cells;
    const slice = () =>
      (srv.state() as { restartW: { v: number; log: string[] } }).restartW;
    const p = W.slow(5).then((v) => `ok:${v}`, (e) => `err:${e.message}`);
    await tick(50);
    cells.disable("restartW");
    cells.enable("restartW");
    const out = await p;
    await tick(50);
    const afterRestart = slice();
    await W.fresh(); // a call started AFTER the restart is untouched
    await tick(50);
    return { out, afterRestart, afterFresh: slice() };
  }

  Deno.test("worker cell: a restart mid-call drops the old call's writes and rejects it", async () => {
    const worker = await observe(true);
    assertEquals(worker, {
      out: "err:[restartW] cell disabled while slow() was running",
      afterRestart: { v: 0, log: [] },
      afterFresh: { v: 0, log: ["fresh"] },
    });
    assertEquals(await observe(false), worker, "in-isolate reads the same");
  });
}
