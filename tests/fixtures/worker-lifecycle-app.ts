// A `worker: true` cell for tests/worker-disable-lifecycle.test.ts — imported
// by the test for its def, and re-imported by a real cell worker spawned by
// `testServer({ workers: "real", workerEntry })`. Not a test file.
import { aio, cell, isCellWorker } from "aio";

type S = { n: number; inits: number };

/** Lifecycle hook runs in THIS isolate's copy of the module. */
export const ran = { inits: 0, destroys: 0 };

export const wlc = cell("wlc", {
  worker: true,
  state: { n: 0, inits: 0 } as S,
  onInit(app) {
    ran.inits++;
    app.dispatch({ type: "wlc:booted", payload: { args: [] } });
  },
  onDestroy() {
    ran.destroys++;
  },
  methods: {
    ok(s: S) {
      s.n++;
    },
    booted(s: S) {
      s.inits++;
    },
    boom(_s: S) {
      throw new Error("sync boom");
    },
  },
});

if (isCellWorker()) {
  await aio.run({
    appId: "worker-lifecycle-probe",
    cells: [wlc],
    client: "server-only",
    persist: false,
    libraryMode: true,
  });
}
