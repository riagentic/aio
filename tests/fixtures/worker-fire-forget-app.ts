// For tests/worker-fire-forget-no-unhandled.test.ts and
// tests/schedule-stops-on-dead-worker.test.ts: a worker cell whose sync method
// throws, and one that polls itself. Re-imported by a real worker.
import { aio, cell, isCellWorker, schedule } from "aio";

export const wff = cell("wff", {
  worker: true,
  state: { n: 0 },
  methods: {
    boom() {
      throw new Error("ff boom");
    },
    inc(s) {
      s.n += 1;
    },
    arm(s) {
      s.$do(schedule.every("wff:tk", 20, wff.inc.action()));
    },
  },
});

if (isCellWorker()) {
  await aio.run({
    watch: false,
    appId: "worker-fire-forget",
    cells: [wff],
    client: "server-only",
    persist: false,
    libraryMode: true,
  });
}
