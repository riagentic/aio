// For tests/worker-stray-rejection.test.ts: a worker cell whose method leaves
// a floating rejected promise behind. Re-imported by a real worker.
import { aio, cell, isCellWorker } from "aio";

type S = { n: number };

export const wstray = cell("wstray", {
  worker: true,
  state: { n: 0 } as S,
  methods: {
    floating(s: S) {
      s.n += 1;
      // A floating `void poll()` whose promise rejects — nobody awaits it.
      void Promise.reject(new Error("stray poll failure"));
      return s.n;
    },
    inc(s: S) {
      s.n += 1;
      return s.n;
    },
  },
});

if (isCellWorker()) {
  await aio.run({
    watch: false,
    appId: "worker-stray-rejection",
    cells: [wstray],
    client: "server-only",
    persist: false,
    libraryMode: true,
  });
}
