// A `worker: true` cell for tests/worker-circuit-breaker.test.ts — imported by
// the test for its def, and re-imported by a real cell worker spawned by
// `testServer({ workers: "real", workerEntry })`. Not a test file.
import { aio, cell } from "aio";

type S = { n: number };

export const wcb = cell("wcb", {
  worker: true,
  state: { n: 0 } as S,
  methods: {
    boom(_s: S) {
      throw new Error("sync boom");
    },
    async boomLate(_s: S) {
      await Promise.resolve();
      throw new Error("async boom");
    },
    ok(s: S) {
      s.n++;
    },
  },
});

if ((globalThis as { name?: string }).name?.startsWith("aio-cell:")) {
  await aio.run({
    appId: "worker-circuit-breaker-probe",
    cells: [wcb],
    client: "server-only",
    persist: false,
    libraryMode: true,
  });
}
