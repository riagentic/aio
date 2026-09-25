// For tests/worker-lifecycle-edges.test.ts: `worker: true` cells at the edges
// of their lifecycle — an `onDestroy` that throws, and a worker that crashes.
// Imported by the test for the defs; re-imported by a real worker.
import { aio, cell, isCellWorker } from "aio";

type S = { n: number };

export const wdt = cell("wdt", {
  worker: true,
  state: { n: 0 } as S,
  onDestroy() {
    throw new Error("resource already closed");
  },
  methods: {
    boom(_s: S) {
      throw new Error("boom");
    },
  },
});

export const wcr = cell("wcr", {
  worker: true,
  state: { n: 0 } as S,
  methods: {
    inc(s: S, k: number) {
      s.n += k;
      return s.n;
    },
    boom(_s: S) {
      throw new Error("boom");
    },
    crash(_s: S) {
      // An uncaught throw on the worker's own loop: the thread dies.
      setTimeout(() => {
        throw new Error("worker loop died");
      }, 0);
    },
  },
});

if (isCellWorker()) {
  await aio.run({
    appId: "worker-lifecycle-edges-probe",
    cells: [wdt, wcr],
    client: "server-only",
    persist: false,
    libraryMode: true,
  });
}
